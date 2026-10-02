// Test d'intégration LOCAL uniquement (aucune connexion cloud) pour le Lot 1
// de PREPARATION_INTEGRATION_METIER.md : le pont générateur 2D -> dépôt de
// plan de chantier réutilise depositProjectPlanAction (chantiers/[id]/plans/
// actions.ts) SANS AUCUNE modification de cette action ni de ses RPC — ce
// script ne teste donc PAS une nouvelle autorisation (il n'y en a pas), il
// vérifie que les deux garde-fous serveur dont ce pont dépend tiennent
// EXACTEMENT comme avant pour les deux cas non couverts par
// scripts/test-project-plans.mjs (B063) : appel sans session, et appel
// authentifié avec un rôle autorisé mais visant un chantier où l'appelant
// n'a aucune adhésion active. Les cas déjà couverts par B063 (dépôt réussi
// CONTRACTOR/OWNER_PRIMARY, refus CO_OWNER) ne sont PAS reproduits ici —
// rejoués tels quels via `node scripts/test-project-plans.mjs`.
//
// Usage : node scripts/test-prototype-plans-bridge.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

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
  const email = `lot1-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, client };
}

async function createDraftProject(ownerClient, role, label) {
  const { data, error } = await ownerClient.rpc("create_draft_project", { p_name: `Lot1 — ${label}`, p_country: "ML", p_role: role });
  if (error) throw new Error(`create_draft_project(${label}): ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { projectId: row.project_id };
}

async function fakePrepareCall(callerClient, projectId) {
  return callerClient.rpc("prepare_project_plan_upload", {
    p_operation_uuid: randomUUID(),
    p_project_id: projectId,
    p_expected_checksum: "0".repeat(64),
    p_expected_size_bytes: 1234,
    p_expected_mime_type: "image/png",
  });
}

async function main() {
  // Chantier cible : un CONTRACTOR habilité y dépose normalement (déjà
  // prouvé par B063) — ce script vérifie seulement les DEUX refus que le
  // pont (Lot 1) doit garantir et que B063 ne couvre pas encore : absence de
  // session, et rôle autorisé mais chantier étranger.
  const contractor = await createTestUser("contractor");
  const { projectId: targetProjectId } = await createDraftProject(contractor.client, "CONTRACTOR", "cible");

  // 1) Sans session (anon key seule, jamais signInWithPassword).
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { error: noSessionErr } = await fakePrepareCall(anon, targetProjectId);
  record(
    "Rejet serveur — aucune session (le paramètre retour ne constitue jamais une autorisation)",
    !!noSessionErr,
    noSessionErr?.message
  );

  // 2) Rôle autorisé (CONTRACTOR) mais chantier où l'appelant n'a AUCUNE
  // adhésion active — un second chantier distinct, jamais celui ciblé.
  const otherContractor = await createTestUser("contractor-autre-chantier");
  await createDraftProject(otherContractor.client, "CONTRACTOR", "autre");
  const { error: wrongProjectErr } = await fakePrepareCall(otherContractor.client, targetProjectId);
  record(
    "Rejet serveur — rôle autorisé mais chantier non autorisé (aucune adhésion active sur la cible)",
    wrongProjectErr?.message === "not_authorized",
    wrongProjectErr?.message
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
