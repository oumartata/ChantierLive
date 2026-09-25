begin;

-- ----------------------------------------------------------------------------
-- Réconciliation récurrente (revue v3.1, §2). La migration précédente
-- (20260926110000) avait remplacé la fenêtre glissante de 24h par
-- reconciled_at, mais l'utilisait comme une EXCLUSION DÉFINITIVE : une fois
-- une clé marquée reconciled_at (souvent immédiatement après sa suppression
-- en phase B), elle ne réapparaissait plus jamais dans
-- list_recently_cleaned_media_keys — une écriture tardive survenant APRÈS
-- cette marque échappait donc, elle aussi, définitivement au mécanisme.
--
-- reconciled_at redevient une simple date de DERNIER CONTRÔLE (informative),
-- jamais un critère d'exclusion : list_recently_cleaned_media_keys sélectionne
-- désormais TOUTE clé nettoyée non liée à une candidate FINALIZED, quel que
-- soit son historique de vérification — une clé reste vérifiée à chaque
-- exécution tant que rien ne garantit qu'elle ne réapparaîtra jamais.
--
-- Limite résiduelle assumée, faute de politique de rétention explicitement
-- demandée : aucune borne n'arrête cette revérification récurrente (chaque
-- clé nettoyée non-FINALIZED est revérifiée à CHAQUE exécution du script,
-- indéfiniment). Une politique d'arrêt (ex. après N contrôles négatifs
-- consécutifs, ou passé un délai de rétention donné) réduirait ce coût mais
-- n'a pas été spécifiée par le fondateur — fabriquer un seuil arbitraire
-- aurait été hors périmètre de cette correction.
-- ----------------------------------------------------------------------------

create or replace function public.list_recently_cleaned_media_keys()
returns table (id uuid, storage_key text, kind text)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select k.id, k.storage_key, k.kind
  from public.private_object_stale_keys k
  where k.cleaned_at is not null
    and not exists (
      select 1 from public.private_object_uploads u
      where u.storage_key = k.storage_key and u.status = 'FINALIZED'
    );
$$;

comment on function public.mark_stale_key_reconciled(uuid) is
  'Enregistre la date du DERNIER contrôle Storage réel pour une clé nettoyée '
  '(revue v3.1, §2) — purement informatif, jamais un critère d''exclusion : '
  'list_recently_cleaned_media_keys ne filtre plus sur reconciled_at. Appelée '
  'uniquement après un contrôle Storage CONFIRMÉ (absence confirmée par un '
  'code service explicite, ou recréation détectée puis re-supprimée) — jamais '
  'après une erreur de téléchargement incertaine.';

commit;
