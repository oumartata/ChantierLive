// Test d'intégration LOCAL uniquement (aucune connexion cloud) pour B063
// (M020, project_plans/project_plan_versions/project_plan_version_shares).
// Couvre le périmètre revu avec le fondateur (D101-D107) : dépôt direct
// OWNER/PRIMARY et CONTRACTOR, partage explicite CONTRACTOR->OWNER/PRIMARY,
// désignation du retenu réservée à OWNER/PRIMARY avec concurrence optimiste,
// rattachement catalogue (version publiée figée), isolation, idempotence/
// reprise, nettoyage, et la paire prepare/finalize concurrente (même
// operation_uuid, deux connexions réelles) qui motivait l'ordre unifié de
// verrous (avisoire -> adhésion -> upload). Ne construit ni validation
// technique chantier (B064) ni devis (B065) ni accès client au catalogue
// (FR175, non livrée).
//
// Usage : node scripts/test-project-plans.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function isLocalSupabaseUrl(candidate) {
  try {
    const { hostname } = new URL(candidate);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

record("Garde-fou réseau — une URL cloud réelle est refusée", isLocalSupabaseUrl("https://xyzcompany.supabase.co") === false);
record("Garde-fou réseau — la destination réellement configurée est locale", isLocalSupabaseUrl(SUPABASE_URL) === true, SUPABASE_URL);
if (!isLocalSupabaseUrl(SUPABASE_URL)) {
  console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`);
  process.exit(1);
}
if (!SERVICE_KEY || !ANON_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY manquants.");
  process.exit(1);
}

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function createTestUser(label) {
  const email = `b063-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, email: email.toLowerCase(), client };
}

function checksumOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Crée un chantier via le vrai chemin applicatif (create_draft_project, B014).
// role='OWNER' -> organization_id toujours null (BR012/M004, vérifié dans la
// source) ; role='CONTRACTOR' -> organisation auto-provisionnée.
async function createDraftProject(ownerClient, role, label) {
  const { data, error } = await ownerClient.rpc("create_draft_project", {
    p_name: `B063 — ${label}`,
    p_country: "ML",
    p_role: role,
  });
  if (error) throw new Error(`create_draft_project(${label}): ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { projectId: row.project_id, membershipId: row.membership_id, organizationId: row.organization_id };
}

// Ajoute un membre à un chantier (service role, fixture directe — pas de
// flux d'invitation à tester ici, hors périmètre de B063).
async function addMembership(projectId, profileId, role, ownerProfile = null) {
  const { data, error } = await service
    .from("project_memberships")
    .insert({ project_id: projectId, profile_id: profileId, role, owner_profile: ownerProfile })
    .select("id")
    .single();
  if (error) throw new Error(`addMembership: ${error.message}`);
  return data.id;
}

async function revokeMembership(membershipId) {
  const { error } = await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("id", membershipId);
  if (error) throw new Error(`revokeMembership: ${error.message}`);
}

// Dépôt direct complet (prepare -> claim -> écriture/relecture RÉELLES dans
// Storage -> attest -> finalize), même discipline que B061/B026.
async function depositDirect(callerClient, projectId, bytes) {
  const operationUuid = randomUUID();
  const checksum = checksumOf(bytes);
  const { data: prep, error: prepErr } = await callerClient.rpc("prepare_project_plan_upload", {
    p_operation_uuid: operationUuid, p_project_id: projectId,
    p_expected_checksum: checksum, p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf",
  });
  if (prepErr) throw new Error(`prepare: ${prepErr.message}`);
  const { data: claim, error: claimErr } = await callerClient.rpc("claim_upload_attempt", {
    p_operation_uuid: operationUuid, p_expected_attempt_id: prep.attempt_id,
  });
  if (claimErr || !claim?.won) throw new Error(`claim: ${claimErr?.message ?? "not won"}`);
  const { error: writeErr } = await service.storage.from("project-plans").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false });
  if (writeErr) throw new Error(`storage.upload: ${writeErr.message}`);
  const { data: written, error: dlErr } = await service.storage.from("project-plans").download(claim.candidate_key);
  if (dlErr) throw new Error(`storage.download: ${dlErr.message}`);
  const writtenBytes = new Uint8Array(await written.arrayBuffer());
  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
    p_actual_checksum: checksumOf(writtenBytes), p_actual_size_bytes: writtenBytes.length, p_actual_mime_type: "application/pdf",
  });
  if (attestErr) throw new Error(`attest: ${attestErr.message}`);
  const { data: version, error: finErr } = await callerClient.rpc("finalize_project_plan_upload", { p_operation_uuid: operationUuid });
  if (finErr) throw new Error(`finalize: ${finErr.message}`);
  return { version, operationUuid };
}

async function main() {
  // =========================================================================
  // 1. Dépôt direct — OWNER/PRIMARY et CONTRACTOR
  // =========================================================================
  const clientOwner = await createTestUser("client-owner");
  const chantierClient = await createDraftProject(clientOwner.client, "OWNER", "chantier-client");
  record("Chantier OWNER — organization_id absent (BR012/M004)", chantierClient.organizationId === null, chantierClient.organizationId);

  const { version: vClientDirect } = await depositDirect(clientOwner.client, chantierClient.projectId, Buffer.from("PLAN-CLIENT-DIRECT"));
  record("Dépôt direct OWNER/PRIMARY — réussi", vClientDirect?.deposited_as_role === "OWNER_PRIMARY", JSON.stringify(vClientDirect));

  const contractorPro = await createTestUser("contractor-pro");
  const chantierPro = await createDraftProject(contractorPro.client, "CONTRACTOR", "chantier-pro");
  record("Chantier CONTRACTOR — organisation auto-provisionnée", !!chantierPro.organizationId);

  const { version: vProDirect } = await depositDirect(contractorPro.client, chantierPro.projectId, Buffer.from("PLAN-PRO-DIRECT"));
  record("Dépôt direct CONTRACTOR — réussi", vProDirect?.deposited_as_role === "CONTRACTOR", JSON.stringify(vProDirect));

  // Ajout du second acteur sur le chantier "pro" (le client) pour les tests de partage.
  const clientOnPro = await createTestUser("client-on-pro");
  await addMembership(chantierPro.projectId, clientOnPro.id, "OWNER", "PRIMARY");

  // Refus CO_OWNER/SITE_MANAGER sur les actes B063 (D101).
  const coOwnerUser = await createTestUser("co-owner");
  await addMembership(chantierPro.projectId, coOwnerUser.id, "OWNER", "CO_OWNER");
  const { error: coOwnerDepositErr } = await coOwnerUser.client.rpc("prepare_project_plan_upload", {
    p_operation_uuid: randomUUID(), p_project_id: chantierPro.projectId,
    p_expected_checksum: "x", p_expected_size_bytes: 1, p_expected_mime_type: "application/pdf",
  });
  record("Dépôt refusé — CO_OWNER (D101, acte propre à B063)", coOwnerDepositErr?.message === "not_authorized", coOwnerDepositErr?.message);

  // =========================================================================
  // 2. Lecture — prédicats, refus d'héritage, révocation
  // =========================================================================

  // Dépôt CONTRACTOR : lisible par lui-même (identité+rôle), PAS par OWNER/PRIMARY sans partage.
  const { data: fileKeyContractorSelf, error: fkContractorSelfErr } = await contractorPro.client.rpc("get_project_plan_version_file_key", { p_version_id: vProDirect.id });
  record("Lecture — CONTRACTOR lit son propre dépôt", fkContractorSelfErr === null && !!fileKeyContractorSelf, fkContractorSelfErr?.message);

  const { error: fkOwnerBeforeShareErr } = await clientOnPro.client.rpc("get_project_plan_version_file_key", { p_version_id: vProDirect.id });
  record("Lecture refusée — OWNER/PRIMARY AVANT partage (D104)", fkOwnerBeforeShareErr?.message === "not_authorized", fkOwnerBeforeShareErr?.message);

  // Dépôt OWNER/PRIMARY (chantier client) : lisible par lui-même sans partage. Pas de CONTRACTOR sur ce chantier pour tester l'autre sens ici (couvert ci-dessous sur chantierPro).
  const { data: fileKeyOwnerSelf, error: fkOwnerSelfErr } = await clientOwner.client.rpc("get_project_plan_version_file_key", { p_version_id: vClientDirect.id });
  record("Lecture — OWNER/PRIMARY lit son propre dépôt sans partage (D105)", fkOwnerSelfErr === null && !!fileKeyOwnerSelf, fkOwnerSelfErr?.message);

  // Dépôt OWNER/PRIMARY sur chantierPro : lisible par CONTRACTOR actif sans partage (D105, rôle seul).
  const { version: vClientOnProDirect } = await depositDirect(clientOnPro.client, chantierPro.projectId, Buffer.from("PLAN-CLIENT-ON-PRO"));
  const { data: fileKeyContractorReadsClient, error: fkContractorReadsClientErr } = await contractorPro.client.rpc("get_project_plan_version_file_key", { p_version_id: vClientOnProDirect.id });
  record("Lecture — CONTRACTOR actif lit un dépôt OWNER/PRIMARY sans partage (D105, rôle seul)", fkContractorReadsClientErr === null && !!fileKeyContractorReadsClient, fkContractorReadsClientErr?.message);

  // Partage réservé au CONTRACTOR déposant — un autre CONTRACTOR (aucun ici) ou un OWNER ne peut pas partager.
  const { error: shareByOwnerErr } = await clientOnPro.client.rpc("share_project_plan_version_with_owner", { p_version_id: vProDirect.id });
  record("Partage refusé — appelant non-CONTRACTOR (OWNER/PRIMARY)", shareByOwnerErr?.message === "not_authorized", shareByOwnerErr?.message);

  const { data: shareRow, error: shareErr } = await contractorPro.client.rpc("share_project_plan_version_with_owner", { p_version_id: vProDirect.id });
  record("Partage — CONTRACTOR déposant, actif et vérifié", shareErr === null && shareRow?.project_plan_version_id === vProDirect.id, shareErr?.message);

  // Contenu de la version inchangé après le partage (immutabilité préservée par une table séparée).
  const { data: versionAfterShare } = await service.from("project_plan_versions").select("private_object_upload_id, version_number").eq("id", vProDirect.id).single();
  record("Immutabilité — contenu de la version inchangé après le partage", versionAfterShare?.private_object_upload_id === vProDirect.private_object_upload_id, JSON.stringify(versionAfterShare));

  const { error: mutateVersionErr } = await service.from("project_plan_versions").update({ version_number: 999 }).eq("id", vProDirect.id);
  record("Immutabilité — UPDATE direct sur la version refusé (trigger)", mutateVersionErr?.message?.includes("project_plan_version_immutable"), mutateVersionErr?.message);

  const { data: fileKeyOwnerAfterShare, error: fkOwnerAfterShareErr } = await clientOnPro.client.rpc("get_project_plan_version_file_key", { p_version_id: vProDirect.id });
  record("Lecture — OWNER/PRIMARY lit APRÈS partage (D104)", fkOwnerAfterShareErr === null && !!fileKeyOwnerAfterShare, fkOwnerAfterShareErr?.message);

  // Révocation : le déposant perd l'accès à son propre dépôt une fois son adhésion révoquée.
  const secondContractorScenarioOwner = await createTestUser("owner-revoke-scenario");
  const chantierRevoke = await createDraftProject(secondContractorScenarioOwner.client, "CONTRACTOR", "chantier-revocation");
  const { version: vRevokeTest } = await depositDirect(secondContractorScenarioOwner.client, chantierRevoke.projectId, Buffer.from("PLAN-REVOKE-TEST"));
  await revokeMembership(chantierRevoke.membershipId);
  const { error: fkAfterRevokeErr } = await secondContractorScenarioOwner.client.rpc("get_project_plan_version_file_key", { p_version_id: vRevokeTest.id });
  record("Lecture refusée — déposant dont l'adhésion est révoquée (droits courants, pas seulement l'identité)", fkAfterRevokeErr?.message === "not_authorized", fkAfterRevokeErr?.message);

  // "Transfert" : un NOUVEAU CONTRACTOR (successeur, sur un chantier DÉDIÉ —
  // un seul CONTRACTOR actif à la fois par chantier, contrainte existante)
  // n'hérite PAS des brouillons privés du prédécesseur.
  const predecessorContractor = await createTestUser("predecessor-contractor");
  const chantierSuccession = await createDraftProject(predecessorContractor.client, "CONTRACTOR", "chantier-succession");
  const { version: vPredecessorDraft } = await depositDirect(predecessorContractor.client, chantierSuccession.projectId, Buffer.from("PLAN-PREDECESSOR-PRIVE"));
  await revokeMembership(chantierSuccession.membershipId);
  const successorContractor = await createTestUser("successor-contractor");
  await addMembership(chantierSuccession.projectId, successorContractor.id, "CONTRACTOR");
  const { error: successorReadErr } = await successorContractor.client.rpc("get_project_plan_version_file_key", { p_version_id: vPredecessorDraft.id });
  record("Lecture refusée — un nouveau CONTRACTOR n'hérite PAS des brouillons privés du prédécesseur", successorReadErr?.message === "not_authorized", successorReadErr?.message);

  // =========================================================================
  // 3. Désignation du retenu — OWNER/PRIMARY seul, concurrence optimiste
  // =========================================================================
  const { error: retainByContractorErr } = await contractorPro.client.rpc("set_retained_project_plan_version", {
    p_project_id: chantierPro.projectId, p_version_id: vProDirect.id, p_expected_revision: 0,
  });
  record("Désignation refusée — CONTRACTOR (réservée à OWNER/PRIMARY, D103)", retainByContractorErr?.message === "not_authorized", retainByContractorErr?.message);

  const { data: projBefore } = await service.from("projects").select("revision").eq("id", chantierPro.projectId).single();
  const { data: retained1, error: retain1Err } = await clientOnPro.client.rpc("set_retained_project_plan_version", {
    p_project_id: chantierPro.projectId, p_version_id: vProDirect.id, p_expected_revision: projBefore.revision,
  });
  record("Désignation — OWNER/PRIMARY, version partagée, revision correcte", retain1Err === null && retained1?.retained_plan_version_id === vProDirect.id, retain1Err?.message);

  // Conflit : deux désignations concurrentes depuis le MÊME état initial (même revision attendue).
  const { data: projAfter1 } = await service.from("projects").select("revision").eq("id", chantierPro.projectId).single();
  const [raceA, raceB] = await Promise.allSettled([
    clientOnPro.client.rpc("set_retained_project_plan_version", { p_project_id: chantierPro.projectId, p_version_id: vClientOnProDirect.id, p_expected_revision: projAfter1.revision }),
    clientOnPro.client.rpc("set_retained_project_plan_version", { p_project_id: chantierPro.projectId, p_version_id: vProDirect.id, p_expected_revision: projAfter1.revision }),
  ]);
  const raceErrors = [raceA, raceB].map((r) => (r.status === "fulfilled" ? r.value.error?.message ?? null : r.reason?.message ?? "rejected"));
  const raceOk = raceErrors.filter((e) => e === null).length === 1 && raceErrors.filter((e) => e === "retained_plan_conflict").length === 1;
  record("Conflit — deux désignations concurrentes depuis le même état : une seule réussit, l'autre retained_plan_conflict sans écriture", raceOk, JSON.stringify(raceErrors));

  const { version: vUnsharedOnPro } = await depositDirect(contractorPro.client, chantierPro.projectId, Buffer.from("PLAN-JAMAIS-PARTAGE"));
  const { error: retainNotSharedErr } = await clientOnPro.client.rpc("set_retained_project_plan_version", {
    p_project_id: chantierPro.projectId, p_version_id: vUnsharedOnPro.id, p_expected_revision: 999,
  });
  record("Désignation refusée — version non partagée (not_readable, avant même la revision)", retainNotSharedErr?.message === "not_readable", retainNotSharedErr?.message);

  // =========================================================================
  // 4. Catalogue — version publiée exacte figée, droits séparés
  // =========================================================================
  const engineerForCatalog = await createTestUser("engineer-catalog");
  const { data: itemForProject } = await contractorPro.client.rpc("create_catalog_item", { p_organization_id: chantierPro.organizationId, p_label: "Modèle pour chantier pro" });
  const designationId = await (async () => {
    const { data, error } = await contractorPro.client.rpc("designate_plan_engineer", { p_organization_id: chantierPro.organizationId, p_identifier_kind: "EMAIL", p_identifier_value: engineerForCatalog.email });
    if (error) throw new Error(`designate: ${error.message}`);
    return data.id;
  })();

  // Dépose + valide + publie une version catalogue (réutilise B061, inchangé).
  const catalogOpUuid = randomUUID();
  const catalogBytes = Buffer.from("PLAN-CATALOGUE-POUR-CHANTIER");
  const catalogChecksum = checksumOf(catalogBytes);
  const { data: catPrep, error: catPrepErr } = await contractorPro.client.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: catalogOpUuid, p_organization_id: chantierPro.organizationId, p_catalog_item_id: itemForProject.id,
    p_expected_checksum: catalogChecksum, p_expected_size_bytes: catalogBytes.length, p_expected_mime_type: "application/pdf",
  });
  if (catPrepErr) throw new Error(`catPrep: ${catPrepErr.message}`);
  const { data: catClaim, error: catClaimErr } = await contractorPro.client.rpc("claim_upload_attempt", { p_operation_uuid: catalogOpUuid, p_expected_attempt_id: catPrep.attempt_id });
  if (catClaimErr || !catClaim?.won) throw new Error(`catClaim: ${catClaimErr?.message ?? "not won"}`);
  await service.storage.from("organization-catalog").upload(catClaim.candidate_key, catalogBytes, { contentType: "application/pdf", upsert: false });
  const { data: catWritten } = await service.storage.from("organization-catalog").download(catClaim.candidate_key);
  const catWrittenBytes = new Uint8Array(await catWritten.arrayBuffer());
  await service.rpc("attest_storage_verified", { p_operation_uuid: catalogOpUuid, p_attempt_id: catClaim.attempt_id, p_actual_checksum: checksumOf(catWrittenBytes), p_actual_size_bytes: catWrittenBytes.length, p_actual_mime_type: "application/pdf" });
  const { data: catVersion, error: catFinErr } = await contractorPro.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: catalogOpUuid });
  if (catFinErr) throw new Error(`catFin: ${catFinErr.message}`);
  const { data: catSubmission, error: catSubErr } = await contractorPro.client.rpc("submit_catalog_item_version_for_validation", { p_version_id: catVersion.id, p_designation_id: designationId });
  if (catSubErr) throw new Error(`catSub: ${catSubErr.message}`);
  const { error: catDecideErr } = await engineerForCatalog.client.rpc("decide_catalog_item_validation", { p_validation_id: catSubmission.id, p_decision: "VALIDATED", p_note: null });
  if (catDecideErr) throw new Error(`catDecide: ${catDecideErr.message}`);
  const { error: catPubErr } = await contractorPro.client.rpc("publish_catalog_item_version", { p_version_id: catVersion.id });
  if (catPubErr) throw new Error(`catPub: ${catPubErr.message}`);

  const { error: attachByOutsiderErr } = await coOwnerUser.client.rpc("attach_catalog_plan_to_project", { p_project_id: chantierPro.projectId, p_catalog_item_id: itemForProject.id });
  record("Rattachement catalogue refusé — CO_OWNER (D101)", attachByOutsiderErr?.message === "not_authorized", attachByOutsiderErr?.message);

  const { error: attachByClientNonOwnerErr } = await clientOnPro.client.rpc("attach_catalog_plan_to_project", { p_project_id: chantierPro.projectId, p_catalog_item_id: itemForProject.id });
  record("Rattachement catalogue refusé — OWNER/PRIMARY habilité chantier mais PAS propriétaire de l'organisation (D107)", attachByClientNonOwnerErr?.message === "not_authorized", attachByClientNonOwnerErr?.message);

  const { data: attachedVersion, error: attachErr } = await contractorPro.client.rpc("attach_catalog_plan_to_project", { p_project_id: chantierPro.projectId, p_catalog_item_id: itemForProject.id });
  record("Rattachement catalogue réussi — CONTRACTOR habilité ET propriétaire de l'organisation", attachErr === null && attachedVersion?.catalog_item_version_id === catVersion.id, attachErr?.message);

  const { error: attachNoOrgErr } = await clientOwner.client.rpc("attach_catalog_plan_to_project", { p_project_id: chantierClient.projectId, p_catalog_item_id: itemForProject.id });
  record("Rattachement catalogue refusé — chantier sans organisation (no_organization)", attachNoOrgErr?.message === "no_organization", attachNoOrgErr?.message);

  // Version publiée exacte figée : republication catalogue postérieure ne change pas la référence déjà attachée.
  const catalogOpUuid2 = randomUUID();
  const catalogBytes2 = Buffer.from("PLAN-CATALOGUE-V2-APRES-RATTACHEMENT");
  const catalogChecksum2 = checksumOf(catalogBytes2);
  const { data: catPrep2 } = await contractorPro.client.rpc("prepare_catalog_item_upload", { p_operation_uuid: catalogOpUuid2, p_organization_id: chantierPro.organizationId, p_catalog_item_id: itemForProject.id, p_expected_checksum: catalogChecksum2, p_expected_size_bytes: catalogBytes2.length, p_expected_mime_type: "application/pdf" });
  const { data: catClaim2 } = await contractorPro.client.rpc("claim_upload_attempt", { p_operation_uuid: catalogOpUuid2, p_expected_attempt_id: catPrep2.attempt_id });
  await service.storage.from("organization-catalog").upload(catClaim2.candidate_key, catalogBytes2, { contentType: "application/pdf", upsert: false });
  const { data: catWritten2 } = await service.storage.from("organization-catalog").download(catClaim2.candidate_key);
  const catWrittenBytes2 = new Uint8Array(await catWritten2.arrayBuffer());
  await service.rpc("attest_storage_verified", { p_operation_uuid: catalogOpUuid2, p_attempt_id: catClaim2.attempt_id, p_actual_checksum: checksumOf(catWrittenBytes2), p_actual_size_bytes: catWrittenBytes2.length, p_actual_mime_type: "application/pdf" });
  const { data: catVersion2 } = await contractorPro.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: catalogOpUuid2 });
  const { data: catSubmission2 } = await contractorPro.client.rpc("submit_catalog_item_version_for_validation", { p_version_id: catVersion2.id, p_designation_id: designationId });
  await engineerForCatalog.client.rpc("decide_catalog_item_validation", { p_validation_id: catSubmission2.id, p_decision: "VALIDATED", p_note: null });
  await contractorPro.client.rpc("publish_catalog_item_version", { p_version_id: catVersion2.id });
  const { data: attachedVersionReread } = await service.from("project_plan_versions").select("catalog_item_version_id").eq("id", attachedVersion.id).single();
  record("Version publiée figée — republication catalogue postérieure ne remplace PAS la référence déjà attachée", attachedVersionReread.catalog_item_version_id === catVersion.id, attachedVersionReread.catalog_item_version_id);

  // =========================================================================
  // 5. Isolation
  // =========================================================================
  const { error: crossProjectReadErr } = await contractorPro.client.rpc("get_project_plan_version_file_key", { p_version_id: vClientDirect.id });
  record("Isolation — CONTRACTOR d'un autre chantier ne lit pas un dépôt étranger", crossProjectReadErr?.message === "not_authorized", crossProjectReadErr?.message);

  // =========================================================================
  // 6. Idempotence / reprise (RPC directes, réponse perdue après finalisation)
  // =========================================================================
  const { version: vIdem, operationUuid: opIdem } = await depositDirect(contractorPro.client, chantierPro.projectId, Buffer.from("PLAN-IDEMPOTENCE"));
  const { data: idemReplay, error: idemReplayErr } = await contractorPro.client.rpc("finalize_project_plan_upload", { p_operation_uuid: opIdem });
  record("Idempotence — rejeu de finalize renvoie la MÊME version", idemReplayErr === null && idemReplay?.id === vIdem.id, idemReplayErr?.message);
  const { data: idemRows } = await service.from("project_plan_versions").select("id").eq("private_object_upload_id", vIdem.private_object_upload_id);
  record("Idempotence — une seule ligne version existe", (idemRows ?? []).length === 1);

  // Reprise réelle d'une tentative expirée.
  const expireOp = randomUUID();
  const expireBytes = Buffer.from("PLAN-EXPIRATION-REPRISE");
  const { data: expirePrep } = await contractorPro.client.rpc("prepare_project_plan_upload", { p_operation_uuid: expireOp, p_project_id: chantierPro.projectId, p_expected_checksum: checksumOf(expireBytes), p_expected_size_bytes: expireBytes.length, p_expected_mime_type: "application/pdf" });
  const { data: expireClaim } = await contractorPro.client.rpc("claim_upload_attempt", { p_operation_uuid: expireOp, p_expected_attempt_id: expirePrep.attempt_id });
  const oldAttemptId = expireClaim.attempt_id;
  await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 60000).toISOString() }).eq("operation_uuid", expireOp);
  const { data: recovered, error: recoverErr } = await contractorPro.client.rpc("recover_media_upload_attempt", { p_operation_uuid: expireOp });
  record("Reprise réelle — nouvel attempt_id après expiration", recoverErr === null && recovered?.attempt_id !== oldAttemptId, recoverErr?.message);
  const { data: reClaim } = await contractorPro.client.rpc("claim_upload_attempt", { p_operation_uuid: expireOp, p_expected_attempt_id: recovered.attempt_id });
  await service.storage.from("project-plans").upload(reClaim.candidate_key, expireBytes, { contentType: "application/pdf", upsert: false });
  const { data: reWritten } = await service.storage.from("project-plans").download(reClaim.candidate_key);
  const reWrittenBytes = new Uint8Array(await reWritten.arrayBuffer());
  await service.rpc("attest_storage_verified", { p_operation_uuid: expireOp, p_attempt_id: reClaim.attempt_id, p_actual_checksum: checksumOf(reWrittenBytes), p_actual_size_bytes: reWrittenBytes.length, p_actual_mime_type: "application/pdf" });
  const { data: expireVersion, error: expireFinErr } = await contractorPro.client.rpc("finalize_project_plan_upload", { p_operation_uuid: expireOp });
  record("Reprise réelle — succès après reprise, une seule version", expireFinErr === null && !!expireVersion?.id, expireFinErr?.message);

  // =========================================================================
  // 7. Nettoyage — troisième domaine branché
  // =========================================================================
  const cleanupOp = randomUUID();
  const cleanupBytes = Buffer.from("PLAN-NETTOYAGE");
  const { data: cleanupPrep } = await contractorPro.client.rpc("prepare_project_plan_upload", { p_operation_uuid: cleanupOp, p_project_id: chantierPro.projectId, p_expected_checksum: checksumOf(cleanupBytes), p_expected_size_bytes: cleanupBytes.length, p_expected_mime_type: "application/pdf" });
  const { data: cleanupClaim } = await contractorPro.client.rpc("claim_upload_attempt", { p_operation_uuid: cleanupOp, p_expected_attempt_id: cleanupPrep.attempt_id });
  await service.storage.from("project-plans").upload(cleanupClaim.candidate_key, cleanupBytes, { contentType: "application/pdf", upsert: false });
  await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 3600 * 1000).toISOString() }).eq("operation_uuid", cleanupOp);

  const { data: expiredList, error: expiredListErr } = await service.rpc("list_expired_project_plan_uploads", { p_older_than: "0 seconds" });
  const expiredRow = (expiredList ?? []).find((r) => r.project_id === chantierPro.projectId && r.id);
  record("Nettoyage — upload expiré sélectionné", expiredListErr === null && !!expiredRow, expiredListErr?.message);

  const { data: didAbandon } = await service.rpc("abandon_expired_project_plan_upload", { p_id: expiredRow.id, p_older_than: "0 seconds" });
  record("Nettoyage — abandon réel", didAbandon === true);

  const { data: staleTrace } = await service.from("private_object_stale_keys").select("id, storage_key").eq("private_object_upload_id", expiredRow.id);
  const candidateTrace = (staleTrace ?? []).find((t) => t.storage_key.includes("/candidates/"));
  const { data: bucketForTrace } = await service.rpc("get_stale_key_bucket", { p_id: candidateTrace.id });
  record("Nettoyage — bucket sélectionné côté serveur = project-plans", bucketForTrace === "project-plans", bucketForTrace);

  const { data: candidateBeforeDelete } = await service.storage.from("project-plans").download(candidateTrace.storage_key);
  record("Nettoyage — candidate orpheline existe réellement avant suppression", !!candidateBeforeDelete);
  const { data: claimedForCleanup } = await service.rpc("claim_stale_key_for_cleanup", { p_id: candidateTrace.id });
  const { error: realRemoveErr } = await service.storage.from(bucketForTrace).remove([claimedForCleanup[0].storage_key]);
  record("Nettoyage — suppression réelle réussie dans le bon bucket", realRemoveErr === null, realRemoveErr?.message);
  if (!realRemoveErr) await service.rpc("mark_stale_key_cleaned", { p_id: candidateTrace.id });
  const { data: candidateAfterDelete } = await service.storage.from("project-plans").download(candidateTrace.storage_key);
  record("Nettoyage — candidate réellement absente après suppression", !candidateAfterDelete);

  // Protection FINALIZED : le fichier de vIdem (jamais tracé comme stale) reste intact.
  const { data: idemUploadRow } = await service.from("private_object_uploads").select("storage_key, status").eq("id", vIdem.private_object_upload_id).single();
  const { data: idemStaleTrace } = await service.from("private_object_stale_keys").select("id").eq("storage_key", idemUploadRow.storage_key);
  record("Protection FINALIZED — fichier idempotent jamais tracé comme obsolète", idemUploadRow.status === "FINALIZED" && (idemStaleTrace ?? []).length === 0);

  // =========================================================================
  // 8. Concurrence RÉELLE prepare/finalize — MÊME operation_uuid, deux connexions
  // =========================================================================
  const concClient = await createTestUser("concurrence");
  const chantierConc = await createDraftProject(concClient.client, "CONTRACTOR", "chantier-concurrence");
  const concOp = randomUUID();
  const concBytes = Buffer.from("PLAN-CONCURRENCE-PREPARE-FINALIZE");
  const concChecksum = checksumOf(concBytes);

  // Prépare et pousse une première fois jusqu'à FINALIZING (attesté, prêt à finaliser).
  const { data: concPrep } = await concClient.client.rpc("prepare_project_plan_upload", { p_operation_uuid: concOp, p_project_id: chantierConc.projectId, p_expected_checksum: concChecksum, p_expected_size_bytes: concBytes.length, p_expected_mime_type: "application/pdf" });
  const { data: concClaim } = await concClient.client.rpc("claim_upload_attempt", { p_operation_uuid: concOp, p_expected_attempt_id: concPrep.attempt_id });
  await service.storage.from("project-plans").upload(concClaim.candidate_key, concBytes, { contentType: "application/pdf", upsert: false });
  const { data: concWritten } = await service.storage.from("project-plans").download(concClaim.candidate_key);
  const concWrittenBytes = new Uint8Array(await concWritten.arrayBuffer());
  await service.rpc("attest_storage_verified", { p_operation_uuid: concOp, p_attempt_id: concClaim.attempt_id, p_actual_checksum: checksumOf(concWrittenBytes), p_actual_size_bytes: concWrittenBytes.length, p_actual_mime_type: "application/pdf" });

  // Deux CONNEXIONS RÉELLES distinctes (clients supabase-js séparés, même utilisateur) :
  // l'une appelle finalize (tient avisoire->adhésion->ligne upload), l'autre rejoue
  // prepare pour le MÊME operation_uuid (réconciliation), au même instant.
  const concClientB = createClient(SUPABASE_URL, ANON_KEY);
  await concClientB.auth.setSession((await concClient.client.auth.getSession()).data.session);

  const [finalizeResult, prepareReplayResult] = await Promise.allSettled([
    concClient.client.rpc("finalize_project_plan_upload", { p_operation_uuid: concOp }),
    concClientB.rpc("prepare_project_plan_upload", { p_operation_uuid: concOp, p_project_id: chantierConc.projectId, p_expected_checksum: concChecksum, p_expected_size_bytes: concBytes.length, p_expected_mime_type: "application/pdf" }),
  ]);

  // Deux issues légitimes pour le prepare rejoué, selon l'ordre réel d'acquisition
  // des verrous : il passe AVANT finalize (renvoie la ligne existante, non
  // finalisée) ou APRÈS (operation_already_finalized, règle commune M010/M019 :
  // aucune nouvelle URL d'écriture sur une opération FINALIZED). Un interblocage
  // (deadlock detected) ou toute autre erreur reste un échec.
  const finalizeOk = finalizeResult.status === "fulfilled" && !finalizeResult.value.error && !!finalizeResult.value.data?.id;
  const prepareReplayOk =
    prepareReplayResult.status === "fulfilled" &&
    (!prepareReplayResult.value.error || prepareReplayResult.value.error.message === "operation_already_finalized");
  record(
    "Concurrence prepare/finalize (même operation_uuid, 2 connexions réelles) — aucun interblocage, finalize aboutit, prepare rejoué renvoie la ligne existante ou operation_already_finalized",
    finalizeOk && prepareReplayOk,
    JSON.stringify({
      finalize: finalizeResult.status === "fulfilled" ? finalizeResult.value.error?.message ?? "ok" : finalizeResult.reason?.message,
      prepareReplay: prepareReplayResult.status === "fulfilled" ? prepareReplayResult.value.error?.message ?? "ok" : prepareReplayResult.reason?.message,
    })
  );
  const { data: concVersions } = await service.from("project_plan_versions").select("id").eq("project_id", chantierConc.projectId);
  record("Concurrence prepare/finalize — une seule version créée malgré l'entrelacement", (concVersions ?? []).length === 1, (concVersions ?? []).length);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${total} tests réussis.`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERREUR:", err.message);
  process.exitCode = 1;
});
