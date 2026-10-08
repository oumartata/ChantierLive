// Lecture COMPLÈTE d'une source renvoyant des lignes (id uuid, …), page par
// page, dans un ordre stable.
//
// Pourquoi (boucle 27) : PostgREST plafonne toute réponse à max_rows = 1000
// (supabase/config.toml), sans erreur et sans ordre garanti. Une lecture
// simple de list_recently_cleaned_media_keys renvoyait 1 000 lignes sur
// 1 132 : 132 clés n'étaient jamais revérifiées par la réconciliation.
//
// Pagination « par clé » (id strictement croissant), et non par décalage :
// une ligne qui quitte la sélection pendant le traitement (clé marquée
// nettoyée en phase B, opération abandonnée en phase A) ne fait sauter
// aucune autre ligne. La page doit rester inférieure au plafond du serveur ;
// une page complète déclenche toujours une page suivante, jusqu'à une page
// incomplète — aucun plafond silencieux.

export const PAGE_SIZE = 500;
const SERVER_MAX_ROWS = 1000;

// buildQuery() renvoie à chaque appel une requête neuve (fonction ou table),
// sur laquelle l'ordre, la borne et la limite sont posés ici.
export async function readAllRows(buildQuery, label, { pageSize = PAGE_SIZE } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize >= SERVER_MAX_ROWS) {
    throw new Error(`readAllRows(${label}) : taille de page ${pageSize} invalide (1 à ${SERVER_MAX_ROWS - 1}).`);
  }
  const rows = [];
  let lastId = null;
  for (;;) {
    let query = buildQuery().order("id", { ascending: true }).limit(pageSize);
    if (lastId !== null) query = query.gt("id", lastId);
    const { data, error } = await query;
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = data ?? [];
    for (const row of page) {
      if (!row || typeof row.id !== "string") throw new Error(`${label}: ligne sans identifiant, pagination impossible.`);
    }
    rows.push(...page);
    if (page.length < pageSize) return rows;
    lastId = page[page.length - 1].id;
  }
}

export async function readAllRpc(client, fn, args = {}, options = {}) {
  return readAllRows(() => client.rpc(fn, args), fn, options);
}

// Conservation de la réconciliation (D190, boucle 29) : une trace nettoyée
// est revérifiée pendant 7 jours après son nettoyage (cleaned_at), puis plus
// jamais ; aucune trace n'est supprimée par cette règle. L'exclusion des
// fichiers d'envois FINALIZED reste décidée côté serveur
// (list_recently_cleaned_media_keys) ; la fenêtre ne fait que restreindre
// cette sélection, jamais l'élargir.
export const RECONCILE_WINDOW_DAYS = 7;

export async function listKeysToReconcile(serviceClient, now = Date.now()) {
  const cutoff = new Date(now - RECONCILE_WINDOW_DAYS * 86400000).toISOString();
  const listed = await readAllRpc(serviceClient, "list_recently_cleaned_media_keys");
  const recent = await readAllRows(
    () => serviceClient.from("private_object_stale_keys").select("id").not("cleaned_at", "is", null).gte("cleaned_at", cutoff),
    "private_object_stale_keys (fenêtre de conservation)"
  );
  const recentIds = new Set(recent.map((r) => r.id));
  const keys = listed.filter((k) => recentIds.has(k.id));
  return { cutoff, keys, ignored: listed.length - keys.length };
}
