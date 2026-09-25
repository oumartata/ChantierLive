-- Correction ciblée B061 (revue, 6 défauts) — n'modifie pas les fichiers
-- déjà appliqués (20260927090000/100000/110000) : CREATE OR REPLACE /
-- ALTER TYPE ADD ATTRIBUTE additifs uniquement.

begin;

-- ----------------------------------------------------------------------------
-- Point 3 — finalize_catalog_item_upload : les contrôles susceptibles de
-- devenir obsolètes PENDANT UNE ATTENTE (verrou organisations/item, qui peut
-- bloquer) sont désormais placés APRÈS ces verrous, juste avant la
-- transition finale : compte vérifié (is_account_provisional), expiration
-- de tentative. L'organisation ET l'item sont verrouillés/revalidés AVANT
-- toute transition (même ordre que submit/publish : organisation d'abord,
-- item ensuite) — l'ancienne version verrouillait l'item APRÈS avoir déjà
-- fait basculer private_object_uploads.status à FINALIZED, fenêtre de TOCTOU
-- réelle entre cette transition et la revalidation de l'item.
-- Point 1 (complément) : l'idempotence (retour de la version existante si
-- déjà FINALIZED) est vérifiée EN PREMIER, avant tout verrou coûteux.
-- ----------------------------------------------------------------------------

create or replace function public.finalize_catalog_item_upload(p_operation_uuid uuid)
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

  -- Idempotence AVANT tout verrou supplémentaire : un rejeu (réponse perdue
  -- après une finalisation déjà réussie) renvoie la MÊME version, jamais une
  -- seconde.
  if v_row.status = 'FINALIZED' then
    select * into v_version from public.plan_catalog_item_versions where private_object_upload_id = v_row.id;
    if found then
      return v_version;
    end if;
    raise exception 'finalize_inconsistent_state';
  end if;

  select * into v_target from public.plan_catalog_item_upload_targets where private_object_upload_id = v_row.id;
  if not found then
    raise exception 'finalize_inconsistent_state';
  end if;

  -- Ordre de verrous compatible avec submit/publish : organisation D'ABORD
  -- (peut attendre), item ENSUITE — tous deux revalidés AVANT toute
  -- transition, jamais entrelacés avec elle.
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

  -- Contrôles susceptibles de devenir obsolètes PENDANT LES ATTENTES
  -- ci-dessus : revérifiés ICI, immédiatement avant la transition finale.
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
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

-- ----------------------------------------------------------------------------
-- Points 5/6 — catalog_item_view étendu (ALTER TYPE, même OID préservé) :
--   - published_version_number : numéro PROPRE à la version publiée, jamais
--     déduit de la dernière version déposée (point 6 — un dépôt v2 après
--     publication de v1 ne doit jamais laisser croire que v2 est publiée).
--   - latest_validation_designation_active : permet à l'interface de
--     proposer une nouvelle soumission quand la demande PENDING actuelle
--     référence une désignation révoquée (point 5), sans jamais le faire
--     pour une désignation encore active (already_pending reste opposé par
--     submit_catalog_item_version_for_validation lui-même — l'affichage suit
--     ici la même règle, ne la contourne pas).
-- ----------------------------------------------------------------------------

alter type public.catalog_item_view add attribute published_version_number integer;
alter type public.catalog_item_view add attribute latest_validation_designation_active boolean;

create or replace function public.list_organization_catalog_items(p_organization_id uuid)
returns setof public.catalog_item_view
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select
    i.id, i.label, i.published_version_id, i.published_at_server, i.archived_at,
    lv.id as latest_version_id, lv.version_number as latest_version_number,
    lval.status as latest_validation_status,
    pv.version_number as published_version_number,
    ld.revoked_at is null as latest_validation_designation_active
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
  left join public.plan_engineer_designations ld on ld.id = lval.designation_id
  left join public.plan_catalog_item_versions pv on pv.id = i.published_version_id
  where i.organization_id = p_organization_id
    and o.owner_profile_id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- Point 4 — nettoyage adapté au bucket organization-catalog. Les fonctions
-- de sélection/abandon existantes (list_expired_media_uploads, abandon_
-- expired_media_upload) restent filtrées à entity_type='media_asset' —
-- AUCUNE ligne catalogue n'y transitait, donc AUCUN nettoyage n'existait
-- pour les uploads catalogue expirés (lacune, pas seulement un mauvais
-- bucket). get_stale_key_bucket permet au script de nettoyage de choisir le
-- BON bucket par clé tracée, sans dupliquer la logique de protection déjà
-- assurée par list_recently_cleaned_media_keys (exclusion des clés
-- FINALIZED, déjà agnostique du domaine).
-- ----------------------------------------------------------------------------

create function public.list_expired_catalog_item_uploads(p_older_than interval default interval '1 hour')
returns table (id uuid, organization_id uuid, attempt_expires_at timestamptz)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.organization_id, u.attempt_expires_at
  from public.private_object_uploads u
  where u.entity_type = 'plan_catalog_item_version'
    and u.status in ('PENDING', 'FINALIZING')
    and u.attempt_expires_at < now() - p_older_than;
$$;

revoke execute on function public.list_expired_catalog_item_uploads(interval)
  from public, anon, authenticated, service_role;
grant execute on function public.list_expired_catalog_item_uploads(interval) to service_role;

create function public.abandon_expired_catalog_item_upload(p_id uuid, p_older_than interval default interval '1 hour')
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

  if not found or v_row.entity_type <> 'plan_catalog_item_version' then
    return false;
  end if;

  if v_row.status not in ('PENDING', 'FINALIZING') or v_row.attempt_expires_at >= now() - p_older_than then
    return false;
  end if;

  if v_row.write_claimed_at is not null then
    insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
    values (v_row.id, v_row.candidate_key, 'candidate');
  end if;

  v_source_key := '_private/' || v_row.organization_id::text || '/plan_catalog_item_version/' || v_row.operation_uuid::text || '/source';
  insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
  values (v_row.id, v_source_key, 'source');

  update public.private_object_uploads set status = 'ABANDONED' where id = v_row.id;

  return true;
end;
$$;

revoke execute on function public.abandon_expired_catalog_item_upload(uuid, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.abandon_expired_catalog_item_upload(uuid, interval) to service_role;

create function public.get_stale_key_bucket(p_id uuid)
returns text
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select case u.entity_type
    when 'media_asset' then 'project-media'
    when 'plan_catalog_item_version' then 'organization-catalog'
    else null
  end
  from public.private_object_stale_keys k
  join public.private_object_uploads u on u.id = k.private_object_upload_id
  where k.id = p_id;
$$;

revoke execute on function public.get_stale_key_bucket(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_stale_key_bucket(uuid) to service_role;

commit;
