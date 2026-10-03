-- M031 — project_plan_requests / project_plan_request_variants.
-- Non rattaché à un identifiant B0xx existant (aucun backlog inventé ici) :
-- autorisation fondateur explicite pour les Lots 2 et 3 de
-- PREPARATION_INTEGRATION_METIER.md (session du 2026-10-03), migration
-- locale uniquement, aucune donnée réelle touchée.
--
-- Objectif : faire exister, côté chantier, la "demande" de plan en amont du
-- dépôt réel déjà livré par M020/M023b (jamais réécrits, jamais contournés
-- ici) — paramètres de génération, variantes successives (état modifiable
-- versionné), et un lien contrôlé vers UNE version réellement déposée.
--
-- Décisions reprises telles quelles (founder, PREPARATION_INTEGRATION_METIER.md
-- §3, confirmées dans cette autorisation) :
--   - création/proposition d'une demande : CONTRACTOR ou OWNER/PRIMARY du
--     chantier ciblé uniquement — jamais CO_OWNER, SITE_MANAGER, ni
--     l'ingénieur seul (qui n'est de toute façon pas un rôle de chantier).
--   - consultation : les mêmes lecteurs que les plans candidats aujourd'hui
--     (chantiers/[id]/plans/page.tsx:151-152 — CO_OWNER/SITE_MANAGER ne
--     voient jamais les candidats ni les brouillons).
--   - modifier les paramètres de génération crée une NOUVELLE demande,
--     jamais un écrasement (generation_params immuable par demande, voir
--     le trigger ci-dessous).
--   - modifier une disposition sauvegardée crée une NOUVELLE variante,
--     jamais un écrasement de la précédente (variantes append-only).
--   - une variante déposée et la version project_plan_versions
--     correspondante (M020, déjà immuable) restent immuables.
--   - choisir une variante (acte client, aucune écriture dédiée), retenir
--     un candidat (set_retained_project_plan_version, M020, inchangé),
--     valider techniquement (M023b, inchangé) et publier (M023b, inchangé)
--     restent quatre actes distincts — cette migration n'en fusionne aucun.
--
-- Suit le même ordre de verrous que M020/M023b : avisoire du chantier ->
-- adhésion -> ligne métier concernée -> écriture.

begin;

-- ---------------------------------------------------------------------------
-- project_plan_requests — la "demande".
-- ---------------------------------------------------------------------------

create table public.project_plan_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_as_role text not null check (created_as_role in ('OWNER_PRIMARY', 'CONTRACTOR')),
  generation_params jsonb not null,
  status text not null default 'OPEN',
  created_at_server timestamptz not null default now(),
  constraint project_plan_requests_status_known check (status in ('OPEN', 'DEPOSITED', 'CANCELLED')),
  constraint project_plan_requests_id_project_unique unique (id, project_id)
);

create index project_plan_requests_project_id_idx on public.project_plan_requests (project_id);

alter table public.project_plan_requests enable row level security;
revoke all privileges on table public.project_plan_requests from public, anon, authenticated;

-- Immuable sauf la transition de statut OPEN -> DEPOSITED|CANCELLED (jamais
-- l'inverse, jamais DEPOSITED<->CANCELLED) : même style que
-- reject_plan_validation_mutation (M023b), jamais un blocage total qui
-- empêcherait la clôture normale d'une demande.
create function public.reject_project_plan_request_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'project_plan_request_immutable';
  end if;
  if old.status <> 'OPEN' then
    raise exception 'request_already_terminal';
  end if;
  if new.status not in ('OPEN', 'DEPOSITED', 'CANCELLED') then
    raise exception 'project_plan_request_immutable';
  end if;
  if new.project_id <> old.project_id
     or new.created_by_profile_id <> old.created_by_profile_id
     or new.created_as_role <> old.created_as_role
     or new.generation_params <> old.generation_params
     or new.created_at_server <> old.created_at_server then
    raise exception 'project_plan_request_immutable';
  end if;
  return new;
end;
$$;

create trigger reject_mutation
before update or delete on public.project_plan_requests
for each row execute function public.reject_project_plan_request_mutation();

-- ---------------------------------------------------------------------------
-- project_plan_request_variants — chaque disposition générée/éditée et
-- explicitement sauvegardée pour une demande (jamais le brouillon local de
-- l'éditeur, qui reste côté navigateur). Append-only : "modifier" en crée
-- une nouvelle, jamais une mise à jour en place (sauf le rattachement de
-- dépôt ci-dessous, seule transition permise après création).
-- ---------------------------------------------------------------------------

create table public.project_plan_request_variants (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.project_plan_requests (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  parent_variant_id uuid null references public.project_plan_request_variants (id) on delete restrict,
  variant_number integer not null check (variant_number > 0),
  layout jsonb not null,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  project_plan_version_id uuid null references public.project_plan_versions (id) on delete restrict,
  deposited_at_server timestamptz null,
  constraint project_plan_request_variants_number_unique unique (request_id, variant_number),
  constraint project_plan_request_variants_id_project_unique unique (id, project_id),
  constraint project_plan_request_variants_id_request_unique unique (id, request_id),
  constraint project_plan_request_variants_version_unique unique (project_plan_version_id),
  constraint project_plan_request_variants_request_project_fk
    foreign key (request_id, project_id) references public.project_plan_requests (id, project_id),
  -- Cohérence demande/variante/chantier/version EN BASE, pas seulement en
  -- RPC : une version d'un autre chantier ne peut tout simplement pas
  -- satisfaire cette FK composite.
  constraint project_plan_request_variants_version_project_fk
    foreign key (project_plan_version_id, project_id) references public.project_plan_versions (id, project_id),
  constraint project_plan_request_variants_deposit_consistency check (
    (project_plan_version_id is null and deposited_at_server is null)
    or (project_plan_version_id is not null and deposited_at_server is not null)
  )
);

create index project_plan_request_variants_request_id_idx on public.project_plan_request_variants (request_id);
create index project_plan_request_variants_project_id_idx on public.project_plan_request_variants (project_id);

alter table public.project_plan_request_variants enable row level security;
revoke all privileges on table public.project_plan_request_variants from public, anon, authenticated;

-- Immuable, à UNE exception près : la transition unique NULL -> valeur de
-- (project_plan_version_id, deposited_at_server), posée atomiquement par
-- finalize_plan_request_variant_deposit ci-dessous (jamais par un autre
-- chemin). Toute autre modification, et toute tentative de modifier une
-- ligne déjà déposée, est refusée — "une variante déposée... reste
-- immuable".
create function public.reject_project_plan_request_variant_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'project_plan_request_variant_immutable';
  end if;
  if old.project_plan_version_id is not null then
    raise exception 'project_plan_request_variant_immutable';
  end if;
  if new.request_id <> old.request_id
     or new.project_id <> old.project_id
     or coalesce(new.parent_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
        <> coalesce(old.parent_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
     or new.variant_number <> old.variant_number
     or new.layout <> old.layout
     or new.created_by_profile_id <> old.created_by_profile_id
     or new.created_at_server <> old.created_at_server then
    raise exception 'project_plan_request_variant_immutable';
  end if;
  return new;
end;
$$;

create trigger reject_mutation
before update or delete on public.project_plan_request_variants
for each row execute function public.reject_project_plan_request_variant_mutation();

commit;
