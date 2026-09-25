// Nettoyage RÉEL des objets Storage devenus inutiles (B026, media_asset).
// REFONDU (revue 2026-09-26) après trois défauts identifiés dans la version
// précédente :
//   1. claim_candidate_for_cleanup supprimait la ligne SQL AVANT
//      storage.remove() : un échec Storage perdait alors la référence à
//      supprimer, sans recours. Corrigé : la trace (private_object_stale_keys)
//      n'est marquée "cleaned_at" qu'APRÈS confirmation réelle du succès de
//      storage.remove() — jamais avant.
//   2. --dry-run appelait quand même la fonction destructive. Corrigé :
//      en dry-run, seules les fonctions de LECTURE (list_*) sont appelées,
//      aucune mutation, aucun appel Storage.
//   3. recover_media_upload_attempt écrasait candidate_key sans trace, et
//      les sources temporaires n'étaient jamais nettoyées. Corrigé côté SQL
//      (M010/M026) : toute clé abandonnée (ancienne candidate reprise, ou
//      source devenue inutile après FINALIZED) est désormais enregistrée
//      dans private_object_stale_keys avant d'être perdue de vue.
//
// Trois phases, jamais confondues :
//   Phase A — ABANDON : les lignes encore PENDING/FINALIZING mais expirées
//   passent au statut terminal ABANDONED (jamais une suppression physique de
//   la ligne : l'identité d'idempotence de l'operation_uuid est préservée),
//   et leurs clés potentiellement écrites sont tracées.
//   Phase B — SUPPRESSION : chaque clé tracée et non encore nettoyée est
//   réclamée (porte CAS), puis réellement supprimée de Storage ; le marquage
//   "cleaned" n'intervient qu'après ce succès confirmé.
//   Phase C — RÉCONCILIATION : chaque clé nettoyée non liée à une candidate
//   FINALIZED est REVÉRIFIÉE RÉCURREMMENT dans Storage à chaque exécution
//   (aucune fenêtre de temps, aucune exclusion définitive — revue v3.1, §2)
//   et resupprimée si une écriture tardive l'a recréée.
//
// Local uniquement. Usage :
//   node scripts/cleanup_media_candidates.mjs --dry-run   (lecture seule, RIEN n'est muté)
//   node scripts/cleanup_media_candidates.mjs             (nettoyage réel)
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "project-media";
const DRY_RUN = process.argv.includes("--dry-run");

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY manquant.");
  process.exit(1);
}

const service = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function phaseAbandon() {
  const { data: expired, error: listError } = await service.rpc("list_expired_media_uploads", { p_older_than: "1 hour" });
  if (listError) throw new Error(`list_expired_media_uploads: ${listError.message}`);

  console.log(`Phase A — sélection : ${expired?.length ?? 0} opération(s) expirée(s) candidate(s) à l'abandon.`);
  if (DRY_RUN) {
    for (const row of expired ?? []) console.log(`[dry-run] abandonnerait l'opération ${row.id} (projet ${row.project_id})`);
    return;
  }

  let abandoned = 0;
  for (const row of expired ?? []) {
    // Revalidation À L'INSTANT PRÉSENT, une ligne à la fois — la sélection
    // ci-dessus peut déjà être périmée (finalisation ou reprise entre-temps).
    const { data: didAbandon, error: abandonError } = await service.rpc("abandon_expired_media_upload", {
      p_id: row.id,
      p_older_than: "1 hour",
    });
    if (abandonError) {
      console.error(`abandon_expired_media_upload(${row.id}): ${abandonError.message}`);
      continue;
    }
    if (didAbandon) abandoned++;
  }
  console.log(`Phase A — abandonnées réellement : ${abandoned}.`);
}

async function phaseDeleteStaleKeys() {
  const { data: staleKeys, error: listError } = await service.rpc("list_stale_media_keys");
  if (listError) throw new Error(`list_stale_media_keys: ${listError.message}`);

  console.log(`Phase B — sélection : ${staleKeys?.length ?? 0} clé(s) tracée(s) non encore nettoyée(s).`);
  if (DRY_RUN) {
    for (const k of staleKeys ?? []) console.log(`[dry-run] supprimerait (${k.kind}) ${k.storage_key}`);
    return;
  }

  let deleted = 0;
  let skipped = 0;
  for (const k of staleKeys ?? []) {
    // Porte CAS avant tout appel Storage réel : jamais deux suppressions
    // concurrentes de la même clé, jamais une reréclamation d'une clé déjà
    // confirmée nettoyée.
    const { data: claimed, error: claimError } = await service.rpc("claim_stale_key_for_cleanup", { p_id: k.id });
    if (claimError) {
      console.error(`claim_stale_key_for_cleanup(${k.id}): ${claimError.message}`);
      continue;
    }
    if (!claimed || claimed.length === 0) {
      skipped++;
      continue;
    }

    const { error: removeError } = await service.storage.from(BUCKET).remove([claimed[0].storage_key]);
    if (removeError) {
      // Échec Storage : la trace REND la réclamation, jamais supprimée ici —
      // réclamable à nouveau après le délai de grâce (claim_stale_key_for_cleanup).
      console.error(`storage.remove(${claimed[0].storage_key}): ${removeError.message} — trace conservée pour réessai.`);
      continue;
    }

    // Marquage "cleaned" UNIQUEMENT après ce succès confirmé.
    const { error: markError } = await service.rpc("mark_stale_key_cleaned", { p_id: k.id });
    if (markError) {
      console.error(`mark_stale_key_cleaned(${k.id}): ${markError.message} (objet Storage déjà supprimé, sans conséquence)`);
    }
    deleted++;
  }
  console.log(`Phase B — supprimées réellement : ${deleted}. Ignorées (déjà réclamées/nettoyées) : ${skipped}.`);
}

// Absence CONFIRMÉE d'un objet Storage (revue v3.1, §2 — même critère que
// actions.ts) : "NoSuchKey" est le code service documenté par storage-js pour
// ce cas précis (vérifié empiriquement en local : statusCode "404" pour le
// même cas). Toute autre erreur (panne réseau, 5xx, etc.) reste INCERTAINE —
// jamais traitée comme une absence confirmée.
function isConfirmedStorageNotFound(error) {
  if (!error) return false;
  return error.code === "NoSuchKey" || error.statusCode === "404";
}

async function phaseReconcile() {
  // RÉCONCILIATION RÉCURRENTE (revue v3.1, §2). cleaned_at n'est PAS une
  // garantie qu'aucune écriture tardive ne puisse recréer la clé (ancienne
  // tentative qui termine tard, ou URL signée cliente encore valide côté
  // fournisseur pour une source déjà supprimée). Cette phase ne fait AUCUNE
  // hypothèse de fin des écritures : elle revérifie l'existence RÉELLE de
  // CHAQUE clé nettoyée non liée à une candidate FINALIZED (exclusion déjà
  // appliquée par list_recently_cleaned_media_keys), et la supprime à nouveau
  // si elle a été recréée.
  //
  // CORRIGÉ (revue v3.1, §2) : la version précédente marquait reconciled_at
  // comme une EXCLUSION DÉFINITIVE dès le premier contrôle (souvent juste
  // après la suppression en phase B) — une écriture tardive survenant APRÈS
  // ce contrôle échappait alors, elle aussi, pour toujours. reconciled_at
  // n'est plus qu'une date de DERNIER CONTRÔLE informative (migration
  // 20260926120000) : chaque clé reste sélectionnée et revérifiée à CHAQUE
  // exécution tant que rien ne garantit qu'elle ne réapparaîtra jamais.
  // Corrigé également : une ERREUR DE TÉLÉCHARGEMENT incertaine (panne
  // réseau/Storage) n'est plus traitée comme une absence confirmée — seul un
  // code service explicite (NoSuchKey/404) l'est.
  //
  // Limite résiduelle assumée, faute de politique de rétention explicitement
  // demandée : aucune borne n'arrête cette revérification (coût croissant
  // avec l'historique de nettoyage) — voir migration 20260926120000.
  const { data: candidates, error: listError } = await service.rpc("list_recently_cleaned_media_keys");
  if (listError) throw new Error(`list_recently_cleaned_media_keys: ${listError.message}`);

  console.log(`Phase C — sélection : ${candidates?.length ?? 0} clé(s) nettoyée(s) à revérifier (contrôle récurrent, aucune exclusion définitive).`);

  let recreated = 0;
  let uncertain = 0;
  for (const k of candidates ?? []) {
    // download() est une LECTURE, sûre même en dry-run : seules la
    // suppression réelle et le marquage reconciled_at ci-dessous sont
    // conditionnés à --dry-run.
    const { data: reappeared, error: dlError } = await service.storage.from(BUCKET).download(k.storage_key);
    if (dlError) {
      if (isConfirmedStorageNotFound(dlError)) {
        // Absence CONFIRMÉE : contrôle réel effectué, rien à supprimer —
        // reconciled_at mis à jour (date de dernier contrôle, informative).
        if (!DRY_RUN) {
          const { error: markError } = await service.rpc("mark_stale_key_reconciled", { p_id: k.id });
          if (markError) console.error(`mark_stale_key_reconciled(${k.id}): ${markError.message}`);
        }
        continue;
      }
      // Erreur INCERTAINE : ni suppression ni marquage — revérifiée au
      // prochain passage, jamais confondue avec une absence confirmée.
      console.error(`download(${k.storage_key}) [réconciliation]: ${dlError.message} — incertain, non marqué, réessayable.`);
      uncertain++;
      continue;
    }
    if (!reappeared) continue; // download sans erreur ni données : rien à faire.
    if (DRY_RUN) {
      console.log(`[dry-run] écriture tardive détectée, supprimerait à nouveau : (${k.kind}) ${k.storage_key}`);
      recreated++;
      continue;
    }
    const { error: removeError } = await service.storage.from(BUCKET).remove([k.storage_key]);
    if (removeError) {
      console.error(`storage.remove(${k.storage_key}) [écriture tardive]: ${removeError.message} — non marquée, réessayable.`);
      continue;
    }
    const { error: markError } = await service.rpc("mark_stale_key_reconciled", { p_id: k.id });
    if (markError) console.error(`mark_stale_key_reconciled(${k.id}): ${markError.message}`);
    console.warn(`Écriture tardive détectée et supprimée à nouveau : (${k.kind}) ${k.storage_key}`);
    recreated++;
  }
  console.log(`Phase C — écritures tardives détectées${DRY_RUN ? "" : " et supprimées"} : ${recreated}. Contrôles incertains (réessayables) : ${uncertain}.`);
}

async function main() {
  if (DRY_RUN) console.log("--dry-run : lecture seule, aucune mutation, aucun appel Storage.");
  await phaseAbandon();
  await phaseDeleteStaleKeys();
  await phaseReconcile();
}

main().catch((err) => {
  console.error("ERREUR:", err);
  process.exitCode = 1;
});
