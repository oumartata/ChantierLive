// Test d'intégration LOCAL uniquement (aucune connexion cloud) pour M034 :
// validation à l'écriture des variantes de demandes de plan. Données de
// test jetables (utilisateurs/chantiers créés par ce script), jamais réelles.
//
// Le chemin « action serveur » est rejoué avec le code RÉEL de validation
// (variantValidation.ts compilé depuis le dépôt) puis les mêmes appels que
// savePlanRequestVariantAction : attestation par le service_role avec le
// profil réellement connecté, enregistrement avec la session utilisateur.
//
// Usage : node --env-file=.env.local scripts/test-plan-request-variant-attestation.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
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

function isLocalSupabaseUrl(candidate) {
  try {
    const { hostname } = new URL(candidate);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}
if (!isLocalSupabaseUrl(SUPABASE_URL)) {
  console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`);
  process.exit(1);
}
if (!SERVICE_KEY || !ANON_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY manquants.");
  process.exit(1);
}

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function newSession(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn: ${error.message}`);
  return client;
}
async function createTestUser(label) {
  const email = `m034-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  // Une seconde session du même utilisateur (deux onglets) pour la course.
  return { id: data.user.id, client: await newSession(email, password), secondSession: () => newSession(email, password) };
}
async function createDraftProject(client, label) {
  const { data, error } = await client.rpc("create_draft_project", { p_name: `M034 — ${label}`, p_country: "ML", p_role: "CONTRACTOR" });
  if (error) throw new Error(`create_draft_project: ${error.message}`);
  return (Array.isArray(data) ? data[0] : data).project_id;
}
async function createRequest(client, projectId) {
  const { data, error } = await client.rpc("create_plan_request", { p_project_id: projectId, p_generation_params: { terrainWidth: 20, terrainDepth: 14 } });
  if (error) throw new Error(`create_plan_request: ${error.message}`);
  return data.id;
}
async function variantCount(requestId) {
  const { count } = await service.from("project_plan_request_variants").select("id", { count: "exact", head: true }).eq("request_id", requestId);
  return count;
}
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (x, y) => JSON.stringify(canon(x)) === JSON.stringify(canon(y));

const tmpDir = mkdtempSync(join(tmpdir(), "m034-variantes-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const sources = ["geometry.ts", "projectFile.ts", "variantValidation.ts"].map((f) => `"${join("src", "app", "prototype-plans", f)}"`).join(" ");
  const compile = spawnSync(`"${tscBin}" ${sources} --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
  const vv = await import(pathToFileURL(join(tmpDir, "variantValidation.js")).href);

  const v4 = JSON.parse(readFileSync(join(repoRoot, "scripts", "fixtures", "plans-c2-resolu.projet.json"), "utf8"));
  const v5 = JSON.parse(readFileSync(join(repoRoot, "scripts", "fixtures", "plans-f2-v5-autorisations.projet.json"), "utf8"));
  const badDoor = JSON.parse(JSON.stringify(v4));
  badDoor.layout.doors[0].roomIndex = 999;
  const badAllow = JSON.parse(JSON.stringify(v5));
  badAllow.layout.dimensionAllowances[0].minW = 9;

  // Même enchaînement que savePlanRequestVariantAction.
  async function saveViaAction(user, requestId, parentVariantId, layoutRaw, operationUuid = randomUUID()) {
    const validated = vv.validateVariantLayoutForSave(layoutRaw);
    if (!validated.ok) return { stage: "validation", message: validated.message, operationUuid };
    const { error: attestErr } = await service.rpc("attest_plan_request_variant_layout", {
      p_operation_uuid: operationUuid, p_request_id: requestId, p_profile_id: user.id, p_layout: validated.file,
    });
    if (attestErr) return { stage: "attestation", message: attestErr.message, operationUuid };
    const { data, error } = await user.client.rpc("save_plan_request_variant", {
      p_request_id: requestId, p_parent_variant_id: parentVariantId, p_operation_uuid: operationUuid,
    });
    if (error) return { stage: "enregistrement", message: error.message, operationUuid };
    return { stage: "ok", variant: data, file: validated.file, operationUuid };
  }
  async function attestOnly(user, requestId, file, operationUuid = randomUUID()) {
    const { error } = await service.rpc("attest_plan_request_variant_layout", {
      p_operation_uuid: operationUuid, p_request_id: requestId, p_profile_id: user.id, p_layout: file,
    });
    if (error) throw new Error(`attest: ${error.message}`);
    return operationUuid;
  }

  // ===========================================================================
  // 1. Validation (code réel) — invalides refusés, témoins acceptés
  // ===========================================================================
  const contractor = await createTestUser("contractor");
  const projectId = await createDraftProject(contractor.client, "chantier");
  const requestA = await createRequest(contractor.client, projectId);

  const invalidCases = [
    ["JSON qui n'est pas un fichier de projet", JSON.stringify({ bonjour: "pas un plan", n: 1 }), /Fichier invalide/],
    ["Référence structurelle invalide (porte vers la pièce 999)", JSON.stringify(badDoor), /Fichier de projet invalide : Géométrie invalide/],
    ["Autorisations F2 invalides (borne > référence)", JSON.stringify(badAllow), /Enregistrement refusé : les autorisations d'adaptation de ce plan sont invalides/],
    ["Texte non JSON", "{pas du json", /illisible/],
  ];
  for (const [name, raw, expected] of invalidCases) {
    const before = await variantCount(requestA);
    const r = await saveViaAction(contractor, requestA, null, raw);
    const after = await variantCount(requestA);
    const { count: attests } = await service.from("project_plan_request_variant_attestations").select("operation_uuid", { count: "exact", head: true }).eq("operation_uuid", r.operationUuid);
    record(`Refusé à la validation — ${name} ; aucune attestation, aucune variante`, r.stage === "validation" && expected.test(r.message) && before === after && attests === 0, r.message);
  }
  const allowMsg = vv.validateVariantLayoutForSave(JSON.stringify(badAllow));
  record("Refus des autorisations F2 : motif précis, sans retrait silencieux", !allowMsg.ok && /minW|borne|référence|largeur/i.test(allowMsg.message) && !/Le plan lui-même est importé/.test(allowMsg.message), allowMsg.message);
  const v4WithAllow = JSON.parse(JSON.stringify(v4));
  v4WithAllow.layout.dimensionAllowances = v5.layout.dimensionAllowances;
  const v4AllowR = vv.validateVariantLayoutForSave(JSON.stringify(v4WithAllow));
  record("Fichier v4 portant des autorisations : refus explicite (jamais ignorées en silence)", !v4AllowR.ok && /antérieur à la version 5/.test(v4AllowR.message), v4AllowR.message);

  const okV4 = await saveViaAction(contractor, requestA, null, JSON.stringify(v4));
  record("Témoin valide v4 accepté — variante 1", okV4.stage === "ok" && okV4.variant.variant_number === 1 && okV4.variant.operation_uuid === okV4.operationUuid, okV4.message);
  const okV5 = await saveViaAction(contractor, requestA, okV4.variant?.id ?? null, JSON.stringify(v5));
  record("Témoin valide v5 (4 autorisations) accepté — variante 2, parent = 1", okV5.stage === "ok" && okV5.variant.variant_number === 2 && okV5.variant.parent_variant_id === okV4.variant.id, okV5.message);
  const { data: rereadV5 } = await contractor.client.rpc("get_plan_request_variant", { p_variant_id: okV5.variant.id });
  record(
    "Variante v5 relue = fichier effectivement validé (v5, 4 autorisations conservées)",
    same(rereadV5?.layout, okV5.file) && rereadV5.layout.version === 5 && rereadV5.layout.layout.dimensionAllowances.length === 4
  );
  const { data: rereadV4 } = await contractor.client.rpc("get_plan_request_variant", { p_variant_id: okV4.variant.id });
  record("Variante v4 relue = fichier validé (identique à la source)", same(rereadV4?.layout, v4) && same(okV4.file, v4));

  // ===========================================================================
  // 2. Appels directs — sans attestation, ancienne signature, attestation
  // ===========================================================================
  const beforeDirect = await variantCount(requestA);
  const { error: noAttestErr } = await contractor.client.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_operation_uuid: randomUUID() });
  record("Enregistrement direct sans attestation refusé", noAttestErr?.message === "layout_not_attested", noAttestErr?.message);
  const { error: nullOpErr } = await contractor.client.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_operation_uuid: null });
  record("Enregistrement direct sans opération refusé", nullOpErr?.message === "layout_not_attested", nullOpErr?.message);
  const { error: oldSigErr } = await contractor.client.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_layout: { bonjour: 1 } });
  record("Ancienne signature (plan libre en argument) introuvable", oldSigErr?.code === "PGRST202", `${oldSigErr?.code} ${oldSigErr?.message}`);
  const { error: mixedSigErr } = await contractor.client.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_operation_uuid: randomUUID(), p_layout: { bonjour: 1 } });
  record("Aucune surcharge acceptant un plan libre avec une opération", mixedSigErr?.code === "PGRST202", `${mixedSigErr?.code} ${mixedSigErr?.message}`);
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  for (const [who, client] of [["authenticated", contractor.client], ["anon", anon]]) {
    const { error: attestErr } = await client.rpc("attest_plan_request_variant_layout", { p_operation_uuid: randomUUID(), p_request_id: requestA, p_profile_id: contractor.id, p_layout: v4 });
    record(`attest_plan_request_variant_layout refusée à ${who}`, attestErr?.code === "42501", `${attestErr?.code} ${attestErr?.message}`);
    const { data: readRows, error: readErr } = await client.from("project_plan_request_variant_attestations").select("operation_uuid").limit(1);
    record(`Table des attestations illisible par ${who}`, readErr?.code === "42501" && !readRows, `${readErr?.code} ${readErr?.message}`);
    const { error: insErr } = await client.from("project_plan_request_variant_attestations").insert({ operation_uuid: randomUUID(), request_id: requestA, profile_id: contractor.id, layout: v4 });
    record(`Table des attestations non modifiable par ${who}`, insErr?.code === "42501", `${insErr?.code} ${insErr?.message}`);
  }
  const { error: saveAnonErr } = await anon.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_operation_uuid: okV4.operationUuid });
  record("Enregistrement refusé sans session", !!saveAnonErr, saveAnonErr?.message);
  record("Aucune variante créée par les appels directs", (await variantCount(requestA)) === beforeDirect);

  // ===========================================================================
  // 3. Substitution — profil, demande, contenu
  // ===========================================================================
  const owner = await createTestUser("owner");
  const { error: ownerErr } = await service.from("project_memberships").insert({ project_id: projectId, profile_id: owner.id, role: "OWNER", owner_profile: "PRIMARY" });
  if (ownerErr) throw new Error(`adhésion du propriétaire: ${ownerErr.message}`);
  const opContractor = await attestOnly(contractor, requestA, v4);
  const { error: otherUserErr } = await owner.client.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_operation_uuid: opContractor });
  record("Attestation d'un autre utilisateur (même chantier, droits suffisants) refusée", otherUserErr?.message === "not_authorized", otherUserErr?.message);
  const requestB = await createRequest(contractor.client, projectId);
  const { error: otherReqErr } = await contractor.client.rpc("save_plan_request_variant", { p_request_id: requestB, p_parent_variant_id: null, p_operation_uuid: opContractor });
  record("Attestation d'une autre demande refusée", otherReqErr?.message === "not_authorized", otherReqErr?.message);
  const { error: diffContentErr } = await service.rpc("attest_plan_request_variant_layout", { p_operation_uuid: opContractor, p_request_id: requestA, p_profile_id: contractor.id, p_layout: v5 });
  record("Même opération, contenu différent : refusé", diffContentErr?.message === "attestation_conflict", diffContentErr?.message);
  const { error: diffProfileErr } = await service.rpc("attest_plan_request_variant_layout", { p_operation_uuid: opContractor, p_request_id: requestA, p_profile_id: owner.id, p_layout: v4 });
  record("Même opération, profil différent : refusé", diffProfileErr?.message === "attestation_conflict", diffProfileErr?.message);
  const { error: diffReqErr } = await service.rpc("attest_plan_request_variant_layout", { p_operation_uuid: opContractor, p_request_id: requestB, p_profile_id: contractor.id, p_layout: v4 });
  record("Même opération, demande différente : refusé", diffReqErr?.message === "attestation_conflict", diffReqErr?.message);
  const { data: attRow } = await service.from("project_plan_request_variant_attestations").select("profile_id, request_id, layout, consumed_at").eq("operation_uuid", opContractor).single();
  record("Attestation inchangée après les tentatives de substitution", attRow.profile_id === contractor.id && attRow.request_id === requestA && same(attRow.layout, v4) && attRow.consumed_at === null);

  // ===========================================================================
  // 4. Concurrence et reprises
  // ===========================================================================
  const beforeRace = await variantCount(requestA);
  const tab2 = await contractor.secondSession();
  const opRace = await attestOnly(contractor, requestA, v5);
  const [r1, r2] = await Promise.all([
    contractor.client.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_operation_uuid: opRace }),
    tab2.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_operation_uuid: opRace }),
  ]);
  record(
    "Deux finalisations simultanées de la même opération : une seule variante, même résultat",
    !r1.error && !r2.error && r1.data.id === r2.data.id && (await variantCount(requestA)) === beforeRace + 1,
    r1.error?.message ?? r2.error?.message
  );

  // Échec réel entre attestation et enregistrement (réponse jamais reçue,
  // enregistrement jamais exécuté) : la reprise complète (même fichier, même
  // opération) aboutit, une seule variante.
  const rawRetry = JSON.stringify(v4);
  const opRetry = randomUUID();
  const firstTry = vv.validateVariantLayoutForSave(rawRetry);
  await attestOnly(contractor, requestA, firstTry.file, opRetry);
  const beforeRetry = await variantCount(requestA);
  const { data: pendingAtt } = await service.from("project_plan_request_variant_attestations").select("consumed_at").eq("operation_uuid", opRetry).single();
  record("Échec réel simulé : attestation enregistrée, aucune variante créée", pendingAtt.consumed_at === null && (await variantCount(requestA)) === beforeRetry);
  const retried = await saveViaAction(contractor, requestA, null, rawRetry, opRetry);
  record("Reprise après échec : aboutit, une seule variante", retried.stage === "ok" && (await variantCount(requestA)) === beforeRetry + 1, retried.message);
  // Réponse réseau perdue APRÈS succès : la reprise renvoie la même variante.
  const replay = await saveViaAction(contractor, requestA, null, rawRetry, opRetry);
  record("Reprise après réponse perdue : même variante, aucun doublon", replay.stage === "ok" && replay.variant.id === retried.variant.id && (await variantCount(requestA)) === beforeRetry + 1, replay.message);
  const { error: replayParentErr } = await contractor.client.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: okV4.variant.id, p_operation_uuid: opRetry });
  record("Reprise avec un parent différent : refusée", replayParentErr?.message === "attestation_conflict", replayParentErr?.message);

  // ===========================================================================
  // 5. Droits revérifiés à la finalisation
  // ===========================================================================
  // Le propriétaire principal (droits d'enregistrement) perd son accès.
  const member = owner;
  const { data: memberRow, error: memberErr } = await service.from("project_memberships").select("id").eq("project_id", projectId).eq("profile_id", owner.id).is("revoked_at", null).single();
  if (memberErr) throw new Error(`adhésion du propriétaire: ${memberErr.message}`);
  const opMember = await attestOnly(member, requestA, v4);
  const opMemberDone = (await saveViaAction(member, requestA, null, JSON.stringify(v4))).operationUuid;
  const opMemberCheck = await service.from("project_plan_request_variants").select("id", { count: "exact", head: true }).eq("operation_uuid", opMemberDone);
  record("Propriétaire principal : enregistrement accepté tant que l'accès est actif", opMemberCheck.count === 1);
  const { error: revokeErr } = await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("id", memberRow.id);
  if (revokeErr) throw new Error(`retrait d'accès de test: ${revokeErr.message}`);
  const beforeRevoked = await variantCount(requestA);
  const { error: revokedErr } = await member.client.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_operation_uuid: opMember });
  record("Accès retiré entre attestation et enregistrement : refusé", revokedErr?.message === "not_authorized" && (await variantCount(requestA)) === beforeRevoked, revokedErr?.message);
  const { error: revokedReplayErr } = await member.client.rpc("save_plan_request_variant", { p_request_id: requestA, p_parent_variant_id: null, p_operation_uuid: opMemberDone });
  record("Accès retiré : même la reprise d'une opération réussie est refusée", revokedReplayErr?.message === "not_authorized", revokedReplayErr?.message);

  const requestC = await createRequest(contractor.client, projectId);
  const opBeforeClose = await attestOnly(contractor, requestC, v4);
  const doneBeforeClose = await saveViaAction(contractor, requestC, null, JSON.stringify(v5));
  const { error: closeErr } = await service.from("project_plan_requests").update({ status: "CANCELLED" }).eq("id", requestC);
  if (closeErr) throw new Error(`fermeture de la demande de test: ${closeErr.message}`);
  const beforeClosed = await variantCount(requestC);
  const { error: closedErr } = await contractor.client.rpc("save_plan_request_variant", { p_request_id: requestC, p_parent_variant_id: null, p_operation_uuid: opBeforeClose });
  record("Demande fermée entre attestation et enregistrement : refusé", closedErr?.message === "request_not_open" && (await variantCount(requestC)) === beforeClosed, closedErr?.message);
  const { data: closedReplay, error: closedReplayErr } = await contractor.client.rpc("save_plan_request_variant", { p_request_id: requestC, p_parent_variant_id: null, p_operation_uuid: doneBeforeClose.operationUuid });
  record("Demande fermée : la reprise d'une opération déjà réussie renvoie la même variante, rien d'écrit", !closedReplayErr && closedReplay?.id === doneBeforeClose.variant.id && (await variantCount(requestC)) === beforeClosed, closedReplayErr?.message);

  // Immuabilité du lien opération.
  const { error: opMutErr } = await service.from("project_plan_request_variants").update({ operation_uuid: randomUUID() }).eq("id", okV4.variant.id);
  record("operation_uuid d'une variante immuable", opMutErr?.message === "project_plan_request_variant_immutable", opMutErr?.message);
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
