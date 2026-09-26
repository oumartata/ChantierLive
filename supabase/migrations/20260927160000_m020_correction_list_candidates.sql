-- M020 correction ciblée (B063) — list_project_plan_candidates était déclarée
-- STABLE tout en verrouillant l'adhésion (SELECT ... FOR UPDATE), ce que
-- PostgreSQL refuse (0A000 "SELECT FOR UPDATE is not allowed in a
-- non-volatile function") : chaque appel échouait, l'écran des plans ne
-- pouvait rien lister. Lecture pure : aucun verrou n'est nécessaire, la
-- fonction reste STABLE et le prédicat de lecture est inchangé.

begin;

create or replace function public.list_project_plan_candidates(p_project_id uuid)
returns setof public.project_plan_candidate
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select id into v_membership_id
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'));

  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  return query
  select v.id, v.project_plan_id, v.origin, v.version_number, v.deposited_as_role, v.created_by_profile_id, v.created_at_server,
         exists(select 1 from public.project_plan_version_shares s where s.project_plan_version_id = v.id),
         exists(select 1 from public.projects p where p.id = p_project_id and p.retained_plan_version_id = v.id)
  from public.project_plan_versions v
  where v.project_id = p_project_id
    and public.project_plan_version_readable(v.id, v_uid)
  order by v.created_at_server desc;
end;
$$;

commit;
