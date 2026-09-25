-- M023 — plan_engineer_designations (B062 uniquement).
--
-- PÉRIMÈTRE RÉDUIT (fondateur, revue B062) : D093 proposait initialement une
-- migration M023 unique portant à la fois plan_engineer_designations et
-- plan_validations (MIGRATION_ORDER.csv). plan_validations dépend de
-- project_plans (M020, B063/B064, non construite) et sert exclusivement la
-- validation technique d'un plan — hors périmètre de B062, qui ne couvre QUE
-- la désignation/révocation de l'ingénieur par l'agence (D092, VALIDATED).
-- plan_validations reste différée au lot consommateur (B064) avec sa propre
-- migration, quand project_plans existera. Cette migration ne dépend que de
-- M002 (profile_identifiers, profiles) et M003 (organizations) — voir
-- MIGRATION_ORDER.csv, mis à jour en conséquence. CORRECTION (revue ciblée,
-- fichier 20260926150000) : is_profile_verified() (M006b) N'EST PAS appelée
-- ici et ne l'a jamais été — une mention antérieure l'affirmait à tort. Le
-- compte du propriétaire appelant est vérifié via is_account_provisional()
-- (M002a) ; l'identifiant de l'ingénieur est vérifié directement sur
-- profile_identifiers.verified_at_server pour la ligne exacte résolue (voir
-- designate_plan_engineer plus bas, et l'en-tête de 20260926150000 pour le
-- détail de cette distinction).
--
-- D092 (arbitrage du fondateur, seul texte VALIDATED ici) : désignation/
-- révocation par le SEUL propriétaire de l'organisation (organizations.
-- owner_profile_id), compte de l'ingénieur identifié et vérifié, périmètre
-- organisationnel précis, aucun pouvoir lié au rôle CONTRACTOR, aucun accès
-- financier supplémentaire, aucune certification ChantierLive sous-entendue.
-- Cette désignation ne confère PAR ELLE-MÊME aucun droit chantier ni
-- financier : aucune fonction ci-dessous n'écrit dans project_memberships,
-- membership_permissions ni aucune table financière.
--
-- Historique jamais perdu (MIGRATION_ORDER.csv) : une ligne n'est JAMAIS
-- supprimée physiquement, seule revoked_at/revoked_by_profile_id la clôt ;
-- une nouvelle désignation après révocation crée une NOUVELLE ligne (jamais
-- une réouverture de l'ancienne) — même principe que project_memberships/
-- organization_memberships (revoked_at + unique index partiel).
--
-- Résolution du profil par identifiant (email/téléphone), PAS un annuaire :
-- aucune fonction ci-dessous ne permet de lister/rechercher des profils.
-- Anti-énumération : absence de l'identifiant ET identifiant non vérifié
-- renvoient EXACTEMENT la même erreur générique (engineer_not_found_or_
-- unverified) — même principe que get_invitation_preview/not_authorized
-- ailleurs dans ce projet, aucune fuite sur l'existence d'un identifiant.
--
-- Audit : audit_events.project_id est NOT NULL (M005) — cette action est
-- strictement organisationnelle, sans chantier associé, donc structurellement
-- non éligible à audit_events sans fabriquer un project_id arbitraire (ce qui
-- ne serait pas fait ici). L'historique complet (qui, quand, révoqué par qui)
-- reste intégralement porté par les colonnes de plan_engineer_designations
-- elle-même, jamais supprimée.

begin;

create table public.plan_engineer_designations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  engineer_profile_id uuid not null references public.profiles (id) on delete restrict,
  designated_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  -- Valeur affichée dans la liste (profiles ne porte aucun nom, profile_identifiers
  -- n'est pas listable par le propriétaire) : capturée au moment de la désignation,
  -- jamais relue depuis profile_identifiers ensuite — ne garantit pas qu'elle
  -- reste l'identifiant courant de ce profil, seulement celui utilisé ici.
  designated_identifier_kind public.identifier_kind not null,
  designated_identifier_value_normalized text not null,
  revoked_at timestamptz null,
  revoked_by_profile_id uuid null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  constraint plan_engineer_designations_revocation_consistency check (
    (revoked_at is null and revoked_by_profile_id is null)
    or (revoked_at is not null and revoked_by_profile_id is not null)
  )
);

-- Une seule désignation NON RÉVOQUÉE par paire (organisation, ingénieur) —
-- même style que project_memberships_contractor_unique/organization_
-- memberships_active_unique. Une nouvelle désignation après révocation crée
-- une nouvelle ligne, jamais un conflit avec l'ancienne (revoked_at non null).
create unique index plan_engineer_designations_active_unique
  on public.plan_engineer_designations (organization_id, engineer_profile_id)
  where revoked_at is null;

create index plan_engineer_designations_organization_id_idx
  on public.plan_engineer_designations (organization_id);

create trigger set_updated_at_server
before update on public.plan_engineer_designations
for each row execute function public.set_updated_at_server();

alter table public.plan_engineer_designations enable row level security;
-- RLS activée SANS policy : refus par défaut pour authenticated/anon, comme
-- private_object_stale_keys (B026). Seules les fonctions SECURITY DEFINER
-- ci-dessous, qui revérifient le propriétaire à chaque appel, donnent accès.
revoke all privileges on table public.plan_engineer_designations from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- designate_plan_engineer — désignation par le propriétaire COURANT de
-- l'organisation, revérifié sous verrou (jamais déduit d'un appel antérieur).
-- Résout l'identifiant fourni EN INTERNE (jamais un annuaire exposé au
-- client) : email normalisé en minuscules/sans espace, téléphone en E.164
-- attendu tel quel — aucune tentative de reconstruire un format invalide,
-- une valeur mal formée ne correspondra simplement à aucun identifiant vérifié
-- et tombera dans la même erreur générique qu'une absence réelle.
-- ----------------------------------------------------------------------------

create function public.designate_plan_engineer(
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

  -- Verrou sur l'organisation AVANT toute résolution : sérialise deux
  -- désignations concurrentes pour la même organisation, revérifie le
  -- propriétaire à l'instant présent (jamais un appel antérieur mis en cache).
  select * into v_org from public.organizations where id = p_organization_id for update;
  if not found or v_org.archived_at is not null then
    raise exception 'not_authorized';
  end if;
  if v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  v_normalized := case
    when p_identifier_kind = 'EMAIL' then lower(btrim(p_identifier_value))
    else btrim(p_identifier_value)
  end;

  -- Résolution + vérification en une seule condition : absence de
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

revoke execute on function public.designate_plan_engineer(uuid, public.identifier_kind, text)
  from public, anon, authenticated, service_role;
grant execute on function public.designate_plan_engineer(uuid, public.identifier_kind, text) to authenticated;

-- ----------------------------------------------------------------------------
-- revoke_plan_engineer_designation — révocation par le propriétaire COURANT
-- de l'organisation de la désignation, revérifié sous verrou. Jamais une
-- suppression physique ; jamais une réouverture d'une ligne déjà révoquée.
-- ----------------------------------------------------------------------------

create function public.revoke_plan_engineer_designation(p_designation_id uuid)
returns public.plan_engineer_designations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.plan_engineer_designations;
  v_org public.organizations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_row from public.plan_engineer_designations where id = p_designation_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;

  select * into v_org from public.organizations where id = v_row.organization_id for update;
  if not found or v_org.owner_profile_id <> v_uid then
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

revoke execute on function public.revoke_plan_engineer_designation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_plan_engineer_designation(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- list_organization_engineers — lecture seule, réservée au propriétaire
-- COURANT de l'organisation (même revérification que les deux fonctions
-- ci-dessus). Renvoie l'historique complet (actives ET révoquées) : "conserve
-- l'historique" ne signifie pas seulement "ne pas supprimer", mais aussi
-- "rester consultable" pour le propriétaire.
-- ----------------------------------------------------------------------------

create function public.list_organization_engineers(p_organization_id uuid)
returns setof public.plan_engineer_designations
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select d.*
  from public.plan_engineer_designations d
  join public.organizations o on o.id = d.organization_id
  where d.organization_id = p_organization_id
    and o.owner_profile_id = auth.uid()
  order by d.created_at_server desc;
$$;

revoke execute on function public.list_organization_engineers(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_engineers(uuid) to authenticated;

commit;
