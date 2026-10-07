// Test d'intégration LOCAL uniquement : M042, lien des journaux et des
// incidents vers une étape (D182). Données jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-phase-links.mjs

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
const err = (r) => r?.error?.message ?? r?.error?.code ?? "aucune erreur";
const one = (r) => (Array.isArray(r.data) ? r.data[0] : r.data);
async function user(label) {
  const email = `m042-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client, label };
}
async function project(u, name) {
  const { data, error } = await u.client.rpc("create_draft_project", { p_name: name, p_country: "ML", p_role: "CONTRACTOR" });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data[0] : data).project_id;
}
const planRev = async (u, pid) => one(await u.client.rpc("get_project_phase_plan", { p_project_id: pid })).revision ?? 0;
async function plan(u, pid, rows, publish) {
  const d = await u.client.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: rows, p_expected_revision: 0 });
  if (d.error) throw new Error(`brouillon: ${d.error.message}`);
  if (publish) {
    const p = await u.client.rpc("publish_phase_plan", { p_project_id: pid, p_expected_revision: await planRev(u, pid) });
    if (p.error) throw new Error(`publication: ${p.error.message}`);
  }
  return ((await u.client.rpc("list_project_phase_details", { p_project_id: pid })).data ?? []).map((p) => p.phase_id);
}
const phaseRow = async (id) => (await service.from("project_phases").select("label, weight, progression, status, validated_at, planned_start, planned_end, archived_at, position").eq("id", id).single()).data;

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const outsider = await user("hors-chantier");
  const contractorB = await user("entreprise-b");
  const pid = await project(contractor, "M042 — liens");
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null]]) {
    const { error } = await service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op });
    if (error) throw new Error(error.message);
  }
  const [s1, s2, s3] = await plan(contractor, pid, [
    { position: 1, label: "Fondations", weight: 40 },
    { position: 2, label: "Gros œuvre", weight: 40 },
    { position: 3, label: "Toiture", weight: 20 },
  ], true);
  // s1 validée ; s3 retirée (archivée).
  await contractor.client.rpc("update_phase_progress", { p_project_id: pid, p_phase_id: s1, p_progression: 100, p_expected_revision: await planRev(contractor, pid) });
  await contractor.client.rpc("declare_phase_complete", { p_project_id: pid, p_phase_id: s1, p_expected_revision: await planRev(contractor, pid) });
  await owner.client.rpc("decide_phase", { p_project_id: pid, p_phase_id: s1, p_decision: "VALIDEE", p_reason: null, p_expected_revision: await planRev(contractor, pid) });
  const r3 = await contractor.client.rpc("restructure_phase_plan", { p_project_id: pid, p_phases: [
    { phase_id: s1, position: 1, label: "Fondations", weight: 40 },
    { phase_id: s2, position: 2, label: "Gros œuvre", weight: 60 },
  ], p_reason: "Toiture retirée", p_expected_revision: await planRev(contractor, pid) });
  if (r3.error) throw new Error(`retrait: ${r3.error.message}`);
  const s1Before = await phaseRow(s1);
  // Autre chantier (plan publié) ; chantier du même entrepreneur au plan non publié.
  const pidB = await project(contractorB, "M042 — autre chantier");
  const [b1] = await plan(contractorB, pidB, [{ position: 1, label: "Autre", weight: 100 }], true);
  const pidC = await project(contractor, "M042 — plan non publié");
  const [c1] = await plan(contractor, pidC, [{ position: 1, label: "Non publiée", weight: 100 }], false);

  // 1. Journal en brouillon.
  const draft = (pidX, date, phase) => contractor.client.rpc("create_daily_log_draft", { p_project_id: pidX, p_log_date: date, p_works_done: "Coulage", p_difficulties: null, p_team: null, p_next_actions: null, p_phase_id: phase });
  const jB = await draft(pid, "2026-10-01", b1);
  record("Journal : étape d'un autre chantier refusée", jB.error?.message === "phase_link_invalid", err(jB));
  const jArch = await draft(pid, "2026-10-01", s3);
  record("Journal : étape retirée (inactive) refusée", jArch.error?.message === "phase_link_invalid", err(jArch));
  const jUnpub = await draft(pidC, "2026-10-01", c1);
  record("Journal : étape d'un plan non publié refusée", jUnpub.error?.message === "phase_link_invalid", err(jUnpub));
  const jNone = await draft(pid, "2026-10-02", null);
  record("Journal : lien facultatif (aucune étape)", !jNone.error && jNone.data.phase_id === null, err(jNone));
  const jVal = await draft(pid, "2026-10-01", s1);
  record("Journal : étape validée ciblable", !jVal.error && jVal.data.phase_id === s1, err(jVal));
  const logId = jVal.data.id;
  const upd = (rev, phase) => contractor.client.rpc("update_daily_log_draft", { p_log_id: logId, p_expected_revision: rev, p_log_date: "2026-10-01", p_works_done: "Coulage", p_difficulties: null, p_team: null, p_next_actions: null, p_phase_id: phase });
  const u1 = await upd(0, s2);
  const u2 = await upd(1, b1);
  record("Brouillon : lien changé librement (s1 -> s2) ; étape d'un autre chantier refusée", !u1.error && u1.data.phase_id === s2 && u2.error?.message === "phase_link_invalid", `${err(u1)} / ${err(u2)}`);
  const pub = await contractor.client.rpc("publish_daily_log_draft", { p_log_id: logId, p_expected_revision: 1 });
  const { data: v1 } = await service.from("daily_log_versions").select("id, phase_id").eq("daily_log_id", logId).eq("version_number", 1).single();
  record("Publication : la version 1 porte le lien du brouillon", !pub.error && v1.phase_id === s2, err(pub));

  // 2. Lecture du lien par ceux qui voient le journal.
  for (const u of [contractor, owner, coOwner, sm]) {
    const l = await u.client.rpc("list_published_daily_logs", { p_project_id: pid });
    const row = (l.data ?? []).find((r) => r.daily_log_id === logId);
    record(`${u.label} : voit l'étape liée au journal publié`, row?.phase_id === s2 && row?.phase_label === "Gros œuvre" && row?.phase_archived === false, err(l));
  }
  const ol = await outsider.client.rpc("list_published_daily_logs", { p_project_id: pid });
  record("Non-membre : journaux (et liens) refusés", ol.error?.message === "not_authorized", err(ol));

  // 3. Lien d'un journal publié : seulement par correction motivée.
  const direct = await service.from("daily_logs").update({ phase_id: s1 }).eq("id", logId);
  record("Journal publié : lien non modifiable hors correction (même service_role)", direct.error?.message === "daily_log_published_immutable", err(direct));
  const verMut = await service.from("daily_log_versions").update({ phase_id: s1 }).eq("id", v1.id);
  record("Version publiée : lien jamais réécrit", verMut.error?.message === "daily_log_version_immutable", err(verMut));
  const corr = (version, reason, phase) => contractor.client.rpc("correct_daily_log", { p_log_id: logId, p_expected_version_number: version, p_reason: reason, p_works_done: "Coulage", p_difficulties: null, p_team: null, p_next_actions: null, p_phase_id: phase });
  const cNo = await corr(1, " ", s1);
  record("Correction du lien sans motif refusée", cNo.error?.message === "reason_required", err(cNo));
  const cBad = await corr(1, "Mauvais chantier", b1);
  record("Correction vers une étape d'un autre chantier refusée", cBad.error?.message === "phase_link_invalid", err(cBad));
  const cOk = await corr(1, "Le coulage concerne les fondations", s1);
  const { data: v1Again } = await service.from("daily_log_versions").select("phase_id").eq("id", v1.id).single();
  record("Correction motivée : version 2 liée à l'étape validée, version 1 garde son lien", !cOk.error && cOk.data.phase_id === s1 && cOk.data.version_number === 2 && v1Again.phase_id === s2, err(cOk));
  const { data: auditCorr } = await service.from("audit_events").select("context").eq("target_id", cOk.data.id).eq("action", "DAILY_LOG_CORRECT").single();
  record("Correction tracée : ancien et nouveau lien dans l'audit", auditCorr.context.previous_phase_id === s2 && auditCorr.context.phase_id === s1);
  const ownerCorr = await owner.client.rpc("correct_daily_log", { p_log_id: logId, p_expected_version_number: 2, p_reason: "Propriétaire", p_works_done: "x", p_difficulties: null, p_team: null, p_next_actions: null, p_phase_id: s2 });
  record("Propriétaire : correction du lien refusée", ownerCorr.error?.message === "not_authorized", err(ownerCorr));

  // 4. Incidents.
  const inc = (phase) => contractor.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "MALFACON", p_severity: "MOYENNE", p_occurred_at: new Date(Date.now() - 3600_000).toISOString(), p_description: "Fissure sur la dalle", p_linked_incident_id: null, p_phase_id: phase });
  const iB = await inc(b1);
  const iArch = await inc(s3);
  record("Incident : étape d'un autre chantier et étape retirée refusées", iB.error?.message === "phase_link_invalid" && iArch.error?.message === "phase_link_invalid", `${err(iB)} / ${err(iArch)}`);
  const iOk = await inc(s1);
  record("Incident : lié à l'étape validée", !iOk.error && iOk.data.phase_id === s1, err(iOk));
  const incCorr = (u, rev, reason, phase) => u.client.rpc("correct_incident", { p_incident_id: iOk.data.id, p_expected_revision: rev, p_reason: reason, p_incident_type: "MALFACON", p_severity: "MOYENNE", p_occurred_at: iOk.data.occurred_at, p_description: "Fissure sur la dalle", p_phase_id: phase });
  const icNo = await incCorr(contractor, 0, " ", s2);
  record("Incident : changement de lien sans motif refusé", icNo.error?.message === "reason_required", err(icNo));
  const icBad = await incCorr(contractor, 0, "Autre chantier", b1);
  record("Incident : changement vers une étape d'un autre chantier refusé", icBad.error?.message === "phase_link_invalid", err(icBad));
  const icOwner = await incCorr(owner, 0, "Propriétaire", s2);
  record("Incident : propriétaire (sans droit de modifier cet incident) refusé", icOwner.error?.message === "not_authorized", err(icOwner));
  const icOk = await incCorr(contractor, 0, "La fissure est dans le gros œuvre", s2);
  const { data: ev } = await service.from("incident_events").select("changes, reason").eq("incident_id", iOk.data.id).eq("event_type", "CORRECTION").single();
  record("Incident : lien corrigé avec motif, ancien et nouveau lien tracés", !icOk.error && icOk.data.phase_id === s2 && ev.changes.phase_id.old === s1 && ev.changes.phase_id.new === s2 && ev.reason === "La fissure est dans le gros œuvre", err(icOk));
  for (const u of [owner, coOwner, sm]) {
    const l = await u.client.rpc("list_project_incidents", { p_project_id: pid });
    const row = (l.data ?? []).find((r) => r.id === iOk.data.id);
    record(`${u.label} : voit l'étape liée à l'incident`, row?.phase_id === s2 && row?.phase_label === "Gros œuvre", err(l));
  }
  const oi = await outsider.client.rpc("list_project_incidents", { p_project_id: pid });
  record("Non-membre : incidents (et liens) refusés", oi.error?.message === "not_authorized", err(oi));
  const fkB = await service.from("incidents").update({ phase_id: b1 }).eq("id", iOk.data.id);
  record("Clé étrangère : étape d'un autre chantier impossible même pour service_role", !!fkB.error, err(fkB));

  // 5. L'étape ciblée n'est jamais modifiée.
  record("Étape validée ciblée : inchangée (libellé, poids, progression, statut, dates, position)", JSON.stringify(await phaseRow(s1)) === JSON.stringify(s1Before));

  // 6. Étape retirée après coup : publication d'un brouillon lié refusée ; lien conservé tel quel ensuite.
  const d2 = await draft(pid, "2026-10-03", s2);
  const rm = await contractor.client.rpc("restructure_phase_plan", { p_project_id: pid, p_phases: [
    { phase_id: s1, position: 1, label: "Fondations", weight: 40 },
    { position: 2, label: "Gros œuvre (nouveau découpage)", weight: 60 },
  ], p_reason: "Redécoupage", p_expected_revision: await planRev(contractor, pid) });
  const pubArch = await contractor.client.rpc("publish_daily_log_draft", { p_log_id: d2.data.id, p_expected_revision: 0 });
  record("Brouillon lié à une étape retirée depuis : publication refusée (choisir une étape active)", !rm.error && pubArch.error?.message === "phase_link_invalid", `${err(rm)} / ${err(pubArch)}`);
  const ownerAfter = (await owner.client.rpc("list_project_incidents", { p_project_id: pid })).data.find((r) => r.id === iOk.data.id);
  record("Incident lié à une étape retirée : lien conservé, marqué comme retiré", ownerAfter.phase_id === s2 && ownerAfter.phase_archived === true);
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
