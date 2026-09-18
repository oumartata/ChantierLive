-- ============================================================================
-- DEV ONLY — rollback manuel de M002a (provisioning du profil, synchronisation
-- des identifiants, is_account_provisional)
--
-- N'EST JAMAIS EXÉCUTÉ AUTOMATIQUEMENT : hors de supabase/migrations/, jamais
-- rejoué par le CLI Supabase. Réservé au développement local — ne jamais
-- exécuter sur un environnement contenant des données réelles.
--
-- Supprime uniquement les objets créés par M002a. Ne touche ni aux tables
-- profiles/profile_identifiers (M002) ni à leurs données. Aucun DROP ...
-- CASCADE.
-- ============================================================================

begin;

drop trigger if exists sync_profile_on_auth_update on auth.users;
drop trigger if exists provision_profile_on_signup on auth.users;

drop function if exists public.is_account_provisional();
drop function if exists public.sync_profile_on_auth_update();
drop function if exists public.provision_profile_on_signup();
drop function if exists public.sync_auth_identifier(uuid, public.identifier_kind, text, text, timestamptz, timestamptz);

commit;
