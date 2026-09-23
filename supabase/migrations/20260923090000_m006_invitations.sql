-- M006 — invitations bidirectionnelles (B015 : création et partage)
-- Documentaire (comme M002a/M004a/M004b) : dépend de M001/M002/M003/M004,
-- ne modifie aucun fichier de migration déjà clôturé. MIGRATION_ORDER.csv
-- réserve M006 pour "invitations role_transfers support_grants" — ce
-- fichier ne couvre QUE les invitations ; role_transfers, support_grants et
-- has_support_scope restent différés (B017/B018, non traités ici).
--
-- Périmètre de CE tour (B015) : create_invitation, get_invitation_preview,
-- la table invitations, RLS/ACL, et la révision d'autorisation sur
-- project_memberships. accept_invitation/refuse_invitation/revoke_invitation
-- et la preuve d'usage unique concurrent restent B016 (non implémentés ici).
--
-- Arbitrages fondateur B015 (2026-09-22/23) :
--   - Jeton aléatoire (32 octets, extensions.gen_random_bytes), seul son
--     hash SHA-256 (extensions.digest) est stocké ; jamais le jeton en
--     clair en base ni dans un message d'erreur/log applicatif (BR022,
--     D018 : le lien d'invitation n'est jamais traité comme un OTP).
--   - Rôle proposé au bénéficiaire entièrement dérivé du (rôle de
--     l'émetteur, rôle demandé) — matrice BR021/FR027-030 ; jamais choisi
--     par le bénéficiaire.
--   - Cible optionnelle (identifier_kind/valeur normalisée) : mêmes règles
--     de normalisation que sync_auth_identifier (M002a), dupliquées ici
--     volontairement — M002a est une migration close, non modifiée.
--   - Quota BR023/FR029/FR030 : max(1) pour CONTRACTOR et OWNER/PRIMARY,
--     max(2) pour OWNER/CO_OWNER et SITE_MANAGER. Compte les adhésions
--     actives ET les invitations PENDING non expirées émises par une
--     adhésion encore active ET encore du même rôle habilitant (voir
--     authorization_revision ci-dessous) — jamais un simple COUNT(*) FOR
--     UPDATE (ne bloque pas une insertion concurrente d'une ligne qui
--     n'existe pas encore) : sérialisé par un verrou avisoire par chantier,
--     pris AVANT tout verrou de ligne (même principe que M004b pour la
--     résolution d'organisation). accept_invitation (B016) devra prendre
--     le même verrou, dans le même ordre, avant de transformer la
--     réservation d'une invitation PENDING en adhésion — sans jamais
--     compter deux fois la même place.
--   - authorization_revision (nouvelle colonne project_memberships) :
--     compteur entier, jamais fourni par l'appelant (toujours recalculé
--     par trigger), incrémenté uniquement quand role/owner_profile/
--     revoked_at changent réellement (IS DISTINCT FROM). La valeur est
--     capturée sur l'adhésion émettrice au moment de la création de
--     l'invitation ; toute divergence ultérieure (y compris un aller-retour
--     de rôle dans une même transaction, qui incrémente deux fois) rend
--     l'invitation définitivement invalide pour l'acceptation ET cesse de
--     réserver une place au quota — sans transition d'état ni écriture
--     requise, et sans construire un quelconque mécanisme de transfert
--     B018 (non anticipé ici).
--   - Aperçu pré-authentification (get_invitation_preview) : accessible à
--     anon, retourne uniquement chantier/rôle/expiration/disponibilité —
--     aucun nom d'émetteur (profiles ne porte aucune colonne de nom
--     affichable), aucune donnée de cible, statuts indistincts (PENDING
--     expiré / REFUSED / REVOKED / inexistant -> même résultat "non
--     disponible", comme projects_select_own_membership).
--   - Compte vérifié exigé pour créer une invitation (is_account_provisional
--     is not false rejeté, même garde que M004b) ; exigé aussi pour accepter
--     (règle métier B016, non implémentée ici, consignée pour mémoire).
--
-- Corrections post-revue ZIP (2026-09-23) :
--   - get_invitation_preview revérifie désormais l'adhésion émettrice
--     (active, rôle/owner_profile conforme à la matrice, authorization_
--     revision inchangée depuis la création) — sans cela, une invitation
--     invalidée par révocation ou changement de rôle de son émetteur restait
--     affichée "disponible" avec le nom du chantier avant toute authentification.
--   - REVOKE EXECUTE ajouté pour set_membership_authorization_revision()
--     (omis initialement), même durcissement que toutes les autres fonctions
--     de ce fichier et de M001/M002a.

begin;

-- ----------------------------------------------------------------------------
-- project_memberships.authorization_revision — détecte toute modification de
-- l'habilitation d'une adhésion (y compris un aller-retour dans la même
-- transaction), sans modifier M004.
-- ----------------------------------------------------------------------------

alter table public.project_memberships
  add column authorization_revision bigint not null default 0;

create function public.set_membership_authorization_revision()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- Toute valeur fournie par l'appelant est ignorée : toujours 0 à la
    -- création, sans exception.
    new.authorization_revision := 0;
    return new;
  end if;

  if (old.role is distinct from new.role)
     or (old.owner_profile is distinct from new.owner_profile)
     or (old.revoked_at is distinct from new.revoked_at) then
    new.authorization_revision := old.authorization_revision + 1;
  else
    -- Toute valeur fournie par l'appelant est ignorée ici aussi : seule une
    -- modification réelle de role/owner_profile/revoked_at avance le
    -- compteur.
    new.authorization_revision := old.authorization_revision;
  end if;
  return new;
end;
$$;

create trigger set_membership_authorization_revision
before insert or update on public.project_memberships
for each row execute function public.set_membership_authorization_revision();

-- Durcissement identique à toutes les autres fonctions de ce fichier et de
-- M001/M002a (ex. set_updated_at_server, sync_auth_identifier) : une
-- fonction sans REVOKE explicite conserve le privilège EXECUTE par défaut
-- de PUBLIC en PostgreSQL. Le trigger continue de s'exécuter normalement
-- après ce retrait (l'exécution déclenchée par un trigger ne passe pas par
-- une vérification EXECUTE de l'appelant SQL — seul un appel direct via
-- SELECT/RPC serait bloqué, ce qui est précisément le but ici).
revoke execute on function public.set_membership_authorization_revision()
  from public, anon, authenticated, service_role;

-- Au plus 1 CONTRACTOR actif par chantier (BR023 : "1 CONTRACTOR principal"),
-- symétrique à project_memberships_primary_owner_unique (M004, OWNER
-- PRIMARY) — cette dernière existe depuis M004 et n'est PAS créée ici.
-- Jusqu'à ce lot, rien n'imposait cette limite au niveau base : M004b ne
-- pouvait créer qu'un seul CONTRACTOR par construction (un seul appelant à
-- la création du chantier), mais aucune contrainte n'empêchait une seconde
-- adhésion CONTRACTOR d'apparaître par une autre voie. create_invitation
-- applique déjà cette limite par comptage (quota, voir plus bas) au moment
-- de l'ÉMISSION d'une invitation ; cet index est le filet de sécurité côté
-- base au moment où une adhésion serait réellement insérée (acceptation,
-- B016 — non implémentée ici, mais l'index doit exister dès maintenant :
-- il protège aussi toute autre voie d'insertion future, pas seulement B016).
create unique index project_memberships_contractor_unique
  on public.project_memberships (project_id)
  where role = 'CONTRACTOR' and revoked_at is null;

-- ----------------------------------------------------------------------------
-- invitations (DATABASE_TABLES.csv T008)
-- ----------------------------------------------------------------------------

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  role public.membership_role not null,
  owner_profile public.owner_profile null,
  -- Cible optionnelle : NULL/NULL == invitation par lien partagé (FR027/28).
  target_kind public.identifier_kind null,
  target_value_normalized text null,
  -- Jamais le jeton en clair : seul son hash. unique (pas de partiel) :
  -- get_invitation_preview doit retrouver une ligne quel que soit son statut
  -- pour renvoyer un message harmonisé, jamais une absence distincte d'un
  -- statut déjà tranché.
  token_hash bytea not null,
  status public.invitation_status not null default 'PENDING',
  expires_at timestamptz not null,
  -- Fonde l'invalidation de l'invitation (get_invitation_preview et le
  -- comptage du quota dans create_invitation revérifient CETTE ligne
  -- précise : active, rôle/owner_profile conforme à la matrice, et
  -- authorization_revision inchangée — voir created_by_membership_revision)
  -- — ce n'est PAS un champ de traçabilité passive. Cette référence reste
  -- TOUJOURS INCHANGÉE après la création : jamais réécrite pour pointer vers
  -- une autre ligne, jamais migrée vers un nouveau responsable — aucun
  -- héritage automatique. Toute divergence constatée sur CETTE ligne
  -- précise (adhésion révoquée, ou authorization_revision qui diverge du
  -- snapshot capturé) invalide définitivement l'invitation ; un transfert de
  -- rôle futur (B018, non anticipé ici) n'a pas à réécrire cette référence
  -- pour qu'une invitation antérieure redevienne valide — elle ne le
  -- redeviendra jamais implicitement.
  created_by_membership_id uuid not null,
  -- Capture de project_memberships.authorization_revision au moment de la
  -- création : toute divergence ultérieure invalide définitivement
  -- l'invitation pour l'acceptation ET le quota (voir commentaire d'en-tête).
  created_by_membership_revision bigint not null,
  accepted_by_profile_id uuid null references public.profiles (id) on delete restrict,
  decided_at timestamptz null,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  constraint invitations_owner_profile_consistency check (
    (role = 'OWNER' and owner_profile is not null)
    or (role <> 'OWNER' and owner_profile is null)
  ),
  constraint invitations_target_consistency check (
    (target_kind is null) = (target_value_normalized is null)
  ),
  constraint invitations_decided_consistency check (
    (status <> 'PENDING') = (decided_at is not null)
  ),
  constraint invitations_accepted_consistency check (
    (status = 'ACCEPTED') = (accepted_by_profile_id is not null)
  ),
  constraint invitations_expiry_after_creation check (expires_at > created_at_server),
  -- Intégrité chantier de l'adhésion émettrice : empêche qu'une invitation
  -- référence une adhésion d'un AUTRE projet (même pattern que
  -- membership_permissions, M004, via l'index composite ci-dessous).
  foreign key (created_by_membership_id, project_id)
    references public.project_memberships (id, project_id)
);

create unique index invitations_token_hash_key on public.invitations (token_hash);
create index invitations_project_status_idx on public.invitations (project_id, status);
create index invitations_created_by_membership_id_idx on public.invitations (created_by_membership_id);

create trigger set_updated_at_server
before update on public.invitations
for each row execute function public.set_updated_at_server();

alter table public.invitations enable row level security;

revoke all privileges on table public.invitations from public, anon, authenticated;

grant select on public.invitations to authenticated;

-- Visibilité "mes invitations envoyées" uniquement — périmètre volontairement
-- restreint : l'auteur ne les voit que tant que SA PROPRE adhésion reste
-- active. Cette policy est évaluée avec les privilèges de l'appelant
-- (authenticated, pas SECURITY DEFINER) : sa sous-requête sur
-- project_memberships est donc elle-même filtrée par la policy ACTUELLE de
-- cette table, project_memberships_select_participants (M004a — remplace
-- project_memberships_select_own de M004, supprimée par M004a) : "using
-- (revoked_at is null and is_active_project_member(project_id))". La ligne
-- created_by_membership_id référencée par exists() devient donc invisible,
-- pour QUICONQUE l'interroge (pas seulement son auteur), dès qu'elle est
-- révoquée (revoked_at is null échoue) — combiné à la condition
-- pm.profile_id = auth.uid() ci-dessous, l'effet observé est bien que
-- l'auteur perd l'accès à ses invitations envoyées dès que SA PROPRE
-- adhésion émettrice est révoquée, y compris celles déjà décidées. ATTENTION
-- : ne PAS élargir cette policy pour "restaurer" un historique
-- post-révocation — périmètre initial délibérément conservé tel quel (voir
-- tests). Ne sert JAMAIS de chemin de lecture pour le bénéficiaire, pas
-- encore membre — celui-ci passe exclusivement par get_invitation_preview
-- (SECURITY DEFINER, contourne RLS en lecture ciblée par jeton).
create policy invitations_select_own_sent
on public.invitations
for select
to authenticated
using (
  exists (
    select 1 from public.project_memberships pm
    where pm.id = invitations.created_by_membership_id
      and pm.profile_id = auth.uid()
  )
);

-- ----------------------------------------------------------------------------
-- create_invitation
-- ----------------------------------------------------------------------------

create type public.invitation_created as (
  invitation_id uuid,
  project_id uuid,
  role public.membership_role,
  owner_profile public.owner_profile,
  expires_at timestamptz,
  token text
);

create function public.create_invitation(
  p_project_id uuid,
  p_role public.membership_role,
  p_target_kind public.identifier_kind default null,
  p_target_value_raw text default null
)
returns public.invitation_created
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
  v_inv_role public.membership_role;
  v_inv_owner_profile public.owner_profile;
  v_target_normalized text;
  v_cap int;
  v_count int;
  v_token text;
  v_token_hash bytea;
  v_expires_at timestamptz;
  v_invitation_id uuid;
  v_result public.invitation_created;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Vérification côté SQL, indépendante de tout garde-fou applicatif : tient
  -- même en appel RPC direct (même principe que M004b).
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_project_id is null then
    raise exception 'project_id_required';
  end if;

  if p_role is null then
    raise exception 'role_not_allowed_for_sender';
  end if;

  -- Verrou avisoire par chantier, pris AVANT tout verrou de ligne : point
  -- de sérialisation partagé de toutes les opérations qui affectent le
  -- quota d'invitations de ce chantier (accept_invitation/revoke_invitation,
  -- B016, devront prendre exactement ce même verrou, dans le même ordre,
  -- avant leur propre verrou de ligne — sans quoi leur comptage resterait
  -- exposé au même risque de phantom read qu'un COUNT(*) FOR UPDATE seul).
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  -- Même filtre d'adhésion autorisante que update_draft_project (M004b) :
  -- seuls OWNER PRIMARY et CONTRACTOR actifs peuvent émettre une invitation.
  select id, role, owner_profile, authorization_revision into v_membership
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if not found then
    -- Message unique, sans aucune information sur le chantier visé (même
    -- principe que update_draft_project : 'not_authorized' qu'il existe ou
    -- non, que l'appelant y soit membre ou non).
    raise exception 'not_authorized';
  end if;

  -- Matrice BR021/FR027-030 : le rôle proposé au bénéficiaire est
  -- entièrement déterminé par (rôle actif de l'émetteur, rôle demandé) —
  -- jamais un choix libre, jamais celui du bénéficiaire.
  if v_membership.role = 'OWNER' then
    if p_role = 'CONTRACTOR' then
      v_inv_role := 'CONTRACTOR';
      v_inv_owner_profile := null;
    elsif p_role = 'OWNER' then
      v_inv_role := 'OWNER';
      v_inv_owner_profile := 'CO_OWNER';
    else
      raise exception 'role_not_allowed_for_sender';
    end if;
  elsif v_membership.role = 'CONTRACTOR' then
    if p_role = 'OWNER' then
      v_inv_role := 'OWNER';
      v_inv_owner_profile := 'PRIMARY';
    elsif p_role = 'SITE_MANAGER' then
      v_inv_role := 'SITE_MANAGER';
      v_inv_owner_profile := null;
    else
      raise exception 'role_not_allowed_for_sender';
    end if;
  else
    raise exception 'role_not_allowed_for_sender';
  end if;

  -- Cible optionnelle : normalisation identique à sync_auth_identifier
  -- (M002a) — dupliquée ici volontairement, M002a n'est pas modifiée.
  if p_target_kind is not null then
    if p_target_value_raw is null or btrim(p_target_value_raw) = '' then
      raise exception 'target_value_required';
    end if;
    if p_target_kind = 'EMAIL' then
      v_target_normalized := lower(btrim(p_target_value_raw));
      if v_target_normalized !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
        raise exception 'target_value_invalid';
      end if;
    else
      v_target_normalized := btrim(p_target_value_raw);
      if left(v_target_normalized, 1) <> '+' then
        v_target_normalized := '+' || v_target_normalized;
      end if;
      if v_target_normalized !~ '^\+[1-9][0-9]{0,14}$' then
        raise exception 'target_value_invalid';
      end if;
    end if;
  elsif p_target_value_raw is not null and btrim(p_target_value_raw) <> '' then
    raise exception 'target_kind_required';
  end if;

  -- Quota BR023/FR029/FR030 : cap selon le rôle/owner_profile proposé.
  v_cap := case
    when v_inv_role = 'CONTRACTOR' then 1
    when v_inv_role = 'OWNER' and v_inv_owner_profile = 'PRIMARY' then 1
    when v_inv_role = 'OWNER' and v_inv_owner_profile = 'CO_OWNER' then 2
    when v_inv_role = 'SITE_MANAGER' then 2
  end;

  -- Additionne adhésions actives ET invitations PENDING non expirées dont
  -- l'adhésion émettrice est toujours active ET toujours du même rôle
  -- habilitant (authorization_revision inchangée depuis leur création) —
  -- sans FOR UPDATE ici : le verrou avisoire ci-dessus protège déjà tout ce
  -- chantier contre une écriture concurrente qui fausserait ce compte.
  select count(*) into v_count
  from (
    select 1
    from public.project_memberships pm
    where pm.project_id = p_project_id
      and pm.revoked_at is null
      and pm.role = v_inv_role
      and pm.owner_profile is not distinct from v_inv_owner_profile
    union all
    select 1
    from public.invitations i
    join public.project_memberships pm2 on pm2.id = i.created_by_membership_id
    where i.project_id = p_project_id
      and i.status = 'PENDING'
      and i.expires_at > now()
      and i.role = v_inv_role
      and i.owner_profile is not distinct from v_inv_owner_profile
      and pm2.revoked_at is null
      and pm2.authorization_revision = i.created_by_membership_revision
  ) v_reserved;

  if v_count >= v_cap then
    raise exception 'quota_exceeded';
  end if;

  -- Jeton aléatoire serveur (32 octets), seul son hash SHA-256 est stocké.
  -- extensions.* qualifié explicitement : pgcrypto est installée dans le
  -- schéma "extensions" (M001), hors du search_path fixé de cette fonction.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := extensions.digest(v_token, 'sha256');
  v_expires_at := now() + interval '7 days';

  insert into public.invitations (
    project_id, role, owner_profile, target_kind, target_value_normalized,
    token_hash, expires_at, created_by_membership_id, created_by_membership_revision
  ) values (
    p_project_id, v_inv_role, v_inv_owner_profile, p_target_kind, v_target_normalized,
    v_token_hash, v_expires_at, v_membership.id, v_membership.authorization_revision
  )
  returning id into v_invitation_id;

  v_result := (v_invitation_id, p_project_id, v_inv_role, v_inv_owner_profile, v_expires_at, v_token);
  return v_result;
end;
$$;

revoke execute on function public.create_invitation(uuid, public.membership_role, public.identifier_kind, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_invitation(uuid, public.membership_role, public.identifier_kind, text)
  to authenticated;

-- ----------------------------------------------------------------------------
-- get_invitation_preview — lecture seule, pré-authentification (BR024).
-- ----------------------------------------------------------------------------

create type public.invitation_preview as (
  project_name text,
  role public.membership_role,
  owner_profile public.owner_profile,
  expires_at timestamptz,
  available boolean
);

create function public.get_invitation_preview(p_token text)
returns public.invitation_preview
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_hash bytea;
  v_row record;
  v_unavailable public.invitation_preview;
begin
  v_unavailable := (null, null, null, null, false);

  if p_token is null or btrim(p_token) = '' then
    return v_unavailable;
  end if;

  v_hash := extensions.digest(p_token, 'sha256');

  -- Recherche indexée par hash (index unique sur token_hash) : aucune
  -- garantie de complexité annoncée au-delà de ça.
  --
  -- JOIN sur project_memberships avec la même matrice émetteur/bénéficiaire
  -- que create_invitation, PLUS authorization_revision inchangée : une
  -- invitation dont l'adhésion émettrice a été révoquée OU dont le rôle a
  -- changé (y compris un aller-retour A->B->A, détecté par la révision, pas
  -- par la valeur courante) ne remonte simplement plus de ligne ici — sans
  -- cette jointure, l'aperçu restait "disponible" avec le nom du chantier
  -- pour une invitation déjà invalidée par ailleurs (bug corrigé).
  select i.role, i.owner_profile, i.expires_at, i.status, p.name as project_name
  into v_row
  from public.invitations i
  join public.projects p on p.id = i.project_id
  join public.project_memberships pm on pm.id = i.created_by_membership_id
  where i.token_hash = v_hash
    and pm.revoked_at is null
    and pm.authorization_revision = i.created_by_membership_revision
    and (
      (i.role = 'CONTRACTOR' and pm.role = 'OWNER' and pm.owner_profile = 'PRIMARY')
      or (i.role = 'OWNER' and i.owner_profile = 'CO_OWNER' and pm.role = 'OWNER' and pm.owner_profile = 'PRIMARY')
      or (i.role = 'OWNER' and i.owner_profile = 'PRIMARY' and pm.role = 'CONTRACTOR')
      or (i.role = 'SITE_MANAGER' and pm.role = 'CONTRACTOR')
    )
  limit 1;

  -- Statuts indistincts (inexistant, expiré, refusé, révoqué, déjà accepté,
  -- OU émetteur invalidé ci-dessus) -> même résultat "non disponible", pour
  -- ne rien révéler avant authentification (BR024). Aucun nom d'émetteur :
  -- profiles ne porte aucune colonne de nom affichable (M002).
  if not found or v_row.status <> 'PENDING' or v_row.expires_at <= now() then
    return v_unavailable;
  end if;

  return (v_row.project_name, v_row.role, v_row.owner_profile, v_row.expires_at, true);
end;
$$;

revoke execute on function public.get_invitation_preview(text) from public, service_role;
grant execute on function public.get_invitation_preview(text) to authenticated, anon;

commit;
