-- M031c — correction ciblée : list_plan_request_variants référençait `id`
-- sans le qualifier dans sa recherche du project_id de la demande — ambigu
-- entre la colonne project_plan_requests.id et le paramètre de sortie `id`
-- déclaré par RETURNS TABLE (même nom), détecté par le test ciblé
-- scripts/test-plan-requests.mjs AVANT toute autre modification. Même
-- principe que les corrections ciblées déjà pratiquées dans ce dépôt (ex.
-- m019_correction_ciblee) : jamais une réécriture de la migration d'origine
-- (M031b), seule la fonction concernée est redéfinie ici.

begin;

create or replace function public.list_plan_request_variants(p_request_id uuid)
returns table (
  id uuid,
  parent_variant_id uuid,
  variant_number integer,
  created_by_profile_id uuid,
  created_at_server timestamptz,
  project_plan_version_id uuid,
  deposited_at_server timestamptz
)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select r.project_id into v_project_id from public.project_plan_requests r where r.id = p_request_id;
  if v_project_id is null then
    raise exception 'not_authorized';
  end if;

  if not exists (
    select 1 from public.project_memberships
    where project_id = v_project_id
      and profile_id = v_uid
      and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  ) then
    raise exception 'not_authorized';
  end if;

  return query
    select v.id, v.parent_variant_id, v.variant_number, v.created_by_profile_id, v.created_at_server,
           v.project_plan_version_id, v.deposited_at_server
    from public.project_plan_request_variants v
    where v.request_id = p_request_id
    order by v.variant_number asc;
end;
$$;

revoke execute on function public.list_plan_request_variants(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_plan_request_variants(uuid) to authenticated;

commit;
