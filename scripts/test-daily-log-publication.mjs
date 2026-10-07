// Test d'intégration LOCAL uniquement : M037, publication et correction du
// journal quotidien (B022, D151–D156). Données jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-daily-log-publication.mjs

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
  const email = `m037-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client };
}
const draft = (client, projectId, date, works = "Coulage dalle") =>
  client.rpc("create_daily_log_draft", { p_project_id: projectId, p_log_date: date, p_works_done: works, p_difficulties: null, p_team: "3 maçons", p_next_actions: null });
const publish = (client, logId, revision) => client.rpc("publish_daily_log_draft", { p_log_id: logId, p_expected_revision: revision });
const correct = (client, logId, version, reason, works = "Coulage dalle corrigé") =>
  client.rpc("correct_daily_log", { p_log_id: logId, p_expected_version_number: version, p_reason: reason, p_works_done: works, p_difficulties: null, p_team: "4 maçons", p_next_actions: null });
const list = (client, projectId) => client.rpc("list_published_daily_logs", { p_project_id: projectId });
const history = (client, logId) => client.rpc("get_daily_log_history", { p_log_id: logId });

try {
  const contractor = await user("entreprise");
  const siteManager = await user("chef");
  const siteManager2 = await user("chef2");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const outsider = await user("hors-chantier");
  const { data: created, error: projErr } = await contractor.client.rpc("create_draft_project", { p_name: "M037 — journal publié", p_country: "ML", p_role: "CONTRACTOR" });
  if (projErr) throw new Error(projErr.message);
  const projectId = (Array.isArray(created) ? created[0] : created).project_id;
  for (const [u, role, ownerProfile] of [[siteManager, "SITE_MANAGER", null], [siteManager2, "SITE_MANAGER", null], [owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"]]) {
    const { error } = await service.from("project_memberships").insert({ project_id: projectId, profile_id: u.id, role, owner_profile: ownerProfile });
    if (error) throw new Error(`adhésion ${role}: ${error.message}`);
  }
  const d1 = "2026-10-06";

  // Publication par l'auteur seul (FR056, AC056).
  const c1 = await draft(contractor.client, projectId, d1);
  const smPub = await publish(siteManager.client, c1.data.id, 0);
  record("Autre membre : publication du brouillon d'un autre refusée", smPub.error?.message === "not_authorized", smPub.error?.message);
  const ownPub = await publish(owner.client, c1.data.id, 0);
  record("Propriétaire : publication refusée", ownPub.error?.message === "not_authorized", ownPub.error?.message);
  const stalePub = await publish(contractor.client, c1.data.id, 5);
  record("Publication sur révision périmée refusée", stalePub.error?.message === "revision_conflict", stalePub.error?.message);
  const p1 = await publish(contractor.client, c1.data.id, 0);
  record("Auteur : publie (PUBLIE, heure serveur, version courante)", !p1.error && p1.data.status === "PUBLIE" && !!p1.data.published_at_server && !!p1.data.current_version_id, p1.error?.message);
  const { data: v1 } = await service.from("daily_log_versions").select("*").eq("daily_log_id", c1.data.id);
  record("Version 1 attribuée (auteur, rôle CONTRACTOR), sans motif", v1?.length === 1 && v1[0].version_number === 1 && v1[0].published_by_profile_id === contractor.id && v1[0].published_by_role === "CONTRACTOR" && v1[0].reason === null);
  const { count: auditPub } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("target_id", v1[0].id).eq("action", "DAILY_LOG_PUBLISH");
  record("Publication tracée dans audit_events", auditPub === 1);
  const rePub = await publish(contractor.client, c1.data.id, 1);
  record("Journal déjà publié : seconde publication refusée", rePub.error?.message === "not_authorized", rePub.error?.message);
  const editPub = await contractor.client.rpc("update_daily_log_draft", { p_log_id: c1.data.id, p_expected_revision: 1, p_log_date: d1, p_works_done: "x", p_difficulties: null, p_team: null, p_next_actions: null });
  record("Journal publié : plus modifiable comme brouillon", editPub.error?.message === "not_authorized", editPub.error?.message);
  const archPub = await contractor.client.rpc("archive_daily_log_draft", { p_log_id: c1.data.id, p_expected_revision: 1 });
  record("Journal publié : pas archivable comme brouillon", archPub.error?.message === "not_authorized", archPub.error?.message);
  const drafts = await contractor.client.rpc("list_my_daily_log_drafts", { p_project_id: projectId });
  record("Journal publié absent de « mes brouillons »", !drafts.error && !drafts.data.some((r) => r.id === c1.data.id));

  // D153 : au moins une rubrique.
  const empty = await contractor.client.rpc("create_daily_log_draft", { p_project_id: projectId, p_log_date: "2026-10-04", p_works_done: " ", p_difficulties: null, p_team: null, p_next_actions: null });
  const emptyPub = await publish(contractor.client, empty.data.id, 0);
  record("Brouillon vide : publication refusée (daily_log_empty)", emptyPub.error?.message === "daily_log_empty", emptyPub.error?.message);

  // D155 : nouveau brouillon même auteur, chantier et date refusé.
  const again = await draft(contractor.client, projectId, d1, "doublon");
  record("Après publication, nouveau brouillon même date : refusé", again.error?.message === "daily_log_already_published", again.error?.message);
  const other = await draft(contractor.client, projectId, "2026-10-05");
  const move = await contractor.client.rpc("update_daily_log_draft", { p_log_id: other.data.id, p_expected_revision: 0, p_log_date: d1, p_works_done: "x", p_difficulties: null, p_team: null, p_next_actions: null });
  record("Brouillon déplacé vers une date déjà publiée : refusé", move.error?.message === "daily_log_already_published", move.error?.message);
  const smSame = await draft(siteManager.client, projectId, d1, "Ferraillage");
  record("Chef : son propre brouillon pour la même date reste possible", !smSame.error, smSame.error?.message);

  // Correction (FR058, D151, D152) : motif obligatoire, nouvelle version liée.
  const noReason = await correct(contractor.client, c1.data.id, 1, "  ");
  record("Correction sans motif refusée (EC025)", noReason.error?.message === "reason_required", noReason.error?.message);
  const k1 = await correct(contractor.client, c1.data.id, 1, "Effectif erroné");
  record("Auteur : corrige (version 2 liée à la version 1, motif)", !k1.error && k1.data.version_number === 2 && k1.data.supersedes_version_id === v1[0].id && k1.data.reason === "Effectif erroné", k1.error?.message);
  const staleCorr = await correct(contractor.client, c1.data.id, 1, "Concurrence");
  record("Correction sur version périmée refusée", staleCorr.error?.message === "revision_conflict", staleCorr.error?.message);
  const emptyCorr = await contractor.client.rpc("correct_daily_log", { p_log_id: c1.data.id, p_expected_version_number: 2, p_reason: "Vider", p_works_done: "", p_difficulties: null, p_team: null, p_next_actions: null });
  record("Correction vide refusée", emptyCorr.error?.message === "daily_log_empty", emptyCorr.error?.message);
  const smCorr = await correct(siteManager.client, c1.data.id, 2, "Pas mon journal");
  record("Chef : correction du journal de l'entreprise refusée", smCorr.error?.message === "not_authorized", smCorr.error?.message);
  const { count: auditCorr } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("target_id", k1.data.id).eq("action", "DAILY_LOG_CORRECT").eq("reason", "Effectif erroné");
  record("Correction tracée avec motif dans audit_events", auditCorr === 1);

  // Journal du chef : corrigé par son auteur ou par l'entreprise ; jamais par un autre chef.
  const pSm = await publish(siteManager.client, smSame.data.id, 0);
  record("Chef : publie son journal (rôle SITE_MANAGER)", !pSm.error && pSm.data.status === "PUBLIE", pSm.error?.message);
  const sm2Corr = await correct(siteManager2.client, smSame.data.id, 1, "Autre chef");
  record("Autre chef : correction refusée", sm2Corr.error?.message === "not_authorized", sm2Corr.error?.message);
  const ctCorr = await correct(contractor.client, smSame.data.id, 1, "Relecture entreprise");
  record("Entreprise : corrige le journal du chef (D151)", !ctCorr.error && ctCorr.data.version_number === 2 && ctCorr.data.published_by_role === "CONTRACTOR", ctCorr.error?.message);
  const smOwnCorr = await correct(siteManager.client, smSame.data.id, 2, "Précision auteur");
  record("Chef : corrige son propre journal (version 3)", !smOwnCorr.error && smOwnCorr.data.version_number === 3, smOwnCorr.error?.message);

  // Version publiée jamais modifiée.
  const mutate = await service.from("daily_log_versions").update({ works_done: "falsifié" }).eq("id", v1[0].id);
  record("Version publiée jamais modifiée (même service_role)", mutate.error?.message === "daily_log_version_immutable", mutate.error?.message);
  const delV = await service.from("daily_log_versions").delete().eq("id", v1[0].id);
  record("Version publiée jamais supprimée (même service_role)", delV.error?.message === "daily_log_version_immutable", delV.error?.message);
  const mutLog = await service.from("daily_logs").update({ works_done: "falsifié" }).eq("id", c1.data.id);
  record("Contenu d'un journal publié figé (même service_role)", mutLog.error?.message === "daily_log_published_immutable", mutLog.error?.message);
  const backDraft = await service.from("daily_logs").update({ status: "BROUILLON" }).eq("id", c1.data.id);
  record("Journal publié jamais repassé en brouillon", !!backDraft.error, backDraft.error?.message);
  const { data: v1After } = await service.from("daily_log_versions").select("works_done, team").eq("id", v1[0].id).single();
  record("Version 1 toujours lisible et inchangée", v1After.works_done === "Coulage dalle" && v1After.team === "3 maçons");

  // Lecture : propriétaires et membres voient publiés + historique, jamais les brouillons (D156).
  for (const [label, u] of [["propriétaire principal", owner], ["copropriétaire", coOwner], ["autre chef", siteManager2]]) {
    const l = await list(u.client, projectId);
    const ids = (l.data ?? []).map((r) => r.daily_log_id);
    record(`${label} : voit les 2 journaux publiés, aucun brouillon`, !l.error && ids.length === 2 && ids.includes(c1.data.id) && ids.includes(smSame.data.id) && !ids.includes(other.data.id) && !ids.includes(empty.data.id), l.error?.message);
    const cur = l.data?.find((r) => r.daily_log_id === c1.data.id);
    record(`${label} : version courante (v2, motif, rôle)`, cur?.current_version_number === 2 && cur?.current_reason === "Effectif erroné" && cur?.works_done === "Coulage dalle corrigé" && cur?.current_published_by_role === "CONTRACTOR");
    const h = await history(u.client, c1.data.id);
    record(`${label} : historique complet (v2 puis v1, motifs, dates)`, !h.error && h.data.length === 2 && h.data[0].version_number === 2 && h.data[1].version_number === 1 && h.data[1].works_done === "Coulage dalle" && h.data.every((v) => !!v.created_at_server), h.error?.message);
    const hd = await history(u.client, other.data.id);
    record(`${label} : historique d'un brouillon refusé`, hd.error?.message === "not_authorized", hd.error?.message);
    const cc = await correct(u.client, c1.data.id, 2, "Tentative");
    record(`${label} : correction refusée`, cc.error?.message === "not_authorized", cc.error?.message);
  }
  const ownerList = await list(owner.client, projectId);
  record("Propriétaire : aucun droit de correction affiché", ownerList.data.every((r) => r.can_correct === false));
  const smList = await list(siteManager.client, projectId);
  record("Chef : droit de correction sur son journal seulement", smList.data.find((r) => r.daily_log_id === smSame.data.id)?.can_correct === true && smList.data.find((r) => r.daily_log_id === c1.data.id)?.can_correct === false);
  const tbl = await owner.client.from("daily_log_versions").select("id").limit(1);
  record("Propriétaire : lecture directe de la table des versions refusée", tbl.error?.code === "42501", tbl.error?.code);

  // Non-membre et sans session : rien.
  const ol = await list(outsider.client, projectId);
  record("Non-membre : liste refusée", ol.error?.message === "not_authorized", ol.error?.message);
  const oh = await history(outsider.client, c1.data.id);
  record("Non-membre : historique refusé", oh.error?.message === "not_authorized", oh.error?.message);
  const oc = await correct(outsider.client, c1.data.id, 2, "Intrus");
  record("Non-membre : correction refusée", oc.error?.message === "not_authorized", oc.error?.message);
  const ot = await outsider.client.from("daily_log_versions").select("id").limit(1);
  record("Non-membre : lecture directe refusée", ot.error?.code === "42501", ot.error?.code);
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const a = await list(anon, projectId);
  record("Sans session : refusé", a.error?.code === "42501", a.error?.code);

  // Accès retiré (EC024).
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", projectId).eq("profile_id", coOwner.id);
  const rv = await list(coOwner.client, projectId);
  record("Copropriétaire dont l'accès est retiré : refusé", rv.error?.message === "not_authorized", rv.error?.message);
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", projectId).eq("profile_id", siteManager.id);
  const rc = await correct(siteManager.client, smSame.data.id, 3, "Après retrait");
  record("Chef dont l'accès est retiré : correction refusée", rc.error?.message === "not_authorized", rc.error?.message);
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
