-- ============================================================================
-- DEV ONLY — rollback manuel de M004b (create_draft_project,
-- update_draft_project)
--
-- N'EST JAMAIS EXÉCUTÉ AUTOMATIQUEMENT : hors de supabase/migrations/, jamais
-- rejoué par le CLI Supabase. Réservé au développement local — ne jamais
-- exécuter sur un environnement contenant des données réelles.
--
-- Supprime uniquement les objets créés par M004b. Ne touche ni aux tables
-- projects/project_memberships (M004) ni organizations (M003), ni à leurs
-- données. Aucun DROP ... CASCADE.
-- ============================================================================

begin;

drop function if exists public.update_draft_project(uuid, int, text, text, text, numeric, numeric, date, date, bigint);
drop function if exists public.create_draft_project(text, text, public.membership_role, uuid, text);

commit;
