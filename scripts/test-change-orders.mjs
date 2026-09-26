// Test d'intégration LOCAL uniquement pour B066 (M022 : avenants, versions,
// lignes, propositions, décisions, autorisations d'exécution). Risques
// couverts : devis accepté requis et rattachement exact (D121), droits
// (D117/D118), montants positifs (D119), avenants parallèles et proposition
// unique par avenant (D120), avenant accepté figé (D122), champs obligatoires
// (D123), transitions et audit sans brouillon (D124), autorisation unique
// (D125), montant contractuel compté une fois (BR094), clés composites,
// révision, attentes réelles sur verrou et audit transactionnel.
//
// Courses : chaque appel concurrent est ENVOYÉ (.then) avant la mutation
// testée (appels supabase-js paresseux).
//
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
  const email = `b066-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
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
const coRow = async (id) => (await service.from("change_orders").select("*").eq("id", id).single()).data;
const verRow = async (id) => (await service.from("change_order_versions").select("*").eq("id", id).single()).data;
const coRev = async (id) => (await coRow(id)).revision;
const draft = (client, pid, coId, lines, revision, title = "Extension terrasse", reason = "Demande du client en cours de travaux") =>
  client.rpc("create_change_order_estimate", { p_project_id: pid, p_change_order_id: coId, p_title: title, p_reason: reason, p_lines: lines, p_expected_revision: revision });
const propose = async (client, versionId, revision) =>
  client.rpc("propose_change_order_version", { p_version_id: versionId, p_expected_revision: revision ?? (await coRev((await verRow(versionId)).change_order_id)) });
const decide = async (client, versionId, decision, revision, reason = null) =>
  client.rpc("decide_change_order_version", { p_version_id: versionId, p_decision: decision, p_reason: reason, p_expected_revision: revision ?? (await coRev((await verRow(versionId)).change_order_id)) });
const amount = async (client, pid) => {
  const r = await client.rpc("get_contract_amount", { p_project_id: pid });
  return { ...r, row: Array.isArray(r.data) ? r.data[0] : r.data };
};
const coAudits = async (pid) => (await service.from("audit_events").select("action").eq("project_id", pid).like("action", "CHANGE_ORDER%")).data.map((a) => a.action);

// Chantier avec devis PROPOSÉ (plan retenu, validé, publié) ; accept() l'accepte.
async function quotedProject(tag, extra = {}) {
  const contractor = await createTestUser(`${tag}-contractor`);
  const owner = await createTestUser(`${tag}-owner`);
  const engineer = await createTestUser(`${tag}-engineer`);
  const { data: proj } = await contractor.client.rpc("create_draft_project", { p_name: `B066 — ${tag}`, p_country: "ML", p_role: "CONTRACTOR" });
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

async function main() {
  const P = await quotedProject("main", { members: [["coOwner", "OWNER", "CO_OWNER"], ["siteManager", "SITE_MANAGER", null]] });
  const { pid, contractor, owner, coOwner, siteManager } = P;
  const outsider = await createTestUser("outsider");

  // 1. Devis accepté requis (D121).
  const early = await draft(contractor.client, pid, null, [line("Terrasse", "1", "100000")], 0);
  record("1. Avenant refusé tant que le devis n'est que proposé (quote_not_accepted)", early.error?.message === "quote_not_accepted", err(early));
  await P.accept();
  const { data: quoteRow } = await service.from("quotes").select("id, accepted_version_id").eq("project_id", pid).single();

  // 2. Création : CONTRACTOR seul.
  for (const [label, u] of [["OWNER/PRIMARY", owner], ["CO_OWNER", coOwner], ["SITE_MANAGER", siteManager], ["tiers", outsider]]) {
    const r = await draft(u.client, pid, null, [line("x", "1", "1")], 0);
    record(`2. Création refusée — ${label}`, r.error?.message === "not_authorized", err(r));
  }

  // 3. Champs obligatoires (D123) et montants positifs (D119).
  const invalid = [
    ["titre vide", [line("x", "1", "1")], "  ", undefined, "invalid_title"],
    ["titre 201 caractères", [line("x", "1", "1")], "t".repeat(201), undefined, "invalid_title"],
    ["motif vide", [line("x", "1", "1")], undefined, "", "invalid_reason"],
    ["motif 1001 caractères", [line("x", "1", "1")], undefined, "m".repeat(1001), "invalid_reason"],
    ["aucune ligne", [], undefined, undefined, "invalid_lines_count"],
    ["201 lignes", Array.from({ length: 201 }, (_, i) => line(`l${i}`, "1", "1")), undefined, undefined, "invalid_lines_count"],
    ["4 décimales", [line("x", "1.2345", "1")], undefined, undefined, "invalid_line"],
    ["quantité en nombre JSON", [{ label: "x", unit: "u", quantity: 1.5, unit_price_fcfa: "1" }], undefined, undefined, "invalid_line"],
    ["prix négatif", [line("x", "1", "-5")], undefined, undefined, "invalid_line"],
    ["quantité négative", [line("x", "-1", "5")], undefined, undefined, "invalid_line"],
    ["prix nul (ligne à 0)", [line("x", "1", "0")], undefined, undefined, "line_amount_not_positive"],
    ["ligne arrondie à 0", [line("x", "0.333", "1")], undefined, undefined, "line_amount_not_positive"],
    ["total nul malgré une ligne positive", [line("a", "1", "5"), line("b", "1", "0")], undefined, undefined, "line_amount_not_positive"],
    ["total > 1e12", [line("a", "1000000", "1000000"), line("b", "1", "1")], undefined, undefined, "amount_out_of_bounds"],
  ];
  for (const [label, lines, title, reason, code] of invalid) {
    const r = await draft(contractor.client, pid, null, lines, 0, title, reason);
    record(`3. Refus — ${label} (${code})`, r.error?.message === code, err(r));
  }
  record("3. Refus sans effet — aucun avenant créé", (await service.from("change_orders").select("id").eq("project_id", pid)).data.length === 0);

  // 4. Avenant A : brouillon exact, privé, sans audit.
  const a1 = await draft(contractor.client, pid, null, [line("Terrasse", "12.5", "15000", "m2"), line("Garde-corps", "2.5", "3")], 0);
  const A = a1.data?.change_order_id;
  const aRow = A ? await coRow(A) : {};
  record("4. Brouillon créé — total exact 187 508 FCFA, rattaché à la version acceptée du devis, révision 1",
    a1.error === null && String(a1.data.total_amount_fcfa) === "187508" && a1.data.status === "ESTIMATE" &&
      aRow.quote_id === quoteRow.id && aRow.accepted_quote_version_id === quoteRow.accepted_version_id && aRow.revision === 1, err(a1));
  const ownerList0 = await owner.client.rpc("list_change_orders", { p_project_id: pid });
  const coList0 = await coOwner.client.rpc("list_change_orders", { p_project_id: pid });
  const ownerLines0 = await owner.client.rpc("get_change_order_version_lines", { p_version_id: a1.data.id });
  const ownerDecide0 = await decide(owner.client, a1.data.id, "ACCEPTED");
  const contractorList0 = await contractor.client.rpc("list_change_orders", { p_project_id: pid });
  record("4. Brouillon privé — OWNER/CO_OWNER : liste vide, lignes et décision refusées (not_authorized)",
    ownerList0.data?.length === 0 && coList0.data?.length === 0 && ownerLines0.error?.message === "not_authorized" && ownerDecide0.error?.message === "not_authorized",
    `${err(ownerLines0)} / ${err(ownerDecide0)}`);
  record("4. CONTRACTOR voit son brouillon", contractorList0.data?.length === 1 && contractorList0.data[0].status === "ESTIMATE");
  const smCalls = [
    await siteManager.client.rpc("list_change_orders", { p_project_id: pid }),
    await siteManager.client.rpc("get_change_order_version_lines", { p_version_id: a1.data.id }),
    await siteManager.client.rpc("get_contract_amount", { p_project_id: pid }),
    await outsider.client.rpc("list_change_orders", { p_project_id: pid }),
    await outsider.client.rpc("get_contract_amount", { p_project_id: pid }),
  ];
  record("4. SITE_MANAGER et tiers refusés (liste, lignes, montant)", smCalls.every((r) => r.error?.message === "not_authorized"));
  record("4. Aucun audit pour un brouillon (jamais CHANGE_ORDER_CREATED)", (await coAudits(pid)).length === 0);

  // 5. Immutabilité et invariants directs (écriture privilégiée).
  const late = await service.from("change_order_version_lines").insert({ version_id: a1.data.id, project_id: pid, position: 99, label: "Tardive", unit: "u", quantity: 1, unit_price_fcfa: 1, line_amount_fcfa: 1 });
  record("5. Ajout tardif d'une ligne refusé", late.error?.message?.includes("change_order_version_lines_closed"), late.error?.message);
  const lUpd = await service.from("change_order_version_lines").update({ unit_price_fcfa: 2 }).eq("version_id", a1.data.id);
  const lDel = await service.from("change_order_version_lines").delete().eq("version_id", a1.data.id);
  record("5. Lignes — modification et suppression refusées", lUpd.error?.message?.includes("change_order_version_line_immutable") && lDel.error?.message?.includes("change_order_version_line_immutable"));
  const vTitle = await service.from("change_order_versions").update({ title: "Autre" }).eq("id", a1.data.id);
  const vTotal = await service.from("change_order_versions").update({ total_amount_fcfa: 1 }).eq("id", a1.data.id);
  const vDel = await service.from("change_order_versions").delete().eq("id", a1.data.id);
  const cDel = await service.from("change_orders").delete().eq("id", A);
  record("5. Version (titre, total, suppression) et avenant (suppression) immuables",
    vTitle.error?.message?.includes("change_order_version_immutable") && vTotal.error?.message?.includes("change_order_version_immutable") &&
      vDel.error?.message?.includes("change_order_version_immutable") && cDel.error?.message?.includes("change_order_immutable"));
  const bare = await service.from("change_order_versions").insert({ change_order_id: A, project_id: pid, version_number: 90, title: "t", reason: "r", total_amount_fcfa: 5, created_by_profile_id: contractor.id });
  record("5. Version sans lignes refusée à la validation (total incohérent)", bare.error?.message?.includes("change_order_version_total_inconsistent"), bare.error?.message);
  const zero = await service.from("change_order_versions").insert({ change_order_id: A, project_id: pid, version_number: 91, title: "t", reason: "r", total_amount_fcfa: 0, created_by_profile_id: contractor.id });
  // Déclencheurs contournés par une transaction qui crée la version : la contrainte de table s'applique.
  const zeroLine = await psqlError(`begin;
with v as (insert into public.change_order_versions (change_order_id, project_id, version_number, title, reason, total_amount_fcfa, created_by_profile_id)
  values ('${A}', '${pid}', 94, 't', 'r', 1, '${contractor.id}') returning id)
insert into public.change_order_version_lines (version_id, project_id, position, label, unit, quantity, unit_price_fcfa, line_amount_fcfa)
  select id, '${pid}', 1, 'z', 'u', 1, 0, 0 from v;
commit;\n`);
  record("5. Contraintes de table — total 0 et ligne à 0 refusés même en écriture privilégiée",
    zero.error?.message?.includes("change_order_versions_total_amount_fcfa_check") && /change_order_version_lines_(unit_price|line_amount)_fcfa_check/.test(zeroLine), `${zero.error?.message} / ${zeroLine}`);
  const skip = await service.from("change_order_versions").update({ status: "ACCEPTED" }).eq("id", a1.data.id);
  const startProposed = await service.from("change_order_versions").insert({ change_order_id: A, project_id: pid, version_number: 92, status: "PROPOSED", title: "t", reason: "r", total_amount_fcfa: 5, created_by_profile_id: contractor.id });
  record("5. Transitions — ESTIMATE -> ACCEPTED directe et insertion directe PROPOSED refusées",
    skip.error?.message?.includes("change_order_version_transition_refused") && startProposed.error?.message?.includes("change_order_version_must_start_as_estimate"));
  const wrongQuote = await service.from("change_orders").insert({ project_id: pid, quote_id: quoteRow.id, accepted_quote_version_id: (await must(contractor.client.rpc("list_quote_versions", { p_project_id: pid }), "lqv")).find((v) => v.version_id !== quoteRow.accepted_version_id)?.version_id ?? randomUUID(), created_by_profile_id: contractor.id });
  const ownRebind = await service.from("change_orders").update({ accepted_quote_version_id: randomUUID() }).eq("id", A);
  record("5. Rattachement — avenant hors version acceptée refusé, rattachement non modifiable",
    !!wrongQuote.error && ownRebind.error?.message?.includes("change_order_immutable"), `${wrongQuote.error?.message} / ${ownRebind.error?.message}`);

  // 6. Révision.
  const nullRev = await contractor.client.rpc("propose_change_order_version", { p_version_id: a1.data.id, p_expected_revision: null });
  const staleRev = await propose(contractor.client, a1.data.id, 0);
  const newStale = await draft(contractor.client, pid, null, [line("x", "1", "1")], 1);
  const nullDraft = await draft(contractor.client, pid, A, [line("x", "1", "1")], null);
  record("6. Révision NULL refusée, révision périmée refusée (change_order_conflict), nouvel avenant exige 0",
    nullRev.error?.message === "expected_revision_required" && staleRev.error?.message === "change_order_conflict" &&
      newStale.error?.message === "change_order_conflict" && nullDraft.error?.message === "expected_revision_required");

  // 7. Propositions parallèles (D120).
  const byOwner = await propose(owner.client, a1.data.id);
  record("7. Proposition refusée — OWNER/PRIMARY", byOwner.error?.message === "not_authorized", err(byOwner));
  const pa1 = await propose(contractor.client, a1.data.id);
  const b1 = await must(draft(contractor.client, pid, null, [line("Clôture", "40", "25000", "ml")], 0, "Clôture", "Ajout demandé"), "b1");
  const B = b1.change_order_id;
  const pb1 = await propose(contractor.client, b1.id);
  const ownerList1 = (await owner.client.rpc("list_change_orders", { p_project_id: pid })).data ?? [];
  record("7. Deux avenants distincts PROPOSED simultanément, visibles du client",
    pa1.error === null && pb1.error === null && ownerList1.filter((v) => v.status === "PROPOSED" && v.is_pending).length === 2, JSON.stringify(ownerList1.map((v) => v.status)));
  record("7. Audit — CHANGE_ORDER_PROPOSED ×2", (await coAudits(pid)).filter((a) => a === "CHANGE_ORDER_PROPOSED").length === 2);
  const coRevisionHidden = (await coOwner.client.rpc("list_change_orders", { p_project_id: pid })).data ?? [];
  record("7. CO_OWNER voit les propositions sans révision ; OWNER/PRIMARY reçoit la révision",
    coRevisionHidden.length === 2 && coRevisionHidden.every((v) => v.revision === null) && ownerList1.every((v) => Number.isInteger(v.revision)));

  // 8. Remplacement : une seule proposition par avenant.
  const a2 = await must(draft(contractor.client, pid, A, [line("Terrasse agrandie", "15", "15000", "m2")], await coRev(A), "Extension terrasse v2"), "a2");
  const a2Hidden = await owner.client.rpc("get_change_order_version_lines", { p_version_id: a2.id });
  record("8. Nouvelle version en brouillon invisible du client pendant qu'une proposition est en attente", a2Hidden.error?.message === "not_authorized");
  const pa2 = await propose(contractor.client, a2.id);
  const { data: propA2 } = await service.from("change_order_proposals").select("supersedes_version_id").eq("version_id", a2.id).single();
  record("8. Nouvelle proposition — l'ancienne passe SUPERSEDED, trace conservée, avenant B non affecté",
    pa2.error === null && (await verRow(a1.data.id)).status === "SUPERSEDED" && propA2.supersedes_version_id === a1.data.id && (await verRow(b1.id)).status === "PROPOSED", err(pa2));
  const a3 = await must(draft(contractor.client, pid, A, [line("Variante", "1", "1000")], await coRev(A), "Variante privée"), "a3");
  const twoProposed = await service.from("change_order_versions").update({ status: "PROPOSED" }).eq("id", a3.id);
  record("8. Deux versions PROPOSED pour le même avenant refusées (index unique)", twoProposed.error?.message?.includes("change_order_versions_one_proposed"), twoProposed.error?.message);
  const decideOld = await decide(owner.client, a1.data.id, "ACCEPTED");
  record("8. Décision sur la version remplacée refusée (version_not_pending)", decideOld.error?.message === "version_not_pending", err(decideOld));

  // 9. Décision : rôles (D117).
  for (const [label, u] of [["CO_OWNER", coOwner], ["CONTRACTOR", contractor], ["SITE_MANAGER", siteManager], ["tiers", outsider]]) {
    const r = await decide(u.client, a2.id, "ACCEPTED");
    record(`9. Décision refusée — ${label}`, r.error?.message === "not_authorized", err(r));
  }

  // 10. Refus de B : n'affecte ni A ni le devis.
  const before10 = (await amount(owner.client, pid)).row;
  const rb = await decide(owner.client, b1.id, "REFUSED", undefined, "Hors budget");
  const after10 = (await amount(owner.client, pid)).row;
  record("10. Refus de B — REFUSED, motif conservé, A toujours PROPOSED, montant contractuel inchangé (devis seul)",
    rb.error === null && rb.data.status === "REFUSED" && (await verRow(a2.id)).status === "PROPOSED" &&
      after10.contract_amount_fcfa === "10000000" && before10.contract_amount_fcfa === "10000000" && after10.accepted_change_order_count === 0, err(rb));

  // 11. Compte provisoire pendant une attente réelle.
  const revA = await coRev(A);
  const w1 = await callDuringRealWait(pid, () => decide(owner.client, a2.id, "ACCEPTED", revA), () => setVerified(owner.id, false));
  await setVerified(owner.id, true);
  record("11. Compte provisoire pendant l'attente — décision refusée, version toujours PROPOSED",
    w1.elapsed >= 2500 && w1.res.error?.message === "account_provisional" && (await verRow(a2.id)).status === "PROPOSED", `${w1.elapsed}ms ${err(w1.res)}`);

  // 12. Échec d'audit -> tout est annulé.
  await psql(`create or replace function public.b066_fail_audit() returns trigger language plpgsql as $f$ begin if new.action = 'CHANGE_ORDER_ACCEPTED' then raise exception 'audit_test_failure'; end if; return new; end $f$;
create trigger b066_fail_audit before insert on public.audit_events for each row execute function public.b066_fail_audit();\n`);
  let auditFail;
  try {
    auditFail = await decide(owner.client, a2.id, "ACCEPTED", revA);
  } finally {
    await psql("drop trigger if exists b066_fail_audit on public.audit_events; drop function if exists public.b066_fail_audit();\n");
  }
  const aAfterAudit = await coRow(A);
  record("12. Échec d'audit — décision annulée : PROPOSED, aucune décision, pointeurs et révision inchangés, montant inchangé",
    auditFail.error?.message === "audit_test_failure" && (await verRow(a2.id)).status === "PROPOSED" &&
      (await service.from("change_order_decisions").select("id").eq("version_id", a2.id)).data.length === 0 &&
      aAfterAudit.accepted_version_id === null && aAfterAudit.pending_version_id === a2.id && aAfterAudit.revision === revA &&
      (await amount(owner.client, pid)).row.contract_amount_fcfa === "10000000", err(auditFail));

  // 13. Décisions concurrentes.
  const [dA, dB] = await Promise.all([decide(owner.client, a2.id, "ACCEPTED", revA), decide(owner.client, a2.id, "REFUSED", revA, "course")]);
  const ok13 = [dA, dB].filter((r) => r.error === null);
  const ko13 = [dA, dB].filter((r) => ["change_order_conflict", "version_not_pending"].includes(r.error?.message));
  record("13. Décisions concurrentes — une seule aboutit, une seule ligne de décision",
    ok13.length === 1 && ko13.length === 1 && (await service.from("change_order_decisions").select("id").eq("version_id", a2.id)).data.length === 1, JSON.stringify([err(dA), err(dB)]));
  let acceptedA = a2.id;
  if (ok13[0]?.data?.status !== "ACCEPTED") {
    const a4 = await must(draft(contractor.client, pid, A, [line("Terrasse agrandie", "15", "15000", "m2")], await coRev(A), "Extension terrasse v3"), "a4");
    await must(propose(contractor.client, a4.id), "pa4");
    await must(decide(owner.client, a4.id, "ACCEPTED"), "da4");
    acceptedA = a4.id;
  }

  // 14. Montant contractuel : devis + avenants acceptés, chacun une fois.
  const c1 = await must(draft(contractor.client, pid, null, [line("Portail", "1", "450000", "u")], 0, "Portail", "Ajout"), "c1");
  await must(propose(contractor.client, c1.id), "pc1");
  await must(decide(owner.client, c1.id, "ACCEPTED"), "dc1");
  const d1 = await must(draft(contractor.client, pid, null, [line("Piscine", "1", "9000000", "forfait")], 0, "Piscine", "Option"), "d1");
  await must(propose(contractor.client, d1.id), "pd1");
  const e1 = await must(draft(contractor.client, pid, null, [line("Brouillon", "1", "777", "u")], 0, "Privé", "Brouillon"), "e1");
  const views = await Promise.all([owner, coOwner, contractor].map((u) => amount(u.client, pid)));
  record("14. Montant = 10 000 000 + 225 000 (A) + 450 000 (C) = 10 675 000 ; 2 avenants comptés ; B refusé, D proposé, brouillons exclus ; identique pour OWNER, CO_OWNER, CONTRACTOR",
    views.every((v) => v.row.contract_amount_fcfa === "10675000" && v.row.change_orders_amount_fcfa === "675000" && v.row.accepted_change_order_count === 2 && v.row.quote_amount_fcfa === "10000000"),
    JSON.stringify(views[0].row));
  record("14. Montant renvoyé en texte exact (sans flottant)", typeof views[0].row.contract_amount_fcfa === "string");

  // 15. Avenant accepté figé (D122).
  const revAcc = await coRev(A);
  const afterAccDraft = await draft(contractor.client, pid, A, [line("x", "1", "1")], revAcc);
  const afterAccPropose = await propose(contractor.client, a3.id, revAcc);
  const afterAccInsert = await service.from("change_order_versions").insert({ change_order_id: A, project_id: pid, version_number: 93, title: "t", reason: "r", total_amount_fcfa: 5, created_by_profile_id: contractor.id });
  record("15. Après acceptation — nouvelle version et proposition refusées (change_order_accepted), même en écriture privilégiée",
    afterAccDraft.error?.message === "change_order_accepted" && afterAccPropose.error?.message === "change_order_accepted" && afterAccInsert.error?.message?.includes("change_order_accepted"),
    `${err(afterAccDraft)} / ${err(afterAccPropose)} / ${afterAccInsert.error?.message}`);
  const accSnapshot = await verRow(acceptedA);
  const accStatus = await service.from("change_order_versions").update({ status: "REFUSED" }).eq("id", acceptedA);
  const accPointer = await service.from("change_orders").update({ accepted_version_id: null }).eq("id", A);
  const accDecision = await service.from("change_order_decisions").delete().eq("version_id", acceptedA);
  record("15. Version acceptée intacte — statut, pointeur et décision non modifiables",
    accStatus.error?.message?.includes("change_order_version_transition_refused") && accPointer.error?.message?.includes("change_order_immutable") &&
      accDecision.error?.message?.includes("change_order_event_immutable") && same(await verRow(acceptedA), accSnapshot));

  // 16. Autorisation d'exécution (D125).
  const D = d1.change_order_id;
  const execPending = await contractor.client.rpc("authorize_change_order_execution", { p_change_order_id: D, p_expected_revision: await coRev(D) });
  const execRefused = await contractor.client.rpc("authorize_change_order_execution", { p_change_order_id: B, p_expected_revision: await coRev(B) });
  const execDirect = await service.from("change_order_execution_authorizations").insert({ change_order_id: D, version_id: d1.id, project_id: pid, authorized_by_profile_id: contractor.id, authorized_at_server: new Date().toISOString() });
  record("16. Autorisation refusée avant acceptation (proposé, refusé, écriture privilégiée)",
    execPending.error?.message === "change_order_not_accepted" && execRefused.error?.message === "change_order_not_accepted" && execDirect.error?.message?.includes("change_order_not_accepted"),
    `${err(execPending)} / ${err(execRefused)} / ${execDirect.error?.message}`);
  const execOwner = await owner.client.rpc("authorize_change_order_execution", { p_change_order_id: A, p_expected_revision: revAcc });
  const execNull = await contractor.client.rpc("authorize_change_order_execution", { p_change_order_id: A, p_expected_revision: null });
  record("16. Autorisation refusée — OWNER/PRIMARY (not_authorized), révision NULL", execOwner.error?.message === "not_authorized" && execNull.error?.message === "expected_revision_required");
  const [x1, x2] = await Promise.all([
    contractor.client.rpc("authorize_change_order_execution", { p_change_order_id: A, p_expected_revision: revAcc }),
    contractor.client.rpc("authorize_change_order_execution", { p_change_order_id: A, p_expected_revision: revAcc }),
  ]);
  const okX = [x1, x2].filter((r) => r.error === null);
  const koX = [x1, x2].filter((r) => ["change_order_conflict", "execution_already_authorized"].includes(r.error?.message));
  const authRows = (await service.from("change_order_execution_authorizations").select("*").eq("change_order_id", A)).data;
  record("16. Autorisations concurrentes — une seule aboutit, une seule ligne, sur la version acceptée",
    okX.length === 1 && koX.length === 1 && authRows.length === 1 && authRows[0].version_id === acceptedA, JSON.stringify([err(x1), err(x2)]));
  const again = await contractor.client.rpc("authorize_change_order_execution", { p_change_order_id: A, p_expected_revision: await coRev(A) });
  const authUpd = await service.from("change_order_execution_authorizations").update({ authorized_at_server: new Date().toISOString() }).eq("change_order_id", A);
  const authDel = await service.from("change_order_execution_authorizations").delete().eq("change_order_id", A);
  record("16. Seconde autorisation refusée explicitement (execution_already_authorized) ; modification et suppression refusées",
    again.error?.message === "execution_already_authorized" && authUpd.error?.message?.includes("change_order_event_immutable") && authDel.error?.message?.includes("change_order_event_immutable"), err(again));
  const listAuth = (await owner.client.rpc("list_change_orders", { p_project_id: pid })).data.find((v) => v.version_id === acceptedA);
  record("16. Autorisation visible dans la liste ; montant contractuel inchangé", !!listAuth?.execution_authorized_at_server && (await amount(owner.client, pid)).row.contract_amount_fcfa === "10675000");

  // 17. Isolation inter-chantiers et clés composites.
  const Q = await quotedProject("other");
  await Q.accept();
  const o1 = await must(draft(Q.contractor.client, Q.pid, null, [line("o", "1", "10")], 0, "Autre", "Autre"), "o1");
  const cross = [
    await contractor.client.rpc("list_change_orders", { p_project_id: Q.pid }),
    await contractor.client.rpc("get_change_order_version_lines", { p_version_id: o1.id }),
    await propose(contractor.client, o1.id, 1),
    await decide(owner.client, o1.id, "ACCEPTED", 1),
    await contractor.client.rpc("authorize_change_order_execution", { p_change_order_id: o1.change_order_id, p_expected_revision: 1 }),
    await contractor.client.rpc("get_contract_amount", { p_project_id: Q.pid }),
    await draft(contractor.client, pid, o1.change_order_id, [line("x", "1", "1")], 1),
  ];
  record("17. Isolation — aucun accès ni action sur les avenants d'un autre chantier", cross.every((r) => r.error?.message === "not_authorized"), JSON.stringify(cross.map(err)));
  const fkSupersede = await service.from("change_order_proposals").insert({ version_id: a3.id, change_order_id: A, project_id: pid, proposed_by_profile_id: contractor.id, proposed_at_server: new Date().toISOString(), supersedes_version_id: o1.id });
  const fkQuote = await service.from("change_orders").insert({ project_id: pid, quote_id: (await service.from("quotes").select("id").eq("project_id", Q.pid).single()).data.id, accepted_quote_version_id: Q.quoteVersionId, created_by_profile_id: contractor.id });
  // Lignes et pointeurs : déclencheurs satisfaits dans la même transaction, seule la clé composite refuse.
  const fkLine = await psqlError(`begin;
with v as (insert into public.change_order_versions (change_order_id, project_id, version_number, title, reason, total_amount_fcfa, created_by_profile_id)
  values ('${D}', '${pid}', 50, 't', 'r', 1, '${contractor.id}') returning id)
insert into public.change_order_version_lines (version_id, project_id, position, label, unit, quantity, unit_price_fcfa, line_amount_fcfa)
  select id, '${Q.pid}', 1, 'x', 'u', 1, 1, 1 from v;
commit;\n`);
  const fkPointer = await psqlError(`update public.change_orders set pending_version_id = '${d1.id}' where id = '${e1.change_order_id}';\n`);
  record("17. Clés composites — remplacement, ligne d'un autre chantier et pointeur vers la version d'un autre avenant refusés en écriture privilégiée",
    fkSupersede.error?.message?.includes("change_order_proposals_supersedes_fk") && fkLine.includes("change_order_version_lines_version_project_fk") &&
      fkPointer.includes("change_orders_pending_version_fk"), [fkSupersede.error?.message, fkLine, fkPointer].join(" / "));
  record("17. Avenant rattaché au devis d'un autre chantier refusé en écriture privilégiée", fkQuote.error?.message?.includes("quote_not_accepted"), fkQuote.error?.message);

  // 18. Adhésion révoquée pendant une attente réelle.
  const { data: qMembership } = await service.from("project_memberships").select("id").eq("project_id", Q.pid).eq("profile_id", Q.contractor.id).single();
  const oRev = await coRev(o1.change_order_id);
  const w2 = await callDuringRealWait(Q.pid,
    () => draft(Q.contractor.client, Q.pid, o1.change_order_id, [line("p", "1", "1")], oRev),
    async () => { await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("id", qMembership.id), "revoke"); });
  record("18. Adhésion révoquée pendant l'attente — version refusée, aucune version créée",
    w2.elapsed >= 2500 && w2.res.error?.message === "not_authorized" && (await service.from("change_order_versions").select("id").eq("change_order_id", o1.change_order_id)).data.length === 1,
    `${w2.elapsed}ms ${err(w2.res)}`);

  // 19. Audit final : événements attendus, jamais de brouillon.
  const audits = await coAudits(pid);
  const count = (a) => audits.filter((x) => x === a).length;
  record("19. Audit — PROPOSED, ACCEPTED, REFUSED, EXECUTION_AUTHORIZED ×1, aucun CHANGE_ORDER_CREATED",
    count("CHANGE_ORDER_PROPOSED") >= 4 && count("CHANGE_ORDER_ACCEPTED") >= 2 && count("CHANGE_ORDER_REFUSED") >= 1 &&
      count("CHANGE_ORDER_EXECUTION_AUTHORIZED") === 1 && count("CHANGE_ORDER_CREATED") === 0 && (await coAudits(Q.pid)).length === 0, JSON.stringify(audits));

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} tests réussis.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERREUR:", e.message);
  process.exitCode = 1;
});
