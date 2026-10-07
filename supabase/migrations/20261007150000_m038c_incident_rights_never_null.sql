-- M038c — correctif de la fuite de droits de M038 (boucle 11b), accord
-- explicite du fondateur 2026-10-07. Jamais une réécriture de M038.
--
-- Défaut constaté par scripts/test-incidents.mjs : incident_can_update et
-- incident_can_close comparaient assignee_profile_id = profile_id ; sans
-- responsable désigné la comparaison vaut NULL, la fonction renvoyait NULL
-- et « if not <NULL> » ne refusait pas. Effets : le propriétaire principal
-- corrigeait l'incident de l'entreprise, un chef de chantier non désigné
-- annulait son propre incident.
--
-- Correctif :
-- - les trois fonctions de droit renvoient toujours vrai ou faux
--   (is not distinct from, coalesce(…, false)) ;
-- - correct_incident, assign_incident, transition_incident refusent tout
--   résultat qui n'est pas vrai (« is not true ») ; corps de M038 repris
--   à l'identique hormis ces conditions.
-- Règles inchangées (D162, D163, D165, D167).

begin;

create or replace function public.incident_can_update(p_incident public.incidents, p_actor public.incident_actor)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    p_actor.role in ('CONTRACTOR', 'SITE_MANAGER')
    or p_incident.reporter_profile_id is not distinct from p_actor.profile_id
    or (p_incident.assignee_profile_id is not distinct from p_actor.profile_id
        and p_incident.assignee_profile_id is not null
        and not (p_actor.role = 'OWNER' and p_actor.owner_profile is not distinct from 'CO_OWNER')),
    false);
$$;

create or replace function public.incident_can_close(p_incident public.incidents, p_actor public.incident_actor)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    p_actor.role = 'CONTRACTOR'
    or (not (p_actor.role = 'OWNER' and p_actor.owner_profile is not distinct from 'CO_OWNER')
        and ((p_incident.assignee_profile_id is not distinct from p_actor.profile_id and p_incident.assignee_profile_id is not null)
             or (p_actor.role = 'OWNER' and p_actor.owner_profile is not distinct from 'PRIMARY'
                 and p_incident.reporter_profile_id is not distinct from p_actor.profile_id))),
    false);
$$;

create or replace function public.incident_can_assign(p_actor public.incident_actor)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(p_actor.role = 'CONTRACTOR' or (p_actor.role = 'OWNER' and p_actor.owner_profile is not distinct from 'PRIMARY'), false);
$$;

revoke execute on function public.incident_can_update(public.incidents, public.incident_actor) from public, anon, authenticated, service_role;
revoke execute on function public.incident_can_close(public.incidents, public.incident_actor) from public, anon, authenticated, service_role;
revoke execute on function public.incident_can_assign(public.incident_actor) from public, anon, authenticated, service_role;

create or replace function public.correct_incident(
  p_incident_id uuid,
  p_expected_revision integer,
  p_reason text,
  p_incident_type text,
  p_severity text,
  p_occurred_at timestamptz,
  p_description text
)
returns public.incidents
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old public.incidents := public.incident_lock_for_write(p_incident_id, p_expected_revision);
  v_actor public.incident_actor := public.incident_require_writer(v_old.project_id);
  v_row public.incidents;
  v_changes jsonb := '{}'::jsonb;
  v_description text := btrim(coalesce(p_description, ''));
begin
  if public.incident_can_update(v_old, v_actor) is not true then
    raise exception 'not_authorized';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'reason_required';
  end if;
  if p_occurred_at is null then
    raise exception 'occurred_at_required';
  end if;
  if p_occurred_at > now() + interval '5 minutes' then
    raise exception 'occurred_in_future';
  end if;
  if p_incident_type is distinct from v_old.incident_type then
    v_changes := v_changes || jsonb_build_object('incident_type', jsonb_build_object('old', v_old.incident_type, 'new', p_incident_type));
  end if;
  if p_severity is distinct from v_old.severity then
    v_changes := v_changes || jsonb_build_object('severity', jsonb_build_object('old', v_old.severity, 'new', p_severity));
  end if;
  if p_occurred_at is distinct from v_old.occurred_at then
    v_changes := v_changes || jsonb_build_object('occurred_at', jsonb_build_object('old', v_old.occurred_at, 'new', p_occurred_at));
  end if;
  if v_description is distinct from v_old.description then
    v_changes := v_changes || jsonb_build_object('description', jsonb_build_object('old', v_old.description, 'new', v_description));
  end if;
  if v_changes = '{}'::jsonb then
    raise exception 'no_change';
  end if;
  begin
    update public.incidents
    set incident_type = p_incident_type, severity = p_severity, occurred_at = p_occurred_at, description = v_description,
        revision = revision + 1
    where id = v_old.id
    returning * into v_row;
  exception
    when check_violation then raise exception 'incident_invalid';
  end;

  insert into public.incident_events (incident_id, project_id, event_type, actor_profile_id, actor_role, actor_owner_profile,
                                      from_status, to_status, changes, reason)
  values (v_row.id, v_row.project_id, 'CORRECTION', v_actor.profile_id, v_actor.role, v_actor.owner_profile,
          v_row.status, v_row.status, v_changes, btrim(p_reason));
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_actor.profile_id, 'INCIDENT_CORRECT', 'incidents', v_row.id, 'SUCCESS',
          jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(v_changes) k)), btrim(p_reason));
  return v_row;
end;
$$;

create or replace function public.assign_incident(
  p_incident_id uuid,
  p_expected_revision integer,
  p_assignee_profile_id uuid,
  p_due_date date
)
returns public.incidents
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old public.incidents := public.incident_lock_for_write(p_incident_id, p_expected_revision);
  v_actor public.incident_actor := public.incident_require_writer(v_old.project_id);
  v_row public.incidents;
begin
  if public.incident_can_assign(v_actor) is not true then
    raise exception 'not_authorized';
  end if;
  if p_assignee_profile_id is null or not exists (
    select 1 from public.project_memberships
    where project_id = v_old.project_id and profile_id = p_assignee_profile_id and revoked_at is null
      and role in ('OWNER', 'CONTRACTOR', 'SITE_MANAGER')
  ) then
    raise exception 'assignee_not_member';
  end if;
  if p_assignee_profile_id is not distinct from v_old.assignee_profile_id and p_due_date is not distinct from v_old.due_date then
    raise exception 'no_change';
  end if;
  update public.incidents
  set assignee_profile_id = p_assignee_profile_id,
      due_date = p_due_date,
      status = case when status = 'OUVERT' then 'AFFECTE' else status end,
      revision = revision + 1
  where id = v_old.id
  returning * into v_row;

  insert into public.incident_events (incident_id, project_id, event_type, actor_profile_id, actor_role, actor_owner_profile,
                                      from_status, to_status, changes)
  values (v_row.id, v_row.project_id, 'DESIGNATION', v_actor.profile_id, v_actor.role, v_actor.owner_profile,
          v_old.status, v_row.status,
          jsonb_build_object('assignee_profile_id', jsonb_build_object('old', v_old.assignee_profile_id, 'new', v_row.assignee_profile_id),
                             'due_date', jsonb_build_object('old', v_old.due_date, 'new', v_row.due_date)));
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_actor.profile_id, 'INCIDENT_ASSIGN', 'incidents', v_row.id, 'SUCCESS',
          jsonb_build_object('assignee_profile_id', v_row.assignee_profile_id, 'due_date', v_row.due_date), 'Responsable désigné.');
  return v_row;
end;
$$;

create or replace function public.transition_incident(
  p_incident_id uuid,
  p_expected_revision integer,
  p_to_status text,
  p_note text default null,
  p_resolution text default null
)
returns public.incidents
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old public.incidents := public.incident_lock_for_write(p_incident_id, p_expected_revision);
  v_actor public.incident_actor := public.incident_require_writer(v_old.project_id);
  v_row public.incidents;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_resolution text := v_old.resolution;
  v_closed timestamptz := null;
begin
  if p_to_status = 'EN_COURS' and v_old.status in ('OUVERT', 'AFFECTE') then
    if public.incident_can_update(v_old, v_actor) is not true then raise exception 'not_authorized'; end if;
  elsif p_to_status = 'RESOLU' and v_old.status = 'EN_COURS' then
    if public.incident_can_update(v_old, v_actor) is not true then raise exception 'not_authorized'; end if;
    v_resolution := nullif(btrim(coalesce(p_resolution, '')), '');
    if v_resolution is null or char_length(v_resolution) < 3 then raise exception 'resolution_required'; end if;
  elsif p_to_status = 'EN_COURS' and v_old.status = 'RESOLU' then
    if public.incident_can_update(v_old, v_actor) is not true then raise exception 'not_authorized'; end if;
    if v_note is null or char_length(v_note) < 3 then raise exception 'reason_required'; end if;
    v_resolution := null;
  elsif p_to_status = 'CLOS' and v_old.status = 'RESOLU' then
    if public.incident_can_close(v_old, v_actor) is not true then raise exception 'not_authorized'; end if;
    v_closed := clock_timestamp();
  elsif p_to_status = 'ANNULE' and v_old.status = 'OUVERT' then
    if public.incident_can_close(v_old, v_actor) is not true then raise exception 'not_authorized'; end if;
    if v_note is null or char_length(v_note) < 3 then raise exception 'reason_required'; end if;
    v_closed := clock_timestamp();
  else
    raise exception 'invalid_transition';
  end if;

  begin
    update public.incidents
    set status = p_to_status, resolution = v_resolution, closed_at_server = v_closed, revision = revision + 1
    where id = v_old.id
    returning * into v_row;
  exception
    when check_violation then raise exception 'incident_invalid';
  end;

  insert into public.incident_events (incident_id, project_id, event_type, actor_profile_id, actor_role, actor_owner_profile,
                                      from_status, to_status, changes, reason)
  values (v_row.id, v_row.project_id, 'TRANSITION', v_actor.profile_id, v_actor.role, v_actor.owner_profile,
          v_old.status, v_row.status,
          case when v_row.resolution is distinct from v_old.resolution
               then jsonb_build_object('resolution', jsonb_build_object('old', v_old.resolution, 'new', v_row.resolution))
               else '{}'::jsonb end,
          v_note);
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_actor.profile_id, 'INCIDENT_TRANSITION', 'incidents', v_row.id, 'SUCCESS',
          jsonb_build_object('from', v_old.status, 'to', v_row.status), coalesce(v_note, 'Changement d''état de l''incident.'));
  return v_row;
end;
$$;

revoke execute on function public.correct_incident(uuid, integer, text, text, text, timestamptz, text) from public, anon, authenticated, service_role;
revoke execute on function public.assign_incident(uuid, integer, uuid, date) from public, anon, authenticated, service_role;
revoke execute on function public.transition_incident(uuid, integer, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.correct_incident(uuid, integer, text, text, text, timestamptz, text) to authenticated;
grant execute on function public.assign_incident(uuid, integer, uuid, date) to authenticated;
grant execute on function public.transition_incident(uuid, integer, text, text, text) to authenticated;

commit;
