-- M036 — B021 : journal quotidien en brouillon (« brouillon auteur
-- modifiable »). Décisions du fondateur 2026-10-06 : D144–D150 (J1–J7).
--
-- Périmètre : création, lecture, modification et archivage d'un brouillon
-- par son AUTEUR seul. Hors périmètre : publication et correction (B022,
-- daily_log_versions), phases (D149), hors ligne (L06), médias,
-- commentaires.
--
-- Droits (PERMISSIONS.csv, lus avec D144/D145) :
-- - JOURNAL_CREATE : CONTRACTOR et SITE_MANAGER (A) ; OWNER/PRIMARY « C »
--   (observation, pas journal opérationnel par défaut) : non ouvert ici ;
--   CO_OWNER et PLATFORM_ADMIN : N.
-- - JOURNAL_EDIT_DRAFT : l'auteur seul (D145).
-- - Lecture d'un brouillon : l'auteur seul (D144) ; JOURNAL_VIEW (adhésion
--   active) s'appliquera aux journaux PUBLIÉS (B022).
-- Toute action exige : session, compte non provisoire, adhésion ACTIVE au
-- chantier avec le rôle CONTRACTOR ou SITE_MANAGER (un accès retiré bloque
-- aussi l'auteur sur ses propres brouillons, EC024).
--
-- Statut du chantier : aucun blocage selon le statut (même usage que M010
-- et M033) ; un éventuel mode lecture seule relève des licences (L08).

begin;

create table public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  author_profile_id uuid not null references public.profiles (id) on delete restrict,
  log_date date not null,
  status text not null default 'BROUILLON',
  -- Contenu opérationnel (FR053) : aucun champ obligatoire (AC053).
  works_done text null,
  difficulties text null,
  team text null,
  next_actions text null,
  revision integer not null default 0,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  archived_at_server timestamptz null,
  constraint daily_logs_status_known check (status in ('BROUILLON', 'ARCHIVE')),
  constraint daily_logs_archive_consistency check ((status = 'ARCHIVE') = (archived_at_server is not null)),
  constraint daily_logs_text_bounds check (
    coalesce(char_length(works_done), 0) <= 4000
    and coalesce(char_length(difficulties), 0) <= 4000
    and coalesce(char_length(team), 0) <= 4000
    and coalesce(char_length(next_actions), 0) <= 4000
  ),
  constraint daily_logs_revision_non_negative check (revision >= 0)
);

-- D146 : au plus un brouillon actif par auteur, chantier et date.
create unique index daily_logs_one_draft_per_author_date
  on public.daily_logs (project_id, author_profile_id, log_date)
  where status = 'BROUILLON';
create index daily_logs_project_author_idx on public.daily_logs (project_id, author_profile_id);

alter table public.daily_logs enable row level security;
revoke all privileges on table public.daily_logs from public, anon, authenticated;

-- Identité figée, ARCHIVE terminal, heure serveur imposée, jamais de
-- suppression physique (D147).
create function public.guard_daily_log_mutation()
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
  new.updated_at_server := clock_timestamp();
  return new;
end;
$$;

create trigger guard_mutation
before update or delete on public.daily_logs
for each row execute function public.guard_daily_log_mutation();

revoke execute on function public.guard_daily_log_mutation() from public, anon, authenticated, service_role;

-- Contrôle commun : session, compte vérifié, adhésion active avec rôle
-- autorisé. Renvoie l'identifiant de l'appelant.
create function public.daily_log_require_author_role(p_project_id uuid)
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
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id
      and profile_id = v_uid
      and revoked_at is null
      and role in ('CONTRACTOR', 'SITE_MANAGER')
  ) then
    raise exception 'not_authorized';
  end if;
  return v_uid;
end;
$$;

revoke execute on function public.daily_log_require_author_role(uuid) from public, anon, authenticated, service_role;

-- Création (FR051, AC051) — brouillon attribué à l'appelant.
create function public.create_daily_log_draft(
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

-- Modification (FR055, D145) — auteur seul, brouillon seul, révision
-- attendue (aucune écriture silencieuse sur une version périmée).
create function public.update_daily_log_draft(
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
    when unique_violation then raise exception 'daily_log_draft_exists';
    when check_violation then raise exception 'daily_log_invalid';
  end;
  return v_log;
end;
$$;

-- « Supprimer » = archiver (D147), avec trace d'audit ; terminal.
create function public.archive_daily_log_draft(p_log_id uuid, p_expected_revision integer)
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
  update public.daily_logs
  set status = 'ARCHIVE', archived_at_server = clock_timestamp(), revision = revision + 1
  where id = p_log_id
  returning * into v_log;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_log.project_id, 'HUMAN', v_uid, 'DAILY_LOG_DRAFT_ARCHIVE', 'daily_logs', v_log.id, 'SUCCESS',
          jsonb_build_object('log_date', v_log.log_date), 'Brouillon de journal quotidien archivé par son auteur (suppression non physique).');
  return v_log;
end;
$$;

-- Lecture : brouillons ACTIFS de l'appelant sur ce chantier (D144) ;
-- aucun brouillon d'un autre auteur n'est jamais renvoyé.
create function public.list_my_daily_log_drafts(p_project_id uuid)
returns setof public.daily_logs
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := public.daily_log_require_author_role(p_project_id);
begin
  return query
    select * from public.daily_logs
    where project_id = p_project_id and author_profile_id = v_uid and status = 'BROUILLON'
    order by log_date desc, created_at_server desc;
end;
$$;

revoke execute on function public.create_daily_log_draft(uuid, date, text, text, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.update_daily_log_draft(uuid, integer, date, text, text, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.archive_daily_log_draft(uuid, integer) from public, anon, authenticated, service_role;
revoke execute on function public.list_my_daily_log_drafts(uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_daily_log_draft(uuid, date, text, text, text, text) to authenticated;
grant execute on function public.update_daily_log_draft(uuid, integer, date, text, text, text, text) to authenticated;
grant execute on function public.archive_daily_log_draft(uuid, integer) to authenticated;
grant execute on function public.list_my_daily_log_drafts(uuid) to authenticated;

commit;
