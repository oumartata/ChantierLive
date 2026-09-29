// Fixtures de démonstration ChantierLive — LOCAL UNIQUEMENT (Docker Supabase).
// Ne touche jamais aux chantiers "Famille Touré". Idempotent : identifie ses
// propres comptes/chantier par préfixe "demo-" / nom exact et ne recrée rien
// si déjà présent (rejeu sans doublon). N'utilise que des RPC réelles, sans
// désactiver aucune protection ni contourner aucune validation métier.
//
// Usage :
//   node scripts/demo_seed_chantierlive.mjs                 # scénario par défaut, prêt pour samedi
//   node scripts/demo_seed_chantierlive.mjs repetition-1     # nouveau scénario DISTINCT et séparé,
//                                                             # pour répéter (confirmer/démarrer)
//                                                             # sans jamais toucher au scénario samedi
//
// Chaque scénario est un chantier distinct, jamais supprimé ni réinitialisé
// par ce script — un rejeu du MÊME scénario ne crée jamais de doublon, mais
// n'annule ni ne "défait" non plus ce qui a déjà été confirmé/autorisé (les
// actions d'avance et de démarrage sont volontairement irréversibles).
//
// Identifiants écrits dans un fichier LOCAL hors Git, un par scénario
// (scripts/.demo-credentials[.scenario].json — voir .gitignore).

import { createClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const { hostname } = new URL(SUPABASE_URL);
if (hostname !== "127.0.0.1" && hostname !== "localhost") {
  console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`);
  process.exit(1);
}
if (!SERVICE_KEY || !ANON_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY manquants.");
  process.exit(1);
}
const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Scénario par défaut ("") = le chantier canonique déjà utilisé pour samedi,
// retrouvé par son nom exact existant — ne jamais changer ce nom par défaut
// sous peine de perdre la correspondance avec le chantier déjà créé.
const SCENARIO = (process.argv[2] ?? "").trim();
const SCENARIO_SLUG = SCENARIO.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
const PROJECT_NAME = SCENARIO ? `Démo — Maison Bamako — ${SCENARIO}` : "Démo — Maison Bamako";
const CREDENTIALS_FILE = new URL(SCENARIO_SLUG ? `./.demo-credentials.${SCENARIO_SLUG}.json` : "./.demo-credentials.json", import.meta.url);
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function must(res, what) {
  const r = await res;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}

// ---- Comptes dédiés : réutilisés si déjà créés lors d'un rejeu précédent ----
async function getOrCreateUser(label, email) {
  const { data: list } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list?.users?.find((u) => u.email === email);
  // Mot de passe STABLE (pas aléatoire) : ces 3 comptes sont partagés entre
  // tous les scénarios (chacun n'étant qu'un chantier distinct sous les
  // mêmes comptes). Un mot de passe régénéré à chaque exécution invaliderait
  // silencieusement le fichier d'identifiants déjà écrit pour un AUTRE
  // scénario utilisant le même compte — comptes 100% locaux/fictifs, sans
  // enjeu de sécurité au-delà de la base de développement locale.
  const password = `Demo-${label}-ChantierLive-2026!`;
  let id;
  if (existing) {
    id = existing.id;
    await service.auth.admin.updateUserById(id, { password });
  } else {
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`createUser(${label}): ${error.message}`);
    id = data.user.id;
  }
  await service.from("profile_identifiers").update({ verified_at_server: new Date().toISOString() }).eq("profile_id", id);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id, email, password, client };
}

async function depositPlan(client, projectId, label) {
  const bytes = Buffer.from(`%PDF-1.4 ${label}`);
  const op = randomUUID();
  const prep = await must(client.rpc("prepare_project_plan_upload", { p_operation_uuid: op, p_project_id: projectId, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "prepare_project_plan_upload");
  const claim = await must(client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "claim_upload_attempt");
  const upload = await service.storage.from("project-plans").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false });
  if (upload.error && !/already exists|Duplicate/i.test(upload.error.message)) throw new Error(`storage upload: ${upload.error.message}`);
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "attest_storage_verified");
  return must(client.rpc("finalize_project_plan_upload", { p_operation_uuid: op }), "finalize_project_plan_upload");
}

const project = async (id) => must(service.from("projects").select("revision, status, published_plan_version_id").eq("id", id).single(), "project");
const line = (label, quantity, price, unit = "u") => ({ label, unit, quantity, unit_price_fcfa: price });

async function main() {
  console.log(`Cible : ${SUPABASE_URL}`);

  const contractor = await getOrCreateUser("entreprise", "demo-entreprise@chantierlive.test");
  const owner = await getOrCreateUser("proprietaire", "demo-proprietaire@chantierlive.test");
  const engineer = await getOrCreateUser("ingenieur", "demo-ingenieur@chantierlive.test");

  // ---- Chantier : réutilisé si déjà créé par un rejeu précédent (identifié
  // par nom exact + profil créateur, jamais par un simple "premier trouvé") ----
  // Chaque étape ci-dessous est vérifiée indépendamment avant d'agir : un
  // rejeu après un échec partiel ne recrée jamais ce qui existe déjà et
  // complète seulement ce qui manque (pas un simple "tout ou rien" au niveau
  // du chantier).
  let projectId;
  let organizationId;
  const { data: existingMembership } = await service
    .from("project_memberships")
    .select("project_id, projects!inner(name, organization_id)")
    .eq("profile_id", contractor.id)
    .eq("projects.name", PROJECT_NAME)
    .is("revoked_at", null)
    .maybeSingle();

  if (existingMembership) {
    projectId = existingMembership.project_id;
    organizationId = existingMembership.projects.organization_id;
    console.log(`Chantier démo déjà présent (${projectId}) — réutilisé, aucun doublon créé.`);
  } else {
    const created = await must(
      contractor.client.rpc("create_draft_project", { p_name: PROJECT_NAME, p_country: "ML", p_role: "CONTRACTOR" }),
      "create_draft_project"
    );
    const row = Array.isArray(created) ? created[0] : created;
    projectId = row.project_id;
    organizationId = row.organization_id;
    console.log(`Chantier démo créé (${projectId}), organisation ${organizationId}.`);
  }

  // ---- Propriétaire : invitation RÉELLE (create_invitation + accept_invitation) ----
  const { data: ownerMembership } = await service
    .from("project_memberships")
    .select("id")
    .eq("project_id", projectId)
    .eq("profile_id", owner.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (ownerMembership) {
    console.log("Propriétaire déjà membre — invitation non renvoyée.");
  } else {
    const invitation = await must(
      contractor.client.rpc("create_invitation", { p_project_id: projectId, p_role: "OWNER", p_target_kind: "EMAIL", p_target_value_raw: owner.email }),
      "create_invitation"
    );
    await must(owner.client.rpc("accept_invitation", { p_token: invitation.token }), "accept_invitation");
    console.log("Propriétaire ajouté par invitation acceptée.");
  }

  // ---- Ingénieur : désignation organisationnelle (pas de rôle CONTRACTOR/OWNER requis pour lui) ----
  const { data: existingDesignations } = await contractor.client.rpc("list_organization_engineers", { p_organization_id: organizationId });
  let designationId = existingDesignations?.find((d) => d.engineer_profile_id === engineer.id && !d.revoked_at)?.id;
  if (!designationId) {
    const designation = await must(
      contractor.client.rpc("designate_plan_engineer", { p_organization_id: organizationId, p_identifier_kind: "EMAIL", p_identifier_value: engineer.email }),
      "designate_plan_engineer"
    );
    designationId = designation.id;
    console.log("Ingénieur désigné.");
  } else {
    console.log("Ingénieur déjà désigné — réutilisé.");
  }

  // ---- Plan : déposé, retenu, validé, publié (chaîne réelle complète) ----
  const projectRow = await project(projectId);
  if (projectRow.published_plan_version_id) {
    console.log("Plan déjà publié — chaîne non rejouée.");
  } else {
    // Déposé PAR LE PROPRIÉTAIRE (comme le précédent établi
    // scripts/test-work-start.mjs) : la lecture d'un dépôt CONTRACTOR par
    // l'OWNER exige un partage explicite (project_plan_version_shares) ; en
    // déposant lui-même, le propriétaire retient sa propre version sans
    // étape de partage supplémentaire.
    const plan = await depositPlan(owner.client, projectId, "Plan Maison Bamako");
    await must(owner.client.rpc("set_retained_project_plan_version", { p_project_id: projectId, p_version_id: plan.id, p_expected_revision: (await project(projectId)).revision }), "set_retained_project_plan_version");
    const validation = await must(contractor.client.rpc("submit_plan_version_for_validation", { p_version_id: plan.id, p_designation_id: designationId }), "submit_plan_version_for_validation");
    await must(engineer.client.rpc("decide_plan_validation", { p_validation_id: validation.id, p_decision: "VALIDATED", p_note: "Plan conforme, démonstration." }), "decide_plan_validation");
    await must(contractor.client.rpc("publish_project_plan_version", { p_project_id: projectId, p_version_id: plan.id, p_expected_revision: (await project(projectId)).revision }), "publish_project_plan_version");
    console.log("Plan déposé, retenu, validé et publié.");
  }

  // ---- Devis : ACCEPTÉ en prérequis (nécessaire techniquement) ----
  // set_advance_requirement exige un devis déjà accepté (contract_amount_internal
  // non nul) : la chaîne avance ne peut être préparée en amont que si le
  // devis l'est aussi. "Acceptation du devis" est donc présentée en direct
  // comme consultation du devis déjà accepté, pas comme un clic de décision
  // — voir le rapport pour l'arbitrage et l'alternative possible.
  const { data: existingQuote } = await service.from("quotes").select("accepted_version_id, revision").eq("project_id", projectId).maybeSingle();
  if (existingQuote?.accepted_version_id) {
    console.log("Devis déjà accepté — non rejoué.");
  } else {
    const quote = await must(
      contractor.client.rpc("create_quote_estimate", { p_project_id: projectId, p_lines: [line("Gros œuvre et fondations", "1", "18000000", "forfait"), line("Second œuvre", "1", "7000000", "forfait")], p_expected_revision: existingQuote?.revision ?? 0 }),
      "create_quote_estimate"
    );
    const quoteRevision = async () => (await service.from("quotes").select("revision").eq("project_id", projectId).single()).data.revision;
    await must(contractor.client.rpc("propose_quote_version", { p_version_id: quote.id, p_expected_revision: await quoteRevision() }), "propose_quote_version");
    await must(owner.client.rpc("decide_quote_version", { p_version_id: quote.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: await quoteRevision() }), "decide_quote_version");
    console.log("Devis proposé et accepté (25 000 000 FCFA).");
  }

  // ---- Avance : EXIGÉE et DÉCLARÉE en prérequis — la CONFIRMATION reste l'action live ----
  const advanceLedgerRevision = async () => (await service.from("advance_ledgers").select("revision").eq("project_id", projectId).maybeSingle()).data?.revision ?? 0;
  const status = await must(contractor.client.rpc("get_advance_status", { p_project_id: projectId }), "get_advance_status");
  const statusRow = Array.isArray(status) ? status[0] : status;
  if (!statusRow?.has_requirement) {
    await must(
      contractor.client.rpc("set_advance_requirement", { p_operation_uuid: randomUUID(), p_project_id: projectId, p_amount_fcfa: "5000000", p_expected_revision: await advanceLedgerRevision() }),
      "set_advance_requirement"
    );
    console.log("Avance de 5 000 000 FCFA exigée.");
  } else {
    console.log("Avance déjà exigée — non rejouée.");
  }

  const payments = await must(owner.client.rpc("list_advance_payments", { p_project_id: projectId }), "list_advance_payments");
  const hasActivePayment = (payments ?? []).some((p) => p.status !== "CANCELLED");
  if (!hasActivePayment) {
    const declared = await must(
      owner.client.rpc("declare_advance_payment", {
        p_operation_uuid: randomUUID(), p_project_id: projectId, p_amount_fcfa: "5000000",
        p_payment_date: new Date().toISOString().slice(0, 10), p_mode: "ORANGE_MONEY", p_reference: "DEMO-OM-0001",
        p_disclaimer_ack: true, p_expected_revision: await advanceLedgerRevision(),
      }),
      "declare_advance_payment"
    );
    console.log(`Versement de 5 000 000 FCFA déclaré (id ${declared.advance_id}) — confirmation laissée en direct.`);
  } else {
    console.log("Versement déjà déclaré — non rejoué.");
  }

  const credentials = {
    generated_at: new Date().toISOString(),
    project_id: projectId,
    project_name: PROJECT_NAME,
    accounts: {
      entreprise: { email: contractor.email, password: contractor.password },
      proprietaire: { email: owner.email, password: owner.password },
      ingenieur: { email: engineer.email, password: engineer.password },
    },
  };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
  console.log(`\nIdentifiants écrits (local, hors Git) : ${CREDENTIALS_FILE.pathname.replace(/^\//, "")}`);
  console.log(`Chantier : ${projectId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
