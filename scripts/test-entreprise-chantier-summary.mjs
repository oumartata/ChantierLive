// Espace entreprise — états d'affichage du chantier sélectionné
// (src/lib/entreprise/chantierSummary.ts) : lecture impossible, information
// absente et zéro toujours distingués ; montants et pourcentages repris du
// serveur sans recalcul.
//
// Usage : node scripts/test-entreprise-chantier-summary.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const tmpDir = mkdtempSync(join(tmpdir(), "entreprise-resume-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "src/lib/entreprise/chantierSummary.ts" --module commonjs --target es2020 --outDir "${tmpDir}" --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
  const s = await import(pathToFileURL(join(tmpDir, "chantierSummary.js")).href);
  const NB = " ";

  // Avancement
  record("Avancement : erreur de lecture → « lecture impossible »", s.progressSummary({ data: null, error: { message: "x" } }).kind === "error");
  record("Avancement : plan absent → information absente (jamais 0 %)", s.progressSummary({ data: [{ status: "ABSENT", global_progress: null }], error: null }).kind === "absent");
  record("Avancement : brouillon → information absente", s.progressSummary({ data: { status: "BROUILLON", global_progress: "40" }, error: null }).kind === "absent");
  const zero = s.progressSummary({ data: [{ status: "PUBLIE", global_progress: "0", last_event_at: null, last_event_by_role: null }], error: null });
  record("Avancement publié à 0 % : zéro affiché comme tel", zero.kind === "published" && zero.percent === `0${NB}%`, zero.percent);
  const pub = s.progressSummary({ data: [{ status: "PUBLIE", global_progress: "37.5", last_event_at: "2026-10-06T05:00:00Z", last_event_by_role: "SITE_MANAGER" }], error: null });
  record("Avancement publié : valeur du serveur reprise, auteur de la mise à jour", pub.kind === "published" && pub.percent === `37,5${NB}%` && pub.lastEventBy === "le chef de chantier");
  record("Avancement publié sans valeur : lecture impossible (rien d'inventé)", s.progressSummary({ data: [{ status: "PUBLIE", global_progress: null }], error: null }).kind === "error");

  // Versements
  record("Versements : erreur → lecture impossible", s.paymentsSummary({ data: null, error: { message: "x" } }).kind === "error");
  record("Versements : liste vide → aucun versement (distinct d'une erreur)", s.paymentsSummary({ data: [], error: null }).kind === "empty");
  const list = s.paymentsSummary({
    data: [
      { advance_id: "a", amount_fcfa: "9007199254740993", external_payment_date: "2026-10-01", mode: "ORANGE_MONEY", declared_role: "OWNER_PRIMARY", status: "DECLARED", has_receipt: true },
      { advance_id: "b", amount_fcfa: "0", external_payment_date: "2026-10-02", mode: "CASH", declared_role: "CONTRACTOR", status: "RECEIVED", has_receipt: false },
    ],
    error: null,
  });
  record(
    "Versements : montants exacts (BigInt), statuts et auteurs",
    list.kind === "list" && list.items[0].amount === `${(9007199254740993n).toLocaleString("fr-FR")}${NB}FCFA` && list.items[0].status.label.startsWith("Déclaré") && list.items[0].declaredBy === "le client" && list.items[1].declaredBy === "l'entreprise" && list.items[1].amount === `0${NB}FCFA`
  );
  record("Versements : statut inconnu → lecture impossible (jamais deviné)", s.paymentsSummary({ data: [{ advance_id: "a", amount_fcfa: "1", status: "PAYE" }], error: null }).kind === "error");

  // Récapitulatif financier
  const noContract = s.financeSummary({ data: { contract_amount_fcfa: null, recognized_fcfa: "0", recognized_count: 0, pending_fcfa: "0", pending_count: 0, remaining_due_fcfa: null }, error: null });
  record("Sans devis accepté : prix convenu « non établi » (null), reconnu à 0 affiché comme zéro", noContract.kind === "ok" && noContract.contract === null && noContract.remainingDue === null && noContract.recognized === `0${NB}FCFA`);
  const withContract = s.financeSummary({ data: [{ contract_amount_fcfa: "15000000", recognized_fcfa: "5000000", recognized_count: 2, pending_fcfa: "1000000", pending_count: 1, remaining_due_fcfa: "10000000" }], error: null });
  record("Avec prix convenu : valeurs du serveur, sans recalcul", withContract.kind === "ok" && withContract.contract === `${(15000000).toLocaleString("fr-FR")}${NB}FCFA` && withContract.remainingDue === `${(10000000).toLocaleString("fr-FR")}${NB}FCFA` && withContract.recognizedCount === 2);
  record("Récapitulatif illisible → lecture impossible", s.financeSummary({ data: { recognized_fcfa: "abc", pending_fcfa: "0" }, error: null }).kind === "error" && s.financeSummary({ data: null, error: { message: "x" } }).kind === "error");
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
