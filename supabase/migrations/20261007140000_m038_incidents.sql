-- M038 — B024 : créer et faire évoluer les incidents (done_when :
-- « transitions invalides refusées »). Décisions du fondateur 2026-10-07 :
-- D159–D166 (L1–L8). Conception : MIGRATION_ORDER.csv M016
-- (« incidents incident_events »), T032/T033, OP009, API049/API050 ;
-- identifiant M016 jamais réutilisé comme nom de fichier.
--
-- - Création (FR101, AC101, INCIDENT_CREATE) : tout membre ACTIF du
--   chantier, compte vérifié ; directement OUVERT (D161) ; gravité en
--   4 niveaux (D159) ; type en liste fermée (D160) ; date de survenue non
--   future ; aucun lien d'étape (D166) ; lien facultatif vers un incident
--   CLOS du même chantier (D165).
-- - Lecture (INCIDENT_VIEW) : tout membre actif, propriétaires compris ;
--   non-membre : rien.
-- - Modifier (INCIDENT_UPDATE, D162) : entreprise, chef de chantier,
--   déclarant, responsable désigné ; propriétaire principal : ses propres
--   incidents ou ceux dont il est responsable ; copropriétaire : ses propres
--   incidents seulement.
-- - Clore (INCIDENT_CLOSE, D162) : entreprise, ou responsable désigné ;
--   propriétaire principal : ses propres incidents ou ceux dont il est
--   responsable ; copropriétaire : jamais ; chef de chantier : seulement
--   responsable désigné. L'annulation (OUVERT -> ANNULE, D165), état
--   terminal, suit le même droit que la clôture, avec motif.
-- - Désigner (FR104, D163) : entreprise ou propriétaire principal ; tout
--   membre actif ; échéance facultative ; chaque changement tracé.
-- - Correction (D164) : type, gravité, date, description, par événement
--   avec motif ; l'ancienne valeur reste dans l'historique.
-- - Transitions (STATE_MACHINES incident, D165) : seules celles listées
--   sont acceptées, revérifiées par un déclencheur même pour service_role ;
--   aucune réouverture d'un incident clos.
-- - Historique incident_events en insertion seule ; audit_events à chaque
--   action. Notifications et alertes (B045), médias, commentaires, hors
--   ligne : hors périmètre.

begin;

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  reporter_profile_id uuid not null references public.profiles (id) on delete restrict,
  reporter_role text not null check (reporter_role in ('OWNER', 'CONTRACTOR', 'SITE_MANAGER')),
  reporter_owner_profile text null check (reporter_owner_profile in ('PRIMARY', 'CO_OWNER')),
  incident_type text not null,
  severity text not null,
  occurred_at timestamptz not null,
  description text not null,
  status text not null default 'OUVERT',
  assignee_profile_id uuid null references public.profiles (id) on delete restrict,
  due_date date null,
  resolution text null,
  linked_incident_id uuid null,
  revision integer not null default 0 check (revision >= 0),
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  closed_at_server timestamptz null,
  constraint incidents_id_project_unique unique (id, project_id),
  constraint incidents_linked_same_project foreign key (linked_incident_id, project_id)
    references public.incidents (id, project_id) on delete restrict,
  constraint incidents_type_known check (incident_type in ('SECURITE', 'MALFACON', 'RETARD', 'MATERIAUX', 'INTEMPERIES', 'AUTRE')),
  constraint incidents_severity_known check (severity in ('FAIBLE', 'MOYENNE', 'ELEVEE', 'URGENTE')),
  constraint incidents_status_known check (status in ('OUVERT', 'AFFECTE', 'EN_COURS', 'RESOLU', 'CLOS', 'ANNULE')),
  constraint incidents_description_bounds check (char_length(btrim(description)) between 5 and 2000),
  constraint incidents_resolution_bounds check (resolution is null or char_length(btrim(resolution)) between 3 and 2000),
  constraint incidents_resolution_required check (status not in ('RESOLU', 'CLOS') or resolution is not null),
  constraint incidents_assigned_has_assignee check (status <> 'AFFECTE' or assignee_profile_id is not null),
  constraint incidents_terminal_consistency check ((status in ('CLOS', 'ANNULE')) = (closed_at_server is not null)),
  constraint incidents_owner_profile_consistency check ((reporter_role = 'OWNER') = (reporter_owner_profile is not null))
);

create index incidents_project_idx on public.incidents (project_id, created_at_server desc);

alter table public.incidents enable row level security;
revoke all privileges on table public.incidents from public, anon, authenticated;

create table public.incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null,
  project_id uuid not null,
  event_type text not null check (event_type in ('CREATION', 'CORRECTION', 'DESIGNATION', 'TRANSITION')),
  actor_profile_id uuid not null references public.profiles (id) on delete restrict,
  actor_role text not null check (actor_role in ('OWNER', 'CONTRACTOR', 'SITE_MANAGER')),
  actor_owner_profile text null check (actor_owner_profile in ('PRIMARY', 'CO_OWNER')),
  from_status text null,
  to_status text null,
  changes jsonb not null default '{}'::jsonb,
  reason text null check (reason is null or char_length(reason) <= 1000),
  created_at_server timestamptz not null default now(),
  constraint incident_events_incident_fk foreign key (incident_id, project_id)
    references public.incidents (id, project_id) on delete restrict
);

create index incident_events_incident_idx on public.incident_events (incident_id, created_at_server);

alter table public.incident_events enable row level security;
revoke all privileges on table public.incident_events from public, anon, authenticated;

create function public.reject_incident_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'incident_event_immutable';
end;
$$;

create trigger reject_mutation
before update or delete on public.incident_events
for each row execute function public.reject_incident_event_mutation();

revoke execute on function public.reject_incident_event_mutation() from public, anon, authenticated, service_role;

-- Garde : jamais de suppression, identité figée, états terminaux figés,
-- seules les transitions de la machine d'états (D165).
create function public.guard_incident_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'incident_immutable';
  end if;
  if new.id <> old.id
     or new.project_id <> old.project_id
     or new.reporter_profile_id <> old.reporter_profile_id
     or new.reporter_role <> old.reporter_role
     or new.reporter_owner_profile is distinct from old.reporter_owner_profile
     or new.linked_incident_id is distinct from old.linked_incident_id
     or new.created_at_server <> old.created_at_server then
    raise exception 'incident_immutable';
  end if;
  if old.status in ('CLOS', 'ANNULE') then
    raise exception 'incident_terminal';
  end if;
  if new.status <> old.status and (old.status, new.status) not in (
    ('OUVERT', 'AFFECTE'), ('OUVERT', 'EN_COURS'), ('AFFECTE', 'EN_COURS'),
    ('EN_COURS', 'RESOLU'), ('RESOLU', 'EN_COURS'), ('RESOLU', 'CLOS'), ('OUVERT', 'ANNULE')
  ) then
    raise exception 'invalid_transition';
  end if;
  new.updated_at_server := clock_timestamp();
  return new;
end;
$$;

create trigger guard_mutation
before update or delete on public.incidents
for each row execute function public.guard_incident_mutation();

revoke execute on function public.guard_incident_mutation() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Contrôles communs.
-- ---------------------------------------------------------------------------
create type public.incident_actor as (profile_id uuid, role text, owner_profile text);

-- Lecteur : session et adhésion active (INCIDENT_VIEW).
create function public.incident_require_member(p_project_id uuid)
returns public.incident_actor
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_actor public.incident_actor;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select v_uid, m.role, m.owner_profile into v_actor
  from public.project_memberships m
  where m.project_id = p_project_id and m.profile_id = v_uid and m.revoked_at is null
    and m.role in ('OWNER', 'CONTRACTOR', 'SITE_MANAGER');
  if not found then
    raise exception 'not_authorized';
  end if;
  return v_actor;
end;
$$;

-- Écriture : en plus, compte vérifié.
create function public.incident_require_writer(p_project_id uuid)
returns public.incident_actor
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor public.incident_actor := public.incident_require_member(p_project_id);
begin
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

create function public.incident_can_update(p_incident public.incidents, p_actor public.incident_actor)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select p_actor.role in ('CONTRACTOR', 'SITE_MANAGER')
      or p_incident.reporter_profile_id = p_actor.profile_id
      or (p_incident.assignee_profile_id = p_actor.profile_id
          and not (p_actor.role = 'OWNER' and p_actor.owner_profile = 'CO_OWNER'));
$$;

create function public.incident_can_close(p_incident public.incidents, p_actor public.incident_actor)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select p_actor.role = 'CONTRACTOR'
      or (not (p_actor.role = 'OWNER' and p_actor.owner_profile = 'CO_OWNER')
          and (p_incident.assignee_profile_id = p_actor.profile_id
               or (p_actor.role = 'OWNER' and p_actor.owner_profile = 'PRIMARY'
                   and p_incident.reporter_profile_id = p_actor.profile_id)));
$$;

create function public.incident_can_assign(p_actor public.incident_actor)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select p_actor.role = 'CONTRACTOR' or (p_actor.role = 'OWNER' and p_actor.owner_profile = 'PRIMARY');
$$;

revoke execute on function public.incident_require_member(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.incident_require_writer(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.incident_can_update(public.incidents, public.incident_actor) from public, anon, authenticated, service_role;
revoke execute on function public.incident_can_close(public.incidents, public.incident_actor) from public, anon, authenticated, service_role;
revoke execute on function public.incident_can_assign(public.incident_actor) from public, anon, authenticated, service_role;

-- Verrouille l'incident, vérifie l'écrivain, la révision et l'état non
-- terminal. Un incident inconnu et un chantier non accessible donnent le
-- même refus (anti-énumération).
create function public.incident_lock_for_write(p_incident_id uuid, p_expected_revision integer)
returns public.incidents
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.incidents;
begin
  select * into v_row from public.incidents where id = p_incident_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;
  perform public.incident_require_writer(v_row.project_id);
  if p_expected_revision is null or p_expected_revision <> v_row.revision then
    raise exception 'revision_conflict';
  end if;
  if v_row.status in ('CLOS', 'ANNULE') then
    raise exception 'incident_terminal';
  end if;
  return v_row;
end;
$$;

revoke execute on function public.incident_lock_for_write(uuid, integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Création (FR101, AC101).
-- ---------------------------------------------------------------------------
create function public.create_incident(
  p_project_id uuid,
  p_incident_type text,
  p_severity text,
  p_occurred_at timestamptz,
  p_description text,
  p_linked_incident_id uuid default null
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
  if p_linked_incident_id is not null and not exists (
    select 1 from public.incidents where id = p_linked_incident_id and project_id = p_project_id and status = 'CLOS'
  ) then
    raise exception 'linked_incident_invalid';
  end if;
  begin
    insert into public.incidents (project_id, reporter_profile_id, reporter_role, reporter_owner_profile, incident_type,
                                  severity, occurred_at, description, linked_incident_id)
    values (p_project_id, v_actor.profile_id, v_actor.role, v_actor.owner_profile, p_incident_type, p_severity,
            p_occurred_at, btrim(coalesce(p_description, '')), p_linked_incident_id)
    returning * into v_row;
  exception
    when check_violation then raise exception 'incident_invalid';
  end;

  insert into public.incident_events (incident_id, project_id, event_type, actor_profile_id, actor_role, actor_owner_profile,
                                      to_status, changes)
  values (v_row.id, v_row.project_id, 'CREATION', v_actor.profile_id, v_actor.role, v_actor.owner_profile, v_row.status,
          jsonb_build_object('incident_type', v_row.incident_type, 'severity', v_row.severity,
                             'occurred_at', v_row.occurred_at, 'description', v_row.description,
                             'linked_incident_id', v_row.linked_incident_id));
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_actor.profile_id, 'INCIDENT_CREATE', 'incidents', v_row.id, 'SUCCESS',
          jsonb_build_object('severity', v_row.severity, 'incident_type', v_row.incident_type), 'Incident déclaré.');
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Correction des champs (D164) : motif obligatoire, ancienne valeur tracée.
-- ---------------------------------------------------------------------------
create function public.correct_incident(
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
  if not public.incident_can_update(v_old, v_actor) then
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

-- ---------------------------------------------------------------------------
-- Désignation du responsable (FR104, D163).
-- ---------------------------------------------------------------------------
create function public.assign_incident(
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
  if not public.incident_can_assign(v_actor) then
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

-- ---------------------------------------------------------------------------
-- Changement d'état (OP009, API050, D162, D165).
-- ---------------------------------------------------------------------------
create function public.transition_incident(
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
    if not public.incident_can_update(v_old, v_actor) then raise exception 'not_authorized'; end if;
  elsif p_to_status = 'RESOLU' and v_old.status = 'EN_COURS' then
    if not public.incident_can_update(v_old, v_actor) then raise exception 'not_authorized'; end if;
    v_resolution := nullif(btrim(coalesce(p_resolution, '')), '');
    if v_resolution is null or char_length(v_resolution) < 3 then raise exception 'resolution_required'; end if;
  elsif p_to_status = 'EN_COURS' and v_old.status = 'RESOLU' then
    if not public.incident_can_update(v_old, v_actor) then raise exception 'not_authorized'; end if;
    if v_note is null or char_length(v_note) < 3 then raise exception 'reason_required'; end if;
    v_resolution := null;
  elsif p_to_status = 'CLOS' and v_old.status = 'RESOLU' then
    if not public.incident_can_close(v_old, v_actor) then raise exception 'not_authorized'; end if;
    v_closed := clock_timestamp();
  elsif p_to_status = 'ANNULE' and v_old.status = 'OUVERT' then
    if not public.incident_can_close(v_old, v_actor) then raise exception 'not_authorized'; end if;
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

-- ---------------------------------------------------------------------------
-- Lecture (INCIDENT_VIEW) : tout membre actif ; droits calculés au serveur.
-- ---------------------------------------------------------------------------
create type public.incident_view as (
  id uuid,
  project_id uuid,
  incident_type text,
  severity text,
  occurred_at timestamptz,
  description text,
  status text,
  reporter_role text,
  reporter_owner_profile text,
  reporter_is_me boolean,
  assignee_profile_id uuid,
  assignee_role text,
  assignee_owner_profile text,
  assignee_is_me boolean,
  due_date date,
  resolution text,
  linked_incident_id uuid,
  revision integer,
  created_at_server timestamptz,
  updated_at_server timestamptz,
  closed_at_server timestamptz,
  can_update boolean,
  can_close boolean,
  can_assign boolean
);

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
           i.assignee_profile_id, am.role, am.owner_profile, i.assignee_profile_id is not distinct from v_actor.profile_id,
           i.due_date, i.resolution, i.linked_incident_id, i.revision, i.created_at_server, i.updated_at_server, i.closed_at_server,
           i.status not in ('CLOS', 'ANNULE') and public.incident_can_update(i, v_actor),
           i.status not in ('CLOS', 'ANNULE') and public.incident_can_close(i, v_actor),
           i.status not in ('CLOS', 'ANNULE') and public.incident_can_assign(v_actor)
    from public.incidents i
    left join public.project_memberships am
      on am.project_id = i.project_id and am.profile_id = i.assignee_profile_id and am.revoked_at is null
    where i.project_id = p_project_id
    order by (i.status in ('CLOS', 'ANNULE')), i.created_at_server desc
    limit v_limit offset v_offset;
end;
$$;

create function public.get_incident_history(p_incident_id uuid)
returns setof public.incident_events
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_project uuid;
begin
  select project_id into v_project from public.incidents where id = p_incident_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  perform public.incident_require_member(v_project);
  return query
    select * from public.incident_events where incident_id = p_incident_id order by created_at_server, id;
end;
$$;

revoke execute on function public.create_incident(uuid, text, text, timestamptz, text, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.correct_incident(uuid, integer, text, text, text, timestamptz, text) from public, anon, authenticated, service_role;
revoke execute on function public.assign_incident(uuid, integer, uuid, date) from public, anon, authenticated, service_role;
revoke execute on function public.transition_incident(uuid, integer, text, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.list_project_incidents(uuid, integer, integer) from public, anon, authenticated, service_role;
revoke execute on function public.get_incident_history(uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_incident(uuid, text, text, timestamptz, text, uuid) to authenticated;
grant execute on function public.correct_incident(uuid, integer, text, text, text, timestamptz, text) to authenticated;
grant execute on function public.assign_incident(uuid, integer, uuid, date) to authenticated;
grant execute on function public.transition_incident(uuid, integer, text, text, text) to authenticated;
grant execute on function public.list_project_incidents(uuid, integer, integer) to authenticated;
grant execute on function public.get_incident_history(uuid) to authenticated;

commit;
