// Test d'intégration LOCAL uniquement (aucune connexion cloud) pour B062
// (M023, plan_engineer_designations). Couvre exactement le périmètre revu
// avec le fondateur : désignation/révocation par le seul propriétaire
// COURANT de l'organisation, isolation entre organisations, résolution
// d'identifiant SANS annuaire (anti-énumération), concurrence, historique
// jamais perdu, aucun accès chantier/financier implicite. Ne construit ni
// validation de plan ni catalogue (hors périmètre B062). Fixtures isolées
// (organisations/utilisateurs dédiés), pas de suppression de données
// existantes. Usage : node scripts/test-plan-engineer-designations.mjs
//
// Nécessite l'instance Supabase locale démarrée (npx supabase status) et
// SUPABASE_SERVICE_ROLE_KEY dans l'environnement (voir .env.local, jamais
// affiché ni committé).

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Garde-fou (revue ciblée) : refuse toute destination NON locale AVANT toute
// création de client — jamais une connexion accidentelle à un projet cloud
// réel. Pure fonction, testée ci-dessous SANS connexion réseau (aucun appel
// réseau tant que main() n'a pas démarré).
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

// Auto-test du garde-fou, AVANT toute création de client (aucun appel réseau
// impliqué : new URL() est une analyse purement locale de la chaîne).
record("Garde-fou réseau — une URL cloud réelle est refusée", isLocalSupabaseUrl("https://xyzcompany.supabase.co") === false);
record("Garde-fou réseau — une URL distante arbitraire est refusée", isLocalSupabaseUrl("https://evil.example.com") === false);
record("Garde-fou réseau — une chaîne invalide est refusée (jamais une exception non gérée)", isLocalSupabaseUrl("not-a-url") === false);
record("Garde-fou réseau — la destination réellement configurée est locale", isLocalSupabaseUrl(SUPABASE_URL) === true, SUPABASE_URL);

if (!isLocalSupabaseUrl(SUPABASE_URL)) {
  console.error(`Destination NON locale refusée : ${SUPABASE_URL}. Ce script ne s'exécute que contre une instance Supabase locale (127.0.0.1/localhost) — aucun client n'est créé.`);
  process.exitCode = 1;
  process.exit(1);
}

if (!SERVICE_KEY || !ANON_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY manquants dans l'environnement.");
  process.exit(1);
}

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function createTestUser(label) {
  const email = `b062-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  // CORRIGÉ (revue ciblée) : email_confirm:true déclenche déjà le trigger
  // provision_profile_on_signup (M002a), qui insère lui-même un
  // profile_identifiers EMAIL vérifié — un second INSERT manuel ici entrait
  // systématiquement en collision avec profile_identifiers_verified_unique
  // (constaté empiriquement : "duplicate key value violates unique
  // constraint"), silencieusement ignoré faute de vérification d'erreur.
  // Retiré ; la fixture obtenue est désormais vérifiée EXPLICITEMENT (lue et
  // confirmée vérifiée) au lieu d'être supposée.
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
    throw new Error(`createTestUser(${label}) : identifiant EMAIL absent ou non vérifié après création (trigger M002a attendu, fixture invalide)`);
  }
  return { id: data.user.id, email: email.toLowerCase(), client };
}

async function createOrganization(ownerProfileId, label) {
  const { data, error } = await service
    .from("organizations")
    .insert({ name: `B062 fixture — ${label}`, owner_profile_id: ownerProfileId })
    .select("id")
    .single();
  if (error) throw new Error(`createOrganization(${label}): ${error.message}`);
  return data.id;
}

// Compte PROVISOIRE réel (revue ciblée, §1). BUG CONSTATÉ EMPIRIQUEMENT puis
// corrigé : email_confirm:false empêche purement et simplement la connexion
// (GoTrue refuse signInWithPassword sur un e-mail non confirmé, "Email not
// confirmed") ; email_confirm:true seul ne donne PAS un compte provisoire —
// le trigger provision_profile_on_signup (M002a) crée alors AUTOMATIQUEMENT
// un profile_identifiers déjà VÉRIFIÉ (verified_at_server = email_confirmed_at
// de la même ligne), rendant is_account_provisional() faux dès la création
// (constaté : la première version de ce fixture laissait passer designate
// sans jamais lever account_provisional). Corrigé : e-mail confirmé pour
// permettre la connexion, PUIS l'identifiant auto-créé est explicitement
// repassé à verified_at_server = null (service_role) pour obtenir un compte
// réellement provisoire au sens applicatif — vérifié réellement ci-dessous
// (is_account_provisional() interrogé juste après signIn).
async function createProvisionalTestUser(label) {
  const email = `b062-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createProvisionalTestUser(${label}): ${error.message}`);
  const { error: unverifyErr } = await service
    .from("profile_identifiers")
    .update({ verified_at_server: null })
    .eq("profile_id", data.user.id);
  if (unverifyErr) throw new Error(`createProvisionalTestUser(${label}) unverify: ${unverifyErr.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  const { data: isProvisional, error: provisionalCheckErr } = await client.rpc("is_account_provisional");
  if (provisionalCheckErr) throw new Error(`vérification is_account_provisional(${label}): ${provisionalCheckErr.message}`);
  if (isProvisional !== true) throw new Error(`createProvisionalTestUser(${label}) : compte pas réellement provisoire (bug de fixture) — is_account_provisional=${isProvisional}`);
  return { id: data.user.id, client };
}

async function main() {
  // --- Fixtures : 2 organisations distinctes, 2 propriétaires, 2 profils
  // "ingénieur" (un vérifié par e-mail, un second avec un identifiant
  // supplémentaire NON vérifié), 1 outsider sans lien avec aucune organisation.
  const ownerA = await createTestUser("ownerA");
  const ownerB = await createTestUser("ownerB");
  const outsider = await createTestUser("outsider");
  const engineerVerified = await createTestUser("engineer-verified");
  const engineerPhone = await createTestUser("engineer-phone");
  const engineerSecond = await createTestUser("engineer-second");

  // Identifiant PHONE vérifié pour engineerPhone (prouve que le type PHONE
  // fonctionne réellement, pas seulement EMAIL).
  // Unique par exécution (jamais une valeur fixe) : profile_identifiers a une
  // contrainte d'unicité réelle sur (kind, value_normalized) — une valeur
  // fixe entrerait en collision avec une exécution précédente non nettoyée
  // et ferait échouer l'insertion pour un tout autre profil (bug constaté).
  const enginePhoneNumber = `+223${String(Date.now()).slice(-8)}`;
  const { error: enginePhoneFixtureErr } = await service.from("profile_identifiers").insert({
    profile_id: engineerPhone.id,
    kind: "PHONE",
    value_normalized: enginePhoneNumber,
    verified_at_server: new Date().toISOString(),
  });
  if (enginePhoneFixtureErr) throw new Error(`fixture PHONE engineerPhone: ${enginePhoneFixtureErr.message}`);

  // Identifiant NON vérifié réel (verified_at_server null) pour l'outsider,
  // utilisé UNIQUEMENT pour prouver l'anti-énumération (existe mais non
  // vérifié doit produire EXACTEMENT la même erreur qu'une absence réelle).
  // Erreur de fixture vérifiée (revue ciblée, §3) : un échec silencieux ici
  // rendrait le test 5 (identifiant inexistant) et le test 6 (existant mais
  // non vérifié) indiscernables l'un de l'autre, sans jamais le signaler.
  const unverifiedEmail = `b062-unverified-${Date.now()}@example.test`;
  const { error: unverifiedFixtureErr } = await service.from("profile_identifiers").insert({
    profile_id: outsider.id,
    kind: "EMAIL",
    value_normalized: unverifiedEmail,
    verified_at_server: null,
  });
  if (unverifiedFixtureErr) throw new Error(`fixture identifiant non vérifié: ${unverifiedFixtureErr.message}`);

  const orgA = await createOrganization(ownerA.id, "A");
  const orgB = await createOrganization(ownerB.id, "B");
  console.log(`Organisations fixture: A=${orgA} B=${orgB}`);

  // ==========================================================================
  // 1. Désignation par le propriétaire — EMAIL
  // ==========================================================================
  const { data: designated1, error: designate1Err } = await ownerA.client.rpc("designate_plan_engineer", {
    p_organization_id: orgA,
    p_identifier_kind: "EMAIL",
    p_identifier_value: engineerVerified.email,
  });
  record("Désignation par le propriétaire réussie (EMAIL)", !designate1Err && designated1?.engineer_profile_id === engineerVerified.id, designate1Err?.message);
  record("Désignation renvoie l'identifiant utilisé (affichage)", designated1?.designated_identifier_value_normalized === engineerVerified.email);

  // ==========================================================================
  // 2. Désignation par le propriétaire — PHONE
  // ==========================================================================
  const { data: designatedPhone, error: designatePhoneErr } = await ownerA.client.rpc("designate_plan_engineer", {
    p_organization_id: orgA,
    p_identifier_kind: "PHONE",
    p_identifier_value: enginePhoneNumber,
  });
  record("Désignation par le propriétaire réussie (PHONE)", !designatePhoneErr && designatedPhone?.engineer_profile_id === engineerPhone.id, designatePhoneErr?.message);

  // ==========================================================================
  // 3. Refus — non-propriétaire (outsider) sur l'organisation A
  // ==========================================================================
  const { error: outsiderDesignateErr } = await outsider.client.rpc("designate_plan_engineer", {
    p_organization_id: orgA,
    p_identifier_kind: "EMAIL",
    p_identifier_value: engineerSecond.email,
  });
  record("Désignation refusée — non-propriétaire", outsiderDesignateErr?.message === "not_authorized", outsiderDesignateErr?.message);

  // ==========================================================================
  // 4. Anti-énumération — identifiant inexistant vs identifiant non vérifié
  //    doivent produire EXACTEMENT la même erreur (aucune fuite d'existence).
  // ==========================================================================
  const { error: notFoundErr } = await ownerA.client.rpc("designate_plan_engineer", {
    p_organization_id: orgA,
    p_identifier_kind: "EMAIL",
    p_identifier_value: `b062-jamais-cree-${Date.now()}@example.test`,
  });
  record("Désignation refusée — identifiant inexistant", notFoundErr?.message === "engineer_not_found_or_unverified", notFoundErr?.message);

  const { error: unverifiedErr } = await ownerA.client.rpc("designate_plan_engineer", {
    p_organization_id: orgA,
    p_identifier_kind: "EMAIL",
    p_identifier_value: unverifiedEmail,
  });
  record("Désignation refusée — identifiant existant mais NON vérifié", unverifiedErr?.message === "engineer_not_found_or_unverified", unverifiedErr?.message);
  record("Anti-énumération — même message pour inexistant et non-vérifié", notFoundErr?.message === unverifiedErr?.message);

  // ==========================================================================
  // 5. Refus — désignation déjà active pour la même paire (organisation, ingénieur)
  // ==========================================================================
  const { error: alreadyDesignatedErr } = await ownerA.client.rpc("designate_plan_engineer", {
    p_organization_id: orgA,
    p_identifier_kind: "EMAIL",
    p_identifier_value: engineerVerified.email,
  });
  record("Désignation refusée — déjà active pour cette paire", alreadyDesignatedErr?.message === "already_designated", alreadyDesignatedErr?.message);

  // ==========================================================================
  // 6. Isolation entre organisations
  // ==========================================================================
  const { data: listFromB, error: listFromBErr } = await ownerB.client.rpc("list_organization_engineers", { p_organization_id: orgA });
  // list_organization_engineers ne lève JAMAIS pour un non-propriétaire (son
  // propre WHERE la rend simplement vide) : une erreur ici serait un bug
  // inattendu, jamais une preuve de refus — vérifiée explicitement (revue
  // ciblée, §3), pas seulement le résultat vide.
  record("Isolation — le propriétaire de B ne voit AUCUNE désignation de A (sans erreur inattendue)", !listFromBErr && (listFromB ?? []).length === 0, listFromBErr?.message ?? `count=${listFromB?.length}`);

  const { error: revokeFromBErr } = await ownerB.client.rpc("revoke_plan_engineer_designation", { p_designation_id: designated1.id });
  record("Isolation — le propriétaire de B ne peut PAS révoquer une désignation de A", revokeFromBErr?.message === "not_authorized", revokeFromBErr?.message);

  const { error: outsiderRevokeErr } = await outsider.client.rpc("revoke_plan_engineer_designation", { p_designation_id: designated1.id });
  record("Révocation refusée — outsider (aucun lien avec l'organisation)", outsiderRevokeErr?.message === "not_authorized", outsiderRevokeErr?.message);

  // ==========================================================================
  // 7. Concurrence — deux désignations identiques simultanées (même paire)
  //    doivent produire EXACTEMENT un succès et un échec already_designated,
  //    jamais deux lignes actives.
  // ==========================================================================
  const [raceA, raceB] = await Promise.all([
    ownerA.client.rpc("designate_plan_engineer", { p_organization_id: orgA, p_identifier_kind: "EMAIL", p_identifier_value: engineerSecond.email }),
    ownerA.client.rpc("designate_plan_engineer", { p_organization_id: orgA, p_identifier_kind: "EMAIL", p_identifier_value: engineerSecond.email }),
  ]);
  const raceOutcomes = [raceA, raceB];
  const raceWins = raceOutcomes.filter((r) => !r.error).length;
  const raceLosses = raceOutcomes.filter((r) => r.error?.message === "already_designated").length;
  record("Concurrence — exactement une désignation aboutit", raceWins === 1, `wins=${raceWins}`);
  record("Concurrence — l'autre échoue avec already_designated (jamais deux lignes actives)", raceLosses === 1, `losses=${raceLosses}`);
  const { count: activeCountAfterRace } = await service
    .from("plan_engineer_designations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgA)
    .eq("engineer_profile_id", engineerSecond.id)
    .is("revoked_at", null);
  record("Concurrence — une seule ligne active en base pour cette paire", activeCountAfterRace === 1, `count=${activeCountAfterRace}`);

  // ==========================================================================
  // 8. Révocation par le propriétaire, puis refus sur une révocation déjà faite
  // ==========================================================================
  const { data: revoked1, error: revoke1Err } = await ownerA.client.rpc("revoke_plan_engineer_designation", { p_designation_id: designated1.id });
  record("Révocation par le propriétaire réussie", !revoke1Err && revoked1?.revoked_at !== null && revoked1?.revoked_by_profile_id === ownerA.id, revoke1Err?.message);

  const { error: alreadyRevokedErr } = await ownerA.client.rpc("revoke_plan_engineer_designation", { p_designation_id: designated1.id });
  record("Révocation refusée — déjà révoquée", alreadyRevokedErr?.message === "already_revoked", alreadyRevokedErr?.message);

  // ==========================================================================
  // 9. Ré-désignation après révocation — nouvelle ligne, historique conservé
  // ==========================================================================
  const { data: redesignated, error: redesignateErr } = await ownerA.client.rpc("designate_plan_engineer", {
    p_organization_id: orgA,
    p_identifier_kind: "EMAIL",
    p_identifier_value: engineerVerified.email,
  });
  record("Ré-désignation après révocation réussie", !redesignateErr && !!redesignated?.id, redesignateErr?.message);
  record("Ré-désignation crée une NOUVELLE ligne (jamais une réouverture)", redesignated?.id !== designated1.id);

  const { data: historyRows, error: historyRowsErr } = await service
    .from("plan_engineer_designations")
    .select("id, revoked_at")
    .eq("organization_id", orgA)
    .eq("engineer_profile_id", engineerVerified.id);
  if (historyRowsErr) throw new Error(`lecture historyRows: ${historyRowsErr.message}`);
  record("Historique conservé — 2 lignes pour cette paire (ancienne révoquée + nouvelle active)", (historyRows ?? []).length === 2, `count=${historyRows?.length}`);
  const activeInHistory = (historyRows ?? []).filter((r) => r.revoked_at === null).length;
  record("Historique — exactement une ligne active pour cette paire", activeInHistory === 1, `active=${activeInHistory}`);

  // ==========================================================================
  // 10. Liste — historique complet visible par le propriétaire (actives ET révoquées)
  // ==========================================================================
  const { data: fullListA, error: fullListErr } = await ownerA.client.rpc("list_organization_engineers", { p_organization_id: orgA });
  record("Liste — le propriétaire voit l'historique complet (actives + révoquées)", !fullListErr && (fullListA ?? []).some((d) => d.revoked_at !== null) && (fullListA ?? []).some((d) => d.revoked_at === null), fullListErr?.message);

  // ==========================================================================
  // 11. RLS — aucune lecture DIRECTE de la table (RLS activée, aucune policy),
  //     y compris pour le PROPRIÉTAIRE LÉGITIME de l'organisation (ownerA,
  //     l'acteur réellement testé ici — pas un tiers). Le propriétaire
  //     consulte sa liste UNIQUEMENT via list_organization_engineers
  //     (SECURITY DEFINER, déjà exercée avec succès aux tests 1/10 pour ce
  //     même ownerA) : aucune policy SELECT n'existe sur cette table pour
  //     personne, la seule voie de lecture autorisée passe par la fonction.
  // ==========================================================================
  const { data: directRead, error: directReadErr } = await ownerA.client
    .from("plan_engineer_designations")
    .select("id")
    .eq("organization_id", orgA);
  // Erreur SPÉCIFIQUE attendue (revoke all privileges sur la table, M023) —
  // pas n'importe quelle erreur : une panne réseau ou un bug non lié ne doit
  // jamais compter comme une preuve de refus (revue ciblée, §3).
  const directReadIsPermissionDenied = typeof directReadErr?.message === "string" && directReadErr.message.includes("permission denied");
  record("RLS — lecture DIRECTE refusée même pour le propriétaire légitime (ownerA), erreur spécifique (permission denied)", directReadIsPermissionDenied, directReadErr?.message ?? `rows=${directRead?.length}`);
  record("RLS — le même propriétaire (ownerA) lit sa liste avec succès via la fonction (rappel test 10)", !fullListErr && (fullListA ?? []).length > 0);

  // ==========================================================================
  // 12. Aucune ADHÉSION créée par la désignation (organization_memberships/
  //     project_memberships) — nécessaire mais PAS suffisant pour prouver
  //     "aucun accès implicite" (un compteur à 0 ne prouve pas qu'une LECTURE
  //     est refusée) ; voir §13 pour la preuve de lecture réelle.
  // ==========================================================================
  const { count: orgMembershipCount, error: orgMembershipCountErr } = await service
    .from("organization_memberships")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgA)
    .eq("profile_id", engineerVerified.id);
  if (orgMembershipCountErr) throw new Error(`lecture orgMembershipCount: ${orgMembershipCountErr.message}`);
  record("Aucune adhésion créée — organization_memberships (nécessaire, pas suffisant)", orgMembershipCount === 0, `count=${orgMembershipCount}`);

  const { count: projectMembershipCount, error: projectMembershipCountErr } = await service
    .from("project_memberships")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", engineerVerified.id);
  if (projectMembershipCountErr) throw new Error(`lecture projectMembershipCount: ${projectMembershipCountErr.message}`);
  record("Aucune adhésion créée — project_memberships (nécessaire, pas suffisant)", projectMembershipCount === 0, `count=${projectMembershipCount}`);

  // ==========================================================================
  // 13. PREUVE DE LECTURE RÉELLE (demandée explicitement) — engineerVerified
  //     est ACTIVEMENT désigné pour orgA depuis le test 9. On crée un VRAI
  //     chantier pour ownerA (create_draft_project, chemin réel de
  //     l'application — B014/B027, déjà livrés) et on vérifie que la seule
  //     désignation, SANS adhésion chantier, ne donne accès à AUCUNE donnée
  //     privée de ce chantier : ni la ligne du chantier lui-même, ni ses
  //     adhésions, ni sa galerie média (B027, déjà livrée). Aucun plan/devis/
  //     module financier (non livrés) n'est impliqué ni prétendu testé ici.
  // ==========================================================================
  const { data: realProjectDraft, error: realProjectErr } = await ownerA.client.rpc("create_draft_project", {
    p_name: "B062 fixture — chantier privé", p_country: "SN", p_role: "CONTRACTOR",
  });
  if (realProjectErr) throw new Error(`create_draft_project (fixture §13): ${realProjectErr.message}`);
  const realProjectId = realProjectDraft[0].project_id;

  // `projects`/`project_memberships` sont lisibles par RLS (pas de revoke
  // total comme sur plan_engineer_designations) : un non-membre reçoit un
  // résultat VIDE, jamais une erreur. Une erreur ici serait donc un bug
  // inattendu (ex. requête malformée), jamais une preuve de refus — vérifiée
  // explicitement (revue ciblée, §3), pas seulement le résultat vide.
  const { data: engineerSeesProject, error: engineerSeesProjectErr } = await engineerVerified.client
    .from("projects")
    .select("id")
    .eq("id", realProjectId);
  record("Lecture réelle refusée — l'ingénieur désigné ne voit PAS la ligne du chantier privé (RLS, sans erreur inattendue)", !engineerSeesProjectErr && (engineerSeesProject ?? []).length === 0, engineerSeesProjectErr?.message ?? `rows=${engineerSeesProject?.length}`);

  const { data: engineerSeesMemberships, error: engineerSeesMembershipsErr } = await engineerVerified.client
    .from("project_memberships")
    .select("id")
    .eq("project_id", realProjectId);
  record("Lecture réelle refusée — l'ingénieur désigné ne voit PAS les adhésions du chantier privé (RLS, sans erreur inattendue)", !engineerSeesMembershipsErr && (engineerSeesMemberships ?? []).length === 0, engineerSeesMembershipsErr?.message ?? `rows=${engineerSeesMemberships?.length}`);

  const { error: engineerListMediaErr } = await engineerVerified.client.rpc("list_project_media", { p_project_id: realProjectId });
  record("Lecture réelle refusée — l'ingénieur désigné ne peut PAS lire la galerie média du chantier (list_project_media, B027 déjà livrée)", engineerListMediaErr?.message === "not_authorized", engineerListMediaErr?.message);

  // ==========================================================================
  // 14. Normalisation PHONE — réutilise le même principe que profile_identifiers
  //     (M002) : forme E.164 canonique attendue, AUCUNE transformation au-delà
  //     d'un simple trim (le projet ne déduit ni ne reformate aucun numéro).
  //     Le test 2 utilisait déjà une valeur propre (aucun espace) : celui-ci
  //     exerce explicitement le trim, jamais vérifié jusqu'ici. engineerPhone
  //     est déjà désigné pour orgA depuis le test 2 — révoqué ici puis
  //     re-désigné avec des espaces superflus pour isoler la vérification.
  // ==========================================================================
  const { data: activePhoneDesignation, error: activePhoneDesignationErr } = await service
    .from("plan_engineer_designations")
    .select("id")
    .eq("organization_id", orgA)
    .eq("engineer_profile_id", engineerPhone.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (activePhoneDesignationErr || !activePhoneDesignation) throw new Error(`fixture activePhoneDesignation: ${activePhoneDesignationErr?.message ?? "introuvable"}`);
  const { error: revokePhoneFixtureErr } = await ownerA.client.rpc("revoke_plan_engineer_designation", { p_designation_id: activePhoneDesignation.id });
  if (revokePhoneFixtureErr) throw new Error(`fixture revocation préalable engineerPhone: ${revokePhoneFixtureErr.message}`);

  const { data: trimmedDesignation, error: trimmedErr } = await ownerA.client.rpc("designate_plan_engineer", {
    p_organization_id: orgA,
    p_identifier_kind: "PHONE",
    p_identifier_value: `  ${enginePhoneNumber}  `,
  });
  record("Normalisation PHONE — espaces superflus acceptés (trim, même principe que M002)", !trimmedErr && trimmedDesignation?.engineer_profile_id === engineerPhone.id, trimmedErr?.message);
  record("Normalisation PHONE — valeur stockée est la forme E.164 propre, jamais les espaces saisis", trimmedDesignation?.designated_identifier_value_normalized === enginePhoneNumber);

  // ==========================================================================
  // 15. Compte PROVISOIRE du propriétaire — RPC DIRECT (revue ciblée, §1).
  //     requireVerifiedAccount() (Server Action) n'est PAS le chemin
  //     emprunté ici : ces deux appels vont directement au RPC, exactement
  //     comme le reste de ce fichier, pour prouver que le contrôle est
  //     réellement porté par la fonction SQL elle-même (is_account_provisional(),
  //     après le verrou organisation), pas seulement par la couche Next.js.
  // ==========================================================================
  const provisionalOwner = await createProvisionalTestUser("provisional-owner");
  const orgProvisional = await createOrganization(provisionalOwner.id, "provisional");

  const { error: provisionalDesignateErr } = await provisionalOwner.client.rpc("designate_plan_engineer", {
    p_organization_id: orgProvisional,
    p_identifier_kind: "EMAIL",
    p_identifier_value: engineerVerified.email,
  });
  record("Compte provisoire — designate_plan_engineer refusé en RPC direct", provisionalDesignateErr?.message === "account_provisional", provisionalDesignateErr?.message);

  // Fixture directe (service_role, hors RPC) : designate étant refusé pour ce
  // propriétaire provisoire, une désignation existante est nécessaire pour
  // isoler strictement le contrôle testé sur revoke_plan_engineer_designation.
  const { data: provisionalFixtureRow, error: provisionalFixtureErr } = await service
    .from("plan_engineer_designations")
    .insert({
      organization_id: orgProvisional,
      engineer_profile_id: engineerVerified.id,
      designated_by_profile_id: provisionalOwner.id,
      designated_identifier_kind: "EMAIL",
      designated_identifier_value_normalized: engineerVerified.email,
    })
    .select("id")
    .single();
  if (provisionalFixtureErr) throw new Error(`fixture designation provisoire: ${provisionalFixtureErr.message}`);

  const { error: provisionalRevokeErr } = await provisionalOwner.client.rpc("revoke_plan_engineer_designation", {
    p_designation_id: provisionalFixtureRow.id,
  });
  record("Compte provisoire — revoke_plan_engineer_designation refusé en RPC direct", provisionalRevokeErr?.message === "account_provisional", provisionalRevokeErr?.message);

  // ==========================================================================
  // 16. Course DÉSIGNATION/RÉVOCATION sur la MÊME paire (revue ciblée, §2).
  //     Une désignation active D existe ; on appelle CONCURREMMENT sa
  //     révocation et une nouvelle désignation pour la MÊME paire. Avec
  //     l'ordre de verrous désormais uniforme (organisation d'abord), les
  //     deux appels se sérialisent sur le verrou organisation : deux issues
  //     cohérentes sont possibles selon l'ordre réel d'exécution (jamais un
  //     crash, jamais deux lignes actives) :
  //       (a) révocation d'abord -> la nouvelle désignation réussit ensuite ;
  //       (b) désignation tentée avant la révocation -> already_designated
  //           (D toujours active à cet instant), PUIS la révocation aboutit.
  // ==========================================================================
  const engineerRace = await createTestUser("engineer-race");
  const { data: raceDesignation, error: raceDesignationErr } = await ownerA.client.rpc("designate_plan_engineer", {
    p_organization_id: orgA, p_identifier_kind: "EMAIL", p_identifier_value: engineerRace.email,
  });
  if (raceDesignationErr) throw new Error(`fixture désignation course: ${raceDesignationErr.message}`);

  const [raceRevoke, raceRedesignate] = await Promise.all([
    ownerA.client.rpc("revoke_plan_engineer_designation", { p_designation_id: raceDesignation.id }),
    ownerA.client.rpc("designate_plan_engineer", { p_organization_id: orgA, p_identifier_kind: "EMAIL", p_identifier_value: engineerRace.email }),
  ]);
  record("Course désignation/révocation — la révocation n'échoue jamais de façon inattendue", !raceRevoke.error, raceRevoke.error?.message);
  const raceRedesignateCoherent = !raceRedesignate.error || raceRedesignate.error.message === "already_designated";
  record("Course désignation/révocation — la désignation concurrente aboutit à une issue cohérente (succès ou already_designated, jamais autre chose)", raceRedesignateCoherent, raceRedesignate.error?.message);

  const { data: raceHistory, error: raceHistoryErr } = await service
    .from("plan_engineer_designations")
    .select("id, revoked_at")
    .eq("organization_id", orgA)
    .eq("engineer_profile_id", engineerRace.id);
  if (raceHistoryErr) throw new Error(`lecture historique course: ${raceHistoryErr.message}`);
  const raceActiveCount = (raceHistory ?? []).filter((r) => r.revoked_at === null).length;
  record("Course désignation/révocation — jamais deux lignes actives simultanées pour cette paire", raceActiveCount <= 1, `active=${raceActiveCount} sur ${raceHistory?.length} ligne(s)`);

  // --- Bilan ------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} tests réussis.`);
  if (failed.length > 0) {
    console.log("Échecs :", failed.map((f) => f.name).join(" | "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("ERREUR FATALE:", err);
  process.exitCode = 1;
});
