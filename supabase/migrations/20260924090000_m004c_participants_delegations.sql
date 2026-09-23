-- M004c — gestion des participants : retrait et délégations (B017)
-- Documentaire (comme M002a/M004a/M004b/M006a) : dépend de M004 (project_
-- memberships, membership_permissions) et M004a (has_project_permission),
-- ne modifie AUCUN fichier de migration déjà clôturé.
--
-- Correction post-revue ZIP (2026-09-24) : ce fichier portait initialement
-- l'identifiant documentaire "M007", qui désigne en réalité
-- "phase_templates template_items" dans MIGRATION_ORDER.csv (source de
-- vérité) — une désignation déjà réservée à un domaine sans rapport
-- (modèles de phases), jamais vérifiée avant ce tour. Renommé en M004c
-- (M004 porte déjà les extensions a et b : M004a rls_helper_functions,
-- M004b draft_project_provisioning ; ce fichier est la même famille —
-- project_memberships/membership_permissions, table T007 déclarée par M004
-- lui-même). Aucune migration CLÔTURÉE n'a été renumérotée : seul ce
-- fichier, non commité, a été corrigé avant toute clôture.
--
-- Périmètre de CE tour (B017) : remove_participant, grant_delegation,
-- revoke_delegation, list_project_delegations. Le transfert de rôle
-- principal (FR038/FR039, table role_transfers T009) reste B018, non
-- implémenté ici.
--
-- Arbitrages fondateur B017 (2026-09-24) :
--   - Matrice de retrait — DÉCISION MÉTIER (pas une règle sourcée dans les
--     CSV, qui ne précisent que l'acteur générique "OwnerPrimary|Contractor"
--     et une cible générique "non principal") :
--       OWNER/PRIMARY peut retirer un CO_OWNER, et RIEN d'autre.
--       CONTRACTOR peut retirer un SITE_MANAGER, et RIEN d'autre.
--       Aucun retrait croisé (OWNER/PRIMARY ne retire jamais un SITE_MANAGER,
--       CONTRACTOR ne retire jamais un CO_OWNER).
--       OWNER/PRIMARY et CONTRACTOR restent protégés dans les deux sens :
--       ni cible, ni acteur d'un retrait qui les viserait eux-mêmes (ROLES.csv:
--       CONTRACTOR n'a qu'un profil PRIMARY, "un seul entrepreneur principal
--       au MVP" ; GLOSSARY.csv G005/G007 ; BR023 "1 CONTRACTOR principal").
--   - removal_required_actor() : dérive le rôle habilitant requis pour
--     retirer un (role, owner_profile) donné. Retourne NULL pour toute
--     combinaison autre que OWNER/CO_OWNER ou SITE_MANAGER — un rôle
--     protégé (CONTRACTOR, OWNER/PRIMARY) ne peut donc JAMAIS matcher
--     aucun acteur, la protection est structurelle, pas un cas particulier
--     détecté et signalé à part (jamais de message distinct type
--     'protected_role' qui distinguerait ce cas d'un simple refus
--     générique — même philosophie que revoke_invitation, M006a).
--   - Délégations : couples et 4 codes STRICTEMENT réutilisés depuis M004
--     (delegation_couple() ci-dessous encode la MÊME matrice que
--     has_project_permission(), M004a — aucun nouveau droit, aucun quota de
--     délégation introduit).
--       CONTRACTOR -> SITE_MANAGER : PHASE_EDIT_DRAFT, EXPENSE_PUBLISH
--       OWNER/PRIMARY -> CO_OWNER : PHASE_VALIDATE, APPROVAL_DECIDE
--   - Octroi : autorisé au détenteur ACTUEL du droit natif correspondant
--     (CONTRACTOR ou OWNER/PRIMARY), jamais un droit fondé sur une valeur
--     passée. Bénéficiaire revérifié actif et du rôle attendu sous verrou.
--   - Révocation : autorisée au détenteur ACTUEL du rôle délégant
--     correspondant, PAS à granted_by — couvre le cas où le délégant
--     d'origine a changé de rôle ou a été révoqué (actuellement impossible à
--     déclencher : CONTRACTOR/OWNER-PRIMARY non remplaçables avant B018,
--     mais la fonction est conçue pour rester correcte quand B018 existera).
--     Le devenir des délégations après un changement de délégant (B018)
--     n'est PAS conçu ici — consigné pour B018, aucun transfert implémenté.
--   - Unicité "non révoquée" (membership_permissions_not_revoked_unique,
--     M004, INCHANGÉE) : une délégation expirée mais non révoquée bloque
--     toujours un nouvel octroi du même code au même bénéficiaire — décision
--     déjà actée, non rouverte. grant_delegation ne contourne rien : la
--     vérification préalable reproduit EXACTEMENT la condition de l'index
--     (revoked_at_server is null, SANS filtrer sur expires_at) et renvoie un
--     message dédié invitant à révoquer explicitement avant de réessayer.
--   - Retrait du bénéficiaire d'une délégation : AUCUNE révocation
--     automatique de ses lignes membership_permissions (ni transfert vers
--     une autre adhésion). Le droit effectif devient nul immédiatement par
--     construction : has_project_permission() (M004a) filtre déjà
--     `pm.revoked_at is null` sur l'adhésion bénéficiaire avant de consulter
--     membership_permissions — une délégation dont le bénéficiaire est
--     retiré ne peut plus jamais être consultée comme active par cette
--     fonction, sans qu'aucune ligne n'ait besoin d'être modifiée. La ligne
--     reste visible comme trace historique (BR028 : conserve l'audit et les
--     décisions passées) ; list_project_delegations() calcule un champ
--     "effective" distinct du seul revoked_at_server pour que l'interface ne
--     présente jamais une délégation inopérante comme utilisable.
--   - Ordre de verrouillage COMMUN avec M006/M006a, réutilisé à l'identique
--     (même clé avisoire 'invitation_quota:' || project_id — jamais
--     renommée : M006/M006a sont des migrations closes, renommer la chaîne
--     changerait le hash et romprait la sérialisation avec create_invitation/
--     accept_invitation/revoke_invitation) : avisoire chantier -> adhésion(s)
--     -> ligne mutée (project_memberships ou membership_permissions). Ce
--     verrou avisoire ne remplace AUCUN verrou de ligne : chaque fonction
--     verrouille et revérifie explicitement l'adhésion de l'acteur, puis
--     celle du bénéficiaire/cible, puis la ligne mutée elle-même. Verrouiller
--     DEUX lignes project_memberships (acteur et cible) dans la même
--     fonction est sans risque d'interblocage ICI précisément parce que
--     l'avisoire par chantier est acquis AVANT tout verrou de ligne et
--     sérialise déjà entièrement les mutations de ce chantier (invitations
--     ET participants ET délégations) à une seule transaction en vol à la
--     fois — aucune autre fonction (M006/M006a incluses) ne verrouille de
--     ligne avant cet avisoire, donc aucun ordre concurrent inverse n'est
--     jamais possible sur le même chantier.
--   - Compte vérifié obligatoire pour les TROIS mutations (remove_participant,
--     grant_delegation, revoke_delegation), appliqué ICI côté SQL
--     (is_account_provisional()) ET dans les Server Actions correspondantes
--     (requireVerifiedAccount()) — même double couche que B014/B015/B016.
--   - Audit : chaque mutation insère une ligne audit_events (M005, jamais
--     encore écrite par aucun RPC avant ce tour) DANS LA MÊME FONCTION que la
--     mutation elle-même — un échec de l'INSERT audit (ex. contrainte
--     violée) annule la mutation entière (fonction unique, transaction
--     unique, même principe que l'atomicité insert+update prouvée sur
--     accept_invitation, M006a). Pour le retrait, le motif (reason) est
--     OBLIGATOIRE et fourni par l'utilisateur, jamais vide. Pour les
--     délégations, le motif est un texte TECHNIQUE généré par la fonction
--     elle-même (quel code, par qui, pour qui) — jamais une justification
--     utilisateur inventée, aucun champ de saisie de motif proposé côté
--     octroi/révocation de délégation.
--
-- Corrections post-revue ZIP (2026-09-24) :
--   - remove_participant : l'autorisation s'appuyait sur role/owner_profile
--     lus AVANT tout verrou (peek), le verrou de la cible ne revérifiant
--     ensuite que id/revoked_at. Une modification committée pendant
--     l'attente du verrou (hypothétique, aucun mécanisme ne le permet avant
--     B018, non construit ici) aurait donc pu échapper au contrôle. Corrigé :
--     le peek non verrouillé ne sert plus qu'à résoudre le chantier (clé de
--     l'avisoire) ; project_id/role/owner_profile de la cible sont
--     désormais relus et revérifiés SOUS VERROU juste avant toute mutation,
--     et c'est cette lecture verrouillée — jamais le peek — qui alimente
--     removal_required_actor().
--   - list_project_delegations : "effective" vérifiait l'expiration, la
--     révocation et l'adhésion active du bénéficiaire, mais pas la
--     compatibilité de son rôle ACTUEL avec permission_code. Ajout de
--     delegation_couple() en jointure latérale pour revérifier
--     (beneficiary_role, beneficiary_owner_profile) — reproduit EXACTEMENT
--     la même matrice que has_project_permission() (M004a), sans construire
--     aucun mécanisme de transfert (B018 reste non implémenté).

begin;

-- ----------------------------------------------------------------------------
-- removal_required_actor — dérive le rôle habilitant requis pour retirer un
-- participant de (role, owner_profile) donné. NULL pour toute combinaison
-- non couverte (CONTRACTOR, OWNER/PRIMARY) : protection structurelle, jamais
-- un cas signalé à part.
-- ----------------------------------------------------------------------------

create function public.removal_required_actor(
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
  if p_role = 'OWNER' and p_owner_profile = 'CO_OWNER' then
    required_role := 'OWNER';
    required_owner_profile := 'PRIMARY';
  elsif p_role = 'SITE_MANAGER' then
    required_role := 'CONTRACTOR';
    required_owner_profile := null;
  else
    -- CONTRACTOR ou OWNER/PRIMARY (ou toute autre combinaison future) :
    -- jamais retirables par ce lot. NULL ne matche jamais un rôle réel.
    required_role := null;
    required_owner_profile := null;
  end if;
end;
$$;

revoke execute on function public.removal_required_actor(public.membership_role, public.owner_profile)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- delegation_couple — dérive le couple délégant/bénéficiaire attendu pour un
-- code de délégation donné. Reproduit EXACTEMENT la matrice déjà encodée
-- dans has_project_permission() (M004a) : aucune divergence tolérée entre
-- lecture (M004a) et écriture (ce fichier).
-- ----------------------------------------------------------------------------

create function public.delegation_couple(
  p_permission_code text,
  out delegant_role public.membership_role,
  out delegant_owner_profile public.owner_profile,
  out beneficiary_role public.membership_role,
  out beneficiary_owner_profile public.owner_profile
)
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH') then
    delegant_role := 'CONTRACTOR';
    delegant_owner_profile := null;
    beneficiary_role := 'SITE_MANAGER';
    beneficiary_owner_profile := null;
  elsif p_permission_code in ('PHASE_VALIDATE', 'APPROVAL_DECIDE') then
    delegant_role := 'OWNER';
    delegant_owner_profile := 'PRIMARY';
    beneficiary_role := 'OWNER';
    beneficiary_owner_profile := 'CO_OWNER';
  else
    raise exception 'invalid_permission_code';
  end if;
end;
$$;

revoke execute on function public.delegation_couple(text)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- remove_participant — retrait d'un participant non principal. Adhésion
-- révoquée uniquement (revoked_at), jamais de DELETE : profil, contributions,
-- invitations émises et délégations passées restent intacts (BR028/FR040).
-- Ordre : 1) avisoire chantier, 2) adhésion de l'acteur, 3) adhésion cible.
-- ----------------------------------------------------------------------------

create function public.remove_participant(p_membership_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek record;
  v_actor record;
  v_target record;
  v_required record;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required';
  end if;

  if p_membership_id is null then
    raise exception 'not_authorized';
  end if;

  -- Lecture NON verrouillée : sert UNIQUEMENT à résoudre le chantier (clé de
  -- l'avisoire). Ni role ni owner_profile ne sont lus ici — la décision
  -- d'autorisation ne doit jamais s'appuyer sur une valeur non verrouillée.
  -- Corrigé après revue ZIP (2026-09-24) : la version précédente lisait
  -- role/owner_profile dans ce même peek et calculait l'autorisation AVANT
  -- le verrou de la cible, laissant une fenêtre où un changement de rôle
  -- committé pendant l'attente du verrou (hypothétique, aucun mécanisme ne
  -- le permet avant B018, non construit ici) aurait pu être ignoré.
  select project_id
  into v_peek
  from public.project_memberships
  where id = p_membership_id;

  if not found then
    -- Harmonisé avec le refus d'autorisation ci-dessous (même philosophie
    -- que revoke_invitation, M006a) : un UUID inexistant et une cible hors
    -- périmètre de l'acteur doivent être indistinguables.
    raise exception 'not_authorized';
  end if;

  -- Ordre : 1) avisoire chantier (clé partagée avec M006/M006a, jamais
  -- renommée), 2) adhésion de l'acteur, 3) adhésion cible.
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek.project_id::text)::bigint);

  select id, role, owner_profile, revoked_at
  into v_actor
  from public.project_memberships
  where project_id = v_peek.project_id
    and profile_id = v_uid
    and revoked_at is null
  for update;

  if not found then
    raise exception 'not_authorized';
  end if;

  -- Relit et reverrouille la cible EN DERNIER (ordre inchangé), mais c'est
  -- désormais cette lecture verrouillée — jamais le peek initial — qui
  -- fournit project_id/role/owner_profile pour la décision d'autorisation.
  select id, project_id, role, owner_profile, revoked_at
  into v_target
  from public.project_memberships
  where id = p_membership_id
  for update;

  -- Défense en profondeur : le chantier ne peut pas changer (aucune
  -- opération ne le permet), mais on ne suppose jamais le peek non verrouillé
  -- encore valide sans le revérifier explicitement.
  if v_target.project_id <> v_peek.project_id then
    raise exception 'not_authorized';
  end if;

  -- Rôle habilitant requis pour retirer CE couple, calculé à partir de la
  -- lecture VERROUILLÉE (jamais du peek) — reflète l'état réel au moment de
  -- la mutation, y compris si le rôle a changé pendant l'attente du verrou.
  -- NULL pour CONTRACTOR/OWNER-PRIMARY (protection structurelle).
  v_required := public.removal_required_actor(v_target.role, v_target.owner_profile);

  if v_required.required_role is null
     or v_actor.role <> v_required.required_role
     or v_actor.owner_profile is distinct from v_required.required_owner_profile
  then
    raise exception 'not_authorized';
  end if;

  -- L'acteur est PROUVÉ habilité pour ce couple (role, owner_profile) —
  -- une réponse plus précise que 'not_authorized' est désormais sans risque
  -- de fuite d'existence/autorisation pour un tiers non habilité.
  if v_target.revoked_at is not null then
    raise exception 'participant_already_removed';
  end if;

  update public.project_memberships
  set revoked_at = now()
  where id = v_target.id;

  -- Motif utilisateur obligatoire (déjà validé non vide ci-dessus), même
  -- transaction que la révocation : un échec ici annule tout (fonction
  -- unique, aucun COMMIT intermédiaire).
  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
  )
  values (
    v_peek.project_id, 'HUMAN', v_uid, 'PARTICIPANT_REMOVED', 'project_memberships', v_target.id, 'SUCCESS', p_reason
  );
end;
$$;

revoke execute on function public.remove_participant(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.remove_participant(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- grant_delegation — octroi d'une délégation par le détenteur ACTUEL du
-- droit natif correspondant. Ordre : 1) avisoire chantier, 2) adhésion de
-- l'acteur (délégant), 3) adhésion bénéficiaire, 4) vérification de
-- l'unicité "non révoquée" (INCHANGÉE, M004).
-- ----------------------------------------------------------------------------

create function public.grant_delegation(p_project_membership_id uuid, p_permission_code text)
returns public.membership_permissions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_couple record;
  v_peek record;
  v_actor record;
  v_target record;
  v_existing_id uuid;
  v_new public.membership_permissions;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_project_membership_id is null then
    raise exception 'not_authorized';
  end if;

  -- Valide le code AVANT toute lecture : un code hors des 4 valeurs
  -- n'entraîne jamais de verrou ni de fuite d'information sur une cible.
  v_couple := public.delegation_couple(p_permission_code);

  select project_id, role, owner_profile
  into v_peek
  from public.project_memberships
  where id = p_project_membership_id;

  if not found then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek.project_id::text)::bigint);

  select id, role, owner_profile, revoked_at
  into v_actor
  from public.project_memberships
  where project_id = v_peek.project_id
    and profile_id = v_uid
    and revoked_at is null
  for update;

  if not found
     or v_actor.role <> v_couple.delegant_role
     or v_actor.owner_profile is distinct from v_couple.delegant_owner_profile
  then
    raise exception 'not_authorized';
  end if;

  select id, role, owner_profile, revoked_at
  into v_target
  from public.project_memberships
  where id = p_project_membership_id
  for update;

  if v_target.revoked_at is not null
     or v_target.role <> v_couple.beneficiary_role
     or v_target.owner_profile is distinct from v_couple.beneficiary_owner_profile
  then
    raise exception 'beneficiary_not_eligible';
  end if;

  -- Reproduit EXACTEMENT la condition de l'index unique partiel
  -- (membership_permissions_not_revoked_unique, M004, INCHANGÉ) : une
  -- délégation expirée mais non révoquée bloque toujours un nouvel octroi —
  -- décision déjà actée, jamais contournée ici.
  select id into v_existing_id
  from public.membership_permissions
  where project_membership_id = v_target.id
    and permission_code = p_permission_code
    and revoked_at_server is null
  for update;

  if found then
    raise exception 'active_delegation_exists';
  end if;

  insert into public.membership_permissions (
    project_id, project_membership_id, permission_code, granted_by
  )
  values (
    v_peek.project_id, v_target.id, p_permission_code, v_uid
  )
  returning * into v_new;

  -- Motif TECHNIQUE généré ici, jamais une justification utilisateur
  -- inventée : décrit l'action, pas une intention.
  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
  )
  values (
    v_peek.project_id, 'HUMAN', v_uid, 'DELEGATION_GRANTED', 'membership_permissions', v_new.id, 'SUCCESS',
    format('Délégation %s accordée par %s à l''adhésion %s', p_permission_code, v_couple.delegant_role, v_target.id)
  );

  return v_new;
end;
$$;

revoke execute on function public.grant_delegation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.grant_delegation(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- revoke_delegation — révocation par le détenteur ACTUEL du rôle délégant,
-- jamais par identité (granted_by) : couvre un délégant d'origine remplacé,
-- bien qu'aucun mécanisme actuel ne permette encore de remplacer CONTRACTOR
-- ou OWNER/PRIMARY (B018, non implémenté). Ordre : 1) avisoire chantier,
-- 2) adhésion de l'acteur, 3) ligne de délégation ciblée.
-- ----------------------------------------------------------------------------

create function public.revoke_delegation(p_delegation_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek record;
  v_couple record;
  v_actor record;
  v_deleg record;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_delegation_id is null then
    raise exception 'not_authorized';
  end if;

  select project_id, permission_code
  into v_peek
  from public.membership_permissions
  where id = p_delegation_id;

  if not found then
    raise exception 'not_authorized';
  end if;

  v_couple := public.delegation_couple(v_peek.permission_code);

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek.project_id::text)::bigint);

  select id, role, owner_profile, revoked_at
  into v_actor
  from public.project_memberships
  where project_id = v_peek.project_id
    and profile_id = v_uid
    and revoked_at is null
  for update;

  if not found
     or v_actor.role <> v_couple.delegant_role
     or v_actor.owner_profile is distinct from v_couple.delegant_owner_profile
  then
    raise exception 'not_authorized';
  end if;

  select id, revoked_at_server
  into v_deleg
  from public.membership_permissions
  where id = p_delegation_id
  for update;

  if v_deleg.revoked_at_server is not null then
    raise exception 'delegation_already_revoked';
  end if;

  update public.membership_permissions
  set revoked_at_server = now(), revoked_by = v_uid
  where id = v_deleg.id;

  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
  )
  values (
    v_peek.project_id, 'HUMAN', v_uid, 'DELEGATION_REVOKED', 'membership_permissions', v_deleg.id, 'SUCCESS',
    format('Délégation %s révoquée par %s (rôle habilitant courant, indépendant de granted_by)', v_peek.permission_code, v_couple.delegant_role)
  );
end;
$$;

revoke execute on function public.revoke_delegation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_delegation(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- list_project_delegations — lecture pour l'interface équipe : calcule
-- "effective" (jamais déduit du seul revoked_at_server) pour ne jamais
-- présenter une délégation inopérante comme un droit utilisable, y compris
-- lorsque le bénéficiaire a été retiré (aucune ligne membership_permissions
-- n'est modifiée par un retrait — voir remove_participant ci-dessus).
--
-- Correction post-revue ZIP (2026-09-24) : "effective" vérifiait l'expiration,
-- la révocation et l'adhésion active, mais pas la compatibilité du rôle
-- ACTUEL du bénéficiaire avec permission_code — un rôle changé sur la même
-- adhésion (hypothétique, aucun mécanisme ne le permet avant B018, non
-- construit ici) pouvait laisser "effective" à true alors que
-- has_project_permission() aurait déjà refusé le droit. Ajout de
-- delegation_couple() en latéral pour revérifier (beneficiary_role,
-- beneficiary_owner_profile) — reproduit EXACTEMENT la même matrice que
-- has_project_permission() (M004a), aucune nouvelle règle.
-- ----------------------------------------------------------------------------

create type public.project_delegation as (
  id uuid,
  permission_code text,
  project_membership_id uuid,
  beneficiary_role public.membership_role,
  beneficiary_owner_profile public.owner_profile,
  beneficiary_active boolean,
  granted_at_server timestamptz,
  expires_at timestamptz,
  revoked_at_server timestamptz,
  effective boolean
);

create function public.list_project_delegations(p_project_id uuid)
returns setof public.project_delegation
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

  -- Même périmètre que la policy RLS existante (membership_permissions_
  -- select_active_member, M004) : tout membre actif du chantier peut
  -- consulter l'ensemble des délégations — jamais élargi, jamais restreint.
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  return query
  select
    mp.id,
    mp.permission_code,
    mp.project_membership_id,
    pm.role,
    pm.owner_profile,
    (pm.revoked_at is null) as beneficiary_active,
    mp.granted_at_server,
    mp.expires_at,
    mp.revoked_at_server,
    (
      mp.revoked_at_server is null
      and (mp.expires_at is null or mp.expires_at > now())
      and pm.revoked_at is null
      and pm.role = couple.beneficiary_role
      and pm.owner_profile is not distinct from couple.beneficiary_owner_profile
    ) as effective
  from public.membership_permissions mp
  join public.project_memberships pm on pm.id = mp.project_membership_id
  cross join lateral public.delegation_couple(mp.permission_code) as couple
  where mp.project_id = p_project_id
  order by mp.granted_at_server desc;
end;
$$;

revoke execute on function public.list_project_delegations(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_project_delegations(uuid) to authenticated;

commit;
