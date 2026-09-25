begin;

-- ----------------------------------------------------------------------------
-- Réconciliation durable (revue v3, §3). list_recently_cleaned_media_keys
-- (20260926100000) ne sélectionnait que les clés dont cleaned_at datait de
-- moins de p_within (24h par défaut). Si le script manuel n'était pas relancé
-- dans ce délai, une clé recréée par une écriture tardive PENDANT
-- l'interruption sortait de la fenêtre à l'exécution suivante et n'était plus
-- JAMAIS sélectionnée : la fenêtre glissante perdait la trace, elle ne la
-- retardait pas. Remplacé par un indicateur persistant (reconciled_at) :
-- chaque clé nettoyée est réconciliée exactement une fois, quel que soit le
-- délai avant la prochaine exécution du script.
--
-- Limite résiduelle assumée (à documenter, pas à masquer) : une clé DÉJÀ
-- marquée reconciled_at n'est plus revérifiée. Une écriture tardive survenant
-- APRÈS cette réconciliation échapperait donc à ce mécanisme — limite
-- inhérente à toute vérification ponctuelle, distincte du défaut corrigé ici
-- (qui perdait des clés jamais encore vérifiées, faute d'exécution à temps).
-- ----------------------------------------------------------------------------

alter table public.private_object_stale_keys
  add column reconciled_at timestamptz null;

create index private_object_stale_keys_unreconciled_idx
  on public.private_object_stale_keys (cleaned_at)
  where cleaned_at is not null and reconciled_at is null;

drop function if exists public.list_recently_cleaned_media_keys(interval);

create function public.list_recently_cleaned_media_keys()
returns table (id uuid, storage_key text, kind text)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select k.id, k.storage_key, k.kind
  from public.private_object_stale_keys k
  where k.cleaned_at is not null
    and k.reconciled_at is null
    and not exists (
      select 1 from public.private_object_uploads u
      where u.storage_key = k.storage_key and u.status = 'FINALIZED'
    );
$$;

revoke execute on function public.list_recently_cleaned_media_keys()
  from public, anon, authenticated, service_role;
grant execute on function public.list_recently_cleaned_media_keys() to service_role;

-- ----------------------------------------------------------------------------
-- mark_stale_key_reconciled — appelée par le script APRÈS vérification Storage
-- réelle (absente, ou recréée puis re-supprimée). Jamais avant cette
-- vérification : tant qu'elle n'est pas appelée, la clé reste sélectionnée
-- par list_recently_cleaned_media_keys à chaque exécution suivante.
-- ----------------------------------------------------------------------------

create function public.mark_stale_key_reconciled(p_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  update public.private_object_stale_keys set reconciled_at = clock_timestamp() where id = p_id;
$$;

revoke execute on function public.mark_stale_key_reconciled(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_stale_key_reconciled(uuid) to service_role;

commit;
