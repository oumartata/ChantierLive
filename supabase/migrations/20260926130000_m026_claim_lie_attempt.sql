begin;

-- ----------------------------------------------------------------------------
-- Lier le CLAIM à l'attempt_id effectivement lu (revue v3.2). commitMediaUpload
-- (actions.ts) lit l'état (get_upload_status), décide s'il doit précontrôler
-- la source, PUIS appelle claim_upload_attempt — deux appels RPC séparés,
-- donc deux lectures de la ligne dans le temps. Entre les deux, une reprise
-- CONCURRENTE (recover_media_upload_attempt) sur une tentative expirée peut
-- ouvrir une NOUVELLE tentative (nouvel attempt_id/candidate_key,
-- write_claimed_at remis à null) :
--   1. A lit une tentative déjà revendiquée (write_claimed_at non null) :
--      précontrôle de la source SAUTÉ (rien ne le justifiait alors).
--   2. B relance recover_media_upload_attempt sur cette tentative, expirée :
--      nouvel attempt_id, porte de nouveau disponible (write_claimed_at null).
--   3. A appelle claim_upload_attempt : la porte est ouverte pour la NOUVELLE
--      tentative, A la gagne (won=true) — mais A n'a jamais lu la source de
--      cette nouvelle tentative (précontrôle sauté à l'étape 1 sur la base de
--      l'ANCIENNE tentative).
-- Le code TypeScript traite alors won=true comme preuve que le précontrôle a
-- eu lieu (`precheckedSourceBytes` non null) — faux dans cet entrelacement :
-- erreur d'exécution (cast TypeScript non protecteur au runtime) après avoir
-- déjà consommé la porte CAS de la NOUVELLE tentative, sans jamais écrire la
-- candidate — même blocage que le défaut visé en v3.1, par un autre chemin.
--
-- Corrigé : claim_upload_attempt accepte désormais un second paramètre
-- optionnel p_expected_attempt_id. Quand il est fourni, la fonction REFUSE
-- (attempt_changed) si l'attempt_id COURANT de la ligne diffère de celui
-- attendu — AVANT toute mise à jour de write_claimed_at : la porte de la
-- tentative courante (éventuellement nouvelle) n'est jamais consommée par ce
-- refus, elle reste intacte pour un appel ultérieur correctement informé.
-- Rétrocompatible : p_expected_attempt_id est optionnel (défaut null, aucune
-- vérification) — tous les appels existants (tests, autres call sites) qui ne
-- le fournissent pas conservent exactement le comportement précédent.
-- ----------------------------------------------------------------------------

drop function if exists public.claim_upload_attempt(uuid);

create function public.claim_upload_attempt(p_operation_uuid uuid, p_expected_attempt_id uuid default null)
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

  -- CORRIGÉ (revue v3.2) : refus AVANT toute autre branche, avant toute
  -- mise à jour de write_claimed_at — la tentative courante (nouvelle ou non)
  -- n'est jamais consommée par ce refus.
  if p_expected_attempt_id is not null and v_row.attempt_id <> p_expected_attempt_id then
    raise exception 'attempt_changed';
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

revoke execute on function public.claim_upload_attempt(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_upload_attempt(uuid, uuid) to authenticated;

commit;
