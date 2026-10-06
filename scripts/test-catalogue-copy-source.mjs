// Test d'intégration LOCAL uniquement (aucune connexion cloud) : copie d'un
// modèle de catalogue vers un chantier (src/lib/plans/catalogueCopySource.ts,
// compilé depuis le dépôt et appelé avec de VRAIES sessions) et traçabilité
// de son origine (M035 : create_plan_request_from_catalog_item,
// list_plan_request_origins). Données jetables créées par ce script.
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
  const secondSession = async () => {
    const other = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const { error: e } = await other.auth.signInWithPassword({ email, password });
    if (e) throw new Error(`signIn(${label}): ${e.message}`);
    return other;
  };
  return { id: data.user.id, email, client, secondSession };
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
  const vDraft = await depositVersion(owner.client, orgA, itemDraft.id, model);
  // Modèle d'une AUTRE organisation (propriétaire différent).
  const orgC = await createOrganization(contractorB.id, "organisation C");
  const { data: itemForeign } = await contractorB.client.rpc("create_catalog_item", { p_organization_id: orgC, p_label: "Modèle d'une autre organisation" });
  const vForeign = await depositVersion(contractorB.client, orgC, itemForeign.id, model);
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
  const base = { organizationId: orgA, catalogItemId: itemPublished.id, versionId: vPublished.id, projectId: projectA };
  const requestsBefore = await count("project_plan_requests", "project_id", projectA);
  const bad = await src.prepareCatalogueCopyFor(owner.client, owner.id, { ...base, params: { ...destParams, accessSide: "left" } });
  record("Incompatibilité (façade) : expliquée, aucune copie préparée", bad.ok && bad.copy === null && bad.report.blocking.some((b) => /Façade d'accès différente/.test(b)));
  const preview = await src.prepareCatalogueCopyFor(owner.client, owner.id, { ...base, params: destParams });
  record("Vérification : copie possible, aucun blocage", preview.ok && preview.copy !== null && preview.report.blocking.length === 0, preview.ok ? preview.report.blocking.join(" | ") : preview.message);
  record("Vérification : aucune demande créée", (await count("project_plan_requests", "project_id", projectA)) === requestsBefore);

  // --- 4. Création ----------------------------------------------------------
  const op = randomUUID();
  const savedAt = new Date().toISOString();
  const refused = await src.createCatalogueCopy(contractorB.client, service, contractorB.id, { ...base, params: destParams, savedAt, operationUuid: randomUUID() });
  record("Création refusée sans accès au modèle, rien d'écrit", !refused.ok && (await count("project_plan_requests", "project_id", projectA)) === requestsBefore, refused.message);
  const blocked = await src.createCatalogueCopy(owner.client, service, owner.id, { ...base, params: { ...destParams, needs: program.slice(1) }, savedAt, operationUuid: randomUUID() });
  record("Création refusée si la copie est incompatible (programme), rien d'écrit", !blocked.ok && blocked.report?.blocking.length > 0 && (await count("project_plan_requests", "project_id", projectA)) === requestsBefore, blocked.message);

  const created = await src.createCatalogueCopy(owner.client, service, owner.id, { ...base, params: destParams, savedAt, operationUuid: op });
  record("Copie créée : demande + variante 1", created.ok, created.message);
  const { data: request } = await service.from("project_plan_requests").select("*").eq("id", created.requestId).single();
  record("Demande : paramètres du CHANTIER enregistrés, jamais ceux du modèle", same(request.generation_params, preview.params) && request.generation_params.terrainWidth === 22 && request.status === "OPEN");
  record("Origine : version EXACTE du modèle (pas le modèle seul), opération enregistrée", request.source_catalog_item_version_id === vPublished.id && request.catalog_copy_operation_uuid === op);
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

  // --- 5. Reprises et concurrence ------------------------------------------
  const retry = await src.createCatalogueCopy(owner.client, service, owner.id, { ...base, params: destParams, savedAt, operationUuid: op });
  record(
    "Reprise après réponse perdue (même opération) : même demande, même variante",
    retry.ok && retry.requestId === created.requestId && retry.variantId === created.variantId &&
      (await count("project_plan_requests", "project_id", projectA)) === requestsBefore + 1 && (await count("project_plan_request_variants", "request_id", created.requestId)) === 1,
    retry.message
  );
  // Échec réel entre A (demande) et B/C (variante) : la reprise termine.
  const op2 = randomUUID();
  const { data: orphan, error: orphanErr } = await owner.client.rpc("create_plan_request_from_catalog_item", {
    p_project_id: projectA, p_catalog_item_version_id: vPublished.id, p_generation_params: preview.params, p_operation_uuid: op2,
  });
  record("Échec réel simulé : demande créée sans variante", !orphanErr && (await count("project_plan_request_variants", "request_id", orphan?.id)) === 0, orphanErr?.message);
  const resumed = await src.createCatalogueCopy(owner.client, service, owner.id, { ...base, params: destParams, savedAt, operationUuid: op2 });
  record("Reprise après échec réel : même demande, une seule variante", resumed.ok && resumed.requestId === orphan.id && (await count("project_plan_request_variants", "request_id", orphan.id)) === 1, resumed.message);
  const conflict = await src.createCatalogueCopy(owner.client, service, owner.id, { ...base, params: { ...destParams, orientation: "S" }, savedAt, operationUuid: op2 });
  record("Même opération, paramètres différents : refusé", !conflict.ok && conflict.code === "catalog_copy_operation_conflict", conflict.code);
  // Concurrence : deux créations simultanées de la même opération.
  const op3 = randomUUID();
  const tab2 = await owner.secondSession();
  const [c1, c2] = await Promise.all([
    src.createCatalogueCopy(owner.client, service, owner.id, { ...base, params: destParams, savedAt, operationUuid: op3 }),
    src.createCatalogueCopy(tab2, service, owner.id, { ...base, params: destParams, savedAt, operationUuid: op3 }),
  ]);
  const { data: op3Requests } = await service.from("project_plan_requests").select("id").eq("catalog_copy_operation_uuid", op3);
  record(
    "Deux créations simultanées (même opération) : une demande, une variante",
    c1.ok && c2.ok && c1.requestId === c2.requestId && c1.variantId === c2.variantId && op3Requests.length === 1 && (await count("project_plan_request_variants", "request_id", c1.requestId)) === 1,
    c1.message ?? c2.message
  );

  // --- 6. Appels directs non autorisés et origines falsifiées ---------------
  const direct = (client, projectId, versionId, opUuid = randomUUID(), params = preview.params) =>
    client.rpc("create_plan_request_from_catalog_item", { p_project_id: projectId, p_catalog_item_version_id: versionId, p_generation_params: params, p_operation_uuid: opUuid });
  const requestsNow = async () => (await service.from("project_plan_requests").select("id", { count: "exact", head: true }).not("source_catalog_item_version_id", "is", null)).count;
  const sourcedBefore = await requestsNow();
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const cases = [
    ["sans session", anon, projectA, vPublished.id, (e) => e?.code === "42501"],
    ["membre du chantier sans propriété de l'organisation", contractorB.client, projectA, vPublished.id, (e) => e?.message === "not_authorized"],
    ["chantier d'une autre organisation", owner.client, projectB, vPublished.id, (e) => e?.message === "catalog_organization_mismatch"],
    ["chantier sans adhésion habilitée (copropriétaire)", owner.client, projectX, vPublished.id, (e) => e?.message === "not_authorized"],
    ["version non publiée", owner.client, projectA, vDraft.id, (e) => e?.message === "catalog_version_not_published"],
    ["version publiée plate (sans fichier structuré)", owner.client, projectA, vFlat.id, (e) => e?.message === "catalog_item_not_editable"],
    ["version d'un modèle d'une autre organisation", owner.client, projectA, vForeign.id, (e) => e?.message === "not_authorized"],
    ["version inexistante", owner.client, projectA, randomUUID(), (e) => e?.message === "not_authorized"],
  ];
  for (const [name, client, projectId, versionId, check] of cases) {
    const { error } = await direct(client, projectId, versionId);
    record(`Appel direct refusé — ${name}`, check(error), `${error?.code ?? ""} ${error?.message ?? "accepté"}`);
  }
  const { error: oldSigErr } = await owner.client.rpc("create_plan_request", { p_project_id: projectA, p_generation_params: preview.params, p_source_catalog_item_version_id: vPublished.id });
  record("Ancienne fonction : aucune origine attribuable (paramètre inconnu)", oldSigErr?.code === "PGRST202", oldSigErr?.code);
  const { error: insertErr } = await owner.client.from("project_plan_requests").insert({
    project_id: projectA, created_by_profile_id: owner.id, created_as_role: "CONTRACTOR", generation_params: {}, source_catalog_item_version_id: vPublished.id, catalog_copy_operation_uuid: randomUUID(),
  });
  record("Insertion directe d'une demande avec origine refusée", insertErr?.code === "42501", insertErr?.message);
  const { error: setSourceErr } = await service.from("project_plan_requests").update({ source_catalog_item_version_id: vFlat.id }).eq("id", created.requestId);
  record("Origine immuable (même pour le service_role)", setSourceErr?.message === "project_plan_request_immutable", setSourceErr?.message);
  const { error: clearSourceErr } = await service.from("project_plan_requests").update({ source_catalog_item_version_id: null, catalog_copy_operation_uuid: null }).eq("id", created.requestId);
  record("Origine non effaçable", clearSourceErr?.message === "project_plan_request_immutable", clearSourceErr?.message);
  const { data: legacy } = await owner.client.rpc("create_plan_request", { p_project_id: projectA, p_generation_params: preview.params });
  const { error: addSourceErr } = await service.from("project_plan_requests").update({ source_catalog_item_version_id: vPublished.id, catalog_copy_operation_uuid: randomUUID() }).eq("id", legacy.id);
  record("Aucune origine ajoutable après coup à une demande existante", addSourceErr?.message === "project_plan_request_immutable", addSourceErr?.message);
  record("Aucune demande créée par ces appels refusés", (await requestsNow()) === sourcedBefore);

  // --- 7. Publication ultérieure --------------------------------------------
  const op4 = randomUUID();
  const { data: beforePublish } = await direct(owner.client, projectA, vPublished.id, op4);
  const { data: variant1Before } = await service.from("project_plan_request_variants").select("layout").eq("id", created.variantId).single();
  const modelV2 = JSON.parse(JSON.stringify(model));
  modelV2.layout.rooms[0].x += 0.5;
  const vSecond = await depositVersion(owner.client, orgA, itemPublished.id, modelV2);
  await publish(owner, engineer, designation.id, vSecond.id);
  const { data: requestAfterPublish } = await service.from("project_plan_requests").select("source_catalog_item_version_id").eq("id", created.requestId).single();
  const { data: variant1After } = await service.from("project_plan_request_variants").select("layout").eq("id", created.variantId).single();
  record("Publication d'une nouvelle version : origine inchangée (version 1 exacte)", requestAfterPublish.source_catalog_item_version_id === vPublished.id);
  record("Publication d'une nouvelle version : copie inchangée", same(variant1After.layout, variant1Before.layout));
  const stale = await src.prepareCatalogueCopyFor(owner.client, owner.id, { ...base, params: destParams });
  record("Vérification avec l'ancienne version affichée : refus explicite, rechargement demandé", !stale.ok && /Une autre version de ce modèle a été publiée/.test(stale.message), stale.message);
  const { error: staleDirect } = await direct(owner.client, projectA, vPublished.id);
  record("Création directe depuis une version qui n'est plus publiée : refusée", staleDirect?.message === "catalog_version_not_published", staleDirect?.message);
  const resumedAfterPublish = await src.createCatalogueCopy(owner.client, service, owner.id, { ...base, params: destParams, savedAt, operationUuid: op4 });
  const { data: v1AfterResume } = resumedAfterPublish.ok
    ? await service.from("project_plan_request_variants").select("layout").eq("id", resumedAfterPublish.variantId).single()
    : { data: null };
  record(
    "Reprise d'une opération lancée avant la publication : terminée avec la version d'origine",
    resumedAfterPublish.ok && resumedAfterPublish.requestId === beforePublish.id && v1AfterResume && same(geom(v1AfterResume.layout.layout), geom(model.layout)),
    resumedAfterPublish.message
  );
  const newCopy = await src.createCatalogueCopy(owner.client, service, owner.id, { ...base, versionId: vSecond.id, params: destParams, savedAt, operationUuid: randomUUID() });
  const { data: newRequest } = newCopy.ok ? await service.from("project_plan_requests").select("source_catalog_item_version_id").eq("id", newCopy.requestId).single() : { data: null };
  record("Nouvelle copie après publication : origine = nouvelle version, l'ancienne demande inchangée", newCopy.ok && newRequest.source_catalog_item_version_id === vSecond.id, newCopy.message);

  // --- 8. Affichage de l'origine selon les permissions existantes -----------
  const { data: originsOwner, error: originsOwnerErr } = await owner.client.rpc("list_plan_request_origins", { p_project_id: projectA });
  const mine = originsOwner?.find((o) => o.request_id === created.requestId);
  const legacyOrigin = originsOwner?.find((o) => o.request_id === legacy.id);
  record("Origine visible par le propriétaire du catalogue : libellé et version 1", !originsOwnerErr && mine?.has_catalog_source && mine.source_details_visible && mine.catalog_item_label === "Modèle structuré publié" && mine.catalog_version_number === 1);
  record("Demande sans origine : « non renseignée » (aucune déduction)", legacyOrigin && legacyOrigin.has_catalog_source === false && legacyOrigin.catalog_item_label === null);
  const { data: originsB } = await contractorB.client.rpc("list_plan_request_origins", { p_project_id: projectA });
  const seenByB = originsB?.find((o) => o.request_id === created.requestId);
  record("Lecteur de la demande sans accès au catalogue : origine signalée, détails masqués", seenByB?.has_catalog_source === true && seenByB.source_details_visible === false && seenByB.catalog_item_label === null && seenByB.catalog_version_number === null);
  record("Aucun identifiant de modèle, de version ni de fichier exposé", Object.keys(mine ?? {}).every((k) => !/(_id$|layout|storage|file)/.test(k) || k === "request_id"));
  const { error: srcByB } = await contractorB.client.rpc("get_catalog_item_version_file", { p_version_id: vPublished.id });
  record("La provenance n'ouvre pas le fichier du modèle", srcByB?.message === "not_authorized", srcByB?.message);
  const { error: originsOutsiderErr } = await outsider.client.rpc("list_plan_request_origins", { p_project_id: projectA });
  record("Origines refusées hors chantier", originsOutsiderErr?.message === "not_authorized", originsOutsiderErr?.message);

  // --- 8 bis. Copie interrompue après A (page fermée) : reprise explicite ---
  const interrupt = async (versionId) => {
    const { data, error } = await direct(owner.client, projectA, versionId, randomUUID());
    if (error) throw new Error(`interruption: ${error.message}`);
    return data;
  };
  const geomOf = async (variantId) => geom((await service.from("project_plan_request_variants").select("layout").eq("id", variantId).single()).data.layout.layout);
  const interrupted = await interrupt(vSecond.id);
  const vSecondBefore = (await service.from("plan_catalog_item_versions").select("*").eq("id", vSecond.id).single()).data;
  // Une version 3 est publiée pendant l'interruption : la reprise doit rester sur la version 2.
  const modelV3 = JSON.parse(JSON.stringify(model));
  modelV3.layout.rooms[0].x += 1;
  const vThird = await depositVersion(owner.client, orgA, itemPublished.id, modelV3);
  await publish(owner, engineer, designation.id, vThird.id);
  const requestsBeforeResume = await count("project_plan_requests", "project_id", projectA);
  const resumedCopy = await src.resumeCatalogueCopy(owner.client, service, owner.id, interrupted.id);
  record("Reprise d'une copie interrompue : même demande, variante 1 créée", resumedCopy.ok && resumedCopy.requestId === interrupted.id && (await count("project_plan_request_variants", "request_id", interrupted.id)) === 1, resumedCopy.message);
  record("Reprise : aucune nouvelle demande", (await count("project_plan_requests", "project_id", projectA)) === requestsBeforeResume);
  record("Reprise : copie de la version source EXACTE (v2), pas de la version publiée actuelle (v3)", resumedCopy.ok && same(await geomOf(resumedCopy.variantId), geom(modelV2.layout)));
  const { data: interruptedAfter } = await service.from("project_plan_requests").select("source_catalog_item_version_id, generation_params").eq("id", interrupted.id).single();
  record("Reprise : origine et paramètres du chantier inchangés", interruptedAfter.source_catalog_item_version_id === vSecond.id && same(interruptedAfter.generation_params, interrupted.generation_params));
  record("Reprise : version source inchangée", same((await service.from("plan_catalog_item_versions").select("*").eq("id", vSecond.id).single()).data, vSecondBefore));
  const again = await src.resumeCatalogueCopy(owner.client, service, owner.id, interrupted.id);
  record("Reprise rejouée (réponse perdue) : même variante, aucun doublon", again.ok && again.variantId === resumedCopy.variantId && (await count("project_plan_request_variants", "request_id", interrupted.id)) === 1);

  const interrupted2 = await interrupt(vThird.id);
  const [d1, d2] = await Promise.all([
    src.resumeCatalogueCopy(owner.client, service, owner.id, interrupted2.id),
    src.resumeCatalogueCopy(tab2, service, owner.id, interrupted2.id),
  ]);
  record("Double clic (deux reprises simultanées) : une seule variante", d1.ok && d2.ok && d1.variantId === d2.variantId && (await count("project_plan_request_variants", "request_id", interrupted2.id)) === 1, d1.message ?? d2.message);

  // Échec entre B (attestation) et C (enregistrement) : le fichier attesté est repris tel quel.
  const interrupted3 = await interrupt(vThird.id);
  const { data: op3Row } = await service.from("project_plan_requests").select("catalog_copy_operation_uuid").eq("id", interrupted3.id).single();
  const attestedAt = "2026-10-06T00:00:00.000Z";
  const preparedForB = await src.prepareCatalogueCopyFor(owner.client, owner.id, { ...base, versionId: vThird.id, params: destParams, savedAt: attestedAt });
  await service.rpc("attest_plan_request_variant_layout", { p_operation_uuid: op3Row.catalog_copy_operation_uuid, p_request_id: interrupted3.id, p_profile_id: owner.id, p_layout: preparedForB.copy });
  const resumedB = await src.resumeCatalogueCopy(owner.client, service, owner.id, interrupted3.id);
  const savedB = resumedB.ok ? (await service.from("project_plan_request_variants").select("layout").eq("id", resumedB.variantId).single()).data : null;
  record("Échec entre attestation et enregistrement : fichier déjà attesté repris tel quel", resumedB.ok && savedB.layout.savedAt === attestedAt, resumedB.message);

  const interrupted4 = await interrupt(vThird.id);
  const byOther = await src.resumeCatalogueCopy(contractorB.client, service, contractorB.id, interrupted4.id);
  record("Reprise par un autre lecteur de la demande : refusée", !byOther.ok && /Seule la personne qui a lancé cette copie/.test(byOther.message), byOther.message);
  const byOutsider = await src.resumeCatalogueCopy(outsider.client, service, outsider.id, interrupted4.id);
  record("Reprise hors chantier : refusée sans rien révéler", !byOutsider.ok && byOutsider.message === "Demande introuvable ou non autorisée.", byOutsider.message);
  const legacyResume = await src.resumeCatalogueCopy(owner.client, service, owner.id, legacy.id);
  record("Demande sans origine : rien à terminer, message clair", !legacyResume.ok && /ne provient pas d'une copie/.test(legacyResume.message), legacyResume.message);
  const { data: op4Row } = await service.from("project_plan_requests").select("catalog_copy_operation_uuid").eq("id", interrupted4.id).single();
  const otherOp = randomUUID();
  await service.rpc("attest_plan_request_variant_layout", { p_operation_uuid: otherOp, p_request_id: interrupted4.id, p_profile_id: owner.id, p_layout: preparedForB.copy });
  await owner.client.rpc("save_plan_request_variant", { p_request_id: interrupted4.id, p_parent_variant_id: null, p_operation_uuid: otherOp });
  const withOther = await src.resumeCatalogueCopy(owner.client, service, owner.id, interrupted4.id);
  record("Demande déjà munie d'une autre variante : reprise refusée, expliquée", !withOther.ok && /déjà d'autres variantes/.test(withOther.message) && op4Row.catalog_copy_operation_uuid !== otherOp, withOther.message);
  const interrupted5 = await interrupt(vThird.id);

  // --- 9. Ancien parcours et droits revérifiés à l'écriture -----------------
  record("Ancien parcours : create_plan_request fonctionne, sans origine", !!legacy?.id && legacy.source_catalog_item_version_id === null);
  const op5 = randomUUID();
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", projectA).eq("profile_id", owner.id);
  const revoked = await src.createCatalogueCopy(owner.client, service, owner.id, { ...base, versionId: vSecond.id, params: destParams, savedAt, operationUuid: op5 });
  record("Accès au chantier retiré : création refusée", !revoked.ok, revoked.message);
  const { error: revokedDirect } = await direct(owner.client, projectA, vSecond.id, op5);
  record("Accès au chantier retiré : appel direct refusé en base", revokedDirect?.message === "not_authorized", revokedDirect?.message);
  const { error: revokedReplay } = await direct(owner.client, projectA, vPublished.id, op);
  record("Accès retiré : même la reprise d'une opération réussie est refusée", revokedReplay?.message === "not_authorized", revokedReplay?.message);
  const resumeRevoked = await src.resumeCatalogueCopy(owner.client, service, owner.id, interrupted5.id);
  record("Accès retiré : reprise d'une copie interrompue refusée, aucune variante", !resumeRevoked.ok && (await count("project_plan_request_variants", "request_id", interrupted5.id)) === 0, resumeRevoked.message);
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
