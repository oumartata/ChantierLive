// Test d'intégration LOCAL uniquement (aucune connexion cloud) pour M032
// (fichier de projet modifiable optionnel sur plan_catalog_item_versions —
// PREPARATION_CATALOGUE_MODIFIABLE.md, Lot A). Réutilise les mêmes
// fixtures que scripts/test-catalog-items.mjs (B061, non modifié ici),
// jamais réécrites. Ne reproduit PAS les cas déjà couverts par ce script
// (droits de base create/prepare/finalize déjà testés) — se concentre sur
// ce que M032 ajoute : le paramètre p_layout, sa validation SQL, son
// immuabilité, et get_catalog_item_version_file.
//
// Usage : node scripts/test-catalog-item-layout.mjs

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
  const email = `m032-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, client };
}

async function createOrganization(ownerProfileId, label) {
  const { data, error } = await service
    .from("organizations")
    .insert({ name: `M032 fixture — ${label}`, owner_profile_id: ownerProfileId })
    .select("id")
    .single();
  if (error) throw new Error(`createOrganization(${label}): ${error.message}`);
  return data.id;
}

function checksumOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function validLayout(seed = "A") {
  return {
    version: 4,
    savedAt: new Date().toISOString(),
    orientation: "N",
    layout: { marker: seed, rooms: [{ label: "Chambre", x: 2, y: 2, w: 3.5, d: 3.5 }] },
  };
}

// prepare -> claim -> écriture/relecture Storage RÉELLES -> attest, sans
// appeler finalize (laissé au test appelant, pour pouvoir faire varier
// p_layout librement).
async function prepareClaimAttest(ownerClient, organizationId, catalogItemId, bytes, operationUuid) {
  const checksum = checksumOf(bytes);
  const { data: prep, error: prepErr } = await ownerClient.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: operationUuid,
    p_organization_id: organizationId,
    p_catalog_item_id: catalogItemId,
    p_expected_checksum: checksum,
    p_expected_size_bytes: bytes.length,
    p_expected_mime_type: "image/png",
  });
  if (prepErr) throw new Error(`prepare: ${prepErr.message}`);
  const { data: claim, error: claimErr } = await ownerClient.rpc("claim_upload_attempt", {
    p_operation_uuid: operationUuid,
    p_expected_attempt_id: prep.attempt_id,
  });
  if (claimErr || !claim?.won) throw new Error(`claim: ${claimErr?.message ?? "not won"}`);
  const { error: writeErr } = await service.storage.from("organization-catalog").upload(claim.candidate_key, bytes, { contentType: "image/png", upsert: false });
  if (writeErr) throw new Error(`storage.upload: ${writeErr.message}`);
  const { data: written, error: dlErr } = await service.storage.from("organization-catalog").download(claim.candidate_key);
  if (dlErr) throw new Error(`storage.download: ${dlErr.message}`);
  const writtenBytes = new Uint8Array(await written.arrayBuffer());
  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid,
    p_attempt_id: claim.attempt_id,
    p_actual_checksum: checksumOf(writtenBytes),
    p_actual_size_bytes: writtenBytes.length,
    p_actual_mime_type: "image/png",
  });
  if (attestErr) throw new Error(`attest: ${attestErr.message}`);
}

async function main() {
  const owner = await createTestUser("owner");
  const outsider = await createTestUser("outsider");
  const orgId = await createOrganization(owner.id, "catalogue-layout");

  const { data: item, error: itemErr } = await owner.client.rpc("create_catalog_item", { p_organization_id: orgId, p_label: "Maison T3 modifiable" });
  if (itemErr) throw new Error(`create_catalog_item: ${itemErr.message}`);

  // ===========================================================================
  // 1. Dépôt valide avec layout — stocké atomiquement avec le fichier plat.
  // ===========================================================================
  const op1 = randomUUID();
  await prepareClaimAttest(owner.client, orgId, item.id, PNG_BYTES, op1);
  const layoutA = validLayout("A");
  const { data: v1, error: v1Err } = await owner.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: op1, p_layout: layoutA });
  record("Dépôt modifiable — réussi, layout stocké", !v1Err && v1?.layout?.layout?.marker === "A", v1Err?.message ?? JSON.stringify(v1));
  record("Dépôt modifiable — version_number=1", v1?.version_number === 1);

  // ===========================================================================
  // 2. Compatibilité ascendante — ancien appel (p_operation_uuid seul) toujours fonctionnel.
  // ===========================================================================
  const op2 = randomUUID();
  await prepareClaimAttest(owner.client, orgId, item.id, PNG_BYTES, op2);
  const { data: v2, error: v2Err } = await owner.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: op2 });
  record("Compatibilité — ancien appel sans p_layout toujours fonctionnel", !v2Err && v2?.layout === null, v2Err?.message);

  // ===========================================================================
  // 3. JSON invalide / version inconnue / structure incomplète — refusés SANS
  // version partielle créée (le compteur de version ne doit pas avancer).
  // ===========================================================================
  async function expectRejected(label, badLayout, expectedMessage) {
    const { count: countBefore } = await service.from("plan_catalog_item_versions").select("id", { count: "exact", head: true }).eq("catalog_item_id", item.id);
    const op = randomUUID();
    await prepareClaimAttest(owner.client, orgId, item.id, PNG_BYTES, op);
    const { error } = await owner.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: op, p_layout: badLayout });
    const { count: countAfter } = await service.from("plan_catalog_item_versions").select("id", { count: "exact", head: true }).eq("catalog_item_id", item.id);
    record(`${label} — refusé`, error?.message === expectedMessage, error?.message);
    record(`${label} — aucune version partielle créée`, countAfter === countBefore, `avant=${countBefore} après=${countAfter}`);
  }
  await expectRejected("Layout = tableau (pas un objet)", ["pas", "un", "objet"], "layout_invalid_format");
  await expectRejected("Layout = chaîne", "juste une chaine", "layout_invalid_format");
  await expectRejected("Version inconnue (99)", { version: 99, savedAt: "x", orientation: "N", layout: {} }, "layout_unknown_version");
  await expectRejected("Structure incomplète (orientation manquante)", { version: 4, savedAt: "x", layout: {} }, "layout_invalid_structure");
  await expectRejected("Structure incomplète (layout manquant)", { version: 4, savedAt: "x", orientation: "N" }, "layout_invalid_structure");
  await expectRejected("Layout trop volumineux (> 2 Mo)", { version: 4, savedAt: "x", orientation: "N", layout: { big: "x".repeat(2_200_000) } }, "layout_too_large");

  const { count: finalCount } = await service.from("plan_catalog_item_versions").select("id", { count: "exact", head: true }).eq("catalog_item_id", item.id);
  record("Aucune version partielle créée par les 6 rejets ci-dessus (toujours 2 versions réelles)", finalCount === 2, finalCount);

  // ===========================================================================
  // 4. Rôle non autorisé — outsider ne peut ni préparer ni finaliser.
  // ===========================================================================
  const opOutsider = randomUUID();
  const { error: prepOutsiderErr } = await outsider.client.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: opOutsider, p_organization_id: orgId, p_catalog_item_id: item.id,
    p_expected_checksum: checksumOf(PNG_BYTES), p_expected_size_bytes: PNG_BYTES.length, p_expected_mime_type: "image/png",
  });
  record("Outsider — prepare_catalog_item_upload refusé", prepOutsiderErr?.message === "not_authorized", prepOutsiderErr?.message);

  // ===========================================================================
  // 5. Reprise après échec réel (attesté, jamais finalisé) — idempotence.
  // ===========================================================================
  const op3 = randomUUID();
  await prepareClaimAttest(owner.client, orgId, item.id, PNG_BYTES, op3);
  const { data: status3 } = await owner.client.rpc("get_upload_status", { p_operation_uuid: op3 });
  record("Reprise — upload attesté mais jamais finalisé avant la reprise", status3?.status === "FINALIZING", JSON.stringify(status3));
  const layoutC = validLayout("C");
  const { data: v3, error: v3Err } = await owner.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: op3, p_layout: layoutC });
  record("Reprise — finalisation aboutit", !v3Err && v3?.layout?.layout?.marker === "C", v3Err?.message);
  const { data: v3Replay, error: v3ReplayErr } = await owner.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: op3, p_layout: layoutC });
  record("Reprise — rejeu (même opération) idempotent, même version, pas de doublon", !v3ReplayErr && v3Replay?.id === v3?.id);
  const { count: v3Count } = await service.from("plan_catalog_item_versions").select("id", { count: "exact", head: true }).eq("private_object_upload_id", v3.private_object_upload_id);
  record("Reprise — une seule version pour cet upload", v3Count === 1);

  // ===========================================================================
  // 6. Immuabilité — ancienne version intacte après création d'une nouvelle.
  // ===========================================================================
  const { data: v1Reread } = await service.from("plan_catalog_item_versions").select("layout").eq("id", v1.id).single();
  record("Version 1 intacte après dépôts suivants (layout toujours 'A')", v1Reread?.layout?.layout?.marker === "A", JSON.stringify(v1Reread));
  const { error: directUpdateErr } = await service.from("plan_catalog_item_versions").update({ layout: validLayout("HACK") }).eq("id", v1.id);
  record("UPDATE direct du layout refusé (immuable, trigger M019 inchangé)", !!directUpdateErr, directUpdateErr?.message);

  // ===========================================================================
  // 7. get_catalog_item_version_file — aperçu + fichier modifiable, droits existants.
  // ===========================================================================
  const { data: fileV1, error: fileV1Err } = await owner.client.rpc("get_catalog_item_version_file", { p_version_id: v1.id });
  const rowV1 = Array.isArray(fileV1) ? fileV1[0] : fileV1;
  record("get_catalog_item_version_file — propriétaire lit storage_key + bucket + layout", !fileV1Err && !!rowV1?.storage_key && rowV1?.bucket === "organization-catalog" && rowV1?.layout?.layout?.marker === "A", fileV1Err?.message ?? JSON.stringify(rowV1));

  const { data: fileV2, error: fileV2Err } = await owner.client.rpc("get_catalog_item_version_file", { p_version_id: v2.id });
  const rowV2 = Array.isArray(fileV2) ? fileV2[0] : fileV2;
  record("get_catalog_item_version_file — ancienne version (sans layout) renvoie layout=null, jamais une erreur", !fileV2Err && rowV2?.layout === null, fileV2Err?.message ?? JSON.stringify(rowV2));

  const { error: fileOutsiderErr } = await outsider.client.rpc("get_catalog_item_version_file", { p_version_id: v1.id });
  record("get_catalog_item_version_file — outsider refusé (aucune permission de lecture nouvelle)", fileOutsiderErr?.message === "not_authorized", fileOutsiderErr?.message);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${total} tests réussis.`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERREUR:", err.message, err.stack);
  process.exitCode = 1;
});
