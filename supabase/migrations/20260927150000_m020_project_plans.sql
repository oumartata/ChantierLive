-- M020 — project_plans/project_plan_versions/project_plan_version_shares
-- (B063). Rattacher un plan au chantier depuis une version PUBLIÉE du
-- catalogue OU par dépôt direct (OWNER/PRIMARY ou CONTRACTOR). D101-D107
-- (fondateur, VALIDATED) : acteurs, partage explicite CONTRACTOR->OWNER/
-- PRIMARY (jamais l'inverse), désignation du "retenu" réservée à OWNER/
-- PRIMARY, provenance historique (deposited_as_role) sans droit permanent.
-- Hors périmètre, volontairement : B064 (validation technique/publication,
-- plan_validations T051), B065 (devis), FR175 (présentation client du
-- catalogue, non livrée — aucun accès client construit ici).

begin;

-- ----------------------------------------------------------------------------
-- Extension private_object_uploads (M026) : nouveau entity_type project-scopé.
-- ----------------------------------------------------------------------------

alter table public.private_object_uploads
  add constraint private_object_uploads_id_project_unique unique (id, project_id);

alter table public.private_object_uploads
  drop constraint private_object_uploads_entity_type_known;
alter table public.private_object_uploads
  add constraint private_object_uploads_entity_type_known
  check (entity_type in ('media_asset', 'plan_catalog_item_version', 'project_plan_version'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-plans', 'project-plans', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- claim_upload_attempt / recover_media_upload_attempt / get_upload_status —
-- CREATE OR REPLACE additif : une lecture NON VERROUILLÉE précède désormais
-- toute décision, pour connaître entity_type/project_id AVANT de choisir
-- l'ordre de verrous. media_asset et plan_catalog_item_version conservent
-- EXACTEMENT leur comportement déjà appliqué (verrou de la ligne d'abord,
-- inchangé). project_plan_version prend avisoire -> adhésion -> PUIS verrou
-- de la ligne (jamais l'inverse — un rejeu de prepare attendant la ligne
-- pendant qu'un finalize la détient et attend l'avisoire créerait sinon un
-- risque d'interblocage réel, corrigé ici avant toute implémentation).

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
  else
    v_authorized := false;
  end if;

  if not v_authorized then
    raise exception 'operation_access_revoked';
  end if;

  return v_row;
end;
$$;

-- ----------------------------------------------------------------------------
-- project_plans (identité) et project_plan_versions (immuable).
-- ----------------------------------------------------------------------------

create table public.project_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  origin text not null check (origin in ('CATALOG', 'DIRECT')),
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  constraint project_plans_id_project_unique unique (id, project_id),
  constraint project_plans_id_origin_unique unique (id, origin)
);

create index project_plans_project_id_idx on public.project_plans (project_id);

alter table public.project_plans enable row level security;
revoke all privileges on table public.project_plans from public, anon, authenticated;

create table public.project_plan_versions (
  id uuid primary key default gen_random_uuid(),
  project_plan_id uuid not null references public.project_plans (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  origin text not null check (origin in ('CATALOG', 'DIRECT')),
  version_number integer not null check (version_number > 0),
  catalog_item_version_id uuid null references public.plan_catalog_item_versions (id) on delete restrict,
  private_object_upload_id uuid null references public.private_object_uploads (id) on delete restrict,
  deposited_as_role text not null check (deposited_as_role in ('OWNER_PRIMARY', 'CONTRACTOR')),
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  constraint project_plan_versions_number_unique unique (project_plan_id, version_number),
  constraint project_plan_versions_id_project_unique unique (id, project_id),
  constraint project_plan_versions_upload_unique unique (private_object_upload_id),
  constraint project_plan_versions_project_plan_fk
    foreign key (project_plan_id, project_id) references public.project_plans (id, project_id),
  constraint project_plan_versions_origin_fk
    foreign key (project_plan_id, origin) references public.project_plans (id, origin),
  constraint project_plan_versions_origin_ref_consistency check (
    (origin = 'CATALOG' and catalog_item_version_id is not null and private_object_upload_id is null)
    or (origin = 'DIRECT' and private_object_upload_id is not null and catalog_item_version_id is null)
  )
);

create index project_plan_versions_project_plan_id_idx on public.project_plan_versions (project_plan_id);

-- Cohérence chantier du dépôt direct : garantie EN BASE, pas seulement en RPC.
alter table public.project_plan_versions
  add constraint project_plan_versions_upload_project_fk
  foreign key (private_object_upload_id, project_id) references public.private_object_uploads (id, project_id);

create function public.reject_project_plan_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'project_plan_version_immutable';
end;
$$;

create trigger reject_mutation
before update on public.project_plan_versions
for each row execute function public.reject_project_plan_version_mutation();

alter table public.project_plan_versions enable row level security;
revoke all privileges on table public.project_plan_versions from public, anon, authenticated;

-- Pointeur "retenu" — sur projects (un seul par chantier, jamais par candidat).
-- Seule set_retained_project_plan_version écrit cette colonne.
alter table public.projects add column retained_plan_version_id uuid null;
alter table public.projects
  add constraint projects_retained_plan_version_fk
  foreign key (retained_plan_version_id, id) references public.project_plan_versions (id, project_id);

-- ----------------------------------------------------------------------------
-- project_plan_version_shares — partage explicite CONTRACTOR -> OWNER/PRIMARY,
-- insert-only, jamais d'UPDATE (contenu immuable de project_plan_versions
-- intact, jamais un trigger interdisant tout UPDATE en conflit avec un
-- besoin d'UPDATE — ici, aucun UPDATE n'est jamais nécessaire).
-- ----------------------------------------------------------------------------

create table public.project_plan_version_shares (
  id uuid primary key default gen_random_uuid(),
  project_plan_version_id uuid not null unique references public.project_plan_versions (id) on delete restrict,
  shared_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  shared_at_server timestamptz not null default now()
);

alter table public.project_plan_version_shares enable row level security;
revoke all privileges on table public.project_plan_version_shares from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- project_plan_version_readable — prédicat de lecture UNIQUE, réutilisé par
-- get_project_plan_version_file_key ET set_retained_project_plan_version
-- (jamais dupliqué). Droits COURANTS + identité quand la règle vise "son
-- propre dépôt" ; aucun héritage automatique des brouillons privés par un
-- rôle courant seul.
-- ----------------------------------------------------------------------------

create function public.project_plan_version_readable(p_version_id uuid, p_uid uuid)
returns boolean
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
    return false;
  end if;

  if v_version.deposited_as_role = 'OWNER_PRIMARY' then
    if exists (
      select 1 from public.project_memberships
      where project_id = v_version.project_id and profile_id = p_uid and revoked_at is null and role = 'CONTRACTOR'
    ) then
      return true;
    end if;
    if v_version.created_by_profile_id = p_uid and exists (
      select 1 from public.project_memberships
      where project_id = v_version.project_id and profile_id = p_uid and revoked_at is null
        and role = 'OWNER' and owner_profile = 'PRIMARY'
    ) then
      return true;
    end if;
    return false;
  end if;

  if v_version.deposited_as_role = 'CONTRACTOR' then
    if v_version.created_by_profile_id = p_uid and exists (
      select 1 from public.project_memberships
      where project_id = v_version.project_id and profile_id = p_uid and revoked_at is null and role = 'CONTRACTOR'
    ) then
      return true;
    end if;
    if exists (select 1 from public.project_plan_version_shares where project_plan_version_id = v_version.id)
       and exists (
         select 1 from public.project_memberships
         where project_id = v_version.project_id and profile_id = p_uid and revoked_at is null
           and role = 'OWNER' and owner_profile = 'PRIMARY'
       ) then
      return true;
    end if;
    return false;
  end if;

  return false;
end;
$$;

revoke execute on function public.project_plan_version_readable(uuid, uuid)
  from public, anon, authenticated, service_role;
-- Fonction interne : jamais accordée directement, appelée uniquement par
-- d'autres fonctions SECURITY DEFINER ci-dessous.

-- ----------------------------------------------------------------------------
-- prepare_project_plan_upload / finalize_project_plan_upload — dépôt direct,
-- même garanties que B026/B061 (CAS, attestation privilégiée inchangée,
-- finalisation atomique). Ordre : avisoire -> adhésion -> (ligne d'upload,
-- gérée par les fonctions génériques ci-dessus).
-- ----------------------------------------------------------------------------

create function public.prepare_project_plan_upload(
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

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
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

      if v_existing.created_by_profile_id <> v_uid
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

revoke execute on function public.prepare_project_plan_upload(uuid, uuid, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_project_plan_upload(uuid, uuid, text, bigint, text) to authenticated;

create function public.finalize_project_plan_upload(p_operation_uuid uuid)
returns public.project_plan_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_project_id uuid;
  v_row public.private_object_uploads;
  v_membership record;
  v_now timestamptz;
  v_updated integer;
  v_project_plan public.project_plans;
  v_version public.project_plan_versions;
  v_source_key text;
  v_deposited_as_role text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select project_id into v_peek_project_id
  from public.private_object_uploads where operation_uuid = p_operation_uuid;
  if v_peek_project_id is null then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek_project_id::text)::bigint);

  select id, role, owner_profile into v_membership
  from public.project_memberships
  where project_id = v_peek_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if v_membership.id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_row from public.private_object_uploads where operation_uuid = p_operation_uuid for update;
  if not found or v_row.created_by_profile_id <> v_uid or v_row.entity_type <> 'project_plan_version'
     or v_row.project_id is distinct from v_peek_project_id then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  v_deposited_as_role := case when v_membership.role = 'CONTRACTOR' then 'CONTRACTOR' else 'OWNER_PRIMARY' end;

  if v_row.status = 'FINALIZED' then
    select * into v_version from public.project_plan_versions where private_object_upload_id = v_row.id;
    if found then
      return v_version;
    end if;
    raise exception 'finalize_inconsistent_state';
  end if;

  v_now := clock_timestamp();

  if v_row.status <> 'FINALIZING' or v_row.storage_verified_attempt_id is distinct from v_row.attempt_id then
    raise exception 'storage_not_verified';
  end if;

  if v_row.attempt_expires_at <= v_now then
    raise exception 'attempt_expired';
  end if;

  update public.private_object_uploads
  set status = 'FINALIZED',
      storage_key = v_row.candidate_key,
      finalized_at = v_now,
      finalized_by_profile_id = v_uid
  where id = v_row.id
    and attempt_id = v_row.attempt_id
    and status = 'FINALIZING';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'storage_not_verified';
  end if;

  insert into public.project_plans (project_id, origin, created_by_profile_id)
  values (v_row.project_id, 'DIRECT', v_uid)
  returning * into v_project_plan;

  insert into public.project_plan_versions (
    project_plan_id, project_id, origin, version_number, private_object_upload_id, deposited_as_role, created_by_profile_id
  ) values (
    v_project_plan.id, v_row.project_id, 'DIRECT', 1, v_row.id, v_deposited_as_role, v_uid
  )
  returning * into v_version;

  update public.private_object_uploads set entity_id = v_version.id where id = v_row.id;

  v_source_key := '_private/' || v_row.project_id::text || '/project_plan_version/' || v_row.operation_uuid::text || '/source';
  insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
  values (v_row.id, v_source_key, 'source');

  return v_version;
end;
$$;

revoke execute on function public.finalize_project_plan_upload(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_project_plan_upload(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- attach_catalog_plan_to_project — version PUBLIÉE figée au moment de
-- l'appel. Droits chantier ET organisation vérifiés séparément (D107) :
-- l'habilitation chantier ne donne pas l'accès catalogue.
-- ----------------------------------------------------------------------------

create function public.attach_catalog_plan_to_project(p_project_id uuid, p_catalog_item_id uuid)
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

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
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

revoke execute on function public.attach_catalog_plan_to_project(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attach_catalog_plan_to_project(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- share_project_plan_version_with_owner — réservé au CONTRACTOR DÉPOSANT
-- (identité + rôle courant actif), jamais un CONTRACTOR quelconque.
-- ----------------------------------------------------------------------------

create function public.share_project_plan_version_with_owner(p_version_id uuid)
returns public.project_plan_version_shares
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_version public.project_plan_versions;
  v_membership_id uuid;
  v_row public.project_plan_version_shares;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_version from public.project_plan_versions where id = p_version_id;
  if not found or v_version.deposited_as_role <> 'CONTRACTOR' or v_version.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_version.project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = v_version.project_id
    and profile_id = v_uid
    and revoked_at is null
    and role = 'CONTRACTOR'
  for update;

  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  insert into public.project_plan_version_shares (project_plan_version_id, shared_by_profile_id)
  values (p_version_id, v_uid)
  on conflict (project_plan_version_id) do nothing;

  select * into v_row from public.project_plan_version_shares where project_plan_version_id = p_version_id;
  return v_row;
end;
$$;

revoke execute on function public.share_project_plan_version_with_owner(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.share_project_plan_version_with_owner(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- set_retained_project_plan_version — réservé à OWNER/PRIMARY, version du
-- même chantier ET lisible par cet appelant (project_plan_version_readable),
-- concurrence optimiste sur projects.revision (déjà existante, M004) :
-- comparaison atomique, conflit explicite SANS écriture si dépassée.
-- ----------------------------------------------------------------------------

create function public.set_retained_project_plan_version(
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

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
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

  if v_project.revision <> p_expected_revision then
    raise exception 'retained_plan_conflict';
  end if;

  update public.projects
  set retained_plan_version_id = v_version.id
  where id = p_project_id
  returning * into v_project;

  return v_project;
end;
$$;

revoke execute on function public.set_retained_project_plan_version(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.set_retained_project_plan_version(uuid, uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- get_project_plan_version_file_key — accès réel au fichier, prédicat unique
-- (project_plan_version_readable), statut FINALIZED revérifié explicitement
-- (jamais déduit de la seule FK), quelle que soit l'origine.
-- ----------------------------------------------------------------------------

create function public.get_project_plan_version_file_key(p_version_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_membership_id uuid;
  v_version public.project_plan_versions;
  v_upload_status text;
  v_storage_key text;
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
  where project_id = v_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if not public.project_plan_version_readable(p_version_id, v_uid) then
    raise exception 'not_authorized';
  end if;

  select * into v_version from public.project_plan_versions where id = p_version_id;

  if v_version.origin = 'DIRECT' then
    select status, storage_key into v_upload_status, v_storage_key
    from public.private_object_uploads where id = v_version.private_object_upload_id;
  else
    select u.status, u.storage_key into v_upload_status, v_storage_key
    from public.private_object_uploads u
    join public.plan_catalog_item_versions civ on civ.private_object_upload_id = u.id
    where civ.id = v_version.catalog_item_version_id;
  end if;

  if v_upload_status is distinct from 'FINALIZED' then
    raise exception 'file_not_finalized';
  end if;

  return v_storage_key;
end;
$$;

revoke execute on function public.get_project_plan_version_file_key(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_project_plan_version_file_key(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- list_project_plan_candidates — lecture des candidats d'un chantier, filtrée
-- par le même prédicat (jamais une liste plus large que ce que chacun peut
-- individuellement lire).
-- ----------------------------------------------------------------------------

create type public.project_plan_candidate as (
  version_id uuid,
  project_plan_id uuid,
  origin text,
  version_number integer,
  deposited_as_role text,
  created_by_profile_id uuid,
  created_at_server timestamptz,
  is_shared boolean,
  is_retained boolean
);

create function public.list_project_plan_candidates(p_project_id uuid)
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
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if v_membership_id is null then
    raise exception 'not_authorized';
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

revoke execute on function public.list_project_plan_candidates(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_project_plan_candidates(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Nettoyage — troisième domaine, branché sur le mécanisme existant.
-- ----------------------------------------------------------------------------

create function public.list_expired_project_plan_uploads(p_older_than interval default interval '1 hour')
returns table (id uuid, project_id uuid, attempt_expires_at timestamptz)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.project_id, u.attempt_expires_at
  from public.private_object_uploads u
  where u.entity_type = 'project_plan_version'
    and u.status in ('PENDING', 'FINALIZING')
    and u.attempt_expires_at < now() - p_older_than;
$$;

revoke execute on function public.list_expired_project_plan_uploads(interval)
  from public, anon, authenticated, service_role;
grant execute on function public.list_expired_project_plan_uploads(interval) to service_role;

create function public.abandon_expired_project_plan_upload(p_id uuid, p_older_than interval default interval '1 hour')
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.private_object_uploads;
  v_source_key text;
begin
  select * into v_row from public.private_object_uploads where id = p_id for update;

  if not found or v_row.entity_type <> 'project_plan_version' then
    return false;
  end if;

  if v_row.status not in ('PENDING', 'FINALIZING') or v_row.attempt_expires_at >= now() - p_older_than then
    return false;
  end if;

  if v_row.write_claimed_at is not null then
    insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
    values (v_row.id, v_row.candidate_key, 'candidate');
  end if;

  v_source_key := '_private/' || v_row.project_id::text || '/project_plan_version/' || v_row.operation_uuid::text || '/source';
  insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
  values (v_row.id, v_source_key, 'source');

  update public.private_object_uploads set status = 'ABANDONED' where id = v_row.id;

  return true;
end;
$$;

revoke execute on function public.abandon_expired_project_plan_upload(uuid, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.abandon_expired_project_plan_upload(uuid, interval) to service_role;

create or replace function public.get_stale_key_bucket(p_id uuid)
returns text
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select case u.entity_type
    when 'media_asset' then 'project-media'
    when 'plan_catalog_item_version' then 'organization-catalog'
    when 'project_plan_version' then 'project-plans'
    else null
  end
  from public.private_object_stale_keys k
  join public.private_object_uploads u on u.id = k.private_object_upload_id
  where k.id = p_id;
$$;

commit;
