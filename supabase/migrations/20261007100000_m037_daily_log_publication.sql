-- M037 — B022 : publier et corriger le journal quotidien (« nouvelle version
-- liée »). Décisions du fondateur 2026-10-07 : D151–D156 (K1–K6), en plus de
-- D144–D150 (M036).
--
-- - Publication (FR056, AC056) : par l'AUTEUR du brouillon (entreprise ou
--   chef de chantier actif, compte vérifié), si au moins une rubrique est
--   remplie (D153) ; crée la version 1, attribuée et horodatée par le
--   serveur ; le brouillon devient PUBLIE, son contenu est figé.
-- - Correction (FR058, AC058, BR038, EC025) : par l'auteur, ou par
--   l'entreprise sur tous les journaux du chantier (D151) ; publiée
--   immédiatement en NOUVELLE version liée (D152), motif obligatoire ; la
--   version précédente reste lisible ; aucun délai (D154). La date du
--   journal n'est pas corrigeable (identité du journal, contenu seul).
-- - Un journal publié n'est JAMAIS modifié : versions en insertion seule.
-- - Lecture (FR057, JOURNAL_VIEW, D156) : tout membre ACTIF du chantier,
--   propriétaires compris, voit les journaux publiés, leur version courante
--   et leur historique complet (motifs, rôle de l'auteur, dates) ; jamais
--   un brouillon.
-- - D155 : un brouillon du même auteur, chantier et date est refusé tant
--   qu'un journal publié existe déjà pour ce triplet.

begin;

-- ---------------------------------------------------------------------------
-- Versions publiées (T016), insertion seule.
-- ---------------------------------------------------------------------------
create table public.daily_log_versions (
  id uuid primary key default gen_random_uuid(),
  daily_log_id uuid not null references public.daily_logs (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  version_number integer not null check (version_number >= 1),
  supersedes_version_id uuid null references public.daily_log_versions (id) on delete restrict,
  works_done text null,
  difficulties text null,
  team text null,
  next_actions text null,
  published_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  published_by_role text not null check (published_by_role in ('CONTRACTOR', 'SITE_MANAGER')),
  -- Motif : absent pour la publication initiale, obligatoire pour une
  -- correction (EC025).
  reason text null,
  created_at_server timestamptz not null default now(),
  constraint daily_log_versions_number_unique unique (daily_log_id, version_number),
  constraint daily_log_versions_reason_rule check (
    (version_number = 1 and reason is null and supersedes_version_id is null)
    or (version_number > 1 and reason is not null and char_length(btrim(reason)) >= 3 and supersedes_version_id is not null)
  ),
  constraint daily_log_versions_text_bounds check (
    coalesce(char_length(works_done), 0) <= 4000
    and coalesce(char_length(difficulties), 0) <= 4000
    and coalesce(char_length(team), 0) <= 4000
    and coalesce(char_length(next_actions), 0) <= 4000
    and coalesce(char_length(reason), 0) <= 1000
  ),
  constraint daily_log_versions_not_empty check (
    coalesce(btrim(works_done), '') <> '' or coalesce(btrim(difficulties), '') <> ''
    or coalesce(btrim(team), '') <> '' or coalesce(btrim(next_actions), '') <> ''
  )
);

create index daily_log_versions_log_idx on public.daily_log_versions (daily_log_id, version_number);
create index daily_log_versions_project_idx on public.daily_log_versions (project_id);

alter table public.daily_log_versions enable row level security;
revoke all privileges on table public.daily_log_versions from public, anon, authenticated;

create function public.reject_daily_log_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'daily_log_version_immutable';
end;
$$;

create trigger reject_mutation
before update or delete on public.daily_log_versions
for each row execute function public.reject_daily_log_version_mutation();

revoke execute on function public.reject_daily_log_version_mutation() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- daily_logs : état PUBLIE, pointeur vers la version courante.
-- ---------------------------------------------------------------------------
alter table public.daily_logs
  add column published_at_server timestamptz null,
  add column current_version_id uuid null references public.daily_log_versions (id) on delete restrict;

alter table public.daily_logs drop constraint daily_logs_status_known;
alter table public.daily_logs add constraint daily_logs_status_known check (status in ('BROUILLON', 'PUBLIE', 'ARCHIVE'));
alter table public.daily_logs add constraint daily_logs_publication_consistency
  check ((status = 'PUBLIE') = (published_at_server is not null and current_version_id is not null));

-- D146 + D155 : au plus un journal ACTIF (brouillon ou publié) par auteur,
-- chantier et date.
drop index public.daily_logs_one_draft_per_author_date;
create unique index daily_logs_one_active_per_author_date
  on public.daily_logs (project_id, author_profile_id, log_date)
  where status in ('BROUILLON', 'PUBLIE');

-- Garde M036 reprise : identité figée, ARCHIVE terminal, jamais de
-- suppression ; un journal PUBLIE ne change plus que de version courante
-- (et de révision), jamais de contenu, de date ni d'état.
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
       or new.published_at_server is distinct from old.published_at_server then
      raise exception 'daily_log_published_immutable';
    end if;
  end if;
  new.updated_at_server := clock_timestamp();
  return new;
end;
$$;

-- Lecteur : membre actif du chantier (JOURNAL_VIEW), quel que soit son rôle.
create function public.daily_log_require_reader(p_project_id uuid)
returns uuid
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
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
  return v_uid;
end;
$$;

revoke execute on function public.daily_log_require_reader(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Création d'un brouillon : D155 (message distinct si un journal publié
-- existe déjà pour ce triplet). Corps M036 repris, une vérification ajoutée.
-- ---------------------------------------------------------------------------
create or replace function public.create_daily_log_draft(
  p_project_id uuid,
  p_log_date date,
  p_works_done text,
  p_difficulties text,
  p_team text,
  p_next_actions text
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
  if exists (
    select 1 from public.daily_logs
    where project_id = p_project_id and author_profile_id = v_uid and log_date = p_log_date and status = 'PUBLIE'
  ) then
    raise exception 'daily_log_already_published';
  end if;
  begin
    insert into public.daily_logs (project_id, author_profile_id, log_date, works_done, difficulties, team, next_actions)
    values (p_project_id, v_uid, p_log_date, nullif(btrim(p_works_done), ''), nullif(btrim(p_difficulties), ''),
            nullif(btrim(p_team), ''), nullif(btrim(p_next_actions), ''))
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

-- Modification d'un brouillon : même règle D155 si la date change vers un
-- triplet déjà publié (corps M036 repris).
create or replace function public.update_daily_log_draft(
  p_log_id uuid,
  p_expected_revision integer,
  p_log_date date,
  p_works_done text,
  p_difficulties text,
  p_team text,
  p_next_actions text
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
  begin
    update public.daily_logs
    set log_date = p_log_date,
        works_done = nullif(btrim(p_works_done), ''),
        difficulties = nullif(btrim(p_difficulties), ''),
        team = nullif(btrim(p_team), ''),
        next_actions = nullif(btrim(p_next_actions), ''),
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

-- ---------------------------------------------------------------------------
-- Publication (FR056, AC056, D153) — par l'auteur seul.
-- ---------------------------------------------------------------------------
create function public.publish_daily_log_draft(p_log_id uuid, p_expected_revision integer)
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

  insert into public.daily_log_versions (daily_log_id, project_id, version_number, works_done, difficulties, team, next_actions,
                                         published_by_profile_id, published_by_role, created_at_server)
  values (v_log.id, v_log.project_id, 1, v_log.works_done, v_log.difficulties, v_log.team, v_log.next_actions, v_uid, v_role, v_now)
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

-- ---------------------------------------------------------------------------
-- Correction (FR058, AC058, D151, D152) — nouvelle version liée, motif
-- obligatoire ; par l'auteur, ou par l'entreprise active.
-- ---------------------------------------------------------------------------
create function public.correct_daily_log(
  p_log_id uuid,
  p_expected_version_number integer,
  p_reason text,
  p_works_done text,
  p_difficulties text,
  p_team text,
  p_next_actions text
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
  begin
    insert into public.daily_log_versions (daily_log_id, project_id, version_number, supersedes_version_id, works_done, difficulties,
                                           team, next_actions, published_by_profile_id, published_by_role, reason, created_at_server)
    values (v_log.id, v_log.project_id, v_current.version_number + 1, v_current.id, nullif(btrim(p_works_done), ''),
            nullif(btrim(p_difficulties), ''), nullif(btrim(p_team), ''), nullif(btrim(p_next_actions), ''), v_uid, v_role,
            btrim(p_reason), clock_timestamp())
    returning * into v_row;
  exception
    when check_violation then raise exception 'daily_log_invalid';
  end;

  update public.daily_logs set current_version_id = v_row.id, revision = revision + 1 where id = v_log.id;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_log.project_id, 'HUMAN', v_uid, 'DAILY_LOG_CORRECT', 'daily_log_versions', v_row.id, 'SUCCESS',
          jsonb_build_object('daily_log_id', v_log.id, 'log_date', v_log.log_date, 'version_number', v_row.version_number,
                             'supersedes_version_id', v_current.id),
          btrim(p_reason));
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lecture (FR057, AC057, D156) : journaux publiés, version courante,
-- chronologie paginée ; jamais un brouillon.
-- ---------------------------------------------------------------------------
create type public.daily_log_published_view as (
  daily_log_id uuid,
  log_date date,
  author_profile_id uuid,
  author_is_me boolean,
  published_at_server timestamptz,
  current_version_number integer,
  current_published_by_role text,
  current_published_at_server timestamptz,
  current_reason text,
  works_done text,
  difficulties text,
  team text,
  next_actions text,
  can_correct boolean
);

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
           (v_role = 'CONTRACTOR' or (v_role = 'SITE_MANAGER' and l.author_profile_id = v_uid))
    from public.daily_logs l
    join public.daily_log_versions v on v.id = l.current_version_id
    where l.project_id = p_project_id and l.status = 'PUBLIE'
    order by l.log_date desc, l.published_at_server desc
    limit v_limit offset v_offset;
end;
$$;

create function public.get_daily_log_history(p_log_id uuid)
returns setof public.daily_log_versions
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_log public.daily_logs;
begin
  select * into v_log from public.daily_logs where id = p_log_id;
  if not found or v_log.status <> 'PUBLIE' then
    raise exception 'not_authorized';
  end if;
  perform public.daily_log_require_reader(v_log.project_id);
  return query
    select * from public.daily_log_versions where daily_log_id = p_log_id order by version_number desc;
end;
$$;

revoke execute on function public.publish_daily_log_draft(uuid, integer) from public, anon, authenticated, service_role;
revoke execute on function public.correct_daily_log(uuid, integer, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.list_published_daily_logs(uuid, integer, integer) from public, anon, authenticated, service_role;
revoke execute on function public.get_daily_log_history(uuid) from public, anon, authenticated, service_role;
grant execute on function public.publish_daily_log_draft(uuid, integer) to authenticated;
grant execute on function public.correct_daily_log(uuid, integer, text, text, text, text, text) to authenticated;
grant execute on function public.list_published_daily_logs(uuid, integer, integer) to authenticated;
grant execute on function public.get_daily_log_history(uuid) to authenticated;

commit;
