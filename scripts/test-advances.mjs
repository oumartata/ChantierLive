// Test d'intégration LOCAL uniquement pour B033 (M014 : acomptes déclaratifs
// et avance exigée). Risques couverts : droits des cinq profils (D126, D132,
// D133), avance exigée (D127, D128, D131), calculs sans double comptage et
// libellés (D129, D130), idempotence avec droits courants revérifiés et
// résultat séparé de l'état courant, collision d'operation_uuid entre
// chantiers, séquence transactionnelle sans trou, justificatifs (D134 :
// préparation, écriture, attestation des octets réels, finalisation atomique,
// lecture, reprise, nettoyage), isolation, attentes réelles, audit.
//
// Courses : chaque appel concurrent est ENVOYÉ (.then) avant la mutation
// testée (appels supabase-js paresseux).
//
// Usage : node scripts/test-advances.mjs

// Usage : node scripts/test-change-orders.mjs

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
  const email = `b033-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
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
const psqlError = (sql) => psql(sql).then(() => "", (e) => e.message);
const holdAdvisory = (projectId, seconds) =>
  psql(`begin;\nselect pg_advisory_xact_lock(hashtext('invitation_quota:${projectId}')::bigint);\nselect pg_sleep(${seconds});\ncommit;\n`);
async function callDuringRealWait(projectId, rpcCall, mutateDuringWait) {
  const blocker = holdAdvisory(projectId, 4);
  await sleep(700);
  const start = Date.now();
  const pending = rpcCall().then((r) => r);
  await sleep(1000);
  await mutateDuringWait();
  const res = await pending;
  const elapsed = Date.now() - start;
  await blocker;
  return { res, elapsed };
}

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
  const { data: proj } = await contractor.client.rpc("create_draft_project", { p_name: `B033 — ${tag}`, p_country: "ML", p_role: "CONTRACTOR" });
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
const seqs = async (pid) => (await service.from("advance_events").select("event_seq").eq("project_id", pid).order("event_seq")).data.map((e) => Number(e.event_seq));
const contiguous = (list) => list.every((v, i) => v === i + 1);
const one = (r) => ({ ...r, row: Array.isArray(r.data) ? r.data[0] : r.data });
const status = async (client, pid) => one(await client.rpc("get_advance_status", { p_project_id: pid }));
const advRow = async (id) => (await service.from("advances").select("*").eq("id", id).single()).data;
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
const cancel = (c, a, r, reason = "Erreur de saisie", op) => act("cancel_advance_payment", c, a, r, op, reason);
const advAudits = async (pid) => (await service.from("audit_events").select("action").eq("project_id", pid).like("action", "ADVANCE%")).data.map((a) => a.action);
const PDF = (label) => Buffer.from(`%PDF-1.4 justificatif ${label} ${randomUUID()}`);
function sniff(b) {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return "application/octet-stream";
}
// Reproduit le flux serveur : préparation, revendication, écriture de la
// candidate, relecture des octets RÉELLEMENT stockés, attestation, finalisation.
async function attachReceipt(client, advanceId, bytes, op = randomUUID(), writeBytes = bytes) {
  const prep = await client.rpc("prepare_advance_receipt_upload", {
    p_operation_uuid: op, p_advance_id: advanceId, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf",
  });
  if (prep.error) return { stage: "prepare", error: prep.error };
  const claim = await client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.data.attempt_id });
  if (claim.error) return { stage: "claim", error: claim.error };
  const up = await service.storage.from("advance-receipts").upload(claim.data.candidate_key, writeBytes, { contentType: "application/pdf", upsert: false });
  if (up.error) return { stage: "upload", error: up.error };
  const dl = await service.storage.from("advance-receipts").download(claim.data.candidate_key);
  const stored = new Uint8Array(await dl.data.arrayBuffer());
  const attest = await service.rpc("attest_storage_verified", {
    p_operation_uuid: op, p_attempt_id: claim.data.attempt_id, p_actual_checksum: sha(stored), p_actual_size_bytes: stored.length, p_actual_mime_type: sniff(stored),
  });
  const fin = await client.rpc("finalize_advance_receipt_upload", { p_operation_uuid: op });
  return { stage: attest.error ? "attest" : "finalize", attestError: attest.error, error: fin.error, data: fin.data, op, candidate: claim.data.candidate_key };
}

async function main() {
  const P = await quotedProject("main", { members: [["coOwner", "OWNER", "CO_OWNER"], ["siteManager", "SITE_MANAGER", null]] });
  const { pid, contractor, owner, coOwner, siteManager } = P;
  const outsider = await createTestUser("outsider");

  // 1. Avance exigée : devis accepté requis, bornes, plafond, droits.
  const before = await status(owner.client, pid);
  record("1. Avant fixation — « intégralement reconnue » faux, aucun montant exigé", before.row?.fully_recognized === false && before.row?.has_requirement === false, JSON.stringify(before.row));
  const noQuote = await setReq(contractor.client, pid, "1000000", 0);
  record("1. Fixation refusée tant que le devis n'est pas accepté (quote_not_accepted)", noQuote.error?.message === "quote_not_accepted", err(noQuote));
  await P.accept();
  for (const [label, u] of [["OWNER/PRIMARY", owner], ["CO_OWNER", coOwner], ["SITE_MANAGER", siteManager], ["tiers", outsider]]) {
    const r = await setReq(u.client, pid, "1000000", 0);
    record(`1. Fixation refusée — ${label}`, r.error?.message === "not_authorized", err(r));
  }
  for (const [label, amount, code] of [["0 FCFA", "0", "amount_out_of_bounds"], ["négatif", "-5", "invalid_amount"], ["décimal", "10.5", "invalid_amount"], ["texte", "abc", "invalid_amount"], ["> 1e12", "1000000000001", "amount_out_of_bounds"], ["au-delà du montant contractuel", "10000001", "amount_above_contract"]]) {
    const r = await setReq(contractor.client, pid, amount, 0);
    record(`1. Fixation refusée — ${label} (${code})`, r.error?.message === code, err(r));
  }
  const nullRev = await setReq(contractor.client, pid, "900000", null);
  record("1. Révision NULL refusée", nullRev.error?.message === "expected_revision_required", err(nullRev));
  const req1 = await setReq(contractor.client, pid, "900000", 0);
  const req2 = await setReq(contractor.client, pid, "1000000", await rev(pid));
  const versions = (await service.from("advance_requirement_versions").select("version_number, amount_fcfa").eq("project_id", pid).order("version_number")).data;
  record("1. Montant exigé versionné — v1 900 000 puis v2 1 000 000, la courante est v2",
    !req1.error && !req2.error && versions.length === 2 && String(versions[1].amount_fcfa) === "1000000" && (await status(coOwner.client, pid)).row.requirement_amount_fcfa === "1000000");

  // 2. Déclarations, droits, formats.
  const r2 = await rev(pid);
  for (const [label, u] of [["CO_OWNER", coOwner], ["SITE_MANAGER", siteManager], ["tiers", outsider]]) {
    const r = await declare(u.client, pid, "1000", r2);
    record(`2. Déclaration refusée — ${label}`, r.error?.message === "not_authorized", err(r));
  }
  const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
  for (const [label, extra, amount, code] of [["date future", { date: tomorrow }, "1000", "invalid_payment_date"], ["mode inconnu", { mode: "CRYPTO" }, "1000", "invalid_mode"], ["mention non acceptée", { ack: false }, "1000", "disclaimer_required"], ["référence > 120", { reference: "r".repeat(121) }, "1000", "invalid_reference"], ["montant nul", {}, "0", "amount_out_of_bounds"]]) {
    const r = await declare(owner.client, pid, amount, r2, randomUUID(), extra);
    record(`2. Déclaration refusée — ${label} (${code})`, r.error?.message === code, err(r));
  }
  const d1op = randomUUID();
  const d1 = await declare(owner.client, pid, "600000", r2, d1op, { reference: "OM-123" });
  const A1 = d1.row?.advance_id;
  record("2. Client déclare 600 000 — DECLARED, résultat non rejoué", !d1.error && d1.row.current_status === "DECLARED" && d1.row.replayed === false && d1.row.outcome === "DECLARED", err(d1));
  const d2 = await declare(contractor.client, pid, "500000", await rev(pid));
  const A2 = d2.row?.advance_id;
  record("2. Entreprise déclare 500 000 reçus — DECLARED", !d2.error && (await advRow(A2)).declared_role === "CONTRACTOR", err(d2));
  record("2. Non confirmés : somme reconnue 0, non intégralement reconnue", (await status(owner.client, pid)).row.recognized_sum_fcfa === "0" && (await status(owner.client, pid)).row.fully_recognized === false);

  // 3. Confirmation : rôle opposé, jamais le déclarant.
  const selfConf = await confirm(owner.client, A1, await rev(pid));
  const sameRole = await confirm(contractor.client, A2, await rev(pid));
  const coConf = await confirm(coOwner.client, A1, await rev(pid));
  const smConf = await confirm(siteManager.client, A1, await rev(pid));
  record("3. Confirmation refusée — déclarant (self_confirmation_refused), CO_OWNER et SITE_MANAGER (not_authorized)",
    selfConf.error?.message === "self_confirmation_refused" && sameRole.error?.message === "self_confirmation_refused" &&
      coConf.error?.message === "not_authorized" && smConf.error?.message === "not_authorized", [selfConf, sameRole, coConf, smConf].map(err).join(" / "));
  const c1op = randomUUID();
  const c1 = await confirm(contractor.client, A1, await rev(pid), c1op);
  const c2 = await confirm(owner.client, A2, await rev(pid));
  const st3 = (await status(owner.client, pid)).row;
  record("3. Confirmations croisées — somme reconnue 1 100 000, intégralement reconnue, 100 000 « au-delà de l'avance », aucun trop-perçu contractuel",
    !c1.error && !c2.error && st3.recognized_sum_fcfa === "1100000" && st3.fully_recognized === true && st3.recognized_above_advance_fcfa === "100000" && st3.recognized_above_contract_fcfa === null, JSON.stringify(st3));
  const again = await confirm(contractor.client, A1, 0);
  record("3. Seconde confirmation (nouvelle opération) — réussite idempotente ALREADY_CONFIRMED, aucun événement", !again.error && again.row.outcome === "ALREADY_CONFIRMED" && again.row.result_event_seq === null &&
    (await service.from("advance_events").select("id").eq("advance_id", A1).eq("kind", "CONFIRMED")).data.length === 1, err(again));

  // 4. Idempotence.
  const seqBefore = await seqs(pid);
  const revBefore = await rev(pid);
  const rp = await declare(owner.client, pid, "600000", 0, d1op, { reference: " OM-123 " });
  record("4. Rejeu identique (révision périmée ignorée, paramètres normalisés) — même versement, rejoué, aucune écriture",
    !rp.error && rp.row.replayed === true && rp.row.advance_id === A1 && same(await seqs(pid), seqBefore) && (await rev(pid)) === revBefore, err(rp));
  const rpDiff = await declare(owner.client, pid, "600001", revBefore, d1op);
  const rpOther = await declare(contractor.client, pid, "600000", revBefore, d1op, { reference: "OM-123" });
  record("4. Même operation_uuid, paramètres ou profil différents — operation_conflict, aucune écriture", rpDiff.error?.message === "operation_conflict" && rpOther.error?.message === "operation_conflict" && same(await seqs(pid), seqBefore), `${err(rpDiff)} / ${err(rpOther)}`);
  const dsp = await dispute(owner.client, A1, await rev(pid), "Opérateur a annulé le transfert");
  const rpConf = await confirm(contractor.client, A1, 0, c1op);
  record("4. Rejeu d'une confirmation après contestation — résultat CONFIRMED rejoué, état courant DISPUTED, rien réactivé",
    !dsp.error && !rpConf.error && rpConf.row.replayed && rpConf.row.outcome === "CONFIRMED" && rpConf.row.current_status === "DISPUTED" && (await advRow(A1)).status === "DISPUTED", JSON.stringify(rpConf.row));
  const st4 = (await status(owner.client, pid)).row;
  record("4. Contesté exclu — somme reconnue 500 000, non intégralement reconnue, aucun montant au-delà de l'avance", st4.recognized_sum_fcfa === "500000" && st4.fully_recognized === false && st4.recognized_above_advance_fcfa === null, JSON.stringify(st4));
  const back = await confirm(contractor.client, A1, await rev(pid));
  record("4. DISPUTED -> RECEIVED refusé (invalid_transition)", back.error?.message === "invalid_transition", err(back));

  // 5. Annulation et nouvelle déclaration.
  const cancelOther = await cancel(contractor.client, A1, await rev(pid));
  const cancelNoReason = await act("cancel_advance_payment", owner.client, A1, await rev(pid), randomUUID(), "  ");
  record("5. Annulation refusée — non-déclarant (not_declarant), motif vide (reason_required)", cancelOther.error?.message === "not_declarant" && cancelNoReason.error?.message === "reason_required", `${err(cancelOther)} / ${err(cancelNoReason)}`);
  const cx = await cancel(owner.client, A1, await rev(pid), "Remplacé par une nouvelle déclaration");
  const d3 = await declare(owner.client, pid, "600000", await rev(pid));
  await confirm(contractor.client, d3.row.advance_id, await rev(pid));
  record("5. Annulation puis nouvelle déclaration confirmée — somme 1 100 000, l'original annulé reste visible",
    !cx.error && (await advRow(A1)).status === "CANCELLED" && (await status(coOwner.client, pid)).row.recognized_sum_fcfa === "1100000" &&
      (await coOwner.client.rpc("list_advance_payments", { p_project_id: pid })).data.some((a) => a.advance_id === A1 && a.status === "CANCELLED"));
  const coDispute = await dispute(coOwner.client, A2, await rev(pid));
  record("5. CO_OWNER : contestation refusée (lecture seule)", coDispute.error?.message === "not_authorized", err(coDispute));

  // 6. Séquence : sans trou, unique, ordre indépendant de l'horodatage.
  const s6 = await seqs(pid);
  record("6. Séquence du chantier contiguë 1..n, sans doublon", contiguous(s6) && new Set(s6).size === s6.length, JSON.stringify(s6));
  const badSeq = await psqlError(`insert into public.advance_events (project_id, event_seq, kind, advance_id, actor_profile_id, actor_role) values ('${pid}', 999, 'RECEIPT_ATTACHED', '${A2}', '${contractor.id}', 'CONTRACTOR');\n`);
  const skipSeq = await psqlError(`update public.advance_ledgers set last_event_seq = last_event_seq + 2 where project_id = '${pid}';\n`);
  record("6. Écriture privilégiée — événement hors séquence et saut de compteur refusés (advance_sequence_violation)", badSeq.includes("advance_sequence_violation") && skipSeq.includes("advance_sequence_violation"), `${badSeq} / ${skipSeq}`);
  const oldTs = await psqlError(`begin;
with a as (insert into public.advances (project_id, declared_by_profile_id, declared_role, amount_fcfa, external_payment_date, mode) values ('${pid}', '${owner.id}', 'OWNER_PRIMARY', 1, '2001-01-01', 'CASH') returning id),
l as (update public.advance_ledgers set last_event_seq = last_event_seq + 1 where project_id = '${pid}' returning last_event_seq)
insert into public.advance_events (project_id, event_seq, kind, advance_id, actor_profile_id, actor_role, created_at_server)
select '${pid}', l.last_event_seq, 'DECLARED', a.id, '${owner.id}', 'OWNER_PRIMARY', timestamptz '2001-01-01' from a, l;
commit;\n`);
  const ev = (await owner.client.rpc("list_advance_events", { p_project_id: pid })).data;
  record("6. Ordre fixé par event_seq, pas par l'horodatage — un événement daté de 2001 reste le dernier de la liste", oldTs === "" && ev[ev.length - 1].created_at_server.startsWith("2001") && ev.every((e, i) => i === 0 || Number(e.event_seq) > Number(ev[i - 1].event_seq)), oldTs);

  // 7. Échec d'audit : aucun numéro consommé, rejeu ensuite réussi avec seq + 1.
  const d4 = await declare(owner.client, pid, "1000", await rev(pid));
  const A4 = d4.row.advance_id;
  const s7 = await seqs(pid);
  const r7 = await rev(pid);
  await psql(`create or replace function public.b033_fail_audit() returns trigger language plpgsql as $f$ begin if new.action = 'ADVANCE_CONFIRMED' then raise exception 'audit_test_failure'; end if; return new; end $f$;
create trigger b033_fail_audit before insert on public.audit_events for each row execute function public.b033_fail_audit();\n`);
  const op7 = randomUUID();
  let fail7;
  try { fail7 = await confirm(contractor.client, A4, r7, op7); } finally { await psql("drop trigger if exists b033_fail_audit on public.audit_events; drop function if exists public.b033_fail_audit();\n"); }
  const ok7 = await confirm(contractor.client, A4, r7, op7);
  const s7b = await seqs(pid);
  record("7. Échec d'audit — tout annulé (statut, séquence, révision, opération), puis même opération réussie avec le numéro suivant exact",
    fail7.error?.message === "audit_test_failure" && !ok7.error && ok7.row.replayed === false && Number(ok7.row.result_event_seq) === s7[s7.length - 1] + 1 && s7b.length === s7.length + 1 && contiguous(s7b), `${err(fail7)} / ${err(ok7)}`);

  // 8. Concurrence.
  const d8 = await declare(owner.client, pid, "2000", await rev(pid));
  const r8 = await rev(pid);
  const [x1, x2] = await Promise.all([confirm(contractor.client, d8.row.advance_id, r8), cancel(owner.client, d8.row.advance_id, r8)]);
  const ev8 = (await service.from("advance_events").select("kind").eq("advance_id", d8.row.advance_id)).data.map((e) => e.kind).filter((k) => k !== "DECLARED");
  record("8. Confirmation et annulation concurrentes — une seule aboutit, un seul événement, séquence contiguë",
    [x1, x2].filter((r) => !r.error).length === 1 && [x1, x2].filter((r) => r.error?.message === "advance_conflict").length === 1 && ev8.length === 1 && contiguous(await seqs(pid)), JSON.stringify([err(x1), err(x2)]));
  const d9 = await declare(owner.client, pid, "3000", await rev(pid));
  const r9 = await rev(pid);
  const [y1, y2] = await Promise.all([confirm(contractor.client, d9.row.advance_id, r9), confirm(contractor.client, d9.row.advance_id, r9)]);
  record("8. Confirmations concurrentes — deux réussites, une seule effective (l'autre ALREADY_CONFIRMED), un seul événement",
    !y1.error && !y2.error && [y1, y2].map((r) => r.row.outcome).sort().join() === "ALREADY_CONFIRMED,CONFIRMED" &&
      (await service.from("advance_events").select("id").eq("advance_id", d9.row.advance_id).eq("kind", "CONFIRMED")).data.length === 1, JSON.stringify([y1.row?.outcome, y2.row?.outcome]));

  // 9. Attentes réelles : compte provisoire puis adhésion révoquée ; rejeu après perte de droits.
  const d10 = await declare(owner.client, pid, "4000", await rev(pid));
  const w1 = await callDuringRealWait(pid, () => confirm(contractor.client, d10.row.advance_id, 0).then((r) => r), () => setVerified(contractor.id, false));
  const rpProv = await confirm(contractor.client, A2, 0);
  await setVerified(contractor.id, true);
  record("9. Compte redevenu provisoire pendant l'attente — refus, aucun événement ; rejeu refusé aussi (account_provisional)",
    w1.elapsed >= 2500 && w1.res.error?.message === "account_provisional" && (await advRow(d10.row.advance_id)).status === "DECLARED" && rpProv.error?.message === "account_provisional", `${w1.elapsed}ms ${err(w1.res)}`);

  // 10. Justificatifs.
  const recOk = await attachReceipt(contractor.client, A2, PDF("A2"));
  record("10. Justificatif — préparé, écrit, octets réels attestés, finalisé : liaison + événement + audit atomiques",
    !recOk.error && !recOk.attestError && recOk.data?.advance_id === A2 &&
      (await service.from("advance_events").select("id").eq("advance_id", A2).eq("kind", "RECEIPT_ATTACHED")).data.length === 1 &&
      (await advAudits(pid)).includes("ADVANCE_RECEIPT_ATTACHED"), `${recOk.stage} ${err(recOk)}`);
  const finReplay = await contractor.client.rpc("finalize_advance_receipt_upload", { p_operation_uuid: recOk.op });
  record("10. Finalisation rejouée — même liaison, aucun nouvel événement", finReplay.data?.id === recOk.data?.id &&
    (await service.from("advance_events").select("id").eq("advance_id", A2).eq("kind", "RECEIPT_ATTACHED")).data.length === 1, err(finReplay));
  const readers = await Promise.all([owner, coOwner, contractor].map((u) => u.client.rpc("get_advance_receipt_file_key", { p_advance_id: A2 }).then(one)));
  const blocked = await Promise.all([siteManager, outsider].map((u) => u.client.rpc("get_advance_receipt_file_key", { p_advance_id: A2 })));
  record("10. Lecture — clé exacte (bucket advance-receipts) pour OWNER/PRIMARY, CO_OWNER, CONTRACTOR ; SITE_MANAGER et tiers refusés",
    readers.every((r) => r.row?.bucket === "advance-receipts" && r.row.storage_key === recOk.candidate) && blocked.every((r) => r.error?.message === "not_authorized"));
  const signed = await service.storage.from(readers[0].row.bucket).createSignedUrl(readers[0].row.storage_key, 60);
  const fetched = signed.data ? Buffer.from(await (await fetch(signed.data.signedUrl)).arrayBuffer()) : null;
  record("10. Lien signé côté serveur à partir de la clé autorisée — contenu identique", fetched?.toString().startsWith("%PDF-1.4 justificatif A2"));
  const second = await attachReceipt(contractor.client, A2, PDF("A2b"));
  const notDecl = await attachReceipt(owner.client, A2, PDF("x"));
  const smPrep = await attachReceipt(siteManager.client, A2, PDF("x"));
  record("10. Refus — second justificatif (receipt_already_attached), non-déclarant et SITE_MANAGER (not_authorized)",
    second.error?.message === "receipt_already_attached" && notDecl.error?.message === "not_authorized" && smPrep.error?.message === "not_authorized", [second, notDecl, smPrep].map((r) => `${r.stage}:${err(r)}`).join(" / "));
  const tampered = await attachReceipt(owner.client, d10.row.advance_id, PDF("attendu"), randomUUID(), PDF("différent"));
  record("10. Octets stockés différents des paramètres liés — attestation refusée (checksum_mismatch), finalisation refusée (storage_not_verified)",
    tampered.attestError?.message === "checksum_mismatch" && tampered.error?.message === "storage_not_verified", `${tampered.attestError?.message} / ${err(tampered)}`);
  const opX = randomUUID();
  const bx = PDF("conflit");
  await owner.client.rpc("prepare_advance_receipt_upload", { p_operation_uuid: opX, p_advance_id: d10.row.advance_id, p_expected_checksum: sha(bx), p_expected_size_bytes: bx.length, p_expected_mime_type: "application/pdf" });
  const prepDiff = await owner.client.rpc("prepare_advance_receipt_upload", { p_operation_uuid: opX, p_advance_id: A4, p_expected_checksum: sha(bx), p_expected_size_bytes: bx.length, p_expected_mime_type: "application/pdf" });
  const claimOther = await contractor.client.rpc("claim_upload_attempt", { p_operation_uuid: opX, p_expected_attempt_id: null });
  record("10. Paramètres liés immuables — autre cible pour le même operation_uuid refusée ; revendication par un autre profil refusée",
    prepDiff.error?.message === "operation_uuid_conflict" && claimOther.error?.message === "not_authorized", `${err(prepDiff)} / ${err(claimOther)}`);
  // Reprise et nettoyage d'une tentative expirée revendiquée.
  const claimX = await must(owner.client.rpc("claim_upload_attempt", { p_operation_uuid: opX, p_expected_attempt_id: null }), "claimX");
  await must(service.storage.from("advance-receipts").upload(claimX.candidate_key, bx, { contentType: "application/pdf" }), "uploadX");
  await psql(`update public.private_object_uploads set attempt_expires_at = now() - interval '2 hours' where operation_uuid = '${opX}';\n`);
  const recovered = await owner.client.rpc("recover_media_upload_attempt", { p_operation_uuid: opX });
  const { data: upX } = await service.from("private_object_uploads").select("id").eq("operation_uuid", opX).single();
  const stale = (await service.from("private_object_stale_keys").select("id, storage_key").eq("private_object_upload_id", upX.id)).data;
  const bucketX = stale[0] ? (await service.rpc("get_stale_key_bucket", { p_id: stale[0].id })).data : null;
  record("10. Reprise — nouvelle candidate sous advance_receipt/, ancienne candidate tracée dans le bucket advance-receipts",
    !recovered.error && recovered.data.candidate_key.includes(`/advance_receipt/${opX}/candidates/`) && recovered.data.candidate_key !== claimX.candidate_key &&
      stale.length === 1 && stale[0].storage_key === claimX.candidate_key && bucketX === "advance-receipts", err(recovered));
  await psql(`update public.private_object_uploads set attempt_expires_at = now() - interval '2 hours' where operation_uuid = '${opX}';\n`);
  const abandoned = await service.rpc("abandon_expired_advance_receipt_upload", { p_id: upX.id, p_older_than: "1 hour" });
  const { data: upOk } = await service.from("private_object_uploads").select("id").eq("operation_uuid", recOk.op).single();
  await psql(`update public.private_object_uploads set attempt_expires_at = now() - interval '2 hours' where id = '${upOk.id}';\n`);
  const abandonFinal = await service.rpc("abandon_expired_advance_receipt_upload", { p_id: upOk.id, p_older_than: "1 hour" });
  const finalStale = (await service.from("private_object_stale_keys").select("id").eq("private_object_upload_id", upOk.id)).data;
  record("10. Nettoyage — tentative non finalisée abandonnée ; fichier FINALIZED jamais abandonné ni tracé pour suppression",
    abandoned.data === true && abandonFinal.data === false && finalStale.length === 0 && (await service.storage.from("advance-receipts").download(recOk.candidate)).data !== null);
  // Versement annulé : jonction refusée, lecture historique conservée.
  const dRec = await declare(contractor.client, pid, "5000", await rev(pid));
  const recHist = await attachReceipt(contractor.client, dRec.row.advance_id, PDF("hist"));
  await cancel(contractor.client, dRec.row.advance_id, await rev(pid), "Déclaration erronée");
  const histRead = await owner.client.rpc("get_advance_receipt_file_key", { p_advance_id: dRec.row.advance_id }).then(one);
  const attachCancelled = await attachReceipt(owner.client, A1, PDF("annulé"));
  record("10. Versement annulé — joindre refusé (advance_cancelled), lecture historique du justificatif déjà joint conservée",
    !recHist.error && attachCancelled.error?.message === "advance_cancelled" && histRead.row?.storage_key === recHist.candidate, `${err(attachCancelled)} / ${err(histRead)}`);

  // 11. Chantier secondaire : transfert de rôle, collision d'operation_uuid, isolation, trop-perçu, figement.
  const Q = await quotedProject("other");
  await Q.accept();
  await must(setReq(Q.contractor.client, Q.pid, "10000000", 0), "reqQ");
  const dq = await declare(Q.contractor.client, Q.pid, "10000005", await rev(Q.pid));
  // Le déclarant (CONTRACTOR) devient OWNER/PRIMARY : il ne peut toujours pas confirmer.
  await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", Q.pid).eq("profile_id", Q.owner.id), "revoke owner");
  await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", Q.pid).eq("profile_id", Q.contractor.id), "revoke contractor");
  await must(service.from("project_memberships").insert({ project_id: Q.pid, profile_id: Q.contractor.id, role: "OWNER", owner_profile: "PRIMARY" }), "declarant now owner");
  const transferred = await confirm(Q.contractor.client, dq.row.advance_id, await rev(Q.pid));
  const exOwner = await confirm(Q.owner.client, dq.row.advance_id, await rev(Q.pid));
  record("11. Déclarant devenu titulaire du rôle opposé après transfert — confirmation refusée (self_confirmation_refused) ; ancien titulaire révoqué refusé",
    transferred.error?.message === "self_confirmation_refused" && exOwner.error?.message === "not_authorized", `${err(transferred)} / ${err(exOwner)}`);
  // Rétablissement : nouvel entrepreneur, confirmation par le titulaire courant du rôle opposé.
  const newPro = await createTestUser("new-contractor");
  await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", Q.pid).eq("profile_id", Q.contractor.id), "revoke");
  await must(service.from("project_memberships").insert({ project_id: Q.pid, profile_id: Q.owner.id, role: "OWNER", owner_profile: "PRIMARY" }), "owner back");
  await must(service.from("project_memberships").insert({ project_id: Q.pid, profile_id: newPro.id, role: "CONTRACTOR", owner_profile: null }), "new contractor");
  const cq = await confirm(Q.owner.client, dq.row.advance_id, await rev(Q.pid));
  const stQ = (await status(Q.owner.client, Q.pid)).row;
  record("11. Trop-perçu comparé au montant contractuel — 5 FCFA au-delà de 10 000 000 ; « au-delà de l'avance » 5 FCFA",
    !cq.error && stQ.recognized_above_contract_fcfa === "5" && stQ.recognized_above_advance_fcfa === "5", JSON.stringify(stQ));
  const cancelLostRole = await cancel(Q.contractor.client, dq.row.advance_id, await rev(Q.pid));
  record("11. Annulation par le déclarant ayant perdu tout rôle autorisé — refusée (not_authorized)", cancelLostRole.error?.message === "not_authorized", err(cancelLostRole));
  // Collision d'operation_uuid entre deux chantiers concurrents.
  const opC = randomUUID();
  const seqMain = await seqs(pid);
  const holder = psql(`begin;
insert into public.advance_operations (operation_uuid, project_id, profile_id, command, payload_hash, outcome) values ('${opC}', '${Q.pid}', '${Q.owner.id}', 'DECLARE', 'x', 'DECLARED');
select pg_sleep(3);
commit;\n`);
  await sleep(800);
  const collide = await declare(owner.client, pid, "7000", await rev(pid), opC);
  await holder;
  record("11. Même operation_uuid sur deux chantiers concurrents — refus maîtrisé operation_conflict, aucune mutation, aucune erreur d'unicité brute",
    collide.error?.message === "operation_conflict" && same(await seqs(pid), seqMain) && !(await service.from("advances").select("id").eq("project_id", pid).eq("amount_fcfa", 7000)).data.length, err(collide));
  const crossRead = await owner.client.rpc("list_advance_payments", { p_project_id: Q.pid });
  const crossAct = await dispute(owner.client, dq.row.advance_id, 0);
  const fkEvent = await psqlError(`begin;
with l as (update public.advance_ledgers set last_event_seq = last_event_seq + 1 where project_id = '${pid}' returning last_event_seq)
insert into public.advance_events (project_id, event_seq, kind, advance_id, actor_profile_id, actor_role) select '${pid}', l.last_event_seq, 'RECEIPT_ATTACHED', '${dq.row.advance_id}', '${owner.id}', 'OWNER_PRIMARY' from l;
commit;\n`);
  record("11. Isolation — lecture et action sur un autre chantier refusées ; événement référant un versement d'un autre chantier refusé (clé composite)",
    crossRead.error?.message === "not_authorized" && crossAct.error?.message === "not_authorized" && fkEvent.includes("advance_events_advance_fk"), fkEvent);
  // Figement (positionné par B067 à l'avenir) : simulé en écriture privilégiée.
  await psql(`update public.advance_ledgers set requirement_frozen_at = now(), last_event_seq = last_event_seq + 1 where project_id = '${Q.pid}';\n`);
  const frozen = await setReq(newPro.client, Q.pid, "900000", await rev(Q.pid));
  const unfreeze = await psqlError(`update public.advance_ledgers set requirement_frozen_at = null, last_event_seq = last_event_seq + 1 where project_id = '${Q.pid}';\n`);
  record("11. Montant exigé figé — nouvelle version refusée (requirement_frozen), levée du figement refusée", frozen.error?.message === "requirement_frozen" && unfreeze.includes("requirement_frozen"), `${err(frozen)} / ${unfreeze}`);

  // 12. Révocation pendant une attente réelle et rejeu après perte de droits.
  const opR = randomUUID();
  const decl = await declare(Q.owner.client, Q.pid, "1000", await rev(Q.pid), opR);
  const { data: mem } = await service.from("project_memberships").select("id").eq("project_id", Q.pid).eq("profile_id", newPro.id).is("revoked_at", null).single();
  const w2 = await callDuringRealWait(Q.pid, () => confirm(newPro.client, decl.row.advance_id, 0).then((r) => r),
    async () => { await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("id", mem.id), "revoke"); });
  await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", Q.pid).eq("profile_id", Q.owner.id).is("revoked_at", null), "revoke owner");
  const replayLost = await declare(Q.owner.client, Q.pid, "1000", 0, opR);
  record("12. Adhésion révoquée pendant l'attente — confirmation refusée ; rejeu d'une opération réussie après perte des droits — refusé (not_authorized)",
    w2.elapsed >= 2500 && w2.res.error?.message === "not_authorized" && (await advRow(decl.row.advance_id)).status === "DECLARED" && replayLost.error?.message === "not_authorized", `${w2.elapsed}ms ${err(w2.res)} / ${err(replayLost)}`);

  // 13. Immuabilité et audit.
  const upd = await service.from("advances").update({ amount_fcfa: 1 }).eq("id", A2);
  const del = await service.from("advance_events").delete().eq("advance_id", A2);
  const opDel = await service.from("advance_operations").delete().eq("operation_uuid", d1op);
  const verUpd = await service.from("advance_requirement_versions").update({ amount_fcfa: 1 }).eq("project_id", pid);
  const direct = await service.from("advances").update({ status: "DECLARED" }).eq("id", A2);
  record("13. Immuabilité — montant, événements, opérations, versions exigées ; retour RECEIVED -> DECLARED refusé",
    upd.error?.message?.includes("advance_immutable") && del.error?.message?.includes("advance_record_immutable") && opDel.error?.message?.includes("advance_record_immutable") &&
      verUpd.error?.message?.includes("advance_record_immutable") && direct.error?.message?.includes("invalid_transition"));
  const audits = await advAudits(pid);
  record("13. Audit — chaque type d'événement tracé", ["ADVANCE_REQUIREMENT_SET", "ADVANCE_DECLARED", "ADVANCE_CONFIRMED", "ADVANCE_DISPUTED", "ADVANCE_CANCELLED", "ADVANCE_RECEIPT_ATTACHED"].every((a) => audits.includes(a)), JSON.stringify([...new Set(audits)]));
  // Le chantier secondaire a reçu un figement SIMULÉ sans événement (réservé à B067, qui devra émettre
  // son propre événement avec le numéro alloué) : seule la séquence du chantier principal est exigée contiguë.
  record("13. Séquence finale contiguë sur le chantier principal", contiguous(await seqs(pid)));

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} tests réussis.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERREUR:", e.message);
  process.exitCode = 1;
});
