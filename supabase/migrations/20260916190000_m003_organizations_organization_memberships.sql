-- M003 — organizations, organization_memberships
-- MIGRATION_ORDER.csv: M003, depends_on=M002, validation_gate="isolation organisation"
-- Arbitrages fondateur B008 (2026-09-16, DECISIONS.yaml D076-D081) : un
-- propriétaire principal (transfert non implémenté, non décidé) ; pas de
-- limite d'organisations par profil ; pas de colonne role en M003 ; aucune
-- création automatique ni fonction de provisioning (BR012/FR014 différés) ;
-- adhésion organisation ≠ rôle chantier ; paiement sans droit supplémentaire.

begin;

-- --------------------------------------------------------------------------
-- organizations (DATABASE_TABLES.csv T003 — write_pattern "archive logique")
-- --------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_profile_id uuid not null references public.profiles (id) on delete restrict,
  archived_at timestamptz null,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  constraint organizations_name_not_blank check (btrim(name) <> '')
);

create index organizations_owner_profile_id_idx on public.organizations (owner_profile_id);

create trigger set_updated_at_server
before update on public.organizations
for each row execute function public.set_updated_at_server();

-- --------------------------------------------------------------------------
-- organization_memberships (DATABASE_TABLES.csv T004 — write_pattern
-- "révocation logique"). Pas de colonne role (D078) : adhésion binaire.
-- --------------------------------------------------------------------------

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  revoked_at timestamptz null,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now()
);

-- Unicité : une adhésion active à la fois par (organisation, profil).
-- Révoquée puis ré-adhérée = nouvelle ligne, exclue de la contrainte.
create unique index organization_memberships_active_unique
  on public.organization_memberships (organization_id, profile_id)
  where revoked_at is null;

create index organization_memberships_organization_id_idx on public.organization_memberships (organization_id);
create index organization_memberships_profile_id_idx on public.organization_memberships (profile_id);

create trigger set_updated_at_server
before update on public.organization_memberships
for each row execute function public.set_updated_at_server();

-- --------------------------------------------------------------------------
-- Sécurité : RLS, refus par défaut, lecture seule cliente
-- --------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;

revoke all privileges on table public.organizations, public.organization_memberships
  from public, anon, authenticated;

-- Lecture seule cliente : aucun INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER.
-- Écriture réservée au service_role (conserve ses privilèges par défaut,
-- non touchés ici), aucune fonction SECURITY DEFINER nécessaire pour M003.
grant select on public.organizations, public.organization_memberships to authenticated;

-- organization_memberships d'abord : sa policy ne dépend d'aucune autre table
-- (pas de récursion). organizations peut ensuite s'appuyer dessus.
create policy organization_memberships_select_own
on public.organization_memberships
for select
to authenticated
using (
  profile_id = auth.uid()
  and revoked_at is null
);

create policy organizations_select_owner_or_member
on public.organizations
for select
to authenticated
using (
  archived_at is null
  and (
    owner_profile_id = auth.uid()
    or exists (
      select 1 from public.organization_memberships m
      where m.organization_id = organizations.id
        and m.profile_id = auth.uid()
        and m.revoked_at is null
    )
  )
);

commit;
