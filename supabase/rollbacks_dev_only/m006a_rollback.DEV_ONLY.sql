-- DEV ONLY — rollback de 20260923150000_m006a_invitation_decisions.sql
-- Jamais en production. Supprime uniquement les objets créés par ce
-- fichier ; ne touche à rien d'antérieur (M001-M006, M002a, M004a, M004b).

begin;

drop function if exists public.list_manageable_invitations(uuid);
drop type if exists public.manageable_invitation;

drop function if exists public.revoke_invitation(uuid);
drop function if exists public.refuse_invitation(text);
drop function if exists public.accept_invitation(text);

drop function if exists public.invitation_required_emitter(public.membership_role, public.owner_profile);

commit;
