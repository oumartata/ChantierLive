-- ============================================================================
-- DEV ONLY — rollback manuel de M004a (fonctions RLS de base)
--
-- N'EST JAMAIS EXÉCUTÉ AUTOMATIQUEMENT : hors de supabase/migrations/, jamais
-- rejoué par le CLI Supabase. Réservé au développement local — ne jamais
-- exécuter sur un environnement contenant des données réelles.
--
-- Usage volontaire uniquement, par exemple :
--   psql "$DB_URL_LOCAL" -f supabase/rollbacks_dev_only/m004a_rollback.DEV_ONLY.sql
--
-- Supprime les objets créés par M004a ET restaure la policy
-- project_memberships_select_own remplacée par M004a (project_memberships
-- retrouve exactement son état post-M004). Aucun DROP ... CASCADE.
-- ============================================================================

begin;

-- La nouvelle policy référence is_active_project_member : la retirer avant
-- de supprimer les fonctions (même logique que M003/M004 : une policy sur
-- une table dépend de la fonction/table qu'elle référence).
drop policy if exists project_memberships_select_participants on public.project_memberships;

-- Restauration exacte de la policy M004 remplacée. Drop défensif avant
-- create : si ce rollback est rejoué une 2e fois sans réapplication entre
-- temps, la policy restaurée par la 1re exécution existe déjà (CREATE
-- POLICY n'a pas de IF NOT EXISTS en PostgreSQL).
drop policy if exists project_memberships_select_own on public.project_memberships;

create policy project_memberships_select_own
on public.project_memberships
for select
to authenticated
using (
  profile_id = auth.uid()
  and revoked_at is null
);

drop function if exists public.has_project_permission(uuid, text);
drop function if exists public.is_primary_owner(uuid);
drop function if exists public.has_project_role(uuid, public.membership_role[]);
drop function if exists public.is_active_project_member(uuid);

commit;
