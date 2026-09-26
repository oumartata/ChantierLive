// Test d'intégration LOCAL uniquement pour B065 (M021 : devis, versions,
// lignes, propositions, décisions). Risques couverts : droits (D112),
// plan retenu ET publié (D113), une seule proposition / aucune version après
// acceptation (D114), précision numérique et bornes (D115), lecture des
// estimations privées (D116), immutabilité dont l'ajout tardif de ligne,
// révision, attentes réelles sur verrou et audit transactionnel.
//
// Courses : chaque appel concurrent est ENVOYÉ (.then) avant la mutation
// testée (appels supabase-js paresseux).
//
// Usage : node scripts/test-quotes.mjs

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
  const email = `b065-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
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
const project = async (id) => (await service.from("projects").select("revision, retained_plan_version_id, published_plan_version_id").eq("id", id).single()).data;
async function retain(owner, pid, versionId) {
  await must(owner.client.rpc("set_retained_project_plan_version", { p_project_id: pid, p_version_id: versionId, p_expected_revision: (await project(pid)).revision }), "retain");
}
async function validateAndPublish(contractor, engineer, designationId, pid, versionId) {
  const val = await must(contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: versionId, p_designation_id: designationId }), "submit");
  await must(engineer.client.rpc("decide_plan_validation", { p_validation_id: val.id, p_decision: "VALIDATED", p_note: null }), "decide");
  await must(contractor.client.rpc("publish_project_plan_version", { p_project_id: pid, p_version_id: versionId, p_expected_revision: (await project(pid)).revision }), "publish");
}
const state = async (client, pid) => {
  const r = await client.rpc("get_quote_state", { p_project_id: pid });
  return { ...r, row: Array.isArray(r.data) ? r.data[0] : r.data };
};
const rev = async (client, pid) => (await state(client, pid)).row.revision;
const line = (label, quantity, price, unit = "u") => ({ label, unit, quantity, unit_price_fcfa: price });
const estimate = async (client, pid, lines, revision) =>
  client.rpc("create_quote_estimate", { p_project_id: pid, p_lines: lines, p_expected_revision: revision });
const versionRow = async (id) => (await service.from("quote_versions").select("*").eq("id", id).single()).data;

async function main() {
  // Mise en place : chantier d'agence, plan retenu PUIS publié (B063/B064).
  const contractor = await createTestUser("contractor");
  const owner = await createTestUser("owner");
  const coOwner = await createTestUser("coowner");
  const siteManager = await createTestUser("sm");
  const engineer = await createTestUser("engineer");
  const { data: proj } = await contractor.client.rpc("create_draft_project", { p_name: "B065 — chantier", p_country: "ML", p_role: "CONTRACTOR" });
  const { project_id: pid, organization_id: orgId } = Array.isArray(proj) ? proj[0] : proj;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [siteManager, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), "membership");
  }
  const designation = await must(contractor.client.rpc("designate_plan_engineer", { p_organization_id: orgId, p_identifier_kind: "EMAIL", p_identifier_value: engineer.email }), "designate");

  // 1. Plan requis (D113).
  const noPlan = await estimate(contractor.client, pid, [line("Fondations", "1", "1000")], 0);
  record("1. Estimation refusée sans plan retenu (no_retained_plan)", noPlan.error?.message === "no_retained_plan", err(noPlan));
  const planA = await deposit(owner.client, pid, "PLAN-A");
  await retain(owner, pid, planA.id);

  // 2. Rôles de création (QUOTE_CREATE : CONTRACTOR seul).
  for (const [label, u] of [["OWNER/PRIMARY", owner], ["CO_OWNER", coOwner], ["SITE_MANAGER", siteManager]]) {
    const r = await estimate(u.client, pid, [line("x", "1", "1")], 0);
    record(`2. Estimation refusée — ${label}`, r.error?.message === "not_authorized", err(r));
  }

  // 3. Précision numérique (D115) : arrondi demi vers le haut, total = somme des lignes arrondies.
  const e1 = await estimate(contractor.client, pid, [
    line("Demi vers le haut", "2.5", "3"),      // 7.5 -> 8
    line("Juste sous le demi", "0.333", "1"),   // 0.333 -> 0
    line("Proche du demi", "1.499", "1"),       // 1.499 -> 1
    line("Tiers", "0.333", "3"),                // 0.999 -> 1
    line("Grand", "1000000", "999999"),         // 999 999 000 000
  ], 0);
  const e1Lines = (await service.from("quote_version_lines").select("line_amount_fcfa, quantity").eq("version_id", e1.data?.id).order("position")).data ?? [];
  record("3. Arrondi de chaque ligne au FCFA (demi vers le haut) : 8, 0, 1, 1, 999 999 000 000",
    e1.error === null && same(e1Lines.map((l) => String(l.line_amount_fcfa)), ["8", "0", "1", "1", "999999000000"]), err(e1));
  record("3. Total = somme exacte des montants de ligne arrondis", String(e1.data?.total_amount_fcfa) === "999999000010", String(e1.data?.total_amount_fcfa));
  const exact = await estimate(contractor.client, pid, [line("Borne exacte", "1000000", "1000000")], await rev(contractor.client, pid));
  record("3. Borne exacte acceptée — ligne et total de 1 000 000 000 000 FCFA", exact.error === null && String(exact.data.total_amount_fcfa) === "1000000000000", err(exact));

  let r0 = await rev(contractor.client, pid);
  const refusals = [
    ["4 décimales refusées sans arrondi", [line("x", "1.2345", "1")], "invalid_line"],
    ["quantité non numérique", [line("x", "abc", "1")], "invalid_line"],
    ["quantité transmise en nombre JSON (flottant)", [{ label: "x", unit: "u", quantity: 1.5, unit_price_fcfa: "1" }], "invalid_line"],
    ["prix décimal", [line("x", "1", "1.5")], "invalid_line"],
    ["quantité nulle", [line("x", "0", "1")], "amount_out_of_bounds"],
    ["quantité > 1 000 000", [line("x", "1000000.001", "1")], "amount_out_of_bounds"],
    ["prix > 10 000 000 000", [line("x", "1", "10000000001")], "amount_out_of_bounds"],
    ["ligne > 1e12", [line("x", "1000000", "1000001")], "amount_out_of_bounds"],
    ["total > 1e12", [line("a", "1000000", "1000000"), line("b", "1", "1")], "amount_out_of_bounds"],
    ["aucune ligne", [], "invalid_lines_count"],
    ["201 lignes", Array.from({ length: 201 }, (_, i) => line(`l${i}`, "1", "1")), "invalid_lines_count"],
    ["libellé vide", [line("   ", "1", "1")], "invalid_line"],
    ["unité > 20 caractères", [line("x", "1", "1", "u".repeat(21))], "invalid_line"],
  ];
  for (const [label, lines, code] of refusals) {
    const r = await estimate(contractor.client, pid, lines, r0);
    record(`3. Refus — ${label} (${code})`, r.error?.message === code, err(r));
  }
  record("3. Refus sans effet — révision inchangée", (await rev(contractor.client, pid)) === r0);

  // 4. Immutabilité, dont l'ajout TARDIF de ligne.
  const late = await service.from("quote_version_lines").insert({ version_id: e1.data.id, project_id: pid, position: 99, label: "Tardive", unit: "u", quantity: 1, unit_price_fcfa: 1, line_amount_fcfa: 1 });
  record("4. Ajout tardif d'une ligne à une version existante refusé", late.error?.message?.includes("quote_version_lines_closed"), late.error?.message);
  const lineUpd = await service.from("quote_version_lines").update({ unit_price_fcfa: 2 }).eq("version_id", e1.data.id);
  const lineDel = await service.from("quote_version_lines").delete().eq("version_id", e1.data.id);
  record("4. Lignes — modification et suppression refusées", lineUpd.error?.message?.includes("quote_version_line_immutable") && lineDel.error?.message?.includes("quote_version_line_immutable"));
  const verUpd = await service.from("quote_versions").update({ total_amount_fcfa: 1 }).eq("id", e1.data.id);
  const verDel = await service.from("quote_versions").delete().eq("id", e1.data.id);
  record("4. Version — total et suppression refusés", verUpd.error?.message?.includes("quote_version_immutable") && verDel.error?.message?.includes("quote_version_immutable"));
  const { data: quoteRow } = await service.from("quotes").select("id").eq("project_id", pid).single();
  const bare = await service.from("quote_versions").insert({ quote_id: quoteRow.id, project_id: pid, version_number: 90, plan_version_id: planA.id, total_amount_fcfa: 5, created_by_profile_id: contractor.id });
  record("4. Version insérée sans lignes (total incohérent) refusée à la validation de la transaction", bare.error?.message?.includes("quote_version_total_inconsistent"), bare.error?.message);
  const skip = await service.from("quote_versions").update({ status: "ACCEPTED" }).eq("id", e1.data.id);
  record("4. Transition ESTIMATE -> ACCEPTED directe refusée", skip.error?.message?.includes("quote_version_transition_refused"), skip.error?.message);

  // 5. Lecture (D116) : estimations privées.
  const ownerList = await owner.client.rpc("list_quote_versions", { p_project_id: pid });
  const coList = await coOwner.client.rpc("list_quote_versions", { p_project_id: pid });
  const ownerLines = await owner.client.rpc("get_quote_version_lines", { p_version_id: e1.data.id });
  const smList = await siteManager.client.rpc("list_quote_versions", { p_project_id: pid });
  const smState = await state(siteManager.client, pid);
  record("5. Estimation invisible — OWNER/PRIMARY et CO_OWNER : liste vide, lignes refusées",
    ownerList.error === null && ownerList.data.length === 0 && coList.data.length === 0 && ownerLines.error?.message === "not_authorized", err(ownerLines));
  record("5. SITE_MANAGER refusé partout", smList.error?.message === "not_authorized" && smState.error?.message === "not_authorized");
  const ownerState = (await state(owner.client, pid)).row;
  const coState = (await state(coOwner.client, pid)).row;
  record("5. État — OWNER/PRIMARY reçoit la révision (sans version), CO_OWNER non ; aucun pointeur vers l'estimation",
    ownerState.revision === r0 && coState.revision === null && ownerState.pending_version_id === null && ownerState.accepted_version_id === null);
  const decideEstimate = await owner.client.rpc("decide_quote_version", { p_version_id: e1.data.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: r0 });
  record("5. Décision sur une estimation — refus identique à une version inaccessible", decideEstimate.error?.message === "not_authorized", err(decideEstimate));

  // 6. Révision.
  const nullRev = await contractor.client.rpc("propose_quote_version", { p_version_id: e1.data.id, p_expected_revision: null });
  const staleRev = await contractor.client.rpc("propose_quote_version", { p_version_id: e1.data.id, p_expected_revision: r0 - 1 });
  record("6. Révision NULL refusée, révision périmée refusée (quote_conflict)", nullRev.error?.message === "expected_revision_required" && staleRev.error?.message === "quote_conflict", `${err(nullRev)} / ${err(staleRev)}`);

  // 7. Proposition : plan retenu ET publié (D113).
  const notPublished = await contractor.client.rpc("propose_quote_version", { p_version_id: e1.data.id, p_expected_revision: r0 });
  record("7. Proposition refusée — plan retenu mais non publié", notPublished.error?.message === "plan_not_retained_and_published", err(notPublished));
  await validateAndPublish(contractor, engineer, designation.id, pid, planA.id);
  const byOwner = await owner.client.rpc("propose_quote_version", { p_version_id: e1.data.id, p_expected_revision: await rev(owner.client, pid) });
  record("7. Proposition refusée — OWNER/PRIMARY", byOwner.error?.message === "not_authorized", err(byOwner));
  const e2 = await must(estimate(contractor.client, pid, [line("Maçonnerie", "12.5", "15000"), line("Toiture", "1", "2500000", "forfait")], await rev(contractor.client, pid)), "e2");
  const p2 = await contractor.client.rpc("propose_quote_version", { p_version_id: e2.id, p_expected_revision: await rev(contractor.client, pid) });
  record("7. Proposition — version PROPOSED, total 2 687 500 FCFA", p2.error === null && p2.data.status === "PROPOSED" && String(p2.data.total_amount_fcfa) === "2687500", err(p2));

  // 8. Lecture après proposition : l'estimation antérieure et une NOUVELLE estimation restent privées.
  const e3 = await must(estimate(contractor.client, pid, [line("Variante privée", "1", "999")], await rev(contractor.client, pid)), "e3");
  const ownerAfter = (await owner.client.rpc("list_quote_versions", { p_project_id: pid })).data ?? [];
  const coAfter = (await coOwner.client.rpc("list_quote_versions", { p_project_id: pid })).data ?? [];
  record("8. Après proposition — OWNER et CO_OWNER ne voient QUE la version proposée",
    ownerAfter.length === 1 && ownerAfter[0].version_id === e2.id && coAfter.length === 1, JSON.stringify(ownerAfter.map((v) => v.status)));
  const e3Lines = await owner.client.rpc("get_quote_version_lines", { p_version_id: e3.id });
  const pendingState = (await state(owner.client, pid)).row;
  record("8. Nouvelle estimation invisible ; pending pointe vers la version PROPOSED", e3Lines.error?.message === "not_authorized" && pendingState.pending_version_id === e2.id);

  // 9. Remplacement : une seule proposition en attente.
  const e4 = await must(estimate(contractor.client, pid, [line("Proposition 2", "2", "1500000")], await rev(contractor.client, pid)), "e4");
  const p4 = await contractor.client.rpc("propose_quote_version", { p_version_id: e4.id, p_expected_revision: await rev(contractor.client, pid) });
  const e2After = await versionRow(e2.id);
  const { data: prop4 } = await service.from("quote_proposals").select("supersedes_version_id").eq("version_id", e4.id).single();
  record("9. Nouvelle proposition — l'ancienne passe SUPERSEDED, trace conservée", p4.error === null && e2After.status === "SUPERSEDED" && prop4.supersedes_version_id === e2.id, err(p4));
  const { data: supersededRow } = await service.from("quote_versions").select("project_id").eq("id", prop4.supersedes_version_id).single();
  record("9. Clé composite — une proposition remplaçant une version du MÊME chantier est acceptée", p4.error === null && supersededRow.project_id === pid);
  const decideOld = await owner.client.rpc("decide_quote_version", { p_version_id: e2.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: await rev(owner.client, pid) });
  record("9. Décision sur la proposition remplacée refusée (version_not_pending)", decideOld.error?.message === "version_not_pending", err(decideOld));

  // 10. Décision : rôles et plan changé (D112/D113).
  for (const [label, u] of [["CO_OWNER", coOwner], ["CONTRACTOR", contractor], ["SITE_MANAGER", siteManager]]) {
    const r = await u.client.rpc("decide_quote_version", { p_version_id: e4.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: 0 });
    record(`10. Décision refusée — ${label}`, r.error?.message === "not_authorized", err(r));
  }
  const planB = await deposit(owner.client, pid, "PLAN-B");
  await retain(owner, pid, planB.id);
  const revBefore = await rev(owner.client, pid);
  const accChanged = await owner.client.rpc("decide_quote_version", { p_version_id: e4.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: revBefore });
  const e4AfterChange = await versionRow(e4.id);
  record("10. Acceptation refusée — plan retenu changé (plan_changed), aucune mutation",
    accChanged.error?.message === "plan_changed" && e4AfterChange.status === "PROPOSED" && (await rev(owner.client, pid)) === revBefore, err(accChanged));
  await retain(owner, pid, planA.id);

  // 11. Compte provisoire pendant une attente réelle -> refus, aucune mutation.
  const w1 = await callDuringRealWait(pid,
    () => owner.client.rpc("decide_quote_version", { p_version_id: e4.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: revBefore }),
    () => setVerified(owner.id, false));
  await setVerified(owner.id, true);
  record("11. Compte provisoire pendant l'attente — décision refusée, version toujours PROPOSED",
    w1.elapsed >= 2500 && w1.res.error?.message === "account_provisional" && (await versionRow(e4.id)).status === "PROPOSED", `${w1.elapsed}ms ${err(w1.res)}`);

  // 12. Échec d'audit -> décision, montant et révision annulés.
  const revAudit = await rev(owner.client, pid);
  await psql(`create or replace function public.b065_fail_audit() returns trigger language plpgsql as $f$ begin if new.action = 'QUOTE_ACCEPTED' then raise exception 'audit_test_failure'; end if; return new; end $f$;
create trigger b065_fail_audit before insert on public.audit_events for each row execute function public.b065_fail_audit();\n`);
  let auditFail;
  try {
    auditFail = await owner.client.rpc("decide_quote_version", { p_version_id: e4.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: revAudit });
  } finally {
    await psql("drop trigger if exists b065_fail_audit on public.audit_events; drop function if exists public.b065_fail_audit();\n");
  }
  const afterAudit = (await state(owner.client, pid)).row;
  const decisionsAfterFail = (await service.from("quote_decisions").select("id").eq("version_id", e4.id)).data.length;
  record("12. Échec d'audit — décision annulée : PROPOSED, aucune décision, montant NULL, révision inchangée",
    auditFail.error?.message === "audit_test_failure" && (await versionRow(e4.id)).status === "PROPOSED" && decisionsAfterFail === 0 &&
      afterAudit.contract_amount_fcfa === null && afterAudit.revision === revAudit, err(auditFail));

  // 13. Décision unique : deux décisions concurrentes réellement envoyées.
  const revRace = await rev(owner.client, pid);
  const [dA, dB] = await Promise.all([
    owner.client.rpc("decide_quote_version", { p_version_id: e4.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: revRace }),
    owner.client.rpc("decide_quote_version", { p_version_id: e4.id, p_decision: "REFUSED", p_reason: "course", p_expected_revision: revRace }),
  ]);
  const ok = [dA, dB].filter((r) => r.error === null);
  const ko = [dA, dB].filter((r) => ["quote_conflict", "version_not_pending"].includes(r.error?.message));
  const decisions = (await service.from("quote_decisions").select("decision").eq("version_id", e4.id)).data;
  record("13. Décisions concurrentes — une seule aboutit, une seule ligne de décision", ok.length === 1 && ko.length === 1 && decisions.length === 1, JSON.stringify([err(dA), err(dB)]));
  let accepted = ok[0]?.data?.status === "ACCEPTED";
  if (!accepted) {
    // La course a retenu le refus : nouvelle estimation proposée puis acceptée.
    const e5 = await must(estimate(contractor.client, pid, [line("Proposition 2", "2", "1500000")], await rev(contractor.client, pid)), "e5");
    await must(contractor.client.rpc("propose_quote_version", { p_version_id: e5.id, p_expected_revision: await rev(contractor.client, pid) }), "p5");
    await must(owner.client.rpc("decide_quote_version", { p_version_id: e5.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: await rev(owner.client, pid) }), "d5");
    accepted = true;
  }

  // 14. Montant contractuel = seule version acceptée ; aucune nouvelle version ensuite (D114).
  const final = (await state(owner.client, pid)).row;
  const coFinal = (await state(coOwner.client, pid)).row;
  const contractorFinal = (await state(contractor.client, pid)).row;
  record("14. Montant contractuel = total de la version acceptée (3 000 000 FCFA), identique pour OWNER, CO_OWNER, CONTRACTOR",
    final.contract_amount_fcfa === "3000000" && coFinal.contract_amount_fcfa === "3000000" && contractorFinal.contract_amount_fcfa === "3000000", final.contract_amount_fcfa);
  const afterAcceptEstimate = await estimate(contractor.client, pid, [line("Après", "1", "1")], contractorFinal.revision);
  const afterAcceptPropose = await contractor.client.rpc("propose_quote_version", { p_version_id: e3.id, p_expected_revision: contractorFinal.revision });
  record("14. Après acceptation — nouvelle estimation et proposition refusées (quote_accepted)",
    afterAcceptEstimate.error?.message === "quote_accepted" && afterAcceptPropose.error?.message === "quote_accepted", `${err(afterAcceptEstimate)} / ${err(afterAcceptPropose)}`);
  const acceptedRow = await versionRow(final.accepted_version_id);
  const accUpd = await service.from("quote_versions").update({ status: "REFUSED" }).eq("id", final.accepted_version_id);
  const quoteUpd = await service.from("quotes").update({ accepted_version_id: e3.id }).eq("project_id", pid);
  const decUpd = await service.from("quote_decisions").delete().eq("version_id", final.accepted_version_id);
  record("14. Version acceptée intacte — changement de statut, de pointeur et suppression de décision refusés",
    accUpd.error?.message?.includes("quote_version_transition_refused") && !!quoteUpd.error && decUpd.error?.message?.includes("quote_event_immutable") &&
      same(await versionRow(final.accepted_version_id), acceptedRow));
  const audits = (await service.from("audit_events").select("action").eq("project_id", pid).in("action", ["QUOTE_PROPOSED", "QUOTE_ACCEPTED", "QUOTE_REFUSED"])).data.map((a) => a.action);
  record("14. Audit — propositions et décisions tracées", audits.filter((a) => a === "QUOTE_PROPOSED").length >= 2 && audits.includes("QUOTE_ACCEPTED"), JSON.stringify(audits));

  // 15. Adhésion révoquée pendant une attente réelle, et isolation entre chantiers.
  const other = await createTestUser("other-contractor");
  const { data: otherProj } = await other.client.rpc("create_draft_project", { p_name: "B065 — autre", p_country: "ML", p_role: "CONTRACTOR" });
  const otherPid = (Array.isArray(otherProj) ? otherProj[0] : otherProj).project_id;
  const otherOwner = await createTestUser("other-owner");
  await must(service.from("project_memberships").insert({ project_id: otherPid, profile_id: otherOwner.id, role: "OWNER", owner_profile: "PRIMARY" }), "m");
  const planO = await deposit(otherOwner.client, otherPid, "PLAN-O");
  await retain(otherOwner, otherPid, planO.id);
  const eo = await must(estimate(other.client, otherPid, [line("o", "1", "10")], 0), "eo");
  const crossRead = await contractor.client.rpc("list_quote_versions", { p_project_id: otherPid });
  const crossLines = await contractor.client.rpc("get_quote_version_lines", { p_version_id: eo.id });
  const crossPropose = await contractor.client.rpc("propose_quote_version", { p_version_id: eo.id, p_expected_revision: 1 });
  const crossSupersede = await service.from("quote_proposals").insert({
    version_id: e3.id, project_id: pid, proposed_by_profile_id: contractor.id, proposed_at_server: new Date().toISOString(),
    published_plan_version_id: planA.id, supersedes_version_id: eo.id,
  });
  record("15. Clé composite — insertion privilégiée référençant une version remplacée d'un AUTRE chantier refusée",
    crossSupersede.error?.message?.includes("quote_proposals_supersedes_project_fk"), crossSupersede.error?.message);
  record("15. Isolation — aucun accès aux devis d'un autre chantier", crossRead.error?.message === "not_authorized" && crossLines.error?.message === "not_authorized" && crossPropose.error?.message === "not_authorized");
  const { data: membership } = await service.from("project_memberships").select("id").eq("project_id", otherPid).eq("profile_id", other.id).single();
  const w2 = await callDuringRealWait(otherPid,
    () => other.client.rpc("create_quote_estimate", { p_project_id: otherPid, p_lines: [line("p", "1", "1")], p_expected_revision: 1 }),
    async () => { await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("id", membership.id), "revoke"); });
  const countO = (await service.from("quote_versions").select("id").eq("project_id", otherPid)).data.length;
  record("15. Adhésion révoquée pendant l'attente — estimation refusée, aucune version créée",
    w2.elapsed >= 2500 && w2.res.error?.message === "not_authorized" && countO === 1, `${w2.elapsed}ms ${err(w2.res)}`);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} tests réussis.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERREUR:", e.message);
  process.exitCode = 1;
});
