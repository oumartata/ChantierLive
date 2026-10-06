-- M035 — traçabilité de la copie catalogue → chantier
-- (PREPARATION_CATALOGUE_MODIFIABLE.md §9.4). Une demande créée depuis un
-- modèle conserve la VERSION EXACTE du catalogue à son origine — jamais le
-- modèle seul ni « sa version publiée actuelle » : une publication
-- ultérieure ne change rien à l'origine enregistrée (les versions sont
-- elles-mêmes immuables, M019). Additive : toutes les demandes existantes
-- gardent une origine nulle (« non renseignée »), aucune n'est réécrite,
-- aucune origine n'est déduite.
--
-- Aucun droit nouveau : create_plan_request_from_catalog_item applique en
-- base exactement les règles déjà en place — lecture de la source réservée
-- au propriétaire de l'organisation (get_catalog_item_version_file, M032),
-- rattachement chantier → organisation (attach_catalog_plan_to_project,
-- D107), adhésion active CONTRACTOR ou OWNER/PRIMARY et compte non
-- provisoire (create_plan_request, M031b). La propriété de l'organisation
-- seule n'ouvre aucun chantier. La variante 1 (la copie) reste enregistrée
-- par le circuit M034, inchangé.

begin;

-- ---------------------------------------------------------------------------
-- Colonnes : origine exacte + opération de création (reprise sans doublon).
-- Posées ensemble ou pas du tout ; jamais modifiables ensuite.
-- ---------------------------------------------------------------------------
alter table public.project_plan_requests
  add column source_catalog_item_version_id uuid null
    references public.plan_catalog_item_versions (id) on delete restrict,
  add column catalog_copy_operation_uuid uuid null;

alter table public.project_plan_requests
  add constraint project_plan_requests_catalog_copy_operation_unique unique (catalog_copy_operation_uuid),
  add constraint project_plan_requests_catalog_source_coherent
    check ((source_catalog_item_version_id is null) = (catalog_copy_operation_uuid is null));

create index project_plan_requests_source_version_idx
  on public.project_plan_requests (source_catalog_item_version_id)
  where source_catalog_item_version_id is not null;

-- Déclencheur d'immuabilité (corps M031 repris à l'identique, deux
-- conditions ajoutées).
create or replace function public.reject_project_plan_request_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'project_plan_request_immutable';
  end if;
  if old.status <> 'OPEN' then
    raise exception 'request_already_terminal';
  end if;
  if new.status not in ('OPEN', 'DEPOSITED', 'CANCELLED') then
    raise exception 'project_plan_request_immutable';
  end if;
  if new.project_id <> old.project_id
     or new.created_by_profile_id <> old.created_by_profile_id
     or new.created_as_role <> old.created_as_role
     or new.generation_params <> old.generation_params
     or new.created_at_server <> old.created_at_server
     or new.source_catalog_item_version_id is distinct from old.source_catalog_item_version_id
     or new.catalog_copy_operation_uuid is distinct from old.catalog_copy_operation_uuid then
    raise exception 'project_plan_request_immutable';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_plan_request_from_catalog_item — SEULE voie qui pose une origine.
-- Idempotente par opération : même opération, même auteur, même chantier,
-- même version, mêmes paramètres ⇒ même demande, rien d'écrit ; toute autre
-- combinaison sous la même opération est refusée. Droits sur le chantier et
-- sur la source toujours revérifiés, y compris en reprise ; la publication
-- de la version n'est exigée qu'à la création (une reprise après réponse
-- perdue reste possible si une autre version a été publiée depuis).
-- ---------------------------------------------------------------------------
create function public.create_plan_request_from_catalog_item(
  p_project_id uuid,
  p_catalog_item_version_id uuid,
  p_generation_params jsonb,
  p_operation_uuid uuid
)
returns public.project_plan_requests
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership record;
  v_project public.projects;
  v_version public.plan_catalog_item_versions;
  v_item public.plan_catalog_items;
  v_org public.organizations;
  v_row public.project_plan_requests;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_operation_uuid is null or p_catalog_item_version_id is null then
    raise exception 'catalog_copy_invalid';
  end if;
  if p_generation_params is null or jsonb_typeof(p_generation_params) <> 'object' then
    raise exception 'generation_params_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('plan_request:' || p_project_id::text)::bigint);

  -- Chantier : mêmes règles que create_plan_request.
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

  -- Source : lisible par le seul propriétaire de son organisation (même
  -- règle que get_catalog_item_version_file), et chantier rattaché à cette
  -- organisation (D107).
  select * into v_version from public.plan_catalog_item_versions where id = p_catalog_item_version_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  select * into v_org from public.organizations where id = v_version.organization_id;
  if not found or v_org.owner_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;
  select * into v_project from public.projects where id = p_project_id;
  if not found or v_project.organization_id is distinct from v_version.organization_id then
    raise exception 'catalog_organization_mismatch';
  end if;

  -- Reprise : l'opération a déjà créé une demande.
  select * into v_row from public.project_plan_requests where catalog_copy_operation_uuid = p_operation_uuid;
  if found then
    if v_row.project_id <> p_project_id
       or v_row.created_by_profile_id <> v_uid
       or v_row.source_catalog_item_version_id <> p_catalog_item_version_id
       or v_row.generation_params <> p_generation_params then
      raise exception 'catalog_copy_operation_conflict';
    end if;
    return v_row;
  end if;

  -- Création : version PUBLIÉE (au moment de l'écriture) et structurée.
  select * into v_item from public.plan_catalog_items where id = v_version.catalog_item_id for update;
  if not found or v_item.organization_id <> v_org.id or v_item.archived_at is not null or v_org.archived_at is not null then
    raise exception 'not_authorized';
  end if;
  if v_item.published_version_id is distinct from p_catalog_item_version_id then
    raise exception 'catalog_version_not_published';
  end if;
  if v_version.layout is null then
    raise exception 'catalog_item_not_editable';
  end if;

  begin
    insert into public.project_plan_requests (
      project_id, created_by_profile_id, created_as_role, generation_params,
      source_catalog_item_version_id, catalog_copy_operation_uuid
    ) values (
      p_project_id, v_uid, case when v_membership.role = 'CONTRACTOR' then 'CONTRACTOR' else 'OWNER_PRIMARY' end, p_generation_params,
      p_catalog_item_version_id, p_operation_uuid
    )
    returning * into v_row;
  exception when unique_violation then
    -- Même opération lancée sur un autre chantier en parallèle : jamais
    -- deux demandes pour une opération.
    raise exception 'catalog_copy_operation_conflict';
  end;

  return v_row;
end;
$$;

revoke execute on function public.create_plan_request_from_catalog_item(uuid, uuid, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_plan_request_from_catalog_item(uuid, uuid, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- list_plan_request_origins — origine des demandes d'un chantier, mêmes
-- lecteurs que list_plan_requests. Le libellé et le numéro de version du
-- modèle ne sont renvoyés qu'à qui peut déjà lire le catalogue (propriétaire
-- de l'organisation) ; les autres apprennent seulement que l'origine est un
-- modèle du catalogue. Jamais d'identifiant de modèle, de fichier ni de
-- plan : la provenance n'ouvre aucun accès au catalogue.
-- ---------------------------------------------------------------------------
create function public.list_plan_request_origins(p_project_id uuid)
returns table (
  request_id uuid,
  has_catalog_source boolean,
  source_details_visible boolean,
  catalog_item_label text,
  catalog_version_number integer
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
      r.id,
      r.source_catalog_item_version_id is not null,
      coalesce(o.owner_profile_id = v_uid, false),
      case when o.owner_profile_id = v_uid then i.label end,
      case when o.owner_profile_id = v_uid then v.version_number end
    from public.project_plan_requests r
    left join public.plan_catalog_item_versions v on v.id = r.source_catalog_item_version_id
    left join public.plan_catalog_items i on i.id = v.catalog_item_id
    left join public.organizations o on o.id = v.organization_id
    where r.project_id = p_project_id;
end;
$$;

revoke execute on function public.list_plan_request_origins(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_plan_request_origins(uuid) to authenticated;

commit;
