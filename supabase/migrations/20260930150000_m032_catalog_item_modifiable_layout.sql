-- M032 — fichier de projet modifiable optionnel pour une version de
-- catalogue (prochain chantier après M031, PREPARATION_CATALOGUE_MODIFIABLE.md
-- Lot A ; non rattaché à un identifiant B0xx existant, autorisation
-- fondateur explicite du 2026-10-03, migration locale uniquement).
--
-- Décisions reprises telles quelles (fondateur) :
--   - colonne JSON NULLABLE sur plan_catalog_item_versions (M019, déjà
--     immuable — additive, aucune ligne existante affectée, NULL partout
--     avant ce lot) ;
--   - conserve le ProjectFile COMPLET et versionné (version/savedAt/
--     orientation/layout — serializeProject, projectFile.ts), jamais un
--     Layout brut qui ne serait pas réimportable tel quel ;
--   - propriétaire d'organisation SEUL habilité (même droit que toute
--     mutation M019 aujourd'hui, aucune extension) ;
--   - les anciens modèles sans JSON restent utilisables exactement comme
--     aujourd'hui (rattachement direct, M020, inchangé).
--
-- finalize_catalog_item_upload gagne un second paramètre `p_layout jsonb`
-- (défaut NULL) — l'ANCIENNE signature à un seul argument est SUPPRIMÉE
-- (DROP puis CREATE, jamais une simple CREATE OR REPLACE qui créerait un
-- second overload ambigu pour PostgREST) ; un appel existant qui ne fournit
-- QUE p_operation_uuid continue de fonctionner à l'identique (le défaut
-- s'applique), aucune modification requise côté appelant existant
-- (UploadVersionForm/depositCatalogItemVersionAction, inchangés).
--
-- Validation du layout EN BASE (defense in depth contre un appel RPC
-- direct, qui ne passe jamais par validateProjectFile côté serveur Next) :
-- format JSON objet, version parmi les versions reconnues par
-- SUPPORTED_VERSIONS (projectFile.ts, [1,2,3,4] au moment de ce lot — à
-- maintenir en phase si ce fichier évolue), présence des clés
-- orientation/layout, taille plafonnée. Reste volontairement SUPERFICIEL
-- (jamais une réplication de validateLayout en PL/pgSQL, hors de
-- proportion) : la validation STRUCTURELLE complète et AUTORITAIRE reste
-- validateProjectFile, appelée côté serveur Next AVANT tout appel RPC —
-- ce garde-fou SQL ne fait que refuser un contournement direct du RPC,
-- jamais une seconde source de vérité structurelle.

begin;

alter table public.plan_catalog_item_versions
  add column layout jsonb null;

-- Taille plafonnée au format JSON texte (jamais au nombre d'octets interne
-- jsonb, qui ne correspond pas à la taille du fichier réellement envoyé) —
-- 2 Mo, largement au-dessus de toute géométrie réaliste de ce prototype,
-- jamais un alignement sur la limite Storage (20 Mo, un fichier binaire
-- PDF/image, pas comparable à un JSON texte).
alter table public.plan_catalog_item_versions
  add constraint plan_catalog_item_versions_layout_size
  check (layout is null or octet_length(layout::text) <= 2097152);

drop function if exists public.finalize_catalog_item_upload(uuid);

create function public.finalize_catalog_item_upload(p_operation_uuid uuid, p_layout jsonb default null)
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
  v_layout_version numeric;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Garde-fou SQL superficiel (format/version/structure/taille) — jamais un
  -- remplacement de validateProjectFile (Next, autoritaire, appelé avant ce
  -- RPC pour le chemin réel) : refuse seulement un contournement direct du
  -- RPC avec un JSON manifestement invalide, jamais un stockage aveugle.
  if p_layout is not null then
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
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.created_by_profile_id <> v_uid or v_row.entity_type <> 'plan_catalog_item_version' then
    raise exception 'not_authorized';
  end if;

  select * into v_target from public.plan_catalog_item_upload_targets where private_object_upload_id = v_row.id;
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

  -- Idempotence inchangée : un rejeu renvoie la version déjà créée, jamais
  -- une tentative d'ajouter/modifier le layout après coup (immuable comme
  -- le reste de la ligne).
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

  insert into public.plan_catalog_item_versions (
    catalog_item_id, organization_id, version_number, private_object_upload_id, created_by_profile_id, layout
  ) values (
    v_target.catalog_item_id, v_row.organization_id, v_next_version_number, v_row.id, v_uid, p_layout
  )
  returning * into v_version;

  update public.private_object_uploads set entity_id = v_version.id where id = v_row.id;

  v_source_key := '_private/' || v_row.organization_id::text || '/plan_catalog_item_version/' || v_row.operation_uuid::text || '/source';
  insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
  values (v_row.id, v_source_key, 'source');

  return v_version;
end;
$$;

revoke execute on function public.finalize_catalog_item_upload(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.finalize_catalog_item_upload(uuid, jsonb) to authenticated;

-- get_catalog_item_version_file — consultation de l'aperçu (storage_key/
-- bucket, inchangé dans sa nature) ET récupération du fichier modifiable
-- (layout, NULL pour un ancien modèle — jamais une erreur). Mêmes droits
-- que toute gestion de catalogue aujourd'hui : propriétaire de
-- l'organisation SEUL — aucune permission de lecture nouvelle, aucun accès
-- public (RLS déjà sans policy sur private_object_uploads/
-- plan_catalog_item_versions, accès exclusivement par fonction SECURITY
-- DEFINER, inchangé).
create function public.get_catalog_item_version_file(p_version_id uuid)
returns table (storage_key text, bucket text, layout jsonb)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_version public.plan_catalog_item_versions;
  v_org public.organizations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_version from public.plan_catalog_item_versions where id = p_version_id;
  if not found then
    raise exception 'not_authorized';
  end if;

  select * into v_org from public.organizations where id = v_version.organization_id;
  if not found or v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  return query
    select u.storage_key, 'organization-catalog'::text, v_version.layout
    from public.private_object_uploads u
    where u.id = v_version.private_object_upload_id
      and u.status = 'FINALIZED';

  if not found then
    raise exception 'file_not_finalized';
  end if;
end;
$$;

revoke execute on function public.get_catalog_item_version_file(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_catalog_item_version_file(uuid) to authenticated;

commit;
