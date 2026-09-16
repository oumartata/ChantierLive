-- ============================================================================
-- DEV ONLY — rollback manuel de M001 (extensions, enums, fonctions communes)
--
-- N'EST JAMAIS EXÉCUTÉ AUTOMATIQUEMENT : ce fichier vit hors de
-- supabase/migrations/ précisément pour que le CLI Supabase ne le rejoue
-- jamais comme une migration ascendante. Réservé au développement local
-- (MIGRATION_ORDER.csv M001 rollback_or_recovery: "migration inverse en
-- développement") — ne jamais exécuter sur un environnement partagé ou
-- contenant des données réelles.
--
-- Usage volontaire uniquement, par exemple :
--   psql "$DB_URL_LOCAL" -f supabase/rollbacks_dev_only/m001_rollback.DEV_ONLY.sql
--
-- Supprime uniquement les objets créés par M001. Aucune table métier n'est
-- concernée (M001 n'en crée aucune). Ordre inverse de la création.
-- ============================================================================

begin;

-- Pas de REVOKE préalable : DROP FUNCTION IF EXISTS retire la fonction (et
-- ses privilèges avec elle) en une seule étape idempotente. Un REVOKE
-- distinct échouerait sur une deuxième exécution du rollback, la fonction
-- étant déjà absente.
drop function if exists public.set_updated_at_server();

drop type if exists public.license_status;
drop type if exists public.sync_item_status;
drop type if exists public.incident_status;
drop type if exists public.advance_status;
drop type if exists public.financial_record_status;
drop type if exists public.record_status;
drop type if exists public.project_status;
drop type if exists public.invitation_status;
drop type if exists public.owner_profile;
drop type if exists public.membership_role;

-- pgcrypto N'EST PAS supprimée : audit confirmé qu'elle est provisionnée par
-- le bootstrap propre à Supabase (/docker-entrypoint-initdb.d/init-scripts/
-- 00000000000000-initial-schema.sql), donc préexistante et partagée avec
-- d'autres composants (Auth/GoTrue notamment) — pas un objet créé par M001.
-- Un rollback ne doit retirer que ce que la migration a réellement introduit.

commit;
