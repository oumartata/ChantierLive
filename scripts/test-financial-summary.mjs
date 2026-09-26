// Test d'intégration LOCAL uniquement pour B068 (M028 : synthèse financière
// consolidée). Risques couverts : montant contractuel (BR094) et valeurs NULL
// sans devis accepté (D142), répartition DECLARED/RECEIVED/DISPUTED/CANCELLED
// sans double comptage (BR112), solde signé, reste dû, trop-perçu, instantané
// du démarrage distinct du déficit courant, droits (D140), confidentialité
// (liste exacte des clés), cohérence avant/après une confirmation concurrente
// validée.
//
// Usage : node scripts/test-financial-summary.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const { hostname } = new URL(SUPABASE_URL);
if (hostname !== "127.0.0.1" && hostname !== "localhost") {
  console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`);
  process.exit(1);
}
if (!SERVICE_KEY || !ANON_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY manquants.");
  process.exit(1);
}
const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail !== undefined ? " — " + detail : ""}`);
}
const err = (res) => res.error?.message ?? "aucune erreur";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function createTestUser(label) {
  const email = `b068-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, email: email.toLowerCase(), client };
}
async function setVerified(profileId, verified) {
  const { error } = await service.from("profile_identifiers").update({ verified_at_server: verified ? new Date().toISOString() : null }).eq("profile_id", profileId);
  if (error) throw new Error(`setVerified: ${error.message}`);
}
function psql(sql) {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", ["exec", "-i", "supabase_db_ChantierLive", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`psql exit ${code}: ${stderr}`))));
    proc.stdin.write(sql);
    proc.stdin.end();
  });
}
// Exécute un SQL privilégié et renvoie le message d'erreur (chaîne vide si succès).

async function must(res, what) {
  const r = await res;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}
async function deposit(client, projectId, label) {
  const bytes = Buffer.from(`%PDF-1.4 ${label}`);
  const op = randomUUID();
  const prep = await must(client.rpc("prepare_project_plan_upload", { p_operation_uuid: op, p_project_id: projectId, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "prepare");
  const claim = await must(client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "claim");
  await must(service.storage.from("project-plans").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "upload");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "attest");
  return must(client.rpc("finalize_project_plan_upload", { p_operation_uuid: op }), "finalize");
}
const project = async (id) => (await service.from("projects").select("revision").eq("id", id).single()).data;
const line = (label, quantity, price, unit = "u") => ({ label, unit, quantity, unit_price_fcfa: price });

// Chantier avec devis PROPOSÉ (plan retenu, validé, publié) ; accept() l'accepte.
async function quotedProject(tag, extra = {}) {
  const contractor = await createTestUser(`${tag}-contractor`);
  const owner = await createTestUser(`${tag}-owner`);
  const engineer = await createTestUser(`${tag}-engineer`);
  const { data: proj } = await contractor.client.rpc("create_draft_project", { p_name: `B068 — ${tag}`, p_country: "ML", p_role: "CONTRACTOR" });
  const { project_id: pid, organization_id: orgId } = Array.isArray(proj) ? proj[0] : proj;
  await must(service.from("project_memberships").insert({ project_id: pid, profile_id: owner.id, role: "OWNER", owner_profile: "PRIMARY" }), "owner");
  const others = {};
  for (const [key, role, op] of extra.members ?? []) {
    others[key] = await createTestUser(`${tag}-${key}`);
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: others[key].id, role, owner_profile: op }), key);
  }
  const designation = await must(contractor.client.rpc("designate_plan_engineer", { p_organization_id: orgId, p_identifier_kind: "EMAIL", p_identifier_value: engineer.email }), "designate");
  const plan = await deposit(owner.client, pid, `PLAN-${tag}`);
  await must(owner.client.rpc("set_retained_project_plan_version", { p_project_id: pid, p_version_id: plan.id, p_expected_revision: (await project(pid)).revision }), "retain");
  const val = await must(contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: plan.id, p_designation_id: designation.id }), "submit");
  await must(engineer.client.rpc("decide_plan_validation", { p_validation_id: val.id, p_decision: "VALIDATED", p_note: null }), "validate");
  await must(contractor.client.rpc("publish_project_plan_version", { p_project_id: pid, p_version_id: plan.id, p_expected_revision: (await project(pid)).revision }), "publish");
  const q = await must(contractor.client.rpc("create_quote_estimate", { p_project_id: pid, p_lines: [line("Gros œuvre", "1", "10000000", "forfait")], p_expected_revision: 0 }), "quote");
  const qRev = async () => (await service.from("quotes").select("revision").eq("project_id", pid).single()).data.revision;
  await must(contractor.client.rpc("propose_quote_version", { p_version_id: q.id, p_expected_revision: await qRev() }), "propose quote");
  const accept = async () => must(owner.client.rpc("decide_quote_version", { p_version_id: q.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: await qRev() }), "accept quote");
  return { pid, contractor, owner, quoteVersionId: q.id, accept, ...others };
}


const ledger = async (pid) => (await service.from("advance_ledgers").select("*").eq("project_id", pid).maybeSingle()).data;
const rev = async (pid) => (await ledger(pid))?.revision ?? 0;
const one = (r) => ({ ...r, row: Array.isArray(r.data) ? r.data[0] : r.data });
const setReq = (client, pid, amount, revision, op = randomUUID()) =>
  client.rpc("set_advance_requirement", { p_operation_uuid: op, p_project_id: pid, p_amount_fcfa: amount, p_expected_revision: revision }).then(one);
const today = new Date().toISOString().slice(0, 10);
const declare = (client, pid, amount, revision, op = randomUUID(), extra = {}) =>
  client.rpc("declare_advance_payment", {
    p_operation_uuid: op, p_project_id: pid, p_amount_fcfa: amount, p_payment_date: extra.date ?? today, p_mode: extra.mode ?? "ORANGE_MONEY",
    p_reference: extra.reference ?? null, p_disclaimer_ack: extra.ack ?? true, p_expected_revision: revision,
  }).then(one);
const act = (fn, client, advanceId, revision, op = randomUUID(), reason) =>
  client.rpc(fn, { p_operation_uuid: op, p_advance_id: advanceId, p_expected_revision: revision, ...(fn === "confirm_advance_payment" ? {} : { p_reason: reason }) }).then(one);
const confirm = (c, a, r, op) => act("confirm_advance_payment", c, a, r, op);
const dispute = (c, a, r, reason = "Paiement non reçu", op) => act("dispute_advance_payment", c, a, r, op, reason);

const authorize = (client, pid, revision, op = randomUUID()) =>
  client.rpc("authorize_work_start", { p_operation_uuid: op, p_project_id: pid, p_expected_revision: revision }).then(one);
const wsRow = async (pid) => (await service.from("work_start_authorizations").select("*").eq("project_id", pid).maybeSingle()).data;
const revoke = (pid, profileId) => must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", profileId).is("revoked_at", null), "revoke");
const membershipId = async (pid, profileId) => (await service.from("project_memberships").select("id").eq("project_id", pid).eq("profile_id", profileId).is("revoked_at", null).single()).data.id;

// Chantier prêt : devis accepté, avance 1 000 000 déclarée par le client et confirmée.
async function readyProject(tag, extra) {
  const P = await quotedProject(tag, extra);
  await P.accept();
  await must(setReq(P.contractor.client, P.pid, "1000000", 0).then((r) => r), "setReq");
  const d = await declare(P.owner.client, P.pid, "1000000", await rev(P.pid));
  if (d.error) throw new Error(`declare: ${d.error.message}`);
  const c = await confirm(P.contractor.client, d.row.advance_id, await rev(P.pid));
  if (c.error) throw new Error(`confirm: ${c.error.message}`);
  return { ...P, advanceId: d.row.advance_id };
}
// Retarde (ou fait échouer) l'audit d'une action sur un chantier donné :
// la transaction reste ouverte, ses écritures non validées.
const installDelayOn = (name, table, cond, seconds, fail = false) =>
  psql(`create or replace function public.${name}() returns trigger language plpgsql as $f$ begin if ${cond} then perform pg_sleep(${seconds}); ${fail ? "raise exception 'forced_failure';" : ""} end if; return new; end $f$;
create trigger ${name} after insert on public.${table} for each row execute function public.${name}();\n`);
const installDelay = (name, action, pid, seconds, fail = false) =>
  installDelayOn(name, "audit_events", `new.action = '${action}' and new.project_id = '${pid}'`, seconds, fail);
const dropDelay = (name, table = "audit_events") => psql(`drop trigger if exists ${name} on public.${table}; drop function if exists public.${name}();\n`);


const cancel = (c, a, r, reason = "Erreur de saisie", op) => act("cancel_advance_payment", c, a, r, op, reason);
const summary = async (client, pid) => one(await client.rpc("get_project_financial_summary", { p_project_id: pid }));
const coRev = async (versionId) => {
  const v = (await service.from("change_order_versions").select("change_order_id").eq("id", versionId).single()).data;
  return (await service.from("change_orders").select("revision").eq("id", v.change_order_id).single()).data.revision;
};
// Avenant chiffré : ESTIMATE -> PROPOSED -> décision éventuelle (B066).
async function changeOrder(P, total, decision) {
  const d = await must(P.contractor.client.rpc("create_change_order_estimate", { p_project_id: P.pid, p_change_order_id: null, p_title: `Avenant ${total}`, p_reason: "Demande du client", p_lines: [line("Supplément", "1", total)], p_expected_revision: 0 }), "avenant");
  await must(P.contractor.client.rpc("propose_change_order_version", { p_version_id: d.id, p_expected_revision: await coRev(d.id) }), "proposition avenant");
  if (decision) await must(P.owner.client.rpc("decide_change_order_version", { p_version_id: d.id, p_decision: decision, p_reason: decision === "REFUSED" ? "Hors budget" : null, p_expected_revision: await coRev(d.id) }), "décision avenant");
  return d.id;
}
async function paid(P, amount, status) {
  const d = await declare(P.owner.client, P.pid, amount, await rev(P.pid));
  if (d.error) throw new Error(`declare: ${d.error.message}`);
  const id = d.row.advance_id;
  if (status === "RECEIVED" || status === "DISPUTED") await must(confirm(P.contractor.client, id, await rev(P.pid)).then((r) => r), "confirm");
  if (status === "DISPUTED") await must(dispute(P.contractor.client, id, await rev(P.pid)).then((r) => r), "dispute");
  if (status === "CANCELLED") await must(cancel(P.owner.client, id, await rev(P.pid)).then((r) => r), "cancel");
  return id;
}
const KEYS = ["accepted_change_order_count", "balance_fcfa", "cancelled_count", "change_orders_amount_fcfa", "contract_amount_fcfa", "current_advance_shortfall_fcfa",
  "disputed_count", "disputed_fcfa", "overpaid_fcfa", "pending_count", "pending_fcfa", "quote_amount_fcfa", "recognized_count", "recognized_fcfa", "remaining_due_fcfa",
  "start_advance_recognized_fcfa", "start_advance_required_fcfa", "start_contract_amount_fcfa", "work_start_at", "work_start_authorized"];
// Invariants internes d'une lecture (valeurs liées d'un même instantané).
const coherent = (s, total) => {
  const counts = s.recognized_count + s.pending_count + s.disputed_count + s.cancelled_count;
  if (total !== undefined && counts !== total) return false;
  if (s.contract_amount_fcfa === null) return s.balance_fcfa === null && s.remaining_due_fcfa === null && s.overpaid_fcfa === null;
  const bal = BigInt(s.contract_amount_fcfa) - BigInt(s.recognized_fcfa);
  return BigInt(s.contract_amount_fcfa) === BigInt(s.quote_amount_fcfa) + BigInt(s.change_orders_amount_fcfa) && BigInt(s.balance_fcfa) === bal &&
    BigInt(s.remaining_due_fcfa) === (bal > 0n ? bal : 0n) && BigInt(s.overpaid_fcfa) === (bal < 0n ? -bal : 0n);
};
const advCount = async (pid) => (await service.from("advances").select("id").eq("project_id", pid)).data.length;

async function main() {
  // 1. Sans devis accepté : NULL préservés, aucun zéro de substitution (D142).
  const N = await quotedProject("noquote", { members: [["coOwner", "OWNER", "CO_OWNER"], ["siteManager", "SITE_MANAGER", null]] });
  const s1 = await summary(N.owner.client, N.pid);
  record("1. Sans devis accepté — contrat, devis, avenants, solde, reste dû et trop-perçu NULL (aucun 0)",
    !s1.error && ["quote_amount_fcfa", "change_orders_amount_fcfa", "accepted_change_order_count", "contract_amount_fcfa", "balance_fcfa", "remaining_due_fcfa", "overpaid_fcfa"].every((k) => s1.row[k] === null), JSON.stringify(s1.row));
  record("1. Sans devis accepté — aucun versement (0 reconnu), démarrage non autorisé, déficit courant non applicable (NULL)",
    s1.row.recognized_fcfa === "0" && s1.row.recognized_count === 0 && s1.row.work_start_authorized === false && s1.row.current_advance_shortfall_fcfa === null && s1.row.start_contract_amount_fcfa === null);
  record("1. Réponse — liste exacte des clés (aucun budget, dépense ni contact)", same(Object.keys(s1.row).sort(), KEYS), Object.keys(s1.row).sort().join(","));

  // 2. Droits (D140).
  for (const [label, u] of [["OWNER/PRIMARY", N.owner], ["CO_OWNER", N.coOwner], ["CONTRACTOR", N.contractor]]) {
    const r = await summary(u.client, N.pid);
    record(`2. Lecture autorisée — ${label}`, !r.error, err(r));
  }
  const outsider = await createTestUser("outsider");
  for (const [label, u] of [["SITE_MANAGER", N.siteManager], ["tiers", outsider]]) {
    const r = await summary(u.client, N.pid);
    record(`2. Lecture refusée — ${label} (not_authorized)`, r.error?.message === "not_authorized" && !r.row, err(r));
  }
  await setVerified(N.coOwner.id, false);
  const prov = await summary(N.coOwner.client, N.pid);
  await setVerified(N.coOwner.id, true);
  record("2. Compte provisoire — account_provisional", prov.error?.message === "account_provisional", err(prov));
  await revoke(N.pid, N.coOwner.id);
  const rev2 = await summary(N.coOwner.client, N.pid);
  record("2. Adhésion révoquée — not_authorized", rev2.error?.message === "not_authorized", err(rev2));
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const an = await anon.rpc("get_project_financial_summary", { p_project_id: N.pid });
  record("2. Anonyme — refusé", !!an.error, err(an));

  // 3. Devis accepté, avenants, répartition des statuts.
  const P = await quotedProject("main", { members: [["coOwner", "OWNER", "CO_OWNER"]] });
  await P.accept();
  const s3 = await summary(P.contractor.client, P.pid);
  record("3. Devis accepté seul — contrat 10 000 000, avenants 0 (0 accepté), reste dû 10 000 000, trop-perçu 0",
    s3.row.quote_amount_fcfa === "10000000" && s3.row.change_orders_amount_fcfa === "0" && s3.row.accepted_change_order_count === 0 && s3.row.contract_amount_fcfa === "10000000" &&
    s3.row.balance_fcfa === "10000000" && s3.row.remaining_due_fcfa === "10000000" && s3.row.overpaid_fcfa === "0" && coherent(s3.row, 0), JSON.stringify(s3.row));
  await changeOrder(P, "500000", "ACCEPTED");
  await changeOrder(P, "700000", "REFUSED");
  await changeOrder(P, "900000", null);
  const s3b = await summary(P.owner.client, P.pid);
  const ca = one(await P.owner.client.rpc("get_contract_amount", { p_project_id: P.pid }));
  record("3. Avenant accepté compté (500 000) ; refusé (700 000) et en attente (900 000) exclus — contrat 10 500 000, identique à get_contract_amount",
    s3b.row.change_orders_amount_fcfa === "500000" && s3b.row.accepted_change_order_count === 1 && s3b.row.contract_amount_fcfa === "10500000" && ca.row.contract_amount_fcfa === "10500000", JSON.stringify(ca.row));
  await must(setReq(P.contractor.client, P.pid, "1000000", await rev(P.pid)).then((r) => r), "avance");
  await paid(P, "300000", "DECLARED");
  await paid(P, "200000", "RECEIVED");
  await paid(P, "100000", "DISPUTED");
  await paid(P, "50000", "CANCELLED");
  const s3c = await summary(P.coOwner.client, P.pid);
  const st = one(await P.coOwner.client.rpc("get_advance_status", { p_project_id: P.pid }));
  record("3. Une seule catégorie par état — reconnu 1 (200 000), en attente 1 (300 000), contesté 1 (100 000), annulé 1 ; total des compteurs = 4 versements",
    s3c.row.recognized_count === 1 && s3c.row.recognized_fcfa === "200000" && s3c.row.pending_count === 1 && s3c.row.pending_fcfa === "300000" &&
    s3c.row.disputed_count === 1 && s3c.row.disputed_fcfa === "100000" && s3c.row.cancelled_count === 1 && coherent(s3c.row, await advCount(P.pid)), JSON.stringify(s3c.row));
  record("3. Seuls les versements RECEIVED sont additionnés — solde 10 300 000 = 10 500 000 − 200 000 ; somme identique à get_advance_status",
    s3c.row.balance_fcfa === "10300000" && s3c.row.remaining_due_fcfa === "10300000" && s3c.row.overpaid_fcfa === "0" && st.row.recognized_sum_fcfa === "200000");

  // 4. Solde nul puis trop-perçu (D142, D129).
  await paid(P, "10300000", "RECEIVED");
  const s4a = await summary(P.owner.client, P.pid);
  record("4. Solde nul — reste dû 0, trop-perçu 0, solde 0", s4a.row.balance_fcfa === "0" && s4a.row.remaining_due_fcfa === "0" && s4a.row.overpaid_fcfa === "0" && coherent(s4a.row), JSON.stringify(s4a.row));
  await paid(P, "250000", "RECEIVED");
  const s4b = await summary(P.owner.client, P.pid);
  record("4. Trop-perçu — solde −250 000, reste dû 0, trop-perçu 250 000 (aucun remboursement)",
    s4b.row.balance_fcfa === "-250000" && s4b.row.remaining_due_fcfa === "0" && s4b.row.overpaid_fcfa === "250000" && coherent(s4b.row, await advCount(P.pid)), JSON.stringify(s4b.row));

  // 5. Démarrage : valeurs historiques vs déficit courant.
  const W = await readyProject("start", { members: [["coOwner", "OWNER", "CO_OWNER"]] });
  const s5a = await summary(W.owner.client, W.pid);
  record("5. Avant autorisation — valeurs historiques NULL, déficit courant non applicable (NULL)",
    s5a.row.work_start_authorized === false && s5a.row.work_start_at === null && s5a.row.start_advance_required_fcfa === null && s5a.row.current_advance_shortfall_fcfa === null);
  await must(authorize(W.contractor.client, W.pid, await rev(W.pid)).then((r) => r), "autorisation");
  const s5b = await summary(W.owner.client, W.pid);
  record("5. Après autorisation — historique 10 000 000 / 1 000 000 / 1 000 000, déficit courant 0",
    s5b.row.work_start_authorized === true && s5b.row.start_contract_amount_fcfa === "10000000" && s5b.row.start_advance_required_fcfa === "1000000" &&
    s5b.row.start_advance_recognized_fcfa === "1000000" && s5b.row.current_advance_shortfall_fcfa === "0" && new Date(s5b.row.work_start_at).getTime() === new Date((await wsRow(W.pid)).authorized_at_server).getTime());
  await changeOrder(W, "400000", "ACCEPTED");
  await must(dispute(W.contractor.client, W.advanceId, await rev(W.pid)).then((r) => r), "contestation");
  const s5c = await summary(W.coOwner.client, W.pid);
  const g5 = one(await W.coOwner.client.rpc("get_work_start", { p_project_id: W.pid }));
  record("5. Avenant après démarrage + contestation — contrat courant 10 400 000, historique inchangé (10 000 000), déficit courant 1 000 000 = get_work_start",
    s5c.row.contract_amount_fcfa === "10400000" && s5c.row.start_contract_amount_fcfa === "10000000" && s5c.row.start_advance_recognized_fcfa === "1000000" &&
    s5c.row.current_advance_shortfall_fcfa === "1000000" && g5.row.deficit_fcfa === "1000000" && s5c.row.recognized_fcfa === "0", JSON.stringify(s5c.row));

  // 6. Transfert du rôle CONTRACTOR : l'ancien titulaire (devenu SITE_MANAGER) perd la lecture.
  const chef = await createTestUser("chef");
  await must(service.from("project_memberships").insert({ project_id: W.pid, profile_id: chef.id, role: "SITE_MANAGER", owner_profile: null }), "chef");
  await must(W.contractor.client.rpc("transfer_contractor_role", { p_project_id: W.pid, p_successor_membership_id: await membershipId(W.pid, chef.id), p_reason: "Changement d'entreprise" }), "transfert");
  const old6 = await summary(W.contractor.client, W.pid);
  const new6 = await summary(chef.client, W.pid);
  record("6. Après transfert — ancien CONTRACTOR refusé, successeur autorisé (rôle courant)", old6.error?.message === "not_authorized" && !new6.error, `${err(old6)} / ${err(new6)}`);

  // 7. Cohérence : confirmation concurrente réellement validée.
  const C = await quotedProject("coherence");
  await C.accept();
  await must(setReq(C.contractor.client, C.pid, "1000000", 0).then((r) => r), "avance");
  const d7 = await declare(C.owner.client, C.pid, "400000", await rev(C.pid));
  const before = (await summary(C.owner.client, C.pid)).row;
  await installDelay("b068_slow_confirm", "ADVANCE_CONFIRMED", C.pid, 3);
  let during, conf;
  try {
    const pConf = confirm(C.contractor.client, d7.row.advance_id, await rev(C.pid)).then((r) => r);
    await sleep(1200);
    during = (await summary(C.owner.client, C.pid)).row;
    conf = await pConf;
  } finally { await dropDelay("b068_slow_confirm"); }
  const after = (await summary(C.owner.client, C.pid)).row;
  record("7. Pendant la confirmation non validée — lecture identique à l'état validé précédent (aucune donnée non validée)", same(during, before), JSON.stringify(during));
  record("7. Avant — en attente 1 (400 000), reconnu 0, solde 10 000 000, invariants cohérents",
    before.pending_count === 1 && before.pending_fcfa === "400000" && before.recognized_count === 0 && before.recognized_fcfa === "0" && before.balance_fcfa === "10000000" && coherent(before, 1));
  record("7. Après validation — reconnu 1 (400 000), en attente 0, solde et reste dû 9 600 000 : valeurs liées toutes mises à jour ensemble",
    !conf.error && after.recognized_count === 1 && after.recognized_fcfa === "400000" && after.pending_count === 0 && after.pending_fcfa === "0" &&
    after.balance_fcfa === "9600000" && after.remaining_due_fcfa === "9600000" && coherent(after, 1), `${err(conf)} ${JSON.stringify(after)}`);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} vérifications réussies`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
