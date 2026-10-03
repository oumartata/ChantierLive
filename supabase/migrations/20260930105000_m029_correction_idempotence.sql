-- M029 (correction) — reconciliation d'un état local où les contraintes
-- projects_latitude_range/_longitude_range/_location_pair avaient déjà été
-- posées (hors suivi de migration, constaté sur l'instance locale de ce
-- poste AVANT ce lot) mais où update_draft_project ne portait pas encore
-- les gardes applicatives M029 correspondantes — jamais introduit par ce
-- lot, seulement réconcilié ici pour que `supabase migration up --local`
-- puisse progresser sans ni supprimer ni recréer ces contraintes (aucune
-- donnée touchée). Même principe que les corrections ciblées déjà
-- pratiquées dans ce dépôt (ex. m019_correction_ciblee) : jamais une
-- réécriture de la migration d'origine.

begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_latitude_range' and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_latitude_range
        check (latitude is null or (latitude between -90 and 90));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_longitude_range' and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_longitude_range
        check (longitude is null or (longitude between -180 and 180));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_location_pair' and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_location_pair
        check ((latitude is null) = (longitude is null));
  end if;
end;
$$;

-- create or replace est sans risque à rejouer : redéfinit la fonction avec
-- les gardes M029 (latitude_out_of_range/longitude_out_of_range/
-- location_pair_incomplete), identique au corps déjà publié dans
-- 20260930100000_m029_project_location_validation.sql.
create or replace function public.update_draft_project(
  p_project_id uuid,
  p_expected_revision int,
  p_name text,
  p_country text,
  p_address text,
  p_latitude numeric,
  p_longitude numeric,
  p_planned_start_date date,
  p_planned_end_date date,
  p_budget bigint
)
returns public.projects
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
  v_project public.projects;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'name_required';
  end if;

  if p_country is null or btrim(p_country) = '' then
    raise exception 'country_required';
  end if;

  select id, role, owner_profile into v_membership
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if not found then
    raise exception 'not_authorized';
  end if;

  select * into v_project
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'project_not_found';
  end if;

  if v_project.status <> 'DRAFT' then
    raise exception 'not_draft';
  end if;

  if v_project.revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = '40001';
  end if;

  if p_latitude is not null and (p_latitude < -90 or p_latitude > 90) then
    raise exception 'latitude_out_of_range';
  end if;

  if p_longitude is not null and (p_longitude < -180 or p_longitude > 180) then
    raise exception 'longitude_out_of_range';
  end if;

  if (p_latitude is null) <> (p_longitude is null) then
    raise exception 'location_pair_incomplete';
  end if;

  update public.projects set
    name = p_name,
    country = p_country,
    address = p_address,
    latitude = p_latitude,
    longitude = p_longitude,
    planned_start_date = p_planned_start_date,
    planned_end_date = p_planned_end_date,
    budget = p_budget
  where id = p_project_id
  returning * into v_project;

  return v_project;
end;
$$;

revoke execute on function public.update_draft_project(uuid, int, text, text, text, numeric, numeric, date, date, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.update_draft_project(uuid, int, text, text, text, numeric, numeric, date, date, bigint)
  to authenticated;

commit;
