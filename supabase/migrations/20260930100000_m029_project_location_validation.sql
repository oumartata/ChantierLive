-- M029 — validation serveur de la position d'un chantier (complément B014)
-- Documentaire (comme M004a/M023c) : dépend de M004/M004b, ne les modifie pas.
-- MIGRATION_ORDER.csv réserve la ligne 29 pour ce cas.
--
-- Constat (vérifié en lecture seule avant cette migration) :
--   - update_draft_project (M004b) affectait p_latitude/p_longitude sans
--     aucun garde propre ; seule la couche applicative (actions.ts) validait
--     les bornes, contournable par tout appel RPC direct.
--   - Aucune contrainte CHECK n'existait sur projects.latitude/longitude.
--   - Données existantes relues avant d'ajouter les contraintes : un seul
--     chantier avec coordonnées non nulles (1, 4), déjà dans les bornes —
--     aucune correction de données nécessaire.
--
-- Arbitrages fondateur (2026-09-30, complément B014, sans réouverture) :
--   - Contrôles de plage ET de paire à la fois en base (CHECK, dernier
--     rempart) et dans update_draft_project (message d'erreur explicite,
--     même style que name_required/country_required déjà présents).
--   - NULL/NULL reste autorisé (effacement complet) : seul un effacement
--     partiel (un seul des deux champs) devient refusé.
--   - Ordre et comportement des contrôles existants (droits, compte, statut,
--     révision) intégralement préservés : les nouveaux gardes s'ajoutent
--     après ces contrôles, jamais avant.

begin;

alter table public.projects
  add constraint projects_latitude_range
    check (latitude is null or (latitude between -90 and 90)),
  add constraint projects_longitude_range
    check (longitude is null or (longitude between -180 and 180)),
  add constraint projects_location_pair
    check ((latitude is null) = (longitude is null));

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

  -- M029 — validation de la position, après droits/compte/statut/révision,
  -- avant toute écriture. NULL/NULL reste un effacement complet valide.
  if p_latitude is not null and (p_latitude < -90 or p_latitude > 90) then
    raise exception 'latitude_out_of_range';
  end if;

  if p_longitude is not null and (p_longitude < -180 or p_longitude > 180) then
    raise exception 'longitude_out_of_range';
  end if;

  if (p_latitude is null) <> (p_longitude is null) then
    raise exception 'location_pair_incomplete';
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
