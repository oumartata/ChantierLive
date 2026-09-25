-- M010 — media_assets, bucket project-media, et tranche minimale B027
-- (déposer -> finaliser -> aperçu -> publier -> galerie), consommant la
-- fondation générique M026 (private_object_uploads, T054).
--
-- Périmètre VOLONTAIREMENT réduit (founder, revue B026-B027 2026-09-25) :
-- media_links (rattachement à une phase) est DIFFÉRÉ à une migration
-- ultérieure M010a (même pattern documentaire que M004a/b/c, M006a/b) —
-- aucune colonne phase_id ici, aucune fonction ne le suppose. Compression
-- (FR064), consentement géolocalisation (FR063) et étiquetage capturé/
-- importé côté UI (FR062) restent également HORS PÉRIMÈTRE de cette
-- tranche : seul le champ origin (CAPTURED|IMPORTED, BR040) est persisté.
--
-- Autorisations sourcées :
--   - MEDIA_UPLOAD (PERMISSIONS.csv, D099) : PREPARE/FINALIZE = adhésion
--     chantier active ET rôle CONTRACTOR ou SITE_MANAGER, sans délégation
--     supplémentaire. OWNER/CO_OWNER refusés à l'ajout dans ce périmètre.
--   - MEDIA_VIEW + D100/BR107 : brouillon lisible par son seul auteur tant
--     qu'il reste CONTRACTOR/SITE_MANAGER actif ; publié lisible par les 4
--     rôles actifs (OWNER quel que soit owner_profile, CONTRACTOR,
--     SITE_MANAGER) ; toute lecture exige en outre que l'upload lié soit
--     FINALIZED (private_object_uploads.status).
--   - MEDIA_PUBLISH (D100) : auteur seul, droits revérifiés à l'instant
--     présent, tant qu'il reste CONTRACTOR/SITE_MANAGER actif.
--
-- Frontière de confiance (plan B026-B027 §4) : attest_storage_verified est
-- accordée au SEUL rôle service_role. Un appelant authentifié ne peut jamais
-- l'invoquer (permission Postgres refusée), donc jamais fabriquer lui-même
-- la preuve qu'un contrôle Storage a eu lieu — identité (auth.uid(), vérifiée
-- par les autres fonctions ci-dessous) et attestation de contrôle (écrite ici
-- uniquement) restent deux vérifications structurellement séparées.

begin;

-- ----------------------------------------------------------------------------
-- Bucket privé dédié (DATA_MODEL.yaml storage.buckets). public_bucket=false :
-- aucune policy RLS authenticated/anon n'est créée sur storage.objects pour
-- ce bucket — RLS Storage est déjà activé par défaut (aucune policy = refus
-- par défaut) ; seul service_role (BYPASSRLS) y écrit/lit, toujours après
-- que les fonctions ci-dessous ont statué sur les droits métier.
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'project-media',
  'project-media',
  false,
  52428800,
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4']
)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- media_assets (DATABASE_TABLES.csv T018). Une ligne n'existe QUE créée par
-- finalize_media_upload ci-dessous (aucun GRANT insert direct) : par
-- construction, tout media_assets référence donc toujours un upload
-- private_object_uploads déjà FINALIZED au moment de sa création — le join
-- explicite dans list_project_media reste une défense en profondeur, pas
-- l'unique garde-fou.
-- ----------------------------------------------------------------------------

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  private_object_upload_id uuid not null references public.private_object_uploads (id) on delete restrict,
  uploaded_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  origin text not null,
  status text not null default 'BROUILLON',
  caption text null,
  file_size_bytes bigint not null,
  mime_type text not null,
  storage_key text not null,
  created_at_server timestamptz not null default now(),
  published_at_server timestamptz null,
  published_by_profile_id uuid null references public.profiles (id) on delete restrict,
  constraint media_assets_upload_unique unique (private_object_upload_id),
  constraint media_assets_origin_known check (origin in ('CAPTURED', 'IMPORTED')),
  constraint media_assets_status_known check (status in ('BROUILLON', 'PUBLIE')),
  constraint media_assets_size_positive check (file_size_bytes > 0),
  constraint media_assets_published_consistency check (
    (status = 'PUBLIE') = (published_at_server is not null and published_by_profile_id is not null)
  )
);

create index media_assets_project_status_idx on public.media_assets (project_id, status);
create index media_assets_author_idx on public.media_assets (uploaded_by_profile_id);

alter table public.media_assets enable row level security;

-- Aucun accès direct : lecture exclusivement via list_project_media
-- (prédicat MEDIA_VIEW/D100 ci-dessous), écriture exclusivement via
-- finalize_media_upload/publish_media_asset.
revoke all privileges on table public.media_assets from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- prepare_media_upload — PREPARE (MEDIA_UPLOAD, D099). Idempotent sur
-- operation_uuid : un rejeu avec les MÊMES paramètres renvoie la même ligne ;
-- un rejeu avec des paramètres DIFFÉRENTS pour le même operation_uuid est
-- refusé (même operation_uuid = même opération, jamais réinterprétée).
--
-- CORRIGÉ (revue 2026-09-26) : deux défauts distincts.
--   (1) Droits au rejeu : l'ancienne version renvoyait la ligne existante
--       AVANT toute revérification d'adhésion/rôle — un appelant révoqué ou
--       rétrogradé après une première préparation légitime pouvait rejouer
--       PREPARE et obtenir une nouvelle URL d'upload (prepareMediaUpload en
--       émet une à chaque appel). Les droits courants sont maintenant
--       vérifiés EN PREMIER, avant même de savoir si l'opération existe déjà.
--   (2) Idempotence : SELECT puis INSERT (sans lock, une ligne non-existante
--       ne peut pas être verrouillée par FOR UPDATE) laissait deux PREMIÈRES
--       préparations concurrentes pour le même operation_uuid toutes deux
--       tenter l'INSERT, l'une des deux échouant avec une violation
--       d'unicité brute, non réconciliée. Passage à un INSERT-FIRST : en cas
--       de conflit, la ligne existante est relue et réconciliée (mêmes
--       paramètres -> même opération renvoyée ; différents -> refus).
-- ----------------------------------------------------------------------------

create function public.prepare_media_upload(
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

  -- Droits courants vérifiés ICI, avant toute lecture de l'opération
  -- existante : s'applique au chemin normal ET à tout rejeu.
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id
      and profile_id = v_uid
      and revoked_at is null
      and role in ('CONTRACTOR', 'SITE_MANAGER')
  ) then
    raise exception 'not_authorized';
  end if;

  v_now := clock_timestamp();
  v_attempt_id := gen_random_uuid();
  v_candidate_key := '_private/' || p_project_id::text || '/media_asset/' || p_operation_uuid::text || '/candidates/' || v_attempt_id::text;

  begin
    insert into public.private_object_uploads (
      operation_uuid, project_id, entity_type, created_by_profile_id,
      attempt_id, attempt_expires_at, candidate_key,
      expected_checksum, expected_size_bytes, expected_mime_type
    ) values (
      p_operation_uuid, p_project_id, 'media_asset', v_uid,
      v_attempt_id, v_now + interval '15 minutes', v_candidate_key,
      p_expected_checksum, p_expected_size_bytes, p_expected_mime_type
    )
    returning * into v_row;

    return v_row;
  exception
    when unique_violation then
      -- Une autre transaction (concurrente ou rejeu) a inséré cette même
      -- operation_uuid entre-temps : réconciliation, jamais une erreur brute.
      select * into v_existing
      from public.private_object_uploads
      where operation_uuid = p_operation_uuid;

      if v_existing.created_by_profile_id <> v_uid
         or v_existing.project_id is distinct from p_project_id
         or v_existing.expected_checksum <> p_expected_checksum
         or v_existing.expected_size_bytes <> p_expected_size_bytes
         or v_existing.expected_mime_type <> p_expected_mime_type
      then
        raise exception 'operation_uuid_conflict';
      end if;

      -- CORRIGÉ (revue 2026-09-27) : ne jamais délivrer une nouvelle URL
      -- d'écriture (via prepareMediaUpload, actions.ts) pour une opération
      -- déjà close. Refus explicite, jamais un retour silencieux de la ligne.
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

revoke execute on function public.prepare_media_upload(uuid, uuid, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_media_upload(uuid, uuid, text, bigint, text) to authenticated;

-- ----------------------------------------------------------------------------
-- upload_claim_result — won=true signifie "vous seul détenez la porte CAS,
-- vous pouvez écrire la candidate maintenant". won=false signifie "n'écrivez
-- rien : un autre appel détient déjà la porte, ou l'opération a déjà
-- progressé" — jamais une seconde tentative d'écriture concurrente.
-- ----------------------------------------------------------------------------

create type public.upload_claim_result as (
  project_id uuid,
  candidate_key text,
  expected_checksum text,
  expected_size_bytes bigint,
  expected_mime_type text,
  attempt_id uuid,
  status text,
  won boolean
);

-- ----------------------------------------------------------------------------
-- claim_upload_attempt — porte CAS acquise AVANT tout appel Storage (voir
-- M026, en-tête). Le verrou de ligne (FOR UPDATE) sérialise deux appels
-- concurrents pour le même operation_uuid : le second ne peut jamais lire
-- write_claimed_at=NULL après que le premier l'a posé dans la même
-- transaction déjà validée.
--
-- CORRIGÉ (revue 2026-09-26) : ne vérifiait que l'identité de l'auteur, pas
-- ses droits COURANTS — un auteur révoqué/rétrogradé pouvait encore
-- revendiquer la porte d'écriture. project_id est désormais renvoyé (issu de
-- la ligne, jamais d'un paramètre client) pour que l'appelant construise le
-- chemin de la source temporaire depuis une valeur RAPPROCHÉE du résultat du
-- claim, jamais depuis un project_id fourni séparément et non revérifié.
-- ----------------------------------------------------------------------------

create function public.claim_upload_attempt(p_operation_uuid uuid)
returns public.upload_claim_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.private_object_uploads;
  v_now timestamptz;
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

  -- Droits courants, revérifiés à CHAQUE appel (chemin normal ET rejeu) —
  -- jamais déduits de la seule identité de l'auteur.
  if not exists (
    select 1 from public.project_memberships
    where project_id = v_row.project_id
      and profile_id = v_uid
      and revoked_at is null
      and role in ('CONTRACTOR', 'SITE_MANAGER')
  ) then
    raise exception 'not_authorized';
  end if;

  if v_row.status <> 'PENDING' then
    return (v_row.project_id, v_row.candidate_key, v_row.expected_checksum, v_row.expected_size_bytes,
            v_row.expected_mime_type, v_row.attempt_id, v_row.status, false)::public.upload_claim_result;
  end if;

  v_now := clock_timestamp();

  if v_row.attempt_expires_at <= v_now then
    raise exception 'attempt_expired';
  end if;

  if v_row.write_claimed_at is not null then
    -- Déjà revendiquée par un autre appel : jamais un second PUT sur cette
    -- même candidate, l'appelant doit attendre/relire l'état courant.
    return (v_row.project_id, v_row.candidate_key, v_row.expected_checksum, v_row.expected_size_bytes,
            v_row.expected_mime_type, v_row.attempt_id, v_row.status, false)::public.upload_claim_result;
  end if;

  update public.private_object_uploads
  set write_claimed_at = v_now
  where id = v_row.id
    and write_claimed_at is null
  returning * into v_row;

  return (v_row.project_id, v_row.candidate_key, v_row.expected_checksum, v_row.expected_size_bytes,
          v_row.expected_mime_type, v_row.attempt_id, v_row.status, true)::public.upload_claim_result;
end;
$$;

revoke execute on function public.claim_upload_attempt(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_upload_attempt(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- attest_storage_verified — SEULE fonction autorisée à écrire l'attestation
-- de contrôle Storage. EXECUTE accordé au SEUL rôle service_role : un
-- appelant authentifié reçoit "permission denied" quels que soient ses
-- droits métier, il ne peut jamais déclarer arbitrairement "vérifié"
-- (frontière de confiance, plan B026-B027 §4). Écart d'empreinte/taille/type
-- réel vs figé à l'opération = refus, jamais un repli "acceptable".
-- ----------------------------------------------------------------------------

create function public.attest_storage_verified(
  p_operation_uuid uuid,
  p_attempt_id uuid,
  p_actual_checksum text,
  p_actual_size_bytes bigint,
  p_actual_mime_type text
)
returns public.private_object_uploads
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.private_object_uploads;
  v_now timestamptz;
begin
  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found then
    raise exception 'not_authorized';
  end if;

  if v_row.status <> 'PENDING' or v_row.attempt_id <> p_attempt_id then
    raise exception 'attempt_stale';
  end if;

  if v_row.write_claimed_at is null then
    raise exception 'attempt_not_claimed';
  end if;

  v_now := clock_timestamp();
  if v_row.attempt_expires_at <= v_now then
    raise exception 'attempt_expired';
  end if;

  if p_actual_checksum is distinct from v_row.expected_checksum
     or p_actual_size_bytes is distinct from v_row.expected_size_bytes
     or p_actual_mime_type is distinct from v_row.expected_mime_type
  then
    raise exception 'checksum_mismatch';
  end if;

  update public.private_object_uploads
  set status = 'FINALIZING', storage_verified_attempt_id = p_attempt_id
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.attest_storage_verified(uuid, uuid, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attest_storage_verified(uuid, uuid, text, bigint, text) to service_role;

-- ----------------------------------------------------------------------------
-- finalize_media_upload — FINALIZE (MEDIA_UPLOAD, D099, droits revérifiés à
-- l'instant présent) + création atomique du media_assets brouillon, DANS LA
-- MÊME transaction (plan B026-B027 §2/§5). CAS : attempt_id courant +
-- expiration valide + attestation présente pour CET attempt_id. Idempotent :
-- un rejeu d'une opération déjà FINALIZED renvoie le MÊME média, jamais un
-- second. Un échec de l'INSERT media_assets annule tout (fonction =
-- transaction unique) : l'opération reste FINALIZING, récupérable.
--
-- CORRIGÉ (revue 2026-09-26) : trois défauts.
--   (1) Droits au rejeu : la branche "déjà FINALIZED -> renvoyer le média
--       existant" s'exécutait AVANT la revérification d'adhésion/rôle — un
--       appelant révoqué pouvait encore rejouer finalize et obtenir la
--       confirmation d'un média qu'il n'aurait plus le droit de produire
--       aujourd'hui. Les droits sont maintenant vérifiés EN PREMIER,
--       s'appliquent au chemin normal ET au rejeu idempotent.
--   (2) Origine : p_origin acceptait 'CAPTURED' fourni par l'appelant alors
--       qu'aucun mécanisme de capture réelle n'existe dans cette tranche —
--       seul 'IMPORTED' est accepté ici (D100/BR107 ne couvrent que la
--       provenance réellement démontrable ; la capture reste différée).
--   (3) Nettoyage : la source temporaire devient inutile dès FINALIZED (la
--       candidate gagnante est désormais l'unique référence) — sa clé est
--       enregistrée dans private_object_stale_keys pour suppression réelle
--       ultérieure (M026), jamais laissée sans trace.
-- ----------------------------------------------------------------------------

create function public.finalize_media_upload(
  p_operation_uuid uuid,
  p_origin text,
  p_caption text
)
returns public.media_assets
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.private_object_uploads;
  v_now timestamptz;
  v_media public.media_assets;
  v_updated integer;
  v_source_key text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_origin <> 'IMPORTED' then
    -- CAPTURED refusé : aucun utilisateur ne peut fabriquer une provenance
    -- non démontrée dans cette tranche (voir en-tête).
    raise exception 'invalid_origin';
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  -- Droits revérifiés À L'INSTANT PRÉSENT, AVANT toute branche — y compris
  -- celle du rejeu idempotent ci-dessous, jamais réutilisés depuis PREPARE.
  if not exists (
    select 1 from public.project_memberships
    where project_id = v_row.project_id
      and profile_id = v_uid
      and revoked_at is null
      and role in ('CONTRACTOR', 'SITE_MANAGER')
  ) then
    raise exception 'not_authorized';
  end if;

  if v_row.status = 'FINALIZED' then
    select * into v_media from public.media_assets where private_object_upload_id = v_row.id;
    if found then
      return v_media;
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

  insert into public.media_assets (
    project_id, private_object_upload_id, uploaded_by_profile_id,
    origin, caption, file_size_bytes, mime_type, storage_key
  ) values (
    v_row.project_id, v_row.id, v_uid,
    p_origin, nullif(btrim(coalesce(p_caption, '')), ''), v_row.expected_size_bytes, v_row.expected_mime_type, v_row.candidate_key
  )
  returning * into v_media;

  update public.private_object_uploads
  set entity_id = v_media.id
  where id = v_row.id;

  -- Source temporaire devenue inutile : tracée pour suppression réelle,
  -- jamais supprimée ici sans trace (M026/list_stale_media_keys).
  v_source_key := '_private/' || v_row.project_id::text || '/media_asset/' || v_row.operation_uuid::text || '/source';
  insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
  values (v_row.id, v_source_key, 'source');

  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
  ) values (
    v_row.project_id, 'HUMAN', v_uid, 'MEDIA_UPLOAD_FINALIZED', 'media_assets', v_media.id, 'SUCCESS',
    'Upload privé finalisé et lié au média brouillon.'
  );

  return v_media;
end;
$$;

revoke execute on function public.finalize_media_upload(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_media_upload(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- recover_media_upload_attempt — timeout/reprise (plan B026-B027 §1/§6).
-- Récupération SEULEMENT si l'attempt courant est réellement expiré (jamais
-- une réouverture d'écriture sur une candidate encore valide). Même
-- operation_uuid conservé (même opération logique) ; nouvel attempt_id et
-- nouvelle clé candidate ouverts sur cette MÊME ligne, jamais une seconde
-- opération ni un second média. Idempotent et SANS EFFET si déjà FINALIZED
-- ou si l'attempt courant reste valide : peut donc être appelée sans risque
-- avant toute reprise cliente, pour resynchroniser l'état courant.
--
-- CORRIGÉ (revue 2026-09-26) : deux défauts.
--   (1) Droits au rejeu : ne vérifiait que l'identité de l'auteur, jamais
--       ses droits courants — un auteur révoqué pouvait encore ouvrir un
--       nouvel attempt_id/candidate. Vérification ajoutée avant toute
--       branche (chemin normal ET rejeu).
--   (2) Nettoyage : l'ancienne candidate abandonnée n'était tracée nulle
--       part avant d'être écrasée ici — désormais enregistrée dans
--       private_object_stale_keys (M026) si une écriture avait pu y être
--       tentée (write_claimed_at non NULL), pour suppression réelle ultérieure.
-- ----------------------------------------------------------------------------

create function public.recover_media_upload_attempt(p_operation_uuid uuid)
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
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.created_by_profile_id <> v_uid then
    -- Ni trouvée ni sienne : refus générique, AUCUNE fuite d'existence à un
    -- appelant qui n'en est pas l'auteur.
    raise exception 'not_authorized';
  end if;

  -- Droits courants, revérifiés à CHAQUE appel — jamais déduits de la seule
  -- identité de l'auteur, y compris pour les branches "sans effet"
  -- ci-dessous (déjà FINALIZED / ABANDONED / encore valide).
  --
  -- CORRIGÉ (revue 2026-09-27) : distingue explicitement, pour son PROPRE
  -- auteur déjà authentifié ci-dessus (aucune fuite vers un tiers, la
  -- propriété est déjà établie), une opération inexistante d'une opération
  -- existante mais temporairement inaccessible (droits courants insuffisants,
  -- ex. révocation). Sans cette distinction, un client ne peut pas savoir
  -- s'il doit abandonner l'operation_uuid (rien à perdre) ou le conserver
  -- (l'opération peut déjà être FINALIZED côté serveur, la perdre créerait
  -- un second média une fois les droits restaurés).
  if not exists (
    select 1 from public.project_memberships
    where project_id = v_row.project_id
      and profile_id = v_uid
      and revoked_at is null
      and role in ('CONTRACTOR', 'SITE_MANAGER')
  ) then
    raise exception 'operation_access_revoked';
  end if;

  if v_row.status = 'FINALIZED' then
    return v_row;
  end if;

  if v_row.status = 'ABANDONED' then
    -- CORRIGÉ (revue 2026-09-27) : ABANDONED est désormais réellement
    -- terminal. Sans ce refus, une ligne déjà abandonnée (sa source tracée
    -- pour suppression dans private_object_stale_keys) pouvait être remise
    -- en PENDING ici alors même que son nettoyage pouvait être en cours.
    raise exception 'operation_abandoned';
  end if;

  v_now := clock_timestamp();

  if v_row.attempt_expires_at > v_now then
    -- Tentative encore valide : jamais d'abandon anticipé, l'appelant doit
    -- réessayer claim_upload_attempt sur l'attempt courant.
    return v_row;
  end if;

  if v_row.write_claimed_at is not null then
    insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
    values (v_row.id, v_row.candidate_key, 'candidate');
  end if;

  v_new_attempt := gen_random_uuid();
  v_new_candidate := '_private/' || v_row.project_id::text || '/media_asset/' || v_row.operation_uuid::text || '/candidates/' || v_new_attempt::text;

  update public.private_object_uploads
  set attempt_id = v_new_attempt,
      candidate_key = v_new_candidate,
      attempt_expires_at = v_now + interval '15 minutes',
      write_claimed_at = null,
      status = 'PENDING',
      storage_verified_attempt_id = null
  where id = v_row.id
  returning * into v_row;

  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
  ) values (
    v_row.project_id, 'HUMAN', v_uid, 'MEDIA_UPLOAD_ATTEMPT_ABANDONED', 'private_object_uploads', v_row.id, 'SUCCESS',
    'Tentative expirée abandonnée, nouvel attempt_id/candidate ouverts.'
  );

  return v_row;
end;
$$;

revoke execute on function public.recover_media_upload_attempt(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.recover_media_upload_attempt(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- get_upload_status — lecture seule de sa propre opération (polling client
-- après un commit incertain, avant recovery). Droits courants revérifiés
-- comme les autres fonctions de ce fichier (cohérence, revue 2026-09-26).
-- ----------------------------------------------------------------------------

create function public.get_upload_status(p_operation_uuid uuid)
returns public.private_object_uploads
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.private_object_uploads;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_row from public.private_object_uploads where operation_uuid = p_operation_uuid;

  if not found or v_row.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  -- Même distinction que recover_media_upload_attempt (revue 2026-09-27) :
  -- propriété déjà établie ci-dessus (aucune fuite), une opération EXISTANTE
  -- mais actuellement inaccessible se distingue explicitement d'une opération
  -- inexistante — permet au client de savoir s'il doit conserver ou
  -- abandonner son operation_uuid en cours.
  if not exists (
    select 1 from public.project_memberships
    where project_id = v_row.project_id
      and profile_id = v_uid
      and revoked_at is null
      and role in ('CONTRACTOR', 'SITE_MANAGER')
  ) then
    raise exception 'operation_access_revoked';
  end if;

  return v_row;
end;
$$;

revoke execute on function public.get_upload_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_upload_status(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- publish_media_asset — MEDIA_PUBLISH (D100/BR107) : auteur SEUL, droits
-- revérifiés à l'instant présent, tant qu'il reste CONTRACTOR/SITE_MANAGER
-- actif. Transition BROUILLON -> PUBLIE uniquement.
-- ----------------------------------------------------------------------------

create function public.publish_media_asset(p_media_asset_id uuid)
returns public.media_assets
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_media public.media_assets;
  v_now timestamptz;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select * into v_media
  from public.media_assets
  where id = p_media_asset_id
  for update;

  if not found then
    raise exception 'not_authorized';
  end if;

  if v_media.uploaded_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if not exists (
    select 1 from public.project_memberships
    where project_id = v_media.project_id
      and profile_id = v_uid
      and revoked_at is null
      and role in ('CONTRACTOR', 'SITE_MANAGER')
  ) then
    raise exception 'not_authorized';
  end if;

  if v_media.status <> 'BROUILLON' then
    raise exception 'media_not_draft';
  end if;

  v_now := clock_timestamp();

  update public.media_assets
  set status = 'PUBLIE', published_at_server = v_now, published_by_profile_id = v_uid
  where id = v_media.id
  returning * into v_media;

  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
  ) values (
    v_media.project_id, 'HUMAN', v_uid, 'MEDIA_PUBLISHED', 'media_assets', v_media.id, 'SUCCESS',
    'Publication explicite par son auteur (D100).'
  );

  return v_media;
end;
$$;

revoke execute on function public.publish_media_asset(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_media_asset(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- list_project_media — prédicat READ sourcé (MEDIA_VIEW + D100/BR107,
-- plan B026-B027 §3) :
--   READ := adhésion chantier active
--     ET ( (statut='PUBLIE' ET rôle in {OWNER,CONTRACTOR,SITE_MANAGER})
--          OU (statut='BROUILLON' ET auteur=appelant
--              ET rôle in {CONTRACTOR,SITE_MANAGER}) )
--     ET upload lié FINALIZED (join défensif, déjà garanti par construction).
-- Manque signalé (non comblé ici) : aucune règle sourcée ne couvre la
-- lecture d'un brouillon par quelqu'un d'autre que son auteur — refusé par
-- défaut.
-- ----------------------------------------------------------------------------

create type public.media_asset_view as (
  id uuid,
  project_id uuid,
  uploaded_by_profile_id uuid,
  origin text,
  status text,
  caption text,
  file_size_bytes bigint,
  mime_type text,
  storage_key text,
  created_at_server timestamptz,
  published_at_server timestamptz
);

create function public.list_project_media(p_project_id uuid)
returns setof public.media_asset_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select role into v_membership
  from public.project_memberships
  where project_id = p_project_id and profile_id = v_uid and revoked_at is null;

  if not found then
    raise exception 'not_authorized';
  end if;

  return query
  select m.id, m.project_id, m.uploaded_by_profile_id, m.origin, m.status, m.caption,
         m.file_size_bytes, m.mime_type, m.storage_key, m.created_at_server, m.published_at_server
  from public.media_assets m
  join public.private_object_uploads u on u.id = m.private_object_upload_id
  where m.project_id = p_project_id
    and u.status = 'FINALIZED'
    and (
      (m.status = 'PUBLIE' and v_membership.role in ('OWNER', 'CONTRACTOR', 'SITE_MANAGER'))
      or (m.status = 'BROUILLON' and m.uploaded_by_profile_id = v_uid and v_membership.role in ('CONTRACTOR', 'SITE_MANAGER'))
    )
  order by m.created_at_server desc;
end;
$$;

revoke execute on function public.list_project_media(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_project_media(uuid) to authenticated;

-- ============================================================================
-- Nettoyage — REFONDU (revue 2026-09-26). Deux phases distinctes, jamais
-- confondues : (A) ABANDON d'une ligne encore vivante mais expirée (bascule
-- vers le statut terminal ABANDONED, jamais une suppression physique — voir
-- M026 en-tête pour la raison d'identité d'idempotence) qui trace ses clés
-- Storage potentiellement écrites dans private_object_stale_keys ; (B)
-- SUPPRESSION RÉELLE d'une clé tracée, confirmée APRÈS le succès réel de
-- storage.remove() — jamais avant, jamais perdue sur un échec.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- list_expired_media_uploads — SÉLECTION seule (STABLE) des lignes encore
-- PENDING/FINALIZING mais dont l'attempt courant est expiré : candidates à
-- faire passer par abandon_expired_media_upload. N'autorise rien par
-- elle-même (peut être périmée dès sa lecture par une reprise cliente).
-- ----------------------------------------------------------------------------

create function public.list_expired_media_uploads(p_older_than interval default interval '1 hour')
returns table (id uuid, project_id uuid, attempt_expires_at timestamptz)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.project_id, u.attempt_expires_at
  from public.private_object_uploads u
  where u.entity_type = 'media_asset'
    and u.status in ('PENDING', 'FINALIZING')
    and u.attempt_expires_at < now() - p_older_than;
$$;

revoke execute on function public.list_expired_media_uploads(interval)
  from public, anon, authenticated, service_role;
grant execute on function public.list_expired_media_uploads(interval) to service_role;

-- ----------------------------------------------------------------------------
-- abandon_expired_media_upload — revérifie SOUS VERROU, à l'instant présent,
-- qu'une ligne listée par list_expired_media_uploads est TOUJOURS éligible
-- (une liste antérieure ne vaut jamais autorisation). Si oui : trace sa
-- candidate (si une écriture avait pu y être tentée) ET sa source dans
-- private_object_stale_keys, bascule le statut à ABANDONED (jamais une
-- suppression physique de la ligne — identité d'operation_uuid préservée).
-- Si la ligne a progressé entre-temps (FINALIZED, ou reprise ayant repoussé
-- l'expiration), ne fait STRICTEMENT rien.
-- ----------------------------------------------------------------------------

create function public.abandon_expired_media_upload(p_id uuid, p_older_than interval default interval '1 hour')
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.private_object_uploads;
  v_source_key text;
begin
  select * into v_row
  from public.private_object_uploads
  where id = p_id
  for update;

  if not found then
    return false;
  end if;

  if v_row.status not in ('PENDING', 'FINALIZING') or v_row.attempt_expires_at >= now() - p_older_than then
    return false;
  end if;

  if v_row.write_claimed_at is not null then
    insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
    values (v_row.id, v_row.candidate_key, 'candidate');
  end if;

  v_source_key := '_private/' || v_row.project_id::text || '/media_asset/' || v_row.operation_uuid::text || '/source';
  insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
  values (v_row.id, v_source_key, 'source');

  update public.private_object_uploads set status = 'ABANDONED' where id = v_row.id;

  return true;
end;
$$;

revoke execute on function public.abandon_expired_media_upload(uuid, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.abandon_expired_media_upload(uuid, interval) to service_role;

-- ----------------------------------------------------------------------------
-- list_stale_media_keys — SÉLECTION seule (STABLE) des clés déjà tracées
-- (candidate abandonnée par une reprise, ou source consommée) et jamais
-- encore confirmées supprimées.
-- ----------------------------------------------------------------------------

create function public.list_stale_media_keys()
returns table (id uuid, storage_key text, kind text)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select k.id, k.storage_key, k.kind
  from public.private_object_stale_keys k
  where k.cleaned_at is null;
$$;

revoke execute on function public.list_stale_media_keys()
  from public, anon, authenticated, service_role;
grant execute on function public.list_stale_media_keys() to service_role;

-- ----------------------------------------------------------------------------
-- claim_stale_key_for_cleanup — porte CAS AVANT tout appel Storage réel
-- (même principe que write_claimed_at). Un délai de grâce permet de
-- reréclamer une clé dont la suppression Storage a échoué silencieusement
-- (jamais confirmée par mark_stale_key_cleaned) — rien n'est jamais perdu.
-- ----------------------------------------------------------------------------

create function public.claim_stale_key_for_cleanup(p_id uuid, p_retry_after interval default interval '10 minutes')
returns table (storage_key text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.private_object_stale_keys;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_row from public.private_object_stale_keys where id = p_id for update;

  if not found or v_row.cleaned_at is not null then
    return;
  end if;

  if v_row.cleanup_claimed_at is not null and v_row.cleanup_claimed_at >= v_now - p_retry_after then
    -- Déjà réclamée récemment par un autre appel : jamais deux suppressions
    -- concurrentes de la même clé.
    return;
  end if;

  update public.private_object_stale_keys set cleanup_claimed_at = v_now where id = v_row.id;

  return query select v_row.storage_key;
end;
$$;

revoke execute on function public.claim_stale_key_for_cleanup(uuid, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_stale_key_for_cleanup(uuid, interval) to service_role;

-- ----------------------------------------------------------------------------
-- mark_stale_key_cleaned — appelée UNIQUEMENT après confirmation réelle du
-- succès de storage.remove() par le script appelant. Tant qu'elle n'est pas
-- appelée, la ligne reste réclamable (voir claim_stale_key_for_cleanup) :
-- un échec Storage ne fait jamais perdre la référence.
-- ----------------------------------------------------------------------------

create function public.mark_stale_key_cleaned(p_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  update public.private_object_stale_keys set cleaned_at = clock_timestamp() where id = p_id;
$$;

revoke execute on function public.mark_stale_key_cleaned(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_stale_key_cleaned(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- list_recently_cleaned_media_keys — RÉCONCILIATION (revue 2026-09-27).
-- cleaned_at exclut une clé des sélections de nettoyage normales, mais ne
-- garantit PAS qu'aucune écriture tardive ne puisse la recréer ensuite :
-- une candidate déjà revendiquée peut encore être écrite par une tentative
-- ancienne qui termine tard, et une source supprimée reste recréable tant
-- que l'URL signée cliente d'origine n'a pas expiré côté fournisseur. Cette
-- fonction NE fait AUCUNE hypothèse de fin des écritures : elle fournit au
-- script appelant les clés récemment nettoyées, pour une VÉRIFICATION RÉELLE
-- de leur existence Storage (download/list), jamais une confiance dans le
-- seul indicateur cleaned_at. Exclut explicitement, en plus, toute clé
-- correspondant au storage_key d'une ligne FINALIZED (double garde : une
-- candidate gagnante n'est jamais éligible, même par coïncidence).
-- ----------------------------------------------------------------------------

create function public.list_recently_cleaned_media_keys(p_within interval default interval '24 hours')
returns table (id uuid, storage_key text, kind text)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select k.id, k.storage_key, k.kind
  from public.private_object_stale_keys k
  where k.cleaned_at is not null
    and k.cleaned_at > now() - p_within
    and not exists (
      select 1 from public.private_object_uploads u
      where u.storage_key = k.storage_key and u.status = 'FINALIZED'
    );
$$;

revoke execute on function public.list_recently_cleaned_media_keys(interval)
  from public, anon, authenticated, service_role;
grant execute on function public.list_recently_cleaned_media_keys(interval) to service_role;

commit;
