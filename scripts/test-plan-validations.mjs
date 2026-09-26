// Test d'intégration LOCAL uniquement pour B064 (M023b plan_validations et
// publications, M025 project_plan_shares). Couvre les risques réels :
// soumission (D108/D109), décision unique, révocation concurrente de
// l'ingénieur et compte devenu provisoire PENDANT une attente réelle,
// isolation entre organisations, publication/republication (D110), absence
// d'équivalence avec les validations catalogue B061, accès aux fichiers
// (D096/D097/D111) et immutabilité.
//
// Courses : chaque appel concurrent est ENVOYÉ (.then) avant la mutation
// testée — les appels supabase-js sont paresseux (limite constatée sur le
// harnais B061).
//
// Usage : node scripts/test-plan-validations.mjs

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
const checksumOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createTestUser(label) {
  const email = `b064-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, email: email.toLowerCase(), client };
}

async function setVerified(profileId, verified) {
  const { error } = await service.from("profile_identifiers")
    .update({ verified_at_server: verified ? new Date().toISOString() : null }).eq("profile_id", profileId);
  if (error) throw new Error(`setVerified: ${error.message}`);
}

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

// L'appel est ENVOYÉ (then) pendant qu'une autre connexion tient le verrou ;
// la mutation concurrente n'intervient qu'ensuite, pendant l'attente.
async function callDuringRealWait(lockSql, rpcCall, mutateDuringWait) {
  const blocker = holdLock(lockSql, 4);
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

async function createDraftProject(client, role, label) {
  const { data, error } = await client.rpc("create_draft_project", { p_name: `B064 — ${label}`, p_country: "ML", p_role: role });
  if (error) throw new Error(`create_draft_project(${label}): ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { projectId: row.project_id, organizationId: row.organization_id };
}

async function addMembership(projectId, profileId, role, ownerProfile = null) {
  const { data, error } = await service.from("project_memberships")
    .insert({ project_id: projectId, profile_id: profileId, role, owner_profile: ownerProfile }).select("id").single();
  if (error) throw new Error(`addMembership: ${error.message}`);
  return data.id;
}

async function depositDirect(client, projectId, label) {
  const bytes = Buffer.from(`%PDF-1.4 ${label}`);
  const op = randomUUID();
  const { data: prep, error: prepErr } = await client.rpc("prepare_project_plan_upload", {
    p_operation_uuid: op, p_project_id: projectId, p_expected_checksum: checksumOf(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf",
  });
  if (prepErr) throw new Error(`prepare: ${prepErr.message}`);
  const { data: claim } = await client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id });
  await service.storage.from("project-plans").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false });
  await service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: checksumOf(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" });
  const { data: version, error: finErr } = await client.rpc("finalize_project_plan_upload", { p_operation_uuid: op });
  if (finErr) throw new Error(`finalize: ${finErr.message}`);
  return version;
}

async function designate(ownerClient, organizationId, engineer) {
  const { data, error } = await ownerClient.rpc("designate_plan_engineer", { p_organization_id: organizationId, p_identifier_kind: "EMAIL", p_identifier_value: engineer.email });
  if (error) throw new Error(`designate: ${error.message}`);
  return data.id;
}

// Modèle catalogue publié par le parcours B061 inchangé (validation CATALOGUE).
async function publishCatalogItem(owner, organizationId, designationId, engineer) {
  const { data: item } = await owner.client.rpc("create_catalog_item", { p_organization_id: organizationId, p_label: "Modèle B064" });
  const op = randomUUID();
  const bytes = Buffer.from("%PDF-1.4 CATALOGUE-B064");
  const { data: prep, error: prepErr } = await owner.client.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: op, p_organization_id: organizationId, p_catalog_item_id: item.id,
    p_expected_checksum: checksumOf(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf",
  });
  if (prepErr) throw new Error(`catPrep: ${prepErr.message}`);
  const { data: claim } = await owner.client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id });
  await service.storage.from("organization-catalog").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false });
  await service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: checksumOf(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" });
  const { data: version } = await owner.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: op });
  const { data: sub } = await owner.client.rpc("submit_catalog_item_version_for_validation", { p_version_id: version.id, p_designation_id: designationId });
  const { error: decErr } = await engineer.client.rpc("decide_catalog_item_validation", { p_validation_id: sub.id, p_decision: "VALIDATED", p_note: null });
  if (decErr) throw new Error(`catDecide: ${decErr.message}`);
  const { error: pubErr } = await owner.client.rpc("publish_catalog_item_version", { p_version_id: version.id });
  if (pubErr) throw new Error(`catPub: ${pubErr.message}`);
  return item.id;
}

const project = async (id) => (await service.from("projects").select("revision, retained_plan_version_id, published_plan_version_id").eq("id", id).single()).data;
const validation = async (id) => (await service.from("plan_validations").select("*").eq("id", id).single()).data;
const publications = async (pid) => (await service.from("project_plan_publications").select("*").eq("project_id", pid).order("published_at_server")).data;

async function retain(owner, pid, versionId) {
  const { revision } = await project(pid);
  const { error } = await owner.client.rpc("set_retained_project_plan_version", { p_project_id: pid, p_version_id: versionId, p_expected_revision: revision });
  if (error) throw new Error(`retain: ${error.message}`);
}
async function publish(client, pid, versionId, revision) {
  const rev = revision === undefined ? (await project(pid)).revision : revision;
  return client.rpc("publish_project_plan_version", { p_project_id: pid, p_version_id: versionId, p_expected_revision: rev });
}

async function main() {
  // ---------------------------------------------------------------------
  // Mise en place : chantier d'agence (CONTRACTOR propriétaire de l'organisation).
  // ---------------------------------------------------------------------
  const contractor = await createTestUser("contractor");
  const owner = await createTestUser("owner");
  const coOwner = await createTestUser("coowner");
  const siteManager = await createTestUser("sitemanager");
  const engineer = await createTestUser("engineer");
  const otherOrgOwner = await createTestUser("other-org-owner");
  const otherEngineer = await createTestUser("other-engineer");

  const chantier = await createDraftProject(contractor.client, "CONTRACTOR", "chantier");
  const pid = chantier.projectId;
  await addMembership(pid, owner.id, "OWNER", "PRIMARY");
  await addMembership(pid, coOwner.id, "OWNER", "CO_OWNER");
  const smMembershipId = await addMembership(pid, siteManager.id, "SITE_MANAGER");
  const designationId = await designate(contractor.client, chantier.organizationId, engineer);

  const otherChantier = await createDraftProject(otherOrgOwner.client, "CONTRACTOR", "autre-agence");
  const otherDesignationId = await designate(otherOrgOwner.client, otherChantier.organizationId, otherEngineer);

  const vContractor = await depositDirect(contractor.client, pid, "PLAN-CONTRACTOR");
  const vOwner = await depositDirect(owner.client, pid, "PLAN-OWNER");
  await contractor.client.rpc("share_project_plan_version_with_owner", { p_version_id: vContractor.id });

  // ---------------------------------------------------------------------
  // 1. Chantier sans organisation (D108).
  // ---------------------------------------------------------------------
  const clientOwner = await createTestUser("client-sans-org");
  const clientProject = await createDraftProject(clientOwner.client, "OWNER", "sans-organisation");
  const invitedContractor = await createTestUser("contractor-invite");
  await addMembership(clientProject.projectId, invitedContractor.id, "CONTRACTOR");
  const vNoOrg = await depositDirect(clientOwner.client, clientProject.projectId, "PLAN-SANS-ORG");
  const { revision: noOrgRev } = await project(clientProject.projectId);
  const { error: noOrgRetainErr } = await clientOwner.client.rpc("set_retained_project_plan_version", { p_project_id: clientProject.projectId, p_version_id: vNoOrg.id, p_expected_revision: noOrgRev });
  record("1. Sans organisation — dépôt et choix du plan retenu B063 restent possibles", noOrgRetainErr === null && !!vNoOrg?.id, noOrgRetainErr?.message);
  const noOrgSubmit = await invitedContractor.client.rpc("submit_plan_version_for_validation", { p_version_id: vNoOrg.id, p_designation_id: designationId });
  record("1. Sans organisation — soumission refusée no_organization", noOrgSubmit.error?.message === "no_organization", err(noOrgSubmit));
  const noOrgEngineers = await invitedContractor.client.rpc("list_project_plan_engineers", { p_project_id: clientProject.projectId });
  record("1. Sans organisation — liste des ingénieurs refusée no_organization", noOrgEngineers.error?.message === "no_organization", err(noOrgEngineers));

  // ---------------------------------------------------------------------
  // 2. Soumission (D109).
  // ---------------------------------------------------------------------
  const engineers = await contractor.client.rpc("list_project_plan_engineers", { p_project_id: pid });
  const listed = engineers.data ?? [];
  record("2. Liste des ingénieurs — CONTRACTOR voit la désignation active, identifiant masqué",
    engineers.error === null && listed.length === 1 && listed[0].designation_id === designationId && !listed[0].identifier_masked.includes(engineer.email.split("@")[0]),
    JSON.stringify(listed.map((e) => e.identifier_masked)));
  const ownerEngineers = await owner.client.rpc("list_project_plan_engineers", { p_project_id: pid });
  record("2. Liste des ingénieurs — refusée à OWNER/PRIMARY", ownerEngineers.error?.message === "not_authorized", err(ownerEngineers));

  for (const [label, user] of [["OWNER/PRIMARY", owner], ["CO_OWNER", coOwner], ["SITE_MANAGER", siteManager], ["ingénieur", engineer]]) {
    const res = await user.client.rpc("submit_plan_version_for_validation", { p_version_id: vOwner.id, p_designation_id: designationId });
    record(`2. Soumission refusée — ${label}`, res.error?.message === "not_authorized", err(res));
  }
  const otherOrgSubmit = await contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: vContractor.id, p_designation_id: otherDesignationId });
  record("2. Soumission refusée — désignation d'une autre organisation", otherOrgSubmit.error?.message === "not_authorized", err(otherOrgSubmit));
  const foreignVersion = await depositDirect(otherOrgOwner.client, otherChantier.projectId, "PLAN-AUTRE-CHANTIER");
  const foreignSubmit = await contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: foreignVersion.id, p_designation_id: designationId });
  record("2. Soumission refusée — version d'un autre chantier", foreignSubmit.error?.message === "not_authorized", err(foreignSubmit));

  // Deux soumissions concurrentes de la même version : une seule aboutit.
  const [subA, subB] = await Promise.all([
    contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: vContractor.id, p_designation_id: designationId }),
    contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: vContractor.id, p_designation_id: designationId }),
  ]);
  const subOk = [subA, subB].filter((r) => r.error === null);
  const subDup = [subA, subB].filter((r) => r.error?.message === "already_pending");
  record("2. Soumissions concurrentes — une PENDING, l'autre already_pending", subOk.length === 1 && subDup.length === 1, JSON.stringify([err(subA), err(subB)]));
  const valContractor = subOk[0].data;

  await setVerified(contractor.id, false);
  const provisionalSubmit = await contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: vOwner.id, p_designation_id: designationId });
  await setVerified(contractor.id, true);
  const pendingOwner = (await service.from("plan_validations").select("id").eq("project_plan_version_id", vOwner.id)).data;
  record("2. Soumission refusée — compte provisoire, aucune demande créée", provisionalSubmit.error?.message === "account_provisional" && pendingOwner.length === 0, err(provisionalSubmit));

  // ---------------------------------------------------------------------
  // 3. Ingénieur : liste, isolation, fichier.
  // ---------------------------------------------------------------------
  const engList = await engineer.client.rpc("list_submitted_plan_validations");
  record("3. Ingénieur — la demande apparaît dans sa liste", (engList.data ?? []).some((v) => v.validation_id === valContractor.id), err(engList));
  const otherList = await otherEngineer.client.rpc("list_submitted_plan_validations");
  record("3. Isolation — l'ingénieur d'une autre agence ne la voit pas", !(otherList.data ?? []).some((v) => v.validation_id === valContractor.id));
  const engFile = await engineer.client.rpc("get_plan_validation_file", { p_validation_id: valContractor.id });
  const engRow = Array.isArray(engFile.data) ? engFile.data[0] : engFile.data;
  const { data: engDownload } = engRow ? await service.storage.from(engRow.bucket).download(engRow.storage_key) : { data: null };
  record("3. Ingénieur — lit le fichier de la version soumise (FINALIZED, bon bucket)", engFile.error === null && engRow?.bucket === "project-plans" && !!engDownload, err(engFile));
  for (const [label, user] of [["ingénieur d'une autre agence", otherEngineer], ["CONTRACTOR", contractor], ["OWNER/PRIMARY", owner]]) {
    const res = await user.client.rpc("get_plan_validation_file", { p_validation_id: valContractor.id });
    record(`3. Fichier de la demande refusé — ${label}`, res.error?.message === "not_authorized", err(res));
  }
  for (const [label, user] of [["ingénieur d'une autre agence", otherEngineer], ["CONTRACTOR", contractor]]) {
    const res = await user.client.rpc("decide_plan_validation", { p_validation_id: valContractor.id, p_decision: "VALIDATED", p_note: null });
    record(`3. Décision refusée — ${label}`, res.error?.message === "not_authorized", err(res));
  }

  // ---------------------------------------------------------------------
  // 4. Décision unique (deux décisions concurrentes réellement envoyées).
  // ---------------------------------------------------------------------
  const [decA, decB] = await Promise.all([
    engineer.client.rpc("decide_plan_validation", { p_validation_id: valContractor.id, p_decision: "VALIDATED", p_note: "Conforme" }),
    engineer.client.rpc("decide_plan_validation", { p_validation_id: valContractor.id, p_decision: "REJECTED", p_note: null }),
  ]);
  const decOk = [decA, decB].filter((r) => r.error === null);
  const decDup = [decA, decB].filter((r) => r.error?.message === "already_decided");
  const valAfter = await validation(valContractor.id);
  record("4. Décisions concurrentes — une seule aboutit, l'autre already_decided", decOk.length === 1 && decDup.length === 1 && valAfter.status === decOk[0].data.status, JSON.stringify([err(decA), err(decB), valAfter.status]));
  record("4. Décision enregistrée — identité de l'ingénieur, version et date", valAfter.decided_by_profile_id === engineer.id && valAfter.project_plan_version_id === vContractor.id && !!valAfter.decided_at_server);
  // Le reste du scénario a besoin d'une version VALIDATED : si la course a
  // retenu REJECTED, une nouvelle demande est validée (décision unique conservée).
  let validatedContractor = valAfter;
  if (valAfter.status !== "VALIDATED") {
    const { data: again } = await contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: vContractor.id, p_designation_id: designationId });
    const { data: dec } = await engineer.client.rpc("decide_plan_validation", { p_validation_id: again.id, p_decision: "VALIDATED", p_note: null });
    validatedContractor = dec;
  }

  // ---------------------------------------------------------------------
  // 5. Immutabilité.
  // ---------------------------------------------------------------------
  const upd = await service.from("plan_validations").update({ status: "REJECTED" }).eq("id", validatedContractor.id);
  record("5. Immutabilité — une demande terminale ne change plus (validation_already_terminal)", upd.error?.message?.includes("validation_already_terminal"), upd.error?.message);
  const del = await service.from("plan_validations").delete().eq("id", validatedContractor.id);
  record("5. Immutabilité — aucune suppression de demande", del.error?.message?.includes("plan_validation_immutable"), del.error?.message);

  // ---------------------------------------------------------------------
  // 6. Révocation concurrente et compte provisoire PENDANT une attente réelle.
  // ---------------------------------------------------------------------
  const { data: valOwner } = await contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: vOwner.id, p_designation_id: designationId });
  const w1 = await callDuringRealWait(advisoryLockSql(pid),
    () => engineer.client.rpc("decide_plan_validation", { p_validation_id: valOwner.id, p_decision: "VALIDATED", p_note: null }),
    () => setVerified(engineer.id, false));
  await setVerified(engineer.id, true);
  record("6. Compte provisoire pendant l'attente — decide refusé account_provisional, demande toujours PENDING",
    w1.elapsed >= 2500 && w1.res.error?.message === "account_provisional" && (await validation(valOwner.id)).status === "PENDING", `${w1.elapsed}ms ${err(w1.res)}`);

  const w2 = await callDuringRealWait(advisoryLockSql(pid),
    () => engineer.client.rpc("decide_plan_validation", { p_validation_id: valOwner.id, p_decision: "VALIDATED", p_note: null }),
    async () => {
      const { error } = await contractor.client.rpc("revoke_plan_engineer_designation", { p_designation_id: designationId });
      if (error) throw new Error(`revoke: ${error.message}`);
    });
  record("6. Révocation pendant l'attente — decide refusé not_authorized, demande toujours PENDING",
    w2.elapsed >= 2500 && w2.res.error?.message === "not_authorized" && (await validation(valOwner.id)).status === "PENDING", `${w2.elapsed}ms ${err(w2.res)}`);

  const engFileAfterRevoke = await engineer.client.rpc("get_plan_validation_file", { p_validation_id: validatedContractor.id });
  record("6. Révocation — l'ingénieur perd l'accès au fichier (D097)", engFileAfterRevoke.error?.message === "not_authorized", err(engFileAfterRevoke));
  const history = await owner.client.rpc("list_project_plan_validations", { p_project_id: pid });
  record("6. Révocation — la décision historique reste consultable (OWNER/PRIMARY)",
    (history.data ?? []).some((v) => v.validation_id === validatedContractor.id && v.status === "VALIDATED" && v.engineer_identifier_masked.includes("•••")), err(history));

  // Nouvelle désignation : la demande orpheline est close explicitement (CANCELLED).
  const designation2Id = await designate(contractor.client, chantier.organizationId, engineer);
  const { data: valOwner2, error: resubErr } = await contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: vOwner.id, p_designation_id: designation2Id });
  const orphan = await validation(valOwner.id);
  record("6. Resoumission — l'ancienne demande (désignation révoquée) passe CANCELLED, une nouvelle PENDING", resubErr === null && orphan.status === "CANCELLED" && orphan.cancelled_reason === "designation_revoked" && valOwner2?.status === "PENDING", resubErr?.message ?? orphan.status);

  // ---------------------------------------------------------------------
  // 7. Publication (D110) et absence d'équivalence avec B061.
  // ---------------------------------------------------------------------
  const notRetained = await publish(contractor.client, pid, vContractor.id);
  record("7. Publication refusée — version validée mais non retenue", notRetained.error?.message === "version_not_retained", err(notRetained));
  await retain(owner, pid, vContractor.id);
  for (const [label, user] of [["OWNER/PRIMARY", owner], ["CO_OWNER", coOwner], ["SITE_MANAGER", siteManager]]) {
    const res = await publish(user.client, pid, vContractor.id);
    record(`7. Publication refusée — ${label}`, res.error?.message === "not_authorized", err(res));
  }
  const nullRev = await publish(contractor.client, pid, vContractor.id, null);
  record("7. Publication refusée — révision NULL", nullRev.error?.message === "expected_revision_required", err(nullRev));
  const staleRev = await publish(contractor.client, pid, vContractor.id, (await project(pid)).revision - 1);
  record("7. Publication refusée — révision périmée", staleRev.error?.message === "publication_conflict", err(staleRev));

  // Compte provisoire pendant l'attente : aucune publication.
  const revBeforeWait = (await project(pid)).revision;
  const w4 = await callDuringRealWait(advisoryLockSql(pid),
    () => contractor.client.rpc("publish_project_plan_version", { p_project_id: pid, p_version_id: vContractor.id, p_expected_revision: revBeforeWait }),
    () => setVerified(contractor.id, false));
  await setVerified(contractor.id, true);
  record("7. Compte provisoire pendant l'attente — publication refusée, aucun pointeur ni journal",
    w4.elapsed >= 2500 && w4.res.error?.message === "account_provisional" && (await project(pid)).published_plan_version_id === null && (await publications(pid)).length === 0, `${w4.elapsed}ms ${err(w4.res)}`);

  const ok1 = await publish(contractor.client, pid, vContractor.id);
  const pubs1 = await publications(pid);
  record("7. Publication — plan retenu VALIDATED publié, une ligne de journal",
    ok1.error === null && (await project(pid)).published_plan_version_id === vContractor.id && pubs1.length === 1 && pubs1[0].plan_validation_id === validatedContractor.id, err(ok1));
  const again = await publish(contractor.client, pid, vContractor.id);
  record("7. Republication de la même version refusée (already_published)", again.error?.message === "already_published", err(again));

  // Plan retenu changé : le plan publié ne bouge pas (aucun remplacement automatique).
  await retain(owner, pid, vOwner.id);
  record("7. Changement du plan retenu — le plan publié reste inchangé", (await project(pid)).published_plan_version_id === vContractor.id);
  const notValidated = await publish(contractor.client, pid, vOwner.id);
  record("7. Publication refusée — nouveau plan retenu encore en attente de validation", notValidated.error?.message === "version_not_validated", err(notValidated));

  // Validation catalogue B061 seule : aucune équivalence.
  const catalogEngineer = await createTestUser("catalog-engineer");
  const catalogDesignation = await designate(contractor.client, chantier.organizationId, catalogEngineer);
  const catalogItemId = await publishCatalogItem(contractor, chantier.organizationId, catalogDesignation, catalogEngineer);
  const { data: vCatalog, error: attachErr } = await contractor.client.rpc("attach_catalog_plan_to_project", { p_project_id: pid, p_catalog_item_id: catalogItemId });
  if (attachErr) throw new Error(`attach: ${attachErr.message}`);
  await contractor.client.rpc("share_project_plan_version_with_owner", { p_version_id: vCatalog.id });
  await retain(owner, pid, vCatalog.id);
  const catalogOnly = await publish(contractor.client, pid, vCatalog.id);
  record("7. Publication refusée — version catalogue validée seulement au catalogue (B061)", catalogOnly.error?.message === "version_not_validated", err(catalogOnly));

  // Validation chantier de la version catalogue puis republication explicite.
  const { data: valCatalog } = await contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: vCatalog.id, p_designation_id: designation2Id });
  const catFile = await engineer.client.rpc("get_plan_validation_file", { p_validation_id: valCatalog.id });
  const catRow = Array.isArray(catFile.data) ? catFile.data[0] : catFile.data;
  record("7. Ingénieur — fichier d'une version catalogue servi depuis organization-catalog", catRow?.bucket === "organization-catalog", err(catFile));
  await engineer.client.rpc("decide_plan_validation", { p_validation_id: valCatalog.id, p_decision: "VALIDATED", p_note: null });
  const ok2 = await publish(contractor.client, pid, vCatalog.id);
  const pubs2 = await publications(pid);
  record("7. Republication explicite — nouveau pointeur, historique conservé (2 lignes, précédent = ancien plan)",
    ok2.error === null && (await project(pid)).published_plan_version_id === vCatalog.id && pubs2.length === 2 && pubs2[1].previous_published_version_id === vContractor.id, err(ok2));
  record("7. D106 — la validation de l'ancien plan reste attachée à SA version", (await validation(validatedContractor.id)).project_plan_version_id === vContractor.id);
  const pubUpd = await service.from("project_plan_publications").update({ published_at_server: new Date().toISOString() }).eq("id", pubs2[0].id);
  record("7. Journal de publication — aucune modification (insertion seule)", pubUpd.error?.message?.includes("project_plan_publication_immutable"), pubUpd.error?.message);

  // ---------------------------------------------------------------------
  // 8. Lecture du plan publié (D096) et partage SITE_MANAGER (D111).
  // ---------------------------------------------------------------------
  for (const [label, user] of [["OWNER/PRIMARY", owner], ["CO_OWNER", coOwner], ["CONTRACTOR", contractor]]) {
    const res = await user.client.rpc("get_published_project_plan_file", { p_project_id: pid });
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    record(`8. Plan publié lisible — ${label}`, res.error === null && row?.project_plan_version_id === vCatalog.id, err(res));
  }
  const smBefore = await siteManager.client.rpc("get_published_project_plan_file", { p_project_id: pid });
  record("8. SITE_MANAGER sans octroi — refusé", smBefore.error?.message === "not_authorized", err(smBefore));
  const grantOld = await contractor.client.rpc("grant_project_plan_share", { p_project_id: pid, p_version_id: vContractor.id, p_site_manager_membership_id: smMembershipId });
  record("8. Octroi refusé — version qui n'est plus publiée", grantOld.error?.message === "version_not_published", err(grantOld));
  const grantByOwner = await owner.client.rpc("grant_project_plan_share", { p_project_id: pid, p_version_id: vCatalog.id, p_site_manager_membership_id: smMembershipId });
  record("8. Octroi refusé — OWNER/PRIMARY", grantByOwner.error?.message === "not_authorized", err(grantByOwner));
  const grant = await contractor.client.rpc("grant_project_plan_share", { p_project_id: pid, p_version_id: vCatalog.id, p_site_manager_membership_id: smMembershipId });
  const smAfter = await siteManager.client.rpc("get_published_project_plan_file", { p_project_id: pid });
  record("8. Octroi explicite — le SITE_MANAGER lit le plan publié", grant.error === null && smAfter.error === null, `${err(grant)} / ${err(smAfter)}`);
  const smDraft = await siteManager.client.rpc("get_project_plan_version_file_key", { p_version_id: vOwner.id });
  const smCandidates = await siteManager.client.rpc("list_project_plan_candidates", { p_project_id: pid });
  record("8. SITE_MANAGER — aucun accès aux brouillons ni aux candidats", smDraft.error?.message === "not_authorized" && smCandidates.error?.message === "not_authorized", `${err(smDraft)} / ${err(smCandidates)}`);
  const smHistory = await siteManager.client.rpc("list_project_plan_publications", { p_project_id: pid });
  record("8. SITE_MANAGER — historique des publications non accessible", smHistory.error?.message === "not_authorized", err(smHistory));

  const revoke = await contractor.client.rpc("revoke_project_plan_share", { p_share_id: grant.data.id });
  const smRevoked = await siteManager.client.rpc("get_published_project_plan_file", { p_project_id: pid });
  record("8. Révocation de l'octroi — le SITE_MANAGER perd l'accès", revoke.error === null && smRevoked.error?.message === "not_authorized", `${err(revoke)} / ${err(smRevoked)}`);

  await contractor.client.rpc("grant_project_plan_share", { p_project_id: pid, p_version_id: vCatalog.id, p_site_manager_membership_id: smMembershipId });
  await retain(owner, pid, vContractor.id);
  const ok3 = await publish(contractor.client, pid, vContractor.id);
  const smAfterRepublish = await siteManager.client.rpc("get_published_project_plan_file", { p_project_id: pid });
  record("8. Republication — l'octroi ne suit pas vers la nouvelle version (nouvel octroi requis)", ok3.error === null && smAfterRepublish.error?.message === "not_authorized", `${err(ok3)} / ${err(smAfterRepublish)}`);
  const shareUpd = await service.from("project_plan_shares").update({ granted_at_server: new Date().toISOString() }).eq("id", grant.data.id);
  record("8. Octroi — aucune modification hors révocation", shareUpd.error?.message?.includes("project_plan_share_immutable"), shareUpd.error?.message);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} tests réussis.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERREUR:", e.message);
  process.exitCode = 1;
});
