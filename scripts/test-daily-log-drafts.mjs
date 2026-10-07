// Test d'intégration LOCAL uniquement : M036, brouillon de journal quotidien
// (B021, D144–D150). Données jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-daily-log-drafts.mjs

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
  const email = `m036-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
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

try {
  const contractor = await user("entreprise");
  const siteManager = await user("chef");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const outsider = await user("hors-chantier");
  const { data: created, error: projErr } = await contractor.client.rpc("create_draft_project", { p_name: "M036 — journal", p_country: "ML", p_role: "CONTRACTOR" });
  if (projErr) throw new Error(projErr.message);
  const projectId = (Array.isArray(created) ? created[0] : created).project_id;
  for (const [u, role, ownerProfile] of [[siteManager, "SITE_MANAGER", null], [owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"]]) {
    const { error } = await service.from("project_memberships").insert({ project_id: projectId, profile_id: u.id, role, owner_profile: ownerProfile });
    if (error) throw new Error(`adhésion ${role}: ${error.message}`);
  }
  const d1 = "2026-10-06";

  // Auteur : crée, voit, modifie.
  const c1 = await draft(contractor.client, projectId, d1);
  record("Entreprise : crée un brouillon (attribué, BROUILLON, révision 0)", !c1.error && c1.data.author_profile_id === contractor.id && c1.data.status === "BROUILLON" && c1.data.revision === 0, c1.error?.message);
  const { count: auditCreate } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("target_id", c1.data.id).eq("action", "DAILY_LOG_DRAFT_CREATE");
  record("Création tracée dans audit_events", auditCreate === 1);
  const l1 = await contractor.client.rpc("list_my_daily_log_drafts", { p_project_id: projectId });
  record("Auteur : voit son brouillon", !l1.error && l1.data.length === 1 && l1.data[0].id === c1.data.id, l1.error?.message);
  const u1 = await contractor.client.rpc("update_daily_log_draft", { p_log_id: c1.data.id, p_expected_revision: 0, p_log_date: d1, p_works_done: "Coulage dalle terminé", p_difficulties: "Pluie l'après-midi", p_team: "3 maçons", p_next_actions: "Décoffrage" });
  record("Auteur : modifie son brouillon (révision 1)", !u1.error && u1.data.revision === 1 && u1.data.difficulties === "Pluie l'après-midi", u1.error?.message);
  const stale = await contractor.client.rpc("update_daily_log_draft", { p_log_id: c1.data.id, p_expected_revision: 0, p_log_date: d1, p_works_done: "écrasement", p_difficulties: null, p_team: null, p_next_actions: null });
  record("Modification sur révision périmée refusée", stale.error?.message === "revision_conflict", stale.error?.message);

  // Un brouillon actif par auteur, chantier et date (D146).
  const dup = await draft(contractor.client, projectId, d1);
  record("2e brouillon actif même auteur, chantier et date : refusé", dup.error?.message === "daily_log_draft_exists", dup.error?.message);
  const other = await draft(contractor.client, projectId, "2026-10-05");
  record("Même auteur, autre date : accepté", !other.error, other.error?.message);
  const sm = await draft(siteManager.client, projectId, d1, "Ferraillage");
  record("Chef de chantier : son propre brouillon pour la même date (auteur distinct) : accepté", !sm.error && sm.data.author_profile_id === siteManager.id, sm.error?.message);

  // Personne d'autre ne voit ni ne modifie (D144, D145).
  const smList = await siteManager.client.rpc("list_my_daily_log_drafts", { p_project_id: projectId });
  record("Autre membre (chef) : ne voit pas le brouillon de l'entreprise", !smList.error && smList.data.every((r) => r.author_profile_id === siteManager.id) && !smList.data.some((r) => r.id === c1.data.id));
  const smEdit = await siteManager.client.rpc("update_daily_log_draft", { p_log_id: c1.data.id, p_expected_revision: 1, p_log_date: d1, p_works_done: "x", p_difficulties: null, p_team: null, p_next_actions: null });
  record("Autre membre : modification du brouillon d'un autre refusée", smEdit.error?.message === "not_authorized", smEdit.error?.message);
  const smArch = await siteManager.client.rpc("archive_daily_log_draft", { p_log_id: c1.data.id, p_expected_revision: 1 });
  record("Autre membre : archivage du brouillon d'un autre refusé", smArch.error?.message === "not_authorized", smArch.error?.message);
  const ctList = await contractor.client.rpc("list_my_daily_log_drafts", { p_project_id: projectId });
  record("Entreprise : ne voit pas le brouillon du chef", !ctList.error && !ctList.data.some((r) => r.id === sm.data.id));
  for (const [label, u] of [["propriétaire principal", owner], ["copropriétaire", coOwner], ["non-membre", outsider]]) {
    const l = await u.client.rpc("list_my_daily_log_drafts", { p_project_id: projectId });
    record(`${label} : ne voit rien (refus)`, l.error?.message === "not_authorized", l.error?.message);
    const c = await draft(u.client, projectId, "2026-10-01");
    record(`${label} : ne peut pas créer`, c.error?.message === "not_authorized", c.error?.message);
    const e = await u.client.rpc("update_daily_log_draft", { p_log_id: c1.data.id, p_expected_revision: 1, p_log_date: d1, p_works_done: "x", p_difficulties: null, p_team: null, p_next_actions: null });
    record(`${label} : ne peut pas modifier`, e.error?.message === "not_authorized", e.error?.message);
    const t = await u.client.from("daily_logs").select("id").limit(1);
    record(`${label} : lecture directe de la table refusée`, t.error?.code === "42501", t.error?.code);
  }
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const a = await anon.rpc("list_my_daily_log_drafts", { p_project_id: projectId });
  record("Sans session : refusé", a.error?.code === "42501", a.error?.code);

  // Archivage (D147) : trace, terminal, puis nouveau brouillon possible.
  const arch = await contractor.client.rpc("archive_daily_log_draft", { p_log_id: c1.data.id, p_expected_revision: 1 });
  record("Auteur : archive son brouillon (ARCHIVE, date d'archivage)", !arch.error && arch.data.status === "ARCHIVE" && !!arch.data.archived_at_server, arch.error?.message);
  const { count: auditArch } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("target_id", c1.data.id).eq("action", "DAILY_LOG_DRAFT_ARCHIVE");
  record("Archivage tracé dans audit_events", auditArch === 1);
  const afterArch = await contractor.client.rpc("list_my_daily_log_drafts", { p_project_id: projectId });
  record("Brouillon archivé absent de la liste", !afterArch.error && !afterArch.data.some((r) => r.id === c1.data.id));
  const editArch = await contractor.client.rpc("update_daily_log_draft", { p_log_id: c1.data.id, p_expected_revision: 2, p_log_date: d1, p_works_done: "x", p_difficulties: null, p_team: null, p_next_actions: null });
  record("Brouillon archivé : plus modifiable", editArch.error?.message === "not_authorized", editArch.error?.message);
  const again = await draft(contractor.client, projectId, d1, "Nouveau brouillon");
  record("Après archivage, nouveau brouillon même date : accepté", !again.error && again.data.id !== c1.data.id, again.error?.message);

  // Suppression physique et mutations directes refusées, même pour le service.
  const del = await service.from("daily_logs").delete().eq("id", c1.data.id);
  record("Suppression physique refusée (même service_role)", del.error?.message === "daily_log_immutable", del.error?.message);
  const reopen = await service.from("daily_logs").update({ status: "BROUILLON", archived_at_server: null }).eq("id", c1.data.id);
  record("Brouillon archivé jamais rouvert (même service_role)", reopen.error?.message === "daily_log_archived", reopen.error?.message);
  const steal = await service.from("daily_logs").update({ author_profile_id: siteManager.id }).eq("id", again.data.id);
  record("Auteur d'un brouillon jamais réattribué", steal.error?.message === "daily_log_immutable", steal.error?.message);

  // Accès retiré (EC024) : l'auteur perd l'accès à ses propres brouillons.
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", projectId).eq("profile_id", siteManager.id);
  const revoked = await siteManager.client.rpc("list_my_daily_log_drafts", { p_project_id: projectId });
  record("Auteur dont l'accès est retiré : refusé", revoked.error?.message === "not_authorized", revoked.error?.message);
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
