-- Rollback DEV ONLY pour M004c (participants/délégations, B017). Jamais
-- exécuté en production — supprime les 6 nouveaux objets dans l'ordre de
-- dépendance inverse de la migration.

begin;

drop function if exists public.list_project_delegations(uuid);
drop type if exists public.project_delegation;
drop function if exists public.revoke_delegation(uuid);
drop function if exists public.grant_delegation(uuid, text);
drop function if exists public.remove_participant(uuid, text);
drop function if exists public.delegation_couple(text);
drop function if exists public.removal_required_actor(public.membership_role, public.owner_profile);

commit;
