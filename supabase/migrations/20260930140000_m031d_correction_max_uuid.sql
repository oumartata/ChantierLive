-- M031d — correction ciblée : list_plan_requests utilisait max(uuid), qui
-- n'existe pas comme agrégat en PostgreSQL (aucun opérateur de tri total
-- défini par défaut pour uuid) — détecté par le parcours navigateur réel
-- (page Plans, section "Demandes de plan") AVANT toute autre modification.
-- Corrigé par array_agg(...)[1], qui fonctionne pour n'importe quel type et
-- reste correct ici car au plus UNE variante par demande peut être déposée
-- (une fois déposée, la demande passe à DEPOSITED, M031b). Même principe que
-- les corrections ciblées déjà pratiquées dans ce dépôt : jamais une
-- réécriture de la migration d'origine (M031b).

begin;

create or replace function public.list_plan_requests(p_project_id uuid)
returns table (
  id uuid,
  created_by_profile_id uuid,
  created_as_role text,
  generation_params jsonb,
  status text,
  created_at_server timestamptz,
  variant_count bigint,
  deposited_variant_id uuid
)
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
    where project_id = p_project_id
      and profile_id = v_uid
      and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  ) then
    raise exception 'not_authorized';
  end if;

  return query
    select
      r.id, r.created_by_profile_id, r.created_as_role, r.generation_params, r.status, r.created_at_server,
      count(v.id) as variant_count,
      (array_agg(v.id) filter (where v.project_plan_version_id is not null))[1] as deposited_variant_id
    from public.project_plan_requests r
    left join public.project_plan_request_variants v on v.request_id = r.id
    where r.project_id = p_project_id
    group by r.id
    order by r.created_at_server desc;
end;
$$;

revoke execute on function public.list_plan_requests(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_plan_requests(uuid) to authenticated;

commit;
