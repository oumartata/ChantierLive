-- M039 — B028 : documents et versions (done_when : « remplacement conserve
-- ancienne version »). Décisions du fondateur 2026-10-07 : D169–D176
-- (M1–M8). Conception : MIGRATION_ORDER.csv M011 (« documents
-- document_versions »), T020/T021, BR064–BR067, FR107–FR112 ; identifiant
-- M011 jamais réutilisé comme nom de fichier.
--
-- - Dépôt (D171) : entreprise ou propriétaire principal actif, compte
--   vérifié ; fichier PDF/JPEG/PNG/WebP de 20 Mo au plus, type réel attesté
--   par le serveur sur les octets stockés (attest_storage_verified, M010) ;
--   aucun antivirus (D176).
-- - Brouillon (D170) : visible par son auteur seul ; publication explicite
--   par l'auteur ; visibilité figée ensuite (D173).
-- - Visibilité (D169) : TOUS (quatre rôles actifs), PRINCIPAUX (entreprise,
--   propriétaire principal, copropriétaire ; défaut), ENTREPRISE (dépôts de
--   l'entreprise seulement). Chef de chantier : TOUS seulement.
-- - Versions (D172, BR067, AC112) : insertion seule ; nouvelle version par
--   la partie qui a déposé le document, publiée immédiatement, type et
--   visibilité repris ; l'ancienne reste lisible.
-- - Archivage (D174) : par la partie propriétaire (brouillon : son auteur),
--   motif obligatoire ; versions conservées.
-- - Types (D175) : les 9 de BR064.
-- - Droits toujours vrai ou faux (leçon de M038c) ; audit à chaque action.
-- - Circuit d'envoi générique (M026) : nouveau type d'entité
--   document_version, bucket privé project-documents ; claim/recover/
--   get_upload_status repris à l'identique de M014, seule la branche
--   document_version est ajoutée.

begin;

-- ---------------------------------------------------------------------------
-- Stockage : type d'entité et bucket privé.
-- ---------------------------------------------------------------------------
alter table public.private_object_uploads drop constraint private_object_uploads_entity_type_known;
alter table public.private_object_uploads add constraint private_object_uploads_entity_type_known
  check (entity_type in ('media_asset', 'plan_catalog_item_version', 'project_plan_version', 'advance_receipt', 'document_version'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-documents', 'project-documents', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  deposited_as_role text not null check (deposited_as_role in ('CONTRACTOR', 'OWNER_PRIMARY')),
  document_type text not null,
  title text not null,
  description text null,
  visibility text not null,
  status text not null default 'BROUILLON',
  current_version_id uuid null,
  revision integer not null default 0 check (revision >= 0),
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  published_at_server timestamptz null,
  archived_at_server timestamptz null,
  archived_by_profile_id uuid null references public.profiles (id) on delete restrict,
  archive_reason text null,
  constraint documents_id_project_unique unique (id, project_id),
  constraint documents_type_known check (document_type in ('PLAN', 'DEVIS', 'CONTRAT', 'RECU', 'FACTURE', 'AUTORISATION', 'RAPPORT', 'PROCES_VERBAL', 'AUTRE')),
  constraint documents_visibility_known check (visibility in ('TOUS', 'PRINCIPAUX', 'ENTREPRISE')),
  constraint documents_enterprise_only_for_contractor check (visibility <> 'ENTREPRISE' or deposited_as_role = 'CONTRACTOR'),
  constraint documents_status_known check (status in ('BROUILLON', 'PUBLIE', 'ARCHIVE')),
  constraint documents_title_bounds check (char_length(btrim(title)) between 3 and 120),
  constraint documents_description_bounds check (description is null or char_length(description) <= 500),
  constraint documents_published_consistency check ((status = 'PUBLIE') <= (published_at_server is not null)),
  constraint documents_archive_consistency check (
    (status = 'ARCHIVE') = (archived_at_server is not null and archived_by_profile_id is not null and archive_reason is not null)
  ),
  constraint documents_archive_reason_bounds check (archive_reason is null or char_length(btrim(archive_reason)) between 3 and 1000)
);

create index documents_project_idx on public.documents (project_id, created_at_server desc);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  project_id uuid not null,
  version_number integer not null check (version_number >= 1),
  supersedes_version_id uuid null references public.document_versions (id) on delete restrict,
  private_object_upload_id uuid not null,
  mime_type text not null,
  file_size_bytes bigint not null check (file_size_bytes > 0),
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_by_role text not null check (created_by_role in ('CONTRACTOR', 'OWNER_PRIMARY')),
  created_at_server timestamptz not null default now(),
  constraint document_versions_document_fk foreign key (document_id, project_id)
    references public.documents (id, project_id) on delete restrict,
  constraint document_versions_upload_fk foreign key (private_object_upload_id, project_id)
    references public.private_object_uploads (id, project_id) on delete restrict,
  constraint document_versions_number_unique unique (document_id, version_number),
  constraint document_versions_upload_unique unique (private_object_upload_id),
  constraint document_versions_chain check ((version_number = 1) = (supersedes_version_id is null))
);

alter table public.documents add constraint documents_current_version_fk
  foreign key (current_version_id) references public.document_versions (id) on delete restrict;

-- Cible d'un envoi : document nouveau (métadonnées) ou nouvelle version
-- d'un document existant ; figée à la préparation.
create table public.document_upload_targets (
  private_object_upload_id uuid primary key,
  project_id uuid not null,
  document_id uuid null,
  document_type text null,
  title text null,
  description text null,
  visibility text null,
  constraint document_upload_targets_upload_fk foreign key (private_object_upload_id, project_id)
    references public.private_object_uploads (id, project_id) on delete restrict,
  constraint document_upload_targets_document_fk foreign key (document_id, project_id)
    references public.documents (id, project_id) on delete restrict,
  constraint document_upload_targets_shape check (
    (document_id is null and document_type is not null and title is not null and visibility is not null)
    or (document_id is not null and document_type is null and title is null and description is null and visibility is null)
  )
);

alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_upload_targets enable row level security;
revoke all privileges on table public.documents from public, anon, authenticated;
revoke all privileges on table public.document_versions from public, anon, authenticated;
revoke all privileges on table public.document_upload_targets from public, anon, authenticated;

-- Versions et cibles : jamais modifiées ni supprimées.
create function public.reject_document_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'document_version_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.document_versions
for each row execute function public.reject_document_record_mutation();
create trigger reject_mutation before update or delete on public.document_upload_targets
for each row execute function public.reject_document_record_mutation();

-- Document : jamais supprimé ; identité figée ; visibilité, type, titre et
-- description figés dès la publication (D173) ; ARCHIVE terminal ; seules
-- les transitions de la machine d'états.
create function public.guard_document_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'document_immutable';
  end if;
  if new.id <> old.id or new.project_id <> old.project_id or new.created_by_profile_id <> old.created_by_profile_id
     or new.deposited_as_role <> old.deposited_as_role or new.created_at_server <> old.created_at_server then
    raise exception 'document_immutable';
  end if;
  if old.status = 'ARCHIVE' then
    raise exception 'document_archived';
  end if;
  if old.published_at_server is not null and (
       new.visibility <> old.visibility or new.document_type <> old.document_type or new.title <> old.title
       or new.description is distinct from old.description or new.published_at_server is distinct from old.published_at_server) then
    raise exception 'document_published_immutable';
  end if;
  if new.status <> old.status and (old.status, new.status) not in (('BROUILLON', 'PUBLIE'), ('BROUILLON', 'ARCHIVE'), ('PUBLIE', 'ARCHIVE')) then
    raise exception 'invalid_transition';
  end if;
  new.updated_at_server := clock_timestamp();
  return new;
end;
$$;

create trigger guard_mutation before update or delete on public.documents
for each row execute function public.guard_document_mutation();

revoke execute on function public.reject_document_record_mutation() from public, anon, authenticated, service_role;
revoke execute on function public.guard_document_mutation() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Droits (toujours vrai ou faux).
-- ---------------------------------------------------------------------------
-- Partie de l'appelant sur le chantier : CONTRACTOR, OWNER_PRIMARY,
-- CO_OWNER, SITE_MANAGER ; NULL si aucune adhésion active.
create function public.document_party(p_project_id uuid, p_uid uuid)
returns text
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select case
           when m.role = 'CONTRACTOR' then 'CONTRACTOR'
           when m.role = 'SITE_MANAGER' then 'SITE_MANAGER'
           when m.role = 'OWNER' and m.owner_profile = 'PRIMARY' then 'OWNER_PRIMARY'
           when m.role = 'OWNER' and m.owner_profile = 'CO_OWNER' then 'CO_OWNER'
         end
  from public.project_memberships m
  where m.project_id = p_project_id and m.profile_id = p_uid and m.revoked_at is null
  limit 1;
$$;

-- Lecture (D169, D170) : jamais publié -> auteur seul, tant qu'il tient
-- encore la partie de dépôt ; publié (même archivé ensuite) -> visibilité.
create function public.document_readable(p_document public.documents, p_party text, p_uid uuid)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    case
      when p_party is null then false
      when p_document.published_at_server is null then
        p_document.created_by_profile_id is not distinct from p_uid and p_party is not distinct from p_document.deposited_as_role
      when p_document.visibility = 'TOUS' then p_party in ('CONTRACTOR', 'OWNER_PRIMARY', 'CO_OWNER', 'SITE_MANAGER')
      when p_document.visibility = 'PRINCIPAUX' then p_party in ('CONTRACTOR', 'OWNER_PRIMARY', 'CO_OWNER')
      when p_document.visibility = 'ENTREPRISE' then p_party = 'CONTRACTOR'
      else false
    end, false);
$$;

-- Partie propriétaire d'un document publié (D172, D174).
create function public.document_owned_by_party(p_document public.documents, p_party text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(p_party is not null and p_party = p_document.deposited_as_role, false);
$$;

revoke execute on function public.document_party(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.document_readable(public.documents, text, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.document_owned_by_party(public.documents, text) from public, anon, authenticated, service_role;

-- Écrivain : session, verrou du chantier (même verrou que les révocations
-- et les dépôts de plan), partie de dépôt active, compte vérifié.
create function public.document_require_depositor(p_project_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_party text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);
  v_party := public.document_party(p_project_id, v_uid);
  if v_party is null or v_party not in ('CONTRACTOR', 'OWNER_PRIMARY') then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  return v_party;
end;
$$;

revoke execute on function public.document_require_depositor(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Préparation d'un envoi : document nouveau (p_document_id nul) ou nouvelle
-- version d'un document publié de sa propre partie.
-- ---------------------------------------------------------------------------
create function public.prepare_document_upload(
  p_operation_uuid uuid,
  p_project_id uuid,
  p_document_id uuid,
  p_document_type text,
  p_title text,
  p_description text,
  p_visibility text,
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
  v_party text;
  v_doc public.documents;
  v_existing public.private_object_uploads;
  v_target public.document_upload_targets;
  v_row public.private_object_uploads;
  v_attempt_id uuid := gen_random_uuid();
  v_type text := nullif(btrim(coalesce(p_document_type, '')), '');
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_visibility text := coalesce(nullif(btrim(coalesce(p_visibility, '')), ''), 'PRINCIPAUX');
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_operation_uuid is null or p_project_id is null then
    raise exception 'not_authorized';
  end if;
  if p_expected_checksum is null or p_expected_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'checksum_required';
  end if;
  if p_expected_size_bytes is null or p_expected_size_bytes <= 0 or p_expected_size_bytes > 20971520 then
    raise exception 'size_required';
  end if;
  if p_expected_mime_type is null or p_expected_mime_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    raise exception 'mime_type_required';
  end if;

  v_party := public.document_require_depositor(p_project_id);

  if p_document_id is not null then
    select * into v_doc from public.documents where id = p_document_id and project_id = p_project_id for update;
    if not found or v_doc.status <> 'PUBLIE' or public.document_owned_by_party(v_doc, v_party) is not true then
      raise exception 'not_authorized';
    end if;
  else
    if v_type is null or v_type not in ('PLAN', 'DEVIS', 'CONTRAT', 'RECU', 'FACTURE', 'AUTORISATION', 'RAPPORT', 'PROCES_VERBAL', 'AUTRE') then
      raise exception 'document_type_invalid';
    end if;
    if v_title is null or char_length(v_title) not between 3 and 120 or coalesce(char_length(v_description), 0) > 500 then
      raise exception 'document_invalid';
    end if;
    if v_visibility not in ('TOUS', 'PRINCIPAUX', 'ENTREPRISE') or (v_visibility = 'ENTREPRISE' and v_party <> 'CONTRACTOR') then
      raise exception 'visibility_not_allowed';
    end if;
  end if;

  select * into v_existing from public.private_object_uploads where operation_uuid = p_operation_uuid;
  if found then
    select * into v_target from public.document_upload_targets where private_object_upload_id = v_existing.id;
    if v_existing.entity_type <> 'document_version' or v_existing.created_by_profile_id <> v_uid
       or v_existing.project_id is distinct from p_project_id or v_target.document_id is distinct from p_document_id
       or v_existing.expected_checksum <> p_expected_checksum or v_existing.expected_size_bytes <> p_expected_size_bytes
       or v_existing.expected_mime_type <> p_expected_mime_type
       or (p_document_id is null and (v_target.document_type is distinct from v_type or v_target.title is distinct from v_title
           or v_target.description is distinct from v_description or v_target.visibility is distinct from v_visibility)) then
      raise exception 'operation_uuid_conflict';
    end if;
    if v_existing.status = 'ABANDONED' then
      raise exception 'operation_abandoned';
    end if;
    return v_existing;
  end if;

  insert into public.private_object_uploads (
    operation_uuid, project_id, entity_type, created_by_profile_id, attempt_id, attempt_expires_at, candidate_key,
    expected_checksum, expected_size_bytes, expected_mime_type
  ) values (
    p_operation_uuid, p_project_id, 'document_version', v_uid, v_attempt_id, clock_timestamp() + interval '15 minutes',
    '_private/' || p_project_id::text || '/document_version/' || p_operation_uuid::text || '/candidates/' || v_attempt_id::text,
    p_expected_checksum, p_expected_size_bytes, p_expected_mime_type
  )
  on conflict (operation_uuid) do nothing
  returning * into v_row;
  if v_row.id is null then
    raise exception 'operation_uuid_conflict';
  end if;

  insert into public.document_upload_targets (private_object_upload_id, project_id, document_id, document_type, title, description, visibility)
  values (v_row.id, p_project_id, p_document_id,
          case when p_document_id is null then v_type end,
          case when p_document_id is null then v_title end,
          case when p_document_id is null then v_description end,
          case when p_document_id is null then v_visibility end);
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Finalisation atomique : document BROUILLON + version 1, ou nouvelle
-- version liée publiée immédiatement (D172) ; jamais d'écrasement.
-- ---------------------------------------------------------------------------
create function public.finalize_document_upload(p_operation_uuid uuid)
returns public.document_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_project_id uuid;
  v_party text;
  v_row public.private_object_uploads;
  v_target public.document_upload_targets;
  v_doc public.documents;
  v_prev public.document_versions;
  v_version public.document_versions;
  v_now timestamptz;
  v_updated integer;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select project_id into v_peek_project_id from public.private_object_uploads
  where operation_uuid = p_operation_uuid and entity_type = 'document_version';
  if v_peek_project_id is null then
    raise exception 'not_authorized';
  end if;
  v_party := public.document_require_depositor(v_peek_project_id);

  select * into v_row from public.private_object_uploads where operation_uuid = p_operation_uuid for update;
  if v_row.id is null or v_row.created_by_profile_id is distinct from v_uid or v_row.entity_type is distinct from 'document_version'
     or v_row.project_id is distinct from v_peek_project_id then
    raise exception 'not_authorized';
  end if;
  select * into v_target from public.document_upload_targets where private_object_upload_id = v_row.id;

  if v_row.status = 'FINALIZED' then
    select * into v_version from public.document_versions where private_object_upload_id = v_row.id;
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

  if v_target.document_id is not null then
    select * into v_doc from public.documents where id = v_target.document_id for update;
    if v_doc.status <> 'PUBLIE' or public.document_owned_by_party(v_doc, v_party) is not true then
      raise exception 'not_authorized';
    end if;
    select * into v_prev from public.document_versions where id = v_doc.current_version_id;
  end if;

  update public.private_object_uploads
  set status = 'FINALIZED', storage_key = v_row.candidate_key, finalized_at = v_now, finalized_by_profile_id = v_uid
  where id = v_row.id and attempt_id = v_row.attempt_id and status = 'FINALIZING';
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'storage_not_verified';
  end if;

  if v_target.document_id is null then
    insert into public.documents (project_id, created_by_profile_id, deposited_as_role, document_type, title, description, visibility)
    values (v_row.project_id, v_uid, v_party, v_target.document_type, v_target.title, v_target.description, v_target.visibility)
    returning * into v_doc;
  end if;

  insert into public.document_versions (document_id, project_id, version_number, supersedes_version_id, private_object_upload_id,
                                        mime_type, file_size_bytes, created_by_profile_id, created_by_role, created_at_server)
  values (v_doc.id, v_doc.project_id, coalesce(v_prev.version_number, 0) + 1, v_prev.id, v_row.id,
          v_row.expected_mime_type, v_row.expected_size_bytes, v_uid, v_party, v_now)
  returning * into v_version;

  update public.documents set current_version_id = v_version.id, revision = revision + 1 where id = v_doc.id;
  update public.private_object_uploads set entity_id = v_version.id where id = v_row.id;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_doc.project_id, 'HUMAN', v_uid,
          case when v_prev.id is null then 'DOCUMENT_DRAFT_CREATE' else 'DOCUMENT_NEW_VERSION' end,
          'document_versions', v_version.id, 'SUCCESS',
          jsonb_build_object('document_id', v_doc.id, 'version_number', v_version.version_number, 'supersedes_version_id', v_prev.id,
                             'visibility', v_doc.visibility, 'document_type', v_doc.document_type),
          case when v_prev.id is null then 'Document déposé en brouillon.' else 'Nouvelle version publiée ; la précédente reste lisible.' end);
  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- Publication (D170, D173) et archivage (D174).
-- ---------------------------------------------------------------------------
create function public.publish_document(p_document_id uuid, p_expected_revision integer)
returns public.documents
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
  v_party text;
  v_doc public.documents;
begin
  select project_id into v_project from public.documents where id = p_document_id;
  if v_project is null then
    raise exception 'not_authorized';
  end if;
  v_party := public.document_require_depositor(v_project);
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.status <> 'BROUILLON' or v_doc.created_by_profile_id is distinct from v_uid
     or public.document_owned_by_party(v_doc, v_party) is not true then
    raise exception 'not_authorized';
  end if;
  if p_expected_revision is null or p_expected_revision <> v_doc.revision then
    raise exception 'revision_conflict';
  end if;
  if v_doc.current_version_id is null then
    raise exception 'file_not_finalized';
  end if;
  update public.documents set status = 'PUBLIE', published_at_server = clock_timestamp(), revision = revision + 1
  where id = v_doc.id returning * into v_doc;
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_doc.project_id, 'HUMAN', v_uid, 'DOCUMENT_PUBLISH', 'documents', v_doc.id, 'SUCCESS',
          jsonb_build_object('visibility', v_doc.visibility, 'document_type', v_doc.document_type), 'Document publié ; visibilité figée.');
  return v_doc;
end;
$$;

create function public.archive_document(p_document_id uuid, p_expected_revision integer, p_reason text)
returns public.documents
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
  v_party text;
  v_doc public.documents;
begin
  select project_id into v_project from public.documents where id = p_document_id;
  if v_project is null then
    raise exception 'not_authorized';
  end if;
  v_party := public.document_require_depositor(v_project);
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.status = 'ARCHIVE' then
    raise exception 'document_archived';
  end if;
  if public.document_owned_by_party(v_doc, v_party) is not true
     or (v_doc.status = 'BROUILLON' and v_doc.created_by_profile_id is distinct from v_uid) then
    raise exception 'not_authorized';
  end if;
  if p_expected_revision is null or p_expected_revision <> v_doc.revision then
    raise exception 'revision_conflict';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'reason_required';
  end if;
  update public.documents
  set status = 'ARCHIVE', archived_at_server = clock_timestamp(), archived_by_profile_id = v_uid, archive_reason = btrim(p_reason),
      revision = revision + 1
  where id = v_doc.id returning * into v_doc;
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_doc.project_id, 'HUMAN', v_uid, 'DOCUMENT_ARCHIVE', 'documents', v_doc.id, 'SUCCESS',
          jsonb_build_object('was_published', v_doc.published_at_server is not null), btrim(p_reason));
  return v_doc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lecture : liste, versions, clé de fichier (accès temporaire signé par le
-- serveur après ce contrôle, FR110).
-- ---------------------------------------------------------------------------
create type public.document_view as (
  id uuid,
  document_type text,
  title text,
  description text,
  visibility text,
  status text,
  deposited_as_role text,
  author_is_me boolean,
  current_version_id uuid,
  current_version_number integer,
  current_mime_type text,
  current_file_size_bytes bigint,
  current_version_at timestamptz,
  created_at_server timestamptz,
  published_at_server timestamptz,
  archived_at_server timestamptz,
  archive_reason text,
  revision integer,
  can_publish boolean,
  can_new_version boolean,
  can_archive boolean
);

create function public.list_project_documents(p_project_id uuid)
returns setof public.document_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_party text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_party := public.document_party(p_project_id, v_uid);
  if v_party is null then
    raise exception 'not_authorized';
  end if;
  return query
    select d.id, d.document_type, d.title, d.description, d.visibility, d.status, d.deposited_as_role,
           d.created_by_profile_id = v_uid, v.id, v.version_number, v.mime_type, v.file_size_bytes, v.created_at_server,
           d.created_at_server, d.published_at_server, d.archived_at_server, d.archive_reason, d.revision,
           d.status = 'BROUILLON' and d.created_by_profile_id = v_uid and public.document_owned_by_party(d, v_party),
           d.status = 'PUBLIE' and public.document_owned_by_party(d, v_party),
           d.status <> 'ARCHIVE' and public.document_owned_by_party(d, v_party)
             and (d.status = 'PUBLIE' or d.created_by_profile_id = v_uid)
    from public.documents d
    left join public.document_versions v on v.id = d.current_version_id
    where d.project_id = p_project_id and public.document_readable(d, v_party, v_uid)
    order by (d.status = 'ARCHIVE'), coalesce(v.created_at_server, d.created_at_server) desc;
end;
$$;

create type public.document_version_view as (
  id uuid,
  document_id uuid,
  version_number integer,
  mime_type text,
  file_size_bytes bigint,
  created_by_role text,
  author_is_me boolean,
  created_at_server timestamptz,
  is_current boolean
);

create function public.list_document_versions(p_document_id uuid)
returns setof public.document_version_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if not found or public.document_readable(v_doc, public.document_party(v_doc.project_id, v_uid), v_uid) is not true then
    raise exception 'not_authorized';
  end if;
  return query
    select v.id, v.document_id, v.version_number, v.mime_type, v.file_size_bytes, v.created_by_role,
           v.created_by_profile_id = v_uid, v.created_at_server, v.id = v_doc.current_version_id
    from public.document_versions v where v.document_id = p_document_id order by v.version_number desc;
end;
$$;

create function public.get_document_version_file_key(p_version_id uuid)
returns table (bucket text, storage_key text, mime_type text)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_version public.document_versions;
  v_doc public.documents;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select * into v_version from public.document_versions where id = p_version_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  select * into v_doc from public.documents where id = v_version.document_id;
  if public.document_readable(v_doc, public.document_party(v_doc.project_id, v_uid), v_uid) is not true then
    raise exception 'not_authorized';
  end if;
  return query
    select 'project-documents'::text, u.storage_key, v_version.mime_type
    from public.private_object_uploads u where u.id = v_version.private_object_upload_id and u.status = 'FINALIZED';
  if not found then
    raise exception 'file_not_finalized';
  end if;
end;
$$;

revoke execute on function public.prepare_document_upload(uuid, uuid, uuid, text, text, text, text, text, bigint, text),
  public.finalize_document_upload(uuid), public.publish_document(uuid, integer), public.archive_document(uuid, integer, text),
  public.list_project_documents(uuid), public.list_document_versions(uuid), public.get_document_version_file_key(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_document_upload(uuid, uuid, uuid, text, text, text, text, text, bigint, text),
  public.finalize_document_upload(uuid), public.publish_document(uuid, integer), public.archive_document(uuid, integer, text),
  public.list_project_documents(uuid), public.list_document_versions(uuid), public.get_document_version_file_key(uuid)
  to authenticated;

-- Nettoyage (service_role), même principe que les justificatifs (M014).
create function public.list_expired_document_uploads(p_older_than interval default interval '1 hour')
returns table (id uuid, project_id uuid, attempt_expires_at timestamptz)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.project_id, u.attempt_expires_at
  from public.private_object_uploads u
  where u.entity_type = 'document_version' and u.status in ('PENDING', 'FINALIZING') and u.attempt_expires_at < now() - p_older_than;
$$;

create function public.abandon_expired_document_upload(p_id uuid, p_older_than interval default interval '1 hour')
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.private_object_uploads;
begin
  select * into v_row from public.private_object_uploads where id = p_id for update;
  if not found or v_row.entity_type <> 'document_version' then
    return false;
  end if;
  if v_row.status not in ('PENDING', 'FINALIZING') or v_row.attempt_expires_at >= now() - p_older_than then
    return false;
  end if;
  if v_row.write_claimed_at is not null then
    insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
    values (v_row.id, v_row.candidate_key, 'candidate');
  end if;
  update public.private_object_uploads set status = 'ABANDONED' where id = v_row.id;
  return true;
end;
$$;

revoke execute on function public.list_expired_document_uploads(interval), public.abandon_expired_document_upload(uuid, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.list_expired_document_uploads(interval), public.abandon_expired_document_upload(uuid, interval)
  to service_role;

-- get_stale_key_bucket : branche document_version AJOUTÉE, autres inchangées.
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
    when 'advance_receipt' then 'advance-receipts'
    when 'document_version' then 'project-documents'
    else null
  end
  from public.private_object_stale_keys k
  join public.private_object_uploads u on u.id = k.private_object_upload_id
  where k.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- claim_upload_attempt / recover_media_upload_attempt / get_upload_status :
-- reprises à l'identique de M014 ; SEULE la branche document_version est
-- ajoutée (verrou avisoire -> adhésion -> ligne, compte vérifié relu,
-- créateur = déposant détenant une partie de dépôt).
-- ---------------------------------------------------------------------------

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

  if v_peek_entity_type in ('project_plan_version', 'advance_receipt', 'document_version') then
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
  elsif v_row.entity_type = 'advance_receipt' then
    v_authorized := true; -- adhésion revérifiée ci-dessus sous verrou ; créateur = déclarant.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
  elsif v_row.entity_type = 'document_version' then
    v_authorized := true; -- adhésion de dépôt revérifiée ci-dessus sous verrou ; créateur = déposant.
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

  if v_peek_entity_type in ('project_plan_version', 'advance_receipt', 'document_version') then
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
  elsif v_row.entity_type = 'advance_receipt' then
    v_authorized := true; -- adhésion revérifiée ci-dessus sous verrou ; créateur = déclarant.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
    v_path_prefix := '_private/' || v_row.project_id::text || '/advance_receipt/' || v_row.operation_uuid::text;
  elsif v_row.entity_type = 'document_version' then
    v_authorized := true; -- adhésion de dépôt revérifiée ci-dessus sous verrou ; créateur = déposant.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
    v_path_prefix := '_private/' || v_row.project_id::text || '/document_version/' || v_row.operation_uuid::text;
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
  elsif v_row.entity_type = 'advance_receipt' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
    );
    if v_authorized and public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
  elsif v_row.entity_type = 'document_version' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
    );
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

commit;
