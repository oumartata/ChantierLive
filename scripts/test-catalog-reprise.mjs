// Test ciblé B061 (EN REVUE) — complément revue : finalize_catalog_item_upload
// revient désormais sur son chemin idempotent (déjà FINALIZED) SEULEMENT
// après avoir revalidé l'organisation/l'item ET le compte — jamais avant.
// Fixtures indépendantes des autres scripts de test (aucune suite existante
// rejouée). Usage : node scripts/test-catalog-reprise.mjs

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
  const email = `b061-reprise-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, email: email.toLowerCase(), client };
}

async function createOrganization(ownerProfileId, label) {
  const { data, error } = await service.from("organizations").insert({ name: `B061 reprise — ${label}`, owner_profile_id: ownerProfileId }).select("id").single();
  if (error) throw new Error(`createOrganization(${label}): ${error.message}`);
  return data.id;
}

function checksumOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function depositVersion(ownerClient, organizationId, catalogItemId, bytes) {
  const operationUuid = randomUUID();
  const checksum = checksumOf(bytes);
  const { data: prep, error: prepErr } = await ownerClient.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: operationUuid, p_organization_id: organizationId, p_catalog_item_id: catalogItemId,
    p_expected_checksum: checksum, p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf",
  });
  if (prepErr) throw new Error(`prepare: ${prepErr.message}`);
  const { data: claim, error: claimErr } = await ownerClient.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid, p_expected_attempt_id: prep.attempt_id });
  if (claimErr || !claim?.won) throw new Error(`claim: ${claimErr?.message ?? "not won"}`);
  const { error: writeErr } = await service.storage.from("organization-catalog").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false });
  if (writeErr) throw new Error(`storage.upload: ${writeErr.message}`);
  const { data: written } = await service.storage.from("organization-catalog").download(claim.candidate_key);
  const writtenBytes = new Uint8Array(await written.arrayBuffer());
  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
    p_actual_checksum: checksumOf(writtenBytes), p_actual_size_bytes: writtenBytes.length, p_actual_mime_type: "application/pdf",
  });
  if (attestErr) throw new Error(`attest: ${attestErr.message}`);
  const { data: version, error: finErr } = await ownerClient.rpc("finalize_catalog_item_upload", { p_operation_uuid: operationUuid });
  if (finErr) throw new Error(`finalize: ${finErr.message}`);
  return { version, operationUuid };
}

async function main() {
  // ---- Scénario A : rejeu FINALIZED après perte de VÉRIFICATION (compte devenu provisoire) ----
  const ownerA = await createTestUser("owner-a");
  const orgA = await createOrganization(ownerA.id, "compte-provisoire");
  const { data: itemA } = await ownerA.client.rpc("create_catalog_item", { p_organization_id: orgA, p_label: "Item A" });
  const { version: vA, operationUuid: opA } = await depositVersion(ownerA.client, orgA, itemA.id, Buffer.from("PLAN-REPRISE-A"));
  record("Scénario A — dépôt initial réussi (FINALIZED)", !!vA?.id);

  const { error: unverifyErr } = await service.from("profile_identifiers").update({ verified_at_server: null }).eq("profile_id", ownerA.id).eq("kind", "EMAIL");
  if (unverifyErr) throw new Error(`unverify: ${unverifyErr.message}`);

  const { data: replayA, error: replayErrA } = await ownerA.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: opA });
  record(
    "Scénario A — rejeu FINALIZED après perte de vérification refuse (account_provisional), ne renvoie PAS la version",
    replayErrA?.message === "account_provisional" && replayA === null,
    replayErrA?.message ?? JSON.stringify(replayA)
  );

  // ---- Scénario B : rejeu FINALIZED après perte de PROPRIÉTÉ (organisation transférée) ----
  const ownerB = await createTestUser("owner-b");
  const otherOwner = await createTestUser("other-owner");
  const orgB = await createOrganization(ownerB.id, "propriete-transferee");
  const { data: itemB } = await ownerB.client.rpc("create_catalog_item", { p_organization_id: orgB, p_label: "Item B" });
  const { version: vB, operationUuid: opB } = await depositVersion(ownerB.client, orgB, itemB.id, Buffer.from("PLAN-REPRISE-B"));
  record("Scénario B — dépôt initial réussi (FINALIZED)", !!vB?.id);

  const { error: transferErr } = await service.from("organizations").update({ owner_profile_id: otherOwner.id }).eq("id", orgB);
  if (transferErr) throw new Error(`transfer: ${transferErr.message}`);

  const { data: replayB, error: replayErrB } = await ownerB.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: opB });
  record(
    "Scénario B — rejeu FINALIZED après perte de propriété de l'organisation refuse (not_authorized), ne renvoie PAS la version",
    replayErrB?.message === "not_authorized" && replayB === null,
    replayErrB?.message ?? JSON.stringify(replayB)
  );

  // Le nouveau propriétaire, lui, n'a jamais créé cette opération : refusé aussi (identité), pour mémoire.
  const { error: replayErrOther } = await otherOwner.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: opB });
  record(
    "Scénario B — le nouveau propriétaire (jamais auteur de l'opération) reste refusé (not_authorized)",
    replayErrOther?.message === "not_authorized",
    replayErrOther?.message
  );

  // ---- Contrôle : le rejeu LÉGITIME (droits toujours valides) continue de fonctionner (non-régression ciblée) ----
  const ownerC = await createTestUser("owner-c");
  const orgC = await createOrganization(ownerC.id, "rejeu-legitime");
  const { data: itemC } = await ownerC.client.rpc("create_catalog_item", { p_organization_id: orgC, p_label: "Item C" });
  const { version: vC, operationUuid: opC } = await depositVersion(ownerC.client, orgC, itemC.id, Buffer.from("PLAN-REPRISE-C"));
  const { data: replayC, error: replayErrC } = await ownerC.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: opC });
  record(
    "Contrôle — rejeu FINALIZED avec droits TOUJOURS valides renvoie la MÊME version (idempotence préservée)",
    replayErrC === null && replayC?.id === vC.id,
    replayErrC?.message ?? replayC?.id
  );

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${total} tests réussis.`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERREUR:", err.message);
  process.exitCode = 1;
});
