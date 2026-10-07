// B020 — historique par étape (src/app/(app)/chantiers/[id]/avancement/
// phaseHistory.ts) : état précédent -> nouvel état pour chaque modification
// (libellé, poids, progression, statut, dates), avec rôle, date et motif.
// Événements construits à l'identique de ceux de M033/M040/M041.
//
// Usage : node scripts/test-phase-history.mjs

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

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";
const at = (n) => `2026-10-07T10:0${n}:00Z`;
const events = [
  { event_seq: 1, event_type: "PLAN_PUBLISHED", phase_id: null, previous_value: null, new_value: [
    { phase_id: A, position: 1, label: "Fondations", weight: 60, planned_start: "2026-10-10", planned_end: null },
    { phase_id: B, position: 2, label: "Toiture", weight: 40 },
  ], actor_role: "CONTRACTOR", reason: null, created_at_server: at(1) },
  { event_seq: 2, event_type: "PROGRESSION_UPDATED", phase_id: A, previous_value: { progression: 0 }, new_value: { progression: 100 }, actor_role: "SITE_MANAGER", reason: null, created_at_server: at(2) },
  { event_seq: 3, event_type: "STRUCTURE_CHANGED", phase_id: null,
    previous_value: [{ phase_id: A, position: 1, label: "Fondations", weight: 60, progression: 100 }, { phase_id: B, position: 2, label: "Toiture", weight: 40, progression: 0 }],
    new_value: [{ phase_id: C, position: 1, label: "Implantation", weight: 10, progression: 0 }, { phase_id: A, position: 2, label: "Fondations", weight: 50, progression: 100 }, { phase_id: B, position: 3, label: "Toiture", weight: 40, progression: 0 }],
    actor_role: "CONTRACTOR", reason: "Ajout de l'implantation", created_at_server: at(3) },
  { event_seq: 4, event_type: "PHASE_DECLARED_COMPLETE", phase_id: A, previous_value: { status: "PUBLIEE" }, new_value: { status: "TERMINEE" }, actor_role: "CONTRACTOR", reason: null, created_at_server: at(4) },
  { event_seq: 5, event_type: "PHASE_REFUSED", phase_id: A, previous_value: { status: "TERMINEE" }, new_value: { status: "REFUSEE" }, actor_role: "OWNER", reason: "Fissures", created_at_server: at(5) },
  { event_seq: 6, event_type: "PHASE_SCHEDULE_CHANGED", phase_id: B, previous_value: { planned_start: null, planned_end: null }, new_value: { planned_start: "2026-11-01", planned_end: "2026-11-30" }, actor_role: "CONTRACTOR", reason: "Livraison décalée", created_at_server: at(6) },
  { event_seq: 7, event_type: "STRUCTURE_CHANGED", phase_id: null,
    previous_value: [{ phase_id: C, position: 1, label: "Implantation", weight: 10, progression: 0 }, { phase_id: A, position: 2, label: "Fondations", weight: 50, progression: 100 }, { phase_id: B, position: 3, label: "Toiture", weight: 40, progression: 0 }],
    new_value: [{ phase_id: A, position: 1, label: "Fondations", weight: 50, progression: 100 }, { phase_id: B, position: 2, label: "Toiture et étanchéité", weight: 50, progression: 0 }],
    actor_role: "CONTRACTOR", reason: "Implantation retirée", created_at_server: at(7) },
];

const tmpDir = mkdtempSync(join(tmpdir(), "phase-history-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "src/app/(app)/chantiers/[id]/avancement/phaseHistory.ts" --module commonjs --target es2020 --outDir "${tmpDir}" --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
  const h = await import(pathToFileURL(join(tmpDir, "phaseHistory.js")).href);
  const map = h.buildPhaseHistories([...events].reverse());
  const a = map.get(A), b = map.get(B), c = map.get(C);
  const ch = (entry, field) => entry.changes.find((x) => x.field === field);

  record("Étape A : 6 entrées dans l'ordre (publication, progression, modification, déclaration, refus, déplacement)", a.map((e) => e.kind).join() === "PUBLICATION,PROGRESSION,MODIFICATION,STATUT,STATUT,MODIFICATION", a.map((e) => e.kind).join());
  record("Publication : état initial (libellé, poids, date prévue) et statut Brouillon -> Publiée", ch(a[0], "label").after === "Fondations" && ch(a[0], "weight").after === 60 && ch(a[0], "planned_start").after === "2026-10-10" && ch(a[0], "status").before === "BROUILLON" && ch(a[0], "status").after === "PUBLIEE" && !ch(a[0], "planned_end"));
  record("Progression : 0 -> 100, auteur chef de chantier", ch(a[1], "progression").before === 0 && ch(a[1], "progression").after === 100 && a[1].actorRole === "SITE_MANAGER");
  record("Restructuration : poids 60 -> 50 et position 1 -> 2, motif conservé, progression inchangée non listée", ch(a[2], "weight").before === 60 && ch(a[2], "weight").after === 50 && ch(a[2], "position").before === 1 && ch(a[2], "position").after === 2 && a[2].reason === "Ajout de l'implantation" && !ch(a[2], "progression"));
  record("Statut : Publiée -> Déclarée terminée, puis Déclarée terminée -> Refusée avec motif du propriétaire", ch(a[3], "status").after === "TERMINEE" && ch(a[4], "status").before === "TERMINEE" && ch(a[4], "status").after === "REFUSEE" && a[4].actorRole === "OWNER" && a[4].reason === "Fissures");
  record("Étape A : restructuration 7 = seulement la position (2 -> 1)", a[5]?.changes.length === 1 && ch(a[5], "position")?.before === 2 && ch(a[5], "position")?.after === 1, JSON.stringify(a[5]?.changes));
  record("Étape B : dates prévues — -> 1er/30 novembre, avec motif", b.some((e) => e.kind === "DATES" && ch(e, "planned_start").before === null && ch(e, "planned_start").after === "2026-11-01" && e.reason === "Livraison décalée"));
  record("Étape B : libellé Toiture -> Toiture et étanchéité, poids 40 -> 50", b.some((e) => e.kind === "MODIFICATION" && ch(e, "label")?.before === "Toiture" && ch(e, "label")?.after === "Toiture et étanchéité" && ch(e, "weight")?.after === 50));
  record("Étape C : ajout puis retrait, jamais effacée de l'historique", c.map((e) => e.kind).join() === "AJOUT,RETRAIT" && c[1].changes[0].before === "Implantation" && c[1].reason === "Implantation retirée");
  record("Aucune entrée pour une restructuration qui ne change pas l'étape", !b.some((e) => e.seq === 3 && e.kind === "MODIFICATION" && e.changes.length === 0));
  record("Format : pourcentage français, statut et date en clair, valeur absente = —", h.formatHistoryValue("weight", 22.5) === "22,5 %" && h.formatHistoryValue("status", "VALIDEE") === "Validée" && h.formatHistoryValue("planned_start", "2026-11-01") === "1 novembre 2026" && h.formatHistoryValue("label", null) === "—", `${h.formatHistoryValue("weight", 22.5)} / ${h.formatHistoryValue("planned_start", "2026-11-01")}`);
  record("Valeurs illisibles ignorées sans erreur", h.buildPhaseHistories([{ event_seq: 1, event_type: "STRUCTURE_CHANGED", phase_id: null, previous_value: "x", new_value: null, actor_role: "CONTRACTOR", reason: "r", created_at_server: at(1) }]).size === 0);
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
