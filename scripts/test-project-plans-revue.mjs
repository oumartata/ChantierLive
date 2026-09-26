// Test d'intégration LOCAL uniquement pour la correction de revue B063
// (20260927170000_m020_correction_revue.sql) et le branchement du nettoyage.
// Couvre exclusivement :
//   1. set_retained_project_plan_version : p_expected_revision NULL refusé,
//      pointeur retenu et révision inchangés ;
//   2. compte vérifié relu après les attentes et avant tout retour/mutation :
//      refus RPC directs (rejeux compris) et perte de vérification PENDANT une
//      attente réelle sur un verrou tenu par une autre connexion ;
//   3. réconciliation de prepare_project_plan_upload : un operation_uuid
//      media_asset (même auteur/chantier/métadonnées) est refusé sans mutation ;
//   4. nettoyage : le script RÉEL abandonne une candidate de plan expirée,
//      supprime son objet Storage et préserve un fichier FINALIZED.
// Les autres comportements B063 restent couverts par test-project-plans.mjs.
//
// Usage : node scripts/test-project-plans-revue.mjs [chemin du script de nettoyage]

import { createClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const CLEANUP_SCRIPT = process.argv[2] || "scripts/cleanup_media_candidates.mjs";

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
  results.push({ name, pass });
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail !== undefined ? " — " + detail : ""}`);
}

const checksumOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createTestUser(label) {
  const email = `b063r-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, email: email.toLowerCase(), client };
}

// Perte / rétablissement de la vérification du compte (identifiants du profil).
async function setVerified(profileId, verified) {
  const { error } = await service
    .from("profile_identifiers")
    .update({ verified_at_server: verified ? new Date().toISOString() : null })
    .eq("profile_id", profileId);
  if (error) throw new Error(`setVerified: ${error.message}`);
}

// Tient un verrou réel depuis une connexion psql SÉPARÉE (même mécanisme que
// test-catalog-concurrency.mjs) pendant holdSeconds, puis COMMIT.
function holdLock(lockSql, holdSeconds) {
  const sql = `begin;\n${lockSql};\nselect pg_sleep(${holdSeconds});\ncommit;\n`;
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", ["exec", "-i", "supabase_db_ChantierLive", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`holdLock exit ${code}: ${stderr}`))));
    proc.stdin.write(sql);
    proc.stdin.end();
  });
}
const advisoryLockSql = (projectId) => `select pg_advisory_xact_lock(hashtext('invitation_quota:${projectId}')::bigint)`;
const rowLockSql = (table, id) => `select 1 from public.${table} where id = '${id}' for update`;

// Appel RPC lancé PENDANT qu'une autre connexion tient le verrou ; la
// vérification est retirée pendant que l'appel attend, puis le verrou tombe.
async function callDuringRealWait(user, lockSql, rpcCall) {
  const blocker = holdLock(lockSql, 4);
  await sleep(700); // le verrou est réellement acquis avant l'appel
  const start = Date.now();
  // Les appels supabase-js sont paresseux : .then() force l'envoi IMMÉDIAT,
  // sans quoi la requête ne partirait qu'au await, après la perte de
  // vérification (l'attente ne serait alors pas réellement testée).
  const pending = rpcCall().then((r) => r);
  await sleep(1000); // l'appel est en attente sur le verrou
  await setVerified(user.id, false);
  const res = await pending;
  const elapsed = Date.now() - start;
  await blocker;
  await setVerified(user.id, true);
  return { res, elapsed };
}

async function createDraftProject(client, role, label) {
  const { data, error } = await client.rpc("create_draft_project", { p_name: `B063 revue — ${label}`, p_country: "ML", p_role: role });
  if (error) throw new Error(`create_draft_project(${label}): ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { projectId: row.project_id, organizationId: row.organization_id };
}

async function addMembership(projectId, profileId, role, ownerProfile = null) {
  const { error } = await service.from("project_memberships").insert({ project_id: projectId, profile_id: profileId, role, owner_profile: ownerProfile });
  if (error) throw new Error(`addMembership: ${error.message}`);
}

// Prépare + revendique + écrit la candidate (jusqu'à PENDING revendiqué).
async function prepareAndWrite(client, projectId, bytes) {
  const op = randomUUID();
  const { data: prep, error: prepErr } = await client.rpc("prepare_project_plan_upload", {
    p_operation_uuid: op, p_project_id: projectId, p_expected_checksum: checksumOf(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf",
  });
  if (prepErr) throw new Error(`prepare: ${prepErr.message}`);
  const { data: claim, error: claimErr } = await client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id });
  if (claimErr || !claim?.won) throw new Error(`claim: ${claimErr?.message ?? "not won"}`);
  const { error: writeErr } = await service.storage.from("project-plans").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false });
  if (writeErr) throw new Error(`storage.upload: ${writeErr.message}`);
  return { op, prep, claim };
}

async function depositDirect(client, projectId, bytes) {
  const { op, claim } = await prepareAndWrite(client, projectId, bytes);
  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: checksumOf(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf",
  });
  if (attestErr) throw new Error(`attest: ${attestErr.message}`);
  const { data: version, error: finErr } = await client.rpc("finalize_project_plan_upload", { p_operation_uuid: op });
  if (finErr) throw new Error(`finalize: ${finErr.message}`);
  return { op, version, claim };
}

// Modèle catalogue publié (réutilise B061 inchangé : dépôt, validation, publication).
async function publishCatalogItem(owner, organizationId) {
  const engineer = await createTestUser("engineer");
  const { data: item } = await owner.client.rpc("create_catalog_item", { p_organization_id: organizationId, p_label: "Modèle revue B063" });
  const { data: designation, error: desErr } = await owner.client.rpc("designate_plan_engineer", { p_organization_id: organizationId, p_identifier_kind: "EMAIL", p_identifier_value: engineer.email });
  if (desErr) throw new Error(`designate: ${desErr.message}`);
  const op = randomUUID();
  const bytes = Buffer.from("%PDF-1.4 PLAN-CATALOGUE-REVUE");
  const { data: prep, error: prepErr } = await owner.client.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: op, p_organization_id: organizationId, p_catalog_item_id: item.id,
    p_expected_checksum: checksumOf(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf",
  });
  if (prepErr) throw new Error(`catPrep: ${prepErr.message}`);
  const { data: claim } = await owner.client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id });
  await service.storage.from("organization-catalog").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false });
  await service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: checksumOf(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" });
  const { data: version, error: finErr } = await owner.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: op });
  if (finErr) throw new Error(`catFin: ${finErr.message}`);
  const { data: submission } = await owner.client.rpc("submit_catalog_item_version_for_validation", { p_version_id: version.id, p_designation_id: designation.id });
  const { error: decErr } = await engineer.client.rpc("decide_catalog_item_validation", { p_validation_id: submission.id, p_decision: "VALIDATED", p_note: null });
  if (decErr) throw new Error(`catDecide: ${decErr.message}`);
  const { error: pubErr } = await owner.client.rpc("publish_catalog_item_version", { p_version_id: version.id });
  if (pubErr) throw new Error(`catPub: ${pubErr.message}`);
  return item.id;
}

const uploadRow = async (op) => (await service.from("private_object_uploads").select("*").eq("operation_uuid", op).maybeSingle()).data;
const projectRow = async (id) => (await service.from("projects").select("revision, retained_plan_version_id").eq("id", id).single()).data;
const planCount = async (projectId) => (await service.from("project_plans").select("id").eq("project_id", projectId)).data.length;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const contractor = await createTestUser("contractor");
  const owner = await createTestUser("owner");
  const chantier = await createDraftProject(contractor.client, "CONTRACTOR", "chantier");
  await addMembership(chantier.projectId, owner.id, "OWNER", "PRIMARY");
  const pid = chantier.projectId;
  const { version: ownerVersion } = await depositDirect(owner.client, pid, Buffer.from("%PDF-1.4 PLAN-OWNER"));

  // =========================================================================
  // 1. p_expected_revision NULL
  // =========================================================================
  const before1 = await projectRow(pid);
  const { error: nullErr } = await owner.client.rpc("set_retained_project_plan_version", { p_project_id: pid, p_version_id: ownerVersion.id, p_expected_revision: null });
  const after1 = await projectRow(pid);
  record("1. NULL — set_retained refuse expected_revision_required", nullErr?.message === "expected_revision_required", nullErr?.message);
  record("1. NULL — pointeur retenu et révision inchangés", same(before1, after1), JSON.stringify(after1));
  const { error: okErr } = await owner.client.rpc("set_retained_project_plan_version", { p_project_id: pid, p_version_id: ownerVersion.id, p_expected_revision: after1.revision });
  record("1. Contrôle — la même désignation avec la révision exacte aboutit toujours", okErr === null, okErr?.message);

  // =========================================================================
  // 2a. Refus RPC directs, compte devenu provisoire (rejeux compris)
  // =========================================================================
  const catalogItemId = await publishCatalogItem(contractor, chantier.organizationId);
  const pendingOp = await prepareAndWrite(contractor.client, pid, Buffer.from("%PDF-1.4 PENDING-REVENDIQUE")); // PENDING revendiqué
  const unclaimedOp = randomUUID();
  const unclaimedBytes = Buffer.from("%PDF-1.4 PENDING-NON-REVENDIQUE");
  const unclaimedParams = { p_operation_uuid: unclaimedOp, p_project_id: pid, p_expected_checksum: checksumOf(unclaimedBytes), p_expected_size_bytes: unclaimedBytes.length, p_expected_mime_type: "application/pdf" };
  await contractor.client.rpc("prepare_project_plan_upload", unclaimedParams);
  const expiredOp = await prepareAndWrite(contractor.client, pid, Buffer.from("%PDF-1.4 EXPIREE"));
  await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("operation_uuid", expiredOp.op);
  const finalized = await depositDirect(contractor.client, pid, Buffer.from("%PDF-1.4 FINALISEE"));

  const snapshot = async () => ({
    pending: await uploadRow(pendingOp.op), unclaimed: await uploadRow(unclaimedOp), expired: await uploadRow(expiredOp.op),
    finalized: await uploadRow(finalized.op), plans: await planCount(pid), project: await projectRow(pid),
  });
  const beforeDirect = await snapshot();
  const newOp = randomUUID();

  await setVerified(contractor.id, false);
  await setVerified(owner.id, false);
  const direct = {
    "prepare (nouvelle opération)": await contractor.client.rpc("prepare_project_plan_upload", { ...unclaimedParams, p_operation_uuid: newOp }),
    "prepare (rejeu de réconciliation)": await contractor.client.rpc("prepare_project_plan_upload", unclaimedParams),
    "claim (non revendiquée)": await contractor.client.rpc("claim_upload_attempt", { p_operation_uuid: unclaimedOp }),
    "claim (rejeu, déjà revendiquée)": await contractor.client.rpc("claim_upload_attempt", { p_operation_uuid: pendingOp.op }),
    "recover (tentative expirée)": await contractor.client.rpc("recover_media_upload_attempt", { p_operation_uuid: expiredOp.op }),
    "recover (rejeu FINALIZED)": await contractor.client.rpc("recover_media_upload_attempt", { p_operation_uuid: finalized.op }),
    "get_upload_status": await contractor.client.rpc("get_upload_status", { p_operation_uuid: finalized.op }),
    "attach_catalog_plan_to_project": await contractor.client.rpc("attach_catalog_plan_to_project", { p_project_id: pid, p_catalog_item_id: catalogItemId }),
    "set_retained (révision exacte)": await owner.client.rpc("set_retained_project_plan_version", { p_project_id: pid, p_version_id: ownerVersion.id, p_expected_revision: beforeDirect.project.revision }),
    "list_project_plan_candidates": await owner.client.rpc("list_project_plan_candidates", { p_project_id: pid }),
  };
  await setVerified(contractor.id, true);
  await setVerified(owner.id, true);
  for (const [name, res] of Object.entries(direct)) {
    record(`2a. Compte provisoire — ${name} refusé account_provisional, aucune donnée renvoyée`, res.error?.message === "account_provisional" && res.data === null, res.error?.message ?? "aucune erreur");
  }
  const afterDirect = await snapshot();
  record("2a. Aucune mutation — lignes upload, plans et chantier identiques", same(beforeDirect, afterDirect));
  record("2a. Aucune opération créée pour la nouvelle opération refusée", (await uploadRow(newOp)) === null);

  // =========================================================================
  // 2b. Perte de vérification PENDANT une attente réelle
  // =========================================================================
  const WAIT_MIN_MS = 2500;
  // prepare : attente sur l'avisoire du chantier (le contrôle était avant, il est après).
  const waitOp = randomUUID();
  const w1 = await callDuringRealWait(contractor, advisoryLockSql(pid), () =>
    contractor.client.rpc("prepare_project_plan_upload", { ...unclaimedParams, p_operation_uuid: waitOp })
  );
  record("2b. prepare — attente réelle sur l'avisoire, refus account_provisional, aucune opération créée",
    w1.elapsed >= WAIT_MIN_MS && w1.res.error?.message === "account_provisional" && (await uploadRow(waitOp)) === null,
    `${w1.elapsed}ms ${w1.res.error?.message}`);

  // claim : attente sur l'avisoire, candidate jamais revendiquée.
  const w2 = await callDuringRealWait(contractor, advisoryLockSql(pid), () =>
    contractor.client.rpc("claim_upload_attempt", { p_operation_uuid: unclaimedOp })
  );
  const unclaimedAfter = await uploadRow(unclaimedOp);
  record("2b. claim — attente réelle, refus account_provisional, write_claimed_at toujours null",
    w2.elapsed >= WAIT_MIN_MS && w2.res.error?.message === "account_provisional" && unclaimedAfter.write_claimed_at === null,
    `${w2.elapsed}ms ${w2.res.error?.message}`);

  // recover : attente sur l'avisoire, aucune nouvelle tentative ouverte.
  const w3 = await callDuringRealWait(contractor, advisoryLockSql(pid), () =>
    contractor.client.rpc("recover_media_upload_attempt", { p_operation_uuid: expiredOp.op })
  );
  const expiredAfter = await uploadRow(expiredOp.op);
  record("2b. recover — attente réelle, refus account_provisional, attempt_id inchangé",
    w3.elapsed >= WAIT_MIN_MS && w3.res.error?.message === "account_provisional" && expiredAfter.attempt_id === beforeDirect.expired.attempt_id,
    `${w3.elapsed}ms ${w3.res.error?.message}`);

  // attach : attente sur le verrou ORGANISATION (le contrôle était avant, il est après).
  const plansBeforeAttach = await planCount(pid);
  const w4 = await callDuringRealWait(contractor, rowLockSql("organizations", chantier.organizationId), () =>
    contractor.client.rpc("attach_catalog_plan_to_project", { p_project_id: pid, p_catalog_item_id: catalogItemId })
  );
  record("2b. attach — attente réelle sur l'organisation, refus account_provisional, aucun plan créé",
    w4.elapsed >= WAIT_MIN_MS && w4.res.error?.message === "account_provisional" && (await planCount(pid)) === plansBeforeAttach,
    `${w4.elapsed}ms ${w4.res.error?.message}`);

  // set_retained : attente sur le verrou CHANTIER (le contrôle était avant, il est après).
  const projBeforeRetain = await projectRow(pid);
  const w5 = await callDuringRealWait(owner, rowLockSql("projects", pid), () =>
    owner.client.rpc("set_retained_project_plan_version", { p_project_id: pid, p_version_id: ownerVersion.id, p_expected_revision: projBeforeRetain.revision })
  );
  record("2b. set_retained — attente réelle sur le chantier, refus account_provisional, pointeur et révision inchangés",
    w5.elapsed >= WAIT_MIN_MS && w5.res.error?.message === "account_provisional" && same(projBeforeRetain, await projectRow(pid)),
    `${w5.elapsed}ms ${w5.res.error?.message}`);

  // Contrôle positif : compte rétabli, les chemins corrigés fonctionnent toujours.
  const { data: attached, error: attachOkErr } = await contractor.client.rpc("attach_catalog_plan_to_project", { p_project_id: pid, p_catalog_item_id: catalogItemId });
  const { data: claimOk, error: claimOkErr } = await contractor.client.rpc("claim_upload_attempt", { p_operation_uuid: unclaimedOp });
  const { data: listOk, error: listOkErr } = await owner.client.rpc("list_project_plan_candidates", { p_project_id: pid });
  record("2c. Compte rétabli — attach, claim et list aboutissent",
    attachOkErr === null && !!attached?.id && claimOkErr === null && claimOk?.won === true && listOkErr === null && Array.isArray(listOk),
    [attachOkErr?.message, claimOkErr?.message, listOkErr?.message].filter(Boolean).join(" / ") || "ok");

  // =========================================================================
  // 3. Réconciliation : operation_uuid d'un autre domaine (media_asset)
  // =========================================================================
  const mediaOp = randomUUID();
  const mediaBytes = Buffer.from("%PDF-1.4 MEME-METADONNEES");
  const mediaParams = { p_operation_uuid: mediaOp, p_project_id: pid, p_expected_checksum: checksumOf(mediaBytes), p_expected_size_bytes: mediaBytes.length, p_expected_mime_type: "application/pdf" };
  const { error: mediaPrepErr } = await contractor.client.rpc("prepare_media_upload", mediaParams);
  if (mediaPrepErr) throw new Error(`prepare_media_upload: ${mediaPrepErr.message}`);
  const mediaBefore = await uploadRow(mediaOp);
  const plansBeforeConflict = await planCount(pid);
  const { data: conflictData, error: conflictErr } = await contractor.client.rpc("prepare_project_plan_upload", mediaParams);
  const mediaAfter = await uploadRow(mediaOp);
  record("3. operation_uuid media_asset (même auteur/chantier/métadonnées) — operation_uuid_conflict",
    conflictErr?.message === "operation_uuid_conflict" && conflictData === null, conflictErr?.message ?? "aucune erreur");
  record("3. Aucune mutation — ligne media_asset identique, aucun plan créé",
    same(mediaBefore, mediaAfter) && mediaAfter.entity_type === "media_asset" && (await planCount(pid)) === plansBeforeConflict);

  // =========================================================================
  // 4. Nettoyage par le script RÉEL
  // =========================================================================
  const cleanupTarget = await prepareAndWrite(contractor.client, pid, Buffer.from("%PDF-1.4 CANDIDATE-A-NETTOYER"));
  await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }).eq("operation_uuid", cleanupTarget.op);
  const { data: candidateBefore } = await service.storage.from("project-plans").download(cleanupTarget.claim.candidate_key);
  record("4. Préalable — candidate expirée présente dans project-plans", !!candidateBefore);
  const finalizedKey = (await uploadRow(finalized.op)).storage_key;

  const scriptOutput = await new Promise((resolve) => {
    const proc = spawn("node", [CLEANUP_SCRIPT], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve({ code, out }));
  });
  console.log(`--- sortie de ${CLEANUP_SCRIPT} (code ${scriptOutput.code}) ---\n${scriptOutput.out.trim()}\n---`);

  const targetAfter = await uploadRow(cleanupTarget.op);
  const { data: candidateAfter } = await service.storage.from("project-plans").download(cleanupTarget.claim.candidate_key);
  const { data: finalizedFile } = await service.storage.from("project-plans").download(finalizedKey);
  const finalizedAfter = await uploadRow(finalized.op);
  record("4. Script réel — l'opération de plan expirée est ABANDONED", targetAfter.status === "ABANDONED", targetAfter.status);
  record("4. Script réel — la candidate expirée est supprimée de project-plans", !candidateAfter);
  record("4. Script réel — le fichier FINALIZED est préservé (statut et objet Storage)", finalizedAfter.status === "FINALIZED" && !!finalizedFile);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} tests réussis.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERREUR:", err.message);
  process.exitCode = 1;
});
