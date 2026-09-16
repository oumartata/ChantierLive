-- M004 — projects, project_memberships, membership_permissions
-- MIGRATION_ORDER.csv: M004, depends_on=M002;M003, validation_gate="accès croisé refusé"
-- Arbitrages fondateur B009 (2026-09-16) : organization_id NULLABLE sur
-- projects (OWNER n'a pas nécessairement d'organisation, FR017/FR014/BR012) ;
-- aucun accès chantier via la seule adhésion organisation ; lecture
-- project_memberships limitée à ses propres adhésions actives (pas de
-- self-jointure, pas de récursion RLS — la liste des participants est
-- différée à B010 via un helper à concevoir) ; membership_permissions
-- explicitement mutable (une ligne par octroi, révocation logique, jamais
-- réactivée) ; 4 permission_code retenus seulement ; aucun mécanisme métier
-- de création/transfert/délégation créé ici.

begin;

-- --------------------------------------------------------------------------
-- projects (DATABASE_TABLES.csv T005 — write_pattern "révision serveur + archive")
-- --------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations (id) on delete restrict,
  name text not null,
  country text not null,
  address text null,
  latitude numeric null,
  longitude numeric null,
  planned_start_date date null,
  planned_end_date date null,
  budget bigint null,
  status public.project_status not null default 'DRAFT',
  archived_at timestamptz null,
  revision int not null default 0,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  constraint projects_name_not_blank check (btrim(name) <> ''),
  constraint projects_country_not_blank check (btrim(country) <> '')
);

create index projects_organization_id_idx on public.projects (organization_id);

create trigger set_updated_at_server
before update on public.projects
for each row execute function public.set_updated_at_server();

-- Révision incrémentée exclusivement côté serveur (DATA_MODEL.yaml
-- conventions.concurrency). Fonction dédiée, ne modifie pas
-- set_updated_at_server (M001).
create function public.set_project_revision()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 0;
  else
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

revoke execute on function public.set_project_revision() from public, anon, authenticated, service_role;

create trigger set_project_revision
before insert or update on public.projects
for each row execute function public.set_project_revision();

-- --------------------------------------------------------------------------
-- project_memberships (DATABASE_TABLES.csv T006)
-- --------------------------------------------------------------------------

create table public.project_memberships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  role public.membership_role not null,
  owner_profile public.owner_profile null,
  revoked_at timestamptz null,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  -- D006 : owner_profile qualifie uniquement le rôle OWNER (PRIMARY/CO_OWNER),
  -- absent pour tout autre rôle.
  constraint project_memberships_owner_profile_consistency check (
    (role = 'OWNER' and owner_profile is not null)
    or (role <> 'OWNER' and owner_profile is null)
  )
);

-- Support de la FK composite de membership_permissions (empêche qu'une
-- délégation référence une adhésion d'un autre chantier).
create unique index project_memberships_id_project_id_key on public.project_memberships (id, project_id);

-- Au plus une adhésion active par (chantier, profil). Ne garantit pas
-- qu'une adhésion existe, seulement l'absence de doublon actif.
create unique index project_memberships_active_unique
  on public.project_memberships (project_id, profile_id)
  where revoked_at is null;

-- Au plus un OWNER PRIMARY actif par chantier (même réserve : pas de garantie
-- d'existence, uniquement d'unicité).
create unique index project_memberships_primary_owner_unique
  on public.project_memberships (project_id)
  where role = 'OWNER' and owner_profile = 'PRIMARY' and revoked_at is null;

create index project_memberships_profile_id_idx on public.project_memberships (profile_id);

create trigger set_updated_at_server
before update on public.project_memberships
for each row execute function public.set_updated_at_server();

-- --------------------------------------------------------------------------
-- membership_permissions (DATABASE_TABLES.csv T007). Modèle explicitement
-- mutable (pas append-only) : une ligne par octroi, révocation logique,
-- jamais réactivée — un nouvel octroi après révocation crée une nouvelle ligne.
-- --------------------------------------------------------------------------

create table public.membership_permissions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  project_membership_id uuid not null,
  -- 4 codes retenus uniquement (cadrage B009) ; couples délégant/bénéficiaire
  -- (CONTRACTOR->SITE_MANAGER pour PHASE_EDIT_DRAFT/EXPENSE_PUBLISH,
  -- OWNER PRIMARY->CO_OWNER pour PHASE_VALIDATE/APPROVAL_DECIDE) documentés
  -- mais non contrôlés ici : contrôle transactionnel différé.
  permission_code text not null check (
    permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH', 'PHASE_VALIDATE', 'APPROVAL_DECIDE')
  ),
  granted_by uuid not null references public.profiles (id) on delete restrict,
  granted_at_server timestamptz not null default now(),
  revoked_at_server timestamptz null,
  revoked_by uuid null references public.profiles (id) on delete restrict,
  expires_at timestamptz null,
  constraint membership_permissions_revocation_consistency check (
    (revoked_at_server is null and revoked_by is null)
    or (revoked_at_server is not null and revoked_by is not null)
  ),
  constraint membership_permissions_expiry_after_grant check (
    expires_at is null or expires_at > granted_at_server
  ),
  -- Empêche qu'une délégation référence une adhésion d'un autre chantier :
  -- le project_id doit correspondre à celui de l'adhésion visée.
  constraint membership_permissions_membership_project_fk
    foreign key (project_membership_id, project_id)
    references public.project_memberships (id, project_id)
    on delete restrict
);

-- Nommé "not_revoked", pas "active" : une expiration non révoquée bloque
-- encore un nouvel octroi du même code (limite assumée, cf cadrage B009).
-- Index immutable (n'utilise pas now()/expires_at).
create unique index membership_permissions_not_revoked_unique
  on public.membership_permissions (project_membership_id, permission_code)
  where revoked_at_server is null;

create index membership_permissions_project_id_idx on public.membership_permissions (project_id);
create index membership_permissions_project_membership_id_idx on public.membership_permissions (project_membership_id);

-- --------------------------------------------------------------------------
-- Sécurité : RLS, refus par défaut, lecture seule cliente
-- --------------------------------------------------------------------------

alter table public.projects enable row level security;
alter table public.project_memberships enable row level security;
alter table public.membership_permissions enable row level security;

revoke all privileges on table public.projects, public.project_memberships, public.membership_permissions
  from public, anon, authenticated;

grant select on public.projects, public.project_memberships, public.membership_permissions to authenticated;

-- Pas de self-jointure : limité à ses propres adhésions actives. La lecture
-- des autres participants du chantier est différée à B010 (helper sécurisé).
create policy project_memberships_select_own
on public.project_memberships
for select
to authenticated
using (
  profile_id = auth.uid()
  and revoked_at is null
);

-- Accès uniquement via adhésion chantier propre et active — aucun accès par
-- la seule adhésion organisation. Archivage ne masque pas la lecture (BR018).
create policy projects_select_own_membership
on public.projects
for select
to authenticated
using (
  exists (
    select 1 from public.project_memberships pm
    where pm.project_id = projects.id
      and pm.profile_id = auth.uid()
      and pm.revoked_at is null
  )
);

-- Référence project_memberships (pas de self-jointure sur elle-même).
create policy membership_permissions_select_active_member
on public.membership_permissions
for select
to authenticated
using (
  exists (
    select 1 from public.project_memberships pm
    where pm.project_id = membership_permissions.project_id
      and pm.profile_id = auth.uid()
      and pm.revoked_at is null
  )
);

commit;
