-- M004b — création/modification d'un chantier brouillon (B014)
-- Documentaire (comme M002a pour M002) : dépend de M004, ne la modifie pas.
-- MIGRATION_ORDER.csv ne réserve aucun numéro pour ce cas — même lacune que
-- celle déjà signalée pour M004a (B010).
--
-- Arbitrages fondateur B014 (2026-09-22) :
--   - create_draft_project() et update_draft_project() sont les SEULES voies
--     d'écriture sur projects/project_memberships/organizations pour ce
--     périmètre (M004/M003 ne grant aucun insert/update direct).
--   - Provisioning minimal de l'organisation personnelle CONTRACTOR (FR014,
--     différé lors de B008) inclus ici : réutilisation si une seule
--     organisation active appartient à l'appelant, choix explicite exigé si
--     plusieurs (jamais un ORDER BY ... LIMIT 1 pour décider à sa place),
--     création "Espace professionnel" si aucune. D077 autorise plusieurs
--     organisations par profil : aucune contrainte d'unicité ajoutée.
--   - Verrou avisoire (pg_advisory_xact_lock) pour sérialiser la
--     résolution/création d'organisation par propriétaire et empêcher deux
--     organisations automatiques lors de créations concurrentes.
--   - update_draft_project() : formulaire complet à chaque appel (tous les
--     champs facultatifs sont fournis explicitement, aucune valeur par
--     défaut) — NULL efface un champ facultatif, jamais un COALESCE qui
--     empêcherait l'effacement. name/country restent obligatoires.
--   - Ordre de verrouillage documenté et respecté : project_memberships
--     (adhésion autorisante) AVANT projects. Toute future fonction touchant
--     ces deux tables doit respecter cet ordre pour éviter un interblocage
--     entre transactions concurrentes.
--   - Un appelant non autorisé ne reçoit jamais d'information sur le
--     chantier visé (existence, statut, révision) : message unique
--     'not_authorized' avant tout accès à la ligne projects.
--   - Le trigger set_project_revision (M004) reste la seule source
--     d'incrément de revision ; jamais fixée manuellement ici.

begin;

-- ----------------------------------------------------------------------------
-- create_draft_project — chantier DRAFT + adhésion initiale (+ organisation
-- CONTRACTOR si nécessaire) dans une seule transaction.
-- ----------------------------------------------------------------------------

create function public.create_draft_project(
  p_name text,
  p_country text,
  p_role public.membership_role,
  p_organization_id uuid default null,
  p_organization_name text default null
)
returns table (project_id uuid, membership_id uuid, organization_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_membership_id uuid;
  v_org_id uuid;
  v_owner_profile public.owner_profile;
  v_org_count int;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Vérification du compte côté SQL, indépendante du garde-fou applicatif
  -- (B013) : tient même en appel RPC direct.
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_role is null or p_role not in ('OWNER', 'CONTRACTOR') then
    raise exception 'invalid_initial_role';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'name_required';
  end if;

  if p_country is null or btrim(p_country) = '' then
    raise exception 'country_required';
  end if;

  if p_role = 'OWNER' then
    -- BR012/M004 : un OWNER n'a pas nécessairement d'organisation. Aucune
    -- source n'autorise à en attacher une ici : toujours NULL pour ce rôle.
    v_owner_profile := 'PRIMARY';
    v_org_id := null;
  else
    v_owner_profile := null;

    -- Sérialise la résolution/création d'organisation pour CE propriétaire
    -- uniquement (clé dérivée de son identité) : deux appels concurrents du
    -- même profil sans organisation existante ne doivent jamais produire
    -- deux organisations automatiques. Verrou avisoire de transaction,
    -- libéré automatiquement au commit/rollback. hashtext() est un hachage
    -- 32 bits : une collision avec la clé d'un AUTRE propriétaire est
    -- possible (rare) et causerait alors une attente supplémentaire non
    -- nécessaire pour cet autre propriétaire — jamais un mélange de leurs
    -- données, seulement une sérialisation superflue le temps d'un appel.
    perform pg_advisory_xact_lock(hashtext('org_provisioning:' || v_uid::text)::bigint);

    if p_organization_id is not null then
      -- Organisation explicitement choisie par l'appelant.
      v_org_id := p_organization_id;
    else
      -- Aucun choix fourni : ne jamais deviner en présence d'ambiguïté
      -- (pas de ORDER BY ... LIMIT 1). D077 autorise plusieurs organisations
      -- actives par profil.
      select count(*) into v_org_count
      from public.organizations
      where owner_profile_id = v_uid and archived_at is null;

      if v_org_count > 1 then
        raise exception 'organization_choice_required';
      elsif v_org_count = 1 then
        select id into v_org_id
        from public.organizations
        where owner_profile_id = v_uid and archived_at is null;
      else
        insert into public.organizations (name, owner_profile_id)
        values (coalesce(nullif(btrim(p_organization_name), ''), 'Espace professionnel'), v_uid)
        returning id into v_org_id;
      end if;
    end if;

    -- Verrouille l'organisation retenue (choix explicite, réutilisée ou
    -- fraîchement créée) et revérifie propriété + non-archivage SOUS ce
    -- verrou, juste avant de l'utiliser pour le chantier : ferme la fenêtre
    -- entre sa résolution ci-dessus et l'insertion, pendant laquelle un
    -- archivage concurrent passerait sinon inaperçu. Couvre le choix
    -- explicite ET la réutilisation (pas la création, déjà exclusive à
    -- cette transaction). Si l'organisation n'est plus disponible, la
    -- fonction s'arrête ici : aucun chantier CONTRACTOR n'est jamais créé
    -- avec organization_id NULL en repli.
    if not exists (
      select 1 from public.organizations
      where id = v_org_id
        and owner_profile_id = v_uid
        and archived_at is null
      for update
    ) then
      raise exception 'organization_not_owned_or_archived';
    end if;
  end if;

  insert into public.projects (name, country, organization_id)
  values (p_name, p_country, v_org_id)
  returning id into v_project_id;

  insert into public.project_memberships (project_id, profile_id, role, owner_profile)
  values (v_project_id, v_uid, p_role, v_owner_profile)
  returning id into v_membership_id;

  return query select v_project_id, v_membership_id, v_org_id;
end;
$$;

revoke execute on function public.create_draft_project(text, text, public.membership_role, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_draft_project(text, text, public.membership_role, uuid, text)
  to authenticated;

-- ----------------------------------------------------------------------------
-- update_draft_project — remplacement complet des champs modifiables d'un
-- chantier en DRAFT, sous contrôle atomique d'adhésion, de statut et de
-- révision.
-- ----------------------------------------------------------------------------

create function public.update_draft_project(
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

  -- Ordre de verrouillage (à respecter par toute future fonction touchant
  -- project_memberships ET projects, pour éviter un interblocage) :
  --   1) project_memberships (adhésion autorisante)
  --   2) projects
  -- SELECT ... FOR UPDATE pose un verrou incompatible avec une révocation ou
  -- un changement de rôle concurrent sur cette même ligne : l'un des deux
  -- attend la fin de l'autre, jamais de lecture non synchronisée.
  select id, role, owner_profile into v_membership
  from public.project_memberships
  where project_id = p_project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if not found then
    -- Message unique, sans aucun détail sur le chantier visé (existence,
    -- statut, révision) : identique qu'il existe ou non, pour ne rien
    -- révéler à un appelant non autorisé.
    raise exception 'not_authorized';
  end if;

  -- À partir d'ici l'appelant est un membre confirmé de CE chantier : les
  -- diagnostics suivants peuvent légitimement le concerner.
  select * into v_project
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    -- Non atteignable en pratique (FK RESTRICT project_memberships->projects
    -- garantit l'existence) ; conservé comme filet de sécurité.
    raise exception 'project_not_found';
  end if;

  if v_project.status <> 'DRAFT' then
    raise exception 'not_draft';
  end if;

  if v_project.revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = '40001';
  end if;

  -- Affectation directe (jamais coalesce) : formulaire complet exigé côté
  -- appelant, NULL efface explicitement un champ facultatif. name/country
  -- déjà validés non vides ci-dessus.
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
  -- set_project_revision (trigger existant, M004) incrémente revision seul.

  return v_project;
end;
$$;

revoke execute on function public.update_draft_project(uuid, int, text, text, text, numeric, numeric, date, date, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.update_draft_project(uuid, int, text, text, text, numeric, numeric, date, date, bigint)
  to authenticated;

commit;
