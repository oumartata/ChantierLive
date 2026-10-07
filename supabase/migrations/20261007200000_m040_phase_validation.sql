-- M040 — B019/B020 sur la base de M033 (décision du fondateur D179,
-- 2026-10-07, option A de PROPOSITION_D6_PHASES.md) et « Avancement validé »
-- (D177, BR034). Jamais une réécriture de M033 : colonnes ajoutées, fonctions
-- M033 reprises seulement là où c'est nécessaire (brouillon : dates prévues ;
-- publication : statut des étapes), nouvelles fonctions pour le reste.
--
-- - Statuts d'une étape (D179) : BROUILLON -> PUBLIEE -> TERMINEE (déclarée
--   terminée par l'entreprise) -> VALIDEE ou REFUSEE (propriétaire principal,
--   motif obligatoire pour un refus) ; REFUSEE -> TERMINEE (nouvelle
--   déclaration). Toute autre transition est refusée par déclencheur, même
--   pour service_role.
-- - Dates prévues facultatives (brouillon : librement ; après publication :
--   motif et trace) ; dates réelles automatiques (premier avancement > 0,
--   déclaration, validation, refus).
-- - Étape publiée modifiable par l'entreprise avec motif et trace
--   (restructure_phase_plan M033, update_phase_schedule) ; étape VALIDEE
--   figée (libellé, poids, progression, dates prévues, archivage), seule sa
--   position peut changer quand d'autres étapes sont réordonnées.
-- - Validation : propriétaire principal seul ; copropriétaire en lecture ;
--   aucune délégation PHASE_VALIDATE utilisée (D179).
-- - « Avancement validé » (BR034, AC050, EC020) = étapes validées / étapes
--   applicables, une étape applicable étant une étape active d'un plan
--   publié ; « non calculable » s'il n'y en a aucune. Jamais fusionné avec
--   l'« Avancement déclaré par l'entreprise » de M033 (D177), inchangé.
-- - Déclarer une étape terminée ne modifie pas sa progression déclarée :
--   les deux mesures restent indépendantes (D177).
-- - Droits toujours vrai ou faux ; audit des déclarations et décisions.

begin;

-- ---------------------------------------------------------------------------
-- 1. Colonnes et reprise des données existantes.
-- ---------------------------------------------------------------------------
alter table public.project_phases
  add column status text not null default 'BROUILLON',
  add column planned_start date null,
  add column planned_end date null,
  add column started_at timestamptz null,
  add column declared_completed_at timestamptz null,
  add column validated_at timestamptz null,
  add column validated_by_profile_id uuid null references public.profiles (id) on delete restrict,
  add column refused_at timestamptz null,
  add column last_refusal_reason text null;

update public.project_phases p
set status = 'PUBLIEE'
from public.project_phase_plans pl
where pl.id = p.plan_id and pl.status = 'PUBLIE';

update public.project_phases set started_at = created_at_server where progression > 0 and started_at is null;

alter table public.project_phases
  add constraint project_phases_status_known check (status in ('BROUILLON', 'PUBLIEE', 'TERMINEE', 'VALIDEE', 'REFUSEE')),
  add constraint project_phases_planned_order check (planned_start is null or planned_end is null or planned_end >= planned_start),
  add constraint project_phases_validated_consistency check ((status = 'VALIDEE') = (validated_at is not null and validated_by_profile_id is not null)),
  add constraint project_phases_refusal_reason_bounds check (last_refusal_reason is null or char_length(btrim(last_refusal_reason)) between 3 and 1000);

alter table public.project_phase_events drop constraint project_phase_events_event_type_check;
alter table public.project_phase_events add constraint project_phase_events_event_type_check
  check (event_type in ('PLAN_PUBLISHED', 'PROGRESSION_UPDATED', 'STRUCTURE_CHANGED',
                        'PHASE_DECLARED_COMPLETE', 'PHASE_VALIDATED', 'PHASE_REFUSED', 'PHASE_SCHEDULE_CHANGED'));
alter table public.project_phase_events drop constraint project_phase_events_actor_role_check;
alter table public.project_phase_events add constraint project_phase_events_actor_role_check
  check (actor_role in ('CONTRACTOR', 'SITE_MANAGER', 'OWNER'));
alter table public.project_phase_events drop constraint project_phase_events_target_consistency;
alter table public.project_phase_events add constraint project_phase_events_target_consistency check (
  (event_type = 'PLAN_PUBLISHED' and phase_id is null)
  or (event_type in ('PROGRESSION_UPDATED', 'STRUCTURE_CHANGED'))
  or (event_type in ('PHASE_DECLARED_COMPLETE', 'PHASE_VALIDATED', 'PHASE_REFUSED', 'PHASE_SCHEDULE_CHANGED') and phase_id is not null)
);
alter table public.project_phase_events drop constraint project_phase_events_reason_required;
alter table public.project_phase_events add constraint project_phase_events_reason_required check (
  event_type not in ('STRUCTURE_CHANGED', 'PHASE_REFUSED', 'PHASE_SCHEDULE_CHANGED') or (reason is not null and char_length(reason) >= 1)
);
alter table public.project_phase_events add column computed_validated_progress numeric null
  check (computed_validated_progress is null or (computed_validated_progress >= 0 and computed_validated_progress <= 100));

-- ---------------------------------------------------------------------------
-- 2. Garde des étapes : transitions, étape validée figée, dates réelles.
-- ---------------------------------------------------------------------------
create function public.guard_project_phase()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'phase_immutable';
  end if;
  if tg_op = 'INSERT' then
    -- Étape ajoutée à un plan déjà publié (restructuration) : publiée d'emblée.
    if exists (select 1 from public.project_phase_plans where id = new.plan_id and status = 'PUBLIE') then
      new.status := 'PUBLIEE';
    else
      new.status := 'BROUILLON';
    end if;
    if new.progression > 0 then
      new.started_at := clock_timestamp();
    end if;
    return new;
  end if;
  if new.id <> old.id or new.project_id <> old.project_id or new.plan_id <> old.plan_id or new.created_at_server <> old.created_at_server then
    raise exception 'phase_immutable';
  end if;
  if old.archived_at is not null and new.archived_at is null then
    raise exception 'phase_immutable';
  end if;
  if old.status = 'VALIDEE' and (
       new.label <> old.label or new.weight <> old.weight or new.progression <> old.progression
       or new.planned_start is distinct from old.planned_start or new.planned_end is distinct from old.planned_end
       or new.archived_at is distinct from old.archived_at or new.status <> old.status
       or new.validated_at is distinct from old.validated_at) then
    raise exception 'phase_validated_immutable';
  end if;
  if new.status <> old.status and (old.status, new.status) not in (
       ('BROUILLON', 'PUBLIEE'), ('PUBLIEE', 'TERMINEE'), ('REFUSEE', 'TERMINEE'), ('TERMINEE', 'VALIDEE'), ('TERMINEE', 'REFUSEE')) then
    raise exception 'invalid_transition';
  end if;
  if new.progression > 0 and old.started_at is null then
    new.started_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create trigger guard_project_phase
before insert or update or delete on public.project_phases
for each row execute function public.guard_project_phase();

revoke execute on function public.guard_project_phase() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Calcul de l'« Avancement validé » (BR034) — interne.
-- ---------------------------------------------------------------------------
create function public.phase_validated_progress_internal(p_plan_id uuid)
returns numeric
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select case when count(*) = 0 then null
              else round(100.0 * count(*) filter (where p.status = 'VALIDEE') / count(*), 2) end
  from public.project_phases p
  join public.project_phase_plans pl on pl.id = p.plan_id and pl.status = 'PUBLIE'
  where p.plan_id = p_plan_id and p.archived_at is null;
$$;

create function public.phase_declared_progress_internal(p_plan_id uuid)
returns numeric
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(sum(weight * progression), 0) / 100 from public.project_phases where plan_id = p_plan_id and archived_at is null;
$$;

revoke execute on function public.phase_validated_progress_internal(uuid), public.phase_declared_progress_internal(uuid)
  from public, anon, authenticated, service_role;

-- Acteur d'écriture : session, compte vérifié, adhésion active ; renvoie
-- le rôle effectif (CONTRACTOR, OWNER_PRIMARY, ou NULL pour tout autre).
create function public.phase_writer_party(p_project_id uuid)
returns text
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_party text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  select case when m.role = 'CONTRACTOR' then 'CONTRACTOR'
              when m.role = 'OWNER' and m.owner_profile = 'PRIMARY' then 'OWNER_PRIMARY' end
    into v_party
  from public.project_memberships m
  where m.project_id = p_project_id and m.profile_id = v_uid and m.revoked_at is null
  limit 1;
  return v_party;
end;
$$;

revoke execute on function public.phase_writer_party(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Brouillon (M033 repris) : dates prévues facultatives lues dans la liste.
-- ---------------------------------------------------------------------------
create or replace function public.upsert_phase_plan_draft(p_project_id uuid, p_phases jsonb, p_expected_revision integer)
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
  v_start date;
  v_end date;
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
    v_start := null;
    v_end := null;
    begin
      if v_item ? 'planned_start' and jsonb_typeof(v_item->'planned_start') = 'string' and v_item->>'planned_start' <> '' then
        v_start := (v_item->>'planned_start')::date;
      end if;
      if v_item ? 'planned_end' and jsonb_typeof(v_item->'planned_end') = 'string' and v_item->>'planned_end' <> '' then
        v_end := (v_item->>'planned_end')::date;
      end if;
    exception when others then
      raise exception 'phase_invalid_dates';
    end;
    if v_start is not null and v_end is not null and v_end < v_start then
      raise exception 'phase_invalid_dates';
    end if;
  end loop;

  update public.project_phases set archived_at = now()
  where plan_id = v_plan.id and archived_at is null;

  insert into public.project_phases (project_id, plan_id, position, label, weight, planned_start, planned_end)
  select p_project_id, v_plan.id, (item->>'position')::integer, item->>'label', (item->>'weight')::numeric,
         nullif(item->>'planned_start', '')::date, nullif(item->>'planned_end', '')::date
  from jsonb_array_elements(p_phases) as item;

  update public.project_phase_plans set last_event_seq = last_event_seq where id = v_plan.id returning * into v_plan;

  v_result.plan_id := v_plan.id;
  v_result.project_id := v_plan.project_id;
  v_result.status := v_plan.status;
  v_result.revision := v_plan.revision;
  v_result.global_progress := null;
  return v_result;
end;
$$;

-- Publication (M033 reprise) : les étapes actives passent à PUBLIEE.
create or replace function public.publish_phase_plan(p_project_id uuid, p_expected_revision integer)
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

  select jsonb_agg(jsonb_build_object('phase_id', id, 'position', position, 'label', label, 'weight', weight,
                                      'planned_start', planned_start, 'planned_end', planned_end) order by position)
    into v_phases
    from public.project_phases where plan_id = v_plan.id and archived_at is null;

  update public.project_phase_plans
  set status = 'PUBLIE', published_at_server = now(), published_by_profile_id = v_uid, last_event_seq = last_event_seq + 1
  where id = v_plan.id
  returning * into v_plan;

  update public.project_phases set status = 'PUBLIEE' where plan_id = v_plan.id and archived_at is null;

  insert into public.project_phase_events (project_id, plan_id, phase_id, event_seq, event_type, previous_value, new_value, actor_profile_id, actor_role, computed_global_progress, computed_validated_progress)
  values (p_project_id, v_plan.id, null, v_plan.last_event_seq, 'PLAN_PUBLISHED', null, v_phases, v_uid, 'CONTRACTOR', 0, 0);

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

-- ---------------------------------------------------------------------------
-- 5. Déclaration, décision, dates prévues (nouvelles commandes).
-- ---------------------------------------------------------------------------
-- Verrou du plan publié, révision attendue, étape active du plan.
create function public.phase_lock(p_project_id uuid, p_phase_id uuid, p_expected_revision integer)
returns public.project_phases
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_plan public.project_phase_plans;
  v_phase public.project_phases;
begin
  select * into v_plan from public.project_phase_plans where project_id = p_project_id for update;
  if not found or v_plan.status <> 'PUBLIE' then
    raise exception 'not_authorized';
  end if;
  if p_expected_revision is null or v_plan.revision is distinct from p_expected_revision then
    raise exception 'revision_conflict';
  end if;
  select * into v_phase from public.project_phases where id = p_phase_id and plan_id = v_plan.id and archived_at is null for update;
  if not found then
    raise exception 'phase_not_found';
  end if;
  return v_phase;
end;
$$;

revoke execute on function public.phase_lock(uuid, uuid, integer) from public, anon, authenticated, service_role;

-- Événement + plan (révision) ; renvoie la vue du plan.
create function public.phase_record_event(p_project_id uuid, p_phase_id uuid, p_event_type text, p_previous jsonb, p_new jsonb, p_actor_role text, p_reason text)
returns public.project_phase_plan_view
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_plan public.project_phase_plans;
  v_result public.project_phase_plan_view;
  v_declared numeric;
  v_validated numeric;
begin
  update public.project_phase_plans set last_event_seq = last_event_seq + 1 where project_id = p_project_id returning * into v_plan;
  v_declared := public.phase_declared_progress_internal(v_plan.id);
  v_validated := public.phase_validated_progress_internal(v_plan.id);
  insert into public.project_phase_events (project_id, plan_id, phase_id, event_seq, event_type, previous_value, new_value, actor_profile_id, actor_role, reason, computed_global_progress, computed_validated_progress)
  values (p_project_id, v_plan.id, p_phase_id, v_plan.last_event_seq, p_event_type, p_previous, p_new, auth.uid(), p_actor_role, p_reason, v_declared, v_validated);
  v_result.plan_id := v_plan.id;
  v_result.project_id := v_plan.project_id;
  v_result.status := v_plan.status;
  v_result.revision := v_plan.revision;
  v_result.published_at_server := v_plan.published_at_server;
  v_result.published_by_profile_id := v_plan.published_by_profile_id;
  v_result.global_progress := v_declared;
  return v_result;
end;
$$;

revoke execute on function public.phase_record_event(uuid, uuid, text, jsonb, jsonb, text, text) from public, anon, authenticated, service_role;

create function public.declare_phase_complete(p_project_id uuid, p_phase_id uuid, p_expected_revision integer)
returns public.project_phase_plan_view
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_phase public.project_phases;
  v_result public.project_phase_plan_view;
begin
  if public.phase_writer_party(p_project_id) is distinct from 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;
  v_phase := public.phase_lock(p_project_id, p_phase_id, p_expected_revision);
  if v_phase.status not in ('PUBLIEE', 'REFUSEE') then
    raise exception 'invalid_transition';
  end if;
  update public.project_phases set status = 'TERMINEE', declared_completed_at = clock_timestamp() where id = v_phase.id;
  v_result := public.phase_record_event(p_project_id, v_phase.id, 'PHASE_DECLARED_COMPLETE',
    jsonb_build_object('status', v_phase.status), jsonb_build_object('status', 'TERMINEE'), 'CONTRACTOR', null);
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (p_project_id, 'HUMAN', auth.uid(), 'PHASE_DECLARED_COMPLETE', 'project_phases', v_phase.id, 'SUCCESS',
          jsonb_build_object('previous_status', v_phase.status), 'Étape déclarée terminée par l''entreprise.');
  return v_result;
end;
$$;

create function public.decide_phase(p_project_id uuid, p_phase_id uuid, p_decision text, p_reason text, p_expected_revision integer)
returns public.project_phase_plan_view
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_phase public.project_phases;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_result public.project_phase_plan_view;
  v_now timestamptz := clock_timestamp();
begin
  if public.phase_writer_party(p_project_id) is distinct from 'OWNER_PRIMARY' then
    raise exception 'not_authorized';
  end if;
  if p_decision is null or p_decision not in ('VALIDEE', 'REFUSEE') then
    raise exception 'decision_invalid';
  end if;
  v_phase := public.phase_lock(p_project_id, p_phase_id, p_expected_revision);
  if v_phase.status <> 'TERMINEE' then
    raise exception 'invalid_transition';
  end if;
  if p_decision = 'REFUSEE' and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'reason_required';
  end if;
  if p_decision = 'VALIDEE' then
    update public.project_phases set status = 'VALIDEE', validated_at = v_now, validated_by_profile_id = auth.uid() where id = v_phase.id;
  else
    update public.project_phases set status = 'REFUSEE', refused_at = v_now, last_refusal_reason = v_reason where id = v_phase.id;
  end if;
  v_result := public.phase_record_event(p_project_id, v_phase.id,
    case when p_decision = 'VALIDEE' then 'PHASE_VALIDATED' else 'PHASE_REFUSED' end,
    jsonb_build_object('status', 'TERMINEE'), jsonb_build_object('status', p_decision), 'OWNER', v_reason);
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (p_project_id, 'HUMAN', auth.uid(), case when p_decision = 'VALIDEE' then 'PHASE_VALIDATED' else 'PHASE_REFUSED' end,
          'project_phases', v_phase.id, 'SUCCESS', jsonb_build_object('decision', p_decision),
          coalesce(v_reason, 'Étape validée par le propriétaire principal.'));
  return v_result;
end;
$$;

create function public.update_phase_schedule(p_project_id uuid, p_phase_id uuid, p_planned_start date, p_planned_end date, p_reason text, p_expected_revision integer)
returns public.project_phase_plan_view
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_phase public.project_phases;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if public.phase_writer_party(p_project_id) is distinct from 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;
  if v_reason is null then
    raise exception 'reason_required';
  end if;
  if p_planned_start is not null and p_planned_end is not null and p_planned_end < p_planned_start then
    raise exception 'phase_invalid_dates';
  end if;
  v_phase := public.phase_lock(p_project_id, p_phase_id, p_expected_revision);
  if v_phase.status = 'VALIDEE' then
    raise exception 'phase_validated_immutable';
  end if;
  if p_planned_start is not distinct from v_phase.planned_start and p_planned_end is not distinct from v_phase.planned_end then
    raise exception 'no_change';
  end if;
  update public.project_phases set planned_start = p_planned_start, planned_end = p_planned_end where id = v_phase.id;
  return public.phase_record_event(p_project_id, v_phase.id, 'PHASE_SCHEDULE_CHANGED',
    jsonb_build_object('planned_start', v_phase.planned_start, 'planned_end', v_phase.planned_end),
    jsonb_build_object('planned_start', p_planned_start, 'planned_end', p_planned_end), 'CONTRACTOR', v_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Lecture (PHASE_VIEW, toute adhésion active).
-- ---------------------------------------------------------------------------
create type public.project_phase_detail as (
  phase_id uuid,
  position integer,
  label text,
  weight numeric,
  progression numeric,
  status text,
  planned_start date,
  planned_end date,
  started_at timestamptz,
  declared_completed_at timestamptz,
  validated_at timestamptz,
  refused_at timestamptz,
  last_refusal_reason text,
  can_declare boolean,
  can_decide boolean,
  can_edit_schedule boolean
);

create function public.list_project_phase_details(p_project_id uuid)
returns setof public.project_phase_detail
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_owner_profile text;
  v_plan public.project_phase_plans;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select m.role::text, m.owner_profile::text into v_role, v_owner_profile
  from public.project_memberships m
  where m.project_id = p_project_id and m.profile_id = v_uid and m.revoked_at is null
  limit 1;
  if v_role is null then
    raise exception 'not_authorized';
  end if;
  select * into v_plan from public.project_phase_plans where project_id = p_project_id;
  if not found then
    return;
  end if;
  return query
    select p.id, p.position, p.label, p.weight, p.progression, p.status, p.planned_start, p.planned_end,
           p.started_at, p.declared_completed_at, p.validated_at, p.refused_at, p.last_refusal_reason,
           coalesce(v_plan.status = 'PUBLIE' and v_role = 'CONTRACTOR' and p.status in ('PUBLIEE', 'REFUSEE'), false),
           coalesce(v_plan.status = 'PUBLIE' and v_role = 'OWNER' and v_owner_profile = 'PRIMARY' and p.status = 'TERMINEE', false),
           coalesce(v_plan.status = 'PUBLIE' and v_role = 'CONTRACTOR' and p.status <> 'VALIDEE', false)
    from public.project_phases p
    where p.plan_id = v_plan.id and p.archived_at is null
    order by p.position;
end;
$$;

create type public.phase_validated_progress as (
  applicable_count integer,
  validated_count integer,
  validated_progress numeric,
  computable boolean
);

create function public.get_project_validated_progress(p_project_id uuid)
returns public.phase_validated_progress
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_result public.phase_validated_progress;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.project_memberships where project_id = p_project_id and profile_id = v_uid and revoked_at is null) then
    raise exception 'not_authorized';
  end if;
  select count(*)::integer, (count(*) filter (where p.status = 'VALIDEE'))::integer
    into v_result.applicable_count, v_result.validated_count
  from public.project_phases p
  join public.project_phase_plans pl on pl.id = p.plan_id and pl.status = 'PUBLIE'
  where pl.project_id = p_project_id and p.archived_at is null;
  v_result.computable := coalesce(v_result.applicable_count, 0) > 0;
  v_result.validated_progress := case when v_result.computable
    then round(100.0 * v_result.validated_count / v_result.applicable_count, 2) end;
  return v_result;
end;
$$;

-- Historique M033 étendu : même signature, plus la mesure validée figée.
create type public.project_phase_event_detail as (
  event_seq bigint,
  event_type text,
  phase_id uuid,
  phase_label text,
  previous_value jsonb,
  new_value jsonb,
  actor_role text,
  reason text,
  computed_global_progress numeric,
  computed_validated_progress numeric,
  created_at_server timestamptz
);

create function public.list_phase_event_details(p_project_id uuid)
returns setof public.project_phase_event_detail
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
  if not exists (select 1 from public.project_memberships where project_id = p_project_id and profile_id = v_uid and revoked_at is null) then
    raise exception 'not_authorized';
  end if;
  select id into v_plan_id from public.project_phase_plans where project_id = p_project_id;
  if v_plan_id is null then
    return;
  end if;
  return query
    select e.event_seq, e.event_type, e.phase_id, p.label, e.previous_value, e.new_value, e.actor_role, e.reason,
           e.computed_global_progress, e.computed_validated_progress, e.created_at_server
    from public.project_phase_events e
    left join public.project_phases p on p.id = e.phase_id
    where e.plan_id = v_plan_id
    order by e.event_seq;
end;
$$;

revoke execute on function public.declare_phase_complete(uuid, uuid, integer), public.decide_phase(uuid, uuid, text, text, integer),
  public.update_phase_schedule(uuid, uuid, date, date, text, integer), public.list_project_phase_details(uuid),
  public.get_project_validated_progress(uuid), public.list_phase_event_details(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.declare_phase_complete(uuid, uuid, integer), public.decide_phase(uuid, uuid, text, text, integer),
  public.update_phase_schedule(uuid, uuid, date, date, text, integer), public.list_project_phase_details(uuid),
  public.get_project_validated_progress(uuid), public.list_phase_event_details(uuid)
  to authenticated;

commit;
