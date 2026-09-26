-- M023c — corrections de revue B064, sans élargissement. Les migrations
-- déjà commitées (M023b 20260927180000, M025 20260927190000) ne sont pas
-- réécrites : CREATE OR REPLACE, mêmes signatures, droits EXECUTE conservés
-- (restreints à authenticated).
--
-- 1. submit_plan_version_for_validation : les désignations concernées
--    (choisie + celle d'une demande PENDING existante) sont verrouillées
--    avant la demande, par id croissant ; le compte est relu APRÈS toutes les
--    attentes (il l'était avant le verrou de l'ancienne désignation).
-- 2. list_project_plan_validations expose designation_active, pour permettre
--    à l'écran la resoumission d'une demande PENDING dont la désignation est
--    révoquée (et seulement dans ce cas).
-- 3. publish_project_plan_version révoque dans sa transaction les accès
--    SITE_MANAGER actifs : un ancien octroi n'est plus réactivé par une
--    republication de la même version (A -> B -> A).
-- 4. Audit (audit_events, M005) écrit dans la transaction de la décision et
--    de la publication ; un échec d'audit annule l'ensemble.

begin;

create or replace function public.submit_plan_version_for_validation(p_version_id uuid, p_designation_id uuid)
returns public.plan_validations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_membership_id uuid;
  v_org_id uuid;
  v_peek_pending_designation_id uuid;
  v_designation public.plan_engineer_designations;
  v_old_designation public.plan_engineer_designations;
  v_locked_id uuid;
  v_pending public.plan_validations;
  v_file record;
  v_row public.plan_validations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select project_id into v_project_id from public.project_plan_versions where id = p_version_id;
  if v_project_id is null then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = v_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  for update;
  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  select organization_id into v_org_id from public.projects where id = v_project_id;
  if v_org_id is null then
    raise exception 'no_organization';
  end if;

  if not public.project_plan_version_readable(p_version_id, v_uid) then
    raise exception 'not_authorized';
  end if;

  -- Toutes les désignations concernées (choisie + celle d'une demande
  -- PENDING existante) sont verrouillées AVANT la demande, dans l'ordre
  -- croissant de leur id (ordre déterministe). La demande PENDING ne peut
  -- pas changer entre cette lecture et son verrou : toute écriture de
  -- plan_validations d'un chantier prend le même verrou avisoire.
  select designation_id into v_peek_pending_designation_id
  from public.plan_validations
  where project_plan_version_id = p_version_id and status = 'PENDING';

  for v_locked_id in
    select d.id from public.plan_engineer_designations d
    where d.id in (p_designation_id, v_peek_pending_designation_id)
    order by d.id
    for update
  loop
    null;
  end loop;

  select * into v_designation from public.plan_engineer_designations where id = p_designation_id;
  if not found or v_designation.revoked_at is not null or v_designation.organization_id <> v_org_id then
    raise exception 'not_authorized';
  end if;

  select * into v_pending
  from public.plan_validations
  where project_plan_version_id = p_version_id and status = 'PENDING'
  for update;
  if v_pending.id is not null and v_pending.designation_id is distinct from v_peek_pending_designation_id then
    raise exception 'submission_conflict';
  end if;

  -- Compte relu APRÈS toutes les attentes (avisoire, adhésion, désignations,
  -- demande), avant toute annulation ou insertion.
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select * into v_file from public.project_plan_version_file(p_version_id);
  if v_file.upload_status is distinct from 'FINALIZED' then
    raise exception 'file_not_finalized';
  end if;

  if v_pending.id is not null then
    select * into v_old_designation from public.plan_engineer_designations where id = v_pending.designation_id;
    if v_old_designation.revoked_at is null then
      raise exception 'already_pending';
    end if;
    -- Désignation révoquée : la demande ne peut plus aboutir, elle est close
    -- explicitement avant la nouvelle soumission (même règle que B061).
    update public.plan_validations
    set status = 'CANCELLED', cancelled_at_server = clock_timestamp(),
        cancelled_by_profile_id = v_uid, cancelled_reason = 'designation_revoked'
    where id = v_pending.id;
  end if;

  insert into public.plan_validations (
    project_plan_version_id, project_id, designation_id, organization_id, submitted_by_profile_id, submitted_at_server
  ) values (
    p_version_id, v_project_id, v_designation.id, v_org_id, v_uid, clock_timestamp()
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.decide_plan_validation(p_validation_id uuid, p_decision text, p_note text)
returns public.plan_validations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek public.plan_validations;
  v_designation public.plan_engineer_designations;
  v_row public.plan_validations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_decision is null or p_decision not in ('VALIDATED', 'REJECTED') then
    raise exception 'invalid_decision';
  end if;

  select * into v_peek from public.plan_validations where id = p_validation_id;
  if not found then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek.project_id::text)::bigint);

  select * into v_designation from public.plan_engineer_designations where id = v_peek.designation_id for update;
  if not found or v_designation.revoked_at is not null or v_designation.engineer_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  select * into v_row from public.plan_validations where id = p_validation_id for update;
  if v_row.designation_id <> v_designation.id
     or v_row.organization_id is distinct from (select organization_id from public.projects where id = v_row.project_id) then
    raise exception 'not_authorized';
  end if;

  if v_row.status <> 'PENDING' then
    raise exception 'already_decided';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  update public.plan_validations
  set status = p_decision, decided_at_server = clock_timestamp(), decided_by_profile_id = v_uid,
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = v_row.id
  returning * into v_row;

  -- Audit dans la MÊME transaction : un échec d'insertion annule la décision.
  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason
  ) values (
    v_row.project_id, 'HUMAN', v_uid, 'PLAN_VALIDATION_DECIDED', 'plan_validations', v_row.id, 'SUCCESS',
    jsonb_build_object('decision', v_row.status, 'project_plan_version_id', v_row.project_plan_version_id, 'designation_id', v_row.designation_id),
    'Décision de validation technique de l''ingénieur désigné.'
  );

  return v_row;
end;
$$;

create or replace function public.publish_project_plan_version(p_project_id uuid, p_version_id uuid, p_expected_revision integer)
returns public.projects
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership_id uuid;
  v_project public.projects;
  v_validation_id uuid;
  v_file record;
  v_revoked_shares integer;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = p_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  for update;
  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_project from public.projects where id = p_project_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_project.revision is distinct from p_expected_revision then
    raise exception 'publication_conflict';
  end if;

  if v_project.retained_plan_version_id is distinct from p_version_id then
    raise exception 'version_not_retained';
  end if;

  if v_project.published_plan_version_id = p_version_id then
    raise exception 'already_published';
  end if;

  if not public.project_plan_version_readable(p_version_id, v_uid) then
    raise exception 'not_authorized';
  end if;

  select id into v_validation_id
  from public.plan_validations
  where project_plan_version_id = p_version_id and project_id = p_project_id and status = 'VALIDATED'
  order by decided_at_server desc
  limit 1;
  if v_validation_id is null then
    raise exception 'version_not_validated';
  end if;

  select * into v_file from public.project_plan_version_file(p_version_id);
  if v_file.upload_status is distinct from 'FINALIZED' then
    raise exception 'file_not_finalized';
  end if;

  -- Une nouvelle publication clôt les accès SITE_MANAGER en cours (D111) :
  -- un octroi n'est jamais réactivé par une republication ultérieure de la
  -- même version (A -> B -> A). Historique conservé (révocation, pas suppression).
  update public.project_plan_shares
  set revoked_at_server = clock_timestamp(), revoked_by_profile_id = v_uid
  where project_id = p_project_id and revoked_at_server is null;
  get diagnostics v_revoked_shares = row_count;

  insert into public.project_plan_publications (
    project_id, project_plan_version_id, plan_validation_id, previous_published_version_id, published_by_profile_id, published_at_server
  ) values (
    p_project_id, p_version_id, v_validation_id, v_project.published_plan_version_id, v_uid, clock_timestamp()
  );

  update public.projects
  set published_plan_version_id = p_version_id
  where id = p_project_id
  returning * into v_project;

  -- Audit dans la MÊME transaction : un échec annule pointeur, journal et révocations.
  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason
  ) values (
    p_project_id, 'HUMAN', v_uid, 'PLAN_PUBLISHED', 'projects', p_project_id, 'SUCCESS',
    jsonb_build_object('project_plan_version_id', p_version_id, 'plan_validation_id', v_validation_id, 'revoked_site_manager_shares', v_revoked_shares),
    'Publication explicite du plan retenu validé au chantier.'
  );

  return v_project;
end;
$$;

alter type public.project_plan_validation_view add attribute designation_active boolean;

create or replace function public.list_project_plan_validations(p_project_id uuid)
returns setof public.project_plan_validation_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  ) then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  return query
  select val.id, val.project_plan_version_id, val.status, val.submitted_at_server, val.decided_at_server, val.decision_note,
         public.mask_identifier(d.designated_identifier_kind, d.designated_identifier_value_normalized),
         d.revoked_at is null
  from public.plan_validations val
  join public.plan_engineer_designations d on d.id = val.designation_id
  where val.project_id = p_project_id
    and public.project_plan_version_readable(val.project_plan_version_id, v_uid)
  order by val.submitted_at_server desc;
end;
$$;

commit;
