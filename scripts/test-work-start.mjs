// Test d'intégration LOCAL uniquement pour B067 (M027 : autorisation de
// démarrage des travaux). Risques couverts : droits (D094), préconditions
// (devis accepté, plan du devis retenu+publié+validé, avance intégralement
// reconnue, statut du chantier : D135, D139), autorisation unique (D136),
// transaction unique figement + événement numéroté + autorisation + audit +
// opération avec un seul horodatage, idempotence et droits revérifiés au
// rejeu, collisions d'operation_uuid entre chantiers concurrents, attentes
// réelles sur verrou, lectures par rôle (D137), déficit après démarrage
// (D138), rollback sur échec d'audit, immuabilité.
//
// Usage : node scripts/test-work-start.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { callWhileLocked, gateKeyOf, openGate, openLock, waitForBlockedBy } from "./lib/real-lock.mjs";

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
  const email = `b067-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
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
// Boucle 33 : verrous réels sans délai fixe (scripts/lib/real-lock.mjs).
const advisoryLockSql = (projectId) => `select pg_advisory_xact_lock(hashtext('invitation_quota:${projectId}')::bigint)`;
// Verrou tenu jusqu'à la relâche ; attente constatée ; au moins 3 s (le contrôle exige >= 2 s).
async function callDuringRealWait(projectId, rpcCall, mutateDuringWait) {
  return callWhileLocked({ lockSql: advisoryLockSql(projectId), call: rpcCall, duringWait: mutateDuringWait, minElapsedMs: 3000 });
}
// Plusieurs appels lancés pendant que le verrou est tenu : on constate que
// TOUS l'attendent réellement avant de le relâcher.
async function callsWhileLocked(projectId, calls) {
  const lock = openLock(advisoryLockSql(projectId));
  try {
    const pid = await lock.locked;
    if (process.env.REAL_LOCK_SABOTAGE === "1") await lock.release();
    const pending = [];
    for (const call of calls) {
      pending.push(Promise.resolve(call()).then((r) => r));
      if (process.env.REAL_LOCK_SABOTAGE !== "1") await waitForBlockedBy(pid, pending.length);
    }
    const waited = process.env.REAL_LOCK_SABOTAGE === "1" ? 0 : (await waitForBlockedBy(pid, calls.length)).length;
    await lock.release();
    return { results: await Promise.all(pending), waited };
  } finally {
    await lock.release().catch(() => {});
  }
}
// Rivale arrêtée à une PORTE (verrou consultatif tenu par le test) au lieu
// d'un pg_sleep : la rivale est constatée à la porte, l'appel testé est
// constaté bloqué par la rivale, la durée minimale est tenue, puis la porte
// est relâchée (la rivale valide ou échoue selon le déclencheur).
async function withRivalAtGate(name, { install, startRival, startCall, duringWait, minElapsedMs }) {
  const key = gateKeyOf(`${name}-${randomUUID()}`);
  const gate = openGate(key);
  try {
    const gatePid = await gate.locked;
    await install(key);
    if (gate.sabotage) await gate.release();
    const pRival = Promise.resolve(startRival()).then((r) => r);
    const rivalPid = gate.sabotage ? null : ((await waitForBlockedBy(gatePid, 1))[0] ?? null);
    const t0 = Date.now();
    const pCall = Promise.resolve(startCall()).then((r) => r);
    const waited = rivalPid !== null && (await waitForBlockedBy(rivalPid, 1)).length >= 1;
    if (duringWait) await duringWait();
    while (!gate.sabotage && Date.now() - t0 < minElapsedMs) await sleep(50);
    await gate.release();
    const rCall = await pCall;
    const elapsed = Date.now() - t0;
    return { rRival: await pRival, rCall, elapsed, waited };
  } finally {
    await gate.release().catch(() => {});
  }
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
  const { data: proj } = await contractor.client.rpc("create_draft_project", { p_name: `B067 — ${tag}`, p_country: "ML", p_role: "CONTRACTOR" });
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
const opRow = async (op) => (await service.from("advance_operations").select("*").eq("operation_uuid", op).maybeSingle()).data;
const wsAudits = async (pid) => (await service.from("audit_events").select("action, context").eq("project_id", pid).eq("action", "WORK_START_AUTHORIZE")).data;
const frozenEvents = async (pid) => (await service.from("advance_events").select("*").eq("project_id", pid).eq("kind", "REQUIREMENT_FROZEN")).data;
const revoke = (pid, profileId) => must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", profileId).is("revoked_at", null), "revoke");
// État complet du domaine pour vérifier qu'une transaction perdante ne laisse rien.
const footprint = async (pid) => ({ ledger: await ledger(pid), seqs: await seqs(pid), ws: await wsRow(pid), audits: (await wsAudits(pid)).length, frozen: (await frozenEvents(pid)).length });
const membershipId = async (pid, profileId) => (await service.from("project_memberships").select("id").eq("project_id", pid).eq("profile_id", profileId).is("revoked_at", null).single()).data.id;
const noTrace = (f) => f.ws === null && f.audits === 0 && f.frozen === 0 && f.ledger.requirement_frozen_at === null;

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
// Arrête (puis éventuellement fait échouer) une transaction à une PORTE
// tenue par le test (boucle 33 : verrou consultatif, plus de pg_sleep) :
// la transaction reste ouverte, ses écritures non validées, jusqu'à la relâche.
const installGateOn = (name, table, cond, gateKey, fail = false) =>
  psql(`create or replace function public.${name}() returns trigger language plpgsql as $f$ begin if ${cond} then perform pg_advisory_xact_lock(${Number(gateKey)}); ${fail ? "raise exception 'forced_failure';" : ""} end if; return new; end $f$;
create trigger ${name} after insert on public.${table} for each row execute function public.${name}();\n`);
const installGate = (name, action, pid, gateKey, fail = false) =>
  installGateOn(name, "audit_events", `new.action = '${action}' and new.project_id = '${pid}'`, gateKey, fail);
const dropDelay = (name, table = "audit_events") => psql(`drop trigger if exists ${name} on public.${table}; drop function if exists public.${name}();\n`);

async function main() {
  const P = await readyProject("main", { members: [["coOwner", "OWNER", "CO_OWNER"], ["siteManager", "SITE_MANAGER", null]] });
  const { pid, contractor, owner, coOwner, siteManager } = P;
  const outsider = await createTestUser("outsider");

  // 1. Droits : CONTRACTOR seul.
  for (const [label, u, code] of [["OWNER/PRIMARY", owner, "not_authorized"], ["CO_OWNER", coOwner, "not_authorized"], ["SITE_MANAGER", siteManager, "not_authorized"], ["tiers", outsider, "not_authorized"]]) {
    const r = await authorize(u.client, pid, await rev(pid));
    record(`1. Autorisation refusée — ${label}`, r.error?.message === code, err(r));
  }
  await setVerified(contractor.id, false);
  const prov = await authorize(contractor.client, pid, await rev(pid));
  await setVerified(contractor.id, true);
  record("1. Autorisation refusée — compte provisoire", prov.error?.message === "account_provisional", err(prov));

  // 2. Préconditions (chantiers dédiés) et révision.
  const noQuote = await quotedProject("noquote");
  const r2a = await authorize(noQuote.contractor.client, noQuote.pid, 0);
  record("2. Sans devis accepté — quote_not_accepted", r2a.error?.message === "quote_not_accepted", err(r2a));
  await noQuote.accept();
  const r2b = await authorize(noQuote.contractor.client, noQuote.pid, 0);
  record("2. Sans avance exigée — advance_not_fully_recognized", r2b.error?.message === "advance_not_fully_recognized", err(r2b));
  await setReq(noQuote.contractor.client, noQuote.pid, "1000000", 0);
  const dPart = await declare(noQuote.owner.client, noQuote.pid, "400000", await rev(noQuote.pid));
  await confirm(noQuote.contractor.client, dPart.row.advance_id, await rev(noQuote.pid));
  const r2c = await authorize(noQuote.contractor.client, noQuote.pid, await rev(noQuote.pid));
  record("2. Avance partielle (400 000 / 1 000 000) — advance_not_fully_recognized", r2c.error?.message === "advance_not_fully_recognized", err(r2c));
  const dRest = await declare(noQuote.owner.client, noQuote.pid, "600000", await rev(noQuote.pid));
  await dispute(noQuote.contractor.client, dRest.row.advance_id, await rev(noQuote.pid));
  const r2d = await authorize(noQuote.contractor.client, noQuote.pid, await rev(noQuote.pid));
  record("2. Complément contesté exclu — advance_not_fully_recognized", r2d.error?.message === "advance_not_fully_recognized", err(r2d));
  const f2 = await footprint(noQuote.pid);
  record("2. Refus sans aucune écriture (ni figement, ni événement, ni autorisation, ni audit)", noTrace(f2), JSON.stringify({ seqs: f2.seqs, frozen: f2.ledger.requirement_frozen_at }));

  const stale = await authorize(contractor.client, pid, (await rev(pid)) - 1);
  record("2. Révision obsolète — advance_conflict", stale.error?.message === "advance_conflict", err(stale));
  const nullRev = await authorize(contractor.client, pid, null);
  record("2. Révision NULL — expected_revision_required", nullRev.error?.message === "expected_revision_required", err(nullRev));
  for (const st of ["SUSPENDED", "COMPLETED", "ARCHIVED", "READ_ONLY"]) {
    await psql(`update public.projects set status = '${st}' where id = '${pid}';\n`);
    const r = await authorize(contractor.client, pid, await rev(pid));
    record(`2. Statut ${st} (écriture privilégiée) — project_status_incompatible`, r.error?.message === "project_status_incompatible", err(r));
  }
  await psql(`update public.projects set status = 'DRAFT' where id = '${pid}';\n`);

  // 3. Échec d'audit forcé : rollback complet, puis même opération réussie avec le numéro suivant.
  const before3 = await footprint(pid);
  const op3 = randomUUID();
  // Porte que personne ne tient : obtenue aussitôt, puis échec forcé (comme pg_sleep(0)).
  await installGate("b067_fail_audit", "WORK_START_AUTHORIZE", pid, gateKeyOf("b067_fail_audit-libre"), true);
  let fail3;
  try { fail3 = await authorize(contractor.client, pid, await rev(pid), op3); } finally { await dropDelay("b067_fail_audit"); }
  const after3 = await footprint(pid);
  record("3. Échec d'audit — erreur remontée, aucune trace (figement, événement, autorisation, audit, opération), compteur inchangé",
    fail3.error?.message === "forced_failure" && noTrace(after3) && same(after3.seqs, before3.seqs) && after3.ledger.revision === before3.ledger.revision && (await opRow(op3)) === null, err(fail3));

  // 4. Succès : transaction unique, horodatage unique, instantané exact.
  const ok = await authorize(contractor.client, pid, await rev(pid), op3);
  const ws = await wsRow(pid);
  const led = await ledger(pid);
  const [fev] = await frozenEvents(pid);
  const op = await opRow(op3);
  const [aud] = await wsAudits(pid);
  const s4 = await seqs(pid);
  record("4. Autorisation réussie — opération réutilisée après l'échec, numéro suivant exact, séquence contiguë",
    !ok.error && ok.row.replayed === false && ok.row.outcome === "WORK_START_AUTHORIZED" && Number(ok.row.result_event_seq) === before3.seqs.length + 1 && contiguous(s4), err(ok));
  const t = new Date(ws?.authorized_at_server).getTime();
  record("4. Un seul horodatage serveur : autorisation = figement = événement = opération = contexte d'audit",
    [led.requirement_frozen_at, fev?.created_at_server, op?.created_at_server, aud?.context?.authorized_at_server].every((x) => new Date(x).getTime() === t),
    JSON.stringify([ws?.authorized_at_server, led.requirement_frozen_at, fev?.created_at_server, op?.created_at_server, aud?.context?.authorized_at_server]));
  const qv = (await service.from("quote_versions").select("id, plan_version_id, total_amount_fcfa").eq("id", P.quoteVersionId).single()).data;
  record("4. Instantané : devis accepté, plan du devis, validation VALIDATED, avance exigée et somme reconnue, statut DRAFT",
    ws.quote_version_id === qv.id && ws.plan_version_id === qv.plan_version_id && Number(ws.quote_total_fcfa) === Number(qv.total_amount_fcfa) &&
    Number(ws.advance_required_fcfa) === 1000000 && Number(ws.advance_recognized_fcfa) === 1000000 && ws.project_status_at_start === "DRAFT" &&
    Number(ws.advance_event_seq) === Number(fev.event_seq) && ws.advance_requirement_version_id === led.current_requirement_version_id &&
    (await service.from("plan_validations").select("status").eq("id", ws.plan_validation_id).single()).data.status === "VALIDATED" &&
    ws.operation_uuid === op3 && ws.authorized_by_profile_id === contractor.id, JSON.stringify(ws));
  record("4. Événement REQUIREMENT_FROZEN unique, acteur CONTRACTOR, version exigée courante ; audit unique",
    (await frozenEvents(pid)).length === 1 && fev.actor_role === "CONTRACTOR" && fev.requirement_version_id === led.current_requirement_version_id && (await wsAudits(pid)).length === 1);

  // 5. Unicité et idempotence.
  const replay = await authorize(contractor.client, pid, 0, op3);
  record("5. Rejeu (révision ignorée) — replayed, même numéro, aucun nouvel événement",
    !replay.error && replay.row.replayed === true && Number(replay.row.result_event_seq) === Number(ok.row.result_event_seq) && same(await seqs(pid), s4), err(replay));
  const again = await authorize(contractor.client, pid, await rev(pid));
  record("5. Seconde autorisation — work_start_already_authorized", again.error?.message === "work_start_already_authorized", err(again));
  const otherUser = await authorize(owner.client, pid, 0, op3);
  record("5. Même operation_uuid par un autre rôle — not_authorized (droits avant rejeu)", otherUser.error?.message === "not_authorized", err(otherUser));

  // 6. Lectures par rôle (D137) ; SITE_MANAGER : fait et date seulement.
  const authorMembership = await membershipId(pid, contractor.id);
  record("6. Auteur historique figé — repère d'adhésion du CONTRACTOR auteur", ws.authorized_by_membership_id === authorMembership, ws.authorized_by_membership_id);
  for (const [label, u] of [["OWNER/PRIMARY", owner], ["CO_OWNER", coOwner], ["CONTRACTOR", contractor]]) {
    const r = one(await u.client.rpc("get_work_start", { p_project_id: pid }));
    record(`6. Lecture complète — ${label} (auteur : repère ${authorMembership.slice(0, 8)}…, rôle CONTRACTOR)`,
      !r.error && r.row.authorized === true && r.row.advance_required_fcfa === "1000000" && r.row.deficit_fcfa === null && r.row.plan_version_number === 1 &&
      r.row.authorized_by_membership_id === authorMembership && r.row.authorized_by_role === "CONTRACTOR" && r.row.authorized_by_me === (u === contractor), err(r));
  }
  const smFull = await siteManager.client.rpc("get_work_start", { p_project_id: pid });
  record("6. Lecture complète refusée — SITE_MANAGER", smFull.error?.message === "not_authorized", err(smFull));
  const smSum = one(await siteManager.client.rpc("get_work_start_summary", { p_project_id: pid }));
  record("6. Résumé SITE_MANAGER — uniquement {authorized, authorized_at_server}",
    !smSum.error && same(Object.keys(smSum.row).sort(), ["authorized", "authorized_at_server"]) && smSum.row.authorized === true && new Date(smSum.row.authorized_at_server).getTime() === t, JSON.stringify(smSum.row));
  const outSum = await outsider.client.rpc("get_work_start_summary", { p_project_id: pid });
  const outFull = await outsider.client.rpc("get_work_start", { p_project_id: pid });
  record("6. Tiers — résumé et lecture refusés", outSum.error?.message === "not_authorized" && outFull.error?.message === "not_authorized", `${err(outSum)} / ${err(outFull)}`);
  const smAdv = await siteManager.client.rpc("get_advance_status", { p_project_id: pid });
  record("6. SITE_MANAGER — acomptes toujours refusés", smAdv.error?.message === "not_authorized", err(smAdv));

  // 7. Déficit après démarrage (D138) : instantané historique, alerte calculée.
  const snap = await wsRow(pid);
  const disp = await dispute(contractor.client, P.advanceId, await rev(pid));
  const g7 = one(await owner.client.rpc("get_work_start", { p_project_id: pid }));
  const g7c = one(await coOwner.client.rpc("get_work_start", { p_project_id: pid }));
  const g7k = one(await contractor.client.rpc("get_work_start", { p_project_id: pid }));
  record("7. Contestation après démarrage — autorisée, alerte 1 000 000 pour OWNER/PRIMARY, CO_OWNER et CONTRACTOR",
    !disp.error && [g7, g7c, g7k].every((g) => g.row.deficit_fcfa === "1000000" && g.row.current_recognized_fcfa === "0"), `${err(disp)} ${g7.row?.deficit_fcfa}`);
  const sm7 = one(await siteManager.client.rpc("get_work_start_summary", { p_project_id: pid }));
  record("7. SITE_MANAGER — aucune alerte ni montant", same(Object.keys(sm7.row).sort(), ["authorized", "authorized_at_server"]), JSON.stringify(sm7.row));
  record("7. Instantané inchangé après contestation", same(await wsRow(pid), snap));
  const reqAfter = await setReq(contractor.client, pid, "900000", await rev(pid));
  record("7. Nouvelle avance exigée après démarrage — requirement_frozen", reqAfter.error?.message === "requirement_frozen", err(reqAfter));
  const d7 = await declare(owner.client, pid, "1000000", await rev(pid));
  const c7 = await confirm(contractor.client, d7.row?.advance_id, await rev(pid));
  const g7b = one(await owner.client.rpc("get_work_start", { p_project_id: pid }));
  record("7. Nouvelle déclaration confirmée — alerte levée, instantané toujours identique",
    !d7.error && !c7.error && g7b.row.deficit_fcfa === null && g7b.row.current_recognized_fcfa === "1000000" && same(await wsRow(pid), snap), `${err(d7)} ${err(c7)}`);
  const s7 = await seqs(pid);
  record("7. Séquence contiguë après démarrage", contiguous(s7), JSON.stringify(s7));

  // 8. Immuabilité (écriture privilégiée).
  const u8 = await psqlError(`update public.work_start_authorizations set advance_required_fcfa = 1 where project_id = '${pid}';\n`);
  const d8 = await psqlError(`delete from public.work_start_authorizations where project_id = '${pid}';\n`);
  const f8 = await psqlError(`update public.advance_ledgers set last_event_seq = last_event_seq + 1, requirement_frozen_at = null where project_id = '${pid}';\n`);
  record("8. UPDATE/DELETE de l'autorisation refusés ; levée du figement refusée",
    u8.includes("work_start_immutable") && d8.includes("work_start_immutable") && f8.includes("requirement_frozen"), `${u8.slice(0, 60)} | ${d8.slice(0, 60)} | ${f8.slice(0, 60)}`);

  // 9. Révocation : rejeu après perte d'adhésion ; lectures refusées.
  await revoke(pid, contractor.id);
  const r9 = await authorize(contractor.client, pid, 0, op3);
  const g9 = await contractor.client.rpc("get_work_start", { p_project_id: pid });
  const s9 = await contractor.client.rpc("get_work_start_summary", { p_project_id: pid });
  record("9. Après révocation — rejeu, lecture et résumé refusés (not_authorized)",
    r9.error?.message === "not_authorized" && g9.error?.message === "not_authorized" && s9.error?.message === "not_authorized", `${err(r9)} / ${err(g9)} / ${err(s9)}`);

  // 10. Révocation pendant l'attente réelle du verrou.
  const R = await readyProject("revoke-wait");
  const f10 = await footprint(R.pid);
  const w10 = await callDuringRealWait(R.pid, () => authorize(R.contractor.client, R.pid, f10.ledger.revision), () => revoke(R.pid, R.contractor.id));
  record("10. Adhésion révoquée pendant l'attente (≥ 2 s) — not_authorized, aucune écriture",
    w10.waited && w10.res.error?.message === "not_authorized" && w10.elapsed >= 2000 && noTrace(await footprint(R.pid)), `attente ${w10.waited ? "constatée" : "NON constatée"}, ${err(w10.res)} ${w10.elapsed} ms`);

  // 11. Deux autorisations parallèles sur le même chantier (UUID distincts).
  const Q = await readyProject("parallel");
  const r11 = await ledger(Q.pid);
  const c11 = await callsWhileLocked(Q.pid, [() => authorize(Q.contractor.client, Q.pid, r11.revision), () => authorize(Q.contractor.client, Q.pid, r11.revision)]);
  const [a11, b11] = c11.results;
  const codes11 = [a11.error?.message ?? "OK", b11.error?.message ?? "OK"].sort();
  record("11. Deux autorisations concurrentes — un succès, un refus, un seul figement, séquence contiguë",
    c11.waited === 2 && (same(codes11, ["OK", "work_start_already_authorized"]) || same(codes11, ["OK", "advance_conflict"])) && (await frozenEvents(Q.pid)).length === 1 && contiguous(await seqs(Q.pid)), `${c11.waited}/2 en attente constatée, ${JSON.stringify(codes11)}`);

  // 12. Même operation_uuid sur deux chantiers concurrents — collision sur
  // work_start_authorizations pendant que la rivale n'est pas validée.
  const B = await readyProject("collide-b");
  const C = await readyProject("collide-c");
  const U = randomUUID();
  const fC = await footprint(C.pid);
  let rB, rC, w12;
  try {
    const revB = await rev(B.pid);
    w12 = await withRivalAtGate("b067_delay_b", {
      install: (k) => installGate("b067_delay_b", "WORK_START_AUTHORIZE", B.pid, k),
      startRival: () => authorize(B.contractor.client, B.pid, revB, U),
      startCall: () => authorize(C.contractor.client, C.pid, fC.ledger.revision, U),
      minElapsedMs: 2000,
    });
    rB = w12.rRival;
    rC = w12.rCall;
    rC.elapsed = w12.elapsed;
  } finally { await dropDelay("b067_delay_b"); }
  const fC2 = await footprint(C.pid);
  record("12. Même UUID, deux chantiers concurrents — un succès, l'autre operation_conflict (pas d'erreur d'unicité brute)",
    w12.waited && !rB.error && rC.error?.message === "operation_conflict" && rC.elapsed >= 1500, `${err(rB)} / ${err(rC)} (attente ${w12.waited ? "constatée" : "NON constatée"}, ${rC.elapsed} ms sur l'insertion rivale non validée)`);
  record("12. Transaction perdante sans aucune mutation (compteur, révision, événement, autorisation, audit)",
    noTrace(fC2) && same(fC2.seqs, fC.seqs) && fC2.ledger.revision === fC.ledger.revision, JSON.stringify(fC2.seqs));
  const replayB = await authorize(B.contractor.client, B.pid, 0, U);
  record("12. Rejeu légitime du gagnant préservé après revalidation des droits", !replayB.error && replayB.row.replayed === true, err(replayB));

  // 13. Rivale annulée : la seconde s'insère normalement.
  const D = await readyProject("collide-d");
  const U2 = randomUUID();
  let rD, rC2, w13;
  try {
    const revD = await rev(D.pid);
    const revC = await rev(C.pid);
    w13 = await withRivalAtGate("b067_fail_d", {
      install: (k) => installGate("b067_fail_d", "WORK_START_AUTHORIZE", D.pid, k, true),
      startRival: () => authorize(D.contractor.client, D.pid, revD, U2),
      startCall: () => authorize(C.contractor.client, C.pid, revC, U2),
      minElapsedMs: 0,
    });
    rD = w13.rRival;
    rC2 = w13.rCall;
  } finally { await dropDelay("b067_fail_d"); }
  record("13. Rivale annulée (échec forcé) — l'autre chantier réussit avec le même UUID, la rivale sans trace",
    w13.waited && rD.error?.message === "forced_failure" && !rC2.error && (await wsRow(C.pid))?.operation_uuid === U2 && noTrace(await footprint(D.pid)), `attente ${w13.waited ? "constatée" : "NON constatée"}, ${err(rD)} / ${err(rC2)}`);

  // 14. Collision avec une commande d'acompte concurrente (table d'opérations).
  const U3 = randomUUID();
  const fD = await footprint(D.pid);
  // Retard APRÈS l'insertion de l'opération de la déclaration (non validée).
  let rDecl, rD2, w14;
  try {
    const revB14 = await rev(B.pid);
    w14 = await withRivalAtGate("b067_delay_decl", {
      install: (k) => installGateOn("b067_delay_decl", "advance_operations", `new.operation_uuid = '${U3}'`, k),
      startRival: () => declare(B.owner.client, B.pid, "5000", revB14, U3),
      startCall: () => authorize(D.contractor.client, D.pid, fD.ledger.revision, U3),
      minElapsedMs: 0,
    });
    rDecl = w14.rRival;
    rD2 = w14.rCall;
  } finally { await dropDelay("b067_delay_decl", "advance_operations"); }
  const fD2 = await footprint(D.pid);
  record("14. UUID pris par une déclaration concurrente — operation_conflict, autorisation annulée sans trace",
    w14.waited && !rDecl.error && rD2.error?.message === "operation_conflict" && noTrace(fD2) && same(fD2.seqs, fD.seqs) && fD2.ledger.revision === fD.ledger.revision, `attente ${w14.waited ? "constatée" : "NON constatée"}, ${err(rDecl)} / ${err(rD2)}`);

  // 15. Divergence de plan (D135).
  const V = await readyProject("divergence");
  const eng = await createTestUser("divergence-eng2");
  const orgId = (await service.from("projects").select("organization_id").eq("id", V.pid).single()).data.organization_id;
  const des = await must(V.contractor.client.rpc("designate_plan_engineer", { p_organization_id: orgId, p_identifier_kind: "EMAIL", p_identifier_value: eng.email }), "designate2");
  const plan1 = qvPlan(await service.from("quote_versions").select("plan_version_id").eq("id", V.quoteVersionId).single());
  const plan2 = await deposit(V.owner.client, V.pid, "PLAN-2");
  await must(V.owner.client.rpc("set_retained_project_plan_version", { p_project_id: V.pid, p_version_id: plan2.id, p_expected_revision: (await project(V.pid)).revision }), "retain2");
  const d15a = await authorize(V.contractor.client, V.pid, await rev(V.pid));
  record("15. Plan retenu différent du plan du devis — plan_divergence", d15a.error?.message === "plan_divergence", err(d15a));
  const val2 = await must(V.contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: plan2.id, p_designation_id: des.id }), "submit2");
  await must(eng.client.rpc("decide_plan_validation", { p_validation_id: val2.id, p_decision: "VALIDATED", p_note: null }), "validate2");
  await must(V.contractor.client.rpc("publish_project_plan_version", { p_project_id: V.pid, p_version_id: plan2.id, p_expected_revision: (await project(V.pid)).revision }), "publish2");
  await must(V.owner.client.rpc("set_retained_project_plan_version", { p_project_id: V.pid, p_version_id: plan1, p_expected_revision: (await project(V.pid)).revision }), "retain1");
  const d15b = await authorize(V.contractor.client, V.pid, await rev(V.pid));
  record("15. Plan retenu = devis mais publié différent — plan_divergence", d15b.error?.message === "plan_divergence", err(d15b));
  record("15. Refus sans écriture", noTrace(await footprint(V.pid)));
  await must(V.contractor.client.rpc("publish_project_plan_version", { p_project_id: V.pid, p_version_id: plan1, p_expected_revision: (await project(V.pid)).revision }), "republish1");
  const d15c = await authorize(V.contractor.client, V.pid, await rev(V.pid));
  record("15. Plan du devis de nouveau retenu et publié — autorisation réussie", !d15c.error && (await wsRow(V.pid))?.plan_version_id === plan1, err(d15c));

  // 16. Contestation concurrente de l'autorisation : résultat cohérent quel que soit l'ordre.
  const X = await readyProject("race-dispute");
  const r16 = await rev(X.pid);
  const c16 = await callsWhileLocked(X.pid, [() => dispute(X.contractor.client, X.advanceId, r16), () => authorize(X.contractor.client, X.pid, r16)]);
  const [x1, x2] = c16.results;
  const wsX = await wsRow(X.pid);
  const evX = (await service.from("advance_events").select("kind, event_seq").eq("project_id", X.pid).order("event_seq")).data;
  const coherent = wsX
    ? Number(wsX.advance_recognized_fcfa) >= Number(wsX.advance_required_fcfa)
    : x2.error?.message === "advance_not_fully_recognized" || x2.error?.message === "advance_conflict";
  record("16. Contestation et autorisation concurrentes — état cohérent (jamais d'autorisation sous une avance non reconnue)",
    c16.waited === 2 && coherent && contiguous(evX.map((e) => Number(e.event_seq))), `${c16.waited}/2 en attente constatée, ${err(x1)} / ${err(x2)} / ${evX.map((e) => e.kind).join(",")}`);

  // 17-18. Rivale tenant le même UUID, B067 réellement bloqué, compte devenu
  // provisoire pendant l'attente, puis rollback de la rivale : refus sans trace.
  const E17 = await readyProject("provisional-wait");
  async function provisionalDuringRivalWait(label, installRival, startRival, dropRival) {
    const fE = await footprint(E17.pid);
    const u = randomUUID();
    let rRival, rE, elapsed, waited;
    try {
      const w = await withRivalAtGate(label, {
        install: (k) => installRival(u, k),
        startRival: () => startRival(u),
        startCall: () => authorize(E17.contractor.client, E17.pid, fE.ledger.revision, u),
        duringWait: () => setVerified(E17.contractor.id, false),
        minElapsedMs: 2000,
      });
      ({ rRival, rCall: rE, elapsed, waited } = w);
    } finally { await dropRival(); await setVerified(E17.contractor.id, true); }
    const fE2 = await footprint(E17.pid);
    record(`${label} — rivale annulée (forced_failure), B067 bloqué ${elapsed} ms puis refus account_provisional`,
      waited && rRival.error?.message === "forced_failure" && rE.error?.message === "account_provisional" && elapsed >= 1500, `attente ${waited ? "constatée" : "NON constatée"}, ${err(rRival)} / ${err(rE)}`);
    record(`${label} — aucune trace (autorisation, figement, événement, audit, opération, compteur, révision)`,
      noTrace(fE2) && same(fE2.seqs, fE.seqs) && fE2.ledger.revision === fE.ledger.revision && (await opRow(u)) === null &&
      (await service.from("work_start_authorizations").select("id").eq("operation_uuid", u)).data.length === 0);
  }
  // Point d'attente 1 : UUID tenu dans work_start_authorizations par une autorisation rivale (chantier D).
  const revD17 = await rev(D.pid);
  await provisionalDuringRivalWait("17. UUID tenu par une autorisation rivale",
    (u, k) => installGate("b067_rival_ws", "WORK_START_AUTHORIZE", D.pid, k, true),
    (u) => authorize(D.contractor.client, D.pid, revD17, u),
    () => dropDelay("b067_rival_ws"));
  // Point d'attente 2 : UUID tenu dans advance_operations par une déclaration d'acompte rivale (chantier B).
  const revB18 = await rev(B.pid);
  await provisionalDuringRivalWait("18. UUID tenu par une opération d'acompte rivale",
    (u, k) => installGateOn("b067_rival_op", "advance_operations", `new.operation_uuid = '${u}'`, k, true),
    (u) => declare(B.owner.client, B.pid, "5000", revB18, u),
    () => dropDelay("b067_rival_op", "advance_operations"));
  const ok18 = await authorize(E17.contractor.client, E17.pid, await rev(E17.pid));
  record("18. Compte revérifié — l'autorisation réussit ensuite normalement", !ok18.error, err(ok18));

  // 19. Auteur historique conservé après transfert du rôle CONTRACTOR (M006b).
  const chef = await createTestUser("divergence-chef");
  await must(service.from("project_memberships").insert({ project_id: V.pid, profile_id: chef.id, role: "SITE_MANAGER", owner_profile: null }), "chef");
  const authorV = await membershipId(V.pid, V.contractor.id);
  const wsV = await wsRow(V.pid);
  await must(V.contractor.client.rpc("transfer_contractor_role", { p_project_id: V.pid, p_successor_membership_id: await membershipId(V.pid, chef.id), p_reason: "Changement d'entreprise" }), "transfert");
  const newC = one(await chef.client.rpc("get_work_start", { p_project_id: V.pid }));
  const ownV = one(await V.owner.client.rpc("get_work_start", { p_project_id: V.pid }));
  record("19. Après transfert — nouveau CONTRACTOR et OWNER voient l'auteur d'origine (même repère), authorized_by_me faux pour le successeur",
    !newC.error && newC.row.authorized_by_membership_id === authorV && newC.row.authorized_by_me === false && ownV.row.authorized_by_membership_id === authorV, `${err(newC)} ${newC.row?.authorized_by_membership_id}`);
  const oldFull = await V.contractor.client.rpc("get_work_start", { p_project_id: V.pid });
  const oldSum = one(await V.contractor.client.rpc("get_work_start_summary", { p_project_id: V.pid }));
  record("19. Ancien auteur devenu SITE_MANAGER — lecture complète refusée, résumé strictement fait + date",
    oldFull.error?.message === "not_authorized" && same(Object.keys(oldSum.row).sort(), ["authorized", "authorized_at_server"]), err(oldFull));
  record("19. Enregistrement d'autorisation inchangé après transfert", same(await wsRow(V.pid), wsV));

  // 20. Commande B033 bloquée sur le verrou d'operation_uuid (M027c) :
  // rivale tenant le même UUID, déclaration réellement envoyée, compte rendu
  // provisoire (ou non, contrôle positif) pendant l'attente, rollback rival.
  const advFootprint = async (pid) => ({
    advances: (await service.from("advances").select("id").eq("project_id", pid)).data.length,
    seqs: await seqs(pid),
    audits: (await service.from("audit_events").select("id").eq("project_id", pid).like("action", "ADVANCE%")).data.length,
    revision: (await ledger(pid)).revision,
  });
  async function b033BlockedDeclare(label, makeProvisional) {
    const before = await advFootprint(E17.pid);
    const u = randomUUID();
    let rRival, rDecl, elapsed, waited;
    try {
      const revB20 = await rev(B.pid);
      const w = await withRivalAtGate(`b067_rival_b033-${label}`, {
        install: (k) => installGateOn("b067_rival_b033", "advance_operations", `new.operation_uuid = '${u}' and new.project_id = '${B.pid}'`, k, true),
        startRival: () => declare(B.owner.client, B.pid, "5000", revB20, u),
        startCall: () => declare(E17.owner.client, E17.pid, "7000", before.revision, u),
        duringWait: makeProvisional ? () => setVerified(E17.owner.id, false) : undefined,
        minElapsedMs: 2000,
      });
      ({ rRival, rCall: rDecl, elapsed, waited } = w);
    } finally { await dropDelay("b067_rival_b033", "advance_operations"); await setVerified(E17.owner.id, true); }
    return { before, after: await advFootprint(E17.pid), rRival, rDecl, elapsed, waited, op: await opRow(u) };
  }
  const neg = await b033BlockedDeclare("provisoire", true);
  record(`20. B033 declare bloqué ${neg.elapsed} ms (UUID tenu par une rivale annulée), compte rendu provisoire pendant l'attente — account_provisional`,
    neg.waited && neg.rRival.error?.message === "forced_failure" && neg.rDecl.error?.message === "account_provisional" && neg.elapsed >= 1500, `attente ${neg.waited ? "constatée" : "NON constatée"}, ${err(neg.rRival)} / ${err(neg.rDecl)}`);
  record("20. Aucune mutation persistée (versement, événement, audit, opération, compteur, révision)",
    same(neg.after, neg.before) && neg.op === null, JSON.stringify({ before: neg.before, after: neg.after }));
  const pos = await b033BlockedDeclare("vérifié", false);
  record(`20. Contrôle positif — compte toujours vérifié, même scénario, bloqué ${pos.elapsed} ms puis déclaration réussie après le rollback rival`,
    pos.waited && pos.rRival.error?.message === "forced_failure" && !pos.rDecl.error && pos.rDecl.row.replayed === false && pos.elapsed >= 1500 &&
    pos.after.advances === pos.before.advances + 1 && pos.after.seqs.length === pos.before.seqs.length + 1 && contiguous(pos.after.seqs) &&
    pos.after.audits === pos.before.audits + 1 && pos.op?.project_id === E17.pid && pos.op?.command === "DECLARE", `${err(pos.rRival)} / ${err(pos.rDecl)}`);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} vérifications réussies`);
  process.exit(passed === results.length ? 0 : 1);
}
const qvPlan = (r) => r.data.plan_version_id;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
