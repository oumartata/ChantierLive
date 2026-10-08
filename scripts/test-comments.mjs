// Test d'intégration LOCAL uniquement : M047, commentaires attribués (B023 ;
// done_when « modération reste visible » ; D191 C1 à C7). Données jetables
// créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-comments.mjs

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
const one = (x) => (Array.isArray(x) ? x[0] : x);
async function must(res, what) { const r = await res; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; }
async function user(label) {
  const email = `m047-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client, label };
}

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const exMember = await user("ex-chef");
  const outsider = await user("hors-chantier");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  const pid = one(await must(contractor.client.rpc("create_draft_project", { p_name: "M047 — fil de test", p_country: "ML", p_role: "CONTRACTOR" }), "projet")).project_id;
  const otherPid = one(await must(contractor.client.rpc("create_draft_project", { p_name: "M047 — autre chantier", p_country: "ML", p_role: "CONTRACTOR" }), "projet 2")).project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null], [exMember, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  // Éléments : journal publié, brouillon de journal, incident ouvert, incident annulé, journal d'un autre chantier.
  const today = new Date().toISOString().slice(0, 10);
  const draftLog = async (u, project, date, text) => must(u.client.rpc("create_daily_log_draft", { p_project_id: project, p_log_date: date, p_works_done: text, p_difficulties: null, p_team: null, p_next_actions: null }), "brouillon");
  const pub = await draftLog(sm, pid, today, "Coulage de la dalle");
  await must(sm.client.rpc("publish_daily_log_draft", { p_log_id: pub.id, p_expected_revision: pub.revision }), "publication");
  const draft = await draftLog(sm, pid, new Date(Date.now() - 86400000).toISOString().slice(0, 10), "Brouillon non publié");
  const otherLog = await draftLog(contractor, otherPid, today, "Autre chantier");
  await must(contractor.client.rpc("publish_daily_log_draft", { p_log_id: otherLog.id, p_expected_revision: otherLog.revision }), "publication autre");
  const incident = await must(sm.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "MALFACON", p_severity: "MOYENNE", p_occurred_at: new Date(Date.now() - 3600000).toISOString(), p_description: "Fissure sur le linteau" }), "incident");
  const toCancel = await must(sm.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "AUTRE", p_severity: "FAIBLE", p_occurred_at: new Date(Date.now() - 3600000).toISOString(), p_description: "Signalement en double" }), "incident 2");

  const add = (u, type, id, body) => u.client.rpc("add_comment", { p_target_type: type, p_target_id: id, p_body: body });
  const list = (u, type, id) => u.client.rpc("list_comments", { p_target_type: type, p_target_id: id });
  const correct = (u, c, body) => u.client.rpc("correct_comment", { p_comment_id: c.id, p_expected_revision: c.revision, p_body: body });
  const retract = (u, c) => u.client.rpc("retract_comment", { p_comment_id: c.id, p_expected_revision: c.revision });
  const moderate = (u, c, reason) => u.client.rpc("moderate_comment", { p_comment_id: c.id, p_expected_revision: c.revision, p_reason: reason });
  const history = (u, c) => u.client.rpc("get_comment_history", { p_comment_id: c.id });
  const fresh = async (c) => (await service.from("comments").select("*").eq("id", c.id).single()).data;

  // 1. Création (C1, C2) et attribution (C5).
  const byRole = {};
  for (const [u, role, text] of [[contractor, "CONTRACTOR", "Vu, merci pour le relevé."], [owner, "OWNER_PRIMARY", "Bonne avancée."], [coOwner, "CO_OWNER", "Quand la prochaine visite ?"], [sm, "SITE_MANAGER", "Séchage prévu 48 h."]]) {
    const r = await add(u, "DAILY_LOG", pub.id, text);
    byRole[role] = r.data;
    record(`Journal publié — ${u.label} commente, attribué à son rôle (${role}), version du journal notée`, !r.error && r.data.author_role === role && r.data.target_version_number === 1 && r.data.author_profile_id === u.id, err(r));
  }
  const incC = await add(owner, "INCIDENT", incident.id, "Merci de le traiter avant le crépissage.");
  record("Incident ouvert — commentaire accepté", !incC.error && incC.data.target_type === "INCIDENT", err(incC));
  const smView = await list(sm, "DAILY_LOG", pub.id);
  const mine = smView.data?.find((c) => c.author_is_me);
  record("Fil : 4 commentaires dans l'ordre, rôle affiché, « vous » pour l'auteur, aucun nom", !smView.error && smView.data.length === 4 && smView.data.map((c) => c.author_role).join() === "CONTRACTOR,OWNER_PRIMARY,CO_OWNER,SITE_MANAGER" && mine?.author_role === "SITE_MANAGER" && !JSON.stringify(smView.data).includes("@example.test"), err(smView));

  // 2. Refus : brouillon, élément interne, autre chantier, type inconnu, texte vide.
  const onDraft = await add(contractor, "DAILY_LOG", draft.id, "Sur un brouillon");
  const onDraftBySm = await add(sm, "DAILY_LOG", draft.id, "Sur mon brouillon");
  const listDraft = await list(sm, "DAILY_LOG", draft.id);
  record("Brouillon de journal : commentaire refusé (même par son auteur), fil illisible", [onDraft, onDraftBySm, listDraft].every((r) => r.error?.message === "not_authorized"), [onDraft, onDraftBySm, listDraft].map(err).join(" / "));
  const expense = await must(contractor.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: null, p_expected_revision: null, p_amount_fcfa: "50000", p_expense_date: today, p_category: "MATERIAUX", p_supplier: null, p_note: null, p_phase_id: null, p_no_receipt_reason: null }), "dépense");
  const onExpense = await add(contractor, "EXPENSE", expense.id, "Sur une dépense");
  const onBudget = await add(contractor, "BUDGET", pid, "Sur le budget");
  const onDoc = await add(contractor, "DOCUMENT", randomUUID(), "Sur un document");
  const onExpenseAsLog = await add(contractor, "DAILY_LOG", expense.id, "Identifiant de dépense passé comme journal");
  record("Élément interne (dépense, budget, document, reçu…) : aucun type accepté, refus not_authorized", [onExpense, onBudget, onDoc, onExpenseAsLog].every((r) => r.error?.message === "not_authorized"), [onExpense, onBudget, onDoc, onExpenseAsLog].map(err).join(" / "));
  const otherProject = await add(owner, "DAILY_LOG", otherLog.id, "Journal d'un chantier où je ne suis pas");
  const otherList = await list(owner, "DAILY_LOG", otherLog.id);
  record("Élément invisible (journal d'un autre chantier) : commentaire refusé, fil illisible", otherProject.error?.message === "not_authorized" && otherList.error?.message === "not_authorized", `${err(otherProject)} / ${err(otherList)}`);
  const empty = await add(owner, "DAILY_LOG", pub.id, "   ");
  const tooLong = await add(owner, "DAILY_LOG", pub.id, "x".repeat(2001));
  record("Texte vide ou de plus de 2 000 caractères refusé", empty.error?.message === "comment_invalid" && tooLong.error?.message === "comment_invalid", `${err(empty)} / ${err(tooLong)}`);

  // 3. Correction par l'auteur seul, avec historique (C3).
  let ownerC = await fresh(byRole.OWNER_PRIMARY);
  const ctCorrects = await correct(contractor, ownerC, "Réécrit par l'entreprise");
  const smCorrects = await correct(sm, ownerC, "Réécrit par le chef");
  record("Correction refusée à tout autre que l'auteur", ctCorrects.error?.message === "not_authorized" && smCorrects.error?.message === "not_authorized", `${err(ctCorrects)} / ${err(smCorrects)}`);
  const stale = await correct(owner, { ...ownerC, revision: 0 }, "Version périmée");
  const same = await correct(owner, ownerC, "Bonne avancée.");
  record("Correction : révision périmée et texte identique refusés", stale.error?.message === "revision_conflict" && same.error?.message === "no_change", `${err(stale)} / ${err(same)}`);
  const fixed = await correct(owner, ownerC, "Bonne avancée, merci à l'équipe.");
  ownerC = await fresh(byRole.OWNER_PRIMARY);
  const h = await history(coOwner, ownerC);
  const afterFix = (await list(coOwner, "DAILY_LOG", pub.id)).data?.find((c) => c.id === ownerC.id);
  record("Correction par l'auteur : mention « modifié », original lisible dans l'historique (2 versions)", !fixed.error && afterFix?.edited === true && afterFix?.body === "Bonne avancée, merci à l'équipe." && h.data?.length === 2 && h.data[0].body === "Bonne avancée." && h.data[1].is_current, err(h));

  // 4. Retrait par l'auteur seul (C4) : texte masqué, conservé, événement visible.
  let coC = await fresh(byRole.CO_OWNER);
  const ownerRetracts = await retract(owner, coC);
  const ctRetracts = await retract(contractor, coC);
  record("Retrait refusé à tout autre que l'auteur (personne ne masque le texte d'un autre)", ownerRetracts.error?.message === "not_authorized" && ctRetracts.error?.message === "not_authorized", `${err(ownerRetracts)} / ${err(ctRetracts)}`);
  const retracted = await retract(coOwner, coC);
  coC = await fresh(byRole.CO_OWNER);
  const seen = (await list(contractor, "DAILY_LOG", pub.id)).data?.find((c) => c.id === coC.id);
  const retractedHistory = await history(contractor, coC);
  const stored = (await service.from("comment_versions").select("body").eq("comment_id", coC.id)).data;
  record("Retrait par l'auteur : événement visible (date), texte jamais renvoyé (liste ni historique), conservé en base", !retracted.error && !!seen?.retracted_at_server && seen?.body === null && retractedHistory.error?.message === "comment_retracted" && stored?.[0]?.body === "Quand la prochaine visite ?", err(retracted));
  const retractAgain = await retract(coOwner, coC);
  const correctRetracted = await correct(coOwner, coC, "Nouveau texte");
  record("Commentaire retiré : ni nouveau retrait ni correction", retractAgain.error?.message === "comment_frozen" && correctRetracted.error?.message === "comment_frozen", `${err(retractAgain)} / ${err(correctRetracted)}`);

  // 5. Modération par l'entreprise et le propriétaire principal (C4), texte lisible.
  let smC = await fresh(byRole.SITE_MANAGER);
  const coModerates = await moderate(coOwner, smC, "Hors sujet");
  const smModerates = await moderate(sm, await fresh(byRole.CONTRACTOR), "Hors sujet");
  record("Modération refusée au copropriétaire et au chef de chantier", coModerates.error?.message === "not_authorized" && smModerates.error?.message === "not_authorized", `${err(coModerates)} / ${err(smModerates)}`);
  const noReason = await moderate(owner, smC, " ");
  record("Modération sans motif refusée", noReason.error?.message === "reason_required", err(noReason));
  const mod = await moderate(owner, smC, "Information à confirmer par l'entreprise");
  smC = await fresh(byRole.SITE_MANAGER);
  const modSeen = await Promise.all([contractor, owner, coOwner, sm].map(async (u) => (await list(u, "DAILY_LOG", pub.id)).data?.find((c) => c.id === smC.id)));
  record("Modération : marque visible (rôle, date, motif) pour les 4 rôles, texte toujours lisible par tous", !mod.error && modSeen.every((c) => c?.moderated_by_role === "OWNER_PRIMARY" && c?.moderation_reason === "Information à confirmer par l'entreprise" && !!c?.moderated_at_server && c?.body === "Séchage prévu 48 h."), err(mod));
  const modAgain = await moderate(contractor, smC, "Deuxième modération");
  const authorCorrectsModerated = await correct(sm, smC, "Texte changé après modération");
  const modHistory = await history(coOwner, smC);
  record("Commentaire modéré : ni deuxième modération ni correction ; historique toujours lisible", modAgain.error?.message === "comment_frozen" && authorCorrectsModerated.error?.message === "comment_frozen" && modHistory.data?.length === 1, `${err(modAgain)} / ${err(authorCorrectsModerated)}`);
  const ctMod = await moderate(contractor, await fresh(incC.data), "Doublon du journal");
  record("Entreprise : modère un commentaire d'incident", !ctMod.error && ctMod.data.moderated_by_role === "CONTRACTOR", err(ctMod));

  // 6. Aucune suppression, même avec la clé de service.
  const d1 = await service.from("comments").delete().eq("id", smC.id);
  const d2 = await service.from("comment_versions").delete().eq("comment_id", smC.id);
  const u1 = await service.from("comment_versions").update({ body: "falsifié" }).eq("comment_id", ownerC.id);
  const u2 = await service.from("comments").update({ moderated_at_server: null, moderated_by_profile_id: null, moderated_by_role: null, moderation_reason: null }).eq("id", smC.id);
  const u3 = await service.from("comments").update({ retracted_at_server: null }).eq("id", coC.id);
  const u4 = await service.from("comments").update({ author_role: "CONTRACTOR" }).eq("id", ownerC.id);
  record("Service : suppression, réécriture du texte, annulation d'une modération ou d'un retrait, changement d'auteur refusés", [d1, d2, u1, u2, u3, u4].every((r) => r.error?.message === "comment_immutable"), [d1, d2, u1, u2, u3, u4].map(err).join(" / "));
  const { count: stillThere } = await service.from("comments").select("id", { count: "exact", head: true }).eq("project_id", pid);
  record("Tous les commentaires sont toujours en base (rien n'est supprimé)", stillThere === 5, String(stillThere));

  // 7. Incident annulé (C6) : plus de commentaire, fil lisible.
  await must(contractor.client.rpc("transition_incident", { p_incident_id: toCancel.id, p_expected_revision: toCancel.revision, p_to_status: "ANNULE", p_note: "Doublon" }), "annulation");
  const lateC = await add(owner, "INCIDENT", toCancel.id, "Trop tard ?");
  const cancelList = await list(owner, "INCIDENT", toCancel.id);
  record("Incident annulé : ajout refusé (comment_closed), fil toujours lisible", lateC.error?.message === "comment_closed" && !cancelList.error && Array.isArray(cancelList.data), `${err(lateC)} / ${err(cancelList)}`);

  // 8. Ancien membre (C7) et non-membre.
  const exC = await must(add(exMember, "DAILY_LOG", pub.id, "Dernier mot avant mon départ."), "commentaire ex-membre");
  await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", exMember.id), "révocation");
  const exCalls = await Promise.all([list(exMember, "DAILY_LOG", pub.id), add(exMember, "DAILY_LOG", pub.id, "Encore là ?"), correct(exMember, await fresh(exC), "Modifié après départ"), retract(exMember, await fresh(exC)), history(exMember, exC)]);
  record("Ancien membre : liste, ajout, correction, retrait et historique refusés", exCalls.every((r) => r.error?.message === "not_authorized"), exCalls.map(err).join(" / "));
  const exSeen = (await list(contractor, "DAILY_LOG", pub.id)).data?.find((c) => c.id === exC.id);
  record("Ancien membre : son commentaire reste visible, attribué à son rôle, mention « ancien membre »", exSeen?.body === "Dernier mot avant mon départ." && exSeen?.author_role === "SITE_MANAGER" && exSeen?.author_is_former_member === true);
  const outCalls = await Promise.all([list(outsider, "DAILY_LOG", pub.id), list(outsider, "INCIDENT", incident.id), add(outsider, "DAILY_LOG", pub.id, "Intrus"), moderate(outsider, ownerC, "Intrus"), history(outsider, ownerC)]);
  record("Non-membre : rien (liste, ajout, modération, historique)", outCalls.every((r) => r.error?.message === "not_authorized" && !r.data), outCalls.map(err).join(" / "));
  const anonCalls = await Promise.all([list(anon, "DAILY_LOG", pub.id), add(anon, "DAILY_LOG", pub.id, "Intrus")]);
  record("Visiteur sans session : refusé", anonCalls.every((r) => !!r.error && !r.data), anonCalls.map(err).join(" / "));

  // 9. Tables fermées ; audit lisible par l'entreprise seule (D186).
  for (const u of [contractor, owner, coOwner, sm, outsider]) {
    const t = await Promise.all([u.client.from("comments").select("*").limit(1), u.client.from("comment_versions").select("*").limit(1)]);
    record(`${u.label} : tables comments et comment_versions refusées en lecture directe`, t.every((r) => r.error?.code === "42501"), t.map((r) => r.error?.code).join("/"));
  }
  const ctAudit = await contractor.client.from("audit_events").select("action").eq("project_id", pid).like("action", "COMMENT_%");
  const ownerAudit = await owner.client.from("audit_events").select("action").eq("project_id", pid);
  const acts = new Set((ctAudit.data ?? []).map((a) => a.action));
  record("Audit : ajout, correction, retrait et modération tracés ; illisible par le propriétaire", ["COMMENT_ADDED", "COMMENT_CORRECTED", "COMMENT_RETRACTED", "COMMENT_MODERATED"].every((a) => acts.has(a)) && !ownerAudit.error && ownerAudit.data.length === 0, [...acts].join(", "));
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
