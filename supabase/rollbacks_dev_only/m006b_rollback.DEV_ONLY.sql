-- Rollback DEV ONLY pour M006b (transfert de rôle principal, B018). Jamais
-- exécuté en production — supprime les nouveaux objets dans l'ordre de
-- dépendance inverse de la migration.

begin;

drop function if exists public.list_role_transfers(uuid);
drop type if exists public.role_transfer_view;
drop policy if exists role_transfers_select_concerned on public.role_transfers;
drop function if exists public.transfer_contractor_role(uuid, uuid, text);
drop function if exists public.confirm_role_transfer(uuid, text);
drop function if exists public.refuse_role_transfer(uuid, text);
drop function if exists public.cancel_role_transfer(uuid, text);
drop function if exists public.request_role_transfer(uuid, uuid, text);
drop function if exists public.is_profile_verified(uuid);
drop function if exists public.role_transfer_couple(public.membership_role);
drop table if exists public.role_transfers;
drop type if exists public.role_transfer_status;

commit;
