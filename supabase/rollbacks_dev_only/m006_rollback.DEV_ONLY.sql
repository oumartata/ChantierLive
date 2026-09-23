-- DEV ONLY — rollback de 20260923090000_m006_invitations.sql
-- Jamais en production. Supprime uniquement les objets créés par ce
-- fichier ; ne touche à rien d'antérieur (M001-M005, M002a, M004a, M004b).

begin;

drop function if exists public.get_invitation_preview(text);
drop type if exists public.invitation_preview;

drop function if exists public.create_invitation(uuid, public.membership_role, public.identifier_kind, text);
drop type if exists public.invitation_created;

drop table if exists public.invitations;

drop index if exists public.project_memberships_contractor_unique;
drop trigger if exists set_membership_authorization_revision on public.project_memberships;
drop function if exists public.set_membership_authorization_revision();
alter table public.project_memberships drop column if exists authorization_revision;

commit;
