-- M006b — transfert d'un rôle principal (B018)
-- Documentaire (comme M002a/M004a/M004b/M004c/M006a) : dépend de M004
-- (project_memberships, authorization_revision ajoutée par M006/B015 — PAS
-- M004a), M004a (is_active_project_member), M004c (aucune dépendance de
-- fonction directe, mais même domaine "access" que M006/M006a). Ne modifie
-- AUCUN fichier de migration déjà clôturé.
--
-- Désignation : MIGRATION_ORDER.csv range role_transfers (T009) dans la
-- MÊME ligne que M006 ("invitations role_transfers support_grants"),
-- domaine DATA_MODEL.yaml "access" (invitations, role_transfers,
-- support_access_grants) — jamais M004 (domaine "tenancy"). M006 porte déjà
-- l'extension M006a (invitation_decisions) ; ce fichier est la même
-- famille, d'où M006b. Aucune migration CLÔTURÉE renumérotée.
--
-- Périmètre de CE tour (B018, FR038/FR039) : request_role_transfer,
-- cancel_role_transfer, confirm_role_transfer, refuse_role_transfer,
-- transfer_contractor_role, list_role_transfers. CURRENT_PRIMARY
-- UNIQUEMENT : RECOVERY_SUPPORT, support_access_grants et has_support_scope
-- (API_CONTRACTS.csv API019 mentionne aussi RECOVERY_SUPPORT) restent
-- EXPLICITEMENT différés à un lot séparé (BR029 : "récupération support
-- séparée"), jamais présentés comme livrés ici.
--
-- Arbitrages fondateur B018 (2026-09-25) :
--   - Ancien titulaire : reste membre actif, jamais retiré. OWNER/PRIMARY ->
--     CO_OWNER ; CONTRACTOR -> SITE_MANAGER (role_transfer_couple ci-dessous,
--     seule source de cette matrice, réutilisée par les 3 fonctions qui
--     exécutent une bascule).
--   - Successeur : DOIT être une adhésion ACTIVE du même chantier, déjà
--     CO_OWNER (pour devenir OWNER/PRIMARY) ou SITE_MANAGER (pour devenir
--     CONTRACTOR). Aucun profil externe (aucune création d'adhésion ici,
--     contrairement à accept_invitation), aucune auto-désignation (le
--     successeur ne peut jamais être l'appelant lui-même).
--   - OWNER (FR038, AC038 "double confirmation réussit") : demande explicite
--     de l'initiateur (request_role_transfer, AUCUNE écriture sur
--     project_memberships), puis confirmation EXPLICITE du successeur
--     (confirm_role_transfer, seule fonction qui bascule réellement les
--     rôles). Le titulaire actuel conserve seul ses droits jusqu'à cette
--     bascule atomique — aucun double PRIMARY possible, y compris pendant
--     l'attente (index uniques project_memberships_primary_owner_unique /
--     _contractor_unique, M004/M006, non déferrables : la démotion de
--     l'ancien titulaire est TOUJOURS écrite avant la promotion du
--     successeur dans confirm_role_transfer/transfer_contractor_role,
--     jamais l'inverse, sous peine de violation immédiate de ces index).
--   - CONTRACTOR (FR039, AC039 "sans période de double contrôle") :
--     transfert IMMÉDIAT par le titulaire actuel (transfer_contractor_role),
--     une seule fonction, une seule transaction, aucune phase PENDING.
--     Journalisé malgré tout dans role_transfers avec un statut directement
--     terminal (CONFIRMED), pour un historique unique et cohérent avec le
--     parcours OWNER (T009 "workflow append-only").
--   - Expiration de la demande OWNER : 72 heures (délibérément plus courte
--     que les 7 jours des invitations — enjeu de sécurité plus élevé,
--     retenu faute de valeur sourcée dans les CSV).
--   - Comptes vérifiés : is_account_provisional() (M002a) ne couvre que
--     l'APPELANT. Le second profil (successeur à la demande, initiateur à
--     la confirmation) est vérifié par is_profile_verified(p_profile_id)
--     ci-dessous — une fonction INTERNE (jamais GRANT à authenticated/anon,
--     même régime que removal_required_actor/delegation_couple, M004c),
--     qui reproduit EXACTEMENT la même requête que is_account_provisional()
--     mais paramétrée par profil. Aucun nouveau RPC public exposé, aucune
--     preuve booléenne acceptée d'un client : la vérification est toujours
--     recalculée côté serveur à partir de profile_identifiers.
--   - proof (API_CONTRACTS.csv API019) : NE désigne PAS ici une
--     ré-authentification distincte. Retenu pour ce périmètre : session
--     Auth validée (auth.uid() non nul) + compte vérifié
--     (is_account_provisional()) + action explicite (appel du RPC dédié
--     avec un motif non vide) — strictement la même triple exigence que
--     toutes les autres mutations sensibles de M004c/M006a. Aucun paramètre
--     "proof" séparé n'est ajouté aux fonctions ci-dessous ; si un contrat
--     documentaire différent est requis, une clause écrite distincte devra
--     d'abord corriger API_CONTRACTS.csv avant toute implémentation.
--   - Délégations incompatibles (membership_permissions), catégorisation
--     EXACTE, aucune supposée :
--       * Reçues par le SUCCESSEUR (n'importe quel code, revoked_at_server
--         IS NULL, MÊME EXPIRÉES) : révoquées EXPLICITEMENT dans la MÊME
--         transaction que la bascule — son nouveau rôle (PRIMARY/CONTRACTOR)
--         n'est plus jamais un bénéficiaire éligible pour aucun des 4 codes.
--       * Accordées PAR l'ancien titulaire à des TIERS (pas le successeur) :
--         MAINTENUES sans modification — effective/revoke_delegation (M004c)
--         ne dépendent jamais de granted_by, seulement du rôle ACTUEL du
--         bénéficiaire ; le nouveau titulaire hérite simplement de
--         l'autorité de révocation à partir de maintenant.
--       * Reçues par l'ANCIEN titulaire après démotion : structurellement
--         impossible avant cette transaction (PRIMARY/CONTRACTOR ne sont
--         jamais des bénéficiaires éligibles, delegation_couple/M004c) —
--         rien à réconcilier, et cette transaction ne lui accorde jamais
--         aucun droit délégué automatiquement.
--     Historique préservé : uniquement des UPDATE revoked_at_server/
--     revoked_by, jamais de DELETE (même régime que M004c).
--   - Expiration mesurée avec clock_timestamp() (heure réelle au moment du
--     contrôle), JAMAIS now() (figée au début de transaction) — leçon B016
--     (accept_invitation/refuse_invitation, M006a) réappliquée ici pour
--     request_role_transfer, cancel_role_transfer, confirm_role_transfer et
--     refuse_role_transfer.
--   - Unicité des demandes PENDING (role_transfers_pending_unique,
--     (project_id, role) WHERE status = 'PENDING') SANS blocage indéfini :
--     request_role_transfer revérifie, SOUS LE MÊME VERROU CHANTIER, la
--     VALIDITÉ EFFECTIVE de toute demande PENDING existante — jamais son
--     seul statut stocké — avant d'en créer une nouvelle. Si elle est
--     réellement expirée ou invalidée (révision d'autorisation divergente
--     sur l'une des deux adhésions), elle est fermée (EXPIRED/INVALIDATED)
--     DANS LA MÊME transaction qui insère ensuite la nouvelle demande —
--     jamais un UPDATE de clôture suivi d'une exception qui l'annulerait.
--     À l'inverse, cancel_role_transfer/confirm_role_transfer/
--     refuse_role_transfer ne tentent JAMAIS de fermer une demande devenue
--     invalide qu'elles rejettent : re-persister ce constat exigerait un
--     UPDATE puis un raise exception, ce qui annulerait ce même UPDATE
--     (fonction = transaction unique). Ces trois fonctions se contentent de
--     refuser (transfer_request_expired/transfer_request_invalidated) sans
--     modifier la ligne ; sa fermeture effective attend soit une nouvelle
--     demande (ci-dessus), soit reste simplement sans conséquence tant que
--     list_role_transfers calcule sa propre validité effective (is_pending)
--     de façon indépendante du statut stocké — même philosophie que
--     "effective" dans list_project_delegations (M004c).
--   - Verrouillage : MÊME clé avisoire 'invitation_quota:' || project_id que
--     M006/M006a/M004c (jamais renommée, ces migrations sont closes) —
--     acquise AVANT tout verrou de ligne, sérialise déjà entièrement les
--     mutations de composition de CE chantier (invitations, participants,
--     délégations ET désormais transferts) ENTRE ELLES. Verrouiller DEUX
--     lignes project_memberships (initiateur et successeur) dans confirm_
--     role_transfers/transfer_contractor_role est sans risque d'interblocage
--     pour la même raison que M004c (remove_participant) : aucune fonction
--     de CETTE FAMILLE ne verrouille de ligne avant cet avisoire.
--     CORRIGÉ (revue ZIP 2026-09-24, puis re-corrigé 2026-09-25 : la clé
--     avisoire 'org_provisioning' avait été attribuée à la mauvaise
--     fonction) : B014/M004b expose DEUX fonctions distinctes —
--     create_draft_project prend l'avisoire 'org_provisioning:' || profil
--     (résolution/création d'organisation) mais NE verrouille JAMAIS
--     project_memberships (simple INSERT, sans lecture verrouillée
--     préalable) ; update_draft_project, à l'inverse, verrouille
--     project_memberships FOR UPDATE (adhésion de l'appelant) mais NE PREND
--     AUCUN avisoire — ni 'org_provisioning', ni 'invitation_quota', ni
--     aucun autre. Une affirmation antérieure erronée disait update_draft_
--     project "sans rapport" avec la composition d'un chantier ; en réalité
--     elle peut retenir un verrou de ligne sur project_memberships PENDANT
--     que ce fichier tient déjà l'avisoire 'invitation_quota' du même
--     chantier (aucun interblocage — ordres non contradictoires — mais une
--     attente réelle possible, non synchronisée par aucun avisoire commun).
--     C'est précisément pourquoi clock_timestamp() et la revérification des
--     deux comptes sont désormais posés APRÈS les verrous de ligne sur les
--     deux adhésions, jamais avant (voir confirm_role_transfer).
--   - Quotas sur l'état FINAL : project_memberships_primary_owner_unique et
--     ..._contractor_unique (index uniques déclaratifs, M004/M006)
--     protègent déjà l'unicité PRIMARY/CONTRACTOR de façon atomique — la
--     démotion doit précéder la promotion dans la même transaction, jamais
--     l'inverse. co_owners_max(2)/site_managers_max(2) (DATA_MODEL.yaml,
--     quotas non déclaratifs, contrôlés seulement à l'émission d'invitation)
--     restent structurellement inchangés par un transfert : AUCUNE nouvelle
--     adhésion n'est créée ici, le successeur QUITTE le vivier CO_OWNER/
--     SITE_MANAGER exactement quand l'ancien titulaire y ENTRE — delta net
--     nul, par construction, sans nécessiter de comptage supplémentaire.
--
-- Corrections post-revue ZIP (2026-09-24) :
--   1. confirm_role_transfer vérifiait statut/expiration AVANT de verrouiller
--      les deux adhésions (initiateur, successeur) — une attente réelle sur
--      CES lignes (ex. update_draft_project/M004b, verrou de ligne hors de
--      l'avisoire 'invitation_quota', voir ci-dessus) pouvait dépasser
--      expires_at sans que clock_timestamp() ne le voie. Ordre corrigé :
--      avisoire chantier -> adhésion successeur (verrou + identité de
--      l'appelant) -> adhésion initiatrice -> demande (role_transfers) ->
--      clock_timestamp()/contrôle d'expiration -> revérifications ->
--      bascule. Testé par une attente réelle sur un verrou de ligne
--      (deuxième session, hors avisoire) recouvrant l'expiration.
--   2. Les deux comptes (is_profile_verified) n'étaient revérifiés qu'à
--      l'entrée de request_role_transfer/transfer_contractor_role (l'appelant
--      seul) et pour l'initiateur seulement dans confirm_role_transfer, tous
--      AVANT les attentes de verrouillage. Une perte de vérification
--      committée PENDANT cette attente (identifiant archivé sur une autre
--      session) restait invisible. Corrigé : les trois fonctions
--      revérifient désormais les comptes concernés (les deux dans confirm_
--      role_transfer ; l'initiateur en plus du successeur dans request_
--      role_transfer/transfer_contractor_role) APRÈS tous leurs verrous de
--      ligne, jamais avant. Testé par une perte de vérification committée
--      par une session tierce pendant l'attente d'un verrou de ligne tenu
--      par une deuxième session.
--   3. Rafraîchissement applicatif après succès (equipe/page.tsx et les 3
--      nouveaux composants) : ajout d'un router.refresh() déclenché après
--      toute soumission réussie (état "pending" retombé à faux sans erreur),
--      vérifié réellement sur les deux parcours navigateur sans rechargement
--      manuel.
--   4. Catalogue de sécurité complété (preuves/06_securite_catalogue.md) :
--      propriétaire/SECURITY DEFINER-INVOKER/search_path/ACL vérifiés par
--      requête catalogue réelle sur les 8 fonctions et 2 types de ce fichier,
--      écritures directes sur role_transfers refusées (RLS + REVOKE ALL),
--      lecture/mutation inter-chantiers refusées par appel RPC réel.
--   5. L'audit ROLE_TRANSFER_CONFIRMED ne consignait pas les délégations
--      révoquées automatiquement. Ajout d'un champ context (jsonb) listant
--      id/permission_code de chaque délégation révoquée (RETURNING sur
--      l'UPDATE membership_permissions, même transaction) — un échec de
--      l'INSERT audit annule toujours la bascule des DEUX rôles ET ces
--      révocations (revérifié par échec d'audit forcé).
--
begin;

-- ----------------------------------------------------------------------------
-- role_transfer_status — cycle de vie append-only (DATABASE_TABLES.csv T009).
-- ----------------------------------------------------------------------------

create type public.role_transfer_status as enum (
  'PENDING', 'CONFIRMED', 'REFUSED', 'CANCELLED', 'EXPIRED', 'INVALIDATED'
);

-- ----------------------------------------------------------------------------
-- role_transfers (DATABASE_TABLES.csv T009).
-- ----------------------------------------------------------------------------

create table public.role_transfers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  role public.membership_role not null,
  status public.role_transfer_status not null default 'PENDING',
  initiator_membership_id uuid not null,
  successor_membership_id uuid not null,
  -- Capture de authorization_revision (M006/B015) des DEUX adhésions au
  -- moment de la demande (ou de l'exécution immédiate CONTRACTOR) : toute
  -- divergence ultérieure invalide définitivement la confirmation — même
  -- principe que created_by_membership_revision (invitations, M006).
  initiator_membership_revision bigint not null,
  successor_membership_revision bigint not null,
  requested_at_server timestamptz not null default now(),
  -- NULL pour CONTRACTOR (transfert immédiat, aucune phase PENDING) ;
  -- obligatoire pour OWNER (fenêtre de 72h, role_transfers_expiry_scope).
  expires_at timestamptz null,
  decided_at_server timestamptz null,
  -- NULL pour une clôture SYSTÈME (EXPIRED/INVALIDATED lors d'une nouvelle
  -- demande) : aucun acteur humain ne décide cette transition.
  decided_by_profile_id uuid null references public.profiles (id) on delete restrict,
  request_reason text not null,
  decision_reason text null,
  constraint role_transfers_role_scope check (role in ('OWNER', 'CONTRACTOR')),
  constraint role_transfers_distinct_parties check (initiator_membership_id <> successor_membership_id),
  constraint role_transfers_expiry_scope check (
    (role = 'OWNER' and expires_at is not null)
    or (role = 'CONTRACTOR' and expires_at is null)
  ),
  constraint role_transfers_decided_consistency check (
    (status = 'PENDING') = (decided_at_server is null)
  ),
  -- Intégrité chantier des deux adhésions référencées (même pattern que
  -- membership_permissions/invitations, M004/M006).
  foreign key (initiator_membership_id, project_id)
    references public.project_memberships (id, project_id),
  foreign key (successor_membership_id, project_id)
    references public.project_memberships (id, project_id)
);

create index role_transfers_project_status_idx on public.role_transfers (project_id, status);
create index role_transfers_initiator_membership_id_idx on public.role_transfers (initiator_membership_id);
create index role_transfers_successor_membership_id_idx on public.role_transfers (successor_membership_id);

-- Au plus une demande PENDING par (chantier, rôle) — voir note "Unicité des
-- demandes PENDING" ci-dessus pour la clôture non bloquante.
create unique index role_transfers_pending_unique
  on public.role_transfers (project_id, role)
  where status = 'PENDING';

-- ----------------------------------------------------------------------------
-- role_transfer_couple — SEULE source de la matrice de transfert (rôles
-- attendus pour initiateur/successeur AVANT bascule, et rôles finaux
-- APRÈS). Réutilisée à l'identique par request_role_transfer, confirm_
-- role_transfer et transfer_contractor_role : aucune divergence tolérée.
-- ----------------------------------------------------------------------------

create function public.role_transfer_couple(
  p_role public.membership_role,
  out initiator_role public.membership_role,
  out initiator_owner_profile public.owner_profile,
  out successor_role public.membership_role,
  out successor_owner_profile public.owner_profile,
  out final_initiator_role public.membership_role,
  out final_initiator_owner_profile public.owner_profile,
  out final_successor_role public.membership_role,
  out final_successor_owner_profile public.owner_profile
)
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_role = 'OWNER' then
    initiator_role := 'OWNER';
    initiator_owner_profile := 'PRIMARY';
    successor_role := 'OWNER';
    successor_owner_profile := 'CO_OWNER';
    final_initiator_role := 'OWNER';
    final_initiator_owner_profile := 'CO_OWNER';
    final_successor_role := 'OWNER';
    final_successor_owner_profile := 'PRIMARY';
  elsif p_role = 'CONTRACTOR' then
    initiator_role := 'CONTRACTOR';
    initiator_owner_profile := null;
    successor_role := 'SITE_MANAGER';
    successor_owner_profile := null;
    final_initiator_role := 'SITE_MANAGER';
    final_initiator_owner_profile := null;
    final_successor_role := 'CONTRACTOR';
    final_successor_owner_profile := null;
  else
    raise exception 'invalid_transfer_role';
  end if;
end;
$$;

revoke execute on function public.role_transfer_couple(public.membership_role)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- is_profile_verified — équivalent de is_account_provisional() (M002a) pour
-- un profil AUTRE que l'appelant. JAMAIS GRANT à authenticated/anon (même
-- régime que removal_required_actor/delegation_couple, M004c) : aucun
-- nouveau RPC public, aucune preuve booléenne acceptée d'un client — la
-- vérification est toujours recalculée ici à partir de profile_identifiers.
-- ----------------------------------------------------------------------------

create function public.is_profile_verified(p_profile_id uuid)
returns boolean
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_profile_id is null then
    return false;
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    return false;
  end if;

  return exists (
    select 1
    from public.profile_identifiers pi
    where pi.profile_id = p_profile_id
      and pi.verified_at_server is not null
      and pi.archived_at is null
  );
end;
$$;

revoke execute on function public.is_profile_verified(uuid)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- request_role_transfer — OWNER UNIQUEMENT (CONTRACTOR n'a pas de phase
-- PENDING, voir transfer_contractor_role). Aucune écriture sur
-- project_memberships/membership_permissions. Ordre : 1) avisoire chantier,
-- 2) adhésion initiatrice, 3) adhésion successeur, 4) éventuelle demande
-- PENDING à clôturer avant d'en insérer une nouvelle.
-- ----------------------------------------------------------------------------

create function public.request_role_transfer(
  p_project_id uuid,
  p_successor_membership_id uuid,
  p_reason text
)
returns public.role_transfers
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_actor record;
  v_successor record;
  v_couple record;
  v_stale record;
  v_now timestamptz;
  v_new public.role_transfers;
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

  if p_project_id is null or p_successor_membership_id is null then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select id, role, owner_profile, revoked_at, authorization_revision
  into v_actor
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
  for update;

  -- Seul OWNER/PRIMARY peut initier CE parcours (CONTRACTOR passe par
  -- transfer_contractor_role, jamais par une demande PENDING).
  if not found or v_actor.role <> 'OWNER' or v_actor.owner_profile <> 'PRIMARY' then
    raise exception 'not_authorized';
  end if;

  v_couple := public.role_transfer_couple('OWNER');

  select id, project_id, profile_id, role, owner_profile, revoked_at, authorization_revision
  into v_successor
  from public.project_memberships
  where id = p_successor_membership_id
  for update;

  if not found
     or v_successor.project_id <> p_project_id
     or v_successor.revoked_at is not null
     or v_successor.role <> v_couple.successor_role
     or v_successor.owner_profile is distinct from v_couple.successor_owner_profile
  then
    raise exception 'successor_not_eligible';
  end if;

  -- Aucune auto-désignation : le successeur ne peut jamais être l'appelant.
  if v_successor.profile_id = v_uid then
    raise exception 'not_authorized';
  end if;

  -- Contrôle serveur du second profil (jamais une preuve du client).
  if public.is_profile_verified(v_successor.profile_id) is not true then
    raise exception 'successor_account_provisional';
  end if;

  -- Contrôle serveur de L'INITIATEUR (l'appelant), recalculé ICI — APRÈS les
  -- deux verrous de ligne ci-dessus, jamais réutilisé depuis l'entrée de la
  -- fonction (is_account_provisional() y précède ces verrous) : un compte
  -- vérifié peut redevenir provisional (M002a) pendant l'attente d'un
  -- verrou — même correction que confirm_role_transfer.
  if public.is_profile_verified(v_uid) is not true then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  v_now := clock_timestamp();

  -- Clôture d'une éventuelle demande PENDING existante DEVENUE inutilisable,
  -- SOUS CE MÊME VERROU, avant toute nouvelle demande — voir note d'en-tête
  -- "Unicité des demandes PENDING". Si elle est encore réellement valide, on
  -- s'arrête ICI sans avoir rien modifié (aucun UPDATE avant ce raise).
  select id, expires_at, initiator_membership_id, successor_membership_id,
         initiator_membership_revision, successor_membership_revision
  into v_stale
  from public.role_transfers
  where project_id = p_project_id
    and role = 'OWNER'
    and status = 'PENDING'
  for update;

  if found then
    if v_stale.expires_at > v_now
       and exists (
         select 1 from public.project_memberships
         where id = v_stale.initiator_membership_id
           and revoked_at is null
           and authorization_revision = v_stale.initiator_membership_revision
       )
       and exists (
         select 1 from public.project_memberships
         where id = v_stale.successor_membership_id
           and revoked_at is null
           and authorization_revision = v_stale.successor_membership_revision
       )
    then
      raise exception 'pending_transfer_exists';
    end if;

    update public.role_transfers
    set status = (case when v_stale.expires_at <= v_now then 'EXPIRED' else 'INVALIDATED' end)::public.role_transfer_status,
        decided_at_server = v_now
    where id = v_stale.id;
  end if;

  insert into public.role_transfers (
    project_id, role, initiator_membership_id, successor_membership_id,
    initiator_membership_revision, successor_membership_revision,
    expires_at, request_reason
  ) values (
    p_project_id, 'OWNER', v_actor.id, v_successor.id,
    v_actor.authorization_revision, v_successor.authorization_revision,
    v_now + interval '72 hours', p_reason
  )
  returning * into v_new;

  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
  ) values (
    p_project_id, 'HUMAN', v_uid, 'ROLE_TRANSFER_REQUESTED', 'role_transfers', v_new.id, 'SUCCESS', p_reason
  );

  return v_new;
end;
$$;

revoke execute on function public.request_role_transfer(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_role_transfer(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- cancel_role_transfer — annulation par l'INITIATEUR (adhésion encore
-- active), depuis PENDING uniquement. Aucune fermeture forcée d'une demande
-- expirée/invalidée détectée ici (voir note d'en-tête) : refus simple, sans
-- mutation de la ligne.
-- ----------------------------------------------------------------------------

create function public.cancel_role_transfer(p_transfer_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek record;
  v_row record;
  v_now timestamptz;
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

  if p_transfer_id is null then
    raise exception 'not_authorized';
  end if;

  select project_id, initiator_membership_id
  into v_peek
  from public.role_transfers
  where id = p_transfer_id;

  if not found then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek.project_id::text)::bigint);

  -- Rôle habilitant COURANT (adhésion initiatrice encore active), jamais une
  -- identité indépendante de l'adhésion.
  if not exists (
    select 1 from public.project_memberships
    where id = v_peek.initiator_membership_id
      and profile_id = v_uid
      and revoked_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  select id, status, expires_at
  into v_row
  from public.role_transfers
  where id = p_transfer_id
  for update;

  v_now := clock_timestamp();

  if v_row.status <> 'PENDING' then
    raise exception 'transfer_request_not_pending';
  end if;

  if v_row.expires_at <= v_now then
    raise exception 'transfer_request_expired';
  end if;

  update public.role_transfers
  set status = 'CANCELLED', decided_at_server = v_now, decided_by_profile_id = v_uid, decision_reason = p_reason
  where id = v_row.id;

  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
  ) values (
    v_peek.project_id, 'HUMAN', v_uid, 'ROLE_TRANSFER_CANCELLED', 'role_transfers', v_row.id, 'SUCCESS', p_reason
  );
end;
$$;

revoke execute on function public.cancel_role_transfer(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_role_transfer(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- refuse_role_transfer — refus par le SUCCESSEUR, depuis PENDING uniquement.
-- Aucune mutation de project_memberships/membership_permissions (symétrique
-- à refuse_invitation, M006a).
-- ----------------------------------------------------------------------------

create function public.refuse_role_transfer(p_transfer_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek record;
  v_row record;
  v_now timestamptz;
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

  if p_transfer_id is null then
    raise exception 'not_authorized';
  end if;

  select project_id, successor_membership_id
  into v_peek
  from public.role_transfers
  where id = p_transfer_id;

  if not found then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek.project_id::text)::bigint);

  if not exists (
    select 1 from public.project_memberships
    where id = v_peek.successor_membership_id
      and profile_id = v_uid
      and revoked_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  select id, status, expires_at
  into v_row
  from public.role_transfers
  where id = p_transfer_id
  for update;

  v_now := clock_timestamp();

  if v_row.status <> 'PENDING' then
    raise exception 'transfer_request_not_pending';
  end if;

  if v_row.expires_at <= v_now then
    raise exception 'transfer_request_expired';
  end if;

  update public.role_transfers
  set status = 'REFUSED', decided_at_server = v_now, decided_by_profile_id = v_uid, decision_reason = p_reason
  where id = v_row.id;

  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
  ) values (
    v_peek.project_id, 'HUMAN', v_uid, 'ROLE_TRANSFER_REFUSED', 'role_transfers', v_row.id, 'SUCCESS', p_reason
  );
end;
$$;

revoke execute on function public.refuse_role_transfer(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.refuse_role_transfer(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- confirm_role_transfer — SEULE fonction du parcours OWNER qui bascule
-- réellement les rôles. Revérifie sous verrou : identités, habilitations,
-- adhésions actives, révisions d'autorisation inchangées depuis la demande,
-- expiration réelle (clock_timestamp(), après verrouillage). Bascule +
-- révocations requises + audit dans la MÊME transaction.
-- ----------------------------------------------------------------------------

create function public.confirm_role_transfer(p_transfer_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek record;
  v_row record;
  v_initiator record;
  v_successor record;
  v_couple record;
  v_now timestamptz;
  v_revoked jsonb;
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

  if p_transfer_id is null then
    raise exception 'not_authorized';
  end if;

  -- Lecture NON verrouillée : sert UNIQUEMENT à résoudre le chantier (clé de
  -- l'avisoire) et les deux adhésions à verrouiller ensuite. Aucune décision
  -- ne s'appuie sur cette lecture — tout est relu sous verrou plus bas.
  select project_id, initiator_membership_id, successor_membership_id
  into v_peek
  from public.role_transfers
  where id = p_transfer_id;

  if not found then
    raise exception 'not_authorized';
  end if;

  -- Ordre CONVENU : 1) avisoire chantier, 2) LES DEUX adhésions, 3) la
  -- demande (role_transfers). Corrigé après revue ZIP (2026-09-24) : la
  -- version précédente vérifiait le statut/l'expiration AVANT de verrouiller
  -- les deux adhésions — une attente réelle sur CES lignes (possible hors de
  -- ce verrou avisoire, ex. update_draft_project/M004b qui verrouille
  -- project_memberships FOR UPDATE sans prendre AUCUN avisoire — 'org_
  -- provisioning' appartient à create_draft_project, une fonction distincte
  -- qui ne verrouille jamais project_memberships) pouvait dépasser
  -- expires_at sans que clock_timestamp() ne le voie. clock_timestamp() et
  -- le contrôle d'expiration sont désormais posés APRÈS ces deux verrous de
  -- ligne, juste avant la bascule.
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek.project_id::text)::bigint);

  select id, profile_id, role, owner_profile, revoked_at, authorization_revision
  into v_successor
  from public.project_memberships
  where id = v_peek.successor_membership_id
  for update;

  if not found or v_successor.profile_id <> v_uid or v_successor.revoked_at is not null then
    raise exception 'not_authorized';
  end if;

  -- FK RESTRICT (role_transfers -> project_memberships) garantit l'existence.
  select id, profile_id, role, owner_profile, revoked_at, authorization_revision
  into v_initiator
  from public.project_memberships
  where id = v_peek.initiator_membership_id
  for update;

  select *
  into v_row
  from public.role_transfers
  where id = p_transfer_id
  for update;

  -- clock_timestamp() (heure réelle au moment de CET appel), jamais now()
  -- (figée au début de transaction), et posé ICI — APRÈS les trois verrous
  -- ci-dessus, pas avant : un appel bloqué par L'UN DE CES TROIS verrous
  -- jusqu'après l'expiration doit voir l'expiration réelle (leçon B016,
  -- accept_invitation/M006a, étendue ici aux verrous de ligne en plus de
  -- l'avisoire).
  v_now := clock_timestamp();

  if v_row.status <> 'PENDING' then
    raise exception 'transfer_request_not_pending';
  end if;

  if v_row.expires_at <= v_now then
    raise exception 'transfer_request_expired';
  end if;

  v_couple := public.role_transfer_couple(v_row.role);

  -- Revérification complète, indépendante du statut stocké : adhésion
  -- initiatrice toujours active, toujours PRIMARY, révision inchangée
  -- depuis la demande.
  if v_initiator.revoked_at is not null
     or v_initiator.authorization_revision <> v_row.initiator_membership_revision
     or v_initiator.role <> v_couple.initiator_role
     or v_initiator.owner_profile is distinct from v_couple.initiator_owner_profile
  then
    raise exception 'transfer_request_invalidated';
  end if;

  -- Idem pour l'adhésion successeur.
  if v_successor.authorization_revision <> v_row.successor_membership_revision
     or v_successor.role <> v_couple.successor_role
     or v_successor.owner_profile is distinct from v_couple.successor_owner_profile
  then
    raise exception 'transfer_request_invalidated';
  end if;

  -- Contrôle serveur des DEUX comptes, recalculé ICI (après les trois
  -- attentes de verrouillage ci-dessus), jamais réutilisé depuis l'entrée de
  -- la fonction : un compte vérifié peut redevenir provisional (M002a)
  -- pendant l'attente d'un verrou — scénario réel, pas hypothétique. Le
  -- successeur (l'appelant) est revérifié bien qu'is_account_provisional()
  -- l'ait déjà validé à l'entrée, car cette validation d'entrée précède
  -- elle aussi les trois verrous ci-dessus.
  if public.is_profile_verified(v_successor.profile_id) is not true
     or public.is_profile_verified(v_initiator.profile_id) is not true
  then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  -- Bascule atomique : démotion AVANT promotion — les index uniques
  -- project_memberships_primary_owner_unique/_contractor_unique (M004/M006,
  -- non déferrables) rejetteraient l'ordre inverse en instantané.
  update public.project_memberships
  set role = v_couple.final_initiator_role, owner_profile = v_couple.final_initiator_owner_profile
  where id = v_initiator.id;

  update public.project_memberships
  set role = v_couple.final_successor_role, owner_profile = v_couple.final_successor_owner_profile
  where id = v_successor.id;

  -- Révocation des délégations REÇUES par le successeur (toutes, même
  -- expirées) : son nouveau rôle n'est plus jamais bénéficiaire éligible
  -- pour aucun des 4 codes. Celles accordées par l'ancien titulaire à des
  -- tiers restent INTACTES (voir note d'en-tête "Délégations incompatibles").
  -- Identifiants/codes capturés via RETURNING pour l'audit ci-dessous —
  -- jamais une simple mention générique "des délégations ont été révoquées".
  with revoked as (
    update public.membership_permissions
    set revoked_at_server = v_now, revoked_by = v_uid
    where project_membership_id = v_successor.id
      and revoked_at_server is null
    returning id, permission_code
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'permission_code', permission_code)), '[]'::jsonb)
  into v_revoked
  from revoked;

  update public.role_transfers
  set status = 'CONFIRMED', decided_at_server = v_now, decided_by_profile_id = v_uid, decision_reason = p_reason
  where id = v_row.id;

  -- Échec de cet INSERT (ex. contrainte violée) annule TOUT ce qui précède,
  -- y compris la révocation des délégations ci-dessus (fonction unique,
  -- transaction unique, même principe que accept_invitation/M006a et
  -- remove_participant/M004c).
  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason, context
  ) values (
    v_peek.project_id, 'HUMAN', v_uid, 'ROLE_TRANSFER_CONFIRMED', 'role_transfers', v_row.id, 'SUCCESS', p_reason,
    jsonb_build_object('revoked_delegations', v_revoked)
  );
end;
$$;

revoke execute on function public.confirm_role_transfer(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_role_transfer(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- transfer_contractor_role — CONTRACTOR, transfert IMMÉDIAT (AC039 "sans
-- période de double contrôle") : une seule fonction, une seule transaction,
-- aucune phase PENDING. Ligne role_transfers insérée directement CONFIRMED.
-- ----------------------------------------------------------------------------

create function public.transfer_contractor_role(
  p_project_id uuid,
  p_successor_membership_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_actor record;
  v_successor record;
  v_couple record;
  v_now timestamptz;
  v_transfer_id uuid;
  v_revoked jsonb;
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

  if p_project_id is null or p_successor_membership_id is null then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select id, role, owner_profile, revoked_at, authorization_revision
  into v_actor
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
  for update;

  if not found or v_actor.role <> 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;

  v_couple := public.role_transfer_couple('CONTRACTOR');

  select id, project_id, profile_id, role, owner_profile, revoked_at, authorization_revision
  into v_successor
  from public.project_memberships
  where id = p_successor_membership_id
  for update;

  if not found
     or v_successor.project_id <> p_project_id
     or v_successor.revoked_at is not null
     or v_successor.role <> v_couple.successor_role
     or v_successor.owner_profile is distinct from v_couple.successor_owner_profile
  then
    raise exception 'successor_not_eligible';
  end if;

  if v_successor.profile_id = v_uid then
    raise exception 'not_authorized';
  end if;

  if public.is_profile_verified(v_successor.profile_id) is not true then
    raise exception 'successor_account_provisional';
  end if;

  -- Contrôle serveur de L'INITIATEUR (l'appelant), recalculé ICI — APRÈS les
  -- deux verrous de ligne ci-dessus — même correction que confirm_role_
  -- transfer/request_role_transfer.
  if public.is_profile_verified(v_uid) is not true then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  v_now := clock_timestamp();

  update public.project_memberships
  set role = v_couple.final_initiator_role, owner_profile = v_couple.final_initiator_owner_profile
  where id = v_actor.id;

  update public.project_memberships
  set role = v_couple.final_successor_role, owner_profile = v_couple.final_successor_owner_profile
  where id = v_successor.id;

  with revoked as (
    update public.membership_permissions
    set revoked_at_server = v_now, revoked_by = v_uid
    where project_membership_id = v_successor.id
      and revoked_at_server is null
    returning id, permission_code
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'permission_code', permission_code)), '[]'::jsonb)
  into v_revoked
  from revoked;

  insert into public.role_transfers (
    project_id, role, status, initiator_membership_id, successor_membership_id,
    initiator_membership_revision, successor_membership_revision,
    expires_at, requested_at_server, decided_at_server, decided_by_profile_id,
    request_reason, decision_reason
  ) values (
    p_project_id, 'CONTRACTOR', 'CONFIRMED', v_actor.id, v_successor.id,
    v_actor.authorization_revision, v_successor.authorization_revision,
    null, v_now, v_now, v_uid, p_reason, p_reason
  )
  returning id into v_transfer_id;

  insert into public.audit_events (
    project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason, context
  ) values (
    p_project_id, 'HUMAN', v_uid, 'ROLE_TRANSFER_CONFIRMED', 'role_transfers', v_transfer_id, 'SUCCESS', p_reason,
    jsonb_build_object('revoked_delegations', v_revoked)
  );
end;
$$;

revoke execute on function public.transfer_contractor_role(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.transfer_contractor_role(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- RLS — RLS_POLICY_MATRIX.csv R009 : select "parties concernées et rôles
-- principaux" (initiateur, successeur, OWNER/PRIMARY et CONTRACTOR
-- courants) ; insert/update SERVER_RPC (aucun accès direct, tout passe par
-- les fonctions SECURITY DEFINER ci-dessus) ; delete DENY (append-only).
-- ----------------------------------------------------------------------------

alter table public.role_transfers enable row level security;

revoke all privileges on table public.role_transfers from public, anon, authenticated;

grant select on table public.role_transfers to authenticated;

create policy role_transfers_select_concerned
on public.role_transfers
for select
to authenticated
using (
  exists (
    select 1 from public.project_memberships pm
    where pm.project_id = role_transfers.project_id
      and pm.profile_id = auth.uid()
      and pm.revoked_at is null
      and (
        pm.id = role_transfers.initiator_membership_id
        or pm.id = role_transfers.successor_membership_id
        or (pm.role = 'OWNER' and pm.owner_profile = 'PRIMARY')
        or pm.role = 'CONTRACTOR'
      )
  )
);

-- ----------------------------------------------------------------------------
-- list_role_transfers — lecture pour l'interface équipe. is_pending calculé
-- (jamais le seul statut stocké) : PENDING ET non expirée (clock_timestamp())
-- ET les deux révisions toujours inchangées — même philosophie que
-- "effective" dans list_project_delegations (M004c). Périmètre RLS déjà
-- appliqué par la policy ci-dessus (SECURITY DEFINER ne la contourne pas
-- ici : la fonction filtre elle-même sur le même critère, voir WHERE final).
-- ----------------------------------------------------------------------------

create type public.role_transfer_view as (
  id uuid,
  role public.membership_role,
  status public.role_transfer_status,
  initiator_membership_id uuid,
  successor_membership_id uuid,
  requested_at_server timestamptz,
  expires_at timestamptz,
  decided_at_server timestamptz,
  request_reason text,
  decision_reason text,
  is_pending boolean
);

create function public.list_role_transfers(p_project_id uuid)
returns setof public.role_transfer_view
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

  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  return query
  select
    rt.id,
    rt.role,
    rt.status,
    rt.initiator_membership_id,
    rt.successor_membership_id,
    rt.requested_at_server,
    rt.expires_at,
    rt.decided_at_server,
    rt.request_reason,
    rt.decision_reason,
    (
      rt.status = 'PENDING'
      and (rt.expires_at is null or rt.expires_at > now())
      and exists (
        select 1 from public.project_memberships pmi
        where pmi.id = rt.initiator_membership_id
          and pmi.revoked_at is null
          and pmi.authorization_revision = rt.initiator_membership_revision
      )
      and exists (
        select 1 from public.project_memberships pms
        where pms.id = rt.successor_membership_id
          and pms.revoked_at is null
          and pms.authorization_revision = rt.successor_membership_revision
      )
    ) as is_pending
  from public.role_transfers rt
  where rt.project_id = p_project_id
    and (
      exists (
        select 1 from public.project_memberships pm
        where pm.project_id = p_project_id
          and pm.profile_id = v_uid
          and pm.revoked_at is null
          and (
            pm.id = rt.initiator_membership_id
            or pm.id = rt.successor_membership_id
            or (pm.role = 'OWNER' and pm.owner_profile = 'PRIMARY')
            or pm.role = 'CONTRACTOR'
          )
      )
    )
  order by rt.requested_at_server desc;
end;
$$;

revoke execute on function public.list_role_transfers(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_role_transfers(uuid) to authenticated;

commit;
