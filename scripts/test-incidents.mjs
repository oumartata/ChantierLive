// Test d'intégration LOCAL uniquement : M038, incidents (B024, D159–D166).
// Données jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-incidents.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const local = (() => { try { const { hostname } = new URL(SUPABASE_URL); return hostname === "127.0.0.1" || hostname === "localhost"; } catch { return false; } })();
if (!local) { console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`); process.exit(1); }
if (!SERVICE_KEY || !ANON_KEY) { console.error("Clés locales manquantes."); process.exit(1); }

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
async function user(label) {
  const email = `m038-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client };
}
const past = new Date(Date.now() - 3600_000).toISOString();
const create = (u, projectId, extra = {}) =>
  u.client.rpc("create_incident", {
    p_project_id: projectId, p_incident_type: "MALFACON", p_severity: "ELEVEE", p_occurred_at: past,
    p_description: "Fissure sur le poteau P3", p_linked_incident_id: null, ...extra,
  });
const correct = (u, inc, rev, reason, extra = {}) =>
  u.client.rpc("correct_incident", {
    p_incident_id: inc.id, p_expected_revision: rev, p_reason: reason, p_incident_type: inc.incident_type,
    p_severity: inc.severity, p_occurred_at: inc.occurred_at, p_description: inc.description, ...extra,
  });
const assign = (u, id, rev, assignee, due = null) =>
  u.client.rpc("assign_incident", { p_incident_id: id, p_expected_revision: rev, p_assignee_profile_id: assignee, p_due_date: due });
const move = (u, id, rev, to, note = null, resolution = null) =>
  u.client.rpc("transition_incident", { p_incident_id: id, p_expected_revision: rev, p_to_status: to, p_note: note, p_resolution: resolution });
const list = (u, projectId) => u.client.rpc("list_project_incidents", { p_project_id: projectId });
const history = (u, id) => u.client.rpc("get_incident_history", { p_incident_id: id });
const rev = async (id) => (await service.from("incidents").select("revision").eq("id", id).single()).data.revision;

try {
  const contractor = await user("entreprise");
  const sm = await user("chef");
  const sm2 = await user("chef2");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const outsider = await user("hors-chantier");
  const { data: created, error: projErr } = await contractor.client.rpc("create_draft_project", { p_name: "M038 — incidents", p_country: "ML", p_role: "CONTRACTOR" });
  if (projErr) throw new Error(projErr.message);
  const projectId = (Array.isArray(created) ? created[0] : created).project_id;
  for (const [u, role, ownerProfile] of [[sm, "SITE_MANAGER", null], [sm2, "SITE_MANAGER", null], [owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"]]) {
    const { error } = await service.from("project_memberships").insert({ project_id: projectId, profile_id: u.id, role, owner_profile: ownerProfile });
    if (error) throw new Error(`adhésion ${role}: ${error.message}`);
  }

  // Déclarer (FR101, D159–D161) : tout membre actif, directement OUVERT.
  const iC = await create(contractor, projectId);
  record("Entreprise : déclare (OUVERT, attribué, révision 0)", !iC.error && iC.data.status === "OUVERT" && iC.data.reporter_profile_id === contractor.id && iC.data.revision === 0, iC.error?.message);
  const iSM = await create(sm, projectId, { p_incident_type: "SECURITE", p_severity: "URGENTE" });
  record("Chef : déclare un incident urgent", !iSM.error && iSM.data.severity === "URGENTE" && iSM.data.reporter_role === "SITE_MANAGER", iSM.error?.message);
  const iOP = await create(owner, projectId, { p_incident_type: "RETARD", p_severity: "FAIBLE" });
  record("Propriétaire principal : déclare", !iOP.error && iOP.data.reporter_owner_profile === "PRIMARY", iOP.error?.message);
  const iCO = await create(coOwner, projectId, { p_incident_type: "AUTRE", p_severity: "MOYENNE" });
  record("Copropriétaire : déclare", !iCO.error && iCO.data.reporter_owner_profile === "CO_OWNER", iCO.error?.message);
  const { count: evCreate } = await service.from("incident_events").select("id", { count: "exact", head: true }).eq("incident_id", iC.data.id).eq("event_type", "CREATION");
  const { count: auCreate } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("target_id", iC.data.id).eq("action", "INCIDENT_CREATE");
  record("Création : événement CREATION et audit", evCreate === 1 && auCreate === 1);
  for (const [label, extra, code] of [
    ["gravité hors liste", { p_severity: "HIGH" }, "incident_invalid"],
    ["type hors liste", { p_incident_type: "COUT" }, "incident_invalid"],
    ["description trop courte", { p_description: "abc" }, "incident_invalid"],
    ["date future", { p_occurred_at: new Date(Date.now() + 86400_000).toISOString() }, "occurred_in_future"],
    ["lien vers un incident non clos", { p_linked_incident_id: iSM.data.id }, "linked_incident_invalid"],
  ]) {
    const r = await create(contractor, projectId, extra);
    record(`Déclaration refusée : ${label}`, r.error?.message === code, r.error?.message);
  }
  const oc = await create(outsider, projectId);
  record("Non-membre : déclaration refusée", oc.error?.message === "not_authorized", oc.error?.message);

  // Voir (INCIDENT_VIEW) : tout membre actif, propriétaires compris.
  for (const [label, u] of [["entreprise", contractor], ["chef", sm], ["autre chef", sm2], ["propriétaire principal", owner], ["copropriétaire", coOwner]]) {
    const l = await list(u, projectId);
    record(`${label} : voit les 4 incidents`, !l.error && l.data.length === 4, l.error?.message);
  }
  const ol = await list(outsider, projectId);
  record("Non-membre : liste refusée", ol.error?.message === "not_authorized", ol.error?.message);
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const al = await list({ client: anon }, projectId);
  record("Sans session : refusé", al.error?.code === "42501", al.error?.code);
  for (const t of ["incidents", "incident_events"]) {
    const d = await owner.client.from(t).select("id").limit(1);
    record(`Propriétaire : lecture directe de ${t} refusée`, d.error?.code === "42501", d.error?.code);
  }
  const ownerView = (await list(owner, projectId)).data;
  const ownerOnC = ownerView.find((r) => r.id === iC.data.id);
  record("Propriétaire principal sur l'incident de l'entreprise : ni modifier ni clore, mais désigner", ownerOnC.can_update === false && ownerOnC.can_close === false && ownerOnC.can_assign === true);
  const coView = (await list(coOwner, projectId)).data;
  record("Copropriétaire : ne clôt jamais, ne désigne jamais", coView.every((r) => r.can_close === false && r.can_assign === false));

  // Modifier avec motif (D162, D164).
  const noReason = await correct(contractor, iOP.data, 0, " ", { p_severity: "MOYENNE" });
  record("Correction sans motif refusée", noReason.error?.message === "reason_required", noReason.error?.message);
  const noChange = await correct(contractor, iOP.data, 0, "Rien");
  record("Correction sans changement refusée", noChange.error?.message === "no_change", noChange.error?.message);
  const cC = await correct(contractor, iOP.data, 0, "Retard plus grave que déclaré", { p_severity: "MOYENNE" });
  record("Entreprise : corrige l'incident du propriétaire (révision 1)", !cC.error && cC.data.severity === "MOYENNE" && cC.data.revision === 1, cC.error?.message);
  const stale = await correct(contractor, iOP.data, 0, "Concurrence", { p_severity: "ELEVEE" });
  record("Correction sur révision périmée refusée", stale.error?.message === "revision_conflict", stale.error?.message);
  const { data: evCorr } = await service.from("incident_events").select("changes, reason").eq("incident_id", iOP.data.id).eq("event_type", "CORRECTION").single();
  record("Correction : ancienne valeur et motif dans l'historique", evCorr.changes.severity.old === "FAIBLE" && evCorr.changes.severity.new === "MOYENNE" && evCorr.reason === "Retard plus grave que déclaré");
  const smCorr = await correct(sm, iCO.data, 0, "Précision chef", { p_description: "Gravats laissés devant l'entrée" });
  record("Chef : corrige l'incident d'un autre", !smCorr.error, smCorr.error?.message);
  const coOwn = await correct(coOwner, { ...iCO.data, description: "Gravats laissés devant l'entrée" }, 1, "Précision", { p_severity: "FAIBLE" });
  record("Copropriétaire : corrige son propre incident", !coOwn.error, coOwn.error?.message);
  const coOther = await correct(coOwner, iC.data, 0, "Pas le mien", { p_severity: "FAIBLE" });
  record("Copropriétaire : correction de l'incident d'un autre refusée", coOther.error?.message === "not_authorized", coOther.error?.message);
  const opOther = await correct(owner, iC.data, 0, "Pas le mien", { p_severity: "FAIBLE" });
  record("Propriétaire principal : correction de l'incident de l'entreprise refusée", opOther.error?.message === "not_authorized", opOther.error?.message);
  const outCorr = await correct(outsider, iC.data, 0, "Intrus", { p_severity: "FAIBLE" });
  record("Non-membre : correction refusée", outCorr.error?.message === "not_authorized", outCorr.error?.message);

  // Désigner (D163).
  const smAssign = await assign(sm, iC.data.id, 0, sm2.id);
  record("Chef : désignation refusée", smAssign.error?.message === "not_authorized", smAssign.error?.message);
  const coAssign = await assign(coOwner, iC.data.id, 0, sm2.id);
  record("Copropriétaire : désignation refusée", coAssign.error?.message === "not_authorized", coAssign.error?.message);
  const outAssign = await assign(owner, iC.data.id, 0, outsider.id);
  record("Désigner un non-membre refusé", outAssign.error?.message === "assignee_not_member", outAssign.error?.message);
  const opAssign = await assign(owner, iC.data.id, 0, sm2.id, "2026-10-20");
  record("Propriétaire principal : désigne le 2e chef avec échéance (AFFECTE)", !opAssign.error && opAssign.data.status === "AFFECTE" && opAssign.data.assignee_profile_id === sm2.id && opAssign.data.due_date === "2026-10-20", opAssign.error?.message);
  const reassign = await assign(contractor, iC.data.id, 1, sm2.id, null);
  record("Entreprise : change l'échéance (désignation tracée, état inchangé)", !reassign.error && reassign.data.status === "AFFECTE" && reassign.data.due_date === null, reassign.error?.message);
  const { count: evAssign } = await service.from("incident_events").select("id", { count: "exact", head: true }).eq("incident_id", iC.data.id).eq("event_type", "DESIGNATION");
  record("Deux désignations tracées", evAssign === 2);

  // Changer d'état et transitions invalides (B024 done_when).
  let r = await rev(iC.data.id);
  const bad1 = await move(contractor, iC.data.id, r, "RESOLU", null, "Réparé");
  record("AFFECTE -> RESOLU refusé (transition invalide)", bad1.error?.message === "invalid_transition", bad1.error?.message);
  const bad2 = await move(contractor, iC.data.id, r, "CLOS");
  record("AFFECTE -> CLOS refusé (transition invalide)", bad2.error?.message === "invalid_transition", bad2.error?.message);
  const bad3 = await move(contractor, iC.data.id, r, "OUVERT");
  record("AFFECTE -> OUVERT refusé (transition invalide)", bad3.error?.message === "invalid_transition", bad3.error?.message);
  const bad4 = await move(contractor, iC.data.id, r, "ANNULE", "Erreur");
  record("AFFECTE -> ANNULE refusé (annulation seulement depuis OUVERT)", bad4.error?.message === "invalid_transition", bad4.error?.message);
  const opMove = await move(owner, iC.data.id, r, "EN_COURS");
  record("Propriétaire principal non responsable : changement d'état refusé", opMove.error?.message === "not_authorized", opMove.error?.message);
  const sm2Start = await move(sm2, iC.data.id, r, "EN_COURS", "Démarrage");
  record("Responsable désigné : EN_COURS", !sm2Start.error && sm2Start.data.status === "EN_COURS", sm2Start.error?.message);
  r = sm2Start.data.revision;
  const noRes = await move(sm2, iC.data.id, r, "RESOLU");
  record("RESOLU sans résolution refusé (BR063)", noRes.error?.message === "resolution_required", noRes.error?.message);
  const res1 = await move(sm2, iC.data.id, r, "RESOLU", null, "Poteau repris au mortier");
  record("Responsable : RESOLU avec résolution", !res1.error && res1.data.status === "RESOLU" && res1.data.resolution === "Poteau repris au mortier", res1.error?.message);
  r = res1.data.revision;
  const smClose = await move(sm, iC.data.id, r, "CLOS");
  record("Chef non responsable : clôture refusée", smClose.error?.message === "not_authorized", smClose.error?.message);
  const coClose = await move(coOwner, iC.data.id, r, "CLOS");
  record("Copropriétaire : clôture refusée", coClose.error?.message === "not_authorized", coClose.error?.message);
  const backNoReason = await move(contractor, iC.data.id, r, "EN_COURS");
  record("RESOLU -> EN_COURS sans motif refusé", backNoReason.error?.message === "reason_required", backNoReason.error?.message);
  const back = await move(contractor, iC.data.id, r, "EN_COURS", "Fissure réapparue au contrôle");
  record("RESOLU -> EN_COURS avec motif (résolution effacée, historisée)", !back.error && back.data.status === "EN_COURS" && back.data.resolution === null, back.error?.message);
  const res2 = await move(sm2, iC.data.id, back.data.revision, "RESOLU", null, "Poteau repris et contrôlé");
  const close = await move(sm2, iC.data.id, res2.data.revision, "CLOS");
  record("Responsable désigné (chef) : clôture", !close.error && close.data.status === "CLOS" && !!close.data.closed_at_server, close.error?.message);
  r = close.data.revision;
  const reopen = await move(contractor, iC.data.id, r, "EN_COURS", "Encore");
  record("Incident clos : aucune réouverture", reopen.error?.message === "incident_terminal", reopen.error?.message);
  const corrClosed = await correct(contractor, close.data, r, "Après clôture", { p_severity: "FAIBLE" });
  record("Incident clos : correction refusée", corrClosed.error?.message === "incident_terminal", corrClosed.error?.message);
  const assignClosed = await assign(contractor, iC.data.id, r, sm.id);
  record("Incident clos : désignation refusée", assignClosed.error?.message === "incident_terminal", assignClosed.error?.message);
  const linked = await create(sm, projectId, { p_linked_incident_id: iC.data.id, p_description: "La fissure du poteau P3 est revenue" });
  record("Nouvel incident lié à un incident clos (D165)", !linked.error && linked.data.linked_incident_id === iC.data.id, linked.error?.message);

  // Propriétaire principal : clôt son propre incident.
  let o = await move(owner, iOP.data.id, await rev(iOP.data.id), "EN_COURS");
  o = await move(owner, iOP.data.id, o.data.revision, "RESOLU", null, "Planning recalé");
  o = await move(owner, iOP.data.id, o.data.revision, "CLOS");
  record("Propriétaire principal : traite et clôt son propre incident", !o.error && o.data.status === "CLOS", o.error?.message);

  // Copropriétaire : modifie son propre incident mais ne le clôt jamais ; désigné, ne modifie pas celui d'un autre.
  let c = await move(coOwner, iCO.data.id, await rev(iCO.data.id), "EN_COURS");
  c = await move(coOwner, iCO.data.id, c.data.revision, "RESOLU", null, "Gravats évacués");
  record("Copropriétaire : fait évoluer son propre incident jusqu'à RESOLU", !c.error && c.data.status === "RESOLU", c.error?.message);
  const coCloseOwn = await move(coOwner, iCO.data.id, c.data.revision, "CLOS");
  record("Copropriétaire : clôture de son propre incident refusée", coCloseOwn.error?.message === "not_authorized", coCloseOwn.error?.message);
  const coAssigned = await assign(owner, iSM.data.id, 0, coOwner.id);
  const coAsAssignee = await move(coOwner, iSM.data.id, coAssigned.data.revision, "EN_COURS");
  record("Copropriétaire désigné sur l'incident d'un autre : modification refusée", !coAssigned.error && coAsAssignee.error?.message === "not_authorized", coAsAssignee.error?.message ?? coAssigned.error?.message);
  const cClose = await move(contractor, iCO.data.id, c.data.revision, "CLOS");
  record("Entreprise : clôt l'incident résolu du copropriétaire", !cClose.error && cClose.data.status === "CLOS", cClose.error?.message);

  // Annulation (D165) : seulement depuis OUVERT, motif, droit de clôture.
  const iCancel = await create(sm, projectId, { p_description: "Déclaré par erreur, doublon" });
  const smCancel = await move(sm, iCancel.data.id, 0, "ANNULE", "Doublon");
  record("Chef non responsable : annulation refusée", smCancel.error?.message === "not_authorized", smCancel.error?.message);
  const cCancelNo = await move(contractor, iCancel.data.id, 0, "ANNULE");
  record("Annulation sans motif refusée", cCancelNo.error?.message === "reason_required", cCancelNo.error?.message);
  const cCancel = await move(contractor, iCancel.data.id, 0, "ANNULE", "Doublon de l'incident poteau");
  record("Entreprise : annule avec motif (ANNULE, terminal)", !cCancel.error && cCancel.data.status === "ANNULE", cCancel.error?.message);

  // Régression des deux fuites de la boucle 11b (M038, corrigées par M038c) :
  // droit évalué à NULL faute de responsable désigné.
  const leak1 = await create(contractor, projectId, { p_description: "Fuite 1 : incident de l'entreprise sans responsable" });
  const leak1Try = await correct(owner, leak1.data, 0, "Pas le mien", { p_severity: "FAIBLE" });
  const { count: leak1Ev } = await service.from("incident_events").select("id", { count: "exact", head: true }).eq("incident_id", leak1.data.id).eq("event_type", "CORRECTION");
  record("Fuite 1 : propriétaire principal, incident de l'entreprise sans responsable : correction refusée et rien d'écrit", leak1.data.assignee_profile_id === null && leak1Try.error?.message === "not_authorized" && leak1Ev === 0, leak1Try.error?.message);
  const leak2 = await create(sm, projectId, { p_description: "Fuite 2 : incident du chef sans responsable" });
  const leak2Try = await move(sm, leak2.data.id, 0, "ANNULE", "Doublon");
  const { data: leak2Row } = await service.from("incidents").select("status").eq("id", leak2.data.id).single();
  record("Fuite 2 : chef non désigné, annulation de son propre incident sans responsable : refusée, reste OUVERT", leak2.data.assignee_profile_id === null && leak2Try.error?.message === "not_authorized" && leak2Row.status === "OUVERT", leak2Try.error?.message);

  // Historique (insertion seule) et visibilité.
  for (const [label, u] of [["propriétaire principal", owner], ["copropriétaire", coOwner], ["autre chef", sm2]]) {
    const h = await history(u, iC.data.id);
    const kinds = (h.data ?? []).map((e) => e.event_type);
    record(`${label} : historique complet de l'incident clos`, !h.error && kinds[0] === "CREATION" && kinds.filter((k) => k === "DESIGNATION").length === 2 && kinds.filter((k) => k === "TRANSITION").length === 5 && !kinds.includes("CORRECTION"), h.error?.message);
  }
  const oh = await history(outsider, iC.data.id);
  record("Non-membre : historique refusé", oh.error?.message === "not_authorized", oh.error?.message);
  const { data: anyEv } = await service.from("incident_events").select("id").eq("incident_id", iC.data.id).limit(1).single();
  const upEv = await service.from("incident_events").update({ reason: "falsifié" }).eq("id", anyEv.id);
  record("Événement jamais modifié (même service_role)", upEv.error?.message === "incident_event_immutable", upEv.error?.message);
  const delEv = await service.from("incident_events").delete().eq("id", anyEv.id);
  record("Événement jamais supprimé (même service_role)", delEv.error?.message === "incident_event_immutable", delEv.error?.message);
  const delInc = await service.from("incidents").delete().eq("id", iSM.data.id);
  record("Incident jamais supprimé (même service_role)", delInc.error?.message === "incident_immutable", delInc.error?.message);
  const svcReopen = await service.from("incidents").update({ status: "EN_COURS" }).eq("id", iC.data.id);
  record("Incident clos jamais rouvert (même service_role)", svcReopen.error?.message === "incident_terminal", svcReopen.error?.message);
  const svcJump = await service.from("incidents").update({ status: "RESOLU", resolution: "saut" }).eq("id", linked.data.id);
  record("Transition invalide refusée même pour service_role (OUVERT -> RESOLU)", svcJump.error?.message === "invalid_transition", svcJump.error?.message);

  // Accès retiré (EC024).
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", projectId).eq("profile_id", sm2.id);
  const rl = await list(sm2, projectId);
  record("Chef dont l'accès est retiré : liste refusée", rl.error?.message === "not_authorized", rl.error?.message);
  const rc = await create(sm2, projectId);
  record("Chef dont l'accès est retiré : déclaration refusée", rc.error?.message === "not_authorized", rc.error?.message);
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
