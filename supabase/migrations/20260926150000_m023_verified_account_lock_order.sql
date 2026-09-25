-- M023 (suite) — B062, revue ciblée : 2 corrections sur
-- designate_plan_engineer/revoke_plan_engineer_designation. Aucune migration
-- déjà appliquée modifiée (20260926140000 reste intacte) : ce fichier
-- remplace les deux fonctions via CREATE OR REPLACE (mêmes signatures, mêmes
-- grants déjà en place — CREATE OR REPLACE ne les retire pas, aucun
-- REVOKE/GRANT à rejouer ici).
--
-- 1. Compte vérifié du PROPRIÉTAIRE appelant. Les deux fonctions ne
-- vérifiaient que owner_profile_id = auth.uid() ; le contrôle de compte
-- vérifié n'existait QUE côté Server Action (requireVerifiedAccount(),
-- première ligne de défense, pas l'autorité) — un appel RPC direct (ex.
-- depuis ce fichier de test) pouvait donc désigner/révoquer avec un compte
-- provisoire, contrairement à finalize_media_upload (M010) qui l'impose déjà
-- côté RPC. Corrigé : is_account_provisional() revérifié dans CHAQUE
-- fonction, refus FERMÉ ("is not false" — toute valeur autre que false
-- exact, y compris une erreur ou null, refuse), et placé APRÈS l'attente du
-- verrou organisation (jamais un état antérieur potentiellement obsolète).
--
-- Clarification (le rapport de revue précédent affirmait à tort une
-- réutilisation) : is_profile_verified() N'EST PAS appelée pour résoudre
-- l'identifiant de l'INGÉNIEUR. Cette fonction vérifie qu'un profil possède
-- AU MOINS UN identifiant vérifié — pas que l'identifiant SPÉCIFIQUE saisi
-- par le propriétaire l'est. Un ingénieur avec un e-mail vérifié mais un
-- téléphone non vérifié aurait pu être désigné via ce téléphone si
-- is_profile_verified() avait été utilisée à la place du contrôle réellement
-- en place (profile_identifiers.verified_at_server sur la ligne EXACTE
-- résolue, voir designate_plan_engineer ci-dessous, inchangé). is_profile_
-- verified() reste utilisée ailleurs dans le projet (M006b) pour un besoin
-- différent (vérifier UN profil dans son ensemble, pas un identifiant précis)
-- et n'a pas sa place ici.
--
-- 2. Ordre des verrous. designate_plan_engineer verrouille organizations
-- (aucune désignation existante à verrouiller, un INSERT seul suffit).
-- revoke_plan_engineer_designation verrouillait la DÉSIGNATION avant
-- l'ORGANISATION — ordre inverse, jamais uniformisé. Corrigé : une lecture
-- INITIALE non verrouillée résout seulement l'organization_id concernée
-- (jamais utilisée pour une décision), le verrou ORGANISATION est acquis en
-- premier (même ordre que designate), PUIS la désignation est reverrouillée
-- et REVALIDÉE (revoked_at relu sous ce second verrou, jamais depuis la
-- lecture initiale non protégée) — une révocation concurrente entre la
-- lecture initiale et ce second verrou est ainsi correctement détectée
-- (already_revoked), jamais une double révocation silencieuse.

begin;

create or replace function public.designate_plan_engineer(
  p_organization_id uuid,
  p_identifier_kind public.identifier_kind,
  p_identifier_value text
)
returns public.plan_engineer_designations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org public.organizations;
  v_normalized text;
  v_engineer_id uuid;
  v_row public.plan_engineer_designations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_identifier_value is null or btrim(p_identifier_value) = '' then
    raise exception 'identifier_required';
  end if;

  -- Verrou ORGANISATION avant toute décision (ordre canonique, partagé avec
  -- revoke_plan_engineer_designation ci-dessous).
  select * into v_org from public.organizations where id = p_organization_id for update;
  if not found or v_org.archived_at is not null then
    raise exception 'not_authorized';
  end if;
  if v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  -- CORRIGÉ (revue ciblée) : compte du propriétaire appelant revérifié APRÈS
  -- le verrou, refus fermé — auparavant absent de cette fonction (seule la
  -- Server Action l'imposait, contournable par un appel RPC direct).
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  v_normalized := case
    when p_identifier_kind = 'EMAIL' then lower(btrim(p_identifier_value))
    else btrim(p_identifier_value)
  end;

  -- Résolution + vérification de l'identifiant SPÉCIFIQUE saisi (inchangé) —
  -- volontairement PAS is_profile_verified() (voir en-tête). Absence de
  -- l'identifiant ET identifiant existant mais non vérifié produisent
  -- EXACTEMENT la même erreur ci-dessous (anti-énumération).
  select pi.profile_id into v_engineer_id
  from public.profile_identifiers pi
  where pi.kind = p_identifier_kind
    and pi.value_normalized = v_normalized
    and pi.verified_at_server is not null
    and pi.archived_at is null
  limit 1;

  if v_engineer_id is null then
    raise exception 'engineer_not_found_or_unverified';
  end if;

  begin
    insert into public.plan_engineer_designations (
      organization_id, engineer_profile_id, designated_by_profile_id,
      designated_identifier_kind, designated_identifier_value_normalized
    ) values (
      p_organization_id, v_engineer_id, v_uid, p_identifier_kind, v_normalized
    )
    returning * into v_row;
  exception
    when unique_violation then
      raise exception 'already_designated';
  end;

  return v_row;
end;
$$;

create or replace function public.revoke_plan_engineer_designation(p_designation_id uuid)
returns public.plan_engineer_designations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.plan_engineer_designations;
  v_org public.organizations;
  v_organization_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Lecture INITIALE non verrouillée : résout uniquement l'organisation
  -- concernée (organization_id est immuable après création, jamais réécrit),
  -- jamais utilisée pour une décision d'autorisation ou de revoked_at.
  select organization_id into v_organization_id
  from public.plan_engineer_designations
  where id = p_designation_id;
  if v_organization_id is null then
    raise exception 'not_authorized';
  end if;

  -- Verrou ORGANISATION EN PREMIER (même ordre que designate_plan_engineer,
  -- CORRIGÉ — auparavant la désignation était verrouillée avant l'organisation).
  select * into v_org from public.organizations where id = v_organization_id for update;
  if not found or v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  -- CORRIGÉ (revue ciblée) : même contrôle que designate_plan_engineer,
  -- après le verrou organisation, refus fermé.
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  -- CORRIGÉ : la désignation est REVERROUILLÉE et REVALIDÉE ICI, jamais
  -- depuis la lecture initiale non protégée — une révocation concurrente
  -- entre cette lecture et ce verrou est ainsi détectée correctement.
  select * into v_row from public.plan_engineer_designations where id = p_designation_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;
  if v_row.revoked_at is not null then
    raise exception 'already_revoked';
  end if;

  update public.plan_engineer_designations
  set revoked_at = clock_timestamp(), revoked_by_profile_id = v_uid
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

commit;
