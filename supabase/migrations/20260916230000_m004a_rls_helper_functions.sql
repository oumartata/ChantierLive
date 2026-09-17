-- M004a — fonctions RLS de base (documentaire, entre M004 et M005)
-- MVP_BACKLOG.csv B010 "Créer fonctions RLS de base", dépend B009
-- Aucune ligne correspondante dans MIGRATION_ORDER.csv (signalé en cadrage) :
-- identifiant M004a purement documentaire, aucune renumérotation.
--
-- 4 fonctions livrées (is_active_project_member, has_project_role,
-- is_primary_owner, has_project_permission). 2 DIFFÉRÉES, non créées ici :
--   - can_access_private_object : "visibility" non défini (seul BR066 en
--     parle, pour la table documents, domaine evidence, non créée avant
--     M010/M011)
--   - has_support_scope : dépend de support_access_grants (M006, non
--     implémenté, lui-même dépendant de M005 non implémenté)
--
-- Arbitrage fondateur B010 (DECISIONS.yaml D082) : pour PHASE_EDIT_DRAFT et
-- EXPENSE_PUBLISH, CONTRACTOR natif ; SITE_MANAGER délégation obligatoire ;
-- OWNER (PRIMARY et CO_OWNER) refusé sans exception. Pour PHASE_VALIDATE et
-- APPROVAL_DECIDE : OWNER PRIMARY natif ; OWNER CO_OWNER délégation
-- (BR060) ; CONTRACTOR/SITE_MANAGER refusés. Correspondances codées en dur
-- ici (aucune table de catalogue créée, cadrage explicite).
--
-- Durcissement : SECURITY DEFINER, search_path = pg_catalog, pg_temp
-- (toutes les références public./auth. explicitement qualifiées), identité
-- exclusivement via auth.uid() (jamais un paramètre utilisateur), EXECUTE
-- révoqué à public/anon/authenticated/service_role puis accordé uniquement
-- à authenticated.

begin;

-- --------------------------------------------------------------------------
-- is_active_project_member
-- --------------------------------------------------------------------------

create function public.is_active_project_member(p_project_uuid uuid)
returns boolean
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  return exists (
    select 1
    from public.project_memberships pm
    where pm.project_id = p_project_uuid
      and pm.profile_id = auth.uid()
      and pm.revoked_at is null
  );
end;
$$;

-- --------------------------------------------------------------------------
-- has_project_role
-- --------------------------------------------------------------------------

create function public.has_project_role(p_project_uuid uuid, p_allowed_roles public.membership_role[])
returns boolean
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  return exists (
    select 1
    from public.project_memberships pm
    where pm.project_id = p_project_uuid
      and pm.profile_id = auth.uid()
      and pm.revoked_at is null
      and pm.role = any (p_allowed_roles)
  );
end;
$$;

-- --------------------------------------------------------------------------
-- is_primary_owner
-- --------------------------------------------------------------------------

create function public.is_primary_owner(p_project_uuid uuid)
returns boolean
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  return exists (
    select 1
    from public.project_memberships pm
    where pm.project_id = p_project_uuid
      and pm.profile_id = auth.uid()
      and pm.revoked_at is null
      and pm.role = 'OWNER'
      and pm.owner_profile = 'PRIMARY'
  );
end;
$$;

-- --------------------------------------------------------------------------
-- has_project_permission — limité aux 4 codes retenus. Rôle et adhésion
-- vérifiés en direct à chaque appel (jamais mis en cache), donc sensible à
-- un changement de rôle ou une révocation survenus après un octroi.
-- --------------------------------------------------------------------------

create function public.has_project_permission(p_project_uuid uuid, p_permission_code text)
returns boolean
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_membership record;
begin
  if p_permission_code not in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH', 'PHASE_VALIDATE', 'APPROVAL_DECIDE') then
    return false;
  end if;

  select pm.id, pm.role, pm.owner_profile
    into v_membership
    from public.project_memberships pm
    where pm.project_id = p_project_uuid
      and pm.profile_id = auth.uid()
      and pm.revoked_at is null;

  if not found then
    return false;
  end if;

  -- Refus explicite OWNER sur ces deux codes, sans exception (D082).
  if p_permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH') and v_membership.role = 'OWNER' then
    return false;
  end if;

  -- Droit natif CONTRACTOR.
  if p_permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH') and v_membership.role = 'CONTRACTOR' then
    return true;
  end if;

  -- Droit natif OWNER PRIMARY.
  if p_permission_code in ('PHASE_VALIDATE', 'APPROVAL_DECIDE')
     and v_membership.role = 'OWNER' and v_membership.owner_profile = 'PRIMARY' then
    return true;
  end if;

  -- Seul le rôle éligible à la délégation pour ce code peut poursuivre.
  if p_permission_code in ('PHASE_EDIT_DRAFT', 'EXPENSE_PUBLISH') and v_membership.role <> 'SITE_MANAGER' then
    return false;
  end if;
  if p_permission_code in ('PHASE_VALIDATE', 'APPROVAL_DECIDE')
     and not (v_membership.role = 'OWNER' and v_membership.owner_profile = 'CO_OWNER') then
    return false;
  end if;

  return exists (
    select 1
    from public.membership_permissions mp
    where mp.project_membership_id = v_membership.id
      and mp.permission_code = p_permission_code
      and mp.revoked_at_server is null
      and (mp.expires_at is null or mp.expires_at > now())
  );
end;
$$;

-- --------------------------------------------------------------------------
-- Durcissement des privilèges
-- --------------------------------------------------------------------------

revoke execute on function
  public.is_active_project_member(uuid),
  public.has_project_role(uuid, public.membership_role[]),
  public.is_primary_owner(uuid),
  public.has_project_permission(uuid, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.is_active_project_member(uuid),
  public.has_project_role(uuid, public.membership_role[]),
  public.is_primary_owner(uuid),
  public.has_project_permission(uuid, text)
to authenticated;

-- --------------------------------------------------------------------------
-- Lecture des participants (remplace project_memberships_select_own, M004) :
-- lecteur membre actif ET ligne consultée non révoquée. Le helper
-- SECURITY DEFINER évite la self-jointure/récursion rencontrée en B009.
-- --------------------------------------------------------------------------

drop policy if exists project_memberships_select_own on public.project_memberships;

create policy project_memberships_select_participants
on public.project_memberships
for select
to authenticated
using (
  revoked_at is null
  and public.is_active_project_member(project_id)
);

commit;
