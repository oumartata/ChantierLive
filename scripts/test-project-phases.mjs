// Test d'intégration LOCAL uniquement — lot « Avancement des travaux »
// (M033 : project_phase_plans, project_phases, project_phase_events).
// Risques couverts : somme des poids = 100 exactement avant publication,
// progression 0-100, aucun pourcentage avant publication, droits
// (CONTRACTOR natif, SITE_MANAGER avec délégation PHASE_UPDATE_PROGRESS
// active sur CE chantier, OWNER/PRIMARY et CO_OWNER toujours refusés en
// écriture, tiers refusé), calcul pondéré exact, historique gelé après
// restructuration (jamais recalculé rétroactivement), concurrence
// (revision), parcours complet entreprise -> publication -> mise à jour ->
// consultation propriétaire -> rechargement.
//
// Usage : node scripts/test-project-phases.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

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

const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail !== undefined ? " — " + detail : ""}`);
}
const err = (res) => res.error?.message ?? "aucune erreur";
const one = (r) => ({ ...r, row: Array.isArray(r.data) ? r.data[0] : r.data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createTestUser(label) {
  const email = `avancement-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, email: email.toLowerCase(), client };
}
async function must(promise, label) {
  const r = await promise;
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  return r.data;
}

// Chantier avec CONTRACTOR, OWNER/PRIMARY, CO_OWNER et SITE_MANAGER —
// réutilise create_draft_project (M004b, inchangé) + insertion directe des
// adhésions complémentaires (même convention que scripts/test-work-start.mjs).
async function setupProject(tag) {
  const contractor = await createTestUser(`${tag}-contractor`);
  const owner = await createTestUser(`${tag}-owner`);
  const coOwner = await createTestUser(`${tag}-coowner`);
  const siteManager = await createTestUser(`${tag}-sitemanager`);
  const outsider = await createTestUser(`${tag}-outsider`);
  const { data: proj } = await contractor.client.rpc("create_draft_project", { p_name: `AVANCEMENT — ${tag}`, p_country: "ML", p_role: "CONTRACTOR" });
  const { project_id: pid } = Array.isArray(proj) ? proj[0] : proj;
  await must(service.from("project_memberships").insert({ project_id: pid, profile_id: owner.id, role: "OWNER", owner_profile: "PRIMARY" }), "owner");
  await must(service.from("project_memberships").insert({ project_id: pid, profile_id: coOwner.id, role: "OWNER", owner_profile: "CO_OWNER" }), "coOwner");
  await must(service.from("project_memberships").insert({ project_id: pid, profile_id: siteManager.id, role: "SITE_MANAGER" }), "siteManager");
  return { pid, contractor, owner, coOwner, siteManager, outsider };
}

const DEFAULT_PHASES = [
  { position: 1, label: "Préparation du chantier", weight: 10 },
  { position: 2, label: "Fondations", weight: 20 },
  { position: 3, label: "Gros œuvre", weight: 30 },
  { position: 4, label: "Toiture / étanchéité", weight: 15 },
  { position: 5, label: "Second œuvre", weight: 15 },
  { position: 6, label: "Finitions", weight: 10 },
];

const asList = (r) => ({ ...r, row: r.data ?? [] });
const getPlan = (client, pid) => client.rpc("get_project_phase_plan", { p_project_id: pid }).then(one);
const listPhases = (client, pid) => client.rpc("list_project_phases", { p_project_id: pid }).then(asList);
const listEvents = (client, pid) => client.rpc("list_phase_events", { p_project_id: pid }).then(asList);
const upsertDraft = (client, pid, phases, rev) => client.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: phases, p_expected_revision: rev }).then(one);
const publish = (client, pid, rev) => client.rpc("publish_phase_plan", { p_project_id: pid, p_expected_revision: rev }).then(one);
const updateProgress = (client, pid, phaseId, progression, rev) => client.rpc("update_phase_progress", { p_project_id: pid, p_phase_id: phaseId, p_progression: progression, p_expected_revision: rev }).then(one);
const restructure = (client, pid, phases, reason, rev) => client.rpc("restructure_phase_plan", { p_project_id: pid, p_phases: phases, p_reason: reason, p_expected_revision: rev }).then(one);
const grantDelegation = (client, membershipId, code) => client.rpc("grant_delegation", { p_project_membership_id: membershipId, p_permission_code: code }).then(one);
const membershipId = async (pid, profileId) => (await service.from("project_memberships").select("id").eq("project_id", pid).eq("profile_id", profileId).is("revoked_at", null).single()).data.id;

async function main() {
  // ------------------------------------------------------------------
  // 1. Brouillon : aucun pourcentage fictif avant publication.
  // ------------------------------------------------------------------
  const P = await setupProject("main");
  const { pid, contractor, owner, coOwner, siteManager, outsider } = P;

  const absent = await getPlan(contractor.client, pid);
  record("1. Plan absent avant toute action — status ABSENT", absent.row?.status === "ABSENT" && absent.row?.global_progress === null, JSON.stringify(absent.row));

  const draft = await upsertDraft(contractor.client, pid, DEFAULT_PHASES, 0);
  record("1. Création du brouillon (modèle par défaut, 6 étapes)", !draft.error && draft.row?.status === "BROUILLON", err(draft));
  const planAfterDraft = await getPlan(contractor.client, pid);
  record("1. Aucun pourcentage global en brouillon", planAfterDraft.row?.global_progress === null, JSON.stringify(planAfterDraft.row));
  let revision = draft.row?.revision ?? 1;

  const phasesAfterDraft = await listPhases(contractor.client, pid);
  record("1. 6 étapes présentes dans le brouillon", phasesAfterDraft.row?.length === 6, JSON.stringify(phasesAfterDraft.row?.length));

  // ------------------------------------------------------------------
  // 2. Refus — brouillon : poids hors bornes, somme invalide à la publication.
  // ------------------------------------------------------------------
  const badWeight = await upsertDraft(contractor.client, pid, DEFAULT_PHASES.map((p, i) => (i === 0 ? { ...p, weight: 150 } : p)), revision);
  record("2. Poids hors bornes refusé (brouillon)", badWeight.error?.message === "phase_invalid_weight", err(badWeight));

  const unbalanced = DEFAULT_PHASES.map((p) => ({ ...p, weight: 10 })); // somme = 60, pas 100
  const draftUnbalanced = await upsertDraft(contractor.client, pid, unbalanced, revision);
  record("2. Brouillon accepte une somme provisoire ≠ 100 (seule la publication l'exige)", !draftUnbalanced.error, err(draftUnbalanced));
  revision = draftUnbalanced.row.revision;
  const pubInvalid = await publish(contractor.client, pid, revision);
  record("2. Publication refusée — somme de poids ≠ 100", pubInvalid.error?.message === "weight_sum_invalid", err(pubInvalid));

  // Remet les poids valides (somme = 100) avant de poursuivre.
  const draftFixed = await upsertDraft(contractor.client, pid, DEFAULT_PHASES, revision);
  revision = draftFixed.row.revision;

  // ------------------------------------------------------------------
  // 3. Refus d'écriture (brouillon et publication) — propriétaire, tiers.
  // ------------------------------------------------------------------
  for (const [label, u] of [["OWNER/PRIMARY", owner], ["CO_OWNER", coOwner], ["tiers", outsider]]) {
    const r = await upsertDraft(u.client, pid, DEFAULT_PHASES, revision);
    record(`3. Édition du brouillon refusée — ${label}`, r.error?.message === "not_authorized", err(r));
    const rp = await publish(u.client, pid, revision);
    record(`3. Publication refusée — ${label}`, rp.error?.message === "not_authorized", err(rp));
  }
  // SITE_MANAGER n'a d'écriture possible sur la structure dans ce lot (CONTRACTOR natif uniquement) :
  const rSm = await upsertDraft(siteManager.client, pid, DEFAULT_PHASES, revision);
  record("3. Édition du brouillon refusée — SITE_MANAGER (aucune extension demandée)", rSm.error?.message === "not_authorized", err(rSm));

  // ------------------------------------------------------------------
  // 4. Publication réelle, lecture propriétaire (consultation seule).
  // ------------------------------------------------------------------
  const pub = await publish(contractor.client, pid, revision);
  record("4. Publication réussie (somme = 100)", !pub.error && pub.row?.status === "PUBLIE" && pub.row?.global_progress === 0, err(pub));
  revision = pub.row.revision;
  const phases = (await listPhases(contractor.client, pid)).row;
  const fondations = phases.find((p) => p.label === "Fondations");
  const grosOeuvre = phases.find((p) => p.label === "Gros œuvre");

  const ownerReadAfterPublish = await getPlan(owner.client, pid);
  record("4. Propriétaire consulte le plan publié", ownerReadAfterPublish.row?.status === "PUBLIE", JSON.stringify(ownerReadAfterPublish.row));

  // ------------------------------------------------------------------
  // 5. Refus — progression hors 0-100, et refus d'écriture par rôle.
  // ------------------------------------------------------------------
  const badProg = await updateProgress(contractor.client, pid, fondations.phase_id, 150, revision);
  record("5. Progression hors bornes refusée", badProg.error?.message === "progression_out_of_range", err(badProg));
  const badProgNeg = await updateProgress(contractor.client, pid, fondations.phase_id, -1, revision);
  record("5. Progression négative refusée", badProgNeg.error?.message === "progression_out_of_range", err(badProgNeg));

  for (const [label, u] of [["OWNER/PRIMARY", owner], ["CO_OWNER", coOwner], ["tiers", outsider]]) {
    const r = await updateProgress(u.client, pid, fondations.phase_id, 50, revision);
    record(`5. Mise à jour de progression refusée — ${label}`, r.error?.message === "not_authorized", err(r));
  }
  const rSmNoDelegation = await updateProgress(siteManager.client, pid, fondations.phase_id, 50, revision);
  record("5. SITE_MANAGER sans délégation active refusé", rSmNoDelegation.error?.message === "not_authorized", err(rSmNoDelegation));

  // ------------------------------------------------------------------
  // 6. SITE_MANAGER avec délégation active PHASE_UPDATE_PROGRESS — autorisé,
  //    jamais par simple appartenance à l'organisation (délégation explicite
  //    requise, scopée à CE chantier).
  // ------------------------------------------------------------------
  const smMembershipId = await membershipId(pid, siteManager.id);
  const grant = await grantDelegation(contractor.client, smMembershipId, "PHASE_UPDATE_PROGRESS");
  record("6. Délégation PHASE_UPDATE_PROGRESS accordée par le CONTRACTOR", !grant.error, err(grant));
  const smUpdate = await updateProgress(siteManager.client, pid, grosOeuvre.phase_id, 20, revision);
  record("6. SITE_MANAGER avec délégation active autorisé", !smUpdate.error, err(smUpdate));
  revision = smUpdate.row.revision;

  // ------------------------------------------------------------------
  // 7. Mise à jour par le CONTRACTOR, calcul pondéré exact.
  // ------------------------------------------------------------------
  const u1 = await updateProgress(contractor.client, pid, fondations.phase_id, 50, revision);
  record("7. Mise à jour de progression par le CONTRACTOR", !u1.error, err(u1));
  revision = u1.row.revision;
  // Attendu : Fondations 20%×50% + Gros œuvre 30%×20% = 10 + 6 = 16 (les
  // autres étapes à 0%). Vérifié directement par calcul indépendant côté
  // test (pas une simple relecture de ce que le serveur vient de renvoyer).
  const expected = (20 * 50 + 30 * 20) / 100;
  record("7. Calcul pondéré exact (Σ(poids×progression)/100)", Number(u1.row.global_progress) === expected, `attendu ${expected}, obtenu ${u1.row.global_progress}`);

  // ------------------------------------------------------------------
  // 8. Historique attribué, conservé après changement de poids.
  // ------------------------------------------------------------------
  const eventsBefore = (await listEvents(contractor.client, pid)).row;
  const progressionEvent = eventsBefore.find((e) => e.event_type === "PROGRESSION_UPDATED" && e.phase_label === "Fondations" && Number(e.computed_global_progress) === expected);
  record("8. Événement de progression historisé et attribué", Boolean(progressionEvent) && progressionEvent.actor_role === "CONTRACTOR", JSON.stringify(progressionEvent));

  const noReason = await restructure(contractor.client, pid, DEFAULT_PHASES.map((p) => ({ ...p, phase_id: phases.find((x) => x.label === p.label).phase_id })), "", revision);
  record("8. Restructuration refusée sans motif", noReason.error?.message === "reason_required", err(noReason));

  const newPhases = DEFAULT_PHASES.map((p) => ({ ...p, phase_id: phases.find((x) => x.label === p.label).phase_id, weight: p.label === "Fondations" ? 10 : p.label === "Gros œuvre" ? 40 : p.weight }));
  const restructured = await restructure(contractor.client, pid, newPhases, "Réévaluation de la charge gros œuvre après visite de chantier", revision);
  record("8. Restructuration acceptée (nouvelle somme = 100, motif fourni)", !restructured.error, err(restructured));
  revision = restructured.row.revision;
  // Nouveau calcul attendu avec les NOUVEAUX poids et les progressions
  // INCHANGÉES (Fondations 50%, Gros œuvre 20%) : 10%×50% + 40%×20% = 5+8=13.
  const expectedAfterRestructure = (10 * 50 + 40 * 20) / 100;
  record("8. Impact de la restructuration = nouveaux poids × progressions conservées", Number(restructured.row.global_progress) === expectedAfterRestructure, `attendu ${expectedAfterRestructure}, obtenu ${restructured.row.global_progress}`);

  const eventsAfter = (await listEvents(contractor.client, pid)).row;
  const sameProgressionEvent = eventsAfter.find((e) => e.event_seq === progressionEvent.event_seq);
  record("8. Historique antérieur INCHANGÉ après la restructuration (jamais recalculé)", Number(sameProgressionEvent.computed_global_progress) === expected, `attendu ${expected} (figé), obtenu ${sameProgressionEvent.computed_global_progress}`);
  const structureEvent = eventsAfter.find((e) => e.event_type === "STRUCTURE_CHANGED");
  record("8. Événement STRUCTURE_CHANGED historisé avec motif", structureEvent?.reason === "Réévaluation de la charge gros œuvre après visite de chantier", JSON.stringify(structureEvent?.reason));

  // ------------------------------------------------------------------
  // 9. Modification concurrente détectée.
  // ------------------------------------------------------------------
  const staleRevision = revision;
  const first = await updateProgress(contractor.client, pid, fondations.phase_id, 60, staleRevision);
  record("9. Première écriture concurrente réussie", !first.error, err(first));
  const second = await updateProgress(contractor.client, pid, grosOeuvre.phase_id, 30, staleRevision);
  record("9. Seconde écriture concurrente (même révision attendue) refusée — revision_conflict", second.error?.message === "revision_conflict", err(second));
  revision = first.row.revision;

  // ------------------------------------------------------------------
  // 10. Parcours complet : consultation propriétaire après rechargement.
  // ------------------------------------------------------------------
  const finalOwnerRead = await getPlan(owner.client, pid);
  const finalPhasesOwnerRead = await listPhases(owner.client, pid);
  record("10. Rechargement propriétaire — statut PUBLIE cohérent", finalOwnerRead.row?.status === "PUBLIE", JSON.stringify(finalOwnerRead.row));
  record("10. Rechargement propriétaire — étapes lisibles (consultation seule)", finalPhasesOwnerRead.row?.length === 6, JSON.stringify(finalPhasesOwnerRead.row?.length));
  record("10. Propriétaire ne peut toujours pas écrire après rechargement", (await updateProgress(owner.client, pid, fondations.phase_id, 10, revision)).error?.message === "not_authorized");

  const summary = `${results.filter(Boolean).length}/${results.length} tests réussis.`;
  console.log(`\n${summary}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => {
  console.error("ÉCHEC INATTENDU:", e);
  process.exit(1);
});
