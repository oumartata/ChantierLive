// Scanner de contenus privés partagé (B050 test-admin-console, B051
// test-support-access ; boucle 35b). Il cherche dans la réponse sérialisée
// chaque marqueur interdit (contenu semé, identité de membre, identifiant
// complet) et tout chemin ou compartiment de fichier privé. Chaque test qui
// l'utilise prouve qu'il détecte ces marqueurs là où ils sont présents (R15).

export const PRIVATE_BUCKETS = /project-media|project-documents|expense-receipts|advance-receipts|project-plans|organization-catalog|license-proofs/;

export function makeScanner(forbidden, { privatePaths = true, allowBuckets = [] } = {}) {
  const markers = forbidden.filter((x) => typeof x === "string" && x.length > 0);
  return (payload) => {
    let txt = JSON.stringify(payload ?? null);
    for (const b of allowBuckets) txt = txt.split(b).join("");
    const hits = markers.filter((x) => txt.includes(x));
    if (privatePaths && (PRIVATE_BUCKETS.test(txt) || txt.includes("_private/"))) hits.push("chemin de fichier privé");
    return hits;
  };
}
