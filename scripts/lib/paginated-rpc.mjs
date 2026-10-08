// Lecture COMPLÈTE d'une fonction en base renvoyant une table (RETURNS
// TABLE (id uuid, …)), page par page, dans un ordre stable.
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

export async function readAllRpc(client, fn, args = {}, { pageSize = PAGE_SIZE } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize >= SERVER_MAX_ROWS) {
    throw new Error(`readAllRpc(${fn}) : taille de page ${pageSize} invalide (1 à ${SERVER_MAX_ROWS - 1}).`);
  }
  const rows = [];
  let lastId = null;
  for (;;) {
    let query = client.rpc(fn, args).order("id", { ascending: true }).limit(pageSize);
    if (lastId !== null) query = query.gt("id", lastId);
    const { data, error } = await query;
    if (error) throw new Error(`${fn}: ${error.message}`);
    const page = data ?? [];
    for (const row of page) {
      if (!row || typeof row.id !== "string") throw new Error(`${fn}: ligne sans identifiant, pagination impossible.`);
    }
    rows.push(...page);
    if (page.length < pageSize) return rows;
    lastId = page[page.length - 1].id;
  }
}
