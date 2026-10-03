-- M031b — RPC pour project_plan_requests/project_plan_request_variants (M031).
-- Même ordre de verrous que M020/M023b : avisoire du chantier -> adhésion ->
-- ligne métier -> écriture. Identité exclusivement via auth.uid() (jamais un
-- paramètre appelant) — aucun identifiant envoyé par le navigateur ne
-- constitue une autorisation, le paramètre retour du générateur 2D moins
-- que tout autre. Ne contourne ni ne réécrit prepare_project_plan_upload/
-- claim_upload_attempt/attest_storage_verified/finalize_project_plan_upload
-- (M020/M026), ni submit_plan_version_for_validation/publish_project_plan_version
-- (M023b) : finalize_plan_request_variant_deposit APPELLE
-- finalize_project_plan_upload telle quelle, ne la réimplémente jamais.

begin;

-- ---------------------------------------------------------------------------
-- create_plan_request — CONTRACTOR ou OWNER/PRIMARY du chantier ciblé
-- uniquement. generation_params est opaque ici (jamais validé en structure
-- par ce RPC — c'est le générateur 2D, inchangé, qui en décide la forme).
-- ---------------------------------------------------------------------------

create function public.create_plan_request(p_project_id uuid, p_generation_params jsonb)
returns public.project_plan_requests
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
  v_row public.project_plan_requests;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(hashtext('plan_request:' || p_project_id::text)::bigint);

  select role, owner_profile into v_membership
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if not found then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_generation_params is null then
    raise exception 'generation_params_required';
  end if;

  insert into public.project_plan_requests (
    project_id, created_by_profile_id, created_as_role, generation_params
  ) values (
    p_project_id, v_uid, case when v_membership.role = 'CONTRACTOR' then 'CONTRACTOR' else 'OWNER_PRIMARY' end, p_generation_params
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_plan_request(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_plan_request(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- list_plan_requests — mêmes lecteurs que les plans candidats aujourd'hui
-- (CONTRACTOR ou OWNER/PRIMARY actifs du chantier, jamais CO_OWNER ni
-- SITE_MANAGER). Inclut le nombre de variantes déjà sauvegardées (lecture
-- seule, pas d'exposition du contenu `layout` ici — voir
-- list_plan_request_variants pour le détail).
-- ---------------------------------------------------------------------------

create function public.list_plan_requests(p_project_id uuid)
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
      max(v.id) filter (where v.project_plan_version_id is not null) as deposited_variant_id
    from public.project_plan_requests r
    left join public.project_plan_request_variants v on v.request_id = r.id
    where r.project_id = p_project_id
    group by r.id
    order by r.created_at_server desc;
end;
$$;

revoke execute on function public.list_plan_requests(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_plan_requests(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- save_plan_request_variant — sauvegarde EXPLICITE d'une disposition
-- (jamais le brouillon local). "Modifier une disposition sauvegardée crée
-- une nouvelle variante" : toujours une insertion, numéro calculé sous
-- verrou, jamais une mise à jour en place. Refusé si la demande n'est plus
-- OPEN (déposée ou annulée) — repartir après dépôt se fait via une nouvelle
-- demande, jamais en rouvrant celle-ci.
-- ---------------------------------------------------------------------------

create function public.save_plan_request_variant(p_request_id uuid, p_parent_variant_id uuid, p_layout jsonb)
returns public.project_plan_request_variants
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_request public.project_plan_requests;
  v_membership record;
  v_next_number integer;
  v_row public.project_plan_request_variants;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_request from public.project_plan_requests where id = p_request_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('plan_request:' || v_request.project_id::text)::bigint);

  select role, owner_profile into v_membership
  from public.project_memberships
  where project_id = v_request.project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if not found then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_request.status <> 'OPEN' then
    raise exception 'request_not_open';
  end if;

  if p_layout is null then
    raise exception 'layout_required';
  end if;

  if p_parent_variant_id is not null and not exists (
    select 1 from public.project_plan_request_variants where id = p_parent_variant_id and request_id = p_request_id
  ) then
    raise exception 'parent_variant_not_found';
  end if;

  select coalesce(max(variant_number), 0) + 1 into v_next_number
  from public.project_plan_request_variants
  where request_id = p_request_id;

  insert into public.project_plan_request_variants (
    request_id, project_id, parent_variant_id, variant_number, layout, created_by_profile_id
  ) values (
    p_request_id, v_request.project_id, p_parent_variant_id, v_next_number, p_layout, v_uid
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.save_plan_request_variant(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_plan_request_variant(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- list_plan_request_variants / get_plan_request_variant — pour retrouver
-- l'état sauvegardé après rechargement (réimportable : le même `layout`
-- json que celui sauvegardé, aucune reconstruction côté serveur).
-- ---------------------------------------------------------------------------

create function public.list_plan_request_variants(p_request_id uuid)
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

  select project_id into v_project_id from public.project_plan_requests where id = p_request_id;
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

create function public.get_plan_request_variant(p_variant_id uuid)
returns public.project_plan_request_variants
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.project_plan_request_variants;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_row from public.project_plan_request_variants where id = p_variant_id;
  if not found then
    raise exception 'not_authorized';
  end if;

  if not exists (
    select 1 from public.project_memberships
    where project_id = v_row.project_id
      and profile_id = v_uid
      and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  ) then
    raise exception 'not_authorized';
  end if;

  return v_row;
end;
$$;

revoke execute on function public.get_plan_request_variant(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_plan_request_variant(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- finalize_plan_request_variant_deposit — SEUL chemin qui fait passer une
-- demande à DEPOSITED et rattache une variante à une version réellement
-- déposée. N'effectue JAMAIS elle-même l'écriture Storage ni la création de
-- project_plan_versions : appelle finalize_project_plan_upload (M020)
-- inchangée, qui a déjà revérifié les droits et l'état de l'upload. Reprise
-- idempotente : si la variante est déjà rattachée (tentative précédente
-- aboutie), renvoie l'état existant sans ré-exécuter quoi que ce soit —
-- "une reprise ne doit pas créer silencieusement deux dépôts".
-- ---------------------------------------------------------------------------

create function public.finalize_plan_request_variant_deposit(p_operation_uuid uuid, p_variant_id uuid)
returns public.project_plan_request_variants
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_variant public.project_plan_request_variants;
  v_request public.project_plan_requests;
  v_membership record;
  v_version public.project_plan_versions;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_variant from public.project_plan_request_variants where id = p_variant_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;

  -- Déjà rattachée (reprise après une exécution précédente aboutie) :
  -- idempotent, jamais un second rattachement ni un second passage à
  -- DEPOSITED.
  if v_variant.project_plan_version_id is not null then
    return v_variant;
  end if;

  select * into v_request from public.project_plan_requests where id = v_variant.request_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('plan_request:' || v_request.project_id::text)::bigint);

  select role, owner_profile into v_membership
  from public.project_memberships
  where project_id = v_request.project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if not found then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_request.status <> 'OPEN' then
    raise exception 'request_not_open';
  end if;

  -- Réutilise telle quelle la fonction M020 : prepare/claim/attest déjà
  -- effectués par l'appelant (même flux que depositProjectPlanAction),
  -- jamais réimplémentés ici.
  select * into v_version from public.finalize_project_plan_upload(p_operation_uuid);

  if v_version.project_id is distinct from v_request.project_id then
    raise exception 'version_project_mismatch';
  end if;

  update public.project_plan_request_variants
  set project_plan_version_id = v_version.id, deposited_at_server = clock_timestamp()
  where id = p_variant_id
  returning * into v_variant;

  update public.project_plan_requests
  set status = 'DEPOSITED'
  where id = v_request.id;

  return v_variant;
end;
$$;

revoke execute on function public.finalize_plan_request_variant_deposit(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finalize_plan_request_variant_deposit(uuid, uuid) to authenticated;

commit;
