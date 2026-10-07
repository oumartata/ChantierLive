-- M038b — correctif ciblé de M038 (jamais une réécriture du fichier
-- appliqué) : list_project_incidents renvoyait project_memberships.role et
-- owner_profile (types énumérés membership_role / owner_profile) dans des
-- colonnes text de incident_view, d'où « structure of query does not match
-- function result type » à chaque lecture. Conversion explicite en text ;
-- droits, filtre et tri inchangés.

begin;

create or replace function public.list_project_incidents(p_project_id uuid, p_limit integer default 50, p_offset integer default 0)
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
           i.status not in ('CLOS', 'ANNULE') and public.incident_can_assign(v_actor)
    from public.incidents i
    left join public.project_memberships am
      on am.project_id = i.project_id and am.profile_id = i.assignee_profile_id and am.revoked_at is null
    where i.project_id = p_project_id
    order by (i.status in ('CLOS', 'ANNULE')), i.created_at_server desc
    limit v_limit offset v_offset;
end;
$$;

revoke execute on function public.list_project_incidents(uuid, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_project_incidents(uuid, integer, integer) to authenticated;

commit;
