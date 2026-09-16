-- ============================================================================
-- DEV ONLY — rollback manuel de M004 (projects, project_memberships,
-- membership_permissions)
--
-- N'EST JAMAIS EXÉCUTÉ AUTOMATIQUEMENT : hors de supabase/migrations/, jamais
-- rejoué par le CLI Supabase. Réservé au développement local — ne jamais
-- exécuter sur un environnement contenant des données réelles.
--
-- Usage volontaire uniquement, par exemple :
--   psql "$DB_URL_LOCAL" -f supabase/rollbacks_dev_only/m004_rollback.DEV_ONLY.sql
--
-- Supprime uniquement les objets créés par M004. Aucun DROP ... CASCADE.
-- ============================================================================

begin;

-- membership_permissions ne bloque rien d'autre : dépend de project_memberships
-- (FK composite) et projects, mais rien ne dépend de membership_permissions.
drop table if exists public.membership_permissions;

-- La policy projects_select_own_membership référence project_memberships :
-- comme en M003, Postgres bloque le DROP TABLE de project_memberships tant
-- que cette policy existe sur projects. Retirée explicitement, gardée par
-- to_regclass pour rester idempotente sur une deuxième exécution.
do $$
begin
  if to_regclass('public.projects') is not null then
    execute 'drop policy if exists projects_select_own_membership on public.projects';
  end if;
end $$;

drop table if exists public.project_memberships;
drop table if exists public.projects;

drop function if exists public.set_project_revision();

commit;
