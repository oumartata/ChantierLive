-- M041 — corrections des étapes (accord du fondateur 2026-10-07, boucle 19).
-- Jamais une réécriture de M033/M040 : deux fonctions remplacées.
--
-- 1. D180 : declare_phase_complete exige une progression déclarée de 100 % ;
--    sinon refus « progression_incomplete », sans aucune modification
--    automatique de la progression. Corps M040 repris, une vérification
--    ajoutée.
-- 2. restructure_phase_plan (M033) : l'insertion d'une étape AVANT une étape
--    existante échouait sur l'index unique des positions actives
--    (project_phases_plan_position_active_unique), les étapes étant
--    traitées dans l'ordre de la nouvelle liste alors que l'étape suivante
--    occupait encore la position visée. Correctif : seules les étapes
--    conservées dont la position change reçoivent d'abord une position
--    provisoire (+1 000 000), puis leur position définitive ; une étape
--    conservée identique (position, libellé, poids) n'est jamais mise à
--    jour. Aucun contenu d'étape validée n'est modifié (seule sa position
--    peut changer, comme depuis M040) ; l'historique n'est jamais réécrit
--    (un seul événement STRUCTURE_CHANGED ajouté, comme avant). Corps M033
--    repris pour tout le reste (droits, validation, somme des poids, motif,
--    calcul et événement).

begin;

create or replace function public.declare_phase_complete(p_project_id uuid, p_phase_id uuid, p_expected_revision integer)
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
  if v_phase.progression is distinct from 100 then
    raise exception 'progression_incomplete';
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

create or replace function public.restructure_phase_plan(p_project_id uuid, p_phases jsonb, p_reason text, p_expected_revision integer)
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
  v_current public.project_phases;
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

  -- Validation intégrale avant toute écriture (inchangée, M033).
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
      if v_phase_id = any (v_kept_ids) then
        raise exception 'phase_invalid_position';
      end if;
      v_kept_ids := array_append(v_kept_ids, v_phase_id);
    end if;
  end loop;

  select coalesce(sum((item->>'weight')::numeric), 0) into v_sum from jsonb_array_elements(p_phases) as item;
  if v_sum is distinct from 100 then
    raise exception 'weight_sum_invalid';
  end if;

  -- Étapes retirées : archivées, jamais supprimées (inchangé, M033) ; elles
  -- libèrent leur position.
  update public.project_phases
  set archived_at = now()
  where plan_id = v_plan.id and archived_at is null
    and not (id = any (v_kept_ids));

  -- Correctif : étapes conservées dont la position CHANGE -> position
  -- provisoire, hors de toute position définitive ; les autres ne sont pas
  -- touchées.
  for v_item in select * from jsonb_array_elements(p_phases) loop
    if v_item ? 'phase_id' and jsonb_typeof(v_item->'phase_id') = 'string' then
      update public.project_phases
      set position = position + 1000000
      where id = (v_item->>'phase_id')::uuid and position <> (v_item->>'position')::integer;
    end if;
  end loop;

  -- Positions définitives : étapes conservées mises à jour seulement si
  -- quelque chose change (progression INCHANGÉE) ; nouvelles étapes insérées.
  for v_item in select * from jsonb_array_elements(p_phases) loop
    if v_item ? 'phase_id' and jsonb_typeof(v_item->'phase_id') = 'string' then
      select * into v_current from public.project_phases where id = (v_item->>'phase_id')::uuid;
      if v_current.position <> (v_item->>'position')::integer
         or v_current.label <> v_item->>'label'
         or v_current.weight <> (v_item->>'weight')::numeric then
        update public.project_phases
        set position = (v_item->>'position')::integer, label = v_item->>'label', weight = (v_item->>'weight')::numeric
        where id = v_current.id;
      end if;
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

  insert into public.project_phase_events (project_id, plan_id, phase_id, event_seq, event_type, previous_value, new_value, actor_profile_id, actor_role, reason, computed_global_progress, computed_validated_progress)
  values (p_project_id, v_plan.id, null, v_plan.last_event_seq, 'STRUCTURE_CHANGED', v_previous, v_new, v_uid, 'CONTRACTOR', p_reason, v_global,
          public.phase_validated_progress_internal(v_plan.id));

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

revoke execute on function public.declare_phase_complete(uuid, uuid, integer), public.restructure_phase_plan(uuid, jsonb, text, integer)
  from public, anon, service_role;
grant execute on function public.declare_phase_complete(uuid, uuid, integer), public.restructure_phase_plan(uuid, jsonb, text, integer)
  to authenticated;

commit;
