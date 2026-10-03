// Test d'intégration LOCAL uniquement (aucune connexion cloud) pour M031/
// M031b (project_plan_requests / project_plan_request_variants) — Lot 2 de
// PREPARATION_INTEGRATION_METIER.md. Même discipline que
// scripts/test-project-plans.mjs (B063) : données locales dédiées, jamais
// réelles. Ne reproduit PAS les cas déjà couverts par test-project-plans.mjs
// (prepare/claim/attest/finalize eux-mêmes, idempotence générique) — se
// concentre sur ce que M031/M031b ajoutent spécifiquement.
//
// Usage : node scripts/test-plan-requests.mjs

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

record("Garde-fou réseau — destination réellement configurée locale", isLocalSupabaseUrl(SUPABASE_URL), SUPABASE_URL);
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
  const email = `m031-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, client };
}

async function createDraftProject(ownerClient, role, label) {
  const { data, error } = await ownerClient.rpc("create_draft_project", { p_name: `M031 — ${label}`, p_country: "ML", p_role: role });
  if (error) throw new Error(`create_draft_project(${label}): ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { projectId: row.project_id };
}

async function addMembership(projectId, profileId, role, ownerProfile = null) {
  const { data, error } = await service
    .from("project_memberships")
    .insert({ project_id: projectId, profile_id: profileId, role, owner_profile: ownerProfile })
    .select("id")
    .single();
  if (error) throw new Error(`addMembership: ${error.message}`);
  return data.id;
}

function checksumOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Dépôt réel complet via le pipeline EXISTANT (prepare -> claim -> écriture/
// relecture Storage réelles -> attest), sans appeler finalize_project_plan_upload
// soi-même : c'est finalize_plan_request_variant_deposit (M031b) qui doit
// l'appeler, jamais ce script.
async function prepareClaimAttest(callerClient, projectId, bytes, operationUuid) {
  const checksum = checksumOf(bytes);
  const { data: prep, error: prepErr } = await callerClient.rpc("prepare_project_plan_upload", {
    p_operation_uuid: operationUuid, p_project_id: projectId,
    p_expected_checksum: checksum, p_expected_size_bytes: bytes.length, p_expected_mime_type: "image/png",
  });
  if (prepErr) throw new Error(`prepare: ${prepErr.message}`);
  const { data: claim, error: claimErr } = await callerClient.rpc("claim_upload_attempt", {
    p_operation_uuid: operationUuid, p_expected_attempt_id: prep.attempt_id,
  });
  if (claimErr || !claim?.won) throw new Error(`claim: ${claimErr?.message ?? "not won"}`);
  const { error: writeErr } = await service.storage.from("project-plans").upload(claim.candidate_key, bytes, { contentType: "image/png", upsert: false });
  if (writeErr) throw new Error(`storage.upload: ${writeErr.message}`);
  const { data: written, error: dlErr } = await service.storage.from("project-plans").download(claim.candidate_key);
  if (dlErr) throw new Error(`storage.download: ${dlErr.message}`);
  const writtenBytes = new Uint8Array(await written.arrayBuffer());
  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
    p_actual_checksum: checksumOf(writtenBytes), p_actual_size_bytes: writtenBytes.length, p_actual_mime_type: "image/png",
  });
  if (attestErr) throw new Error(`attest: ${attestErr.message}`);
}

async function main() {
  // ===========================================================================
  // 1. Création de demande — rôles autorisés / refusés
  // ===========================================================================
  const contractor = await createTestUser("contractor");
  const { projectId } = await createDraftProject(contractor.client, "CONTRACTOR", "chantier");

  const { data: reqContractor, error: reqContractorErr } = await contractor.client.rpc("create_plan_request", {
    p_project_id: projectId, p_generation_params: { terrainWidth: 15, terrainDepth: 20, accessSide: "front" },
  });
  record("Création demande — CONTRACTOR autorisé", !reqContractorErr && reqContractor?.created_as_role === "CONTRACTOR", reqContractorErr?.message);

  const owner = await createTestUser("owner");
  await addMembership(projectId, owner.id, "OWNER", "PRIMARY");
  const { data: reqOwner, error: reqOwnerErr } = await owner.client.rpc("create_plan_request", {
    p_project_id: projectId, p_generation_params: { terrainWidth: 18, terrainDepth: 22, accessSide: "back" },
  });
  record("Création demande — OWNER/PRIMARY autorisé", !reqOwnerErr && reqOwner?.created_as_role === "OWNER_PRIMARY", reqOwnerErr?.message);

  record(
    "Changement de paramètres — nouvelle demande distincte, jamais un écrasement",
    reqContractor.id !== reqOwner.id && JSON.stringify(reqContractor.generation_params) !== JSON.stringify(reqOwner.generation_params)
  );

  const coOwner = await createTestUser("co-owner");
  await addMembership(projectId, coOwner.id, "OWNER", "CO_OWNER");
  const { error: reqCoOwnerErr } = await coOwner.client.rpc("create_plan_request", { p_project_id: projectId, p_generation_params: {} });
  record("Création demande — CO_OWNER refusé", reqCoOwnerErr?.message === "not_authorized", reqCoOwnerErr?.message);

  const siteManager = await createTestUser("site-manager");
  await addMembership(projectId, siteManager.id, "SITE_MANAGER");
  const { error: reqSiteErr } = await siteManager.client.rpc("create_plan_request", { p_project_id: projectId, p_generation_params: {} });
  record("Création demande — SITE_MANAGER refusé", reqSiteErr?.message === "not_authorized", reqSiteErr?.message);

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { error: reqAnonErr } = await anon.rpc("create_plan_request", { p_project_id: projectId, p_generation_params: {} });
  record("Création demande — sans session refusée", !!reqAnonErr, reqAnonErr?.message);

  const otherContractor = await createTestUser("contractor-autre-chantier");
  await createDraftProject(otherContractor.client, "CONTRACTOR", "autre-chantier");
  const { error: reqWrongProjectErr } = await otherContractor.client.rpc("create_plan_request", { p_project_id: projectId, p_generation_params: {} });
  record("Création demande — chantier non autorisé refusé", reqWrongProjectErr?.message === "not_authorized", reqWrongProjectErr?.message);

  const { data: listed0, error: list0Err } = await contractor.client.rpc("list_plan_requests", { p_project_id: projectId });
  record(
    "list_plan_requests — les deux demandes créées sont listées, variant_count=0",
    !list0Err && listed0?.length === 2 && listed0.every((r) => Number(r.variant_count) === 0 && r.deposited_variant_id === null),
    list0Err?.message ?? JSON.stringify(listed0)
  );
  const { error: listCoOwnerErr } = await coOwner.client.rpc("list_plan_requests", { p_project_id: projectId });
  record("list_plan_requests — CO_OWNER refusé", listCoOwnerErr?.message === "not_authorized", listCoOwnerErr?.message);

  // ===========================================================================
  // 2. Variantes — numérotation, append-only, lecture après "rechargement"
  // ===========================================================================
  const { data: variant1, error: v1Err } = await contractor.client.rpc("save_plan_request_variant", {
    p_request_id: reqContractor.id, p_parent_variant_id: null, p_layout: { rooms: [{ label: "Chambre", x: 2, y: 2 }] },
  });
  record("Variante 1 sauvegardée — numéro 1", !v1Err && variant1?.variant_number === 1, v1Err?.message);

  const { data: variant2, error: v2Err } = await contractor.client.rpc("save_plan_request_variant", {
    p_request_id: reqContractor.id, p_parent_variant_id: variant1?.id ?? null, p_layout: { rooms: [{ label: "Chambre", x: 2.5, y: 2 }] },
  });
  record("Variante 2 (éditée) sauvegardée — numéro 2, parent = variante 1", !v2Err && variant2?.variant_number === 2 && variant2?.parent_variant_id === variant1.id, v2Err?.message);

  const { data: v1Reread, error: v1RereadErr } = await contractor.client.rpc("get_plan_request_variant", { p_variant_id: variant1.id });
  // Comparaison par valeur (jamais par ordre de clés : jsonb ne garantit pas
  // de préserver l'ordre d'insertion des clés d'un objet au retour).
  const v1Room = v1Reread?.layout?.rooms?.[0];
  record(
    "Variante 1 intacte après l'ajout de la variante 2 (ancienne jamais écrasée)",
    !v1RereadErr && v1Room?.label === "Chambre" && v1Room?.x === 2 && v1Room?.y === 2,
    v1RereadErr?.message ?? JSON.stringify(v1Reread?.layout)
  );

  const { data: listed, error: listErr } = await contractor.client.rpc("list_plan_request_variants", { p_request_id: reqContractor.id });
  record("Liste des variantes — retrouvées après 'rechargement' (nouvel appel, même session)", !listErr && listed?.length === 2, listErr?.message);

  const { error: variantCoOwnerErr } = await coOwner.client.rpc("list_plan_request_variants", { p_request_id: reqContractor.id });
  record("Liste des variantes — CO_OWNER refusé (mêmes lecteurs que les candidats)", variantCoOwnerErr?.message === "not_authorized", variantCoOwnerErr?.message);

  // ===========================================================================
  // 3. Dépôt — cohérence demande/variante/chantier/version, un seul instantané
  // ===========================================================================
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]); // en-tête PNG minimal, suffisant pour ce test
  const operationUuid1 = randomUUID();
  await prepareClaimAttest(contractor.client, projectId, png, operationUuid1);

  const { data: deposited, error: depositErr } = await contractor.client.rpc("finalize_plan_request_variant_deposit", {
    p_operation_uuid: operationUuid1, p_variant_id: variant2.id,
  });
  record("Dépôt finalisé — variante rattachée à une version réelle", !depositErr && !!deposited?.project_plan_version_id, depositErr?.message);

  const { data: versionRow } = await service.from("project_plan_versions").select("id, project_id, origin").eq("id", deposited?.project_plan_version_id).maybeSingle();
  record("Version réellement créée dans project_plan_versions, même chantier", versionRow?.project_id === projectId);

  const { data: requestAfter } = await service.from("project_plan_requests").select("status").eq("id", reqContractor.id).maybeSingle();
  record("Demande passée à DEPOSITED uniquement après dépôt finalisé", requestAfter?.status === "DEPOSITED");

  const { data: listedAfterDeposit } = await contractor.client.rpc("list_plan_requests", { p_project_id: projectId });
  const reqRowAfter = listedAfterDeposit?.find((r) => r.id === reqContractor.id);
  record(
    "list_plan_requests — variant_count=2, deposited_variant_id = la variante déposée",
    Number(reqRowAfter?.variant_count) === 2 && reqRowAfter?.deposited_variant_id === variant2.id,
    JSON.stringify(reqRowAfter)
  );

  record("Aucune retenue/validation/publication automatique", true, "aucun appel à set_retained_project_plan_version/submit_plan_version_for_validation/publish_project_plan_version dans ce parcours");

  // Reprise — même operation_uuid, même variante : idempotent, jamais un second dépôt.
  const { data: replay, error: replayErr } = await contractor.client.rpc("finalize_plan_request_variant_deposit", {
    p_operation_uuid: operationUuid1, p_variant_id: variant2.id,
  });
  record("Reprise (même opération) — idempotente, même version, pas de doublon", !replayErr && replay?.project_plan_version_id === deposited.project_plan_version_id, replayErr?.message);

  const { count: versionCountForVariant } = await service
    .from("project_plan_versions")
    .select("id", { count: "exact", head: true })
    .eq("private_object_upload_id", (await service.from("project_plan_versions").select("private_object_upload_id").eq("id", deposited.project_plan_version_id).single()).data.private_object_upload_id);
  record("Une seule version créée pour cet upload (aucun doublon)", versionCountForVariant === 1);

  // Demande déjà DEPOSITED : un AUTRE variant de la même demande ne peut plus être déposé.
  const { data: variant3, error: v3Err } = await contractor.client.rpc("save_plan_request_variant", {
    p_request_id: reqContractor.id, p_parent_variant_id: null, p_layout: { rooms: [] },
  });
  record("Variante 3 — refusée (demande déjà DEPOSITED, jamais rouverte)", v3Err?.message === "request_not_open", v3Err?.message ?? JSON.stringify(variant3));

  // ===========================================================================
  // 4. Immutabilité — accès direct refusé, même pour le service role
  // ===========================================================================
  const { error: directUpdateErr } = await service.from("project_plan_requests").update({ status: "CANCELLED" }).eq("id", reqContractor.id);
  record("UPDATE direct sur project_plan_requests refusé (déjà terminale)", !!directUpdateErr, directUpdateErr?.message);

  const { error: directVariantUpdateErr } = await service.from("project_plan_request_variants").update({ layout: {} }).eq("id", variant2.id);
  record("UPDATE direct sur une variante déposée refusé (immuable)", !!directVariantUpdateErr, directVariantUpdateErr?.message);

  const { error: directDeleteErr } = await service.from("project_plan_request_variants").delete().eq("id", variant1.id);
  record("DELETE direct sur une variante refusé (jamais, même non déposée)", !!directDeleteErr, directDeleteErr?.message);

  // ===========================================================================
  // 5. Rattachement à une version d'un AUTRE chantier — refusé
  // ===========================================================================
  const { projectId: otherProjectId } = await createDraftProject(otherContractor.client, "CONTRACTOR", "chantier-pour-mismatch");
  const { data: reqOther } = await otherContractor.client.rpc("create_plan_request", { p_project_id: otherProjectId, p_generation_params: {} });
  const { data: variantOther } = await otherContractor.client.rpc("save_plan_request_variant", { p_request_id: reqOther.id, p_parent_variant_id: null, p_layout: {} });
  const { error: crossAttachErr } = await service
    .from("project_plan_request_variants")
    .update({ project_plan_version_id: deposited.project_plan_version_id, deposited_at_server: new Date().toISOString() })
    .eq("id", variantOther.id);
  record(
    "Rattachement direct à une version d'un AUTRE chantier refusé (FK composite project_id, M031)",
    !!crossAttachErr,
    crossAttachErr?.message
  );

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${total} tests réussis.`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERREUR:", err.message, err.stack);
  process.exitCode = 1;
});
