// Test d'intégration LOCAL uniquement : M040, validation des étapes (B019/
// B020 sur la base de M033, D179) et « Avancement validé » (D177, BR034,
// EC020). Données jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-phase-validation.mjs

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
async function user(label) {
  const email = `m040-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client, label };
}
const one = (r) => (Array.isArray(r.data) ? r.data[0] : r.data);

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const exMember = await user("ex-coproprietaire");
  const outsider = await user("hors-chantier");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  const { data: created, error: projErr } = await contractor.client.rpc("create_draft_project", { p_name: "M040 — étapes validées", p_country: "ML", p_role: "CONTRACTOR" });
  if (projErr) throw new Error(projErr.message);
  const pid = (Array.isArray(created) ? created[0] : created).project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null], [exMember, "OWNER", "CO_OWNER"]]) {
    const { error } = await service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op });
    if (error) throw new Error(`adhésion ${u.label}: ${error.message}`);
  }
  const rev = async () => one(await contractor.client.rpc("get_project_phase_plan", { p_project_id: pid })).revision;
  const details = async (u = contractor) => u.client.rpc("list_project_phase_details", { p_project_id: pid });
  const validated = async (u = contractor) => u.client.rpc("get_project_validated_progress", { p_project_id: pid });
  const declare = async (u, phaseId) => u.client.rpc("declare_phase_complete", { p_project_id: pid, p_phase_id: phaseId, p_expected_revision: await rev() });
  const decide = async (u, phaseId, decision, reason = null) => u.client.rpc("decide_phase", { p_project_id: pid, p_phase_id: phaseId, p_decision: decision, p_reason: reason, p_expected_revision: await rev() });
  const schedule = async (u, phaseId, s, e, reason) => u.client.rpc("update_phase_schedule", { p_project_id: pid, p_phase_id: phaseId, p_planned_start: s, p_planned_end: e, p_reason: reason, p_expected_revision: await rev() });

  // 1. Brouillon (B019 : modèle copié dans le chantier) et dates prévues facultatives.
  const rows = [
    { position: 1, label: "Fondations", weight: 40, planned_start: "2026-10-10", planned_end: "2026-10-31" },
    { position: 2, label: "Gros œuvre", weight: 40 },
    { position: 3, label: "Finitions", weight: 20, planned_start: "2026-12-01" },
  ];
  const badDates = await contractor.client.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: [{ position: 1, label: "X", weight: 100, planned_start: "2026-11-02", planned_end: "2026-11-01" }], p_expected_revision: 0 });
  record("Brouillon : fin prévue avant début refusée", badDates.error?.message === "phase_invalid_dates", err(badDates));
  const draft = await contractor.client.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: rows, p_expected_revision: 0 });
  const d0 = (await details()).data ?? [];
  record("Brouillon : 3 étapes copiées dans le chantier, statut BROUILLON, dates prévues facultatives conservées", !draft.error && d0.length === 3 && d0.every((p) => p.status === "BROUILLON") && d0[0].planned_end === "2026-10-31" && d0[1].planned_start === null, err(draft));
  const v0 = one(await validated());
  record("EC020 : aucune étape applicable avant publication — avancement validé non calculable (jamais 0 ni 100 %)", v0.computable === false && v0.validated_progress === null && v0.applicable_count === 0);
  const ownerDraft = await owner.client.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: rows, p_expected_revision: await rev() });
  const ownerPub = await owner.client.rpc("publish_phase_plan", { p_project_id: pid, p_expected_revision: await rev() });
  record("Propriétaire : ni création ni publication d'étapes (D179)", ownerDraft.error?.message === "not_authorized" && ownerPub.error?.message === "not_authorized", `${err(ownerDraft)} / ${err(ownerPub)}`);
  const pub = await contractor.client.rpc("publish_phase_plan", { p_project_id: pid, p_expected_revision: await rev() });
  const d1 = (await details()).data ?? [];
  const [p1, p2, p3] = d1.map((p) => p.phase_id);
  record("Publication : étapes PUBLIEE", !pub.error && d1.every((p) => p.status === "PUBLIEE"), err(pub));
  const v1 = one(await validated());
  record("Avancement validé après publication : 0/3 = 0 %, calculable", v1.computable === true && v1.applicable_count === 3 && v1.validated_count === 0 && Number(v1.validated_progress) === 0);

  // 2. Déclaration (entreprise seule).
  for (const u of [owner, coOwner, sm, outsider]) {
    const r = await declare(u, p1);
    record(`${u.label} : déclaration « terminée » refusée`, r.error?.message === "not_authorized", err(r));
  }
  // D180 (M041) : 100 % déclarés exigés, sans modification automatique.
  const at0 = await declare(contractor, p1);
  await contractor.client.rpc("update_phase_progress", { p_project_id: pid, p_phase_id: p1, p_progression: 99.5, p_expected_revision: await rev() });
  const at99 = await declare(contractor, p1);
  const d1b = (await details()).data.find((p) => p.phase_id === p1);
  record("D180 : déclaration refusée à 0 % et à 99,5 % (progression_incomplete), étape inchangée, progression non modifiée", at0.error?.message === "progression_incomplete" && at99.error?.message === "progression_incomplete" && d1b.status === "PUBLIEE" && Number(d1b.progression) === 99.5, `${err(at0)} / ${err(at99)}`);
  await contractor.client.rpc("update_phase_progress", { p_project_id: pid, p_phase_id: p1, p_progression: 100, p_expected_revision: await rev() });
  const globalBefore = Number(one(await contractor.client.rpc("get_project_phase_plan", { p_project_id: pid })).global_progress);
  const declared = await declare(contractor, p1);
  const d2 = (await details()).data.find((p) => p.phase_id === p1);
  record("Entreprise : déclare l'étape terminée à 100 % (TERMINEE, date réelle automatique)", !declared.error && d2.status === "TERMINEE" && !!d2.declared_completed_at && Number(d2.progression) === 100, err(declared));
  const again = await declare(contractor, p1);
  record("Déclarer à nouveau une étape déjà déclarée : transition invalide", again.error?.message === "invalid_transition", err(again));
  const globalAfter = Number(one(await contractor.client.rpc("get_project_phase_plan", { p_project_id: pid })).global_progress);
  record("Déclarer terminée ne change pas l'avancement déclaré (deux mesures distinctes)", globalBefore === 40 && globalAfter === globalBefore, `${globalBefore} -> ${globalAfter}`);

  // 3. Décision (propriétaire principal seul, D179).
  for (const u of [contractor, coOwner, sm, outsider]) {
    const r = await decide(u, p1, "VALIDEE");
    record(`${u.label} : validation refusée`, r.error?.message === "not_authorized", err(r));
  }
  const notDeclared = await decide(owner, p2, "VALIDEE");
  record("Valider une étape non déclarée terminée : transition invalide", notDeclared.error?.message === "invalid_transition", err(notDeclared));
  const badDecision = await decide(owner, p1, "APPROUVEE");
  record("Décision inconnue refusée", badDecision.error?.message === "decision_invalid", err(badDecision));
  const noReason = await decide(owner, p1, "REFUSEE", " ");
  record("Refus sans motif refusé", noReason.error?.message === "reason_required", err(noReason));
  const refused = await decide(owner, p1, "REFUSEE", "Fissures sur la semelle nord");
  const d3 = (await details()).data.find((p) => p.phase_id === p1);
  record("Propriétaire principal : refuse avec motif (REFUSEE, motif et date conservés)", !refused.error && d3.status === "REFUSEE" && d3.last_refusal_reason === "Fissures sur la semelle nord" && !!d3.refused_at, err(refused));
  const validateRefused = await decide(owner, p1, "VALIDEE");
  record("Valider une étape refusée sans nouvelle déclaration : transition invalide", validateRefused.error?.message === "invalid_transition", err(validateRefused));
  const redeclared = await declare(contractor, p1);
  record("Entreprise : déclare à nouveau terminée une étape refusée", !redeclared.error && (await details()).data.find((p) => p.phase_id === p1).status === "TERMINEE", err(redeclared));
  const ok = await decide(owner, p1, "VALIDEE");
  const d4 = (await details()).data.find((p) => p.phase_id === p1);
  record("Propriétaire principal : valide (VALIDEE, date de validation)", !ok.error && d4.status === "VALIDEE" && !!d4.validated_at, err(ok));
  const twice = await decide(owner, p1, "VALIDEE");
  record("Valider deux fois : transition invalide", twice.error?.message === "invalid_transition", err(twice));
  const v2 = one(await validated(owner));
  record("Avancement validé = 1/3 (BR034, AC050)", v2.computable && v2.validated_count === 1 && v2.applicable_count === 3 && Number(v2.validated_progress) === 33.33, String(v2.validated_progress));
  const { data: lastEv } = await service.from("project_phase_events").select("event_type, computed_validated_progress, actor_role").eq("project_id", pid).order("event_seq", { ascending: false }).limit(1).single();
  record("Historique : validation tracée par le propriétaire, avancement validé figé à l'instant", lastEv.event_type === "PHASE_VALIDATED" && lastEv.actor_role === "OWNER" && Number(lastEv.computed_validated_progress) === 33.33);
  const { count: audits } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("project_id", pid).in("action", ["PHASE_DECLARED_COMPLETE", "PHASE_VALIDATED", "PHASE_REFUSED"]);
  record("Audit : 2 déclarations, 1 refus, 1 validation", audits === 4, String(audits));

  // 4. Étape validée figée.
  const prog = await contractor.client.rpc("update_phase_progress", { p_project_id: pid, p_phase_id: p1, p_progression: 50, p_expected_revision: await rev() });
  record("Étape validée : progression non modifiable", prog.error?.message === "phase_validated_immutable", err(prog));
  const sch = await schedule(contractor, p1, "2026-10-01", "2026-10-20", "Recalage");
  record("Étape validée : dates prévues non modifiables", sch.error?.message === "phase_validated_immutable", err(sch));
  const current = (await details()).data;
  const restructRename = await contractor.client.rpc("restructure_phase_plan", { p_project_id: pid, p_phases: current.map((p, i) => ({ phase_id: p.phase_id, position: i + 1, label: p.phase_id === p1 ? "Fondations renommées" : p.label, weight: Number(p.weight) })), p_reason: "Renommage", p_expected_revision: await rev() });
  record("Étape validée : libellé non modifiable par restructuration", restructRename.error?.message === "phase_validated_immutable", err(restructRename));
  const restructDrop = await contractor.client.rpc("restructure_phase_plan", { p_project_id: pid, p_phases: [{ phase_id: p2, position: 1, label: "Gros œuvre", weight: 60 }, { phase_id: p3, position: 2, label: "Finitions", weight: 40 }], p_reason: "Retrait", p_expected_revision: await rev() });
  record("Étape validée : jamais retirée (archivage refusé)", restructDrop.error?.message === "phase_validated_immutable", err(restructDrop));
  // M041 : insertion avant une étape existante (en tête et au milieu),
  // y compris avant l'étape validée ; contenu validé et historique intacts.
  const snap = async () => (await service.from("project_phase_events").select("event_seq, event_type, previous_value, new_value, reason, computed_global_progress").eq("project_id", pid).order("event_seq")).data;
  const frozen = async () => (await service.from("project_phases").select("label, weight, progression, status, validated_at, planned_start, planned_end, archived_at").eq("id", p1).single()).data;
  const p1Before = await frozen();
  const evBefore = await snap();
  const head = await contractor.client.rpc("restructure_phase_plan", { p_project_id: pid, p_phases: [
    { position: 1, label: "Implantation", weight: 10 },
    { phase_id: p1, position: 2, label: "Fondations", weight: 40 },
    { phase_id: p2, position: 3, label: "Gros œuvre", weight: 30 },
    { phase_id: p3, position: 4, label: "Finitions", weight: 20 },
  ], p_reason: "Ajout de l'implantation en tête", p_expected_revision: await rev() });
  const dh = (await details()).data;
  record("Insertion EN TÊTE avant l'étape validée : acceptée, positions 1 à 4 dans l'ordre voulu", !head.error && dh.map((p) => p.label).join("|") === "Implantation|Fondations|Gros œuvre|Finitions" && dh.map((p) => p.position).join() === "1,2,3,4", err(head));
  const mid = await contractor.client.rpc("restructure_phase_plan", { p_project_id: pid, p_phases: [
    { phase_id: dh[0].phase_id, position: 1, label: "Implantation", weight: 10 },
    { phase_id: p1, position: 2, label: "Fondations", weight: 40 },
    { position: 3, label: "Toiture", weight: 10 },
    { phase_id: p2, position: 4, label: "Gros œuvre", weight: 20 },
    { phase_id: p3, position: 5, label: "Finitions", weight: 20 },
  ], p_reason: "Ajout de la toiture", p_expected_revision: await rev() });
  const dm = (await details()).data;
  record("Insertion AU MILIEU : acceptée, nouvelle étape PUBLIEE à la position 3", !mid.error && dm.map((p) => p.label).join("|") === "Implantation|Fondations|Toiture|Gros œuvre|Finitions" && dm.find((p) => p.label === "Toiture").status === "PUBLIEE", err(mid));
  const swap = await contractor.client.rpc("restructure_phase_plan", { p_project_id: pid, p_phases: [
    { phase_id: dm[0].phase_id, position: 1, label: "Implantation", weight: 10 },
    { phase_id: p1, position: 2, label: "Fondations", weight: 40 },
    { phase_id: dm[2].phase_id, position: 3, label: "Toiture", weight: 10 },
    { phase_id: p3, position: 4, label: "Finitions", weight: 20 },
    { phase_id: p2, position: 5, label: "Gros œuvre", weight: 20 },
  ], p_reason: "Inversion gros œuvre / finitions", p_expected_revision: await rev() });
  const ds = (await details()).data;
  record("Inversion de deux étapes (permutation) : acceptée", !swap.error && ds.map((p) => p.label).join("|") === "Implantation|Fondations|Toiture|Finitions|Gros œuvre", err(swap));
  const p1After = await frozen();
  record("Étape validée : contenu inchangé (libellé, poids, progression, statut, dates), seule sa position a changé", JSON.stringify(p1Before) === JSON.stringify(p1After) && ds.find((p) => p.phase_id === p1).position === 2);
  const evAfter = await snap();
  record("Historique : événements antérieurs identiques, 3 événements STRUCTURE_CHANGED ajoutés", JSON.stringify(evAfter.slice(0, evBefore.length)) === JSON.stringify(evBefore) && evAfter.length === evBefore.length + 3 && evAfter.slice(evBefore.length).every((e) => e.event_type === "STRUCTURE_CHANGED"));
  const dup = await contractor.client.rpc("restructure_phase_plan", { p_project_id: pid, p_phases: [
    { phase_id: p1, position: 1, label: "Fondations", weight: 50 },
    { phase_id: p1, position: 2, label: "Fondations", weight: 50 },
  ], p_reason: "Doublon", p_expected_revision: await rev() });
  record("Même étape présente deux fois dans la liste : refusée", dup.error?.message === "phase_invalid_position", err(dup));
  const v3 = one(await validated());
  record("Avancement validé recalculé : 1/5 = 20 %", Number(v3.validated_progress) === 20 && v3.applicable_count === 5);

  // 5. Dates prévues après publication : motif et trace ; dates réelles automatiques.
  const sNo = await schedule(contractor, p2, "2026-11-01", "2026-11-30", " ");
  record("Dates prévues après publication sans motif refusées", sNo.error?.message === "reason_required", err(sNo));
  const sBad = await schedule(contractor, p2, "2026-11-30", "2026-11-01", "Inversé");
  record("Dates prévues incohérentes refusées", sBad.error?.message === "phase_invalid_dates", err(sBad));
  const sOwner = await schedule(owner, p2, "2026-11-01", "2026-11-30", "Propriétaire");
  record("Propriétaire : dates prévues non modifiables", sOwner.error?.message === "not_authorized", err(sOwner));
  const sOk = await schedule(contractor, p2, "2026-11-01", "2026-11-30", "Livraison des parpaings décalée");
  const { data: sEv } = await service.from("project_phase_events").select("event_type, reason").eq("project_id", pid).order("event_seq", { ascending: false }).limit(1).single();
  record("Entreprise : dates prévues modifiées avec motif, tracées", !sOk.error && sEv.event_type === "PHASE_SCHEDULE_CHANGED" && sEv.reason === "Livraison des parpaings décalée", err(sOk));
  await contractor.client.rpc("update_phase_progress", { p_project_id: pid, p_phase_id: p2, p_progression: 30, p_expected_revision: await rev() });
  record("Date réelle de début automatique au premier avancement", !!(await details()).data.find((p) => p.phase_id === p2).started_at);

  // 6. Gardes en base, même pour service_role.
  const jump = await service.from("project_phases").update({ status: "VALIDEE" }).eq("id", p2);
  record("Transition invalide refusée même pour service_role (PUBLIEE -> VALIDEE)", !!jump.error, err(jump));
  const back = await service.from("project_phases").update({ status: "PUBLIEE" }).eq("id", p1);
  const relabel = await service.from("project_phases").update({ label: "falsifié" }).eq("id", p1);
  record("Étape validée figée même pour service_role", back.error?.message === "phase_validated_immutable" && relabel.error?.message === "phase_validated_immutable", `${err(back)} / ${err(relabel)}`);
  const del = await service.from("project_phases").delete().eq("id", p3);
  record("Étape jamais supprimée (même service_role)", del.error?.message === "phase_immutable", err(del));

  // 7. Lecture : copropriétaire en lecture ; drapeaux d'action ; non-membre, ex-membre, sans session.
  await contractor.client.rpc("update_phase_progress", { p_project_id: pid, p_phase_id: p2, p_progression: 100, p_expected_revision: await rev() });
  const p2Declared = await declare(contractor, p2);
  record("Entreprise : déclare une autre étape à 100 %", !p2Declared.error, err(p2Declared));
  const coD = await details(coOwner);
  const coV = await validated(coOwner);
  record("Copropriétaire : lit étapes et avancement validé, sans aucune action", !coD.error && !coV.error && coD.data.every((p) => !p.can_declare && !p.can_decide && !p.can_edit_schedule), `${err(coD)} / ${err(coV)}`);
  const ownD = (await details(owner)).data;
  record("Propriétaire principal : peut décider seulement l'étape déclarée terminée", ownD.filter((p) => p.can_decide).map((p) => p.phase_id).join() === p2 && ownD.every((p) => !p.can_declare));
  const ctD = (await details(contractor)).data;
  record("Entreprise : peut déclarer les étapes publiées ou refusées, jamais décider", ctD.every((p) => !p.can_decide) && ctD.find((p) => p.phase_id === p1).can_declare === false && ctD.find((p) => p.label === "Toiture").can_declare === true);
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", exMember.id);
  for (const u of [exMember, outsider]) {
    const a = await details(u);
    const b = await validated(u);
    const c = await u.client.rpc("list_phase_event_details", { p_project_id: pid });
    record(`${u.label} : étapes, avancement validé et historique refusés`, a.error?.message === "not_authorized" && b.error?.message === "not_authorized" && c.error?.message === "not_authorized", [a, b, c].map(err).join(" / "));
  }
  const an = await details(anon);
  record("Visiteur sans session : refusé", !!an.error, err(an));
  const tbl = await owner.client.from("project_phases").select("id").limit(1);
  record("Lecture directe de la table refusée", tbl.error?.code === "42501", tbl.error?.code);
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
