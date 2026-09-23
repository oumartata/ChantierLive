-- M006a — décisions sur une invitation (B016 : accepter, refuser, révoquer)
-- Documentaire (comme M002a/M004a/M004b) : dépend de M006 (B015), ne modifie
-- AUCUN fichier de migration déjà clôturé (ni M006, ni les précédents).
--
-- Périmètre de CE tour (B016) : accept_invitation, refuse_invitation,
-- revoke_invitation, list_manageable_invitations. Toujours pas
-- role_transfers/support_grants/has_support_scope (M006 reste PARTIELLE).
--
-- Arbitrages fondateur B016 (2026-09-23) :
--   - Contrôles strictement séparés par action, jamais mutualisés :
--       accepter  : adhésion émettrice D'ORIGINE (created_by_membership_id)
--                   active, rôle/owner_profile conforme à la matrice,
--                   authorization_revision inchangée ; bénéficiaire vérifié
--                   (non provisional) ; cible contrôlée si ciblée.
--       refuser   : PENDING + non expirée ; cible contrôlée si ciblée, sinon
--                   session authentifiée seule suffit. AUCUN contrôle de
--                   validité de l'émetteur (le refus ne crée rien).
--       révoquer  : adhésion ACTUELLE de l'appelant (n'importe laquelle,
--                   pas forcément created_by_membership_id) avec le rôle
--                   habilitant correspondant — fonctionne même si l'émetteur
--                   d'origine est révoqué ou sa révision périmée. AUCUNE
--                   revérification de l'émetteur d'origine.
--   - Déjà membre actif (tout rôle confondu) au moment d'accepter : refus
--     explicite ('already_member'), invitation laissée PENDING inchangée,
--     jamais de changement de rôle implicite.
--   - Ordre de verrouillage COMMUN, documenté par fonction : verrou avisoire
--     du chantier (identifié par une lecture non verrouillée préalable,
--     revérifiée après verrouillage) -> adhésion(s) habilitante(s)
--     nécessaire(s) -> ligne invitations. JAMAIS l'inverse (verrouiller
--     l'invitation puis une adhésion créerait un risque d'interblocage avec
--     create_invitation, qui verrouille déjà adhésion avant tout le reste).
--     refuse_invitation n'a besoin d'aucun verrou d'adhésion : verrou de la
--     ligne invitations directement (rien à sérialiser côté quota/émetteur).
--   - list_manageable_invitations : identité via auth.uid(), EXECUTE réservé
--     à authenticated (jamais anon), colonnes minimales SANS token_hash ni
--     jeton ; expose "revocable" (PENDING ET non expirée) distinct du statut
--     brut, pour ne jamais proposer une action de révocation inutilisable
--     sur une invitation déjà expirée en pratique (lazy expiry, M006).
--     Portée : invitations PENDING du chantier dont le rôle habilitant
--     courant de l'appelant correspond — jamais l'historique décidé, jamais
--     élargi à tout membre actif.
--   - invitation_required_emitter() : petite fonction interne partagée par
--     CES 4 fonctions (nouvelles dans ce fichier) pour dériver le rôle
--     habilitant depuis (role, owner_profile) d'une invitation — réduit le
--     risque de divergence entre accept/revoke/list. create_invitation et
--     get_invitation_preview (M006, déjà clôturée) gardent leur propre
--     logique inline, non modifiée.
--
-- Corrections post-revue ZIP (2026-09-23) :
--   - accept_invitation/refuse_invitation comparaient expires_at à now()
--     (figée au début de la transaction) : un appel bloqué par un verrou
--     jusqu'après l'expiration réelle voyait encore l'ancienne heure et
--     pouvait aboutir à tort. Remplacé par clock_timestamp() (heure réelle
--     au moment du contrôle, posé APRÈS acquisition des verrous).
--   - revoke_invitation ne contrôlait aucune expiration alors que
--     list_manageable_invitations annonce revocable := PENDING ET non
--     expirée : un appel RPC direct pouvait révoquer une invitation déjà
--     expirée en pratique, en désaccord avec ce contrat. Ajouté, avec
--     clock_timestamp() également, après le verrou de la ligne invitations.
--   - revoke_invitation distinguait un UUID inexistant (invitation_not_
--     available, immédiat) d'une invitation existante hors périmètre de
--     l'appelant (not_authorized) : une fuite d'existence pour un appelant
--     non habilité. Harmonisé sur not_authorized dans les deux cas ; seul un
--     appelant PROUVÉ habilité (adhésion courante trouvée) peut ensuite voir
--     invitation_not_available pour un statut/expiration réels.

begin;

-- ----------------------------------------------------------------------------
-- invitation_required_emitter — dérive le rôle habilitant depuis le couple
-- (role, owner_profile) proposé au bénéficiaire. Les 4 combinaisons
-- couvertes sont les 4 SEULES possibles compte tenu de
-- invitations_owner_profile_consistency (M006) : la branche ELSE est un
-- filet de sécurité inatteignable en pratique, jamais une validation réelle.
-- ----------------------------------------------------------------------------

create function public.invitation_required_emitter(
  p_role public.membership_role,
  p_owner_profile public.owner_profile,
  out required_role public.membership_role,
  out required_owner_profile public.owner_profile
)
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_role = 'CONTRACTOR' then
    required_role := 'OWNER';
    required_owner_profile := 'PRIMARY';
  elsif p_role = 'OWNER' and p_owner_profile = 'CO_OWNER' then
    required_role := 'OWNER';
    required_owner_profile := 'PRIMARY';
  elsif p_role = 'OWNER' and p_owner_profile = 'PRIMARY' then
    required_role := 'CONTRACTOR';
    required_owner_profile := null;
  elsif p_role = 'SITE_MANAGER' then
    required_role := 'CONTRACTOR';
    required_owner_profile := null;
  else
    raise exception 'invalid_invitation_role_combination';
  end if;
end;
$$;

revoke execute on function public.invitation_required_emitter(public.membership_role, public.owner_profile)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- accept_invitation
-- ----------------------------------------------------------------------------

create function public.accept_invitation(p_token text)
returns public.project_memberships
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_hash bytea;
  v_peek record;
  v_required record;
  v_membership record;
  v_inv public.invitations;
  v_cap int;
  v_count int;
  v_new_membership public.project_memberships;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Bénéficiaire vérifié obligatoire pour TOUTE invitation, ciblée ou lien
  -- partagé (décidé B015/B016), symétrique à l'exigence côté émission.
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception 'invitation_not_available';
  end if;

  v_hash := extensions.digest(p_token, 'sha256');

  -- Lecture NON verrouillée : identifie seulement le chantier (clé du
  -- verrou avisoire) et l'adhésion émettrice à verrouiller ensuite. Toute
  -- valeur lue ici est revérifiée après acquisition des verrous ci-dessous,
  -- jamais utilisée telle quelle pour une décision.
  select project_id, created_by_membership_id
  into v_peek
  from public.invitations
  where token_hash = v_hash;

  if not found then
    raise exception 'invitation_not_available';
  end if;

  -- Ordre : 1) avisoire chantier, 2) adhésion émettrice, 3) invitation.
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek.project_id::text)::bigint);

  select id, role, owner_profile, revoked_at, authorization_revision
  into v_membership
  from public.project_memberships
  where id = v_peek.created_by_membership_id
  for update;
  -- FK RESTRICT (M006) garantit l'existence de cette ligne : "not found"
  -- non atteignable ici.

  select *
  into v_inv
  from public.invitations
  where token_hash = v_hash
  for update;

  -- clock_timestamp() (heure réelle au moment de CET appel), jamais now()
  -- (figée au début de la transaction) : un appel bloqué par le verrou
  -- ci-dessus jusqu'après l'expiration doit voir l'expiration réelle, pas
  -- l'heure d'avant blocage (corrigé après revue ZIP).
  if v_inv.status <> 'PENDING' or v_inv.expires_at <= clock_timestamp() then
    raise exception 'invitation_not_available';
  end if;

  v_required := public.invitation_required_emitter(v_inv.role, v_inv.owner_profile);

  -- Contrôle "accepter" : adhésion émettrice D'ORIGINE active, rôle
  -- conforme, révision inchangée. Un aller-retour de rôle (même transaction
  -- ou non) sur cette même ligne l'invalide définitivement (authorization_
  -- revision, M006).
  if v_membership.revoked_at is not null
     or v_membership.authorization_revision <> v_inv.created_by_membership_revision
     or v_membership.role <> v_required.required_role
     or v_membership.owner_profile is distinct from v_required.required_owner_profile
  then
    raise exception 'sender_no_longer_authorized';
  end if;

  if v_inv.target_kind is not null then
    if not exists (
      select 1 from public.profile_identifiers pi
      where pi.profile_id = v_uid
        and pi.kind = v_inv.target_kind
        and pi.value_normalized = v_inv.target_value_normalized
        and pi.verified_at_server is not null
        and pi.archived_at is null
    ) then
      raise exception 'target_not_controlled';
    end if;
  end if;

  -- Déjà membre actif (tout rôle confondu) : refus explicite, invitation
  -- laissée PENDING inchangée, aucun changement de rôle implicite.
  if exists (
    select 1 from public.project_memberships
    where project_id = v_inv.project_id
      and profile_id = v_uid
      and revoked_at is null
  ) then
    raise exception 'already_member';
  end if;

  -- Quota revérifié, CETTE invitation exclue du comptage (elle est en train
  -- d'être consommée, jamais comptée deux fois avec la nouvelle adhésion).
  v_cap := case
    when v_inv.role = 'CONTRACTOR' then 1
    when v_inv.role = 'OWNER' and v_inv.owner_profile = 'PRIMARY' then 1
    when v_inv.role = 'OWNER' and v_inv.owner_profile = 'CO_OWNER' then 2
    when v_inv.role = 'SITE_MANAGER' then 2
  end;

  select count(*) into v_count
  from (
    select 1
    from public.project_memberships pm
    where pm.project_id = v_inv.project_id
      and pm.revoked_at is null
      and pm.role = v_inv.role
      and pm.owner_profile is not distinct from v_inv.owner_profile
    union all
    select 1
    from public.invitations i
    join public.project_memberships pm2 on pm2.id = i.created_by_membership_id
    where i.project_id = v_inv.project_id
      and i.id <> v_inv.id
      and i.status = 'PENDING'
      and i.expires_at > now()
      and i.role = v_inv.role
      and i.owner_profile is not distinct from v_inv.owner_profile
      and pm2.revoked_at is null
      and pm2.authorization_revision = i.created_by_membership_revision
  ) v_reserved;

  if v_count >= v_cap then
    raise exception 'quota_exceeded';
  end if;

  -- INSERT puis UPDATE dans la MÊME transaction (fonction unique) : tout
  -- échec (y compris un index unique violé) annule les deux, le jeton
  -- n'est jamais consommé sans adhésion créée, et réciproquement.
  insert into public.project_memberships (project_id, profile_id, role, owner_profile)
  values (v_inv.project_id, v_uid, v_inv.role, v_inv.owner_profile)
  returning * into v_new_membership;

  update public.invitations
  set status = 'ACCEPTED', accepted_by_profile_id = v_uid, decided_at = now()
  where id = v_inv.id;

  return v_new_membership;
end;
$$;

revoke execute on function public.accept_invitation(text)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_invitation(text) to authenticated;

-- ----------------------------------------------------------------------------
-- refuse_invitation — aucun contrôle de validité de l'émetteur (le refus ne
-- crée rien) : ni verrou avisoire, ni verrou d'adhésion nécessaires, verrou
-- de la ligne invitations uniquement.
-- ----------------------------------------------------------------------------

create function public.refuse_invitation(p_token text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_hash bytea;
  v_inv public.invitations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception 'invitation_not_available';
  end if;

  v_hash := extensions.digest(p_token, 'sha256');

  select *
  into v_inv
  from public.invitations
  where token_hash = v_hash
  for update;

  -- clock_timestamp(), même correction que accept_invitation ci-dessus
  -- (corrigé après revue ZIP).
  if not found or v_inv.status <> 'PENDING' or v_inv.expires_at <= clock_timestamp() then
    raise exception 'invitation_not_available';
  end if;

  -- Cible : empêche un tiers en possession du lien de refuser à la place du
  -- destinataire réel. Lien partagé (target_kind null) : session
  -- authentifiée seule suffit, aucune identité supplémentaire à vérifier.
  if v_inv.target_kind is not null then
    if not exists (
      select 1 from public.profile_identifiers pi
      where pi.profile_id = v_uid
        and pi.kind = v_inv.target_kind
        and pi.value_normalized = v_inv.target_value_normalized
        and pi.verified_at_server is not null
        and pi.archived_at is null
    ) then
      raise exception 'target_not_controlled';
    end if;
  end if;

  update public.invitations
  set status = 'REFUSED', decided_at = now()
  where id = v_inv.id;
end;
$$;

revoke execute on function public.refuse_invitation(text)
  from public, anon, authenticated, service_role;
grant execute on function public.refuse_invitation(text) to authenticated;

-- ----------------------------------------------------------------------------
-- revoke_invitation — autorisation par le rôle habilitant ACTUEL de
-- l'appelant, jamais par l'identité de l'émetteur d'origine : fonctionne
-- même si created_by_membership_id est révoquée ou sa révision périmée.
-- ----------------------------------------------------------------------------

create function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek record;
  v_required record;
  v_membership_id uuid;
  v_inv public.invitations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_invitation_id is null then
    raise exception 'invitation_not_available';
  end if;

  -- Lecture non verrouillée : identifie chantier + rôle proposé, pour
  -- calculer le rôle habilitant et la clé du verrou avisoire.
  select project_id, role, owner_profile
  into v_peek
  from public.invitations
  where id = p_invitation_id;

  if not found then
    -- Harmonisé avec le "not_authorized" ci-dessous (corrigé après revue
    -- ZIP) : un UUID inexistant et une invitation existante hors périmètre
    -- de l'appelant doivent être RIGOUREUSEMENT indistinguables pour
    -- l'appelant, sinon le seul code d'erreur renvoyé permettrait de sonder
    -- l'existence d'un identifiant d'invitation sans y être habilité.
    raise exception 'not_authorized';
  end if;

  -- Ordre : 1) avisoire chantier, 2) adhésion habilitante ACTUELLE de
  -- l'appelant, 3) invitation.
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek.project_id::text)::bigint);

  v_required := public.invitation_required_emitter(v_peek.role, v_peek.owner_profile);

  select id into v_membership_id
  from public.project_memberships
  where project_id = v_peek.project_id
    and profile_id = v_uid
    and revoked_at is null
    and role = v_required.required_role
    and owner_profile is not distinct from v_required.required_owner_profile
  for update;

  if not found then
    -- Générique : ne révèle pas si l'invitation existe, son statut, ou si
    -- l'appelant serait autorisé pour un AUTRE rôle habilitant.
    raise exception 'not_authorized';
  end if;

  select *
  into v_inv
  from public.invitations
  where id = p_invitation_id
  for update;

  -- Alignement avec le contrat annoncé par list_manageable_invitations
  -- (revocable := PENDING ET non expirée) : un appel RPC direct ne doit pas
  -- pouvoir révoquer une invitation déjà expirée en pratique, même si l'UI
  -- masque déjà le bouton dans ce cas (corrigé après revue ZIP).
  -- clock_timestamp(), même raison que accept_invitation/refuse_invitation.
  if v_inv.status <> 'PENDING' or v_inv.expires_at <= clock_timestamp() then
    raise exception 'invitation_not_available';
  end if;

  update public.invitations
  set status = 'REVOKED', decided_at = now()
  where id = v_inv.id;
end;
$$;

revoke execute on function public.revoke_invitation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- list_manageable_invitations — lecture ciblée, SANS token_hash ni jeton.
-- ----------------------------------------------------------------------------

create type public.manageable_invitation as (
  id uuid,
  role public.membership_role,
  owner_profile public.owner_profile,
  target_kind public.identifier_kind,
  target_value_normalized text,
  status public.invitation_status,
  expires_at timestamptz,
  revocable boolean,
  created_at_server timestamptz
);

create function public.list_manageable_invitations(p_project_id uuid)
returns setof public.manageable_invitation
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_project_id is null then
    raise exception 'project_id_required';
  end if;

  -- Portée : invitations PENDING (lazy expiry incluse) du chantier, dont le
  -- rôle habilitant COURANT de l'appelant correspond — jamais l'historique
  -- déjà décidé (ACCEPTED/REFUSED/REVOKED), jamais élargi à tout membre
  -- actif du chantier. "revocable" distingue une PENDING encore
  -- révocable utilement d'une PENDING déjà expirée en pratique.
  return query
  select
    i.id,
    i.role,
    i.owner_profile,
    i.target_kind,
    i.target_value_normalized,
    i.status,
    i.expires_at,
    (i.status = 'PENDING' and i.expires_at > now()) as revocable,
    i.created_at_server
  from public.invitations i
  cross join lateral public.invitation_required_emitter(i.role, i.owner_profile) req
  where i.project_id = p_project_id
    and i.status = 'PENDING'
    and exists (
      select 1
      from public.project_memberships pm
      where pm.project_id = p_project_id
        and pm.profile_id = v_uid
        and pm.revoked_at is null
        and pm.role = req.required_role
        and pm.owner_profile is not distinct from req.required_owner_profile
    )
  order by i.created_at_server desc;
end;
$$;

revoke execute on function public.list_manageable_invitations(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_manageable_invitations(uuid) to authenticated;

commit;
