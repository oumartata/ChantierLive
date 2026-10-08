-- M047 — B023 : commentaires attribués (done_when : « modération reste
-- visible »). Décisions du fondateur 2026-10-08 : D191 (C1 à C7, C4
-- modifiée). Conception : DATABASE_TABLES T017 (comments, insertion seule +
-- modération visible), BR039, FR059 (révisée), FR103, MIGRATION_ORDER M009
-- (commentaires, jamais réalisés jusqu'ici ; identifiant M009 non réutilisé).
--
-- - Éléments commentables (C1) : journal PUBLIÉ et incident. Jamais un
--   brouillon ni un élément interne : aucun autre type n'est accepté.
-- - Qui (C2) : tout membre actif du chantier qui voit l'élément (les quatre
--   rôles voient les journaux publiés et les incidents) ; compte vérifié pour
--   écrire.
-- - Visibilité : celle de l'élément, au plus — la lecture revérifie que
--   l'élément est encore visible (journal toujours publié).
-- - Correction (C3) : auteur seul, nouvelle version ; l'original reste
--   lisible dans l'historique.
-- - Retrait (C4) : auteur seul ; texte masqué dans le fil (jamais renvoyé, ni
--   par la liste ni par l'historique), conservé en base.
-- - Modération (C4) : entreprise et propriétaire principal, motif
--   obligatoire ; marque visible, texte toujours lisible ; personne ne masque
--   le texte d'un autre.
-- - Rien n'est jamais supprimé, même avec la clé de service.
-- - Incident clos ou annulé (C6) : plus d'ajout ni de correction ; fil
--   lisible ; retrait et modération restent possibles.
-- - Attribution (C5) : rôle au moment du commentaire ; ex-membre (C7) :
--   mention « ancien membre », plus aucun accès.
-- - Audit à chaque action (lisible par l'entreprise seule, D186).

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
create table public.comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  target_type text not null check (target_type in ('DAILY_LOG', 'INCIDENT')),
  daily_log_id uuid null references public.daily_logs (id) on delete restrict,
  incident_id uuid null,
  author_profile_id uuid not null references public.profiles (id) on delete restrict,
  author_role text not null check (author_role in ('CONTRACTOR', 'OWNER_PRIMARY', 'CO_OWNER', 'SITE_MANAGER')),
  target_version_number integer null check (target_version_number is null or target_version_number >= 1),
  current_version_id uuid null,
  revision integer not null default 0 check (revision >= 0),
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  retracted_at_server timestamptz null,
  moderated_at_server timestamptz null,
  moderated_by_profile_id uuid null references public.profiles (id) on delete restrict,
  moderated_by_role text null check (moderated_by_role is null or moderated_by_role in ('CONTRACTOR', 'OWNER_PRIMARY')),
  moderation_reason text null check (moderation_reason is null or char_length(btrim(moderation_reason)) between 3 and 1000),
  constraint comments_id_project_unique unique (id, project_id),
  constraint comments_target_shape check (
    (target_type = 'DAILY_LOG' and daily_log_id is not null and incident_id is null)
    or (target_type = 'INCIDENT' and incident_id is not null and daily_log_id is null)
  ),
  constraint comments_incident_same_project foreign key (incident_id, project_id) references public.incidents (id, project_id) on delete restrict,
  constraint comments_moderation_consistency check (
    (moderated_at_server is null) = (moderated_by_profile_id is null)
    and (moderated_at_server is null) = (moderated_by_role is null)
    and (moderated_at_server is null) = (moderation_reason is null)
  )
);

create index comments_daily_log_idx on public.comments (daily_log_id, created_at_server) where daily_log_id is not null;
create index comments_incident_idx on public.comments (incident_id, created_at_server) where incident_id is not null;

create table public.comment_versions (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null,
  project_id uuid not null,
  version_number integer not null check (version_number >= 1),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at_server timestamptz not null default now(),
  constraint comment_versions_comment_fk foreign key (comment_id, project_id) references public.comments (id, project_id) on delete restrict,
  constraint comment_versions_number_unique unique (comment_id, version_number)
);

alter table public.comments add constraint comments_current_version_fk
  foreign key (current_version_id) references public.comment_versions (id) on delete restrict;

alter table public.comments enable row level security;
alter table public.comment_versions enable row level security;
revoke all privileges on table public.comments from public, anon, authenticated;
revoke all privileges on table public.comment_versions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Gardes (même service_role) : versions immuables ; commentaire jamais
--    supprimé, identité et élément figés ; retrait et modération uniques et
--    définitifs ; texte figé dès le retrait ou la modération.
-- ---------------------------------------------------------------------------
create function public.reject_comment_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'comment_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.comment_versions
for each row execute function public.reject_comment_version_mutation();

create function public.guard_comment_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'comment_immutable';
  end if;
  if new.id <> old.id or new.project_id <> old.project_id or new.target_type <> old.target_type
     or new.daily_log_id is distinct from old.daily_log_id or new.incident_id is distinct from old.incident_id
     or new.author_profile_id <> old.author_profile_id or new.author_role <> old.author_role
     or new.target_version_number is distinct from old.target_version_number or new.created_at_server <> old.created_at_server then
    raise exception 'comment_immutable';
  end if;
  if old.retracted_at_server is not null and new.retracted_at_server is distinct from old.retracted_at_server then
    raise exception 'comment_immutable';
  end if;
  if old.moderated_at_server is not null and (
       new.moderated_at_server is distinct from old.moderated_at_server or new.moderated_by_profile_id is distinct from old.moderated_by_profile_id
       or new.moderated_by_role is distinct from old.moderated_by_role or new.moderation_reason is distinct from old.moderation_reason) then
    raise exception 'comment_immutable';
  end if;
  if (old.retracted_at_server is not null or old.moderated_at_server is not null)
     and new.current_version_id is distinct from old.current_version_id then
    raise exception 'comment_immutable';
  end if;
  new.updated_at_server := clock_timestamp();
  return new;
end;
$$;

create trigger guard_mutation before update or delete on public.comments
for each row execute function public.guard_comment_mutation();

revoke execute on function public.reject_comment_version_mutation(), public.guard_comment_mutation()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Élément commenté : chantier, visibilité, possibilité de commenter.
--    Toujours vrai ou faux (leçon de M038c) ; aucun autre type d'élément.
-- ---------------------------------------------------------------------------
create function public.comment_target(p_target_type text, p_target_id uuid,
  p_project_id out uuid, p_visible out boolean, p_open out boolean, p_version_number out integer)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
begin
  p_visible := false;
  p_open := false;
  if p_target_type = 'DAILY_LOG' then
    select l.project_id, l.status, v.version_number into p_project_id, v_status, p_version_number
    from public.daily_logs l left join public.daily_log_versions v on v.id = l.current_version_id
    where l.id = p_target_id;
    -- Journal : visible et commentable seulement publié (jamais un brouillon).
    p_visible := coalesce(v_status = 'PUBLIE', false);
    p_open := p_visible;
  elsif p_target_type = 'INCIDENT' then
    select i.project_id, i.status into p_project_id, v_status from public.incidents i where i.id = p_target_id;
    -- Incident : visible de tout membre actif ; plus d'ajout une fois clos ou annulé.
    p_visible := p_project_id is not null;
    p_open := coalesce(p_visible and v_status not in ('CLOS', 'ANNULE'), false);
    p_version_number := null;
  end if;
end;
$$;

-- Partie de l'appelant sur le chantier, pour lire (toute adhésion active) ou
-- écrire (compte vérifié en plus) ; sinon not_authorized.
create function public.comment_require_party(p_project_id uuid, p_for_write boolean)
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
  if p_project_id is null then
    raise exception 'not_authorized';
  end if;
  v_party := public.document_party(p_project_id, v_uid);
  if v_party is null then
    raise exception 'not_authorized';
  end if;
  if p_for_write and public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  return v_party;
end;
$$;

revoke execute on function public.comment_target(text, uuid), public.comment_require_party(uuid, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Écritures.
-- ---------------------------------------------------------------------------
create function public.add_comment(p_target_type text, p_target_id uuid, p_body text)
returns public.comments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_target record;
  v_party text;
  v_body text := btrim(coalesce(p_body, ''));
  v_row public.comments;
  v_version public.comment_versions;
begin
  if p_target_type is null or p_target_type not in ('DAILY_LOG', 'INCIDENT') or p_target_id is null then
    raise exception 'not_authorized';
  end if;
  select * into v_target from public.comment_target(p_target_type, p_target_id);
  v_party := public.comment_require_party(v_target.p_project_id, true);
  if v_target.p_visible is not true then
    raise exception 'not_authorized';
  end if;
  if v_target.p_open is not true then
    raise exception 'comment_closed';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then
    raise exception 'comment_invalid';
  end if;
  insert into public.comments (project_id, target_type, daily_log_id, incident_id, author_profile_id, author_role, target_version_number)
  values (v_target.p_project_id, p_target_type,
          case when p_target_type = 'DAILY_LOG' then p_target_id end,
          case when p_target_type = 'INCIDENT' then p_target_id end,
          v_uid, v_party, v_target.p_version_number)
  returning * into v_row;
  insert into public.comment_versions (comment_id, project_id, version_number, body)
  values (v_row.id, v_row.project_id, 1, v_body)
  returning * into v_version;
  update public.comments set current_version_id = v_version.id, revision = revision + 1 where id = v_row.id returning * into v_row;
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_uid, 'COMMENT_ADDED', 'comments', v_row.id, 'SUCCESS',
          jsonb_build_object('target_type', p_target_type, 'target_id', p_target_id), 'Commentaire ajouté.');
  return v_row;
end;
$$;

-- Verrou et contrôles communs aux actions sur un commentaire existant.
create function public.comment_lock(p_comment_id uuid, p_expected_revision integer)
returns public.comments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.comments;
  v_target record;
begin
  select * into v_row from public.comments where id = p_comment_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  perform public.comment_require_party(v_row.project_id, true);
  select * into v_target from public.comment_target(v_row.target_type, coalesce(v_row.daily_log_id, v_row.incident_id));
  if v_target.p_visible is not true then
    raise exception 'not_authorized';
  end if;
  select * into v_row from public.comments where id = p_comment_id for update;
  if p_expected_revision is null or p_expected_revision <> v_row.revision then
    raise exception 'revision_conflict';
  end if;
  return v_row;
end;
$$;

revoke execute on function public.comment_lock(uuid, integer) from public, anon, authenticated, service_role;

create function public.correct_comment(p_comment_id uuid, p_expected_revision integer, p_body text)
returns public.comments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.comments;
  v_target record;
  v_prev public.comment_versions;
  v_version public.comment_versions;
  v_body text := btrim(coalesce(p_body, ''));
begin
  v_row := public.comment_lock(p_comment_id, p_expected_revision);
  if v_row.author_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;
  if v_row.retracted_at_server is not null or v_row.moderated_at_server is not null then
    raise exception 'comment_frozen';
  end if;
  select * into v_target from public.comment_target(v_row.target_type, coalesce(v_row.daily_log_id, v_row.incident_id));
  if v_target.p_open is not true then
    raise exception 'comment_closed';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then
    raise exception 'comment_invalid';
  end if;
  select * into v_prev from public.comment_versions where id = v_row.current_version_id;
  if v_prev.body = v_body then
    raise exception 'no_change';
  end if;
  insert into public.comment_versions (comment_id, project_id, version_number, body)
  values (v_row.id, v_row.project_id, v_prev.version_number + 1, v_body)
  returning * into v_version;
  update public.comments set current_version_id = v_version.id, revision = revision + 1 where id = v_row.id returning * into v_row;
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_uid, 'COMMENT_CORRECTED', 'comments', v_row.id, 'SUCCESS',
          jsonb_build_object('version_number', v_version.version_number), 'Commentaire corrigé ; version précédente conservée.');
  return v_row;
end;
$$;

create function public.retract_comment(p_comment_id uuid, p_expected_revision integer)
returns public.comments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.comments;
begin
  v_row := public.comment_lock(p_comment_id, p_expected_revision);
  if v_row.author_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;
  if v_row.retracted_at_server is not null then
    raise exception 'comment_frozen';
  end if;
  update public.comments set retracted_at_server = clock_timestamp(), revision = revision + 1 where id = v_row.id returning * into v_row;
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_uid, 'COMMENT_RETRACTED', 'comments', v_row.id, 'SUCCESS', '{}'::jsonb,
          'Commentaire retiré par son auteur ; texte conservé.');
  return v_row;
end;
$$;

create function public.moderate_comment(p_comment_id uuid, p_expected_revision integer, p_reason text)
returns public.comments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.comments;
  v_party text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  v_row := public.comment_lock(p_comment_id, p_expected_revision);
  v_party := public.comment_require_party(v_row.project_id, true);
  if v_party not in ('CONTRACTOR', 'OWNER_PRIMARY') then
    raise exception 'not_authorized';
  end if;
  if v_row.moderated_at_server is not null or v_row.retracted_at_server is not null then
    raise exception 'comment_frozen';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  update public.comments
  set moderated_at_server = clock_timestamp(), moderated_by_profile_id = v_uid, moderated_by_role = v_party,
      moderation_reason = v_reason, revision = revision + 1
  where id = v_row.id
  returning * into v_row;
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_uid, 'COMMENT_MODERATED', 'comments', v_row.id, 'SUCCESS', '{}'::jsonb, v_reason);
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Lecture.
-- ---------------------------------------------------------------------------
create type public.comment_view as (
  id uuid,
  revision integer,
  author_role text,
  author_is_me boolean,
  author_is_former_member boolean,
  target_version_number integer,
  body text,
  version_number integer,
  edited boolean,
  created_at_server timestamptz,
  last_edited_at_server timestamptz,
  retracted_at_server timestamptz,
  moderated_at_server timestamptz,
  moderated_by_role text,
  moderated_by_me boolean,
  moderation_reason text,
  can_correct boolean,
  can_retract boolean,
  can_moderate boolean
);

create function public.list_comments(p_target_type text, p_target_id uuid)
returns setof public.comment_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_target record;
  v_party text;
begin
  if p_target_type is null or p_target_type not in ('DAILY_LOG', 'INCIDENT') or p_target_id is null then
    raise exception 'not_authorized';
  end if;
  select * into v_target from public.comment_target(p_target_type, p_target_id);
  v_party := public.comment_require_party(v_target.p_project_id, false);
  if v_target.p_visible is not true then
    raise exception 'not_authorized';
  end if;
  return query
    select c.id, c.revision, c.author_role, c.author_profile_id = v_uid,
           not exists (select 1 from public.project_memberships m where m.project_id = c.project_id and m.profile_id = c.author_profile_id and m.revoked_at is null),
           c.target_version_number,
           -- Retiré par son auteur : texte jamais renvoyé ; modéré : toujours lisible.
           case when c.retracted_at_server is null then v.body end,
           v.version_number, v.version_number > 1, c.created_at_server,
           case when v.version_number > 1 then v.created_at_server end,
           c.retracted_at_server, c.moderated_at_server, c.moderated_by_role,
           coalesce(c.moderated_by_profile_id = v_uid, false), c.moderation_reason,
           c.author_profile_id = v_uid and c.retracted_at_server is null and c.moderated_at_server is null and v_target.p_open,
           c.author_profile_id = v_uid and c.retracted_at_server is null,
           v_party in ('CONTRACTOR', 'OWNER_PRIMARY') and c.retracted_at_server is null and c.moderated_at_server is null
    from public.comments c
    join public.comment_versions v on v.id = c.current_version_id
    where (p_target_type = 'DAILY_LOG' and c.daily_log_id = p_target_id) or (p_target_type = 'INCIDENT' and c.incident_id = p_target_id)
    order by c.created_at_server, c.id;
end;
$$;

-- Historique des versions (C3) ; jamais pour un commentaire retiré (texte masqué).
create function public.get_comment_history(p_comment_id uuid)
returns table (version_number integer, body text, created_at_server timestamptz, is_current boolean)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.comments;
  v_target record;
begin
  select c.* into v_row from public.comments c where c.id = p_comment_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  perform public.comment_require_party(v_row.project_id, false);
  select * into v_target from public.comment_target(v_row.target_type, coalesce(v_row.daily_log_id, v_row.incident_id));
  if v_target.p_visible is not true then
    raise exception 'not_authorized';
  end if;
  if v_row.retracted_at_server is not null then
    raise exception 'comment_retracted';
  end if;
  return query
    select cv.version_number, cv.body, cv.created_at_server, cv.id = v_row.current_version_id
    from public.comment_versions cv where cv.comment_id = p_comment_id
    order by cv.version_number;
end;
$$;

revoke execute on function public.add_comment(text, uuid, text), public.correct_comment(uuid, integer, text),
  public.retract_comment(uuid, integer), public.moderate_comment(uuid, integer, text),
  public.list_comments(text, uuid), public.get_comment_history(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.add_comment(text, uuid, text), public.correct_comment(uuid, integer, text),
  public.retract_comment(uuid, integer), public.moderate_comment(uuid, integer, text),
  public.list_comments(text, uuid), public.get_comment_history(uuid)
  to authenticated;

commit;
