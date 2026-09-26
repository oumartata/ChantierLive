-- M023b — plan_validations (T051) et publication au chantier (B064).
-- D084/BR092 : dépôt, validation technique et publication sont trois actes
-- distincts ; D092/BR100 : validation par l'ingénieur désigné, habilitation
-- ACTIVE relue au moment de la décision ; D097/BR105 : lecture de l'ingénieur
-- limitée aux versions qui lui sont soumises, tant que sa désignation reste
-- active ; D106 : une validation reste attachée à SA version ;
-- D108 : chantier sans organisation -> soumission refusée (no_organization) ;
-- D109 : soumission par le CONTRACTOR actif, version qu'il peut consulter ;
-- D110 : publication/republication explicites du plan retenu VALIDATED,
-- historique par insertion, jamais de remplacement automatique.
-- Aucune équivalence avec les validations catalogue B061
-- (plan_catalog_item_validations n'est jamais lue ici).
-- Hors périmètre : autorisation de démarrage (B067), devis (B065).
--
-- Ordre des verrous, commun à toutes les fonctions : avisoire du chantier ->
-- adhésion -> désignation -> demande de validation -> chantier. Le contrôle
-- de compte vérifié est relu APRÈS la dernière attente, avant tout retour
-- sensible ou mutation. Compatible avec revoke_plan_engineer_designation
-- (organisation -> désignation), qui ne prend aucun autre verrou.

begin;

-- ----------------------------------------------------------------------------
-- plan_validations — PENDING -> VALIDATED | REJECTED | CANCELLED, puis immuable.
-- ----------------------------------------------------------------------------

create table public.plan_validations (
  id uuid primary key default gen_random_uuid(),
  project_plan_version_id uuid not null references public.project_plan_versions (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  designation_id uuid not null references public.plan_engineer_designations (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  submitted_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  submitted_at_server timestamptz not null,
  status text not null default 'PENDING',
  decided_at_server timestamptz null,
  decided_by_profile_id uuid null references public.profiles (id) on delete restrict,
  decision_note text null,
  cancelled_at_server timestamptz null,
  cancelled_by_profile_id uuid null references public.profiles (id) on delete restrict,
  cancelled_reason text null,
  constraint plan_validations_status_known
    check (status in ('PENDING', 'VALIDATED', 'REJECTED', 'CANCELLED')),
  constraint plan_validations_status_consistency check (
    (status = 'PENDING'
      and decided_at_server is null and decided_by_profile_id is null
      and cancelled_at_server is null and cancelled_by_profile_id is null and cancelled_reason is null)
    or (status in ('VALIDATED', 'REJECTED')
      and decided_at_server is not null and decided_by_profile_id is not null
      and cancelled_at_server is null and cancelled_by_profile_id is null and cancelled_reason is null)
    or (status = 'CANCELLED'
      and cancelled_at_server is not null and cancelled_by_profile_id is not null and cancelled_reason is not null
      and decided_at_server is null and decided_by_profile_id is null)
  ),
  constraint plan_validations_version_project_fk
    foreign key (project_plan_version_id, project_id) references public.project_plan_versions (id, project_id),
  constraint plan_validations_designation_org_fk
    foreign key (designation_id, organization_id) references public.plan_engineer_designations (id, organization_id),
  constraint plan_validations_id_version_unique unique (id, project_plan_version_id)
);

-- Une seule demande en attente par version (décision unique).
create unique index plan_validations_one_pending_per_version
  on public.plan_validations (project_plan_version_id) where status = 'PENDING';
create index plan_validations_project_id_idx on public.plan_validations (project_id);
create index plan_validations_designation_id_idx on public.plan_validations (designation_id);

-- Seule transition permise : PENDING -> état terminal, identité de la demande
-- inchangée. Aucune suppression.
create function public.reject_plan_validation_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'plan_validation_immutable';
  end if;
  if old.status <> 'PENDING' then
    raise exception 'validation_already_terminal';
  end if;
  if new.project_plan_version_id <> old.project_plan_version_id
     or new.project_id <> old.project_id
     or new.designation_id <> old.designation_id
     or new.organization_id <> old.organization_id
     or new.submitted_by_profile_id <> old.submitted_by_profile_id
     or new.submitted_at_server <> old.submitted_at_server then
    raise exception 'plan_validation_immutable';
  end if;
  return new;
end;
$$;

create trigger reject_mutation
before update or delete on public.plan_validations
for each row execute function public.reject_plan_validation_mutation();

alter table public.plan_validations enable row level security;
revoke all privileges on table public.plan_validations from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Publication : pointeur courant + journal par insertion (D110).
-- ----------------------------------------------------------------------------

alter table public.projects add column published_plan_version_id uuid null;
alter table public.projects
  add constraint projects_published_plan_version_fk
  foreign key (published_plan_version_id, id) references public.project_plan_versions (id, project_id);

create table public.project_plan_publications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  project_plan_version_id uuid not null references public.project_plan_versions (id) on delete restrict,
  plan_validation_id uuid not null references public.plan_validations (id) on delete restrict,
  previous_published_version_id uuid null references public.project_plan_versions (id) on delete restrict,
  published_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  published_at_server timestamptz not null default now(),
  constraint project_plan_publications_version_project_fk
    foreign key (project_plan_version_id, project_id) references public.project_plan_versions (id, project_id),
  constraint project_plan_publications_validation_version_fk
    foreign key (plan_validation_id, project_plan_version_id) references public.plan_validations (id, project_plan_version_id)
);

create index project_plan_publications_project_id_idx on public.project_plan_publications (project_id);

create function public.reject_project_plan_publication_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'project_plan_publication_immutable';
end;
$$;

create trigger reject_mutation
before update or delete on public.project_plan_publications
for each row execute function public.reject_project_plan_publication_mutation();

alter table public.project_plan_publications enable row level security;
revoke all privileges on table public.project_plan_publications from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Résolution du fichier d'une version (interne, jamais exposée) : même règle
-- que get_project_plan_version_file_key (B063), bucket choisi selon l'origine.
-- ----------------------------------------------------------------------------

create function public.project_plan_version_file(p_version_id uuid, out storage_key text, out bucket text, out upload_status text)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_version public.project_plan_versions;
begin
  select * into v_version from public.project_plan_versions where id = p_version_id;
  if not found then
    return;
  end if;
  if v_version.origin = 'DIRECT' then
    select u.storage_key, u.status into storage_key, upload_status
    from public.private_object_uploads u where u.id = v_version.private_object_upload_id;
    bucket := 'project-plans';
  else
    select u.storage_key, u.status into storage_key, upload_status
    from public.private_object_uploads u
    join public.plan_catalog_item_versions civ on civ.private_object_upload_id = u.id
    where civ.id = v_version.catalog_item_version_id;
    bucket := 'organization-catalog';
  end if;
end;
$$;

revoke execute on function public.project_plan_version_file(uuid) from public, anon, authenticated, service_role;

-- Masque un identifiant de contact (données privées) : l'entrepreneur choisit
-- une désignation sans que l'e-mail ou le téléphone complet lui soit révélé.
create function public.mask_identifier(p_kind public.identifier_kind, p_value text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_kind::text = 'EMAIL' and position('@' in p_value) > 1
      then left(p_value, 1) || '•••' || substr(p_value, position('@' in p_value))
    else '•••' || right(p_value, 2)
  end;
$$;

revoke execute on function public.mask_identifier(public.identifier_kind, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- list_project_plan_engineers — désignations ACTIVES de l'organisation du
-- chantier, pour le CONTRACTOR actif uniquement (D109), identifiant masqué.
-- ----------------------------------------------------------------------------

create type public.project_plan_engineer as (
  designation_id uuid,
  identifier_masked text,
  designated_at_server timestamptz
);

create function public.list_project_plan_engineers(p_project_id uuid)
returns setof public.project_plan_engineer
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  ) then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select organization_id into v_org_id from public.projects where id = p_project_id;
  if v_org_id is null then
    raise exception 'no_organization';
  end if;

  return query
  select d.id, public.mask_identifier(d.designated_identifier_kind, d.designated_identifier_value_normalized), d.created_at_server
  from public.plan_engineer_designations d
  where d.organization_id = v_org_id and d.revoked_at is null
  order by d.created_at_server;
end;
$$;

revoke execute on function public.list_project_plan_engineers(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_project_plan_engineers(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- submit_plan_version_for_validation — CONTRACTOR actif (D109), version
-- lisible, désignation active de l'organisation du chantier (D108).
-- ----------------------------------------------------------------------------

create function public.submit_plan_version_for_validation(p_version_id uuid, p_designation_id uuid)
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
  v_designation public.plan_engineer_designations;
  v_pending public.plan_validations;
  v_old_designation_revoked timestamptz;
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

  select * into v_designation from public.plan_engineer_designations where id = p_designation_id for update;
  if not found or v_designation.revoked_at is not null or v_designation.organization_id <> v_org_id then
    raise exception 'not_authorized';
  end if;

  select * into v_pending
  from public.plan_validations
  where project_plan_version_id = p_version_id and status = 'PENDING'
  for update;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select * into v_file from public.project_plan_version_file(p_version_id);
  if v_file.upload_status is distinct from 'FINALIZED' then
    raise exception 'file_not_finalized';
  end if;

  if v_pending.id is not null then
    select revoked_at into v_old_designation_revoked
    from public.plan_engineer_designations where id = v_pending.designation_id for update;
    if v_old_designation_revoked is null then
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

revoke execute on function public.submit_plan_version_for_validation(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.submit_plan_version_for_validation(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- decide_plan_validation — ingénieur de la désignation liée, active, dans
-- l'organisation ACTUELLE du chantier ; décision unique.
-- ----------------------------------------------------------------------------

create function public.decide_plan_validation(p_validation_id uuid, p_decision text, p_note text)
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

  return v_row;
end;
$$;

revoke execute on function public.decide_plan_validation(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.decide_plan_validation(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- publish_project_plan_version — CONTRACTOR actif, plan RETENU dont cette
-- version exacte est VALIDATED, révision attendue obligatoire (D110).
-- ----------------------------------------------------------------------------

create function public.publish_project_plan_version(p_project_id uuid, p_version_id uuid, p_expected_revision integer)
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

  insert into public.project_plan_publications (
    project_id, project_plan_version_id, plan_validation_id, previous_published_version_id, published_by_profile_id, published_at_server
  ) values (
    p_project_id, p_version_id, v_validation_id, v_project.published_plan_version_id, v_uid, clock_timestamp()
  );

  update public.projects
  set published_plan_version_id = p_version_id
  where id = p_project_id
  returning * into v_project;

  return v_project;
end;
$$;

revoke execute on function public.publish_project_plan_version(uuid, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.publish_project_plan_version(uuid, uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- get_plan_validation_file — ingénieur de la désignation liée, tant qu'elle
-- reste active (D097), quel que soit le statut de la demande.
-- ----------------------------------------------------------------------------

create function public.get_plan_validation_file(p_validation_id uuid, out storage_key text, out bucket text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek public.plan_validations;
  v_designation public.plan_engineer_designations;
  v_file record;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
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

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select * into v_file from public.project_plan_version_file(v_peek.project_plan_version_id);
  if v_file.upload_status is distinct from 'FINALIZED' then
    raise exception 'file_not_finalized';
  end if;

  storage_key := v_file.storage_key;
  bucket := v_file.bucket;
end;
$$;

revoke execute on function public.get_plan_validation_file(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_plan_validation_file(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Listes.
-- ----------------------------------------------------------------------------

-- Ingénieur : demandes EN ATTENTE sur ses désignations actives (jamais une
-- autre agence, jamais une désignation révoquée).
create type public.submitted_plan_validation as (
  validation_id uuid,
  project_plan_version_id uuid,
  origin text,
  submitted_at_server timestamptz
);

create function public.list_submitted_plan_validations()
returns setof public.submitted_plan_validation
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  return query
  select val.id, val.project_plan_version_id, v.origin, val.submitted_at_server
  from public.plan_validations val
  join public.plan_engineer_designations d on d.id = val.designation_id
  join public.project_plan_versions v on v.id = val.project_plan_version_id
  where val.status = 'PENDING'
    and d.revoked_at is null
    and d.engineer_profile_id = auth.uid()
  order by val.submitted_at_server;
end;
$$;

revoke execute on function public.list_submitted_plan_validations() from public, anon, authenticated, service_role;
grant execute on function public.list_submitted_plan_validations() to authenticated;

-- OWNER/PRIMARY et CONTRACTOR : demandes des versions qu'ils peuvent lire
-- (même prédicat que B063, jamais plus large). La décision historique reste
-- consultable (D097), avec l'identifiant masqué de l'ingénieur.
create type public.project_plan_validation_view as (
  validation_id uuid,
  project_plan_version_id uuid,
  status text,
  submitted_at_server timestamptz,
  decided_at_server timestamptz,
  decision_note text,
  engineer_identifier_masked text
);

create function public.list_project_plan_validations(p_project_id uuid)
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
         public.mask_identifier(d.designated_identifier_kind, d.designated_identifier_value_normalized)
  from public.plan_validations val
  join public.plan_engineer_designations d on d.id = val.designation_id
  where val.project_id = p_project_id
    and public.project_plan_version_readable(val.project_plan_version_id, v_uid)
  order by val.submitted_at_server desc;
end;
$$;

revoke execute on function public.list_project_plan_validations(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_project_plan_validations(uuid) to authenticated;

-- Historique des publications : lecteurs D096 hors SITE_MANAGER (OWNER tous
-- profils, CONTRACTOR) ; métadonnées seulement, aucun fichier.
create type public.project_plan_publication_view as (
  publication_id uuid,
  project_plan_version_id uuid,
  previous_published_version_id uuid,
  published_at_server timestamptz
);

create function public.list_project_plan_publications(p_project_id uuid)
returns setof public.project_plan_publication_view
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
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null and role in ('OWNER', 'CONTRACTOR')
  ) then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  return query
  select p.id, p.project_plan_version_id, p.previous_published_version_id, p.published_at_server
  from public.project_plan_publications p
  where p.project_id = p_project_id
  order by p.published_at_server desc;
end;
$$;

revoke execute on function public.list_project_plan_publications(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_project_plan_publications(uuid) to authenticated;

commit;
