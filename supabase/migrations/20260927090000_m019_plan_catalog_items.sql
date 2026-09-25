-- M019 — plan_catalog_items (B061, terminée et validée par le fondateur). Catalogue de
-- plans par agence : dépôt -> soumission à l'ingénieur -> décision -> publi-
-- cation. Table de validation PROPRE au catalogue (plan_catalog_item_
-- validations), INDÉPENDANTE de plan_validations chantier (T051, différée à
-- B063/B064) — aucune colonne project_id, aucune dépendance vers project_
-- plans (M020). Seul point de partage avec B062 : le contrôle d'habilitation
-- (plan_engineer_designations), jamais une table de décision commune.
--
-- Étend M026 (private_object_uploads, déjà appliquée, non modifiée) de façon
-- additive : nouvelle contrainte, nouveau entity_type, fonctions génériques
-- remplacées via CREATE OR REPLACE (préserve les GRANTs existants) pour
-- brancher EXPLICITEMENT sur entity_type ET le rattachement organisationnel
-- attendu — jamais un simple "organization_id is not null". attest_storage_
-- verified reste INCHANGÉE (déjà générique, service_role uniquement).
--
-- Ordre de verrous uniforme sur tous les chemins mutants ou lisant un fichier
-- (soumission, remplacement d'une demande devenue inutilisable, décision,
-- accès au fichier) : désignation(s) AVANT la ligne de validation. Toute
-- lecture initiale sans verrou ne sert qu'à retrouver les rattachements ;
-- relecture et revérification systématiques sous verrou ensuite.

begin;

-- ----------------------------------------------------------------------------
-- Extension private_object_uploads (M026) — additive uniquement.
-- ----------------------------------------------------------------------------

alter table public.private_object_uploads
  add constraint private_object_uploads_id_org_unique unique (id, organization_id);

alter table public.private_object_uploads
  drop constraint private_object_uploads_entity_type_known;
alter table public.private_object_uploads
  add constraint private_object_uploads_entity_type_known
  check (entity_type in ('media_asset', 'plan_catalog_item_version'));

create index private_object_uploads_org_entity_idx
  on public.private_object_uploads (organization_id, entity_type)
  where organization_id is not null;

alter type public.upload_claim_result add attribute organization_id uuid;

-- claim_upload_attempt — CREATE OR REPLACE : branche sur entity_type, jamais
-- un organization_id non null seul. Chemin media_asset strictement inchangé.
create or replace function public.claim_upload_attempt(p_operation_uuid uuid)
returns public.upload_claim_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.private_object_uploads;
  v_now timestamptz;
  v_authorized boolean;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

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
  else
    v_authorized := false;
  end if;

  if not v_authorized then
    raise exception 'not_authorized';
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

-- recover_media_upload_attempt — même branchement. Pas d'écriture
-- audit_events pour la branche organisationnelle (project_id NOT NULL,
-- M005 — même principe déjà appliqué par B062/M023).
create or replace function public.recover_media_upload_attempt(p_operation_uuid uuid)
returns public.private_object_uploads
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.private_object_uploads;
  v_now timestamptz;
  v_new_attempt uuid;
  v_new_candidate text;
  v_authorized boolean;
  v_path_prefix text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

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
    v_path_prefix := '_private/' || v_row.project_id::text || '/media_asset/' || v_row.operation_uuid::text;
  elsif v_row.entity_type = 'plan_catalog_item_version' then
    v_authorized := exists (
      select 1 from public.organizations
      where id = v_row.organization_id
        and owner_profile_id = v_uid
        and archived_at is null
    );
    v_path_prefix := '_private/' || v_row.organization_id::text || '/plan_catalog_item_version/' || v_row.operation_uuid::text;
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

-- get_upload_status — même branchement, lecture seule.
create or replace function public.get_upload_status(p_operation_uuid uuid)
returns public.private_object_uploads
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.private_object_uploads;
  v_authorized boolean;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
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
-- plan_catalog_items (T044) — identité stable du modèle. published_version_id
-- ajouté SANS sa FK ici (la table cible n'existe pas encore) : contrainte
-- ajoutée plus bas, après création de plan_catalog_item_versions.
-- ----------------------------------------------------------------------------

create table public.plan_catalog_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  label text not null,
  published_version_id uuid null,
  published_at_server timestamptz null,
  published_by_profile_id uuid null references public.profiles (id) on delete restrict,
  archived_at timestamptz null,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  constraint plan_catalog_items_label_not_blank check (btrim(label) <> ''),
  constraint plan_catalog_items_published_consistency check (
    (published_version_id is null) = (published_at_server is null)
    and (published_version_id is null) = (published_by_profile_id is null)
  ),
  constraint plan_catalog_items_id_org_unique unique (id, organization_id)
);

create index plan_catalog_items_organization_id_idx on public.plan_catalog_items (organization_id);

create trigger set_updated_at_server
before update on public.plan_catalog_items
for each row execute function public.set_updated_at_server();

alter table public.plan_catalog_items enable row level security;
revoke all privileges on table public.plan_catalog_items from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- plan_catalog_item_versions — chaque ligne est un fichier finalisé IMMUABLE.
-- Une modification crée une NOUVELLE ligne, jamais une réécriture (trigger
-- ci-dessous : aucun UPDATE n'est jamais autorisé sur cette table). FK
-- composites : version/item/organisation et version/fichier/organisation
-- garantis identiques AU NIVEAU BASE, pas seulement par contrôle RPC.
-- ----------------------------------------------------------------------------

create table public.plan_catalog_item_versions (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references public.plan_catalog_items (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  version_number integer not null,
  private_object_upload_id uuid not null references public.private_object_uploads (id) on delete restrict,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  constraint plan_catalog_item_versions_number_unique unique (catalog_item_id, version_number),
  constraint plan_catalog_item_versions_upload_unique unique (private_object_upload_id),
  constraint plan_catalog_item_versions_number_positive check (version_number > 0),
  constraint plan_catalog_item_versions_id_item_unique unique (id, catalog_item_id),
  constraint plan_catalog_item_versions_id_org_unique unique (id, organization_id),
  constraint plan_catalog_item_versions_item_org_fk
    foreign key (catalog_item_id, organization_id) references public.plan_catalog_items (id, organization_id),
  constraint plan_catalog_item_versions_upload_org_fk
    foreign key (private_object_upload_id, organization_id) references public.private_object_uploads (id, organization_id)
);

create index plan_catalog_item_versions_catalog_item_id_idx on public.plan_catalog_item_versions (catalog_item_id);

create function public.reject_catalog_item_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'catalog_item_version_immutable';
end;
$$;

create trigger reject_mutation
before update on public.plan_catalog_item_versions
for each row execute function public.reject_catalog_item_version_mutation();

alter table public.plan_catalog_item_versions enable row level security;
revoke all privileges on table public.plan_catalog_item_versions from public, anon, authenticated;

-- FK différée : published_version_id doit référencer une version du MÊME
-- item (clé composite), pas seulement un id de version existant.
alter table public.plan_catalog_items
  add constraint plan_catalog_items_published_version_fk
  foreign key (published_version_id, id) references public.plan_catalog_item_versions (id, catalog_item_id);

-- ----------------------------------------------------------------------------
-- plan_catalog_item_upload_targets — lie chaque opération d'upload à SON item
-- cible, dans un paramètre immuable de l'opération (jamais réécrit). Un
-- rejeu de prepare_catalog_item_upload avec un item DIFFÉRENT, même dans la
-- même organisation, est détecté et refusé via cette table (voir
-- prepare_catalog_item_upload plus bas).
-- ----------------------------------------------------------------------------

create table public.plan_catalog_item_upload_targets (
  private_object_upload_id uuid primary key references public.private_object_uploads (id) on delete restrict,
  catalog_item_id uuid not null references public.plan_catalog_items (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  constraint plan_catalog_item_upload_targets_item_org_fk
    foreign key (catalog_item_id, organization_id) references public.plan_catalog_items (id, organization_id),
  constraint plan_catalog_item_upload_targets_upload_org_fk
    foreign key (private_object_upload_id, organization_id) references public.private_object_uploads (id, organization_id)
);

alter table public.plan_catalog_item_upload_targets enable row level security;
revoke all privileges on table public.plan_catalog_item_upload_targets from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- plan_catalog_item_validations — table de décision PROPRE au catalogue,
-- SANS colonne project_id, SANS référence à project_plans/plan_validations.
-- designation_id référence la désignation PRÉCISE au moment de la soumission
-- (pas seulement l'organisation) : si cette désignation est révoquée, la
-- ligne reste liée à une désignation révoquée pour toujours (plan_engineer_
-- designations ne rouvre jamais une ligne révoquée, B062) — une nouvelle
-- soumission crée une NOUVELLE ligne vers la désignation active courante,
-- jamais une réactivation implicite de l'ancienne.
--
-- status distingue explicitement une décision de l'ingénieur (VALIDATED/
-- REJECTED) d'une clôture administrative (CANCELLED, ex. désignation
-- devenue inutilisable) — jamais confondues (CHECK ci-dessous). Trigger :
-- aucune modification une fois status <> 'PENDING' (immutabilité réelle,
-- pas seulement une discipline RPC).
-- ----------------------------------------------------------------------------

-- plan_engineer_designations (id, organization_id) requis par la FK
-- composite ci-dessous (id est déjà clé primaire, ajout trivial). Doit
-- exister AVANT la création de plan_catalog_item_validations.
alter table public.plan_engineer_designations
  add constraint plan_engineer_designations_id_org_unique unique (id, organization_id);

create table public.plan_catalog_item_validations (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.plan_catalog_item_versions (id) on delete restrict,
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
  constraint plan_catalog_item_validations_status_known
    check (status in ('PENDING', 'VALIDATED', 'REJECTED', 'CANCELLED')),
  constraint plan_catalog_item_validations_status_consistency check (
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
  constraint plan_catalog_item_validations_version_org_fk
    foreign key (version_id, organization_id) references public.plan_catalog_item_versions (id, organization_id),
  constraint plan_catalog_item_validations_designation_org_fk
    foreign key (designation_id, organization_id) references public.plan_engineer_designations (id, organization_id)
);

-- Une seule demande PENDING par version.
create unique index plan_catalog_item_validations_pending_unique
  on public.plan_catalog_item_validations (version_id)
  where status = 'PENDING';

create index plan_catalog_item_validations_designation_idx on public.plan_catalog_item_validations (designation_id);

create function public.reject_terminal_catalog_item_validation_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'PENDING' then
    raise exception 'validation_already_terminal';
  end if;
  return new;
end;
$$;

create trigger reject_terminal_mutation
before update on public.plan_catalog_item_validations
for each row execute function public.reject_terminal_catalog_item_validation_mutation();

alter table public.plan_catalog_item_validations enable row level security;
revoke all privileges on table public.plan_catalog_item_validations from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- create_catalog_item — dépôt de l'IDENTITÉ du modèle (pas un fichier).
-- Réservé au propriétaire courant de l'organisation.
-- ----------------------------------------------------------------------------

create function public.create_catalog_item(p_organization_id uuid, p_label text)
returns public.plan_catalog_items
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org public.organizations;
  v_row public.plan_catalog_items;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_label is null or btrim(p_label) = '' then
    raise exception 'label_required';
  end if;

  select * into v_org from public.organizations where id = p_organization_id for update;
  if not found or v_org.archived_at is not null or v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  insert into public.plan_catalog_items (organization_id, created_by_profile_id, label)
  values (v_org.id, v_uid, btrim(p_label))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_catalog_item(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.create_catalog_item(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- prepare_catalog_item_upload — PREPARE organisationnel. Lie l'opération à
-- l'item cible via plan_catalog_item_upload_targets (paramètre immuable,
-- jamais réécrit) : un rejeu du même operation_uuid avec un item DIFFÉRENT,
-- même dans la même organisation, est explicitement refusé.
-- ----------------------------------------------------------------------------

create function public.prepare_catalog_item_upload(
  p_operation_uuid uuid,
  p_organization_id uuid,
  p_catalog_item_id uuid,
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
  v_existing public.private_object_uploads;
  v_attempt_id uuid;
  v_candidate_key text;
  v_now timestamptz;
  v_row public.private_object_uploads;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_operation_uuid is null or p_organization_id is null or p_catalog_item_id is null then
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

  if not exists (
    select 1 from public.organizations
    where id = p_organization_id and owner_profile_id = v_uid and archived_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  if not exists (
    select 1 from public.plan_catalog_items
    where id = p_catalog_item_id and organization_id = p_organization_id and archived_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  v_now := clock_timestamp();
  v_attempt_id := gen_random_uuid();
  v_candidate_key := '_private/' || p_organization_id::text || '/plan_catalog_item_version/' || p_operation_uuid::text || '/candidates/' || v_attempt_id::text;

  begin
    insert into public.private_object_uploads (
      operation_uuid, organization_id, entity_type, created_by_profile_id,
      attempt_id, attempt_expires_at, candidate_key,
      expected_checksum, expected_size_bytes, expected_mime_type
    ) values (
      p_operation_uuid, p_organization_id, 'plan_catalog_item_version', v_uid,
      v_attempt_id, v_now + interval '15 minutes', v_candidate_key,
      p_expected_checksum, p_expected_size_bytes, p_expected_mime_type
    )
    returning * into v_row;

    insert into public.plan_catalog_item_upload_targets (private_object_upload_id, catalog_item_id, organization_id)
    values (v_row.id, p_catalog_item_id, p_organization_id);

    return v_row;
  exception
    when unique_violation then
      select * into v_existing
      from public.private_object_uploads
      where operation_uuid = p_operation_uuid;

      if v_existing.created_by_profile_id <> v_uid
         or v_existing.organization_id is distinct from p_organization_id
         or v_existing.expected_checksum <> p_expected_checksum
         or v_existing.expected_size_bytes <> p_expected_size_bytes
         or v_existing.expected_mime_type <> p_expected_mime_type
      then
        raise exception 'operation_uuid_conflict';
      end if;

      if not exists (
        select 1 from public.plan_catalog_item_upload_targets
        where private_object_upload_id = v_existing.id and catalog_item_id = p_catalog_item_id
      ) then
        -- Même operation_uuid, mêmes paramètres d'upload, item CIBLE
        -- différent : jamais réinterprété comme la même opération.
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

revoke execute on function public.prepare_catalog_item_upload(uuid, uuid, uuid, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_catalog_item_upload(uuid, uuid, uuid, text, bigint, text) to authenticated;

-- ----------------------------------------------------------------------------
-- finalize_catalog_item_upload — FINALIZE + création atomique de la version,
-- dans la MÊME transaction (même principe que finalize_media_upload). Le
-- statut FINALIZED du fichier est garanti PAR CONSTRUCTION à l'insertion de
-- la version (mise à jour CAS juste avant, même transaction) — pas seulement
-- par la FK composite. Numéro de version calculé sous verrou de l'item :
-- deux finalisations concurrentes du même item ne peuvent jamais produire le
-- même numéro ni une ligne en double pour un rejeu (idempotence conservée
-- via le statut FINALIZED déjà atteint).
-- ----------------------------------------------------------------------------

create function public.finalize_catalog_item_upload(p_operation_uuid uuid)
returns public.plan_catalog_item_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.private_object_uploads;
  v_target public.plan_catalog_item_upload_targets;
  v_now timestamptz;
  v_version public.plan_catalog_item_versions;
  v_updated integer;
  v_next_version_number integer;
  v_source_key text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.created_by_profile_id <> v_uid or v_row.entity_type <> 'plan_catalog_item_version' then
    raise exception 'not_authorized';
  end if;

  if not exists (
    select 1 from public.organizations
    where id = v_row.organization_id and owner_profile_id = v_uid and archived_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  select * into v_target from public.plan_catalog_item_upload_targets where private_object_upload_id = v_row.id;
  if not found then
    raise exception 'finalize_inconsistent_state';
  end if;

  if v_row.status = 'FINALIZED' then
    select * into v_version from public.plan_catalog_item_versions where private_object_upload_id = v_row.id;
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

  perform 1 from public.plan_catalog_items where id = v_target.catalog_item_id for update;

  select coalesce(max(version_number), 0) + 1 into v_next_version_number
  from public.plan_catalog_item_versions
  where catalog_item_id = v_target.catalog_item_id;

  insert into public.plan_catalog_item_versions (
    catalog_item_id, organization_id, version_number, private_object_upload_id, created_by_profile_id
  ) values (
    v_target.catalog_item_id, v_row.organization_id, v_next_version_number, v_row.id, v_uid
  )
  returning * into v_version;

  update public.private_object_uploads set entity_id = v_version.id where id = v_row.id;

  v_source_key := '_private/' || v_row.organization_id::text || '/plan_catalog_item_version/' || v_row.operation_uuid::text || '/source';
  insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
  values (v_row.id, v_source_key, 'source');

  return v_version;
end;
$$;

revoke execute on function public.finalize_catalog_item_upload(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_catalog_item_upload(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- submit_catalog_item_version_for_validation — mutation PROPRIÉTAIRE.
-- Ordre de verrous : organizations (propriété revérifiée) -> plan_catalog_
-- items -> désignation(s) concernée(s), verrouillées ENSEMBLE dans un ordre
-- déterministe (id croissant, via un curseur FOR UPDATE trié) pour éviter
-- tout interblocage entre deux soumissions concurrentes qui échangeraient
-- les mêmes deux désignations -> ligne de validation PENDING existante
-- (verrouillée APRÈS sa désignation). Une demande PENDING dont la
-- désignation est révoquée est close en CANCELLED (motif enregistré) avant
-- l'insertion de la nouvelle ; si sa désignation est encore active, refus
-- already_pending (aucune annulation volontaire ajoutée, hors périmètre).
-- ----------------------------------------------------------------------------

create function public.submit_catalog_item_version_for_validation(
  p_version_id uuid,
  p_designation_id uuid
)
returns public.plan_catalog_item_validations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_catalog_item_id uuid;
  v_org public.organizations;
  v_item public.plan_catalog_items;
  v_version public.plan_catalog_item_versions;
  v_old_designation_id uuid;
  v_designation_row public.plan_engineer_designations;
  v_new_designation public.plan_engineer_designations;
  v_old_designation public.plan_engineer_designations;
  v_existing_validation public.plan_catalog_item_validations;
  v_row public.plan_catalog_item_validations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Lecture non verrouillée : uniquement pour retrouver les rattachements.
  select v.catalog_item_id, v.organization_id into v_catalog_item_id, v_org_id
  from public.plan_catalog_item_versions v
  where v.id = p_version_id;

  if v_catalog_item_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_org from public.organizations where id = v_org_id for update;
  if not found or v_org.archived_at is not null or v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select * into v_item from public.plan_catalog_items where id = v_catalog_item_id for update;
  if not found or v_item.organization_id <> v_org.id or v_item.archived_at is not null then
    raise exception 'not_authorized';
  end if;

  select * into v_version from public.plan_catalog_item_versions where id = p_version_id;
  if not found or v_version.catalog_item_id <> v_item.id then
    raise exception 'not_authorized';
  end if;

  select designation_id into v_old_designation_id
  from public.plan_catalog_item_validations
  where version_id = p_version_id and status = 'PENDING';

  -- Désignation(s) AVANT validation, verrouillées ensemble en ordre déterministe.
  for v_designation_row in
    select * from public.plan_engineer_designations
    where id = any (array_remove(array[p_designation_id, v_old_designation_id], null))
    order by id
    for update
  loop
    if v_designation_row.id = p_designation_id then
      v_new_designation := v_designation_row;
    end if;
    if v_old_designation_id is not null and v_designation_row.id = v_old_designation_id then
      v_old_designation := v_designation_row;
    end if;
  end loop;

  if v_new_designation.id is null or v_new_designation.revoked_at is not null or v_new_designation.organization_id <> v_org.id then
    raise exception 'not_authorized';
  end if;

  if v_old_designation_id is not null then
    select * into v_existing_validation
    from public.plan_catalog_item_validations
    where version_id = p_version_id and status = 'PENDING'
    for update;

    if found then
      if v_old_designation.revoked_at is null then
        raise exception 'already_pending';
      end if;

      update public.plan_catalog_item_validations
      set status = 'CANCELLED', cancelled_at_server = clock_timestamp(),
          cancelled_by_profile_id = v_uid, cancelled_reason = 'designation_revoked'
      where id = v_existing_validation.id;
    end if;
  end if;

  begin
    insert into public.plan_catalog_item_validations (
      version_id, designation_id, organization_id, submitted_by_profile_id, submitted_at_server, status
    ) values (
      p_version_id, p_designation_id, v_org.id, v_uid, clock_timestamp(), 'PENDING'
    )
    returning * into v_row;
  exception
    when unique_violation then
      raise exception 'already_pending';
  end;

  return v_row;
end;
$$;

revoke execute on function public.submit_catalog_item_version_for_validation(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_catalog_item_version_for_validation(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- decide_catalog_item_validation — mutation INGÉNIEUR. Ordre de verrous :
-- désignation (résolue par une lecture non verrouillée de la ligne de
-- validation, verrouillée ensuite) -> ligne de validation, revalidée sous
-- son propre verrou (jamais depuis la lecture initiale).
-- ----------------------------------------------------------------------------

create function public.decide_catalog_item_validation(
  p_validation_id uuid,
  p_decision text,
  p_note text
)
returns public.plan_catalog_item_validations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_designation_id uuid;
  v_designation public.plan_engineer_designations;
  v_row public.plan_catalog_item_validations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_decision not in ('VALIDATED', 'REJECTED') then
    raise exception 'invalid_decision';
  end if;

  select designation_id into v_designation_id
  from public.plan_catalog_item_validations where id = p_validation_id;

  if v_designation_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_designation from public.plan_engineer_designations where id = v_designation_id for update;
  if not found or v_designation.revoked_at is not null or v_designation.engineer_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  select * into v_row from public.plan_catalog_item_validations where id = p_validation_id for update;
  if not found or v_row.designation_id <> v_designation.id then
    raise exception 'not_authorized';
  end if;

  if v_row.status <> 'PENDING' then
    raise exception 'already_decided';
  end if;

  update public.plan_catalog_item_validations
  set status = p_decision, decided_at_server = clock_timestamp(), decided_by_profile_id = v_uid,
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.decide_catalog_item_validation(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.decide_catalog_item_validation(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- publish_catalog_item_version — mutation PROPRIÉTAIRE. Seul appel explicite
-- modifiant published_version_id : une version simplement VALIDATED, ou plus
-- récente, ne remplace jamais silencieusement la version publiée. Statut
-- FINALIZED du fichier revérifié EXPLICITEMENT ici (la FK composite garantit
-- le rattachement organisationnel, pas ce statut).
-- ----------------------------------------------------------------------------

create function public.publish_catalog_item_version(p_version_id uuid)
returns public.plan_catalog_items
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_catalog_item_id uuid;
  v_org public.organizations;
  v_item public.plan_catalog_items;
  v_version public.plan_catalog_item_versions;
  v_upload public.private_object_uploads;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select v.catalog_item_id, v.organization_id into v_catalog_item_id, v_org_id
  from public.plan_catalog_item_versions v where v.id = p_version_id;

  if v_catalog_item_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_org from public.organizations where id = v_org_id for update;
  if not found or v_org.archived_at is not null or v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select * into v_item from public.plan_catalog_items where id = v_catalog_item_id for update;
  if not found or v_item.organization_id <> v_org.id or v_item.archived_at is not null then
    raise exception 'not_authorized';
  end if;

  select * into v_version from public.plan_catalog_item_versions where id = p_version_id;
  if not found or v_version.catalog_item_id <> v_item.id then
    raise exception 'not_authorized';
  end if;

  select * into v_upload from public.private_object_uploads where id = v_version.private_object_upload_id;
  if not found or v_upload.status <> 'FINALIZED' then
    raise exception 'file_not_finalized';
  end if;

  if not exists (
    select 1 from public.plan_catalog_item_validations
    where version_id = p_version_id and status = 'VALIDATED'
  ) then
    raise exception 'version_not_validated';
  end if;

  update public.plan_catalog_items
  set published_version_id = v_version.id,
      published_at_server = clock_timestamp(),
      published_by_profile_id = v_uid
  where id = v_item.id
  returning * into v_item;

  return v_item;
end;
$$;

revoke execute on function public.publish_catalog_item_version(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_catalog_item_version(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- list_organization_catalog_items — lecture PROPRIÉTAIRE (réservée, comme
-- list_organization_engineers).
-- ----------------------------------------------------------------------------

create type public.catalog_item_view as (
  id uuid,
  label text,
  published_version_id uuid,
  published_at_server timestamptz,
  archived_at timestamptz,
  latest_version_id uuid,
  latest_version_number integer,
  latest_validation_status text
);

create function public.list_organization_catalog_items(p_organization_id uuid)
returns setof public.catalog_item_view
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select
    i.id, i.label, i.published_version_id, i.published_at_server, i.archived_at,
    lv.id as latest_version_id, lv.version_number as latest_version_number,
    lval.status as latest_validation_status
  from public.plan_catalog_items i
  join public.organizations o on o.id = i.organization_id
  left join lateral (
    select v.* from public.plan_catalog_item_versions v
    where v.catalog_item_id = i.id order by v.version_number desc limit 1
  ) lv on true
  left join lateral (
    select val.* from public.plan_catalog_item_validations val
    where val.version_id = lv.id order by val.submitted_at_server desc limit 1
  ) lval on true
  where i.organization_id = p_organization_id
    and o.owner_profile_id = auth.uid();
$$;

revoke execute on function public.list_organization_catalog_items(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_catalog_items(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- list_submitted_catalog_item_validations — lecture INGÉNIEUR, strictement
-- limitée aux demandes PENDING dont la désignation référencée est active et
-- lui appartient (jamais les brouillons, jamais un autre ingénieur).
-- ----------------------------------------------------------------------------

create type public.submitted_catalog_item_validation as (
  validation_id uuid,
  version_id uuid,
  catalog_item_id uuid,
  organization_id uuid,
  version_number integer,
  submitted_at_server timestamptz
);

create function public.list_submitted_catalog_item_validations()
returns setof public.submitted_catalog_item_validation
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select val.id, val.version_id, v.catalog_item_id, val.organization_id, v.version_number, val.submitted_at_server
  from public.plan_catalog_item_validations val
  join public.plan_engineer_designations d on d.id = val.designation_id
  join public.plan_catalog_item_versions v on v.id = val.version_id
  where val.status = 'PENDING'
    and d.revoked_at is null
    and d.engineer_profile_id = auth.uid();
$$;

revoke execute on function public.list_submitted_catalog_item_validations()
  from public, anon, authenticated, service_role;
grant execute on function public.list_submitted_catalog_item_validations() to authenticated;

-- ----------------------------------------------------------------------------
-- get_catalog_item_validation_file_key — accès RÉEL au fichier exact soumis.
-- Ordre de verrous : désignation d'abord (active, appartient à l'appelant),
-- puis ligne de validation (PENDING, même désignation). Statut FINALIZED
-- revérifié EXPLICITEMENT ici (la FK composite ne le garantit pas). Aucun
-- accès global à l'organisation : une seule clé de stockage exacte renvoyée,
-- jamais une liste. La génération de l'URL signée elle-même (Server Action,
-- Supabase Storage) reste scopée à cette seule clé, expiration courte.
-- Limite connue conservée, non résolue ici : une URL déjà signée reste
-- utilisable jusqu'à son expiration même si la désignation est révoquée
-- immédiatement après (même limite déjà acceptée pour B026/B027).
-- ----------------------------------------------------------------------------

create function public.get_catalog_item_validation_file_key(p_validation_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_designation_id uuid;
  v_designation public.plan_engineer_designations;
  v_row public.plan_catalog_item_validations;
  v_version public.plan_catalog_item_versions;
  v_upload public.private_object_uploads;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select designation_id into v_designation_id
  from public.plan_catalog_item_validations where id = p_validation_id;

  if v_designation_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_designation from public.plan_engineer_designations where id = v_designation_id for update;
  if not found or v_designation.revoked_at is not null or v_designation.engineer_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  select * into v_row from public.plan_catalog_item_validations where id = p_validation_id for update;
  if not found or v_row.designation_id <> v_designation.id or v_row.status <> 'PENDING' then
    raise exception 'not_authorized';
  end if;

  select * into v_version from public.plan_catalog_item_versions where id = v_row.version_id;
  if not found then
    raise exception 'not_authorized';
  end if;

  select * into v_upload from public.private_object_uploads where id = v_version.private_object_upload_id;
  if not found or v_upload.status <> 'FINALIZED' then
    raise exception 'file_not_finalized';
  end if;

  return v_upload.storage_key;
end;
$$;

revoke execute on function public.get_catalog_item_validation_file_key(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_catalog_item_validation_file_key(uuid) to authenticated;

commit;
