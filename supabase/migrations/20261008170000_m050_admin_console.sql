-- M050 — B050 : interface d'administration à métadonnées minimales
-- (done_when : « contenus privés absents »). Décisions du fondateur
-- 2026-10-08 : D195 (E1 à E8), D194 (administrateur), D019, D057, BR088.
--
-- Toutes les fonctions exigent un administrateur de plateforme
-- (require_platform_admin, M049) ; tout autre compte reçoit not_authorized.
-- Aucune ne lit un contenu de chantier : ni journal, ni photo, ni document,
-- ni dépense, ni budget, ni reçu, ni commentaire, ni nom, adresse ou
-- description de chantier, ni identité de membre (D195 E3, D194 A9).
--
-- - Tableau de bord (E2) : comptages seulement, chacun avec sa définition ;
--   aucun montant.
-- - Chantiers (E3) : identifiant court, statut, pays, état de la licence,
--   date de création, nombre de membres actifs par rôle.
-- - Comptes (E4) : aucune liste ; recherche sur identifiant EXACT (e-mail ou
--   téléphone normalisés), réponse minimale ; chaque recherche est auditée,
--   l'identifiant cherché masqué dans le journal.
-- - Organisations (E5) : nom d'entreprise, identifiant court, date, nombre de
--   membres et de chantiers, seulement pour un compte trouvé.
-- - Journal de plateforme (E6) : lecture ; jamais l'audit des chantiers.
-- - Prix de la licence (E7) : modification auditée (ancienne et nouvelle
--   valeur) ; les déclarations gardent le prix figé à leur création.

begin;

-- ---------------------------------------------------------------------------
-- 1. Tableau de bord (E2).
-- ---------------------------------------------------------------------------
create function public.admin_platform_stats()
returns table (metric text, label text, definition text, value bigint)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_platform_admin();
  return query
    select 'accounts_total'::text, 'Comptes'::text, 'Nombre de profils de compte créés.'::text, (select count(*) from public.profiles)::bigint
    union all
    select 'accounts_verified', 'Comptes vérifiés', 'Comptes ayant au moins un identifiant (e-mail ou téléphone) vérifié et non archivé.',
           (select count(distinct i.profile_id) from public.profile_identifiers i where i.verified_at_server is not null and i.archived_at is null)::bigint
    union all
    select 'organizations_total', 'Organisations', 'Organisations non archivées.', (select count(*) from public.organizations o where o.archived_at is null)::bigint
    union all
    select 'projects_' || lower(s.status), 'Chantiers — ' || s.status, 'Chantiers dont le statut est ' || s.status || '.', s.n
    from (select p.status::text as status, count(*)::bigint as n from public.projects p group by p.status) s
    union all
    select 'licenses_none', 'Licences — aucune', 'Chantiers sans aucune licence déclarée.',
           (select count(*) from public.projects p where not exists (select 1 from public.project_licenses l where l.project_id = p.id))::bigint
    union all
    select 'licenses_' || lower(l.status), 'Licences — ' || l.status, 'Chantiers dont la licence est à l''état ' || l.status || '.', l.n
    from (select pl.status as status, count(*)::bigint as n from public.project_licenses pl group by pl.status) l
    union all
    select 'license_payments_pending', 'Déclarations à vérifier', 'Déclarations de paiement de licence au statut PENDING_REVIEW.',
           (select count(*) from public.license_payments lp where lp.status = 'PENDING_REVIEW')::bigint
    union all
    select 'platform_admins', 'Administrateurs', 'Comptes désignés administrateurs de plateforme.', (select count(*) from public.platform_admins)::bigint;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Chantiers en métadonnées (E3).
-- ---------------------------------------------------------------------------
create function public.admin_list_projects(p_limit integer, p_offset integer)
returns table (project_ref text, status text, country text, license_status text, created_at_server timestamptz,
               contractors integer, owners_primary integer, co_owners integer, site_managers integer, total_count bigint)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform public.require_platform_admin();
  return query
    select upper(left(p.id::text, 8)), p.status::text, p.country, coalesce(l.status, 'NONE'), p.created_at_server,
           (select count(*)::integer from public.project_memberships m where m.project_id = p.id and m.revoked_at is null and m.role = 'CONTRACTOR'),
           (select count(*)::integer from public.project_memberships m where m.project_id = p.id and m.revoked_at is null and m.role = 'OWNER' and m.owner_profile = 'PRIMARY'),
           (select count(*)::integer from public.project_memberships m where m.project_id = p.id and m.revoked_at is null and m.role = 'OWNER' and m.owner_profile = 'CO_OWNER'),
           (select count(*)::integer from public.project_memberships m where m.project_id = p.id and m.revoked_at is null and m.role = 'SITE_MANAGER'),
           count(*) over ()
    from public.projects p
    left join public.project_licenses l on l.project_id = p.id
    order by p.created_at_server desc, p.id
    limit v_limit offset v_offset;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Recherche d'un compte sur identifiant exact (E4, E5).
-- ---------------------------------------------------------------------------
create function public.admin_mask_identifier(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_value is null or p_value = '' then ''
    when position('@' in p_value) > 1 then left(p_value, 1) || '•••@' || split_part(p_value, '@', 2)
    else left(p_value, 4) || '•••' || right(p_value, 2)
  end;
$$;

revoke execute on function public.admin_mask_identifier(text) from public, anon, authenticated, service_role;

create function public.admin_find_account(p_identifier text)
returns table (account_ref text, created_at_server timestamptz, verified boolean, active_memberships integer, is_admin boolean, organizations jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_raw text := btrim(coalesce(p_identifier, ''));
  v_value text;
  v_kind text;
  v_profile uuid;
begin
  if position('@' in v_raw) > 0 then
    v_kind := 'EMAIL';
    v_value := lower(v_raw);
  else
    v_kind := 'PHONE';
    v_value := regexp_replace(v_raw, '[[:space:].()-]', '', 'g');
  end if;
  if char_length(v_value) < 6 then
    raise exception 'identifier_invalid';
  end if;
  select i.profile_id into v_profile from public.profile_identifiers i
  where i.kind::text = v_kind and i.value_normalized = v_value and i.archived_at is null
  limit 1;
  insert into public.platform_audit_events (actor_profile_id, actor_kind, action, target_table, target_id, context)
  values (v_admin, 'ADMIN', 'ADMIN_ACCOUNT_LOOKUP', 'profiles', v_profile,
          jsonb_build_object('identifier_kind', v_kind, 'identifier_masked', public.admin_mask_identifier(v_value), 'found', v_profile is not null));
  if v_profile is null then
    return;
  end if;
  return query
    select upper(left(pr.id::text, 8)), pr.created_at_server,
           exists (select 1 from public.profile_identifiers i where i.profile_id = pr.id and i.verified_at_server is not null and i.archived_at is null),
           (select count(*)::integer from public.project_memberships m where m.profile_id = pr.id and m.revoked_at is null),
           exists (select 1 from public.platform_admins a where a.profile_id = pr.id),
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'organization_ref', upper(left(o.id::text, 8)),
                      'name', o.name,
                      'created_at_server', o.created_at_server,
                      'owner', o.owner_profile_id = pr.id,
                      'members', (select count(*) from public.organization_memberships om where om.organization_id = o.id and om.revoked_at is null),
                      'projects', (select count(*) from public.projects p where p.organization_id = o.id)) order by o.created_at_server)
             from public.organizations o
             where o.archived_at is null
               and (o.owner_profile_id = pr.id or exists (select 1 from public.organization_memberships om where om.organization_id = o.id and om.profile_id = pr.id and om.revoked_at is null))
           ), '[]'::jsonb)
    from public.profiles pr where pr.id = v_profile;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Journal de plateforme (E6).
-- ---------------------------------------------------------------------------
create function public.admin_list_platform_audit(p_limit integer)
returns table (action text, actor text, project_ref text, reason text, created_at_server timestamptz)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
begin
  return query
    select e.action,
           case when e.actor_kind = 'SERVER_OPERATION' then 'opération serveur'
                when e.actor_profile_id = v_admin then 'vous'
                else 'autre administrateur' end,
           case when e.project_id is null then null else upper(left(e.project_id::text, 8)) end,
           e.reason, e.created_at_server
    from public.platform_audit_events e
    order by e.created_at_server desc, e.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Prix de la licence (E7).
-- ---------------------------------------------------------------------------
create function public.admin_set_license_offer(p_price_fcfa text, p_price_is_demo boolean, p_expected_price_fcfa bigint)
returns table (label text, duration_months integer, price_fcfa bigint, price_is_demo boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_old jsonb;
  v_new jsonb;
  v_price bigint := public.advance_parse_amount(p_price_fcfa);
begin
  if p_price_is_demo is null then
    raise exception 'offer_invalid';
  end if;
  select s.value into v_old from public.platform_settings s where s.key = 'license_offer' for update;
  if v_old is null then
    raise exception 'license_offer_unavailable';
  end if;
  if p_expected_price_fcfa is null or (v_old->>'price_fcfa')::bigint <> p_expected_price_fcfa then
    raise exception 'revision_conflict';
  end if;
  if (v_old->>'price_fcfa')::bigint = v_price and coalesce((v_old->>'price_is_demo')::boolean, false) = p_price_is_demo then
    raise exception 'no_change';
  end if;
  v_new := v_old || jsonb_build_object('price_fcfa', v_price, 'price_is_demo', p_price_is_demo);
  update public.platform_settings set value = v_new, updated_at_server = clock_timestamp() where key = 'license_offer';
  insert into public.platform_audit_events (actor_profile_id, actor_kind, action, target_table, reason, context)
  values (v_admin, 'ADMIN', 'LICENSE_OFFER_CHANGED', 'platform_settings', 'Prix de la licence modifié.',
          jsonb_build_object('old', jsonb_build_object('price_fcfa', v_old->'price_fcfa', 'price_is_demo', v_old->'price_is_demo'),
                             'new', jsonb_build_object('price_fcfa', v_new->'price_fcfa', 'price_is_demo', v_new->'price_is_demo')));
  return query select v_new->>'label', (v_new->>'duration_months')::integer, (v_new->>'price_fcfa')::bigint, (v_new->>'price_is_demo')::boolean;
end;
$$;

revoke execute on function public.admin_platform_stats(), public.admin_list_projects(integer, integer), public.admin_find_account(text),
  public.admin_list_platform_audit(integer), public.admin_set_license_offer(text, boolean, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_platform_stats(), public.admin_list_projects(integer, integer), public.admin_find_account(text),
  public.admin_list_platform_audit(integer), public.admin_set_license_offer(text, boolean, bigint)
  to authenticated;

commit;
