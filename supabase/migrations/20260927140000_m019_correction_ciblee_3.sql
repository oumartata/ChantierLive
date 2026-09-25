-- Correction ciblée B061 (revue, 3 branches de reprise) — n'modifie pas les
-- fichiers déjà appliqués : CREATE OR REPLACE additif, grants préservés
-- (revérifiés après application).
--
-- Point 1 : finalize_catalog_item_upload revenait tôt sur le chemin
-- idempotent (status déjà FINALIZED) AVANT de revérifier la propriété
-- courante de l'organisation et le compte vérifié — un appelant ayant perdu
-- la propriété de l'organisation ou dont le compte est devenu provisoire
-- pouvait encore rejouer finalize sur une opération déjà terminée et
-- recevoir la version. Même défaut déjà corrigé pour finalize_media_upload
-- (M010, revue 2026-09-26 : "la branche déjà FINALIZED -> renvoyer le média
-- existant s'exécutait AVANT la revérification"), non reporté ici lors de
-- la première correction (20260927120000). Corrigé : organisation et item
-- verrouillés/revalidés, puis compte revérifié, TOUS AVANT tout retour —
-- y compris le retour idempotent. L'idempotence et l'ordre des contrôles
-- après attente (organisation avant item, compte/expiration après les deux
-- verrous) sont conservés à l'identique.

begin;

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

  select * into v_target from public.plan_catalog_item_upload_targets where private_object_upload_id = v_row.id;
  if not found then
    raise exception 'finalize_inconsistent_state';
  end if;

  -- Ordre de verrous compatible avec submit/publish : organisation D'ABORD
  -- (peut attendre), item ENSUITE — tous deux revalidés AVANT TOUT RETOUR,
  -- y compris le retour idempotent ci-dessous (jamais seulement pour la
  -- transition normale).
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
  -- ci-dessus : revérifiés ICI, AVANT tout retour (idempotent ou non).
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  -- Idempotence : APRÈS revalidation complète des droits courants — un
  -- rejeu (réponse perdue après finalisation déjà réussie) renvoie la MÊME
  -- version, mais SEULEMENT si l'appelant est toujours légitime à cet
  -- instant, jamais déduit de sa seule identité passée.
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

commit;
