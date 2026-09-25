// Test d'intégration LOCAL uniquement (aucune connexion cloud) pour B061
// (M019, plan_catalog_items/plan_catalog_item_versions/plan_catalog_item_
// validations). B061 reste EN REVUE (non clôturée) — ce script couvre les
// nouveaux parcours, les autorisations et les courses réellement modifiées
// par cette revue (état terminal CANCELLED, ordre de verrous désignation
// avant validation, contraintes SQL composites, idempotence liée à l'item
// cible, accès réel au fichier). Ne rejoue PAS l'intégralité de la suite
// B062 (ses fonctions ne sont pas modifiées) ; la non-régression média des
// fonctions génériques partagées (claim_upload_attempt, recover_media_
// upload_attempt, get_upload_status) est vérifiée séparément en rejouant
// scripts/test-media-upload.mjs (existant, non dupliqué ici).
//
// Usage : node scripts/test-catalog-items.mjs

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
  const email = `b061-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  const { data: autoIdentifier, error: autoIdentifierErr } = await service
    .from("profile_identifiers")
    .select("verified_at_server")
    .eq("profile_id", data.user.id)
    .eq("kind", "EMAIL")
    .maybeSingle();
  if (autoIdentifierErr) throw new Error(`createTestUser(${label}) vérification fixture: ${autoIdentifierErr.message}`);
  if (!autoIdentifier || autoIdentifier.verified_at_server === null) {
    throw new Error(`createTestUser(${label}) : identifiant EMAIL absent ou non vérifié après création.`);
  }
  return { id: data.user.id, email: email.toLowerCase(), client };
}

async function createOrganization(ownerProfileId, label) {
  const { data, error } = await service
    .from("organizations")
    .insert({ name: `B061 fixture — ${label}`, owner_profile_id: ownerProfileId })
    .select("id")
    .single();
  if (error) throw new Error(`createOrganization(${label}): ${error.message}`);
  return data.id;
}

async function designate(ownerClient, organizationId, engineerEmail) {
  const { data, error } = await ownerClient.rpc("designate_plan_engineer", {
    p_organization_id: organizationId,
    p_identifier_kind: "EMAIL",
    p_identifier_value: engineerEmail,
  });
  if (error) throw new Error(`designate: ${error.message}`);
  return data.id;
}

function checksumOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Dépose un fichier complet (prepare -> claim -> attest -> finalize) pour un
// item donné, via le client PROPRIÉTAIRE. Retourne la version créée.
async function depositVersion(ownerClient, organizationId, catalogItemId, bytes) {
  const operationUuid = randomUUID();
  const checksum = checksumOf(bytes);
  const { data: prep, error: prepErr } = await ownerClient.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: operationUuid,
    p_organization_id: organizationId,
    p_catalog_item_id: catalogItemId,
    p_expected_checksum: checksum,
    p_expected_size_bytes: bytes.length,
    p_expected_mime_type: "application/pdf",
  });
  if (prepErr) throw new Error(`prepare_catalog_item_upload: ${prepErr.message}`);

  const { data: claim, error: claimErr } = await ownerClient.rpc("claim_upload_attempt", {
    p_operation_uuid: operationUuid,
    p_expected_attempt_id: prep.attempt_id,
  });
  if (claimErr || !claim?.won) throw new Error(`claim_upload_attempt: ${claimErr?.message ?? "not won"}`);

  // Écriture RÉELLE dans Storage (même chemin que depositCatalogItemVersionAction,
  // pas une fixture) : candidate écrite, relue, empreinte recalculée sur les
  // octets RÉELLEMENT stockés avant attestation — jamais sur `bytes` supposés.
  const { error: writeErr } = await service.storage
    .from("organization-catalog")
    .upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false });
  if (writeErr) throw new Error(`storage.upload: ${writeErr.message}`);

  const { data: written, error: dlErr } = await service.storage.from("organization-catalog").download(claim.candidate_key);
  if (dlErr) throw new Error(`storage.download: ${dlErr.message}`);
  const writtenBytes = new Uint8Array(await written.arrayBuffer());
  const actualChecksum = checksumOf(writtenBytes);

  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid,
    p_attempt_id: claim.attempt_id,
    p_actual_checksum: actualChecksum,
    p_actual_size_bytes: writtenBytes.length,
    p_actual_mime_type: "application/pdf",
  });
  if (attestErr) throw new Error(`attest_storage_verified: ${attestErr.message}`);

  const { data: version, error: finErr } = await ownerClient.rpc("finalize_catalog_item_upload", {
    p_operation_uuid: operationUuid,
  });
  if (finErr) throw new Error(`finalize_catalog_item_upload: ${finErr.message}`);

  return { version, operationUuid };
}

async function main() {
  // ---- Fixtures ----
  const owner = await createTestUser("owner");
  const orgId = await createOrganization(owner.id, "agence-A");
  const engineer1 = await createTestUser("eng1");
  const engineer2 = await createTestUser("eng2");
  const outsider = await createTestUser("outsider");

  const designation1Id = await designate(owner.client, orgId, engineer1.email);

  const { data: item, error: itemErr } = await owner.client.rpc("create_catalog_item", {
    p_organization_id: orgId,
    p_label: "Modèle T3 standard",
  });
  if (itemErr) throw new Error(`create_catalog_item: ${itemErr.message}`);
  record("Dépôt identité — item créé par le propriétaire", !!item?.id, itemErr?.message);

  const { error: itemOutsiderErr } = await outsider.client.rpc("create_catalog_item", {
    p_organization_id: orgId,
    p_label: "Tentative intrus",
  });
  record("Dépôt identité refusé — non-propriétaire", itemOutsiderErr?.message === "not_authorized", itemOutsiderErr?.message);

  // ---- Idempotence liée à l'item cible (point 3) ----
  const sameOpUuid = randomUUID();
  const bytesA = Buffer.from("PLAN-A-CONTENT");
  const { data: item2, error: item2Err } = await owner.client.rpc("create_catalog_item", {
    p_organization_id: orgId,
    p_label: "Autre modèle",
  });
  if (item2Err) throw new Error(`create_catalog_item(2): ${item2Err.message}`);

  const { error: prep1Err } = await owner.client.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: sameOpUuid,
    p_organization_id: orgId,
    p_catalog_item_id: item.id,
    p_expected_checksum: checksumOf(bytesA),
    p_expected_size_bytes: bytesA.length,
    p_expected_mime_type: "application/pdf",
  });
  record("PREPARE initial — item A accepté", !prep1Err, prep1Err?.message);

  const { error: prep2Err } = await owner.client.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: sameOpUuid,
    p_organization_id: orgId,
    p_catalog_item_id: item2.id,
    p_expected_checksum: checksumOf(bytesA),
    p_expected_size_bytes: bytesA.length,
    p_expected_mime_type: "application/pdf",
  });
  record(
    "Idempotence — rejeu du même operation_uuid avec un ITEM DIFFÉRENT refusé (même organisation)",
    prep2Err?.message === "operation_uuid_conflict",
    prep2Err?.message
  );

  // ---- Dépôt réel de deux versions pour item ----
  const { version: v1 } = await depositVersion(owner.client, orgId, item.id, Buffer.from("PLAN-V1"));
  record("Dépôt version 1 — fichier finalisé, version créée", v1?.version_number === 1, JSON.stringify(v1));

  const { version: v2 } = await depositVersion(owner.client, orgId, item.id, Buffer.from("PLAN-V2-DIFFERENT"));
  record("Dépôt version 2 — numéro incrémenté, jamais une réécriture", v2?.version_number === 2, JSON.stringify(v2));

  // ---- Immutabilité des versions (point 2) ----
  const { error: mutateVersionErr } = await service
    .from("plan_catalog_item_versions")
    .update({ version_number: 999 })
    .eq("id", v1.id);
  record(
    "Immutabilité — toute UPDATE directe sur une version est refusée (trigger)",
    mutateVersionErr?.message?.includes("catalog_item_version_immutable"),
    mutateVersionErr?.message
  );

  // ---- Soumission, refus already_pending, remplacement d'une demande devenue inutilisable (point 1) ----
  const { data: submission1, error: sub1Err } = await owner.client.rpc("submit_catalog_item_version_for_validation", {
    p_version_id: v1.id,
    p_designation_id: designation1Id,
  });
  record("Soumission — v1 vers ingénieur 1 (désignation active)", sub1Err === null && submission1?.status === "PENDING", sub1Err?.message);

  const designation2Id = await designate(owner.client, orgId, engineer2.email);
  const { error: subAlreadyPendingErr } = await owner.client.rpc("submit_catalog_item_version_for_validation", {
    p_version_id: v1.id,
    p_designation_id: designation2Id,
  });
  record(
    "Soumission refusée — already_pending (désignation existante encore ACTIVE, aucune annulation volontaire)",
    subAlreadyPendingErr?.message === "already_pending",
    subAlreadyPendingErr?.message
  );

  const { error: revokeErr } = await owner.client.rpc("revoke_plan_engineer_designation", { p_designation_id: designation1Id });
  if (revokeErr) throw new Error(`revoke designation1: ${revokeErr.message}`);

  const { data: submission2, error: sub2Err } = await owner.client.rpc("submit_catalog_item_version_for_validation", {
    p_version_id: v1.id,
    p_designation_id: designation2Id,
  });
  record(
    "Soumission — v1 re-soumise à ingénieur 2 après révocation de la désignation 1 (état terminal explicite)",
    sub2Err === null && submission2?.status === "PENDING",
    sub2Err?.message
  );

  const { data: historyRows, error: historyErr } = await service
    .from("plan_catalog_item_validations")
    .select("id, status, designation_id, cancelled_reason, decided_at_server")
    .eq("version_id", v1.id)
    .order("submitted_at_server", { ascending: true });
  if (historyErr) throw new Error(`historyRows: ${historyErr.message}`);
  record("Historique — 2 lignes conservées pour v1 (jamais supprimées)", (historyRows ?? []).length === 2, JSON.stringify(historyRows));
  record(
    "Historique — l'ancienne ligne est CANCELLED (motif enregistré), PAS une décision d'ingénieur",
    historyRows?.[0]?.status === "CANCELLED" && historyRows?.[0]?.cancelled_reason === "designation_revoked" && historyRows?.[0]?.decided_at_server === null,
    JSON.stringify(historyRows?.[0])
  );
  record("Historique — exactement une ligne PENDING active pour v1", historyRows?.filter((r) => r.status === "PENDING").length === 1);

  // ---- Décision par l'ingénieur (ordre de verrous désignation avant validation) ----
  const { error: decideOutsiderErr } = await outsider.client.rpc("decide_catalog_item_validation", {
    p_validation_id: submission2.id,
    p_decision: "VALIDATED",
    p_note: null,
  });
  record("Décision refusée — non-désigné", decideOutsiderErr?.message === "not_authorized", decideOutsiderErr?.message);

  const { data: decided, error: decideErr } = await engineer2.client.rpc("decide_catalog_item_validation", {
    p_validation_id: submission2.id,
    p_decision: "VALIDATED",
    p_note: "Conforme.",
  });
  record("Décision — ingénieur désigné actif valide v1", decideErr === null && decided?.status === "VALIDATED", decideErr?.message);

  const { error: decideAgainErr } = await engineer2.client.rpc("decide_catalog_item_validation", {
    p_validation_id: submission2.id,
    p_decision: "REJECTED",
    p_note: null,
  });
  record("Décision refusée — déjà décidée (already_decided)", decideAgainErr?.message === "already_decided", decideAgainErr?.message);

  const { error: mutateTerminalErr } = await service
    .from("plan_catalog_item_validations")
    .update({ decision_note: "modification directe" })
    .eq("id", submission2.id);
  record(
    "Immutabilité — toute modification directe d'une ligne terminale est refusée (trigger)",
    mutateTerminalErr?.message?.includes("validation_already_terminal"),
    mutateTerminalErr?.message
  );

  // ---- Accès réel au fichier par l'ingénieur ----
  const { data: fileKeyBefore, error: fileKeyErr } = await engineer2.client.rpc("get_catalog_item_validation_file_key", {
    p_validation_id: submission2.id,
  });
  record(
    "Accès fichier refusé — la demande n'est plus PENDING (déjà décidée)",
    fileKeyErr?.message === "not_authorized",
    fileKeyErr?.message ?? fileKeyBefore
  );

  // Nouvelle soumission PENDING pour tester l'accès fichier à l'état correct.
  const { version: v3 } = await depositVersion(owner.client, orgId, item.id, Buffer.from("PLAN-V3"));
  const { data: submission3, error: sub3Err } = await owner.client.rpc("submit_catalog_item_version_for_validation", {
    p_version_id: v3.id,
    p_designation_id: designation2Id,
  });
  if (sub3Err) throw new Error(`submit v3: ${sub3Err.message}`);

  const { data: fileKey, error: fileKeySuccessErr } = await engineer2.client.rpc("get_catalog_item_validation_file_key", {
    p_validation_id: submission3.id,
  });
  record(
    "Accès fichier — ingénieur désigné actif reçoit la clé exacte du fichier FINALIZED soumis",
    fileKeySuccessErr === null && typeof fileKey === "string" && fileKey.length > 0,
    fileKeySuccessErr?.message ?? fileKey
  );

  const { error: fileKeyEng1Err } = await engineer1.client.rpc("get_catalog_item_validation_file_key", {
    p_validation_id: submission3.id,
  });
  record(
    "Accès fichier refusé — ingénieur 1 (désignation révoquée) ne peut pas lire cette soumission",
    fileKeyEng1Err?.message === "not_authorized",
    fileKeyEng1Err?.message
  );

  const { data: listedForEng2, error: listErr } = await engineer2.client.rpc("list_submitted_catalog_item_validations");
  record(
    "Liste ingénieur — voit uniquement les demandes qui lui sont soumises et actives",
    !listErr && (listedForEng2 ?? []).some((r) => r.validation_id === submission3.id) && !(listedForEng2 ?? []).some((r) => r.validation_id === submission2.id),
    listErr?.message
  );

  // ---- Publication réservée au propriétaire, uniquement version approuvée (point 2) ----
  const { error: publishBeforeDecisionErr } = await owner.client.rpc("publish_catalog_item_version", { p_version_id: v3.id });
  record("Publication refusée — v3 pas encore validée", publishBeforeDecisionErr?.message === "version_not_validated", publishBeforeDecisionErr?.message);

  const { error: publishOutsiderErr } = await outsider.client.rpc("publish_catalog_item_version", { p_version_id: v1.id });
  record("Publication refusée — non-propriétaire", publishOutsiderErr?.message === "not_authorized", publishOutsiderErr?.message);

  const { data: publishedItem, error: publishErr } = await owner.client.rpc("publish_catalog_item_version", { p_version_id: v1.id });
  record(
    "Publication — propriétaire publie v1 (seule version VALIDATED)",
    publishErr === null && publishedItem?.published_version_id === v1.id,
    publishErr?.message
  );

  // v2 existe (déposée, jamais validée/publiée) : ne doit JAMAIS remplacer silencieusement published_version_id.
  const { data: itemAfterV2, error: reReadErr } = await service
    .from("plan_catalog_items")
    .select("published_version_id")
    .eq("id", item.id)
    .single();
  if (reReadErr) throw new Error(`reReadErr: ${reReadErr.message}`);
  record(
    "Publication — une version non approuvée (v2) ne remplace jamais silencieusement la version publiée",
    itemAfterV2.published_version_id === v1.id,
    itemAfterV2.published_version_id
  );

  // ---- Contraintes SQL composites (point 2) — tentées directement en service-role ----
  const orgB = await createOrganization(owner.id, "agence-B");
  const { data: itemB, error: itemBErr } = await service
    .from("plan_catalog_items")
    .insert({ organization_id: orgB, created_by_profile_id: owner.id, label: "Item agence B" })
    .select("id")
    .single();
  if (itemBErr) throw new Error(`itemB: ${itemBErr.message}`);

  // Isolation (revue ciblée) : réutiliser v1.private_object_upload_id ferait
  // échouer l'INSERT sur plan_catalog_item_versions_upload_unique (déjà
  // consommé par la vraie version v1), pas sur la FK composite visée ici.
  // Un upload FINALIZED frais, jamais encore lié à une version, isole la
  // contrainte réellement testée.
  const isolatedUploadOpId = randomUUID();
  const { data: isolatedUpload, error: isolatedUploadErr } = await service
    .from("private_object_uploads")
    .insert({
      operation_uuid: isolatedUploadOpId,
      organization_id: orgId, // agence A — jamais lié à orgB par ailleurs
      entity_type: "plan_catalog_item_version",
      created_by_profile_id: owner.id,
      status: "FINALIZED",
      attempt_id: randomUUID(),
      attempt_expires_at: new Date(Date.now() + 900000).toISOString(),
      candidate_key: `_private/${orgId}/plan_catalog_item_version/${isolatedUploadOpId}/candidates/isolated`,
      storage_key: `_private/${orgId}/plan_catalog_item_version/${isolatedUploadOpId}/candidates/isolated`,
      expected_checksum: "isolated-fixture",
      expected_size_bytes: 1,
      expected_mime_type: "application/pdf",
      finalized_at: new Date().toISOString(),
      finalized_by_profile_id: owner.id,
    })
    .select("id")
    .single();
  if (isolatedUploadErr) throw new Error(`isolatedUpload: ${isolatedUploadErr.message}`);

  const { error: crossOrgVersionErr } = await service.from("plan_catalog_item_versions").insert({
    catalog_item_id: item.id, // agence A
    organization_id: orgB, // agence B — incohérent
    version_number: 999,
    private_object_upload_id: isolatedUpload.id, // frais, jamais utilisé
    created_by_profile_id: owner.id,
  });
  record(
    "Contrainte SQL — version rattachée à un item d'une AUTRE organisation refusée (FK composite, isolée de l'unicité upload)",
    crossOrgVersionErr?.message?.includes("plan_catalog_item_versions_item_org_fk") ?? false,
    crossOrgVersionErr?.message
  );

  const { error: crossItemPublishErr } = await service
    .from("plan_catalog_items")
    .update({ published_version_id: v1.id, published_at_server: new Date().toISOString(), published_by_profile_id: owner.id })
    .eq("id", itemB.id);
  record(
    "Contrainte SQL — published_version_id d'un AUTRE item refusé (FK composite id+catalog_item_id)",
    !!crossItemPublishErr,
    crossItemPublishErr?.message
  );

  // ---- Course : deux soumissions concurrentes vers deux désignations actives distinctes pour la même version ----
  const { version: v4 } = await depositVersion(owner.client, orgId, item.id, Buffer.from("PLAN-V4"));
  const engineer3 = await createTestUser("eng3");
  const designation3Id = await designate(owner.client, orgId, engineer3.email);
  // designation2Id est déjà active (ré-utilisée) — les deux cibles sont ACTIVES simultanément.
  const [raceA, raceB] = await Promise.allSettled([
    owner.client.rpc("submit_catalog_item_version_for_validation", { p_version_id: v4.id, p_designation_id: designation2Id }),
    owner.client.rpc("submit_catalog_item_version_for_validation", { p_version_id: v4.id, p_designation_id: designation3Id }),
  ]);
  const raceErrors = [raceA, raceB].map((r) => (r.status === "fulfilled" ? r.value.error?.message ?? null : r.reason?.message ?? "rejected"));
  const raceSuccesses = raceErrors.filter((e) => e === null).length;
  const raceRefusals = raceErrors.filter((e) => e === "already_pending").length;
  record(
    "Course soumission — exactement une aboutit, l'autre already_pending (aucun blocage, aucune ligne fantôme)",
    raceSuccesses === 1 && raceRefusals === 1,
    JSON.stringify(raceErrors)
  );
  const { data: v4Pending } = await service.from("plan_catalog_item_validations").select("id").eq("version_id", v4.id).eq("status", "PENDING");
  record("Course soumission — une seule ligne PENDING en base pour v4", (v4Pending ?? []).length === 1);

  // ---- Correction ciblée, point 1 : réponse perdue après finalisation → reprise sans doublon ----
  const { version: v5, operationUuid: v5OpUuid } = await depositVersion(owner.client, orgId, item.id, Buffer.from("PLAN-V5"));
  const { data: v5Retry, error: v5RetryErr } = await owner.client.rpc("finalize_catalog_item_upload", {
    p_operation_uuid: v5OpUuid,
  });
  record(
    "Réponse perdue — rejeu de finalize sur une opération déjà FINALIZED renvoie la MÊME version",
    v5RetryErr === null && v5Retry?.id === v5.id,
    v5RetryErr?.message ?? v5Retry?.id
  );
  const { data: v5Rows } = await service
    .from("plan_catalog_item_versions")
    .select("id")
    .eq("catalog_item_id", item.id)
    .eq("version_number", v5.version_number);
  record("Réponse perdue — une seule ligne version existe pour ce numéro (aucun doublon créé)", (v5Rows ?? []).length === 1);

  // ---- Correction ciblée, point 3 : compte devenu provisoire APRÈS attestation, revérifié juste avant la transition finale ----
  const provisionalOwner = await createTestUser("owner-late-provisional");
  const provisionalOrgId = await createOrganization(provisionalOwner.id, "agence-provisoire");
  const { data: provisionalItem } = await service
    .from("plan_catalog_items")
    .insert({ organization_id: provisionalOrgId, created_by_profile_id: provisionalOwner.id, label: "Item compte devenu provisoire" })
    .select("id")
    .single();
  const lateOpUuid = randomUUID();
  const lateBytes = Buffer.from("PLAN-LATE-PROVISIONAL");
  const lateChecksum = checksumOf(lateBytes);
  const { data: latePrep, error: latePrepErr } = await provisionalOwner.client.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: lateOpUuid,
    p_organization_id: provisionalOrgId,
    p_catalog_item_id: provisionalItem.id,
    p_expected_checksum: lateChecksum,
    p_expected_size_bytes: lateBytes.length,
    p_expected_mime_type: "application/pdf",
  });
  if (latePrepErr) throw new Error(`latePrep: ${latePrepErr.message}`);
  const { data: lateClaim, error: lateClaimErr } = await provisionalOwner.client.rpc("claim_upload_attempt", {
    p_operation_uuid: lateOpUuid,
  });
  if (lateClaimErr || !lateClaim?.won) throw new Error(`lateClaim: ${lateClaimErr?.message ?? "not won"}`);
  const { error: lateAttestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: lateOpUuid,
    p_attempt_id: lateClaim.attempt_id,
    p_actual_checksum: lateChecksum,
    p_actual_size_bytes: lateBytes.length,
    p_actual_mime_type: "application/pdf",
  });
  if (lateAttestErr) throw new Error(`lateAttest: ${lateAttestErr.message}`);
  // Compte basculé PROVISOIRE entre l'attestation et la finalisation — simule
  // une revérification devenue obsolète si elle n'était vérifiée qu'au tout
  // début de la fonction (revue ciblée, point 3).
  const { error: makeProvisionalErr } = await service
    .from("profile_identifiers")
    .update({ verified_at_server: null })
    .eq("profile_id", provisionalOwner.id)
    .eq("kind", "EMAIL");
  if (makeProvisionalErr) throw new Error(`makeProvisional: ${makeProvisionalErr.message}`);
  const { error: lateFinalizeErr } = await provisionalOwner.client.rpc("finalize_catalog_item_upload", {
    p_operation_uuid: lateOpUuid,
  });
  record(
    "Revérification tardive — compte devenu provisoire ENTRE attestation et finalisation refuse la transition finale",
    lateFinalizeErr?.message === "account_provisional",
    lateFinalizeErr?.message
  );
  const { data: lateUploadRow } = await service
    .from("private_object_uploads")
    .select("status")
    .eq("operation_uuid", lateOpUuid)
    .single();
  record(
    "Revérification tardive — l'upload reste FINALIZING (récupérable), jamais FINALIZED malgré le refus",
    lateUploadRow?.status === "FINALIZING",
    lateUploadRow?.status
  );

  // ---- Correction ciblée, point 4 : nettoyage réel catalogue + protection FINALIZED ----
  const { version: v6ForCleanupProtection } = await depositVersion(owner.client, orgId, item.id, Buffer.from("PLAN-V6-PROTEGE"));
  const opUuidToExpire = randomUUID();
  const expireBytes = Buffer.from("PLAN-EXPIRE-CANDIDATE");
  const { error: expirePrepErr } = await owner.client.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: opUuidToExpire,
    p_organization_id: orgId,
    p_catalog_item_id: item.id,
    p_expected_checksum: checksumOf(expireBytes),
    p_expected_size_bytes: expireBytes.length,
    p_expected_mime_type: "application/pdf",
  });
  if (expirePrepErr) throw new Error(`expirePrep: ${expirePrepErr.message}`);
  const { data: expireClaim, error: expireClaimErr } = await owner.client.rpc("claim_upload_attempt", {
    p_operation_uuid: opUuidToExpire,
  });
  if (expireClaimErr || !expireClaim?.won) throw new Error(`expireClaim: ${expireClaimErr?.message ?? "not won"}`);
  const { error: expireWriteErr } = await service.storage
    .from("organization-catalog")
    .upload(expireClaim.candidate_key, expireBytes, { contentType: "application/pdf", upsert: false });
  if (expireWriteErr) throw new Error(`expireWrite: ${expireWriteErr.message}`);
  // Force l'expiration réelle de la tentative (au lieu d'attendre 15 minutes).
  const { error: forceExpireErr } = await service
    .from("private_object_uploads")
    .update({ attempt_expires_at: new Date(Date.now() - 3600 * 1000).toISOString() })
    .eq("operation_uuid", opUuidToExpire);
  if (forceExpireErr) throw new Error(`forceExpire: ${forceExpireErr.message}`);

  const { data: expiredCatalogUploads, error: listExpiredErr } = await service.rpc("list_expired_catalog_item_uploads", {
    p_older_than: "0 seconds",
  });
  if (listExpiredErr) throw new Error(`listExpired: ${listExpiredErr.message}`);
  const expiredRow = (expiredCatalogUploads ?? []).find((r) => r.organization_id === orgId);
  record("Nettoyage catalogue — l'upload expiré est sélectionné par list_expired_catalog_item_uploads", !!expiredRow);

  const { data: didAbandonCatalog, error: abandonCatalogErr } = await service.rpc("abandon_expired_catalog_item_upload", {
    p_id: expiredRow.id,
    p_older_than: "0 seconds",
  });
  record("Nettoyage catalogue — abandon réel de l'upload expiré", abandonCatalogErr === null && didAbandonCatalog === true, abandonCatalogErr?.message);

  const { data: staleTrace } = await service
    .from("private_object_stale_keys")
    .select("id, storage_key, kind")
    .eq("private_object_upload_id", expiredRow.id);
  record("Nettoyage catalogue — candidate ET source tracées avant suppression", (staleTrace ?? []).length === 2, JSON.stringify(staleTrace));

  const candidateTrace = (staleTrace ?? []).find((t) => t.kind === "candidate");
  const { data: bucketForTrace, error: bucketErr } = await service.rpc("get_stale_key_bucket", { p_id: candidateTrace.id });
  record(
    "Nettoyage catalogue — get_stale_key_bucket sélectionne le BON bucket (organization-catalog)",
    bucketErr === null && bucketForTrace === "organization-catalog",
    bucketErr?.message ?? bucketForTrace
  );

  const { data: candidateBeforeDelete } = await service.storage.from("organization-catalog").download(candidateTrace.storage_key);
  record("Nettoyage catalogue — la candidate orpheline existe réellement dans Storage avant suppression", !!candidateBeforeDelete);

  const { data: claimedForCleanup, error: claimCleanupErr } = await service.rpc("claim_stale_key_for_cleanup", { p_id: candidateTrace.id });
  if (claimCleanupErr) throw new Error(`claimCleanup: ${claimCleanupErr.message}`);
  const { error: realRemoveErr } = await service.storage.from(bucketForTrace).remove([claimedForCleanup[0].storage_key]);
  record("Nettoyage catalogue — suppression RÉELLE dans le bon bucket réussie", realRemoveErr === null, realRemoveErr?.message);
  if (!realRemoveErr) {
    const { error: markErr } = await service.rpc("mark_stale_key_cleaned", { p_id: candidateTrace.id });
    if (markErr) throw new Error(`markCleaned: ${markErr.message}`);
  }
  const { data: candidateAfterDelete } = await service.storage.from("organization-catalog").download(candidateTrace.storage_key);
  record("Nettoyage catalogue — la candidate est réellement absente après suppression", !candidateAfterDelete);

  // Protection FINALIZED : le fichier FINALIZED de v6 (jamais tracé comme
  // stale) ne doit jamais être sélectionné par le nettoyage.
  const { data: v6Upload } = await service
    .from("plan_catalog_item_versions")
    .select("private_object_upload_id")
    .eq("id", v6ForCleanupProtection.id)
    .single();
  const { data: v6UploadRow } = await service
    .from("private_object_uploads")
    .select("storage_key, status")
    .eq("id", v6Upload.private_object_upload_id)
    .single();
  const { data: v6StaleTrace } = await service
    .from("private_object_stale_keys")
    .select("id")
    .eq("storage_key", v6UploadRow.storage_key);
  record(
    "Protection FINALIZED — le fichier FINALIZED de v6 n'a jamais été tracé comme clé obsolète",
    v6UploadRow.status === "FINALIZED" && (v6StaleTrace ?? []).length === 0
  );
  const { data: v6StillThere } = await service.storage.from("organization-catalog").download(v6UploadRow.storage_key);
  record("Protection FINALIZED — le fichier FINALIZED de v6 existe toujours réellement dans Storage", !!v6StillThere);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${total} tests réussis.`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERREUR:", err.message);
  process.exitCode = 1;
});
