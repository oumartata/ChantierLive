-- Correctif immédiat (revue ciblée, même session) : 20260927090000 a recréé
-- claim_upload_attempt(uuid) à UN seul paramètre, en s'appuyant sur le texte
-- de 20260926100000 (M010 d'origine) sans tenir compte de la correction
-- ultérieure 20260926130000 (M026, revue v3.2) qui avait DÉJÀ fait évoluer
-- la signature réellement utilisée vers (uuid, uuid default null) et
-- supprimé l'ancienne. CREATE OR REPLACE ne trouvant aucune fonction
-- existante à UN paramètre à remplacer, un nouvel overload a été créé avec
-- les droits PostgreSQL par défaut (PUBLIC, anon, authenticated,
-- service_role) — trou de sécurité introduit par erreur, jamais utilisé par
-- le code applicatif (qui appelle la forme à deux paramètres), corrigé ici
-- avant toute revue. Ne modifie PAS 20260927090000 déjà appliquée dans cette
-- même session (discipline habituelle : nouvelle migration correctrice).

begin;

drop function if exists public.claim_upload_attempt(uuid);

create or replace function public.claim_upload_attempt(p_operation_uuid uuid, p_expected_attempt_id uuid default null)
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

  -- Revue v3.2 (20260926130000), préservée à l'identique : refus AVANT toute
  -- autre branche, avant toute mise à jour de write_claimed_at.
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

-- Réaffirmé explicitement (jamais supposé silencieusement cette fois).
revoke execute on function public.claim_upload_attempt(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_upload_attempt(uuid, uuid) to authenticated;

commit;
