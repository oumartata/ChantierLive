// B044 — tableaux de bord par rôle (src/lib/dashboard/dashboard.ts ; D189).
// 1. Fonctions pures : date la plus récente, « fin prévue dépassée » (T2 A),
//    incidents ouverts.
// 2. Intégration LOCALE : les cartes réelles construites avec le client de
//    chaque compte jetable. Propriétaire et copropriétaire : aucune donnée
//    interne (dépenses, budget, reçus, demandes internes, documents
//    « Entreprise seulement », brouillons d'autrui) et aucune fonction interne
//    appelée ; chef de chantier : ni budget ni alerte ; deux mesures
//    d'avancement distinctes ; « fin prévue dépassée » sur une étape non
//    validée, absente sur une étape validée.
//
// Usage : node --env-file=.env.local scripts/test-dashboard.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const tmpDir = mkdtempSync(join(tmpdir(), "dashboard-"));
let d;
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "src/lib/dashboard/dashboard.ts" --module commonjs --target es2020 --outDir "${tmpDir}" --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(`compilation : ${compile.stdout}${compile.stderr}`);
  d = await import(pathToFileURL(join(tmpDir, "dashboard.js")).href);
} catch (e) {
  console.error("ERREUR:", e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Fonctions pures.
// ---------------------------------------------------------------------------
record("latestOf : date la plus récente, valeurs vides ignorées", d.latestOf([null, "2026-10-01T10:00:00Z", undefined, "2026-10-03T08:00:00Z", "2026-10-02T23:00:00Z"]) === "2026-10-03T08:00:00Z" && d.latestOf([]) === null);
const phasesPure = [
  { label: "Passée non validée", status: "PUBLIEE", planned_end: "2026-10-06" },
  { label: "Passée terminée", status: "TERMINEE", planned_end: "2026-10-01" },
  { label: "Passée validée", status: "VALIDEE", planned_end: "2026-10-01" },
  { label: "Aujourd'hui", status: "PUBLIEE", planned_end: "2026-10-07" },
  { label: "Sans date", status: "PUBLIEE", planned_end: null },
];
const o1 = d.overduePhases("PUBLIE", phasesPure, "2026-10-07");
record("Fin prévue dépassée : étapes non validées à date passée seulement (ni validée, ni du jour, ni sans date)", o1.count === 2 && o1.labels.join("|") === "Passée non validée|Passée terminée", JSON.stringify(o1));
record("Fin prévue dépassée : rien si le plan n'est pas publié", d.overduePhases("BROUILLON", phasesPure, "2026-10-07").count === 0 && d.overduePhases(null, phasesPure, "2026-10-07").count === 0);
const inc = d.incidentSummary([
  { status: "OUVERT", severity: "URGENTE", updated_at_server: "2026-10-05T10:00:00Z" },
  { status: "EN_COURS", severity: "FAIBLE", updated_at_server: "2026-10-06T10:00:00Z" },
  { status: "CLOS", severity: "ELEVEE", updated_at_server: "2026-10-07T10:00:00Z" },
  { status: "ANNULE", severity: "URGENTE", updated_at_server: null },
]);
record("Incidents : ouverts = ni clos ni annulés ; gravité élevée/urgente à part", inc.open === 2 && inc.high === 1 && inc.latestAt === "2026-10-07T10:00:00Z", JSON.stringify(inc));

// ---------------------------------------------------------------------------
// 2. Intégration locale.
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const local = (() => { try { const { hostname } = new URL(SUPABASE_URL); return hostname === "127.0.0.1" || hostname === "localhost"; } catch { return false; } })();
if (!local) { console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`); process.exit(1); }
if (!SERVICE_KEY || !ANON_KEY) { console.error("Clés locales manquantes."); process.exit(1); }
const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const one = (x) => (Array.isArray(x) ? x[0] : x);
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function must(res, what) { const r = await res; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; }
async function user(label) {
  const email = `b044-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client, label };
}
// Client espion : la carte n'a accès qu'à rpc(), et chaque appel est noté.
const spy = (u) => {
  const calls = [];
  return { calls, client: { rpc: (fn, args) => { calls.push(fn); return u.client.rpc(fn, args); } } };
};
const INTERNAL_FUNCTIONS = /expense|budget|receipt/i;
const daysFrom = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const today = daysFrom(0);

// Marqueurs repérables de données internes ou privées.
const EXPENSE_AMOUNT = "717171717";
const BUDGET_AMOUNT = "818181818";
const DOC_TITLE = "DOC-INTERNE-B044";
const DRAFT_TEXT = "BROUILLON-SECRET-B044";
const ENVELOPE = "52000000";

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const outsider = await user("hors-chantier");
  const created = one(await must(contractor.client.rpc("create_draft_project", { p_name: "B044 — chantier de test", p_country: "ML", p_role: "CONTRACTOR" }), "projet"));
  const pid = created.project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  await must(service.from("projects").update({ budget: ENVELOPE }).eq("id", pid), "enveloppe");
  const rev = async () => one((await contractor.client.rpc("get_project_phase_plan", { p_project_id: pid })).data).revision;
  await must(contractor.client.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: [
    { position: 1, label: "Fondations", weight: 40, planned_start: daysFrom(-20), planned_end: daysFrom(-1) },
    { position: 2, label: "Élévation", weight: 40, planned_start: daysFrom(-20), planned_end: daysFrom(-1) },
    { position: 3, label: "Toiture", weight: 20, planned_start: daysFrom(-1), planned_end: daysFrom(10) },
  ], p_expected_revision: 0 }), "plan");
  await must(contractor.client.rpc("publish_phase_plan", { p_project_id: pid, p_expected_revision: await rev() }), "publication");
  const phases = await must(contractor.client.rpc("list_project_phase_details", { p_project_id: pid }), "étapes");
  const byLabel = (l) => phases.find((p) => p.label === l).phase_id;
  await must(contractor.client.rpc("update_phase_progress", { p_project_id: pid, p_phase_id: byLabel("Fondations"), p_progression: 50, p_expected_revision: await rev() }), "progression F");
  await must(contractor.client.rpc("update_phase_progress", { p_project_id: pid, p_phase_id: byLabel("Élévation"), p_progression: 100, p_expected_revision: await rev() }), "progression E");
  await must(contractor.client.rpc("declare_phase_complete", { p_project_id: pid, p_phase_id: byLabel("Élévation"), p_expected_revision: await rev() }), "déclaration");
  await must(owner.client.rpc("decide_phase", { p_project_id: pid, p_phase_id: byLabel("Élévation"), p_decision: "VALIDEE", p_reason: null, p_expected_revision: await rev() }), "validation");

  // Données internes ou privées.
  const smExp = await must(sm.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: null, p_expected_revision: null, p_amount_fcfa: EXPENSE_AMOUNT, p_expense_date: today, p_category: "MATERIAUX", p_supplier: "Fournisseur interne", p_note: null, p_phase_id: null, p_no_receipt_reason: null }), "dépense");
  await must(sm.client.rpc("submit_expense", { p_expense_id: smExp.id, p_expected_revision: smExp.revision }), "soumission");
  await must(sm.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: null, p_expected_revision: null, p_amount_fcfa: "1000", p_expense_date: today, p_category: "AUTRE", p_supplier: null, p_note: null, p_phase_id: null, p_no_receipt_reason: null }), "brouillon dépense");
  await must(contractor.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: BUDGET_AMOUNT, p_reason: null, p_expected_revision: 0 }), "budget");
  const bytes = Buffer.from(`%PDF-1.4 B044 ${randomUUID()}`);
  const op = randomUUID();
  const prep = await must(contractor.client.rpc("prepare_document_upload", { p_operation_uuid: op, p_project_id: pid, p_document_id: null, p_document_type: "AUTRE", p_title: DOC_TITLE, p_description: null, p_visibility: "ENTREPRISE", p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "doc prepare");
  const claim = await must(contractor.client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "doc claim");
  await must(service.storage.from("project-documents").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "doc write");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "doc attest");
  const docVersion = await must(contractor.client.rpc("finalize_document_upload", { p_operation_uuid: op }), "doc finalize");
  const docRev = (await service.from("documents").select("revision").eq("id", docVersion.document_id).single()).data.revision;
  await must(contractor.client.rpc("publish_document", { p_document_id: docVersion.document_id, p_expected_revision: docRev }), "doc publish");
  await must(sm.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: today, p_works_done: DRAFT_TEXT, p_difficulties: null, p_team: null, p_next_actions: null }), "journal brouillon");
  await must(sm.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "SECURITE", p_severity: "URGENTE", p_occurred_at: new Date(Date.now() - 3600000).toISOString(), p_description: "Échafaudage instable côté nord" }), "incident");

  const project = { id: pid, name: "B044 — chantier de test", status: "DRAFT", budget: ENVELOPE };

  // Propriétaire principal et copropriétaire.
  const ownerSpy = spy(owner);
  const ownerCard = await d.loadCard(ownerSpy.client, project, "OWNER_PRIMARY", today);
  const coSpy = spy(coOwner);
  const coCard = await d.loadCard(coSpy.client, project, "CO_OWNER", today);
  for (const [label, card, calls] of [["Propriétaire principal", ownerCard, ownerSpy.calls], ["Copropriétaire", coCard, coSpy.calls]]) {
    const body = JSON.stringify(card);
    const leaks = [EXPENSE_AMOUNT, BUDGET_AMOUNT, DOC_TITLE, DRAFT_TEXT, "Fournisseur interne"].filter((m) => body.includes(m));
    record(`${label} : aucune donnée interne ni privée dans la carte (dépense, budget, document « Entreprise », brouillon d'autrui)`, leaks.length === 0 && !/expense|receipt|dépense|reçu|budget_fcfa|internal/i.test(body), leaks.join(", ") || "aucune fuite");
    record(`${label} : aucune fonction interne appelée (dépenses, budget, reçus, demandes internes)`, calls.length > 0 && !calls.some((f) => INTERNAL_FUNCTIONS.test(f)), calls.join(", "));
    record(`${label} : avancement déclaré et avancement validé dans deux valeurs séparées`, card.declared.kind === "ok" && card.validated.kind === "ok" && card.declared.value.percent === 60 /* 40 % × 50 % + 40 % × 100 % */ && card.validated.value.validated === 1 && card.validated.value.applicable === 3, `${JSON.stringify(card.declared)} / ${JSON.stringify(card.validated)}`);
    record(`${label} : incidents ouverts (dont urgent) et activité datée`, card.incidents.kind === "ok" && card.incidents.value.open === 1 && card.incidents.value.high === 1 && !!card.lastActivityAt, JSON.stringify(card.incidents));
  }
  record("Propriétaire principal : décisions visibles et à sa charge ; copropriétaire : en lecture (droits affichés)", ownerCard.decisions.kind === "ok" && ownerCard.decisions.value.canDecide === true && coCard.decisions.kind === "ok" && coCard.decisions.value.canDecide === false, `${JSON.stringify(ownerCard.decisions)} / ${JSON.stringify(coCard.decisions)}`);
  record("Propriétaire : la carte n'a aucune rubrique « fin prévue dépassée » ni « demandes internes »", !("overdue" in ownerCard) && !("requests" in ownerCard));

  // Entreprise.
  const ctSpy = spy(contractor);
  const ctCard = await d.loadCard(ctSpy.client, project, "CONTRACTOR", today);
  record("Entreprise : « fin prévue dépassée » sur l'étape non validée (Fondations), absente sur l'étape validée (Élévation) et sur l'étape future", ctCard.overdue.kind === "ok" && ctCard.overdue.value.count === 1 && ctCard.overdue.value.labels.join() === "Fondations", JSON.stringify(ctCard.overdue));
  record("Entreprise : demandes par chantier (1 dépense soumise, jamais de montant)", ctCard.requests.kind === "ok" && ctCard.requests.value.expensesSubmitted === 1 && !JSON.stringify(ctCard).includes(EXPENSE_AMOUNT) && !JSON.stringify(ctCard).includes(BUDGET_AMOUNT), JSON.stringify(ctCard.requests));
  record("Entreprise : deux mesures d'avancement séparées", ctCard.declared.kind === "ok" && ctCard.validated.kind === "ok" && ctCard.declared.value.percent === 60 /* 40 % × 50 % + 40 % × 100 % */ && ctCard.validated.value.validated === 1);
  record("Entreprise : aucune fonction de budget ni d'alerte appelée par le tableau de bord", !ctSpy.calls.some((f) => /budget/i.test(f)), ctSpy.calls.join(", "));

  // Chef de chantier.
  const smSpy = spy(sm);
  const smCard = await d.loadCard(smSpy.client, project, "SITE_MANAGER", today);
  record("Chef de chantier : aucune fonction de budget ni d'alerte appelée ; aucun montant de budget dans la carte", !smSpy.calls.some((f) => /budget|alert/i.test(f)) && !JSON.stringify(smCard).includes(BUDGET_AMOUNT), smSpy.calls.join(", "));
  record("Chef de chantier : journal du jour en brouillon, ses dépenses (1 brouillon, 1 soumise), incidents", smCard.journalToday.kind === "ok" && smCard.journalToday.value.draft === true && smCard.journalToday.value.published === false && smCard.myExpenses.kind === "ok" && smCard.myExpenses.value.drafts === 1 && smCard.myExpenses.value.submitted === 1 && smCard.incidents.kind === "ok" && smCard.incidents.value.high === 1, JSON.stringify([smCard.journalToday, smCard.myExpenses]));
  record("Chef de chantier : aucun bloc « éléments non synchronisés » (T5 A)", !("queue" in smCard) && !("unsynced" in smCard));

  // Non-membre : chaque section en erreur, aucune donnée.
  const outCard = await d.loadCard(outsider.client, project, "OWNER_PRIMARY", today);
  const sections = ["declared", "validated", "finance", "decisions", "incidents"].map((k) => outCard[k].kind);
  record("Non-membre : toutes les sections en erreur (aucune donnée), aucune activité", sections.every((k) => k === "error") && outCard.lastActivityAt === null, sections.join(", "));

  // Aucun total entre chantiers : un second chantier ne modifie pas la carte du premier.
  const p2 = one(await must(contractor.client.rpc("create_draft_project", { p_name: "B044 — second chantier", p_country: "ML", p_role: "CONTRACTOR" }), "projet 2")).project_id;
  await must(service.from("project_memberships").insert({ project_id: p2, profile_id: owner.id, role: "OWNER", owner_profile: "PRIMARY" }), "adhésion 2");
  const again = await d.loadCard(owner.client, project, "OWNER_PRIMARY", today);
  record("Cartes indépendantes : la carte du chantier 1 est identique avec un second chantier (aucun cumul)", JSON.stringify(again.finance) === JSON.stringify(ownerCard.finance) && JSON.stringify(again.validated) === JSON.stringify(ownerCard.validated));
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
