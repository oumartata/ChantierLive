// Test d'intégration LOCAL uniquement : B046, rapport de suivi PDF
// (src/lib/report/report.ts ; M053 ; D200, D034 ; BR079, BR080, BR098).
// Le générateur RÉEL est compilé puis appelé avec le client de chaque compte
// jetable (4 rôles) ; le TEXTE EXTRAIT de chaque PDF (pdfjs-dist) passe au
// scanner de confidentialité partagé (scripts/lib/private-scan.mjs), avec un
// contrôle positif capable d'échouer (R15). Ex-membre et non-membre refusés ;
// trace de génération visible de son seul auteur, hors audit du chantier ;
// aucun fichier conservé ; police intégrée (nom accentué, latin étendu,
// caractère non couvert signalé).
//
// Usage : node --env-file=.env.local scripts/test-report.mjs

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { makeScanner } from "./lib/private-scan.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const local = (() => { try { const { hostname } = new URL(SUPABASE_URL); return hostname === "127.0.0.1" || hostname === "localhost"; } catch { return false; } })();
if (!local) { console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`); process.exit(1); }
if (!SERVICE_KEY || !ANON_KEY) { console.error("Clés locales manquantes."); process.exit(1); }

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const one = (d) => (Array.isArray(d) ? d[0] : d);
async function must(res, what) { const r = await res; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; }
async function user(label) {
  const email = `b046-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, email, client, label };
}
const psqlValue = (sql) => new Promise((resolve, reject) => {
  const proc = spawn("docker", ["exec", "-i", "supabase_db_ChantierLive", "psql", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] });
  let o = "";
  let e = "";
  proc.stdout.on("data", (d) => (o += d));
  proc.stderr.on("data", (d) => (e += d));
  proc.on("close", (c) => (c === 0 ? resolve(o.trim()) : reject(new Error(e))));
});
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64"
);
const tag = String(Date.now()).slice(-6);
const M = {
  name: `Résidence Éloïse — Œuvre de Ségou ${tag}`,
  journal: `JOURNAL-RAPPORT-${tag} Électricité posée à l'étage, façade et Łódź ŝ 😀`,
  draftLog: `JOURNAL-BROUILLON-RAPPORT-${tag}`,
  incident: `INCIDENT-RAPPORT-${tag}`,
  comment: `COMMENTAIRE-VISIBLE-RAPPORT-${tag}`,
  retracted: `COMMENTAIRE-RETIRE-RAPPORT-${tag}`,
  supplier: `FOURNISSEUR-INTERNE-RAPPORT-${tag}`,
  expense: "454545454",
  budget: "565656565",
  budget2: "676767676",
  budgetReason: `MOTIF-BUDGET-RAPPORT-${tag}`,
  docInternal: `DOC-ENTREPRISE-RAPPORT-${tag}`,
  docShared: `DOC-PRINCIPAUX-RAPPORT-${tag}`,
  docAll: `DOC-TOUS-RAPPORT-${tag}`,
  docDraft: `DOC-BROUILLON-RAPPORT-${tag}`,
  reference: `REF-PAIEMENT-RAPPORT-${tag}`,
};

async function depositPlan(client, pid, label) {
  const bytes = Buffer.from(`%PDF-1.4 ${label}`);
  const op = randomUUID();
  const prep = await must(client.rpc("prepare_project_plan_upload", { p_operation_uuid: op, p_project_id: pid, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "prepare");
  const claim = await must(client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "claim");
  await must(service.storage.from("project-plans").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "upload");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "attest");
  return must(client.rpc("finalize_project_plan_upload", { p_operation_uuid: op }), "finalize");
}
async function depositDoc(u, pid, title, visibility, publish = true) {
  const bytes = Buffer.from(`%PDF-1.4 ${title} ${randomUUID()}`);
  const op = randomUUID();
  const prep = await must(u.client.rpc("prepare_document_upload", { p_operation_uuid: op, p_project_id: pid, p_document_id: null, p_document_type: "AUTRE", p_title: title, p_description: null, p_visibility: visibility, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "doc");
  const claim = await must(u.client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "doc claim");
  await must(service.storage.from("project-documents").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "doc write");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "doc attest");
  const fin = one(await must(u.client.rpc("finalize_document_upload", { p_operation_uuid: op }), "doc finalize"));
  const id = fin.document_id ?? fin.id;
  if (publish) {
    const { data: row } = await service.from("documents").select("revision").eq("id", id).single();
    await must(u.client.rpc("publish_document", { p_document_id: id, p_expected_revision: row.revision }), "doc publish");
  }
}
async function uploadMedia(u, pid, publish) {
  const op = randomUUID();
  await must(u.client.rpc("prepare_media_upload", { p_operation_uuid: op, p_project_id: pid, p_expected_checksum: sha(JPEG), p_expected_size_bytes: JPEG.length, p_expected_mime_type: "image/jpeg" }), "prepare_media_upload");
  const temp = `_private/${pid}/media_asset/${op}/source`;
  const signed = await must(service.storage.from("project-media").createSignedUploadUrl(temp), "createSignedUploadUrl");
  await must(u.client.storage.from("project-media").uploadToSignedUrl(signed.path, signed.token, JPEG, { contentType: "image/jpeg", upsert: true }), "uploadToSignedUrl");
  const claim = await must(u.client.rpc("claim_upload_attempt", { p_operation_uuid: op }), "claim media");
  await must(service.storage.from("project-media").upload(claim.candidate_key, JPEG, { contentType: "image/jpeg", upsert: false }), "write candidate");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(JPEG), p_actual_size_bytes: JPEG.length, p_actual_mime_type: "image/jpeg" }), "attest media");
  const row = one(await must(u.client.rpc("finalize_media_upload", { p_operation_uuid: op, p_origin: "IMPORTED", p_caption: null }), "finalize media"));
  if (publish) await must(u.client.rpc("publish_media_asset", { p_media_asset_id: row.id }), "publish media");
}

// Compilé sous node_modules/.cache pour résoudre pdfkit et fontkit du dépôt.
const cacheDir = join(repoRoot, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const tmpDir = mkdtempSync(join(cacheDir, "test-rapport-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "src/lib/report/report.ts" --module commonjs --target es2020 --outDir "${tmpDir}" --skipLibCheck --strict --esModuleInterop`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(`compilation : ${compile.stdout}${compile.stderr}`);
  const R = await import(pathToFileURL(join(tmpDir, "report.js")).href);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const extract = async (bytes) => {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, isEvalSupported: false }).promise;
    const pages = [];
    let minFont = Infinity;
    let width = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      width = page.getViewport({ scale: 1 }).width;
      const tc = await page.getTextContent();
      for (const it of tc.items) if (it.str.trim()) minFont = Math.min(minFont, Math.abs(it.transform[0]));
      pages.push(tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join(""));
    }
    return { text: pages.join("\n"), pages: pdf.numPages, minFont, width };
  };

  // Chantier : devis accepté (prix convenu), versement confirmé, 4 rôles.
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const exMember = await user("ex-chef");
  const outsider = await user("hors-chantier");
  const engineer = await user("ingenieur");
  const { data: proj } = await contractor.client.rpc("create_draft_project", { p_name: M.name, p_country: "ML", p_role: "CONTRACTOR" });
  const { project_id: pid, organization_id: orgId } = one(proj);
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null], [exMember, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  const revision = async () => (await service.from("projects").select("revision").eq("id", pid).single()).data.revision;
  const designation = await must(contractor.client.rpc("designate_plan_engineer", { p_organization_id: orgId, p_identifier_kind: "EMAIL", p_identifier_value: engineer.email }), "designate");
  const plan = await depositPlan(owner.client, pid, `PLAN-${tag}`);
  await must(owner.client.rpc("set_retained_project_plan_version", { p_project_id: pid, p_version_id: plan.id, p_expected_revision: await revision() }), "retain");
  const val = await must(contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: plan.id, p_designation_id: designation.id }), "submit");
  await must(engineer.client.rpc("decide_plan_validation", { p_validation_id: val.id, p_decision: "VALIDATED", p_note: null }), "validate");
  await must(contractor.client.rpc("publish_project_plan_version", { p_project_id: pid, p_version_id: plan.id, p_expected_revision: await revision() }), "publish");
  const q = await must(contractor.client.rpc("create_quote_estimate", { p_project_id: pid, p_lines: [{ label: "Gros œuvre", unit: "forfait", quantity: "1", unit_price_fcfa: "10000000" }], p_expected_revision: 0 }), "quote");
  const qRev = async () => (await service.from("quotes").select("revision").eq("project_id", pid).single()).data.revision;
  await must(contractor.client.rpc("propose_quote_version", { p_version_id: q.id, p_expected_revision: await qRev() }), "propose quote");
  await must(owner.client.rpc("decide_quote_version", { p_version_id: q.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: await qRev() }), "accept quote");
  const ledgerRev = async () => (await service.from("advance_ledgers").select("revision").eq("project_id", pid).maybeSingle()).data?.revision ?? 0;
  await must(contractor.client.rpc("set_advance_requirement", { p_operation_uuid: randomUUID(), p_project_id: pid, p_amount_fcfa: "1000000", p_expected_revision: 0 }), "avance exigée");
  const today = new Date().toISOString().slice(0, 10);
  const adv = one(await must(owner.client.rpc("declare_advance_payment", { p_operation_uuid: randomUUID(), p_project_id: pid, p_amount_fcfa: "1000000", p_payment_date: today, p_mode: "ORANGE_MONEY", p_reference: M.reference, p_disclaimer_ack: true, p_expected_revision: await ledgerRev() }), "versement"));
  await must(contractor.client.rpc("confirm_advance_payment", { p_operation_uuid: randomUUID(), p_advance_id: adv.advance_id, p_expected_revision: await ledgerRev() }), "confirmation");

  // Contenu du chantier.
  const log = await must(sm.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: today, p_works_done: M.journal, p_difficulties: null, p_team: null, p_next_actions: null }), "journal");
  await must(sm.client.rpc("publish_daily_log_draft", { p_log_id: log.id, p_expected_revision: log.revision }), "publication");
  await must(sm.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), p_works_done: M.draftLog, p_difficulties: null, p_team: null, p_next_actions: null }), "brouillon");
  await must(sm.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "AUTRE", p_severity: "MOYENNE", p_occurred_at: new Date(Date.now() - 3600000).toISOString(), p_description: M.incident }), "incident");
  await must(owner.client.rpc("add_comment", { p_target_type: "DAILY_LOG", p_target_id: log.id, p_body: M.comment }), "commentaire");
  const toRetract = await must(owner.client.rpc("add_comment", { p_target_type: "DAILY_LOG", p_target_id: log.id, p_body: M.retracted }), "commentaire 2");
  await must(owner.client.rpc("retract_comment", { p_comment_id: toRetract.id, p_expected_revision: toRetract.revision }), "retrait");
  const exp = await must(sm.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: null, p_expected_revision: null, p_amount_fcfa: M.expense, p_expense_date: today, p_category: "MATERIAUX", p_supplier: M.supplier, p_note: null, p_phase_id: null, p_no_receipt_reason: null }), "dépense");
  await must(sm.client.rpc("submit_expense", { p_expense_id: exp.id, p_expected_revision: exp.revision }), "soumission");
  const b1 = await must(contractor.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: M.budget, p_reason: null, p_expected_revision: 0 }), "budget");
  await must(contractor.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: M.budget2, p_reason: M.budgetReason, p_expected_revision: b1.version_number ?? 1 }), "révision budget");
  await depositDoc(contractor, pid, M.docInternal, "ENTREPRISE");
  await depositDoc(contractor, pid, M.docShared, "PRINCIPAUX");
  await depositDoc(owner, pid, M.docAll, "TOUS");
  await depositDoc(contractor, pid, M.docDraft, "TOUS", false);
  await uploadMedia(sm, pid, true);
  await uploadMedia(sm, pid, false);

  // Ex-membre : retiré avant la génération.
  const { data: exMs } = await service.from("project_memberships").select("id").eq("project_id", pid).eq("profile_id", exMember.id).single();
  await must(contractor.client.rpc("remove_participant", { p_membership_id: exMs.id, p_reason: "Fin de mission" }), "retrait");

  const { from, to } = R.defaultPeriod(new Date());
  record("Période par défaut : 30 derniers jours, aujourd'hui compris", to === today && (new Date(to) - new Date(from)) / 86400000 === 29, `${from} → ${to}`);

  // Mesures « avant » : stockage, audit du chantier, notifications.
  const storageBefore = await psqlValue("select count(*) from storage.objects");
  const auditBefore = (await service.from("audit_events").select("id", { count: "exact", head: true }).eq("project_id", pid)).count;
  const notifBefore = (await service.from("notifications").select("id", { count: "exact", head: true }).eq("project_id", pid)).count;

  // Génération pour les 4 rôles.
  const out = {};
  for (const u of [contractor, owner, coOwner, sm]) {
    const g = await R.generateReport(u.client, pid, from, to);
    const x = await extract(g.bytes);
    out[u.label] = { ...g, ...x };
  }
  record("Taille des PDF (Ko) et nombre de pages par rôle", Object.values(out).every((o) => o.bytes.length > 1000 && o.bytes.length < 2_000_000),
    Object.entries(out).map(([k, o]) => `${k} ${(o.bytes.length / 1024).toFixed(1)} Ko, ${o.pages} p.`).join(" ; "));

  const has = (role, s) => out[role].text.replace(/\s+/g, " ").includes(s.replace(/\s+/g, " "));
  const all = Object.keys(out);
  record("Mentions obligatoires sur chaque rapport (D034) : génération, données synchronisées, ni expertise ni certification, aucune preuve garantie, identifiant, empreinte",
    all.every((r) => has(r, "Rapport généré le") && has(r, "à partir des données synchronisées disponibles") && has(r, "ni expertise, ni certification") && has(r, "Aucune preuve n'est garantie authentique") && has(r, "SIL Open Font License 1.1") && has(r, out[r].data.reportId) && has(r, out[r].contentHash)));
  record("Avancement déclaré et avancement validé : deux sections distinctes dans chaque rapport",
    all.every((r) => has(r, "Avancement déclaré par l'entreprise") && has(r, "Avancement validé par le propriétaire principal") && out[r].text.indexOf("Avancement déclaré par") < out[r].text.indexOf("Avancement validé par")));
  record("Nom accentué rendu par la police intégrée (Noto Sans) dans chaque rapport", all.every((r) => has(r, M.name)), M.name);
  record("Latin étendu rendu (Łódź, ŝ) ; caractère non couvert (😀) remplacé par « � » et signalé (U+1F600), jamais supprimé en silence",
    all.every((r) => has(r, "Łódź ŝ") && has(r, "façade et Łódź ŝ �") && has(r, "U+1F600 (1)") && out[r].unsupported.some((u) => u.codePoint === "U+1F600")));
  record("Journal publié présent ; brouillon absent ; aucun commentaire (visible ou retiré)", all.every((r) => has(r, `JOURNAL-RAPPORT-${tag}`) && !has(r, M.draftLog) && !has(r, M.comment) && !has(r, M.retracted)));
  record("Incident présent dans chaque rapport", all.every((r) => has(r, M.incident)));
  record("Documents selon la visibilité : « Entreprise » pour l'entreprise seule ; « principaux » sans le chef ; « tous » partout ; brouillon nulle part",
    has("entreprise", M.docInternal) && !has("proprietaire", M.docInternal) && !has("coproprietaire", M.docInternal) && !has("chef", M.docInternal)
      && has("entreprise", M.docShared) && has("proprietaire", M.docShared) && has("coproprietaire", M.docShared) && !has("chef", M.docShared)
      && all.every((r) => has(r, M.docAll) && !has(r, M.docDraft)));
  record("Photos en liste (date, origine) : une seule, la publiée ; jamais le brouillon", all.every((r) => has(r, "Photos publiées (1)") && has(r, "importée")));
  record("Prix convenu, versements et reste dû pour entreprise, propriétaire et copropriétaire ; absents pour le chef",
    ["entreprise", "proprietaire", "coproprietaire"].every((r) => /Prix convenu : 10.000.000.FCFA/.test(out[r].text.replace(/\s+/g, " ")) && has(r, "Reste dû") && has(r, "ChantierLive n'encaisse rien"))
      && !has("chef", "Prix convenu") && !/10.000.000/.test(out.chef.text) && !has("chef", "Versements"));

  // Scanner de confidentialité sur le TEXTE EXTRAIT (R15).
  const forbidden = [M.supplier, M.expense, M.budget, M.budget2, M.budgetReason, M.draftLog, M.comment, M.retracted, M.docDraft, M.reference,
    contractor.email, owner.email, coOwner.email, sm.email, exMember.email, contractor.id, owner.id, coOwner.id, sm.id, pid, "_private/", "project-documents"];
  const scan = makeScanner(forbidden);
  const legit = await Promise.all([
    contractor.client.rpc("list_project_expenses", { p_project_id: pid }),
    contractor.client.rpc("list_internal_budget_versions", { p_project_id: pid }),
    sm.client.rpc("list_my_daily_log_drafts", { p_project_id: pid }),
  ]);
  const legitHits = new Set(legit.flatMap((r) => scan(r.data)));
  record("Contrôle positif (R15) : le scanner trouve dépense, budget, motif et brouillon là où ils existent", [M.supplier, M.budget2, M.budgetReason, M.draftLog].every((m) => legitHits.has(m)), [...legitHits].join(","));
  const forgedText = `${out.proprietaire.text}\nDépense ${M.supplier} ${M.expense} FCFA — ${M.docDraft} — ${owner.email}`;
  record("Contrôle positif (R15) : un rapport altéré (dépense, document brouillon, e-mail) est détecté", [M.supplier, M.expense, M.docDraft, owner.email].every((m) => scan(forgedText).includes(m)), scan(forgedText).join(","));
  const leaks = Object.entries(out).flatMap(([r, o]) => scan(o.text).map((h) => `${r}:${h}`));
  record("Texte extrait des 4 rapports : aucune finance interne (dépense, budget, motif), aucun brouillon, commentaire, référence de paiement, identité ni chemin privé", leaks.length === 0, leaks.join(", ") || "rien");

  // Nom de fichier, téléphone.
  record("Nom de fichier sans donnée sensible : rapport-chantier-<identifiant court>-<du>_<au>.pdf", all.every((r) => out[r].fileName === `rapport-chantier-${pid.slice(0, 8)}-${from}_${to}.pdf` && !/[A-Z ÉÈ]/.test(out[r].fileName)), out.proprietaire.fileName);
  record("Lisible sur téléphone : A4 portrait, une colonne, texte d'au moins 7,5 points (corps 10)", all.every((r) => Math.round(out[r].width) === 595 && out[r].minFont >= 7.4), all.map((r) => `${r} ${out[r].minFont}`).join(" ; "));

  // Trace de génération : auteur seul, hors audit ; aucune notification ; rien de stocké.
  const traces = {};
  for (const u of [contractor, owner, coOwner, sm]) traces[u.label] = (await must(u.client.rpc("list_my_report_generations", { p_project_id: pid }), "traces")) ?? [];
  record("Trace de génération : chacun ne voit que la sienne (identifiant, empreintes, taille exactes)",
    Object.entries(traces).every(([r, t]) => t.length === 1 && t[0].report_id === out[r].data.reportId && t[0].file_sha256 === out[r].fileHash && t[0].content_sha256 === out[r].contentHash && t[0].file_size_bytes === out[r].bytes.length));
  const directTrace = await owner.client.from("report_generations").select("id").limit(1);
  record("Table des traces jamais lisible directement", !!directTrace.error, directTrace.error?.message);
  const auditAfter = (await service.from("audit_events").select("id", { count: "exact", head: true }).eq("project_id", pid)).count;
  const notifAfter = (await service.from("notifications").select("id", { count: "exact", head: true }).eq("project_id", pid)).count;
  record("Aucune écriture dans l'audit du chantier (D186) ni notification", auditAfter === auditBefore && notifAfter === notifBefore, `audit ${auditBefore} → ${auditAfter} ; notifications ${notifBefore} → ${notifAfter}`);
  const storageAfter = await psqlValue("select count(*) from storage.objects");
  record("Aucun fichier PDF conservé : stockage inchangé après 4 générations", storageAfter === storageBefore, `${storageBefore} → ${storageAfter}`);
  const second = await R.collectReport(owner.client, pid, from, to);
  record("Régénération : nouvel identifiant à chaque demande ; même empreinte des données si rien n'a changé (BR079)", second.reportId !== out.proprietaire.data.reportId && R.contentSha256(second) === out.proprietaire.contentHash);

  // Refus.
  const refusal = async (u, f = from, t = to) => {
    try { await R.collectReport(u.client, pid, f, t); return "généré"; } catch (e) { return e.code ?? e.message; }
  };
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const longFrom = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const r1 = await refusal(exMember);
  const r2 = await refusal(outsider);
  const r3 = await refusal(owner, longFrom, to);
  const r4 = await refusal(owner, from, tomorrow);
  const r5 = await refusal(owner, to, from);
  record("Ex-membre et non-membre refusés ; période de plus de 12 mois, dans le futur ou inversée refusée", r1 === "not_authorized" && r2 === "not_authorized" && r3 === "period_too_long" && r4 === "period_in_future" && (from === to || r5 === "period_invalid"), [r1, r2, r3, r4, r5].join(" / "));
  const r12 = await refusal(owner, new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10), to);
  record("Période de 12 mois acceptée", r12 === "généré", r12);
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
