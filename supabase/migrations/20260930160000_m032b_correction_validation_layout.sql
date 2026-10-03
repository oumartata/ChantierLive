-- M032b — correction d'une frontière de confiance contournable sur M032
-- (plan_catalog_item_versions.layout) : détectée par appel RPC direct
-- AVANT toute autre modification, à la demande explicite du fondateur
-- (2026-10-03). finalize_catalog_item_upload(uuid, jsonb) acceptait
-- `p_layout` directement de l'appelant AUTHENTIFIÉ (grant à `authenticated`,
-- nécessaire pour que le flux normal fonctionne) — un appel RPC direct
-- (hors de l'action serveur Next, qui seule appelle validateProjectFile
-- avant tout) pouvait donc fournir un JSON respectant l'enveloppe SQL
-- superficielle (objet, version connue, clés orientation/layout présentes)
-- mais structurellement invalide (ex. une porte référençant une pièce
-- inexistante) — confirmé empiriquement : accepté, version créée, contenu
-- jamais validé par validateLayout. Jamais une réécriture de M032
-- (20260930150000_m032_*.sql, laissé tel quel) : correction en NOUVEAU
-- fichier, cible locale reconfirmée avant application, sauvegarde reprise.
--
-- Corrigé en reprenant le MÊME principe de frontière de confiance déjà
-- utilisé pour le contenu du fichier plat (attest_storage_verified,
-- M010/M026) : jamais une revalidation structurelle complète en SQL (hors
-- de proportion, explicitement exclu), mais un déplacement du point
-- d'écriture derrière une fonction accessible UNIQUEMENT au service_role
-- (jamais à `authenticated`) — exactement comme attest_storage_verified.
-- Seule l'action serveur Next (qui détient la clé service_role, jamais le
-- navigateur) peut donc faire parvenir un layout jusqu'à la version créée,
-- et elle appelle TOUJOURS validateProjectFile (TS, autoritaire) avant cet
-- appel. finalize_catalog_item_upload reprend sa signature ORIGINALE à un
-- seul paramètre (plus simple que la version M032 à deux paramètres,
-- aucune ambiguïté d'overload possible) : le layout, s'il existe, est lu
-- depuis l'enregistrement intermédiaire posé par attest_catalog_item_layout,
-- jamais depuis un argument fourni par l'appelant authentifié.

begin;

-- Enregistrement intermédiaire du layout VALIDÉ (Node), en attente de
-- finalisation — jamais lu ni écrit par un appelant authentifié
-- directement (voir attest_catalog_item_layout ci-dessous). Même plafond de
-- taille que la colonne finale (M032), défense en profondeur à ce stade
-- aussi.
alter table public.plan_catalog_item_upload_targets
  add column pending_layout jsonb null;

alter table public.plan_catalog_item_upload_targets
  add constraint plan_catalog_item_upload_targets_pending_layout_size
  check (pending_layout is null or octet_length(pending_layout::text) <= 2097152);

-- attest_catalog_item_layout — SEULE porte d'entrée pour faire parvenir un
-- layout jusqu'à une version de catalogue. Réservée au service_role : un
-- appelant authentifié ordinaire ne peut PAS l'invoquer (aucun grant),
-- exactement comme attest_storage_verified (M010). Garde-fou SQL superficiel
-- conservé (format/version/structure/taille) — jamais un remplacement de
-- validateProjectFile, qui a déjà tourné côté Next AVANT cet appel.
create function public.attest_catalog_item_layout(p_operation_uuid uuid, p_layout jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.private_object_uploads;
  v_layout_version numeric;
begin
  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.entity_type <> 'plan_catalog_item_version' then
    raise exception 'not_authorized';
  end if;

  if v_row.status = 'ABANDONED' then
    raise exception 'operation_abandoned';
  end if;

  if p_layout is null then
    raise exception 'layout_invalid_format';
  end if;
  if jsonb_typeof(p_layout) <> 'object' then
    raise exception 'layout_invalid_format';
  end if;
  if octet_length(p_layout::text) > 2097152 then
    raise exception 'layout_too_large';
  end if;
  v_layout_version := (p_layout->>'version')::numeric;
  if v_layout_version is null or v_layout_version not in (1, 2, 3, 4) then
    raise exception 'layout_unknown_version';
  end if;
  if jsonb_typeof(p_layout->'orientation') is distinct from 'string' then
    raise exception 'layout_invalid_structure';
  end if;
  if jsonb_typeof(p_layout->'layout') is distinct from 'object' then
    raise exception 'layout_invalid_structure';
  end if;

  update public.plan_catalog_item_upload_targets
  set pending_layout = p_layout
  where private_object_upload_id = v_row.id;

  if not found then
    raise exception 'finalize_inconsistent_state';
  end if;
end;
$$;

revoke execute on function public.attest_catalog_item_layout(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.attest_catalog_item_layout(uuid, jsonb) to service_role;

-- finalize_catalog_item_upload reprend sa signature ORIGINALE à un seul
-- paramètre (p_operation_uuid) — le second paramètre jsonb de M032 est
-- supprimé : un appelant authentifié ne fournit plus JAMAIS le layout
-- directement, il est lu depuis pending_layout (posé exclusivement par
-- attest_catalog_item_layout, service_role seul). Comportement par
-- ailleurs identique à M032 (idempotence, verrous, revérifications).
drop function if exists public.finalize_catalog_item_upload(uuid, jsonb);
drop function if exists public.finalize_catalog_item_upload(uuid);

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
  v_org public.organizations;
  v_now timestamptz;
  v_version public.plan_catalog_item_versions;
  v_updated integer;
  v_next_version_number integer;
  v_source_key text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.created_by_profile_id <> v_uid or v_row.entity_type <> 'plan_catalog_item_version' then
    raise exception 'not_authorized';
  end if;

  select * into v_target from public.plan_catalog_item_upload_targets where private_object_upload_id = v_row.id for update;
  if not found then
    raise exception 'finalize_inconsistent_state';
  end if;

  select * into v_org from public.organizations where id = v_row.organization_id for update;
  if not found or v_org.archived_at is not null or v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.plan_catalog_items where id = v_target.catalog_item_id for update;
  if not exists (
    select 1 from public.plan_catalog_items
    where id = v_target.catalog_item_id and organization_id = v_org.id and archived_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
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

  select coalesce(max(version_number), 0) + 1 into v_next_version_number
  from public.plan_catalog_item_versions
  where catalog_item_id = v_target.catalog_item_id;

  -- v_target relu sous verrou plus haut : pending_layout reflète la
  -- DERNIÈRE valeur attestée par attest_catalog_item_layout (service_role
  -- seul), jamais un argument de cet appel.
  insert into public.plan_catalog_item_versions (
    catalog_item_id, organization_id, version_number, private_object_upload_id, created_by_profile_id, layout
  ) values (
    v_target.catalog_item_id, v_row.organization_id, v_next_version_number, v_row.id, v_uid, v_target.pending_layout
  )
  returning * into v_version;

  update public.private_object_uploads set entity_id = v_version.id where id = v_row.id;

  v_source_key := '_private/' || v_row.organization_id::text || '/plan_catalog_item_version/' || v_row.operation_uuid::text || '/source';
  insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
  values (v_row.id, v_source_key, 'source');

  return v_version;
end;
$$;

revoke execute on function public.finalize_catalog_item_upload(uuid) from public, anon, authenticated, service_role;
grant execute on function public.finalize_catalog_item_upload(uuid) to authenticated;

commit;
