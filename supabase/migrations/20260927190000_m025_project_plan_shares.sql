-- M025 — project_plan_shares (T053) et lecture du plan publié (B064).
-- D096 : plan publié lisible par OWNER (PRIMARY et CO_OWNER) et CONTRACTOR
-- dont l'adhésion est active ; SITE_MANAGER actif seulement sur octroi
-- EXPLICITE au document par le CONTRACTOR, distinct des délégations
-- membership_permissions.
-- D111 : partage minimal, limité au plan ACTUELLEMENT publié ; aucun accès
-- aux brouillons, aux candidats ni aux versions remplacées (une republication
-- exige un nouvel octroi).
-- Ordre des verrous : avisoire du chantier -> adhésion(s) -> partage.

begin;

create table public.project_plan_shares (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  project_plan_version_id uuid not null references public.project_plan_versions (id) on delete restrict,
  site_manager_membership_id uuid not null references public.project_memberships (id) on delete restrict,
  site_manager_profile_id uuid not null references public.profiles (id) on delete restrict,
  granted_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  granted_at_server timestamptz not null,
  revoked_at_server timestamptz null,
  revoked_by_profile_id uuid null references public.profiles (id) on delete restrict,
  constraint project_plan_shares_revocation_consistency check (
    (revoked_at_server is null and revoked_by_profile_id is null)
    or (revoked_at_server is not null and revoked_by_profile_id is not null)
  ),
  constraint project_plan_shares_version_project_fk
    foreign key (project_plan_version_id, project_id) references public.project_plan_versions (id, project_id),
  constraint project_plan_shares_membership_project_fk
    foreign key (site_manager_membership_id, project_id) references public.project_memberships (id, project_id)
);

create unique index project_plan_shares_active_unique
  on public.project_plan_shares (project_plan_version_id, site_manager_membership_id)
  where revoked_at_server is null;
create index project_plan_shares_project_id_idx on public.project_plan_shares (project_id);

-- Seule mutation permise : révocation unique d'un octroi actif.
create function public.reject_project_plan_share_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'project_plan_share_immutable';
  end if;
  if old.revoked_at_server is not null
     or new.revoked_at_server is null
     or new.project_id <> old.project_id
     or new.project_plan_version_id <> old.project_plan_version_id
     or new.site_manager_membership_id <> old.site_manager_membership_id
     or new.site_manager_profile_id <> old.site_manager_profile_id
     or new.granted_by_profile_id <> old.granted_by_profile_id
     or new.granted_at_server <> old.granted_at_server then
    raise exception 'project_plan_share_immutable';
  end if;
  return new;
end;
$$;

create trigger reject_mutation
before update or delete on public.project_plan_shares
for each row execute function public.reject_project_plan_share_mutation();

alter table public.project_plan_shares enable row level security;
revoke all privileges on table public.project_plan_shares from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- grant_project_plan_share — CONTRACTOR actif, SITE_MANAGER actif du même
-- chantier, version = plan actuellement publié (D111).
-- ----------------------------------------------------------------------------

create function public.grant_project_plan_share(p_project_id uuid, p_version_id uuid, p_site_manager_membership_id uuid)
returns public.project_plan_shares
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_contractor_membership_id uuid;
  v_site_manager public.project_memberships;
  v_published uuid;
  v_row public.project_plan_shares;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select id into v_contractor_membership_id
  from public.project_memberships
  where project_id = p_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  for update;
  if v_contractor_membership_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_site_manager
  from public.project_memberships
  where id = p_site_manager_membership_id and project_id = p_project_id and revoked_at is null and role = 'SITE_MANAGER'
  for update;
  if not found then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select published_plan_version_id into v_published from public.projects where id = p_project_id;
  if v_published is null or v_published <> p_version_id then
    raise exception 'version_not_published';
  end if;

  select * into v_row
  from public.project_plan_shares
  where project_plan_version_id = p_version_id and site_manager_membership_id = v_site_manager.id and revoked_at_server is null;
  if found then
    return v_row;
  end if;

  insert into public.project_plan_shares (
    project_id, project_plan_version_id, site_manager_membership_id, site_manager_profile_id, granted_by_profile_id, granted_at_server
  ) values (
    p_project_id, p_version_id, v_site_manager.id, v_site_manager.profile_id, v_uid, clock_timestamp()
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.grant_project_plan_share(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.grant_project_plan_share(uuid, uuid, uuid) to authenticated;

create function public.revoke_project_plan_share(p_share_id uuid)
returns public.project_plan_shares
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_contractor_membership_id uuid;
  v_row public.project_plan_shares;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select project_id into v_project_id from public.project_plan_shares where id = p_share_id;
  if v_project_id is null then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_project_id::text)::bigint);

  select id into v_contractor_membership_id
  from public.project_memberships
  where project_id = v_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  for update;
  if v_contractor_membership_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_row from public.project_plan_shares where id = p_share_id for update;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_row.revoked_at_server is not null then
    return v_row;
  end if;

  update public.project_plan_shares
  set revoked_at_server = clock_timestamp(), revoked_by_profile_id = v_uid
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.revoke_project_plan_share(uuid) from public, anon, authenticated, service_role;
grant execute on function public.revoke_project_plan_share(uuid) to authenticated;

-- CONTRACTOR actif : octrois ACTIFS du chantier.
create function public.list_project_plan_shares(p_project_id uuid)
returns setof public.project_plan_shares
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = auth.uid() and revoked_at is null and role = 'CONTRACTOR'
  ) then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  return query
  select * from public.project_plan_shares
  where project_id = p_project_id and revoked_at_server is null
  order by granted_at_server;
end;
$$;

revoke execute on function public.list_project_plan_shares(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_project_plan_shares(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- get_published_project_plan_file — plan ACTUELLEMENT publié, lecteurs D096 :
-- OWNER (PRIMARY, CO_OWNER) et CONTRACTOR actifs ; SITE_MANAGER actif avec un
-- octroi actif sur CETTE version.
-- ----------------------------------------------------------------------------

create function public.get_published_project_plan_file(p_project_id uuid, out project_plan_version_id uuid, out storage_key text, out bucket text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership public.project_memberships;
  v_published uuid;
  v_file record;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select * into v_membership
  from public.project_memberships
  where project_id = p_project_id and profile_id = v_uid and revoked_at is null
    and role in ('OWNER', 'CONTRACTOR', 'SITE_MANAGER')
  for update;
  if not found then
    raise exception 'not_authorized';
  end if;

  select published_plan_version_id into v_published from public.projects where id = p_project_id;
  if v_published is null then
    raise exception 'not_published';
  end if;

  if v_membership.role = 'SITE_MANAGER' and not exists (
    select 1 from public.project_plan_shares s
    where s.project_plan_version_id = v_published and s.site_manager_membership_id = v_membership.id and s.revoked_at_server is null
  ) then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select * into v_file from public.project_plan_version_file(v_published);
  if v_file.upload_status is distinct from 'FINALIZED' then
    raise exception 'file_not_finalized';
  end if;

  project_plan_version_id := v_published;
  storage_key := v_file.storage_key;
  bucket := v_file.bucket;
end;
$$;

revoke execute on function public.get_published_project_plan_file(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_published_project_plan_file(uuid) to authenticated;

commit;
