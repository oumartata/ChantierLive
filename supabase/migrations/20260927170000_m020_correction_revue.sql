-- M020 correction de revue (B063), sans élargir le périmètre. Aucune
-- migration déjà appliquée n'est modifiée : CREATE OR REPLACE, mêmes
-- signatures, GRANT conservés.
--
-- 1. set_retained_project_plan_version : p_expected_revision NULL refusé
--    (expected_revision_required) ; la comparaison reste atomique sous le
--    verrou du chantier (is distinct from).
-- 2. Compte vérifié (is_account_provisional, refus fermé) relu APRÈS les
--    attentes pertinentes et AVANT tout retour sensible ou mutation, rejeux
--    compris :
--    - claim_upload_attempt / recover_media_upload_attempt / get_upload_status :
--      contrôle ajouté dans la SEULE branche project_plan_version ; les
--      branches media_asset et plan_catalog_item_version sont inchangées ;
--    - prepare_project_plan_upload : déplacé après avisoire -> adhésion ;
--    - attach_catalog_plan_to_project : déplacé après les verrous
--      organisation et modèle ;
--    - set_retained_project_plan_version : déplacé après le verrou chantier ;
--    - list_project_plan_candidates : contrôle ajouté (absent).
--    finalize_project_plan_upload, share_project_plan_version_with_owner et
--    get_project_plan_version_file_key le plaçaient déjà après leur dernière
--    attente : inchangées.
-- 3. prepare_project_plan_upload : la réconciliation exige
--    entity_type = 'project_plan_version' (un operation_uuid d'un autre
--    domaine n'est jamais réinterprété).

begin;

create or replace function public.claim_upload_attempt(p_operation_uuid uuid, p_expected_attempt_id uuid default null)
returns public.upload_claim_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_entity_type text;
  v_peek_project_id uuid;
  v_row public.private_object_uploads;
  v_now timestamptz;
  v_authorized boolean;
  v_membership_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select entity_type, project_id into v_peek_entity_type, v_peek_project_id
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid;

  if v_peek_entity_type is null then
    raise exception 'not_authorized';
  end if;

  if v_peek_entity_type = 'project_plan_version' then
    perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek_project_id::text)::bigint);

    select id into v_membership_id
    from public.project_memberships
    where project_id = v_peek_project_id
      and profile_id = v_uid
      and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
    for update;

    if v_membership_id is null then
      raise exception 'not_authorized';
    end if;
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type <> v_peek_entity_type or v_row.project_id is distinct from v_peek_project_id then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type = 'media_asset' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and role in ('CONTRACTOR', 'SITE_MANAGER')
    );
  elsif v_row.entity_type = 'plan_catalog_item_version' then
    v_authorized := exists (
      select 1 from public.organizations
      where id = v_row.organization_id
        and owner_profile_id = v_uid
        and archived_at is null
    );
  elsif v_row.entity_type = 'project_plan_version' then
    v_authorized := true; -- déjà revérifié ci-dessus, sous verrou adhésion.
    -- Compte vérifié relu APRÈS la dernière attente (verrou de la ligne),
    -- avant tout retour (y compris les rejeux) et toute mutation.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
  else
    v_authorized := false;
  end if;

  if not v_authorized then
    raise exception 'not_authorized';
  end if;

  if p_expected_attempt_id is not null and v_row.attempt_id <> p_expected_attempt_id then
    raise exception 'attempt_changed';
  end if;

  if v_row.status <> 'PENDING' then
    return (v_row.project_id, v_row.candidate_key, v_row.expected_checksum, v_row.expected_size_bytes,
            v_row.expected_mime_type, v_row.attempt_id, v_row.status, false, v_row.organization_id)::public.upload_claim_result;
  end if;

  v_now := clock_timestamp();

  if v_row.attempt_expires_at <= v_now then
    raise exception 'attempt_expired';
  end if;

  if v_row.write_claimed_at is not null then
    return (v_row.project_id, v_row.candidate_key, v_row.expected_checksum, v_row.expected_size_bytes,
            v_row.expected_mime_type, v_row.attempt_id, v_row.status, false, v_row.organization_id)::public.upload_claim_result;
  end if;

  update public.private_object_uploads
  set write_claimed_at = v_now
  where id = v_row.id
    and write_claimed_at is null
  returning * into v_row;

  return (v_row.project_id, v_row.candidate_key, v_row.expected_checksum, v_row.expected_size_bytes,
          v_row.expected_mime_type, v_row.attempt_id, v_row.status, true, v_row.organization_id)::public.upload_claim_result;
end;
$$;

create or replace function public.recover_media_upload_attempt(p_operation_uuid uuid)
returns public.private_object_uploads
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_entity_type text;
  v_peek_project_id uuid;
  v_row public.private_object_uploads;
  v_now timestamptz;
  v_new_attempt uuid;
  v_new_candidate text;
  v_authorized boolean;
  v_path_prefix text;
  v_membership_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select entity_type, project_id into v_peek_entity_type, v_peek_project_id
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid;

  if v_peek_entity_type is null then
    raise exception 'not_authorized';
  end if;

  if v_peek_entity_type = 'project_plan_version' then
    perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek_project_id::text)::bigint);

    select id into v_membership_id
    from public.project_memberships
    where project_id = v_peek_project_id
      and profile_id = v_uid
      and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
    for update;

    if v_membership_id is null then
      raise exception 'operation_access_revoked';
    end if;
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type <> v_peek_entity_type or v_row.project_id is distinct from v_peek_project_id then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type = 'media_asset' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and role in ('CONTRACTOR', 'SITE_MANAGER')
    );
    v_path_prefix := '_private/' || v_row.project_id::text || '/media_asset/' || v_row.operation_uuid::text;
  elsif v_row.entity_type = 'plan_catalog_item_version' then
    v_authorized := exists (
      select 1 from public.organizations
      where id = v_row.organization_id
        and owner_profile_id = v_uid
        and archived_at is null
    );
    v_path_prefix := '_private/' || v_row.organization_id::text || '/plan_catalog_item_version/' || v_row.operation_uuid::text;
  elsif v_row.entity_type = 'project_plan_version' then
    v_authorized := true; -- déjà revérifié ci-dessus, sous verrou adhésion.
    -- Même placement que claim_upload_attempt : après la dernière attente,
    -- avant le retour FINALIZED et avant toute nouvelle tentative.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
    v_path_prefix := '_private/' || v_row.project_id::text || '/project_plan_version/' || v_row.operation_uuid::text;
  else
    v_authorized := false;
  end if;

  if not v_authorized then
    raise exception 'operation_access_revoked';
  end if;

  if v_row.status = 'FINALIZED' then
    return v_row;
  end if;

  if v_row.status = 'ABANDONED' then
    raise exception 'operation_abandoned';
  end if;

  v_now := clock_timestamp();

  if v_row.attempt_expires_at > v_now then
    return v_row;
  end if;

  if v_row.write_claimed_at is not null then
    insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
    values (v_row.id, v_row.candidate_key, 'candidate');
  end if;

  v_new_attempt := gen_random_uuid();
  v_new_candidate := v_path_prefix || '/candidates/' || v_new_attempt::text;

  update public.private_object_uploads
  set attempt_id = v_new_attempt,
      candidate_key = v_new_candidate,
      attempt_expires_at = v_now + interval '15 minutes',
      write_claimed_at = null,
      status = 'PENDING',
      storage_verified_attempt_id = null
  where id = v_row.id
  returning * into v_row;

  if v_row.entity_type = 'media_asset' then
    insert into public.audit_events (
      project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
    ) values (
      v_row.project_id, 'HUMAN', v_uid, 'MEDIA_UPLOAD_ATTEMPT_ABANDONED', 'private_object_uploads', v_row.id, 'SUCCESS',
      'Tentative expirée abandonnée, nouvel attempt_id/candidate ouverts.'
    );
  end if;

  return v_row;
end;
$$;

create or replace function public.get_upload_status(p_operation_uuid uuid)
returns public.private_object_uploads
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_entity_type text;
  v_peek_project_id uuid;
  v_row public.private_object_uploads;
  v_authorized boolean;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select entity_type, project_id into v_peek_entity_type, v_peek_project_id
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid;

  if v_peek_entity_type is null then
    raise exception 'not_authorized';
  end if;

  select * into v_row from public.private_object_uploads where operation_uuid = p_operation_uuid;

  if not found or v_row.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type = 'media_asset' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and role in ('CONTRACTOR', 'SITE_MANAGER')
    );
  elsif v_row.entity_type = 'plan_catalog_item_version' then
    v_authorized := exists (
      select 1 from public.organizations
      where id = v_row.organization_id
        and owner_profile_id = v_uid
        and archived_at is null
    );
  elsif v_row.entity_type = 'project_plan_version' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
    );
    -- Aucune attente ici (lecture) : contrôlé avant le retour de la ligne.
    if v_authorized and public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
  else
    v_authorized := false;
  end if;

  if not v_authorized then
    raise exception 'operation_access_revoked';
  end if;

  return v_row;
end;
$$;

create or replace function public.prepare_project_plan_upload(
  p_operation_uuid uuid,
  p_project_id uuid,
  p_expected_checksum text,
  p_expected_size_bytes bigint,
  p_expected_mime_type text
)
returns public.private_object_uploads
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership_id uuid;
  v_attempt_id uuid;
  v_candidate_key text;
  v_now timestamptz;
  v_row public.private_object_uploads;
  v_existing public.private_object_uploads;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_operation_uuid is null or p_project_id is null then
    raise exception 'not_authorized';
  end if;
  if p_expected_checksum is null or btrim(p_expected_checksum) = '' then
    raise exception 'checksum_required';
  end if;
  if p_expected_size_bytes is null or p_expected_size_bytes <= 0 then
    raise exception 'size_required';
  end if;
  if p_expected_mime_type is null or btrim(p_expected_mime_type) = '' then
    raise exception 'mime_type_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  -- Déplacé ici (auparavant avant l'attente du verrou) : relu après les
  -- attentes, avant toute insertion et avant le rejeu de réconciliation.
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  v_now := clock_timestamp();
  v_attempt_id := gen_random_uuid();
  v_candidate_key := '_private/' || p_project_id::text || '/project_plan_version/' || p_operation_uuid::text || '/candidates/' || v_attempt_id::text;

  begin
    insert into public.private_object_uploads (
      operation_uuid, project_id, entity_type, created_by_profile_id,
      attempt_id, attempt_expires_at, candidate_key,
      expected_checksum, expected_size_bytes, expected_mime_type
    ) values (
      p_operation_uuid, p_project_id, 'project_plan_version', v_uid,
      v_attempt_id, v_now + interval '15 minutes', v_candidate_key,
      p_expected_checksum, p_expected_size_bytes, p_expected_mime_type
    )
    returning * into v_row;

    return v_row;
  exception
    when unique_violation then
      select * into v_existing from public.private_object_uploads where operation_uuid = p_operation_uuid;

      if v_existing.entity_type <> 'project_plan_version'
         or v_existing.created_by_profile_id <> v_uid
         or v_existing.project_id is distinct from p_project_id
         or v_existing.expected_checksum <> p_expected_checksum
         or v_existing.expected_size_bytes <> p_expected_size_bytes
         or v_existing.expected_mime_type <> p_expected_mime_type
      then
        raise exception 'operation_uuid_conflict';
      end if;

      if v_existing.status = 'FINALIZED' then
        raise exception 'operation_already_finalized';
      end if;
      if v_existing.status = 'ABANDONED' then
        raise exception 'operation_abandoned';
      end if;

      return v_existing;
  end;
end;
$$;

create or replace function public.attach_catalog_plan_to_project(p_project_id uuid, p_catalog_item_id uuid)
returns public.project_plan_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
  v_project public.projects;
  v_org public.organizations;
  v_item public.plan_catalog_items;
  v_project_plan public.project_plans;
  v_version public.project_plan_versions;
  v_deposited_as_role text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select id, role, owner_profile into v_membership
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if v_membership.id is null then
    raise exception 'not_authorized';
  end if;

  v_deposited_as_role := case when v_membership.role = 'CONTRACTOR' then 'CONTRACTOR' else 'OWNER_PRIMARY' end;

  select * into v_project from public.projects where id = p_project_id;
  if not found or v_project.organization_id is null then
    raise exception 'no_organization';
  end if;

  -- Accès CATALOGUE distinct de l'habilitation chantier (D107) : réservé au
  -- propriétaire de l'organisation, jamais déduit du rôle CONTRACTOR seul.
  select * into v_org from public.organizations where id = v_project.organization_id for update;
  if not found or v_org.archived_at is not null or v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  select * into v_item from public.plan_catalog_items where id = p_catalog_item_id for update;
  if not found or v_item.organization_id <> v_org.id or v_item.archived_at is not null or v_item.published_version_id is null then
    raise exception 'not_authorized';
  end if;

  -- Déplacé ici (auparavant avant les verrous organisation/modèle) : relu
  -- après la dernière attente, avant toute insertion.
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  insert into public.project_plans (project_id, origin, created_by_profile_id)
  values (p_project_id, 'CATALOG', v_uid)
  returning * into v_project_plan;

  insert into public.project_plan_versions (
    project_plan_id, project_id, origin, version_number, catalog_item_version_id, deposited_as_role, created_by_profile_id
  ) values (
    v_project_plan.id, p_project_id, 'CATALOG', 1, v_item.published_version_id, v_deposited_as_role, v_uid
  )
  returning * into v_version;

  return v_version;
end;
$$;

create or replace function public.set_retained_project_plan_version(
  p_project_id uuid,
  p_version_id uuid,
  p_expected_revision integer
)
returns public.projects
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership_id uuid;
  v_version public.project_plan_versions;
  v_project public.projects;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- NULL rendait la comparaison "<>" inconnue, donc jamais vraie : la
  -- désignation passait sans contrôle de concurrence. Refus explicite.
  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
    and role = 'OWNER' and owner_profile = 'PRIMARY'
  for update;

  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_version from public.project_plan_versions where id = p_version_id and project_id = p_project_id;
  if not found then
    raise exception 'not_authorized';
  end if;

  if not public.project_plan_version_readable(p_version_id, v_uid) then
    raise exception 'not_readable';
  end if;

  select * into v_project from public.projects where id = p_project_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;

  -- Déplacé ici : relu après la dernière attente (verrou du chantier),
  -- avant la comparaison atomique et la mise à jour.
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_project.revision is distinct from p_expected_revision then
    raise exception 'retained_plan_conflict';
  end if;

  update public.projects
  set retained_plan_version_id = v_version.id
  where id = p_project_id
  returning * into v_project;

  return v_project;
end;
$$;

create or replace function public.list_project_plan_candidates(p_project_id uuid)
returns setof public.project_plan_candidate
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select id into v_membership_id
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'));

  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  return query
  select v.id, v.project_plan_id, v.origin, v.version_number, v.deposited_as_role, v.created_by_profile_id, v.created_at_server,
         exists(select 1 from public.project_plan_version_shares s where s.project_plan_version_id = v.id),
         exists(select 1 from public.projects p where p.id = p_project_id and p.retained_plan_version_id = v.id)
  from public.project_plan_versions v
  where v.project_id = p_project_id
    and public.project_plan_version_readable(v.id, v_uid)
  order by v.created_at_server desc;
end;
$$;

commit;
