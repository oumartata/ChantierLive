-- ============================================================================
-- DEV ONLY — rollback manuel de M003 (organizations, organization_memberships)
--
-- N'EST JAMAIS EXÉCUTÉ AUTOMATIQUEMENT : hors de supabase/migrations/, jamais
-- rejoué par le CLI Supabase. Réservé au développement local — ne jamais
-- exécuter sur un environnement contenant des données réelles.
--
-- Usage volontaire uniquement, par exemple :
--   psql "$DB_URL_LOCAL" -f supabase/rollbacks_dev_only/m003_rollback.DEV_ONLY.sql
--
-- Supprime uniquement les objets créés par M003. Aucun DROP ... CASCADE.
-- Ordre inverse de la création (enfant avant parent pour la FK).
-- ============================================================================

begin;

-- La policy organizations_select_owner_or_member référence
-- organization_memberships (sous-requête d'appartenance) : Postgres bloque le
-- DROP TABLE de organization_memberships tant que cette policy existe sur
-- organizations, même sans FK dans ce sens. On la retire explicitement plutôt
-- que d'utiliser CASCADE. DROP POLICY exige que la table cible existe (IF
-- EXISTS ne porte que sur la policy) : gardé par to_regclass pour rester
-- idempotent sur une deuxième exécution, où organizations n'existe déjà plus.
do $$
begin
  if to_regclass('public.organizations') is not null then
    execute 'drop policy if exists organizations_select_owner_or_member on public.organizations';
  end if;
end $$;

drop table if exists public.organization_memberships;
drop table if exists public.organizations;

commit;
