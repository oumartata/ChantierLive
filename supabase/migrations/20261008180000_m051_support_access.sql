-- M051 — B051 : accès support limité et expirant (done_when : « motif
-- périmètre et audit obligatoires »). Décisions du fondateur 2026-10-08 :
-- D197 (S1 à S10 de PROPOSITION_B051_SUPPORT.md dans le cadre de la
-- boucle 35b), D019, D020, D057, D183, D185, D186, D187, D195 E6, BR088,
-- BR089.
--
-- - Dossier (S3) : une demande d'aide ouverte par une partie principale
--   (entreprise ou propriétaire principal, S2) ; catégorie et description
--   (le motif) ; l'administrateur ne lit la description qu'après prise en
--   charge motivée, lecture tracée.
-- - Accord (S1, S7) : seule une partie principale ouvre l'accès, jamais le
--   support seul ; modules choisis (S4, jamais les finances internes, S5) ;
--   durée 15, 30 ou 60 minutes choisie par le membre ; expiration contrôlée
--   en base à chaque lecture ; révocable à tout moment par l'une ou l'autre
--   partie principale ou par l'administrateur.
-- - Lecture seule (S6) : support_read et support_get_file ne modifient aucun
--   contenu ; l'administrateur n'est toujours membre d'aucun chantier.
-- - Journal d'accès dédié (S8) : chaque accord, prise en charge, lecture,
--   ouverture de fichier, refus, révocation et clôture ; lisible des DEUX
--   parties principales (jamais du copropriétaire ni du chef de chantier) ;
--   l'administrateur ne lit jamais l'audit du chantier (D195 E6).
-- - Bandeau (S9) : support_active_access, parties principales.
-- - Une lecture refusée est journalisée (EC061) : les fonctions de lecture
--   renvoient un refus au lieu de lever une exception, pour que la trace
--   reste écrite.

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
create table public.support_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  requester_profile_id uuid not null references public.profiles (id) on delete restrict,
  requester_party text not null check (requester_party in ('CONTRACTOR', 'OWNER_PRIMARY')),
  category text not null check (category in ('TECHNIQUE', 'ACCES', 'DONNEES', 'AUTRE')),
  description text not null check (char_length(description) between 10 and 1000),
  status text not null default 'OPEN' check (status in ('OPEN', 'TAKEN', 'CLOSED')),
  taken_by_profile_id uuid null references public.profiles (id) on delete restrict,
  taken_at_server timestamptz null,
  take_reason text null check (take_reason is null or char_length(take_reason) between 10 and 1000),
  closed_at_server timestamptz null,
  closed_by_kind text null check (closed_by_kind is null or closed_by_kind in ('MEMBER', 'ADMIN')),
  created_at_server timestamptz not null default now(),
  constraint support_requests_taken_consistency check ((taken_by_profile_id is null) = (taken_at_server is null) and (taken_at_server is null) = (take_reason is null)),
  constraint support_requests_closed_consistency check ((status = 'CLOSED') = (closed_at_server is not null) and (closed_at_server is null) = (closed_by_kind is null))
);

create table public.support_access_grants (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.support_requests (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  granted_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  granted_by_party text not null check (granted_by_party in ('CONTRACTOR', 'OWNER_PRIMARY')),
  modules text[] not null,
  duration_minutes integer not null check (duration_minutes in (15, 30, 60)),
  granted_at_server timestamptz not null default now(),
  expires_at_server timestamptz not null,
  revoked_at_server timestamptz null,
  revoked_by_kind text null check (revoked_by_kind is null or revoked_by_kind in ('MEMBER', 'ADMIN')),
  revoked_by_party text null check (revoked_by_party is null or revoked_by_party in ('CONTRACTOR', 'OWNER_PRIMARY')),
  revoke_reason text null check (revoke_reason is null or char_length(revoke_reason) <= 500),
  constraint support_grants_expiry check (expires_at_server = granted_at_server + make_interval(mins => duration_minutes)),
  constraint support_grants_modules check (
    cardinality(modules) between 1 and 7
    and modules <@ array['JOURNAL', 'INCIDENTS', 'PHOTOS', 'DOCUMENTS', 'AVANCEMENT', 'COMMENTAIRES', 'EQUIPE']::text[]),
  constraint support_grants_revocation check ((revoked_at_server is null) = (revoked_by_kind is null))
);

create table public.support_access_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  request_id uuid not null references public.support_requests (id) on delete restrict,
  grant_id uuid null references public.support_access_grants (id) on delete restrict,
  actor_kind text not null check (actor_kind in ('MEMBER', 'ADMIN')),
  actor_profile_id uuid not null references public.profiles (id) on delete restrict,
  actor_party text null check (actor_party is null or actor_party in ('CONTRACTOR', 'OWNER_PRIMARY')),
  action text not null check (action in ('REQUEST_CREATED', 'ACCESS_GRANTED', 'REQUEST_TAKEN', 'REQUEST_VIEWED', 'ACCESS_READ',
                                         'FILE_OPENED', 'ACCESS_DENIED', 'ACCESS_REVOKED', 'REQUEST_CLOSED')),
  module text null,
  object_count integer null,
  object_ids uuid[] null,
  detail text null,
  created_at_server timestamptz not null default clock_timestamp(),
  constraint support_events_actor check ((actor_kind = 'MEMBER') = (actor_party is not null))
);

create index support_requests_project_idx on public.support_requests (project_id, created_at_server desc);
create index support_grants_request_idx on public.support_access_grants (request_id, granted_at_server desc);
create index support_events_project_idx on public.support_access_events (project_id, created_at_server desc);

alter table public.support_requests enable row level security;
alter table public.support_access_grants enable row level security;
alter table public.support_access_events enable row level security;
revoke all privileges on table public.support_requests, public.support_access_grants, public.support_access_events from public, anon, authenticated;

-- Gardes : dossier aux transitions contrôlées, accord révocable une seule
-- fois, journal en insertion seule ; aucune suppression.
create function public.support_guard_request()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'support_record_immutable';
  end if;
  if new.project_id <> old.project_id or new.requester_profile_id <> old.requester_profile_id or new.requester_party <> old.requester_party
     or new.category <> old.category or new.description <> old.description or new.created_at_server <> old.created_at_server
     or (old.taken_by_profile_id is not null and (new.taken_by_profile_id is distinct from old.taken_by_profile_id
         or new.taken_at_server is distinct from old.taken_at_server or new.take_reason is distinct from old.take_reason))
     or old.status = 'CLOSED'
     or (old.status = 'TAKEN' and new.status = 'OPEN') then
    raise exception 'support_record_immutable';
  end if;
  return new;
end;
$$;

create trigger guard_request before update or delete on public.support_requests
for each row execute function public.support_guard_request();

create function public.support_guard_grant()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'support_record_immutable';
  end if;
  if old.revoked_at_server is not null
     or new.request_id <> old.request_id or new.project_id <> old.project_id or new.granted_by_profile_id <> old.granted_by_profile_id
     or new.granted_by_party <> old.granted_by_party or new.modules <> old.modules or new.duration_minutes <> old.duration_minutes
     or new.granted_at_server <> old.granted_at_server or new.expires_at_server <> old.expires_at_server then
    raise exception 'support_record_immutable';
  end if;
  return new;
end;
$$;

create trigger guard_grant before update or delete on public.support_access_grants
for each row execute function public.support_guard_grant();

create function public.support_reject_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'support_record_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.support_access_events
for each row execute function public.support_reject_event_mutation();

-- ---------------------------------------------------------------------------
-- 2. Aides internes (révoquées pour tous).
-- ---------------------------------------------------------------------------
-- Partie principale du compte sur le chantier (S2), sinon NULL.
create function public.support_principal_party(p_project_id uuid, p_uid uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select case when public.document_party(p_project_id, p_uid) in ('CONTRACTOR', 'OWNER_PRIMARY') then public.document_party(p_project_id, p_uid) end;
$$;

create function public.support_require_principal(p_project_id uuid)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_party text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_party := public.support_principal_party(p_project_id, auth.uid());
  if v_party is null then
    raise exception 'not_authorized';
  end if;
  return v_party;
end;
$$;

create function public.support_log(p_project_id uuid, p_request_id uuid, p_grant_id uuid, p_actor_kind text, p_actor uuid, p_party text,
                                   p_action text, p_module text, p_count integer, p_ids uuid[], p_detail text)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
  insert into public.support_access_events (project_id, request_id, grant_id, actor_kind, actor_profile_id, actor_party, action, module, object_count, object_ids, detail)
  values (p_project_id, p_request_id, p_grant_id, p_actor_kind, p_actor, p_party, p_action, p_module, p_count, p_ids, p_detail);
$$;

-- Modules demandés : non vides, connus, sans doublon ; jamais les finances
-- internes ni l'audit du chantier (S5, D195 E6).
create function public.support_normalize_modules(p_modules text[])
returns text[]
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_modules text[];
begin
  select coalesce(array_agg(distinct upper(btrim(m)) order by upper(btrim(m))), '{}') into v_modules
  from unnest(coalesce(p_modules, '{}'::text[])) m
  where btrim(coalesce(m, '')) <> '';
  if cardinality(v_modules) = 0
     or not v_modules <@ array['JOURNAL', 'INCIDENTS', 'PHOTOS', 'DOCUMENTS', 'AVANCEMENT', 'COMMENTAIRES', 'EQUIPE']::text[] then
    raise exception 'scope_invalid';
  end if;
  return v_modules;
end;
$$;

revoke execute on function public.support_principal_party(uuid, uuid), public.support_require_principal(uuid),
  public.support_log(uuid, uuid, uuid, text, uuid, text, text, text, integer, uuid[], text), public.support_normalize_modules(text[])
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Côté membre (parties principales).
-- ---------------------------------------------------------------------------
create function public.support_grant_access(p_request_id uuid, p_modules text[], p_duration_minutes integer)
returns table (grant_id uuid, modules text[], duration_minutes integer, granted_at_server timestamptz, expires_at_server timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_req public.support_requests;
  v_party text;
  v_modules text[];
  v_row public.support_access_grants;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_req from public.support_requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;
  v_party := public.support_require_principal(v_req.project_id);
  if public.is_account_provisional() then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  if v_req.status = 'CLOSED' then
    raise exception 'request_closed';
  end if;
  if p_duration_minutes is null or p_duration_minutes not in (15, 30, 60) then
    raise exception 'duration_invalid';
  end if;
  v_modules := public.support_normalize_modules(p_modules);
  if exists (select 1 from public.support_access_grants g where g.request_id = v_req.id and g.revoked_at_server is null and g.expires_at_server > clock_timestamp()) then
    raise exception 'grant_already_active';
  end if;
  insert into public.support_access_grants (request_id, project_id, granted_by_profile_id, granted_by_party, modules, duration_minutes, granted_at_server, expires_at_server)
  values (v_req.id, v_req.project_id, auth.uid(), v_party, v_modules, p_duration_minutes, v_now, v_now + make_interval(mins => p_duration_minutes))
  returning * into v_row;
  perform public.support_log(v_req.project_id, v_req.id, v_row.id, 'MEMBER', auth.uid(), v_party, 'ACCESS_GRANTED', null, null, null,
                             array_to_string(v_modules, ',') || ' ; ' || p_duration_minutes || ' min');
  return query select v_row.id, v_row.modules, v_row.duration_minutes, v_row.granted_at_server, v_row.expires_at_server;
end;
$$;

create function public.support_create_request(p_project_id uuid, p_category text, p_description text, p_grant_modules text[], p_grant_duration_minutes integer)
returns table (request_id uuid, status text, grant_id uuid, expires_at_server timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_party text := public.support_require_principal(p_project_id);
  v_description text := btrim(coalesce(p_description, ''));
  v_req public.support_requests;
  v_grant record;
begin
  if public.is_account_provisional() then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  if p_category is null or p_category not in ('TECHNIQUE', 'ACCES', 'DONNEES', 'AUTRE') then
    raise exception 'category_invalid';
  end if;
  if char_length(v_description) < 10 or char_length(v_description) > 1000 then
    raise exception 'description_invalid';
  end if;
  insert into public.support_requests (project_id, requester_profile_id, requester_party, category, description)
  values (p_project_id, auth.uid(), v_party, p_category, v_description)
  returning * into v_req;
  perform public.support_log(p_project_id, v_req.id, null, 'MEMBER', auth.uid(), v_party, 'REQUEST_CREATED', null, null, null, p_category);
  if p_grant_modules is not null and cardinality(p_grant_modules) > 0 then
    select * into v_grant from public.support_grant_access(v_req.id, p_grant_modules, p_grant_duration_minutes);
    return query select v_req.id, v_req.status, v_grant.grant_id, v_grant.expires_at_server;
  else
    return query select v_req.id, v_req.status, null::uuid, null::timestamptz;
  end if;
end;
$$;

-- Révocation (S7, cadre 35b) : l'une ou l'autre partie principale, ou
-- l'administrateur ; jamais une seconde fois.
create function public.support_revoke_access(p_grant_id uuid, p_reason text)
returns table (grant_id uuid, revoked_at_server timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_grant public.support_access_grants;
  v_admin boolean := public.is_platform_admin();
  v_party text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_grant from public.support_access_grants g where g.id = p_grant_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;
  if not v_admin then
    v_party := public.support_require_principal(v_grant.project_id);
  end if;
  if v_grant.revoked_at_server is not null then
    raise exception 'grant_already_revoked';
  end if;
  if v_grant.expires_at_server <= clock_timestamp() then
    raise exception 'grant_expired';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'reason_invalid';
  end if;
  update public.support_access_grants g
     set revoked_at_server = clock_timestamp(), revoked_by_kind = case when v_admin then 'ADMIN' else 'MEMBER' end,
         revoked_by_party = v_party, revoke_reason = v_reason
   where g.id = v_grant.id
  returning * into v_grant;
  perform public.support_log(v_grant.project_id, v_grant.request_id, v_grant.id, case when v_admin then 'ADMIN' else 'MEMBER' end,
                             auth.uid(), v_party, 'ACCESS_REVOKED', null, null, null, v_reason);
  return query select v_grant.id, v_grant.revoked_at_server;
end;
$$;

-- Clôture du dossier : partie principale ou administrateur ; l'accès en
-- cours est révoqué dans la même transaction.
create function public.support_close_request(p_request_id uuid)
returns table (request_id uuid, status text, closed_at_server timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_req public.support_requests;
  v_admin boolean := public.is_platform_admin();
  v_party text;
  v_kind text;
begin
  select * into v_req from public.support_requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;
  if not v_admin then
    v_party := public.support_require_principal(v_req.project_id);
  end if;
  v_kind := case when v_admin then 'ADMIN' else 'MEMBER' end;
  if v_req.status = 'CLOSED' then
    raise exception 'request_closed';
  end if;
  update public.support_access_grants g
     set revoked_at_server = clock_timestamp(), revoked_by_kind = v_kind, revoked_by_party = v_party, revoke_reason = 'Dossier clos.'
   where g.request_id = v_req.id and g.revoked_at_server is null and g.expires_at_server > clock_timestamp();
  update public.support_requests r set status = 'CLOSED', closed_at_server = clock_timestamp(), closed_by_kind = v_kind
   where r.id = v_req.id
  returning * into v_req;
  perform public.support_log(v_req.project_id, v_req.id, null, v_kind, auth.uid(), v_party, 'REQUEST_CLOSED', null, null, null, null);
  return query select v_req.id, v_req.status, v_req.closed_at_server;
end;
$$;

-- Dossiers du chantier pour les parties principales : la description n'est
-- rendue qu'à la partie qui a écrit la demande.
create function public.support_list_project_requests(p_project_id uuid)
returns table (request_id uuid, category text, description text, requester_party text, status text, created_at_server timestamptz,
               taken boolean, closed_at_server timestamptz, active_grant_id uuid, active_modules text[], active_expires_at timestamptz,
               active_granted_by_party text)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_party text := public.support_require_principal(p_project_id);
begin
  return query
    select r.id, r.category, case when r.requester_party = v_party then r.description end, r.requester_party, r.status, r.created_at_server,
           r.taken_by_profile_id is not null, r.closed_at_server, g.id, g.modules, g.expires_at_server, g.granted_by_party
    from public.support_requests r
    left join lateral (
      select * from public.support_access_grants g
      where g.request_id = r.id and g.revoked_at_server is null and g.expires_at_server > clock_timestamp()
      order by g.granted_at_server desc limit 1
    ) g on true
    where r.project_id = p_project_id
    order by r.created_at_server desc;
end;
$$;

-- Journal d'accès (S8) : les deux parties principales, quel que soit celui
-- qui a accordé. Module et nombre d'objets, jamais leur contenu ni leur
-- titre ; les expirations sont déduites des accords.
create function public.support_list_access_journal(p_project_id uuid)
returns table (request_id uuid, grant_id uuid, actor text, action text, module text, object_count integer, detail text, created_at_server timestamptz)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.support_require_principal(p_project_id);
  return query
    select x.request_id, x.grant_id, x.actor, x.action, x.module, x.object_count, x.detail, x.created_at_server
    from (
      select e.request_id, e.grant_id,
             case when e.actor_kind = 'ADMIN' then 'support'
                  when e.actor_party = 'CONTRACTOR' then 'entreprise'
                  else 'propriétaire principal' end as actor,
             e.action, e.module, e.object_count,
             case when e.action in ('REQUEST_CREATED', 'REQUEST_VIEWED', 'ACCESS_READ', 'FILE_OPENED') then null else e.detail end as detail,
             e.created_at_server
      from public.support_access_events e
      where e.project_id = p_project_id
      union all
      select g.request_id, g.id, 'système', 'ACCESS_EXPIRED', null, null, null, g.expires_at_server
      from public.support_access_grants g
      where g.project_id = p_project_id and g.revoked_at_server is null and g.expires_at_server <= clock_timestamp()
    ) x
    order by x.created_at_server desc
    limit 300;
end;
$$;

-- Bandeau (S9) : accès ouvert sur le chantier, parties principales.
create function public.support_active_access(p_project_id uuid)
returns table (grant_id uuid, modules text[], expires_at_server timestamptz, granted_by_party text)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.support_require_principal(p_project_id);
  return query
    select g.id, g.modules, g.expires_at_server, g.granted_by_party
    from public.support_access_grants g
    where g.project_id = p_project_id and g.revoked_at_server is null and g.expires_at_server > clock_timestamp()
    order by g.expires_at_server;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Côté administrateur.
-- ---------------------------------------------------------------------------
-- Liste minimisée (FR157) : jamais la description.
create function public.admin_list_support_requests(p_include_closed boolean)
returns table (request_id uuid, request_ref text, project_ref text, category text, requester_party text, status text,
               created_at_server timestamptz, taken_by text, active_grant_id uuid, active_modules text[], active_expires_at timestamptz)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
begin
  return query
    select r.id, upper(left(r.id::text, 8)), upper(left(r.project_id::text, 8)), r.category, r.requester_party, r.status, r.created_at_server,
           case when r.taken_by_profile_id is null then null when r.taken_by_profile_id = v_admin then 'vous' else 'autre administrateur' end,
           g.id, g.modules, g.expires_at_server
    from public.support_requests r
    left join lateral (
      select * from public.support_access_grants g
      where g.request_id = r.id and g.revoked_at_server is null and g.expires_at_server > clock_timestamp()
      order by g.granted_at_server desc limit 1
    ) g on true
    where coalesce(p_include_closed, false) or r.status <> 'CLOSED'
    order by (r.status = 'CLOSED'), r.created_at_server desc
    limit 200;
end;
$$;

-- Prise en charge motivée (motif obligatoire) ; tracée pour les membres et
-- dans le journal de plateforme.
create function public.admin_take_support_request(p_request_id uuid, p_reason text)
returns table (request_id uuid, status text, taken_at_server timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_req public.support_requests;
begin
  if char_length(v_reason) < 10 or char_length(v_reason) > 1000 then
    raise exception 'reason_required';
  end if;
  select * into v_req from public.support_requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'request_not_found';
  end if;
  if v_req.status = 'CLOSED' then
    raise exception 'request_closed';
  end if;
  if v_req.status = 'TAKEN' then
    raise exception 'request_already_taken';
  end if;
  update public.support_requests r set status = 'TAKEN', taken_by_profile_id = v_admin, taken_at_server = clock_timestamp(), take_reason = v_reason
   where r.id = v_req.id
  returning * into v_req;
  perform public.support_log(v_req.project_id, v_req.id, null, 'ADMIN', v_admin, null, 'REQUEST_TAKEN', null, null, null, v_reason);
  insert into public.platform_audit_events (actor_profile_id, actor_kind, action, project_id, target_table, target_id, reason)
  values (v_admin, 'ADMIN', 'SUPPORT_REQUEST_TAKEN', v_req.project_id, 'support_requests', v_req.id, v_reason);
  return query select v_req.id, v_req.status, v_req.taken_at_server;
end;
$$;

-- Dossier pris en charge par l'appelant : description (lecture tracée) et
-- accords ; jamais pour un autre administrateur.
create function public.admin_get_support_request(p_request_id uuid)
returns table (request_id uuid, request_ref text, project_ref text, category text, description text, requester_party text, status text,
               created_at_server timestamptz, take_reason text, grants jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_req public.support_requests;
begin
  select * into v_req from public.support_requests r where r.id = p_request_id;
  if not found or v_req.taken_by_profile_id is distinct from v_admin then
    raise exception 'not_assigned';
  end if;
  perform public.support_log(v_req.project_id, v_req.id, null, 'ADMIN', v_admin, null, 'REQUEST_VIEWED', null, null, null, null);
  return query
    select v_req.id, upper(left(v_req.id::text, 8)), upper(left(v_req.project_id::text, 8)), v_req.category, v_req.description,
           v_req.requester_party, v_req.status, v_req.created_at_server, v_req.take_reason,
           coalesce((select jsonb_agg(jsonb_build_object(
                       'grant_id', g.id, 'modules', g.modules, 'duration_minutes', g.duration_minutes, 'granted_by_party', g.granted_by_party,
                       'granted_at_server', g.granted_at_server, 'expires_at_server', g.expires_at_server, 'revoked_at_server', g.revoked_at_server,
                       'active', g.revoked_at_server is null and g.expires_at_server > clock_timestamp()) order by g.granted_at_server desc)
                     from public.support_access_grants g where g.request_id = v_req.id), '[]'::jsonb);
end;
$$;

-- Contrôle commun d'une lecture : renvoie le refus (texte) ou NULL ; le
-- refus est journalisé par l'appelant.
create function public.support_check_grant(p_grant public.support_access_grants, p_req public.support_requests, p_admin uuid, p_module text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_req.taken_by_profile_id is distinct from p_admin then 'not_assigned'
    when p_req.status = 'CLOSED' then 'request_closed'
    when p_grant.revoked_at_server is not null then 'access_revoked'
    when p_grant.expires_at_server <= clock_timestamp() then 'access_expired'
    when p_module is null or not (p_module = any (p_grant.modules)) then 'out_of_scope'
  end;
$$;

revoke execute on function public.support_check_grant(public.support_access_grants, public.support_requests, uuid, text)
  from public, anon, authenticated, service_role;

-- Lecture seule d'un module ouvert (S4, S6). Le contenu est celui que voit la
-- partie qui a accordé l'accès ; jamais d'identité de membre, jamais de
-- brouillon, jamais de finance interne ni d'audit du chantier.
create function public.support_read(p_grant_id uuid, p_module text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_module text := upper(btrim(coalesce(p_module, '')));
  v_grant public.support_access_grants;
  v_req public.support_requests;
  v_refusal text;
  v_items jsonb;
  v_ids uuid[];
begin
  select * into v_grant from public.support_access_grants g where g.id = p_grant_id;
  if not found then
    insert into public.platform_audit_events (actor_profile_id, actor_kind, action, target_table, target_id, reason)
    values (v_admin, 'ADMIN', 'SUPPORT_ACCESS_DENIED', 'support_access_grants', p_grant_id, 'grant_not_found');
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;
  select * into v_req from public.support_requests r where r.id = v_grant.request_id;
  v_refusal := public.support_check_grant(v_grant, v_req, v_admin, v_module);
  if v_refusal is not null then
    perform public.support_log(v_grant.project_id, v_grant.request_id, v_grant.id, 'ADMIN', v_admin, null, 'ACCESS_DENIED', nullif(v_module, ''), null, null, v_refusal);
    return jsonb_build_object('ok', false, 'error', v_refusal);
  end if;

  if v_module = 'JOURNAL' then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'log_date', d.log_date, 'works_done', v.works_done, 'difficulties', v.difficulties,
                    'team', v.team, 'next_actions', v.next_actions, 'version_number', v.version_number, 'published_at_server', d.published_at_server,
                    'phase', ph.label) order by d.log_date desc, d.published_at_server desc), '[]'::jsonb),
           coalesce(array_agg(d.id), '{}')
      into v_items, v_ids
    from public.daily_logs d
    join public.daily_log_versions v on v.id = d.current_version_id
    left join public.project_phases ph on ph.id = d.phase_id
    where d.project_id = v_grant.project_id and d.status = 'PUBLIE';
  elsif v_module = 'INCIDENTS' then
    select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'incident_type', i.incident_type, 'severity', i.severity, 'occurred_at', i.occurred_at,
                    'description', i.description, 'status', i.status, 'reporter_role', i.reporter_role, 'due_date', i.due_date,
                    'resolution', i.resolution, 'created_at_server', i.created_at_server, 'closed_at_server', i.closed_at_server)
                    order by i.created_at_server desc), '[]'::jsonb),
           coalesce(array_agg(i.id), '{}')
      into v_items, v_ids
    from public.incidents i
    where i.project_id = v_grant.project_id;
  elsif v_module = 'PHOTOS' then
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'caption', m.caption, 'mime_type', m.mime_type, 'file_size_bytes', m.file_size_bytes,
                    'published_at_server', m.published_at_server) order by m.published_at_server desc), '[]'::jsonb),
           coalesce(array_agg(m.id), '{}')
      into v_items, v_ids
    from public.media_assets m
    join public.private_object_uploads u on u.id = m.private_object_upload_id
    where m.project_id = v_grant.project_id and m.status = 'PUBLIE' and u.status = 'FINALIZED';
  elsif v_module = 'DOCUMENTS' then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'document_type', d.document_type, 'title', d.title, 'description', d.description,
                    'visibility', d.visibility, 'status', d.status, 'version_number', v.version_number, 'mime_type', v.mime_type,
                    'file_size_bytes', v.file_size_bytes, 'published_at_server', d.published_at_server) order by d.published_at_server desc), '[]'::jsonb),
           coalesce(array_agg(d.id), '{}')
      into v_items, v_ids
    from public.documents d
    left join public.document_versions v on v.id = d.current_version_id
    where d.project_id = v_grant.project_id and d.published_at_server is not null
      and public.document_readable(d, v_grant.granted_by_party, null);
  elsif v_module = 'AVANCEMENT' then
    select coalesce(jsonb_agg(jsonb_build_object('id', ph.id, 'position', ph.position, 'label', ph.label, 'weight', ph.weight,
                    'progression', ph.progression, 'status', ph.status, 'planned_start', ph.planned_start, 'planned_end', ph.planned_end,
                    'started_at', ph.started_at, 'declared_completed_at', ph.declared_completed_at, 'validated_at', ph.validated_at)
                    order by ph.position), '[]'::jsonb),
           coalesce(array_agg(ph.id), '{}')
      into v_items, v_ids
    from public.project_phases ph
    where ph.project_id = v_grant.project_id and ph.archived_at is null;
  elsif v_module = 'COMMENTAIRES' then
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'target_type', c.target_type, 'target_id', coalesce(c.daily_log_id, c.incident_id),
                    'author_role', c.author_role, 'body', cv.body, 'version_number', cv.version_number, 'created_at_server', c.created_at_server)
                    order by c.created_at_server desc), '[]'::jsonb),
           coalesce(array_agg(c.id), '{}')
      into v_items, v_ids
    from public.comments c
    join public.comment_versions cv on cv.id = c.current_version_id
    left join public.daily_logs d on d.id = c.daily_log_id
    where c.project_id = v_grant.project_id and c.retracted_at_server is null and c.moderated_at_server is null
      and (c.incident_id is not null or d.status = 'PUBLIE');
  elsif v_module = 'EQUIPE' then
    select coalesce(jsonb_agg(jsonb_build_object('role', m.role::text, 'owner_profile', m.owner_profile::text, 'since', m.created_at_server)
                    order by m.created_at_server), '[]'::jsonb),
           coalesce(array_agg(m.id), '{}')
      into v_items, v_ids
    from public.project_memberships m
    where m.project_id = v_grant.project_id and m.revoked_at is null;
  end if;

  perform public.support_log(v_grant.project_id, v_grant.request_id, v_grant.id, 'ADMIN', v_admin, null, 'ACCESS_READ', v_module,
                             cardinality(v_ids), v_ids, null);
  return jsonb_build_object('ok', true, 'module', v_module, 'project_ref', upper(left(v_grant.project_id::text, 8)),
                            'expires_at_server', v_grant.expires_at_server, 'items', v_items);
end;
$$;

-- Fichier d'une photo publiée ou d'un document lisible par la partie qui a
-- accordé ; lien valable au plus 60 s et jamais au-delà de la fin de
-- l'accès. Ouverture tracée.
create function public.support_get_file(p_grant_id uuid, p_kind text, p_object_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_kind text := upper(btrim(coalesce(p_kind, '')));
  v_module text := case v_kind when 'PHOTO' then 'PHOTOS' when 'DOCUMENT' then 'DOCUMENTS' end;
  v_grant public.support_access_grants;
  v_req public.support_requests;
  v_refusal text;
  v_bucket text;
  v_key text;
  v_mime text;
begin
  select * into v_grant from public.support_access_grants g where g.id = p_grant_id;
  if not found then
    insert into public.platform_audit_events (actor_profile_id, actor_kind, action, target_table, target_id, reason)
    values (v_admin, 'ADMIN', 'SUPPORT_ACCESS_DENIED', 'support_access_grants', p_grant_id, 'grant_not_found');
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;
  select * into v_req from public.support_requests r where r.id = v_grant.request_id;
  v_refusal := public.support_check_grant(v_grant, v_req, v_admin, v_module);
  if v_refusal is null and v_kind = 'PHOTO' then
    select 'project-media', u.storage_key, m.mime_type into v_bucket, v_key, v_mime
    from public.media_assets m join public.private_object_uploads u on u.id = m.private_object_upload_id
    where m.id = p_object_id and m.project_id = v_grant.project_id and m.status = 'PUBLIE' and u.status = 'FINALIZED';
  elsif v_refusal is null and v_kind = 'DOCUMENT' then
    select 'project-documents', u.storage_key, v.mime_type into v_bucket, v_key, v_mime
    from public.documents d
    join public.document_versions v on v.id = d.current_version_id
    join public.private_object_uploads u on u.id = v.private_object_upload_id
    where d.id = p_object_id and d.project_id = v_grant.project_id and d.published_at_server is not null
      and public.document_readable(d, v_grant.granted_by_party, null) and u.status = 'FINALIZED';
  end if;
  if v_refusal is null and v_key is null then
    v_refusal := 'object_not_found';
  end if;
  if v_refusal is not null then
    perform public.support_log(v_grant.project_id, v_grant.request_id, v_grant.id, 'ADMIN', v_admin, null, 'ACCESS_DENIED', v_module, null,
                               case when p_object_id is null then null else array[p_object_id] end, v_refusal);
    return jsonb_build_object('ok', false, 'error', v_refusal);
  end if;
  perform public.support_log(v_grant.project_id, v_grant.request_id, v_grant.id, 'ADMIN', v_admin, null, 'FILE_OPENED', v_module, 1, array[p_object_id], null);
  return jsonb_build_object('ok', true, 'bucket', v_bucket, 'storage_key', v_key, 'mime_type', v_mime,
                            'expires_in', greatest(1, least(60, floor(extract(epoch from (v_grant.expires_at_server - clock_timestamp())))::integer)));
end;
$$;

revoke execute on function public.support_grant_access(uuid, text[], integer), public.support_create_request(uuid, text, text, text[], integer),
  public.support_revoke_access(uuid, text), public.support_close_request(uuid), public.support_list_project_requests(uuid),
  public.support_list_access_journal(uuid), public.support_active_access(uuid), public.admin_list_support_requests(boolean),
  public.admin_take_support_request(uuid, text), public.admin_get_support_request(uuid), public.support_read(uuid, text),
  public.support_get_file(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.support_grant_access(uuid, text[], integer), public.support_create_request(uuid, text, text, text[], integer),
  public.support_revoke_access(uuid, text), public.support_close_request(uuid), public.support_list_project_requests(uuid),
  public.support_list_access_journal(uuid), public.support_active_access(uuid), public.admin_list_support_requests(boolean),
  public.admin_take_support_request(uuid, text), public.admin_get_support_request(uuid), public.support_read(uuid, text),
  public.support_get_file(uuid, text, uuid)
  to authenticated;

commit;
