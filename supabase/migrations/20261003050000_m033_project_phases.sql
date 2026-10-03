-- M033 — Avancement des travaux (étapes de chantier, poids, progression).
-- Autorisation fondateur explicite du 2026-10-03, migration strictement
-- locale. Référence de conception : MIGRATION_ORDER.csv lignes 8-9
-- (M007 « phase_templates template_items », M008 « project_phases
-- phase_versions ») — jamais réutilisés comme identifiant de fichier
-- (vérifié : M030 existe et est déjà appliqué, aucun trou dans la
-- séquence réelle M001..M032b ; voir PREPARATION_AVANCEMENT_TRAVAUX.md
-- §0). Le modèle par défaut (6 étapes) n'est PAS semé en SQL : il vit
-- côté application (action serveur Next), ce fichier ne contient aucune
-- donnée métier figée.
--
-- Décisions fondateur appliquées : poids (weight) devant totaliser
-- exactement 100 à la publication (jamais un arrondi silencieux) ;
-- progression 0-100 par étape ; avancement global =
-- Σ(weight×progression)/100 ; aucun pourcentage avant publication
-- (global_progress NULL tant que BROUILLON) ; affichage « déclaré par
-- l'entreprise », aucune validation automatique par photo/géolocalisation,
-- aucun circuit PHASE_VALIDATE (hors périmètre, non implémenté) ; toute
-- modification de progression et toute restructuration après démarrage
-- attribuée et historisée, jamais recalculée silencieusement
-- (computed_global_progress gelé par événement) ; concurrence protégée
-- par revision (même principe que advance_ledgers, M014).

begin;

-- ----------------------------------------------------------------------------
-- 1. Extension du mécanisme de délégation existant (M004/M004a/M004c) pour
--    le nouveau code PHASE_UPDATE_PROGRESS — même couple CONTRACTOR (natif) /
--    SITE_MANAGER (délégation active) que PHASE_EDIT_DRAFT. OWNER (PRIMARY
--    et CO_OWNER) toujours refusé, aucune exception. Aucune table recréée :
--    extension de la contrainte et des deux fonctions existantes.
-- ----------------------------------------------------------------------------

alter table public.membership_permissions
  drop constraint membership_permissions_permission_code_check;

alter table public.membership_permissions
  add constraint membership_permissions_permission_code_check check (
    permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH', 'PHASE_VALIDATE', 'APPROVAL_DECIDE', 'PHASE_UPDATE_PROGRESS')
  );

create or replace function public.has_project_permission(p_project_uuid uuid, p_permission_code text)
returns boolean
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_membership record;
begin
  if p_permission_code not in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH', 'PHASE_VALIDATE', 'APPROVAL_DECIDE', 'PHASE_UPDATE_PROGRESS') then
    return false;
  end if;

  select pm.id, pm.role, pm.owner_profile
    into v_membership
    from public.project_memberships pm
    where pm.project_id = p_project_uuid
      and pm.profile_id = auth.uid()
      and pm.revoked_at is null;

  if not found then
    return false;
  end if;

  -- Refus explicite OWNER sur ces codes, sans exception (D082).
  if p_permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH', 'PHASE_UPDATE_PROGRESS') and v_membership.role = 'OWNER' then
    return false;
  end if;

  -- Droit natif CONTRACTOR.
  if p_permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH', 'PHASE_UPDATE_PROGRESS') and v_membership.role = 'CONTRACTOR' then
    return true;
  end if;

  -- Droit natif OWNER PRIMARY.
  if p_permission_code in ('PHASE_VALIDATE', 'APPROVAL_DECIDE')
     and v_membership.role = 'OWNER' and v_membership.owner_profile = 'PRIMARY' then
    return true;
  end if;

  -- Seul le rôle éligible à la délégation pour ce code peut poursuivre.
  if p_permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH', 'PHASE_UPDATE_PROGRESS') and v_membership.role <> 'SITE_MANAGER' then
    return false;
  end if;
  if p_permission_code in ('PHASE_VALIDATE', 'APPROVAL_DECIDE')
     and not (v_membership.role = 'OWNER' and v_membership.owner_profile = 'CO_OWNER') then
    return false;
  end if;

  return exists (
    select 1
    from public.membership_permissions mp
    where mp.project_membership_id = v_membership.id
      and mp.permission_code = p_permission_code
      and mp.revoked_at_server is null
      and (mp.expires_at is null or mp.expires_at > now())
  );
end;
$$;

create or replace function public.delegation_couple(
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
  if p_permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH', 'PHASE_UPDATE_PROGRESS') then
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

-- ----------------------------------------------------------------------------
-- 2. Tables.
-- ----------------------------------------------------------------------------

create table public.project_phase_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects (id) on delete restrict,
  status text not null default 'BROUILLON' check (status in ('BROUILLON', 'PUBLIE')),
  revision integer not null default 0,
  last_event_seq bigint not null default 0,
  published_at_server timestamptz null,
  published_by_profile_id uuid null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  constraint project_phase_plans_published_consistency check (
    (status = 'BROUILLON' and published_at_server is null and published_by_profile_id is null)
    or (status = 'PUBLIE' and published_at_server is not null and published_by_profile_id is not null)
  )
);

create table public.project_phases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  plan_id uuid not null references public.project_phase_plans (id) on delete restrict,
  position integer not null check (position > 0),
  label text not null check (char_length(label) between 1 and 200),
  weight numeric not null default 0 check (weight >= 0 and weight <= 100),
  progression numeric not null default 0 check (progression >= 0 and progression <= 100),
  archived_at timestamptz null,
  created_at_server timestamptz not null default now()
);

create unique index project_phases_plan_position_active_unique
  on public.project_phases (plan_id, position)
  where archived_at is null;

-- Historique append-only, jamais réécrit — une ligne par événement,
-- computed_global_progress gelé à l'instant précis de l'événement (jamais
-- recalculé rétroactivement si les poids changent ensuite).
create table public.project_phase_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  plan_id uuid not null references public.project_phase_plans (id) on delete restrict,
  phase_id uuid null references public.project_phases (id) on delete restrict,
  event_seq bigint not null check (event_seq > 0),
  event_type text not null check (event_type in ('PLAN_PUBLISHED', 'PROGRESSION_UPDATED', 'STRUCTURE_CHANGED')),
  previous_value jsonb null,
  new_value jsonb null,
  actor_profile_id uuid not null references public.profiles (id) on delete restrict,
  actor_role text not null check (actor_role in ('CONTRACTOR', 'SITE_MANAGER')),
  reason text null check (reason is null or char_length(reason) between 1 and 1000),
  computed_global_progress numeric not null check (computed_global_progress >= 0 and computed_global_progress <= 100),
  created_at_server timestamptz not null default now(),
  constraint project_phase_events_seq_unique unique (plan_id, event_seq),
  constraint project_phase_events_target_consistency check (
    (event_type = 'PLAN_PUBLISHED' and phase_id is null)
    or (event_type in ('PROGRESSION_UPDATED', 'STRUCTURE_CHANGED'))
  ),
  constraint project_phase_events_reason_required check (
    event_type <> 'STRUCTURE_CHANGED' or (reason is not null and char_length(reason) >= 1)
  )
);

-- ----------------------------------------------------------------------------
-- 3. Déclencheurs (invariants).
-- ----------------------------------------------------------------------------

create function public.guard_project_phase_plan()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'phase_plan_immutable';
  end if;
  if tg_op = 'INSERT' then
    new.revision := 0;
    return new;
  end if;
  if new.project_id <> old.project_id or new.created_at_server <> old.created_at_server then
    raise exception 'phase_plan_immutable';
  end if;
  if old.status = 'PUBLIE' and new.status = 'BROUILLON' then
    raise exception 'phase_plan_cannot_unpublish';
  end if;
  if new.last_event_seq <> old.last_event_seq + 1 and new.last_event_seq <> old.last_event_seq then
    raise exception 'phase_plan_sequence_violation';
  end if;
  new.revision := old.revision + 1;
  return new;
end;
$$;

create trigger guard_project_phase_plan
before insert or update or delete on public.project_phase_plans
for each row execute function public.guard_project_phase_plan();

create function public.guard_phase_event_insert()
returns trigger
language plpgsql
as $$
begin
  if new.event_seq is distinct from (select last_event_seq from public.project_phase_plans where id = new.plan_id) then
    raise exception 'phase_sequence_violation';
  end if;
  return new;
end;
$$;

create trigger guard_phase_event_insert
before insert on public.project_phase_events
for each row execute function public.guard_phase_event_insert();

create function public.reject_phase_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'phase_event_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.project_phase_events
for each row execute function public.reject_phase_event_mutation();

-- Même durcissement que advance_ledgers/advance_events (M014) : RLS activée
-- ET tout privilège de table révoqué — aucun accès direct possible, même en
-- cas d'erreur de politique RLS, uniquement via les fonctions SECURITY
-- DEFINER ci-dessous.
alter table public.project_phase_plans enable row level security;
alter table public.project_phases enable row level security;
alter table public.project_phase_events enable row level security;
revoke all privileges on table public.project_phase_plans, public.project_phases, public.project_phase_events
  from public, anon, authenticated;

revoke execute on function public.guard_project_phase_plan(), public.guard_phase_event_insert(), public.reject_phase_event_mutation()
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Types de retour.
-- ----------------------------------------------------------------------------

create type public.project_phase_plan_view as (
  plan_id uuid,
  project_id uuid,
  status text,
  revision integer,
  published_at_server timestamptz,
  published_by_profile_id uuid,
  global_progress numeric,
  last_event_at timestamptz,
  last_event_by_role text
);

create type public.project_phase_row as (
  phase_id uuid,
  position integer,
  label text,
  weight numeric,
  progression numeric
);

create type public.project_phase_event_row as (
  event_seq bigint,
  event_type text,
  phase_id uuid,
  phase_label text,
  previous_value jsonb,
  new_value jsonb,
  actor_role text,
  reason text,
  computed_global_progress numeric,
  created_at_server timestamptz
);

-- ----------------------------------------------------------------------------
-- 5. Lecture (PHASE_VIEW : toute adhésion active, les 4 rôles — inchangé).
-- ----------------------------------------------------------------------------

create function public.get_project_phase_plan(p_project_id uuid)
returns public.project_phase_plan_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_plan public.project_phase_plans;
  v_result public.project_phase_plan_view;
  v_last_event record;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  select * into v_plan from public.project_phase_plans where project_id = p_project_id;
  if not found then
    v_result.plan_id := null;
    v_result.project_id := p_project_id;
    v_result.status := 'ABSENT';
    v_result.revision := null;
    v_result.global_progress := null;
    return v_result;
  end if;

  v_result.plan_id := v_plan.id;
  v_result.project_id := v_plan.project_id;
  v_result.status := v_plan.status;
  v_result.revision := v_plan.revision;
  v_result.published_at_server := v_plan.published_at_server;
  v_result.published_by_profile_id := v_plan.published_by_profile_id;

  if v_plan.status = 'PUBLIE' then
    select coalesce(sum(weight * progression), 0) / 100 into v_result.global_progress
    from public.project_phases
    where plan_id = v_plan.id and archived_at is null;
  else
    v_result.global_progress := null;
  end if;

  select actor_role, created_at_server into v_last_event
  from public.project_phase_events
  where plan_id = v_plan.id
  order by event_seq desc
  limit 1;
  v_result.last_event_at := v_last_event.created_at_server;
  v_result.last_event_by_role := v_last_event.actor_role;

  return v_result;
end;
$$;

revoke execute on function public.get_project_phase_plan(uuid) from public, anon, service_role;
grant execute on function public.get_project_phase_plan(uuid) to authenticated;

create function public.list_project_phases(p_project_id uuid)
returns setof public.project_phase_row
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_plan_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  select id into v_plan_id from public.project_phase_plans where project_id = p_project_id;
  if v_plan_id is null then
    return;
  end if;

  return query
    select id, position, label, weight, progression
    from public.project_phases
    where plan_id = v_plan_id and archived_at is null
    order by position;
end;
$$;

revoke execute on function public.list_project_phases(uuid) from public, anon, service_role;
grant execute on function public.list_project_phases(uuid) to authenticated;

create function public.list_phase_events(p_project_id uuid)
returns setof public.project_phase_event_row
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_plan_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null
  ) then
    raise exception 'not_authorized';
  end if;

  select id into v_plan_id from public.project_phase_plans where project_id = p_project_id;
  if v_plan_id is null then
    return;
  end if;

  return query
    select e.event_seq, e.event_type, e.phase_id, p.label, e.previous_value, e.new_value,
           e.actor_role, e.reason, e.computed_global_progress, e.created_at_server
    from public.project_phase_events e
    left join public.project_phases p on p.id = e.phase_id
    where e.plan_id = v_plan_id
    order by e.event_seq;
end;
$$;

revoke execute on function public.list_phase_events(uuid) from public, anon, service_role;
grant execute on function public.list_phase_events(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Écriture — brouillon (CONTRACTOR natif uniquement dans ce lot ; aucune
--    extension OWNER/SITE_MANAGER non demandée par le fondateur).
-- ----------------------------------------------------------------------------

create function public.upsert_phase_plan_draft(p_project_id uuid, p_phases jsonb, p_expected_revision integer)
returns public.project_phase_plan_view
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
  v_plan public.project_phase_plans;
  v_item jsonb;
  v_seen_positions integer[] := '{}';
  v_count integer := 0;
  v_result public.project_phase_plan_view;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select pm.id, pm.role into v_membership
  from public.project_memberships pm
  where pm.project_id = p_project_id and pm.profile_id = v_uid and pm.revoked_at is null;
  if not found or v_membership.role <> 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;

  if jsonb_typeof(p_phases) <> 'array' or jsonb_array_length(p_phases) < 1 then
    raise exception 'phases_required';
  end if;

  select * into v_plan from public.project_phase_plans where project_id = p_project_id for update;
  if not found then
    if p_expected_revision is distinct from 0 then
      raise exception 'revision_conflict';
    end if;
    insert into public.project_phase_plans (project_id) values (p_project_id) returning * into v_plan;
  else
    if v_plan.status <> 'BROUILLON' then
      raise exception 'plan_already_published';
    end if;
    if v_plan.revision is distinct from p_expected_revision then
      raise exception 'revision_conflict';
    end if;
  end if;

  -- Validation intégrale avant toute écriture (lecture fermée).
  for v_item in select * from jsonb_array_elements(p_phases) loop
    v_count := v_count + 1;
    if jsonb_typeof(v_item->'label') <> 'string' or char_length(trim(both from (v_item->>'label'))) < 1 or char_length(v_item->>'label') > 200 then
      raise exception 'phase_invalid_label';
    end if;
    if jsonb_typeof(v_item->'position') <> 'number' or (v_item->>'position')::integer <> v_count then
      raise exception 'phase_invalid_position';
    end if;
    if jsonb_typeof(v_item->'weight') <> 'number' or (v_item->>'weight')::numeric < 0 or (v_item->>'weight')::numeric > 100 then
      raise exception 'phase_invalid_weight';
    end if;
  end loop;

  -- Brouillon jamais historisé (§ limites documentées) : remplacement
  -- complet archivé plutôt que supprimé, pour ne jamais casser une FK
  -- d'un événement futur qui référencerait une ligne déjà existante.
  update public.project_phases set archived_at = now()
  where plan_id = v_plan.id and archived_at is null;

  insert into public.project_phases (project_id, plan_id, position, label, weight)
  select p_project_id, v_plan.id, (item->>'position')::integer, item->>'label', (item->>'weight')::numeric
  from jsonb_array_elements(p_phases) as item;

  -- Pas d'événement d'historique ni d'avancement du compteur de séquence
  -- pour l'édition d'un brouillon (seul le plan publié est historisé) :
  -- seule la révision du plan doit changer pour protéger contre un
  -- écrasement concurrent entre deux éditions de brouillon.
  update public.project_phase_plans set last_event_seq = last_event_seq where id = v_plan.id returning * into v_plan;

  v_result.plan_id := v_plan.id;
  v_result.project_id := v_plan.project_id;
  v_result.status := v_plan.status;
  v_result.revision := v_plan.revision;
  v_result.global_progress := null;
  return v_result;
end;
$$;

revoke execute on function public.upsert_phase_plan_draft(uuid, jsonb, integer) from public, anon, service_role;
grant execute on function public.upsert_phase_plan_draft(uuid, jsonb, integer) to authenticated;

create function public.publish_phase_plan(p_project_id uuid, p_expected_revision integer)
returns public.project_phase_plan_view
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
  v_plan public.project_phase_plans;
  v_sum numeric;
  v_phases jsonb;
  v_result public.project_phase_plan_view;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select pm.id, pm.role into v_membership
  from public.project_memberships pm
  where pm.project_id = p_project_id and pm.profile_id = v_uid and pm.revoked_at is null;
  if not found or v_membership.role <> 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;

  select * into v_plan from public.project_phase_plans where project_id = p_project_id for update;
  if not found or v_plan.status <> 'BROUILLON' then
    raise exception 'not_authorized';
  end if;
  if v_plan.revision is distinct from p_expected_revision then
    raise exception 'revision_conflict';
  end if;

  select coalesce(sum(weight), 0) into v_sum from public.project_phases where plan_id = v_plan.id and archived_at is null;
  if v_sum is distinct from 100 then
    raise exception 'weight_sum_invalid';
  end if;

  select jsonb_agg(jsonb_build_object('phase_id', id, 'position', position, 'label', label, 'weight', weight) order by position)
    into v_phases
    from public.project_phases where plan_id = v_plan.id and archived_at is null;

  update public.project_phase_plans
  set status = 'PUBLIE', published_at_server = now(), published_by_profile_id = v_uid, last_event_seq = last_event_seq + 1
  where id = v_plan.id
  returning * into v_plan;

  insert into public.project_phase_events (project_id, plan_id, phase_id, event_seq, event_type, previous_value, new_value, actor_profile_id, actor_role, computed_global_progress)
  values (p_project_id, v_plan.id, null, v_plan.last_event_seq, 'PLAN_PUBLISHED', null, v_phases, v_uid, 'CONTRACTOR', 0);

  v_result.plan_id := v_plan.id;
  v_result.project_id := v_plan.project_id;
  v_result.status := v_plan.status;
  v_result.revision := v_plan.revision;
  v_result.published_at_server := v_plan.published_at_server;
  v_result.published_by_profile_id := v_plan.published_by_profile_id;
  v_result.global_progress := 0;
  return v_result;
end;
$$;

revoke execute on function public.publish_phase_plan(uuid, integer) from public, anon, service_role;
grant execute on function public.publish_phase_plan(uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Écriture — progression (CONTRACTOR natif OU SITE_MANAGER avec
--    délégation PHASE_UPDATE_PROGRESS active sur CE chantier ; jamais un
--    droit par simple appartenance à une organisation ; OWNER toujours
--    refusé, consultation seulement).
-- ----------------------------------------------------------------------------

create function public.update_phase_progress(p_project_id uuid, p_phase_id uuid, p_progression numeric, p_expected_revision integer)
returns public.project_phase_plan_view
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
  v_actor_role text;
  v_plan public.project_phase_plans;
  v_phase public.project_phases;
  v_previous jsonb;
  v_global numeric;
  v_result public.project_phase_plan_view;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select pm.id, pm.role into v_membership
  from public.project_memberships pm
  where pm.project_id = p_project_id and pm.profile_id = v_uid and pm.revoked_at is null;
  if not found then
    raise exception 'not_authorized';
  end if;

  if v_membership.role = 'CONTRACTOR' then
    v_actor_role := 'CONTRACTOR';
  elsif v_membership.role = 'SITE_MANAGER' and public.has_project_permission(p_project_id, 'PHASE_UPDATE_PROGRESS') then
    v_actor_role := 'SITE_MANAGER';
  else
    raise exception 'not_authorized';
  end if;

  if p_progression is null or p_progression < 0 or p_progression > 100 then
    raise exception 'progression_out_of_range';
  end if;

  select * into v_plan from public.project_phase_plans where project_id = p_project_id for update;
  if not found or v_plan.status <> 'PUBLIE' then
    raise exception 'not_authorized';
  end if;
  if v_plan.revision is distinct from p_expected_revision then
    raise exception 'revision_conflict';
  end if;

  select * into v_phase from public.project_phases where id = p_phase_id and plan_id = v_plan.id and archived_at is null for update;
  if not found then
    raise exception 'phase_not_found';
  end if;

  v_previous := jsonb_build_object('progression', v_phase.progression);

  update public.project_phases set progression = p_progression where id = v_phase.id;

  update public.project_phase_plans set last_event_seq = last_event_seq + 1 where id = v_plan.id returning * into v_plan;

  select coalesce(sum(weight * progression), 0) / 100 into v_global
  from public.project_phases where plan_id = v_plan.id and archived_at is null;

  insert into public.project_phase_events (project_id, plan_id, phase_id, event_seq, event_type, previous_value, new_value, actor_profile_id, actor_role, computed_global_progress)
  values (p_project_id, v_plan.id, v_phase.id, v_plan.last_event_seq, 'PROGRESSION_UPDATED', v_previous, jsonb_build_object('progression', p_progression), v_uid, v_actor_role, v_global);

  v_result.plan_id := v_plan.id;
  v_result.project_id := v_plan.project_id;
  v_result.status := v_plan.status;
  v_result.revision := v_plan.revision;
  v_result.published_at_server := v_plan.published_at_server;
  v_result.published_by_profile_id := v_plan.published_by_profile_id;
  v_result.global_progress := v_global;
  return v_result;
end;
$$;

revoke execute on function public.update_phase_progress(uuid, uuid, numeric, integer) from public, anon, service_role;
grant execute on function public.update_phase_progress(uuid, uuid, numeric, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- 8. Écriture — restructuration après publication (CONTRACTOR natif
--    uniquement, motif explicite obligatoire, historisée, jamais un
--    recalcul silencieux de l'historique déjà affiché).
-- ----------------------------------------------------------------------------

create function public.restructure_phase_plan(p_project_id uuid, p_phases jsonb, p_reason text, p_expected_revision integer)
returns public.project_phase_plan_view
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
  v_plan public.project_phase_plans;
  v_item jsonb;
  v_count integer := 0;
  v_phase_id uuid;
  v_sum numeric;
  v_previous jsonb;
  v_new jsonb;
  v_global numeric;
  v_kept_ids uuid[] := '{}';
  v_result public.project_phase_plan_view;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  if p_reason is null or char_length(trim(both from p_reason)) < 1 then
    raise exception 'reason_required';
  end if;

  select pm.id, pm.role into v_membership
  from public.project_memberships pm
  where pm.project_id = p_project_id and pm.profile_id = v_uid and pm.revoked_at is null;
  if not found or v_membership.role <> 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;

  select * into v_plan from public.project_phase_plans where project_id = p_project_id for update;
  if not found or v_plan.status <> 'PUBLIE' then
    raise exception 'not_authorized';
  end if;
  if v_plan.revision is distinct from p_expected_revision then
    raise exception 'revision_conflict';
  end if;

  if jsonb_typeof(p_phases) <> 'array' or jsonb_array_length(p_phases) < 1 then
    raise exception 'phases_required';
  end if;

  select jsonb_agg(jsonb_build_object('phase_id', id, 'position', position, 'label', label, 'weight', weight, 'progression', progression) order by position)
    into v_previous
    from public.project_phases where plan_id = v_plan.id and archived_at is null;

  -- Validation intégrale avant toute écriture.
  for v_item in select * from jsonb_array_elements(p_phases) loop
    v_count := v_count + 1;
    if jsonb_typeof(v_item->'label') <> 'string' or char_length(trim(both from (v_item->>'label'))) < 1 or char_length(v_item->>'label') > 200 then
      raise exception 'phase_invalid_label';
    end if;
    if jsonb_typeof(v_item->'position') <> 'number' or (v_item->>'position')::integer <> v_count then
      raise exception 'phase_invalid_position';
    end if;
    if jsonb_typeof(v_item->'weight') <> 'number' or (v_item->>'weight')::numeric < 0 or (v_item->>'weight')::numeric > 100 then
      raise exception 'phase_invalid_weight';
    end if;
    if v_item ? 'phase_id' and jsonb_typeof(v_item->'phase_id') = 'string' then
      v_phase_id := (v_item->>'phase_id')::uuid;
      if not exists (select 1 from public.project_phases where id = v_phase_id and plan_id = v_plan.id and archived_at is null) then
        raise exception 'phase_not_found';
      end if;
      v_kept_ids := array_append(v_kept_ids, v_phase_id);
    end if;
  end loop;

  select coalesce(sum((item->>'weight')::numeric), 0) into v_sum from jsonb_array_elements(p_phases) as item;
  if v_sum is distinct from 100 then
    raise exception 'weight_sum_invalid';
  end if;

  -- Étapes retirées de la nouvelle liste : archivées, jamais supprimées,
  -- jamais rencontrées dans la progression (poids=0 dès cet instant dans
  -- le calcul global puisqu'exclues de la somme active).
  update public.project_phases
  set archived_at = now()
  where plan_id = v_plan.id and archived_at is null
    and not (id = any (v_kept_ids));

  -- Étapes conservées : label/position/weight mis à jour, progression
  -- INCHANGÉE (c'est elle qui donne « l'impact » de la restructuration).
  for v_item in select * from jsonb_array_elements(p_phases) loop
    if v_item ? 'phase_id' and jsonb_typeof(v_item->'phase_id') = 'string' then
      update public.project_phases
      set position = (v_item->>'position')::integer, label = v_item->>'label', weight = (v_item->>'weight')::numeric
      where id = (v_item->>'phase_id')::uuid;
    else
      insert into public.project_phases (project_id, plan_id, position, label, weight, progression)
      values (p_project_id, v_plan.id, (v_item->>'position')::integer, v_item->>'label', (v_item->>'weight')::numeric, 0);
    end if;
  end loop;

  select jsonb_agg(jsonb_build_object('phase_id', id, 'position', position, 'label', label, 'weight', weight, 'progression', progression) order by position)
    into v_new
    from public.project_phases where plan_id = v_plan.id and archived_at is null;

  select coalesce(sum(weight * progression), 0) / 100 into v_global
  from public.project_phases where plan_id = v_plan.id and archived_at is null;

  update public.project_phase_plans set last_event_seq = last_event_seq + 1 where id = v_plan.id returning * into v_plan;

  insert into public.project_phase_events (project_id, plan_id, phase_id, event_seq, event_type, previous_value, new_value, actor_profile_id, actor_role, reason, computed_global_progress)
  values (p_project_id, v_plan.id, null, v_plan.last_event_seq, 'STRUCTURE_CHANGED', v_previous, v_new, v_uid, 'CONTRACTOR', p_reason, v_global);

  v_result.plan_id := v_plan.id;
  v_result.project_id := v_plan.project_id;
  v_result.status := v_plan.status;
  v_result.revision := v_plan.revision;
  v_result.published_at_server := v_plan.published_at_server;
  v_result.published_by_profile_id := v_plan.published_by_profile_id;
  v_result.global_progress := v_global;
  return v_result;
end;
$$;

revoke execute on function public.restructure_phase_plan(uuid, jsonb, text, integer) from public, anon, service_role;
grant execute on function public.restructure_phase_plan(uuid, jsonb, text, integer) to authenticated;

commit;
