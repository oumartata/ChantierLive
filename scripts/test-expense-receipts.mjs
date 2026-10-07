// Test d'intégration LOCAL uniquement : M046, reçus des dépenses internes
// (B032 ; done_when « absence et justification gérées » ; D183, D184 F5 C
// et F6 A, D186, D187 H1). Type réel contrôlé sur les octets relus ; reçu
// lisible par qui voit la dépense (entreprise, chef de chantier ; brouillon
// : son auteur seul) ; propriétaire, copropriétaire, ex-membre, non-membre
// et visiteur sans session n'obtiennent rien. Données jetables créées par ce
// script. Le stockage direct et les chemins forgés sont couverts par
// scripts/test-file-cross-access.mjs.
//
// Usage : node --env-file=.env.local scripts/test-expense-receipts.mjs

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const local = (() => { try { const { hostname } = new URL(SUPABASE_URL); return hostname === "127.0.0.1" || hostname === "localhost"; } catch { return false; } })();
if (!local) { console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`); process.exit(1); }
if (!SERVICE_KEY || !ANON_KEY) { console.error("Clés locales manquantes."); process.exit(1); }

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const BUCKET = "expense-receipts";
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const err = (r) => r?.error?.message ?? r?.error?.code ?? "aucune erreur";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const one = (d) => (Array.isArray(d) ? d[0] : d);
async function user(label) {
  const email = `m046-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client, label };
}

// Détection du type réel : même règle que l'action serveur (src/app/(app)/chantiers/[id]/depenses/actions.ts).
function sniff(b) {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
const PDF = (label) => Buffer.from(`%PDF-1.4 M046 ${label} ${randomUUID()}`);

// Flux serveur reproduit : préparer -> revendiquer -> écrire (service) -> relire -> type réel -> attester -> finaliser.
async function attach(u, expenseId, bytes, declared = "application/pdf") {
  const op = randomUUID();
  const prep = await u.client.rpc("prepare_expense_receipt_upload", { p_operation_uuid: op, p_expense_id: expenseId, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: declared });
  if (prep.error) return { stage: "prepare", error: prep.error };
  const claim = await u.client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.data.attempt_id });
  if (claim.error || !claim.data?.won) return { stage: "claim", error: claim.error ?? { message: "not_won" } };
  const w = await service.storage.from(BUCKET).upload(claim.data.candidate_key, bytes, { contentType: declared, upsert: false });
  if (w.error) return { stage: "write", error: w.error };
  const reread = Buffer.from(await (await service.storage.from(BUCKET).download(claim.data.candidate_key)).data.arrayBuffer());
  const att = await service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.data.attempt_id, p_actual_checksum: sha(reread), p_actual_size_bytes: reread.length, p_actual_mime_type: sniff(reread) ?? "application/octet-stream" });
  if (att.error) {
    const fin = await u.client.rpc("finalize_expense_receipt_upload", { p_operation_uuid: op });
    return { stage: "attest", error: att.error, finalizeError: fin.error, op };
  }
  const fin = await u.client.rpc("finalize_expense_receipt_upload", { p_operation_uuid: op });
  if (fin.error) return { stage: "finalize", error: fin.error, op };
  return { data: fin.data, key: claim.data.candidate_key, op, bytes };
}

try {
  const contractor = await user("entreprise");
  const sm = await user("chef");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const exMember = await user("ex-coproprietaire");
  const outsider = await user("hors-chantier");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  const { data: created, error: pErr } = await contractor.client.rpc("create_draft_project", { p_name: "M046 — chantier de test", p_country: "ML", p_role: "CONTRACTOR" });
  if (pErr) throw new Error(pErr.message);
  const pid = one(created).project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null], [exMember, "OWNER", "CO_OWNER"]]) {
    const { error } = await service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op });
    if (error) throw new Error(`adhésion ${u.label}: ${error.message}`);
  }
  const save = (u, { id = null, rev = null, amount = "125000", justification = null } = {}) =>
    u.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: id, p_expected_revision: rev, p_amount_fcfa: amount, p_expense_date: "2026-10-06", p_category: "MATERIAUX", p_supplier: "Quincaillerie", p_note: null, p_phase_id: null, p_no_receipt_reason: justification });
  const submit = (u, e) => u.client.rpc("submit_expense", { p_expense_id: e.id, p_expected_revision: e.revision });
  const fresh = async (id) => (await service.from("expenses").select("*").eq("id", id).single()).data;
  const receipts = (u, expenseId) => u.client.rpc("list_expense_receipts", { p_expense_id: expenseId });
  const fileKey = (u, receiptId) => u.client.rpc("get_expense_receipt_file_key", { p_receipt_id: receiptId });
  const withdraw = (u, receiptId, reason) => u.client.rpc("withdraw_expense_receipt", { p_receipt_id: receiptId, p_reason: reason });
  const policy = (u) => u.client.rpc("get_expense_receipt_policy", { p_project_id: pid });
  const setPolicy = (u, required, rev) => u.client.rpc("set_expense_receipt_policy", { p_project_id: pid, p_required: required, p_expected_revision: rev });

  // 1. Brouillon du chef de chantier : reçu joint par son auteur (H1).
  const smDraft = (await save(sm)).data;
  const r1 = await attach(sm, smDraft.id, PDF("brouillon-chef"));
  record("Chef de chantier : joint un reçu PDF à son brouillon (aucune version encore)", !r1.error && r1.data.attached_to_version_id === null && r1.data.mime_type === "application/pdf", r1.error ? `${r1.stage} ${err(r1)}` : "");
  const smOwnList = await receipts(sm, smDraft.id);
  const smOwnKey = await fileKey(sm, r1.data.id);
  record("Chef de chantier : lit la liste et obtient la clé de son reçu", !smOwnList.error && smOwnList.data.length === 1 && smOwnList.data[0].can_withdraw && one(smOwnKey.data)?.storage_key === r1.key, err(smOwnKey));
  const ctDraftList = await receipts(contractor, smDraft.id);
  const ctDraftKey = await fileKey(contractor, r1.data.id);
  const ctDraftAttach = await attach(contractor, smDraft.id, PDF("intrus"));
  const ctDraftWithdraw = await withdraw(contractor, r1.data.id, "Tentative");
  record("H1 : l'entreprise n'obtient ni la liste, ni la clé, ni le dépôt, ni le retrait sur le brouillon du chef", [ctDraftList, ctDraftKey, ctDraftWithdraw].every((r) => r.error?.message === "not_authorized") && ctDraftAttach.error?.message === "not_authorized", [ctDraftList, ctDraftKey, ctDraftAttach, ctDraftWithdraw].map(err).join(" / "));

  // 2. Type réel contrôlé (comme M039).
  const spoof = await attach(sm, smDraft.id, PDF("deguise"), "image/png");
  record("Type réel : PDF déclaré PNG refusé à l'attestation, finalisation impossible", spoof.stage === "attest" && spoof.error?.message === "checksum_mismatch" && spoof.finalizeError?.message === "storage_not_verified", `${spoof.stage} ${err(spoof)} / ${spoof.finalizeError?.message}`);
  const html = await attach(sm, smDraft.id, Buffer.from("<html>pas un reçu</html>"), "image/jpeg");
  record("Type réel : contenu HTML déclaré JPEG refusé", html.stage === "attest" && html.error?.message === "checksum_mismatch", `${html.stage} ${err(html)}`);
  const badMime = await attach(sm, smDraft.id, Buffer.from("texte"), "text/plain");
  record("Format non admis (texte) refusé dès la préparation", badMime.stage === "prepare" && badMime.error?.message === "mime_type_required", err(badMime));
  const bigPrep = await sm.client.rpc("prepare_expense_receipt_upload", { p_operation_uuid: randomUUID(), p_expense_id: smDraft.id, p_expected_checksum: "a".repeat(64), p_expected_size_bytes: 10485761, p_expected_mime_type: "application/pdf" });
  record("Fichier de plus de 10 Mo refusé", bigPrep.error?.message === "size_required", err(bigPrep));
  const okList = await receipts(sm, smDraft.id);
  record("Les envois refusés ne créent aucun reçu", okList.data?.length === 1, String(okList.data?.length));

  // 3. Après soumission : lisible par l'entreprise et le chef ; URL signée servie au contenu exact.
  const smSub = (await submit(sm, await fresh(smDraft.id))).data;
  const ctKey = await fileKey(contractor, r1.data.id);
  const signed = await service.storage.from(BUCKET).createSignedUrl(one(ctKey.data).storage_key, 300);
  const body = Buffer.from(await (await fetch(signed.data.signedUrl)).arrayBuffer());
  record("Soumise : l'entreprise lit le reçu du chef ; l'URL signée renvoie le contenu exact", !ctKey.error && sha(body) === sha(r1.bytes), err(ctKey));
  const r2 = await attach(contractor, smSub.id, PDF("entreprise-sur-soumise"));
  record("Entreprise : joint un reçu à la dépense soumise, lié à la version 1", !r2.error && r2.data.attached_to_version_id === smSub.current_version_id, r2.error ? `${r2.stage} ${err(r2)}` : "");
  const smSees = await receipts(sm, smSub.id);
  record("Chef de chantier : voit les 2 reçus, ne peut retirer que le sien", smSees.data?.length === 2 && smSees.data.filter((r) => r.can_withdraw).length === 1 && smSees.data.find((r) => r.can_withdraw).id === r1.data.id, JSON.stringify(smSees.data?.map((r) => r.can_withdraw)));

  // Dépense de l'entreprise : le chef la voit (H3) mais n'y joint rien.
  const ctExp = (await submit(contractor, (await save(contractor, { amount: "900000" })).data)).data;
  const r3 = await attach(contractor, ctExp.id, PDF("entreprise"));
  const smOnCt = await attach(sm, ctExp.id, PDF("chef-sur-entreprise"));
  const smReadCt = await fileKey(sm, r3.data.id);
  record("Chef de chantier : lit le reçu d'une dépense de l'entreprise, ne peut pas y joindre", !smReadCt.error && smOnCt.error?.message === "not_authorized", `${err(smReadCt)} / ${err(smOnCt)}`);

  // 4. Retrait motivé, visible ; fichier retiré non délivré.
  const smWdCt = await withdraw(sm, r2.data.id, "Pas le bon");
  record("Chef de chantier : ne retire pas le reçu de l'entreprise", smWdCt.error?.message === "not_authorized", err(smWdCt));
  const noReason = await withdraw(sm, r1.data.id, " ");
  record("Retrait sans motif refusé", noReason.error?.message === "reason_required", err(noReason));
  const wd = await withdraw(sm, r1.data.id, "Photo floue");
  const afterWd = await receipts(contractor, smSub.id);
  const wdRow = afterWd.data?.find((r) => r.id === r1.data.id);
  const wdKey = await fileKey(contractor, r1.data.id);
  const wdAgain = await withdraw(contractor, r1.data.id, "Encore");
  record("Retrait : reçu toujours listé (retiré, motif, rôle), fichier plus délivré, retrait unique", !wd.error && wdRow?.withdrawn && wdRow?.withdraw_reason === "Photo floue" && wdRow?.withdrawn_by_role === "SITE_MANAGER" && wdKey.error?.message === "receipt_withdrawn" && !!wdAgain.error, `${err(wd)} / ${err(wdKey)} / ${err(wdAgain)}`);

  // Décision du fondateur (boucle 25b) : un reçu retiré n'est jamais supprimé du stockage.
  const kept = await service.storage.from(BUCKET).download(r1.key);
  const keptHash = kept.data ? sha(Buffer.from(await kept.data.arrayBuffer())) : null;
  const keptUpload = (await service.from("private_object_uploads").select("status, storage_key").eq("id", r1.data.private_object_upload_id).single()).data;
  const { count: staleKeys } = await service.from("private_object_stale_keys").select("id", { count: "exact", head: true }).eq("private_object_upload_id", r1.data.private_object_upload_id).eq("storage_key", r1.key);
  const smWdKey = await fileKey(sm, r1.data.id);
  record("Reçu retiré : fichier conservé en stockage (contenu identique, envoi FINALIZED, jamais mis au nettoyage) mais plus délivré à personne", keptHash === sha(r1.bytes) && keptUpload?.status === "FINALIZED" && keptUpload?.storage_key === r1.key && staleKeys === 0 && smWdKey.error?.message === "receipt_withdrawn", `${keptUpload?.status} / nettoyage ${staleKeys} / ${err(smWdKey)}`);

  // 5. Dépense refusée : plus aucun dépôt ni retrait.
  const refused = (await contractor.client.rpc("decide_expense", { p_expense_id: smSub.id, p_expected_revision: (await fresh(smSub.id)).revision, p_decision: "REFUSEE", p_reason: "Hors budget" })).data;
  const onRefused = await attach(contractor, refused.id, PDF("tardif"));
  const wdRefused = await withdraw(contractor, r2.data.id, "Tardif");
  const readRefused = await fileKey(sm, r2.data.id);
  record("Refusée : dépôt et retrait refusés ; reçu toujours lisible", onRefused.error?.message === "not_authorized" && wdRefused.error?.message === "not_authorized" && !readRefused.error, `${err(onRefused)} / ${err(wdRefused)} / ${err(readRefused)}`);

  // 6. Justification d'un reçu absent (F5 C).
  const p0 = await policy(sm);
  const p0c = await policy(contractor);
  record("F5 C : réglage désactivé par défaut ; modifiable par l'entreprise seule", one(p0.data)?.require_no_receipt_justification === false && one(p0.data)?.can_change === false && one(p0c.data)?.can_change === true, err(p0));
  const smSet = await setPolicy(sm, true, 0);
  record("Chef de chantier : ne modifie pas le réglage", smSet.error?.message === "not_authorized", err(smSet));
  const noRecDefault = (await submit(sm, (await save(sm, { amount: "40000" })).data));
  record("Réglage désactivé : envoi sans reçu ni justification accepté", !noRecDefault.error && noRecDefault.data.status === "SOUMISE", err(noRecDefault));
  const stalePol = await setPolicy(contractor, true, 3);
  const on = await setPolicy(contractor, true, 0);
  const same = await setPolicy(contractor, true, 1);
  record("Entreprise : active le réglage (révision vérifiée, sans changement refusé)", stalePol.error?.message === "revision_conflict" && !on.error && on.data.require_no_receipt_justification === true && same.error?.message === "no_change", `${err(stalePol)} / ${err(on)} / ${err(same)}`);
  const bare = (await save(sm, { amount: "41000" })).data;
  const bareSub = await submit(sm, bare);
  record("Réglage actif : envoi sans reçu ni justification refusé", bareSub.error?.message === "receipt_justification_required", err(bareSub));
  const justified = (await save(sm, { id: bare.id, rev: bare.revision, amount: "41000", justification: "Achat au marché, pas de facture" })).data;
  const justSub = await submit(sm, justified);
  const justRow = (await sm.client.rpc("list_project_expenses", { p_project_id: pid })).data?.find((e) => e.id === bare.id);
  record("Réglage actif : envoi avec justification accepté, justification figée et affichée", !justSub.error && justRow?.no_receipt_reason === "Achat au marché, pas de facture" && justRow?.receipt_count === 0, err(justSub));
  const withRec = (await save(sm, { amount: "42000" })).data;
  const r4 = await attach(sm, withRec.id, PDF("avec-recu"));
  const withRecSub = await submit(sm, await fresh(withRec.id));
  record("Réglage actif : envoi avec un reçu, sans justification, accepté", !r4.error && !withRecSub.error, `${err(r4)} / ${err(withRecSub)}`);
  const lastWd = await withdraw(sm, r4.data.id, "Erreur de fichier");
  record("Réglage actif : retrait du dernier reçu d'une dépense envoyée sans justification refusé", lastWd.error?.message === "receipt_justification_required", err(lastWd));
  // Correction par l'entreprise d'une dépense approuvée sans reçu.
  const ctBare = (await submit(contractor, (await save(contractor, { amount: "50000", justification: "Paiement en espèces" })).data)).data;
  const corrArgs = (justification) => ({ p_expense_id: ctBare.id, p_expected_revision: ctBare.revision, p_reason: "Montant corrigé", p_amount_fcfa: "55000", p_expense_date: "2026-10-06", p_category: "MATERIAUX", p_supplier: "Quincaillerie", p_note: null, p_phase_id: null, p_no_receipt_reason: justification });
  const corrBare = await contractor.client.rpc("correct_expense", corrArgs(null));
  const corrJust = await contractor.client.rpc("correct_expense", corrArgs("Paiement en espèces"));
  record("Réglage actif : correction sans reçu exige la justification", corrBare.error?.message === "receipt_justification_required" && !corrJust.error && corrJust.data.no_receipt_reason === "Paiement en espèces", `${err(corrBare)} / ${err(corrJust)}`);
  const off = await setPolicy(contractor, false, 1);
  const offSub = await submit(sm, (await save(sm, { amount: "43000" })).data);
  record("Réglage désactivé de nouveau : envoi sans justification accepté (non rétroactif, rien d'autre modifié)", !off.error && !offSub.error, `${err(off)} / ${err(offSub)}`);

  // 7. Gardes (même service_role).
  const g1 = await service.from("expense_receipts").update({ mime_type: "image/png" }).eq("id", r3.data.id);
  const g2 = await service.from("expense_receipts").delete().eq("id", r3.data.id);
  const g3 = await service.from("expense_receipts").update({ withdrawn_at_server: null, withdrawn_by_profile_id: null, withdrawn_by_role: null, withdraw_reason: null }).eq("id", r1.data.id);
  const g4 = await service.from("expense_receipt_upload_targets").delete().eq("private_object_upload_id", r3.data.private_object_upload_id);
  const g5 = await service.from("expenses").update({ draft_no_receipt_reason: "après coup" }).eq("id", bare.id);
  record("Reçu jamais modifié ni supprimé ; retrait irréversible ; cible figée ; justification figée après l'envoi", [g1, g2, g3, g4].every((r) => r.error?.message === "expense_record_immutable") && g5.error?.message === "expense_immutable", [g1, g2, g3, g4, g5].map(err).join(" / "));
  const { data: auditRows } = await service.from("audit_events").select("action").eq("project_id", pid).like("action", "EXPENSE_RECEIPT_%");
  const acts = new Set((auditRows ?? []).map((a) => a.action));
  record("Audit : dépôt, retrait et réglage tracés", ["EXPENSE_RECEIPT_ATTACHED", "EXPENSE_RECEIPT_WITHDRAWN", "EXPENSE_RECEIPT_POLICY_SET"].every((a) => acts.has(a)), [...acts].join(", "));

  // 8. Confidentialité : fonctions.
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", exMember.id);
  const calls = (u) => [
    receipts(u, ctExp.id), fileKey(u, r3.data.id), withdraw(u, r3.data.id, "Tentative"), policy(u), setPolicy(u, true, 2),
    u.client.rpc("prepare_expense_receipt_upload", { p_operation_uuid: randomUUID(), p_expense_id: ctExp.id, p_expected_checksum: "a".repeat(64), p_expected_size_bytes: 10, p_expected_mime_type: "application/pdf" }),
    u.client.rpc("finalize_expense_receipt_upload", { p_operation_uuid: r3.op }),
    u.client.rpc("get_upload_status", { p_operation_uuid: r3.op }),
    u.client.rpc("claim_upload_attempt", { p_operation_uuid: r3.op }),
  ];
  for (const u of [owner, coOwner, exMember, outsider]) {
    const rs = await Promise.all(calls(u));
    record(`${u.label} : les 9 appels des reçus refusés, aucune donnée`, rs.every((r) => !!r.error && !r.data) && rs.slice(0, 7).every((r) => r.error.message === "not_authorized"), rs.map(err).join(" / "));
  }
  const an = await Promise.all(calls(anon));
  record("Visiteur sans session : les 9 appels refusés", an.every((r) => !!r.error && !r.data), an.map(err).join(" / "));

  // 9. Confidentialité : tables et audit.
  for (const u of [contractor, sm, owner, coOwner, exMember, outsider, anon]) {
    const t = await Promise.all(["expense_receipts", "project_expense_settings", "expense_receipt_upload_targets"].map((tb) => u.client.from(tb).select("*").limit(1)));
    record(`${u.label} : tables des reçus et du réglage refusées en lecture directe`, t.every((r) => !!r.error && !r.data), t.map((r) => r.error?.code).join("/"));
  }
  for (const u of [sm, owner, coOwner, exMember, outsider]) {
    const a = await u.client.from("audit_events").select("id").eq("project_id", pid);
    record(`${u.label} : aucune ligne d'audit (reçus compris)`, !a.error && a.data.length === 0, err(a));
  }
  const ctAudit = await contractor.client.from("audit_events").select("action").eq("project_id", pid).like("action", "EXPENSE_RECEIPT_%");
  record("Témoin : l'entreprise lit l'audit des reçus", !ctAudit.error && ctAudit.data.length > 0, err(ctAudit));

  // 10. Surfaces lisibles par le propriétaire : aucune trace d'un reçu.
  const surfaces = [
    ["synthèse financière", (u) => u.client.rpc("get_project_financial_summary", { p_project_id: pid })],
    ["fiche chantier", (u) => u.client.from("projects").select("*").eq("id", pid)],
    ["documents", (u) => u.client.rpc("list_project_documents", { p_project_id: pid })],
    ["photos", (u) => u.client.rpc("list_project_media", { p_project_id: pid })],
    ["versements", (u) => u.client.rpc("list_advance_payments", { p_project_id: pid })],
    ["historique des étapes", (u) => u.client.rpc("list_phase_event_details", { p_project_id: pid })],
  ];
  for (const u of [owner, coOwner]) {
    const leaks = [];
    for (const [name, call] of surfaces) {
      const r = await call(u);
      const txt = JSON.stringify(r.data ?? null) + JSON.stringify(r.error ?? null);
      if (/expense|receipt|reçu|justificati/i.test(txt) || [r1, r2, r3, r4].some((x) => txt.includes(x.data.id) || txt.includes(x.key))) leaks.push(name);
    }
    record(`${u.label} : aucune des ${surfaces.length} surfaces lisibles ne mentionne un reçu`, leaks.length === 0, leaks.join(", ") || "aucune fuite");
  }

  // 11. Accès retiré : le chef perd la lecture de tous les reçus.
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", sm.id);
  const smRev = await Promise.all([receipts(sm, ctExp.id), fileKey(sm, r3.data.id), fileKey(sm, r4.data.id), attach(sm, withRec.id, PDF("apres-retrait"))]);
  record("Chef de chantier dont l'accès est retiré : liste, clés et dépôt refusés", smRev.every((r) => r.error?.message === "not_authorized"), smRev.map(err).join(" / "));
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
