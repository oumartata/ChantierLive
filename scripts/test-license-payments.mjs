// Test d'intégration LOCAL uniquement : M048, déclaration de paiement de
// licence (B048 ; done_when « preuve et statut PENDING_REVIEW » ; D193 L1 à
// L9 ; D004 : le paiement ne donne aucun droit). Données jetables créées par
// ce script. Le stockage direct et les chemins forgés sont couverts par
// scripts/test-file-cross-access.mjs.
//
// Usage : node --env-file=.env.local scripts/test-license-payments.mjs

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const local = (() => { try { const { hostname } = new URL(SUPABASE_URL); return hostname === "127.0.0.1" || hostname === "localhost"; } catch { return false; } })();
if (!local) { console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`); process.exit(1); }
if (!SERVICE_KEY || !ANON_KEY) { console.error("Clés locales manquantes."); process.exit(1); }

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const BUCKET = "license-proofs";
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const err = (r) => r?.error?.message ?? r?.error?.code ?? "aucune erreur";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const one = (d) => (Array.isArray(d) ? d[0] : d);
async function must(res, what) { const r = await res; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; }
async function user(label) {
  const email = `m048-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client, label };
}
function sniff(b) {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}
const PDF = (label) => Buffer.from(`%PDF-1.4 M048 ${label} ${randomUUID()}`);
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const outsider = await user("hors-chantier");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  const created = await must(contractor.client.rpc("create_draft_project", { p_name: "M048 — licence de test", p_country: "ML", p_role: "CONTRACTOR" }), "projet");
  const pid = one(created).project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  // Instantané des droits AVANT toute déclaration (AC142).
  const rightsSnapshot = async () => JSON.stringify({
    memberships: (await service.from("project_memberships").select("profile_id, role, owner_profile, revoked_at").eq("project_id", pid).order("profile_id")).data,
    permissions: (await service.from("membership_permissions").select("*").order("id")).data?.filter((p) => JSON.stringify(p).includes(pid)) ?? [],
    organizations: (await service.from("organization_memberships").select("*").in("profile_id", [owner.id, contractor.id]).order("profile_id")).data ?? [],
  });
  const rightsBefore = await rightsSnapshot();

  const base = { amount: "100000", operator: "ORANGE_MONEY", reference: "MP231008.1530.C12345", paidOn: yesterday, payer: null, ack: true };
  async function declare(u, overrides = {}, bytes = PDF("preuve"), declared = "application/pdf") {
    const f = { ...base, ...overrides };
    const op = randomUUID();
    const prep = await u.client.rpc("prepare_license_payment_upload", {
      p_operation_uuid: op, p_project_id: pid, p_amount_fcfa: f.amount, p_operator: f.operator, p_payment_reference: f.reference,
      p_paid_on: f.paidOn, p_payer_name: f.payer, p_disclaimer_ack: f.ack,
      p_expected_checksum: sha(bytes), p_expected_size_bytes: f.size ?? bytes.length, p_expected_mime_type: declared,
    });
    if (prep.error) return { stage: "prepare", error: prep.error };
    const claim = await u.client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.data.attempt_id });
    if (claim.error || !claim.data?.won) return { stage: "claim", error: claim.error ?? { message: "not_won" } };
    const w = await service.storage.from(BUCKET).upload(claim.data.candidate_key, bytes, { contentType: declared, upsert: false });
    if (w.error) return { stage: "write", error: w.error };
    const reread = Buffer.from(await (await service.storage.from(BUCKET).download(claim.data.candidate_key)).data.arrayBuffer());
    const att = await service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.data.attempt_id, p_actual_checksum: sha(reread), p_actual_size_bytes: reread.length, p_actual_mime_type: sniff(reread) ?? "application/octet-stream" });
    if (att.error) {
      const fin = await u.client.rpc("finalize_license_payment_upload", { p_operation_uuid: op });
      return { stage: "attest", error: att.error, finalizeError: fin.error };
    }
    const fin = await u.client.rpc("finalize_license_payment_upload", { p_operation_uuid: op });
    if (fin.error) return { stage: "finalize", error: fin.error };
    return { data: fin.data, key: claim.data.candidate_key, bytes };
  }
  const license = (u) => u.client.rpc("get_project_license", { p_project_id: pid });
  const mine = (u) => u.client.rpc("list_my_license_payments", { p_project_id: pid });
  const proofKey = (u, id) => u.client.rpc("get_license_proof_file_key", { p_payment_id: id });
  const cancel = (u, id, reason) => u.client.rpc("cancel_license_payment", { p_payment_id: id, p_reason: reason });

  // 1. Formule et prix (L2).
  const offer = one((await owner.client.rpc("get_license_offer")).data);
  record("Formule unique 12 mois, prix lu dans le réglage de plateforme, marqué « prix de démonstration »", offer?.duration_months === 12 && Number(offer?.price_fcfa) > 0 && offer?.price_is_demo === true && /12 mois/.test(offer?.label ?? ""), JSON.stringify(offer));
  const l0 = one((await license(sm)).data);
  record("Avant toute déclaration : état « aucune licence » visible du chef de chantier, sans montant", l0?.status === "NONE" && l0?.has_pending_declaration === false && l0?.can_declare === false && !("amount_fcfa" in (l0 ?? {})));

  // 2. Déclaration (done_when : preuve et statut PENDING_REVIEW).
  const dOwner = await declare(owner, { payer: "Awa Traoré" });
  record("Propriétaire principal : déclaration avec preuve, statut PENDING_REVIEW, formule et prix figés", !dOwner.error && dOwner.data.status === "PENDING_REVIEW" && dOwner.data.offer_duration_months === 12 && dOwner.data.offer_price_is_demo === true && dOwner.data.proof_mime_type === "application/pdf", dOwner.error ? `${dOwner.stage} ${err(dOwner)}` : "");
  const lic = (await service.from("project_licenses").select("status").eq("project_id", pid).single()).data;
  record("Licence du chantier : PENDING (rien n'est activé par une déclaration)", lic?.status === "PENDING", lic?.status);
  const dCt = await declare(contractor, { operator: "MOOV_MONEY", reference: "MV-2026-ABC-778" });
  record("Entreprise : deuxième déclaration possible (L8), elle aussi en PENDING_REVIEW", !dCt.error && dCt.data.status === "PENDING_REVIEW", dCt.error ? `${dCt.stage} ${err(dCt)}` : "");

  // 3. Le payeur ne gagne aucun droit (D004, BR082, AC142).
  record("Le payeur ne gagne aucun droit : adhésions, rôles, permissions et organisations identiques après les déclarations", (await rightsSnapshot()) === rightsBefore);
  const ownerExpense = await owner.client.rpc("list_project_expenses", { p_project_id: pid });
  const ownerBudget = await owner.client.rpc("get_internal_budget", { p_project_id: pid });
  record("Le propriétaire payeur n'accède toujours pas aux finances internes (D183)", ownerExpense.error?.message === "not_authorized" && ownerBudget.error?.message === "not_authorized", `${err(ownerExpense)} / ${err(ownerBudget)}`);

  // 4. Déclarants (L3) : copropriétaire, chef de chantier, non-membre refusés.
  for (const u of [coOwner, sm, outsider]) {
    const r = await declare(u);
    record(`${u.label} : déclaration refusée (not_authorized)`, r.stage === "prepare" && r.error?.message === "not_authorized", err(r));
  }
  const an = await declare(anon);
  record("Visiteur sans session : déclaration refusée", an.stage === "prepare" && !!an.error, err(an));

  // 5. Validations et données sensibles (L6, L7).
  for (const [label, overrides, code] of [
    ["sans accusé de l'avertissement", { ack: false }, "disclaimer_required"],
    ["montant nul", { amount: "0" }, "amount_out_of_bounds"],
    ["montant décimal", { amount: "100000.5" }, "invalid_amount"],
    ["opérateur inconnu", { operator: "VISA" }, "operator_invalid"],
    ["référence trop courte", { reference: "AB" }, "reference_invalid"],
    ["référence = numéro de téléphone", { reference: "+223 76 12 34 56" }, "sensitive_data_refused"],
    ["référence = numéro de carte", { reference: "4111 1111 1111 1111" }, "sensitive_data_refused"],
    ["référence = numéro de compte", { reference: "000123456789" }, "sensitive_data_refused"],
    ["nom du payeur avec un numéro", { payer: "Awa 76123456" }, "sensitive_data_refused"],
    ["date de paiement dans le futur", { paidOn: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) }, "paid_on_invalid"],
  ]) {
    const r = await declare(owner, overrides);
    record(`Refusé : ${label}`, r.stage === "prepare" && r.error?.message === code, err(r));
  }
  const { data: colRows } = await service.from("license_payments").select("*").eq("id", dOwner.data.id);
  const keys = Object.keys(colRows?.[0] ?? {});
  record("Aucun champ téléphone, carte, compte, IBAN ou code dans la déclaration", keys.length > 0 && !keys.some((k) => /phone|tel|msisdn|card|carte|account|compte|iban|pin|secret|cvv/i.test(k)), keys.join(","));

  // 6. Type réel de la preuve.
  const spoof = await declare(owner, {}, PDF("deguisee"), "image/png");
  record("Preuve : PDF déclaré PNG refusé à l'attestation, déclaration jamais créée", spoof.stage === "attest" && spoof.error?.message === "checksum_mismatch" && spoof.finalizeError?.message === "storage_not_verified", `${spoof.stage} ${err(spoof)}`);
  const html = await declare(owner, {}, Buffer.from("<html>faux</html>"), "image/jpeg");
  record("Preuve : HTML déclaré JPEG refusé", html.stage === "attest" && html.error?.message === "checksum_mismatch", `${html.stage} ${err(html)}`);
  const txt = await declare(owner, {}, Buffer.from("texte"), "text/plain");
  const big = await declare(owner, { size: 10485761 });
  record("Preuve : format texte et fichier de plus de 10 Mo refusés", txt.error?.message === "mime_type_required" && big.error?.message === "size_required", `${err(txt)} / ${err(big)}`);

  // 7. Preuve visible du seul déclarant (L4).
  const ok = await proofKey(owner, dOwner.data.id);
  const signed = await service.storage.from(BUCKET).createSignedUrl(one(ok.data).storage_key, 300);
  const body = Buffer.from(await (await fetch(signed.data.signedUrl)).arrayBuffer());
  record("Déclarant (propriétaire) : clé de sa preuve délivrée ; l'URL signée renvoie le contenu exact", !ok.error && sha(body) === sha(dOwner.bytes), err(ok));
  const ctOwn = await proofKey(contractor, dCt.data.id);
  record("Déclarant (entreprise) : clé de sa propre preuve délivrée", !ctOwn.error && one(ctOwn.data)?.storage_key === dCt.key, err(ctOwn));
  const refused = await Promise.all([proofKey(contractor, dOwner.data.id), proofKey(owner, dCt.data.id), proofKey(coOwner, dOwner.data.id), proofKey(sm, dOwner.data.id), proofKey(outsider, dOwner.data.id), proofKey(anon, dOwner.data.id)]);
  record("Preuve refusée à tout autre : entreprise (preuve du propriétaire), propriétaire (preuve de l'entreprise), copropriétaire, chef de chantier, non-membre, visiteur", refused.every((r) => !!r.error && !r.data) && refused.slice(0, 5).every((r) => r.error.message === "not_authorized"), refused.map(err).join(" / "));

  // 8. Déclarations : chacun voit les siennes ; état de la licence pour tous, sans montant.
  const lists = await Promise.all([mine(owner), mine(contractor), mine(coOwner), mine(sm)]);
  record("Chaque déclarant ne voit que ses déclarations ; copropriétaire et chef de chantier n'en voient aucune", lists[0].data?.length === 1 && lists[0].data[0].id === dOwner.data.id && lists[1].data?.length === 1 && lists[1].data[0].id === dCt.data.id && lists[2].data?.length === 0 && lists[3].data?.length === 0, lists.map((l) => l.data?.length ?? err(l)).join(" / "));
  for (const u of [owner, coOwner, contractor, sm]) {
    const r = one((await license(u)).data);
    record(`${u.label} : état de la licence visible (PENDING, déclaration en attente), sans montant ni preuve`, r?.status === "PENDING" && r?.has_pending_declaration === true && !JSON.stringify(r).match(/amount|fcfa|proof|storage|reference/i), JSON.stringify(r));
  }
  const outL = await license(outsider);
  const outM = await mine(outsider);
  record("Non-membre : ni état de la licence, ni déclarations", outL.error?.message === "not_authorized" && outM.error?.message === "not_authorized", `${err(outL)} / ${err(outM)}`);

  // 9. Annulation par le déclarant (L9).
  const otherCancels = await cancel(owner, dCt.data.id, "Pas la mienne");
  const noReason = await cancel(contractor, dCt.data.id, " ");
  record("Annulation : refusée à un autre que le déclarant, motif obligatoire", otherCancels.error?.message === "not_authorized" && noReason.error?.message === "reason_required", `${err(otherCancels)} / ${err(noReason)}`);
  const cancelled = await cancel(contractor, dCt.data.id, "Doublon : le propriétaire a déjà payé");
  const again = await cancel(contractor, dCt.data.id, "Encore");
  const stillListed = (await mine(contractor)).data?.find((p) => p.id === dCt.data.id);
  record("Annulation par le déclarant : CANCELLED avec motif, toujours listée, pas de seconde annulation", !cancelled.error && cancelled.data.status === "CANCELLED" && again.error?.message === "invalid_transition" && stillListed?.status === "CANCELLED" && stillListed?.cancel_reason === "Doublon : le propriétaire a déjà payé", err(cancelled));

  // 10. Gardes (même service_role) : rien n'est réécrit ni supprimé.
  const g = await Promise.all([
    service.from("license_payments").update({ amount_fcfa: 1 }).eq("id", dOwner.data.id),
    service.from("license_payments").update({ status: "PENDING_REVIEW", cancelled_at_server: null, cancel_reason: null }).eq("id", dCt.data.id),
    service.from("license_payments").delete().eq("id", dOwner.data.id),
    service.from("license_payment_upload_targets").delete().eq("project_id", pid),
    service.from("project_licenses").delete().eq("project_id", pid),
  ]);
  record("Service : montant réécrit, annulation défaite, suppressions refusés", g.every((r) => r.error?.message === "license_record_immutable"), g.map(err).join(" / "));

  // 11. Tables fermées ; audit lisible par l'entreprise seule (D186).
  for (const u of [owner, coOwner, contractor, sm, outsider]) {
    const t = await Promise.all(["license_payments", "project_licenses", "license_payment_upload_targets", "platform_settings"].map((tb) => u.client.from(tb).select("*").limit(1)));
    record(`${u.label} : tables de licence et réglage de plateforme refusés en lecture directe`, t.every((r) => r.error?.code === "42501"), t.map((r) => r.error?.code).join("/"));
  }
  const { data: auditRows } = await service.from("audit_events").select("action").eq("project_id", pid).like("action", "LICENSE_%");
  const ownerAudit = await owner.client.from("audit_events").select("id").eq("project_id", pid);
  record("Audit : déclarations et annulation tracées ; illisibles par le propriétaire", (auditRows ?? []).filter((a) => a.action === "LICENSE_PAYMENT_DECLARED").length === 2 && (auditRows ?? []).some((a) => a.action === "LICENSE_PAYMENT_CANCELLED") && !ownerAudit.error && ownerAudit.data.length === 0, (auditRows ?? []).map((a) => a.action).join(","));

  // 12. Déclarant dont l'accès est retiré : plus rien.
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", owner.id);
  const exCalls = await Promise.all([proofKey(owner, dOwner.data.id), mine(owner), license(owner), cancel(owner, dOwner.data.id, "Après retrait"), declare(owner)]);
  record("Déclarant dont l'accès est retiré : preuve, déclarations, état, annulation et nouvelle déclaration refusés", exCalls.every((r) => r.error?.message === "not_authorized"), exCalls.map(err).join(" / "));
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
