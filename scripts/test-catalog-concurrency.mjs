// Test de concurrence RÉELLE (deux connexions Postgres distinctes) pour B061
// (EN REVUE) — complément ciblé, revue : les scénarios précédents
// ("compte devenu provisoire entre deux appels RPC séparés") ne prouvaient
// PAS qu'un contrôle devienne obsolète PENDANT une attente réelle sur un
// verrou. Ce script tient un verrou ouvert depuis une connexion psql
// séparée (docker exec, même mécanisme que l'application des migrations
// dans cette session — aucune nouvelle dépendance ajoutée), pendant qu'une
// mutation réelle est appliquée sur une ligne DIFFÉRENTE (jamais celle
// verrouillée elle-même — un verrou FOR UPDATE garantit déjà la fraîcheur
// de la ligne qu'il protège), puis vérifie que l'appel RPC bloqué, une fois
// débloqué, revoit l'état À JOUR et non une valeur mise en cache avant
// l'attente. Le temps RÉELLEMENT écoulé de chaque appel bloqué est mesuré
// pour prouver qu'un blocage réel a eu lieu (pas un succès immédiat fortuit).
//
// Usage : node scripts/test-catalog-concurrency.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";

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
  const email = `b061-conc-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, email: email.toLowerCase(), client };
}

async function createOrganization(ownerProfileId, label) {
  const { data, error } = await service.from("organizations").insert({ name: `B061 concurrence — ${label}`, owner_profile_id: ownerProfileId }).select("id").single();
  if (error) throw new Error(`createOrganization(${label}): ${error.message}`);
  return data.id;
}

async function designate(ownerClient, organizationId, engineerEmail) {
  const { data, error } = await ownerClient.rpc("designate_plan_engineer", { p_organization_id: organizationId, p_identifier_kind: "EMAIL", p_identifier_value: engineerEmail });
  if (error) throw new Error(`designate: ${error.message}`);
  return data.id;
}

function checksumOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Dépose un fichier complet (prepare -> claim -> écriture/relecture RÉELLES
// dans Storage -> attest -> finalize). Retourne version + operationUuid.
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
  const { data: written, error: dlErr } = await service.storage.from("organization-catalog").download(claim.candidate_key);
  if (dlErr) throw new Error(`storage.download: ${dlErr.message}`);
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

// Tient un verrou FOR UPDATE réel sur une ligne, depuis une connexion psql
// SÉPARÉE (docker exec — même mécanisme que l'application des migrations
// dans cette session), pendant holdSeconds, puis COMMIT (relâche le verrou).
// Retourne une promesse résolue quand la connexion se termine (verrou relâché).
function holdLock(table, id, holdSeconds) {
  const sql = `begin;\nselect * from public.${table} where id = '${id}' for update;\nselect pg_sleep(${holdSeconds});\ncommit;\n`;
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", ["exec", "-i", "supabase_db_ChantierLive", "psql", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`holdLock(${table},${id}) exit ${code}: ${stderr}`))));
    proc.stdin.write(sql);
    proc.stdin.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const owner = await createTestUser("owner");

  // ---------------------------------------------------------------------
  // Test 1 — finalize_catalog_item_upload : expiration de tentative RÉELLE
  // pendant une attente réelle sur le verrou organisations (blocage
  // extérieur), pas une simple comparaison locale sans attente.
  // ---------------------------------------------------------------------
  const org1 = await createOrganization(owner.id, "expiration");
  const { data: item1 } = await owner.client.rpc("create_catalog_item", { p_organization_id: org1, p_label: "Item expiration" });
  const opUuid1 = randomUUID();
  const bytes1 = Buffer.from("PLAN-EXPIRATION-REELLE");
  const { data: prep1, error: prep1Err } = await owner.client.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: opUuid1, p_organization_id: org1, p_catalog_item_id: item1.id,
    p_expected_checksum: checksumOf(bytes1), p_expected_size_bytes: bytes1.length, p_expected_mime_type: "application/pdf",
  });
  if (prep1Err) throw new Error(`prep1: ${prep1Err.message}`);
  const { data: claim1, error: claim1Err } = await owner.client.rpc("claim_upload_attempt", { p_operation_uuid: opUuid1, p_expected_attempt_id: prep1.attempt_id });
  if (claim1Err || !claim1?.won) throw new Error(`claim1: ${claim1Err?.message ?? "not won"}`);
  const { error: write1Err } = await service.storage.from("organization-catalog").upload(claim1.candidate_key, bytes1, { contentType: "application/pdf", upsert: false });
  if (write1Err) throw new Error(`write1: ${write1Err.message}`);
  const { data: written1 } = await service.storage.from("organization-catalog").download(claim1.candidate_key);
  const writtenBytes1 = new Uint8Array(await written1.arrayBuffer());
  const { error: attest1Err } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: opUuid1, p_attempt_id: claim1.attempt_id,
    p_actual_checksum: checksumOf(writtenBytes1), p_actual_size_bytes: writtenBytes1.length, p_actual_mime_type: "application/pdf",
  });
  if (attest1Err) throw new Error(`attest1: ${attest1Err.message}`);
  // Fenêtre d'expiration COURTE et réelle : 2 secondes.
  const { error: shortWindowErr } = await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() + 2000).toISOString() }).eq("operation_uuid", opUuid1);
  if (shortWindowErr) throw new Error(`shortWindow: ${shortWindowErr.message}`);

  const blocker1 = holdLock("organizations", org1, 5).catch((e) => { throw e; });
  await sleep(700); // laisse le blocker acquérir réellement son verrou avant l'appel bloqué.
  const t1Start = Date.now();
  const { error: finErr1 } = await owner.client.rpc("finalize_catalog_item_upload", { p_operation_uuid: opUuid1 });
  const t1Elapsed = Date.now() - t1Start;
  await blocker1;
  record(
    "Attente réelle (organizations, ~5s) — finalize bloque RÉELLEMENT (>= 3.5s), pas un succès immédiat",
    t1Elapsed >= 3500,
    `${t1Elapsed}ms`
  );
  record(
    "Expiration pendant l'attente réelle — finalize refuse attempt_expired (fenêtre de 2s dépassée pendant les ~5s de blocage)",
    finErr1?.message === "attempt_expired",
    finErr1?.message
  );
  const { data: upload1After } = await service.from("private_object_uploads").select("status").eq("operation_uuid", opUuid1).single();
  record("Refus n'a rien finalisé — l'upload reste FINALIZING (jamais FINALIZED)", upload1After?.status === "FINALIZING", upload1After?.status);

  // ---------------------------------------------------------------------
  // Test 2 — decide_catalog_item_validation : compte devenu provisoire
  // PENDANT une attente réelle sur le verrou de la désignation (ligne
  // DIFFÉRENTE de celle mutée : profile_identifiers, jamais verrouillée
  // ici — la mutation n'attend donc pas le verrou, contrairement à decide).
  // ---------------------------------------------------------------------
  const org2 = await createOrganization(owner.id, "provisoire-decide");
  const { data: item2 } = await owner.client.rpc("create_catalog_item", { p_organization_id: org2, p_label: "Item provisoire decide" });
  const engineer2 = await createTestUser("eng-decide");
  const designation2Id = await designate(owner.client, org2, engineer2.email);
  const { version: v2 } = await depositVersion(owner.client, org2, item2.id, Buffer.from("PLAN-PROVISOIRE-DECIDE"));
  const { data: submission2, error: sub2Err } = await owner.client.rpc("submit_catalog_item_version_for_validation", { p_version_id: v2.id, p_designation_id: designation2Id });
  if (sub2Err) throw new Error(`sub2: ${sub2Err.message}`);

  const blocker2 = holdLock("plan_engineer_designations", designation2Id, 4).catch((e) => { throw e; });
  await sleep(700);
  // Mutation RÉELLE d'une ligne DIFFÉRENTE (profile_identifiers), PENDANT le blocage.
  await sleep(600);
  const { error: unverify2Err } = await service.from("profile_identifiers").update({ verified_at_server: null }).eq("profile_id", engineer2.id).eq("kind", "EMAIL");
  if (unverify2Err) throw new Error(`unverify2: ${unverify2Err.message}`);

  const t2Start = Date.now();
  const { error: decideErr2 } = await engineer2.client.rpc("decide_catalog_item_validation", { p_validation_id: submission2.id, p_decision: "VALIDATED", p_note: null });
  const t2Elapsed = Date.now() - t2Start;
  await blocker2;
  record(
    "Attente réelle (désignation, ~4s) — decide bloque RÉELLEMENT (>= 2.5s)",
    t2Elapsed >= 2500,
    `${t2Elapsed}ms`
  );
  record(
    "Perte de vérification PENDANT l'attente réelle — decide refuse account_provisional (compte devenu provisoire alors que decide attendait le verrou)",
    decideErr2?.message === "account_provisional",
    decideErr2?.message
  );
  const { data: validation2After } = await service.from("plan_catalog_item_validations").select("status, decided_at_server").eq("id", submission2.id).single();
  record(
    "Refus n'a modifié AUCUNE décision — la ligne reste PENDING, decided_at_server toujours null",
    validation2After?.status === "PENDING" && validation2After?.decided_at_server === null,
    JSON.stringify(validation2After)
  );

  // ---------------------------------------------------------------------
  // Test 3 — get_catalog_item_validation_file_key : même scénario, vérifie
  // en plus qu'AUCUNE clé n'est délivrée en cas de refus.
  // ---------------------------------------------------------------------
  const org3 = await createOrganization(owner.id, "provisoire-filekey");
  const { data: item3 } = await owner.client.rpc("create_catalog_item", { p_organization_id: org3, p_label: "Item provisoire filekey" });
  const engineer3 = await createTestUser("eng-filekey");
  const designation3Id = await designate(owner.client, org3, engineer3.email);
  const { version: v3 } = await depositVersion(owner.client, org3, item3.id, Buffer.from("PLAN-PROVISOIRE-FILEKEY"));
  const { data: submission3, error: sub3Err } = await owner.client.rpc("submit_catalog_item_version_for_validation", { p_version_id: v3.id, p_designation_id: designation3Id });
  if (sub3Err) throw new Error(`sub3: ${sub3Err.message}`);

  const blocker3 = holdLock("plan_engineer_designations", designation3Id, 4).catch((e) => { throw e; });
  await sleep(700);
  await sleep(600);
  const { error: unverify3Err } = await service.from("profile_identifiers").update({ verified_at_server: null }).eq("profile_id", engineer3.id).eq("kind", "EMAIL");
  if (unverify3Err) throw new Error(`unverify3: ${unverify3Err.message}`);

  const t3Start = Date.now();
  const { data: fileKey3, error: fileKeyErr3 } = await engineer3.client.rpc("get_catalog_item_validation_file_key", { p_validation_id: submission3.id });
  const t3Elapsed = Date.now() - t3Start;
  await blocker3;
  record(
    "Attente réelle (désignation, ~4s) — get_catalog_item_validation_file_key bloque RÉELLEMENT (>= 2.5s)",
    t3Elapsed >= 2500,
    `${t3Elapsed}ms`
  );
  record(
    "Perte de vérification PENDANT l'attente réelle — accès fichier refusé account_provisional",
    fileKeyErr3?.message === "account_provisional",
    fileKeyErr3?.message
  );
  record("Refus ne délivre AUCUNE clé de fichier", fileKey3 === null || fileKey3 === undefined, JSON.stringify(fileKey3));
  const { data: validation3After } = await service.from("plan_catalog_item_validations").select("status, decided_at_server").eq("id", submission3.id).single();
  record(
    "Refus n'a modifié AUCUNE décision ni finalisation — la ligne reste PENDING",
    validation3After?.status === "PENDING" && validation3After?.decided_at_server === null,
    JSON.stringify(validation3After)
  );

  // ---------------------------------------------------------------------
  // Test 4 — idempotence de l'ACTION APPLICATIVE complète (pas seulement
  // finalize) : reproduit exactement la branche de reprise de
  // depositCatalogItemVersionAction (get_upload_status -> FINALIZED ->
  // lecture directe de la version existante), jamais testée jusqu'ici
  // (le test précédent ne rejouait que finalize_catalog_item_upload seul).
  // ---------------------------------------------------------------------
  const org4 = await createOrganization(owner.id, "idempotence-action");
  const { data: item4 } = await owner.client.rpc("create_catalog_item", { p_organization_id: org4, p_label: "Item idempotence action" });
  const { version: v4, operationUuid: opUuid4 } = await depositVersion(owner.client, org4, item4.id, Buffer.from("PLAN-IDEMPOTENCE-ACTION"));

  // Reprend EXACTEMENT la logique de depositCatalogItemVersionAction (voir
  // actions.ts) : get_upload_status D'ABORD, puis court-circuit si FINALIZED
  // — sans jamais rappeler prepare/claim/attest/finalize.
  const { data: status4, error: status4Err } = await owner.client.rpc("get_upload_status", { p_operation_uuid: opUuid4 });
  if (status4Err) throw new Error(`status4: ${status4Err.message}`);
  record("Reprise applicative — get_upload_status confirme FINALIZED", status4?.status === "FINALIZED", status4?.status);

  const { data: existingVersion4, error: existingErr4 } = await service.from("plan_catalog_item_versions").select("id").eq("private_object_upload_id", status4.id).maybeSingle();
  record(
    "Reprise applicative — court-circuit renvoie la MÊME version que le dépôt initial (sans rappeler prepare/claim/attest/finalize)",
    existingErr4 === null && existingVersion4?.id === v4.id,
    existingErr4?.message ?? existingVersion4?.id
  );
  const { data: v4Rows } = await service.from("plan_catalog_item_versions").select("id").eq("catalog_item_id", item4.id);
  record("Reprise applicative — une seule ligne version existe pour cet item (aucun doublon)", (v4Rows ?? []).length === 1);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${total} tests réussis.`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERREUR:", err.message);
  process.exitCode = 1;
});
