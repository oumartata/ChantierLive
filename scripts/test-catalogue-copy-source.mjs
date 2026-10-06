// Test d'intégration LOCAL uniquement (aucune connexion cloud) : copie d'un
// modèle de catalogue vers un chantier, premier sous-lot SANS migration
// (src/lib/plans/catalogueCopySource.ts, compilé depuis le dépôt et appelé
// avec de VRAIES sessions). Données jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-catalogue-copy-source.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const local = (() => {
  try {
    const { hostname } = new URL(SUPABASE_URL);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
})();
if (!local) {
  console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`);
  process.exit(1);
}
if (!SERVICE_KEY || !ANON_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY manquants.");
  process.exit(1);
}

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (x, y) => JSON.stringify(canon(x)) === JSON.stringify(canon(y));
const checksumOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function createTestUser(label) {
  const email = `copie-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, email, client };
}
async function createOrganization(ownerId, label) {
  const { data, error } = await service.from("organizations").insert({ name: `Copie — ${label}`, owner_profile_id: ownerId }).select("id").single();
  if (error) throw new Error(`createOrganization: ${error.message}`);
  return data.id;
}
async function createProject(client, label, organizationId) {
  const { data, error } = await client.rpc("create_draft_project", { p_name: `Copie — ${label}`, p_country: "ML", p_role: "CONTRACTOR", p_organization_id: organizationId });
  if (error) throw new Error(`create_draft_project(${label}): ${error.message}`);
  return (Array.isArray(data) ? data[0] : data).project_id;
}
// Version de catalogue : fichier plat (PNG) + fichier structuré facultatif,
// par le circuit réel (prepare → claim → écriture → attest → finalize).
async function depositVersion(ownerClient, organizationId, catalogItemId, layout) {
  const op = randomUUID();
  const { data: prep, error: prepErr } = await ownerClient.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: op, p_organization_id: organizationId, p_catalog_item_id: catalogItemId,
    p_expected_checksum: checksumOf(PNG_BYTES), p_expected_size_bytes: PNG_BYTES.length, p_expected_mime_type: "image/png",
  });
  if (prepErr) throw new Error(`prepare: ${prepErr.message}`);
  const { data: claim, error: claimErr } = await ownerClient.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id });
  if (claimErr || !claim?.won) throw new Error(`claim: ${claimErr?.message}`);
  const { error: writeErr } = await service.storage.from("organization-catalog").upload(claim.candidate_key, PNG_BYTES, { contentType: "image/png", upsert: false });
  if (writeErr) throw new Error(`upload: ${writeErr.message}`);
  const { error: attErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: checksumOf(PNG_BYTES), p_actual_size_bytes: PNG_BYTES.length, p_actual_mime_type: "image/png",
  });
  if (attErr) throw new Error(`attest: ${attErr.message}`);
  if (layout) {
    const { error } = await service.rpc("attest_catalog_item_layout", { p_operation_uuid: op, p_layout: layout });
    if (error) throw new Error(`attest layout: ${error.message}`);
  }
  const { data: version, error: finErr } = await ownerClient.rpc("finalize_catalog_item_upload", { p_operation_uuid: op });
  if (finErr) throw new Error(`finalize: ${finErr.message}`);
  return version;
}
async function publish(owner, engineer, designationId, versionId) {
  const { data: sub, error: subErr } = await owner.client.rpc("submit_catalog_item_version_for_validation", { p_version_id: versionId, p_designation_id: designationId });
  if (subErr) throw new Error(`submit: ${subErr.message}`);
  const { error: decErr } = await engineer.client.rpc("decide_catalog_item_validation", { p_validation_id: sub.id, p_decision: "VALIDATED", p_note: "Test copie." });
  if (decErr) throw new Error(`decide: ${decErr.message}`);
  const { error: pubErr } = await owner.client.rpc("publish_catalog_item_version", { p_version_id: versionId });
  if (pubErr) throw new Error(`publish: ${pubErr.message}`);
}
async function count(table, column, value) {
  const { count: n } = await service.from(table).select("id", { count: "exact", head: true }).eq(column, value);
  return n;
}

const tmpDir = mkdtempSync(join(tmpdir(), "copie-catalogue-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const sources = [
    "src/app/prototype-plans/geometry.ts",
    "src/app/prototype-plans/projectFile.ts",
    "src/app/prototype-plans/catalogueCopy.ts",
    "src/lib/plans/variantAttestation.ts",
    "src/lib/plans/catalogueCopySource.ts",
  ].map((f) => `"${f}"`).join(" ");
  const compile = spawnSync(`"${tscBin}" ${sources} --module commonjs --target es2020 --outDir "${tmpDir}" --rootDir src --esModuleInterop --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
  const src = await import(pathToFileURL(join(tmpDir, "lib", "plans", "catalogueCopySource.js")).href);

  const model = JSON.parse(readFileSync(join(repoRoot, "scripts", "fixtures", "plans-c2-resolu.projet.json"), "utf8"));
  const program = [
    { type: "salon", count: 1, minWidth: 4, minDepth: 4 },
    { type: "chambre", count: 3, minWidth: 3, minDepth: 3 },
    { type: "cuisine", count: 1, minWidth: 2.5, minDepth: 2.5 },
    { type: "sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8 },
  ];
  // Chantier destinataire : terrain DIFFÉRENT de celui du modèle (20 × 14).
  const destParams = { terrainWidth: 22, terrainDepth: 16, setbacks: { front: 3, back: 3, left: 2, right: 2 }, accessSide: "front", orientation: "E", needs: program };

  // --- Données de test ------------------------------------------------------
  const owner = await createTestUser("proprietaire-org");
  const engineer = await createTestUser("ingenieur");
  const contractorB = await createTestUser("entreprise-non-proprietaire");
  const outsider = await createTestUser("chantier-hors-adhesion");
  const orgA = await createOrganization(owner.id, "organisation A");
  const orgB = await createOrganization(owner.id, "organisation B");
  const projectA = await createProject(owner.client, "chantier A (org A)", orgA);
  const projectB = await createProject(owner.client, "chantier B (org B)", orgB);
  // Chantier de l'organisation A dont le propriétaire de l'organisation n'est PAS membre.
  await service.from("organization_memberships").insert({ organization_id: orgA, profile_id: outsider.id });
  let projectX;
  try {
    projectX = await createProject(outsider.client, "chantier X (org A, sans le propriétaire)", orgA);
  } catch {
    projectX = await createProject(outsider.client, "chantier X (org A, sans le propriétaire)", null);
    await service.from("projects").update({ organization_id: orgA }).eq("id", projectX);
  }
  const { data: projX } = await service.from("projects").select("organization_id").eq("id", projectX).single();
  record("Préparation : chantier X rattaché à l'organisation A sans adhésion du propriétaire", projX.organization_id === orgA);
  // B : entreprise sur le chantier A, sans posséder l'organisation.
  await service.from("project_memberships").insert({ project_id: projectA, profile_id: contractorB.id, role: "OWNER", owner_profile: "PRIMARY" });

  const { data: designation, error: desErr } = await owner.client.rpc("designate_plan_engineer", { p_organization_id: orgA, p_identifier_kind: "EMAIL", p_identifier_value: engineer.email });
  if (desErr) throw new Error(`designate: ${desErr.message}`);
  const { data: itemPublished } = await owner.client.rpc("create_catalog_item", { p_organization_id: orgA, p_label: "Modèle structuré publié" });
  const { data: itemDraft } = await owner.client.rpc("create_catalog_item", { p_organization_id: orgA, p_label: "Modèle structuré non publié" });
  const { data: itemFlat } = await owner.client.rpc("create_catalog_item", { p_organization_id: orgA, p_label: "Modèle plat publié" });
  const vPublished = await depositVersion(owner.client, orgA, itemPublished.id, model);
  await depositVersion(owner.client, orgA, itemDraft.id, model);
  const vFlat = await depositVersion(owner.client, orgA, itemFlat.id, null);
  await publish(owner, engineer, designation.id, vPublished.id);
  await publish(owner, engineer, designation.id, vFlat.id);
  const { data: versionBefore } = await service.from("plan_catalog_item_versions").select("*").eq("id", vPublished.id).single();
  const validationsBefore = await count("plan_catalog_item_validations", "catalog_item_version_id", vPublished.id);

  // --- 1. Source : modèle accessible, publié, structuré ----------------------
  const s1 = await src.loadCatalogueCopySource(owner.client, orgA, itemPublished.id);
  record("Source : version publiée structurée lue par le propriétaire de l'organisation", s1.ok && s1.value.versionId === vPublished.id && s1.value.file.version === 4, s1.message);
  const s2 = await src.loadCatalogueCopySource(contractorB.client, orgA, itemPublished.id);
  record("Source refusée à un membre de chantier qui ne possède pas l'organisation", !s2.ok, s2.message);
  const s3 = await src.loadCatalogueCopySource(owner.client, orgA, itemDraft.id);
  record("Modèle sans version publiée : refusé, expliqué", !s3.ok && /pas de version publiée/.test(s3.message), s3.message);
  const s4 = await src.loadCatalogueCopySource(owner.client, orgA, itemFlat.id);
  record("Modèle plat publié : jamais présenté comme éditable", !s4.ok && s4.flat === true && /ne peut pas être ouvert dans l'éditeur/.test(s4.message), s4.message);

  // --- 2. Destination : adhésion + rattachement (D107) -----------------------
  const dests = await src.listCatalogueCopyDestinations(owner.client, owner.id, orgA);
  record(
    "Chantiers proposés : seulement ceux où l'utilisateur est membre habilité ET rattachés à l'organisation",
    dests.length === 1 && dests[0].id === projectA,
    JSON.stringify(dests.map((d) => d.id === projectA ? "A" : d.id === projectB ? "B" : d.id === projectX ? "X" : "?"))
  );
  const dB = await src.checkCatalogueCopyDestination(owner.client, owner.id, orgA, projectB);
  record("Chantier d'une autre organisation refusé", !dB.ok && /pas rattaché/.test(dB.message), dB.message);
  const dX = await src.checkCatalogueCopyDestination(owner.client, owner.id, orgA, projectX);
  record("Posséder l'organisation ne donne pas accès à ses chantiers (chantier X sans adhésion)", !dX.ok, dX.message);
  await service.from("project_memberships").insert({ project_id: projectX, profile_id: owner.id, role: "OWNER", owner_profile: "CO_OWNER" });
  const dX2 = await src.checkCatalogueCopyDestination(owner.client, owner.id, orgA, projectX);
  record("Copropriétaire du chantier : rôle insuffisant, refusé", !dX2.ok && /rôle/.test(dX2.message), dX2.message);

  // --- 3. Vérification sans écriture -----------------------------------------
  const requestsBefore = await count("project_plan_requests", "project_id", projectA);
  const bad = await src.prepareCatalogueCopyFor(owner.client, owner.id, {
    organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: { ...destParams, accessSide: "left" },
  });
  record("Incompatibilité (façade) : expliquée, aucune copie préparée", bad.ok && bad.copy === null && bad.report.blocking.some((b) => /Façade d'accès différente/.test(b)));
  const preview = await src.prepareCatalogueCopyFor(owner.client, owner.id, { organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: destParams });
  record("Vérification : copie possible, aucun blocage", preview.ok && preview.copy !== null && preview.report.blocking.length === 0, preview.ok ? preview.report.blocking.join(" | ") : preview.message);
  record("Vérification : aucune demande créée", (await count("project_plan_requests", "project_id", projectA)) === requestsBefore);

  // --- 4. Création ----------------------------------------------------------
  const op = randomUUID();
  const savedAt = new Date().toISOString();
  const refused = await src.createCatalogueCopy(contractorB.client, service, contractorB.id, {
    organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: destParams, savedAt, operationUuid: randomUUID(), requestId: null,
  });
  record("Création refusée sans accès au modèle, rien d'écrit", !refused.ok && (await count("project_plan_requests", "project_id", projectA)) === requestsBefore, refused.message);
  const blocked = await src.createCatalogueCopy(owner.client, service, owner.id, {
    organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: { ...destParams, needs: program.slice(1) }, savedAt, operationUuid: randomUUID(), requestId: null,
  });
  record("Création refusée si la copie est incompatible (programme), rien d'écrit", !blocked.ok && blocked.report?.blocking.length > 0 && (await count("project_plan_requests", "project_id", projectA)) === requestsBefore, blocked.message);

  const created = await src.createCatalogueCopy(owner.client, service, owner.id, {
    organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: destParams, savedAt, operationUuid: op, requestId: null,
  });
  record("Copie créée : demande + variante 1", created.ok, created.message);
  const { data: request } = await service.from("project_plan_requests").select("*").eq("id", created.requestId).single();
  record("Demande : paramètres du CHANTIER enregistrés, jamais ceux du modèle", same(request.generation_params, preview.params) && request.generation_params.terrainWidth === 22 && request.status === "OPEN");
  const { data: variants } = await service.from("project_plan_request_variants").select("*").eq("request_id", created.requestId);
  const v1 = variants[0];
  record("Variante 1 = la copie, posée sur le terrain du chantier (22 × 16)", variants.length === 1 && v1.variant_number === 1 && v1.layout.layout.terrain.w === 22 && v1.layout.layout.terrain.d === 16 && v1.layout.orientation === "E");
  const geom = (L) => L.rooms.map((r) => [r.type, r.number, r.x, r.y, r.w, r.d]);
  record("Variante 1 : pièces identiques au modèle (aucun redimensionnement)", same(geom(v1.layout.layout), geom(model.layout)));
  record("Variante 1 : aucune autorisation F2", !v1.layout.layout.dimensionAllowances && v1.layout.version === 4);
  record("Variante 1 : ni déposée ni rattachée à une version", v1.project_plan_version_id === null && v1.deposited_at_server === null);
  const { data: versionAfter } = await service.from("plan_catalog_item_versions").select("*").eq("id", vPublished.id).single();
  record("Modèle et version d'origine strictement inchangés", same(versionAfter, versionBefore));
  record("Aucun verdict hérité : aucune version de chantier, aucune validation de chantier", (await count("project_plan_versions", "project_id", projectA)) === 0 && (await count("plan_validations", "project_id", projectA)) === 0);
  record("Validations du catalogue inchangées", (await count("plan_catalog_item_validations", "catalog_item_version_id", vPublished.id)) === validationsBefore);
  record("Demande sans lien vers le catalogue (aucune colonne source sans migration)", !Object.keys(request).some((k) => /catalog/.test(k)));

  // --- 5. Reprises ----------------------------------------------------------
  const retry = await src.createCatalogueCopy(owner.client, service, owner.id, {
    organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: destParams, savedAt, operationUuid: op, requestId: created.requestId,
  });
  record("Reprise (même opération, demande connue) : même variante, aucun doublon", retry.ok && retry.variantId === created.variantId && (await count("project_plan_request_variants", "request_id", created.requestId)) === 1);
  const lost = await src.createCatalogueCopy(owner.client, service, owner.id, {
    organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: destParams, savedAt, operationUuid: op, requestId: null,
  });
  record(
    "Reprise après réponse perdue (demande inconnue du navigateur) : même demande, même variante",
    lost.ok && lost.requestId === created.requestId && lost.variantId === created.variantId && (await count("project_plan_requests", "project_id", projectA)) === requestsBefore + 1,
    lost.message
  );

  // Échec réel entre la création de la demande et l'enregistrement : la
  // reprise réutilise la demande ouverte, une seule variante.
  const op2 = randomUUID();
  const { data: orphan } = await owner.client.rpc("create_plan_request", { p_project_id: projectA, p_generation_params: preview.params });
  const resumed = await src.createCatalogueCopy(owner.client, service, owner.id, {
    organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: destParams, savedAt, operationUuid: op2, requestId: orphan.id,
  });
  record("Reprise après échec réel : demande ouverte réutilisée, une variante", resumed.ok && resumed.requestId === orphan.id && (await count("project_plan_request_variants", "request_id", orphan.id)) === 1, resumed.message);

  const other = await src.createCatalogueCopy(owner.client, service, owner.id, {
    organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: { ...destParams, orientation: "S" }, savedAt, operationUuid: randomUUID(), requestId: orphan.id,
  });
  record("Paramètres différents : demande précédente jamais réutilisée", other.ok && other.requestId !== orphan.id);

  // Accès retiré entre la vérification et la création.
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", projectA).eq("profile_id", owner.id);
  const revoked = await src.createCatalogueCopy(owner.client, service, owner.id, {
    organizationId: orgA, catalogItemId: itemPublished.id, projectId: projectA, params: destParams, savedAt, operationUuid: randomUUID(), requestId: null,
  });
  record("Accès au chantier retiré : création refusée", !revoked.ok, revoked.message);
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
