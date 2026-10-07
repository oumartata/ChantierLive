-- M042 — lien des journaux et des incidents vers une étape (révision de
-- D149/J6 et D166/L8 par D182, fondateur 2026-10-07 ; accord d'application
-- en local). Jamais une réécriture de M036–M041 : colonnes et contraintes
-- ajoutées, fonctions reprises à l'identique de leur dernière version
-- (M037, M038, M038b, M038c) avec le seul lien en plus.
--
-- - Lien facultatif : daily_logs.phase_id (brouillon), daily_log_versions.
--   phase_id (chaque version publiée porte son lien), incidents.phase_id.
-- - Étape cible (phase_link_check) : active (non archivée), d'un plan publié,
--   du même chantier (vérifié aussi par clé étrangère composite) ; une étape
--   validée peut être ciblée et n'est jamais modifiée.
-- - Journal publié : lien figé (déclencheur) ; il ne change que par
--   correct_daily_log, nouvelle version liée avec motif. Incident : par
--   correct_incident, motif obligatoire, ancien et nouveau lien tracés.
-- - Sémantique inchangée des corrections : la liste des champs est complète
--   (un lien omis vaut « sans étape »), comme pour les autres champs.
-- - Lecture : le libellé de l'étape est renvoyé avec le journal publié et
--   l'incident, à tous ceux qui les voient déjà ; aucun droit nouveau.

begin;

-- ---------------------------------------------------------------------------
-- 1. Colonnes et clés étrangères composites (même chantier).
-- ---------------------------------------------------------------------------
alter table public.project_phases add constraint project_phases_id_project_unique unique (id, project_id);

alter table public.daily_logs add column phase_id uuid null;
alter table public.daily_logs add constraint daily_logs_phase_same_project
  foreign key (phase_id, project_id) references public.project_phases (id, project_id) on delete restrict;
alter table public.daily_log_versions add column phase_id uuid null;
alter table public.daily_log_versions add constraint daily_log_versions_phase_same_project
  foreign key (phase_id, project_id) references public.project_phases (id, project_id) on delete restrict;
alter table public.incidents add column phase_id uuid null;
alter table public.incidents add constraint incidents_phase_same_project
  foreign key (phase_id, project_id) references public.project_phases (id, project_id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 2. Contrôle de l'étape cible.
-- ---------------------------------------------------------------------------
create function public.phase_link_check(p_project_id uuid, p_phase_id uuid)
returns void
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_phase_id is null then
    return;
  end if;
  if not exists (
    select 1
    from public.project_phases p
    join public.project_phase_plans pl on pl.id = p.plan_id and pl.status = 'PUBLIE'
    where p.id = p_phase_id and p.project_id = p_project_id and p.archived_at is null
  ) then
    raise exception 'phase_link_invalid';
  end if;
end;
$$;

revoke execute on function public.phase_link_check(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Journal (M037 repris).
-- ---------------------------------------------------------------------------
drop function public.create_daily_log_draft(uuid, date, text, text, text, text);
drop function public.update_daily_log_draft(uuid, integer, date, text, text, text, text);
drop function public.correct_daily_log(uuid, integer, text, text, text, text, text);

create function public.create_daily_log_draft(
  p_project_id uuid,
  p_log_date date,
  p_works_done text,
  p_difficulties text,
  p_team text,
  p_next_actions text,
  p_phase_id uuid default null
)
returns public.daily_logs
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := public.daily_log_require_author_role(p_project_id);
  v_row public.daily_logs;
begin
  if p_log_date is null then
    raise exception 'log_date_required';
  end if;
  perform public.phase_link_check(p_project_id, p_phase_id);
  if exists (
    select 1 from public.daily_logs
    where project_id = p_project_id and author_profile_id = v_uid and log_date = p_log_date and status = 'PUBLIE'
  ) then
    raise exception 'daily_log_already_published';
  end if;
  begin
    insert into public.daily_logs (project_id, author_profile_id, log_date, works_done, difficulties, team, next_actions, phase_id)
    values (p_project_id, v_uid, p_log_date, nullif(btrim(p_works_done), ''), nullif(btrim(p_difficulties), ''),
            nullif(btrim(p_team), ''), nullif(btrim(p_next_actions), ''), p_phase_id)
    returning * into v_row;
  exception
    when unique_violation then raise exception 'daily_log_draft_exists';
    when check_violation then raise exception 'daily_log_invalid';
  end;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (p_project_id, 'HUMAN', v_uid, 'DAILY_LOG_DRAFT_CREATE', 'daily_logs', v_row.id, 'SUCCESS',
          jsonb_build_object('log_date', v_row.log_date), 'Brouillon de journal quotidien créé.');
  return v_row;
end;
$$;

create function public.update_daily_log_draft(
  p_log_id uuid,
  p_expected_revision integer,
  p_log_date date,
  p_works_done text,
  p_difficulties text,
  p_team text,
  p_next_actions text,
  p_phase_id uuid default null
)
returns public.daily_logs
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_log public.daily_logs;
  v_uid uuid;
begin
  select * into v_log from public.daily_logs where id = p_log_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;
  v_uid := public.daily_log_require_author_role(v_log.project_id);
  if v_log.author_profile_id <> v_uid or v_log.status <> 'BROUILLON' then
    raise exception 'not_authorized';
  end if;
  if p_expected_revision is null or p_expected_revision <> v_log.revision then
    raise exception 'revision_conflict';
  end if;
  if p_log_date is null then
    raise exception 'log_date_required';
  end if;
  perform public.phase_link_check(v_log.project_id, p_phase_id);
  begin
    update public.daily_logs
    set log_date = p_log_date,
        works_done = nullif(btrim(p_works_done), ''),
        difficulties = nullif(btrim(p_difficulties), ''),
        team = nullif(btrim(p_team), ''),
        next_actions = nullif(btrim(p_next_actions), ''),
        phase_id = p_phase_id,
        revision = revision + 1
    where id = p_log_id
    returning * into v_log;
  exception
    when unique_violation then
      if exists (select 1 from public.daily_logs where project_id = v_log.project_id and author_profile_id = v_uid and log_date = p_log_date and status = 'PUBLIE') then
        raise exception 'daily_log_already_published';
      end if;
      raise exception 'daily_log_draft_exists';
    when check_violation then raise exception 'daily_log_invalid';
  end;
  return v_log;
end;
$$;

create or replace function public.publish_daily_log_draft(p_log_id uuid, p_expected_revision integer)
returns public.daily_logs
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_log public.daily_logs;
  v_uid uuid;
  v_role text;
  v_version_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_log from public.daily_logs where id = p_log_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;
  v_uid := public.daily_log_require_author_role(v_log.project_id);
  if v_log.author_profile_id <> v_uid or v_log.status <> 'BROUILLON' then
    raise exception 'not_authorized';
  end if;
  if p_expected_revision is null or p_expected_revision <> v_log.revision then
    raise exception 'revision_conflict';
  end if;
  if coalesce(v_log.works_done, '') = '' and coalesce(v_log.difficulties, '') = ''
     and coalesce(v_log.team, '') = '' and coalesce(v_log.next_actions, '') = '' then
    raise exception 'daily_log_empty';
  end if;
  select role into v_role from public.project_memberships
  where project_id = v_log.project_id and profile_id = v_uid and revoked_at is null;

  perform public.phase_link_check(v_log.project_id, v_log.phase_id);
  insert into public.daily_log_versions (daily_log_id, project_id, version_number, works_done, difficulties, team, next_actions,
                                         published_by_profile_id, published_by_role, created_at_server, phase_id)
  values (v_log.id, v_log.project_id, 1, v_log.works_done, v_log.difficulties, v_log.team, v_log.next_actions, v_uid, v_role, v_now, v_log.phase_id)
  returning id into v_version_id;

  update public.daily_logs
  set status = 'PUBLIE', published_at_server = v_now, current_version_id = v_version_id, revision = revision + 1
  where id = v_log.id
  returning * into v_log;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_log.project_id, 'HUMAN', v_uid, 'DAILY_LOG_PUBLISH', 'daily_log_versions', v_version_id, 'SUCCESS',
          jsonb_build_object('daily_log_id', v_log.id, 'log_date', v_log.log_date, 'version_number', 1),
          'Journal quotidien publié.');
  return v_log;
end;
$$;

create function public.correct_daily_log(
  p_log_id uuid,
  p_expected_version_number integer,
  p_reason text,
  p_works_done text,
  p_difficulties text,
  p_team text,
  p_next_actions text,
  p_phase_id uuid default null
)
returns public.daily_log_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_log public.daily_logs;
  v_current public.daily_log_versions;
  v_uid uuid;
  v_role text;
  v_row public.daily_log_versions;
begin
  select * into v_log from public.daily_logs where id = p_log_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;
  v_uid := public.daily_log_require_author_role(v_log.project_id);
  select role into v_role from public.project_memberships
  where project_id = v_log.project_id and profile_id = v_uid and revoked_at is null;
  if v_log.status <> 'PUBLIE' or not (v_log.author_profile_id = v_uid or v_role = 'CONTRACTOR') then
    raise exception 'not_authorized';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'reason_required';
  end if;
  select * into v_current from public.daily_log_versions where id = v_log.current_version_id;
  if p_expected_version_number is null or p_expected_version_number <> v_current.version_number then
    raise exception 'revision_conflict';
  end if;
  if coalesce(btrim(p_works_done), '') = '' and coalesce(btrim(p_difficulties), '') = ''
     and coalesce(btrim(p_team), '') = '' and coalesce(btrim(p_next_actions), '') = '' then
    raise exception 'daily_log_empty';
  end if;
  -- Lien vérifié seulement s'il change (un lien conservé vers une étape
  -- retirée depuis reste tel quel, jamais réécrit).
  if p_phase_id is distinct from v_current.phase_id then
    perform public.phase_link_check(v_log.project_id, p_phase_id);
  end if;
  begin
    insert into public.daily_log_versions (daily_log_id, project_id, version_number, supersedes_version_id, works_done, difficulties,
                                           team, next_actions, published_by_profile_id, published_by_role, reason, created_at_server, phase_id)
    values (v_log.id, v_log.project_id, v_current.version_number + 1, v_current.id, nullif(btrim(p_works_done), ''),
            nullif(btrim(p_difficulties), ''), nullif(btrim(p_team), ''), nullif(btrim(p_next_actions), ''), v_uid, v_role,
            btrim(p_reason), clock_timestamp(), p_phase_id)
    returning * into v_row;
  exception
    when check_violation then raise exception 'daily_log_invalid';
  end;

  update public.daily_logs set current_version_id = v_row.id, revision = revision + 1 where id = v_log.id;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_log.project_id, 'HUMAN', v_uid, 'DAILY_LOG_CORRECT', 'daily_log_versions', v_row.id, 'SUCCESS',
          jsonb_build_object('daily_log_id', v_log.id, 'log_date', v_log.log_date, 'version_number', v_row.version_number,
                             'supersedes_version_id', v_current.id,
                             'phase_id', p_phase_id, 'previous_phase_id', v_current.phase_id),
          btrim(p_reason));
  return v_row;
end;
$$;

create or replace function public.guard_daily_log_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'daily_log_immutable';
  end if;
  if old.status = 'ARCHIVE' then
    raise exception 'daily_log_archived';
  end if;
  if new.id <> old.id
     or new.project_id <> old.project_id
     or new.author_profile_id <> old.author_profile_id
     or new.created_at_server <> old.created_at_server then
    raise exception 'daily_log_immutable';
  end if;
  if old.status = 'PUBLIE' then
    if new.status <> 'PUBLIE'
       or new.log_date <> old.log_date
       or new.works_done is distinct from old.works_done
       or new.difficulties is distinct from old.difficulties
       or new.team is distinct from old.team
       or new.next_actions is distinct from old.next_actions
       or new.phase_id is distinct from old.phase_id
       or new.published_at_server is distinct from old.published_at_server then
      raise exception 'daily_log_published_immutable';
    end if;
  end if;
  new.updated_at_server := clock_timestamp();
  return new;
end;
$$;

-- Lecture des journaux publiés (M037 reprise) : lien de la version courante.
drop function public.list_published_daily_logs(uuid, integer, integer);
alter type public.daily_log_published_view add attribute phase_id uuid;
alter type public.daily_log_published_view add attribute phase_label text;
alter type public.daily_log_published_view add attribute phase_archived boolean;

create function public.list_published_daily_logs(p_project_id uuid, p_limit integer default 20, p_offset integer default 0)
returns setof public.daily_log_published_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := public.daily_log_require_reader(p_project_id);
  v_role text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  select role into v_role from public.project_memberships
  where project_id = p_project_id and profile_id = v_uid and revoked_at is null;
  return query
    select l.id, l.log_date, l.author_profile_id, l.author_profile_id = v_uid, l.published_at_server,
           v.version_number, v.published_by_role, v.created_at_server, v.reason,
           v.works_done, v.difficulties, v.team, v.next_actions,
           (v_role = 'CONTRACTOR' or (v_role = 'SITE_MANAGER' and l.author_profile_id = v_uid)),
           v.phase_id, ph.label, ph.archived_at is not null
    from public.daily_logs l
    join public.daily_log_versions v on v.id = l.current_version_id
    left join public.project_phases ph on ph.id = v.phase_id
    where l.project_id = p_project_id and l.status = 'PUBLIE'
    order by l.log_date desc, l.published_at_server desc
    limit v_limit offset v_offset;
end;
$$;

revoke execute on function public.create_daily_log_draft(uuid, date, text, text, text, text, uuid),
  public.update_daily_log_draft(uuid, integer, date, text, text, text, text, uuid),
  public.correct_daily_log(uuid, integer, text, text, text, text, text, uuid),
  public.list_published_daily_logs(uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.create_daily_log_draft(uuid, date, text, text, text, text, uuid),
  public.update_daily_log_draft(uuid, integer, date, text, text, text, text, uuid),
  public.correct_daily_log(uuid, integer, text, text, text, text, text, uuid),
  public.list_published_daily_logs(uuid, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Incidents (M038/M038b/M038c repris).
-- ---------------------------------------------------------------------------
drop function public.create_incident(uuid, text, text, timestamptz, text, uuid);
drop function public.correct_incident(uuid, integer, text, text, text, timestamptz, text);

create function public.create_incident(
  p_project_id uuid,
  p_incident_type text,
  p_severity text,
  p_occurred_at timestamptz,
  p_description text,
  p_linked_incident_id uuid default null,
  p_phase_id uuid default null
)
returns public.incidents
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor public.incident_actor := public.incident_require_writer(p_project_id);
  v_row public.incidents;
begin
  if p_occurred_at is null then
    raise exception 'occurred_at_required';
  end if;
  if p_occurred_at > now() + interval '5 minutes' then
    raise exception 'occurred_in_future';
  end if;
  perform public.phase_link_check(p_project_id, p_phase_id);
  if p_linked_incident_id is not null and not exists (
    select 1 from public.incidents where id = p_linked_incident_id and project_id = p_project_id and status = 'CLOS'
  ) then
    raise exception 'linked_incident_invalid';
  end if;
  begin
    insert into public.incidents (project_id, reporter_profile_id, reporter_role, reporter_owner_profile, incident_type,
                                  severity, occurred_at, description, linked_incident_id, phase_id)
    values (p_project_id, v_actor.profile_id, v_actor.role, v_actor.owner_profile, p_incident_type, p_severity,
            p_occurred_at, btrim(coalesce(p_description, '')), p_linked_incident_id, p_phase_id)
    returning * into v_row;
  exception
    when check_violation then raise exception 'incident_invalid';
  end;

  insert into public.incident_events (incident_id, project_id, event_type, actor_profile_id, actor_role, actor_owner_profile,
                                      to_status, changes)
  values (v_row.id, v_row.project_id, 'CREATION', v_actor.profile_id, v_actor.role, v_actor.owner_profile, v_row.status,
          jsonb_build_object('incident_type', v_row.incident_type, 'severity', v_row.severity,
                             'occurred_at', v_row.occurred_at, 'description', v_row.description,
                             'linked_incident_id', v_row.linked_incident_id, 'phase_id', v_row.phase_id));
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_actor.profile_id, 'INCIDENT_CREATE', 'incidents', v_row.id, 'SUCCESS',
          jsonb_build_object('severity', v_row.severity, 'incident_type', v_row.incident_type), 'Incident déclaré.');
  return v_row;
end;
$$;

create function public.correct_incident(
  p_incident_id uuid,
  p_expected_revision integer,
  p_reason text,
  p_incident_type text,
  p_severity text,
  p_occurred_at timestamptz,
  p_description text,
  p_phase_id uuid default null
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
  if p_phase_id is distinct from v_old.phase_id then
    perform public.phase_link_check(v_old.project_id, p_phase_id);
      v_changes := v_changes || jsonb_build_object('phase_id', jsonb_build_object('old', v_old.phase_id, 'new', p_phase_id));
  end if;
  if v_changes = '{}'::jsonb then
    raise exception 'no_change';
  end if;
  begin
    update public.incidents
    set incident_type = p_incident_type, severity = p_severity, occurred_at = p_occurred_at, description = v_description, phase_id = p_phase_id,
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

drop function public.list_project_incidents(uuid, integer, integer);
alter type public.incident_view add attribute phase_id uuid;
alter type public.incident_view add attribute phase_label text;
alter type public.incident_view add attribute phase_archived boolean;

create function public.list_project_incidents(p_project_id uuid, p_limit integer default 50, p_offset integer default 0)
returns setof public.incident_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor public.incident_actor := public.incident_require_member(p_project_id);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  return query
    select i.id, i.project_id, i.incident_type, i.severity, i.occurred_at, i.description, i.status,
           i.reporter_role, i.reporter_owner_profile, i.reporter_profile_id = v_actor.profile_id,
           i.assignee_profile_id, am.role::text, am.owner_profile::text, i.assignee_profile_id is not distinct from v_actor.profile_id,
           i.due_date, i.resolution, i.linked_incident_id, i.revision, i.created_at_server, i.updated_at_server, i.closed_at_server,
           i.status not in ('CLOS', 'ANNULE') and public.incident_can_update(i, v_actor),
           i.status not in ('CLOS', 'ANNULE') and public.incident_can_close(i, v_actor),
           i.status not in ('CLOS', 'ANNULE') and public.incident_can_assign(v_actor),
           i.phase_id, ph.label, ph.archived_at is not null
    from public.incidents i
    left join public.project_memberships am
      on am.project_id = i.project_id and am.profile_id = i.assignee_profile_id and am.revoked_at is null
    left join public.project_phases ph on ph.id = i.phase_id
    where i.project_id = p_project_id
    order by (i.status in ('CLOS', 'ANNULE')), i.created_at_server desc
    limit v_limit offset v_offset;
end;
$$;

revoke execute on function public.create_incident(uuid, text, text, timestamptz, text, uuid, uuid),
  public.correct_incident(uuid, integer, text, text, text, timestamptz, text, uuid),
  public.list_project_incidents(uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.create_incident(uuid, text, text, timestamptz, text, uuid, uuid),
  public.correct_incident(uuid, integer, text, text, text, timestamptz, text, uuid),
  public.list_project_incidents(uuid, integer, integer)
  to authenticated;

commit;
