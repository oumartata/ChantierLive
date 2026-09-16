-- ============================================================================
-- DEV ONLY — rollback manuel de M002 (profiles, profile_identifiers)
--
-- N'EST JAMAIS EXÉCUTÉ AUTOMATIQUEMENT : hors de supabase/migrations/, jamais
-- rejoué par le CLI Supabase. Réservé au développement local
-- (MIGRATION_ORDER.csv M002 rollback_or_recovery: "suppression dev seulement
-- avant données") — ne jamais exécuter sur un environnement contenant des
-- données réelles.
--
-- Usage volontaire uniquement, par exemple :
--   psql "$DB_URL_LOCAL" -f supabase/rollbacks_dev_only/m002_rollback.DEV_ONLY.sql
--
-- Supprime uniquement les objets créés par M002. Aucun DROP ... CASCADE :
-- rien d'autre ne référence encore ces tables (M002 est la migration la plus
-- récente). Ordre inverse de la création (enfant avant parent pour la FK).
-- ============================================================================

begin;

drop table if exists public.profile_identifiers;
drop table if exists public.profiles;
drop type if exists public.identifier_kind;

commit;
