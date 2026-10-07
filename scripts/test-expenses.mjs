// Test d'intégration LOCAL uniquement : M045, dépenses internes (B031 ;
// D183, D184 F3/F4/F7/F8/F10, D185, D186, D187). Circuits, droits, totaux
// (H2), brouillon de l'auteur seul (H1), vue du chef de chantier sans budget
// ni alerte (H3), refus définitif (H4), contre-écritures de l'entreprise
// seule (H5) ; confidentialité « jamais, à aucun niveau » envers le
// propriétaire principal, le copropriétaire, l'ex-membre, le non-membre et
// le visiteur sans session. Données jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-expenses.mjs

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
  const email = `m045-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client, label };
}

// Montants repérables : aucune réponse lisible hors entreprise et chef de
// chantier ne doit les contenir.
const A = "111000111"; // chef de chantier, approuvée
const B = "222000222"; // chef de chantier, refusée
const C1 = "333000333"; // entreprise, approuvée puis contestée puis corrigée
const C2 = "333000444"; // correction de C1
const D = "444000444"; // entreprise, annulée
const E = "555000555"; // chef de chantier, soumise (en attente)
const F = "666000666"; // entreprise, contestée
const G = "777000777"; // brouillon du chef de chantier
const H = "888000888"; // brouillon de l'entreprise
const ALL = [A, B, C1, C2, D, E, F, G, H];
const BUDGET = "1000000000";

try {
  const contractor = await user("entreprise");
  const sm = await user("chef");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const exMember = await user("ex-coproprietaire");
  const outsider = await user("hors-chantier");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  const { data: created, error: pErr } = await contractor.client.rpc("create_draft_project", { p_name: "M045 — circuit interne", p_country: "ML", p_role: "CONTRACTOR" });
  if (pErr) throw new Error(pErr.message);
  const pid = (Array.isArray(created) ? created[0] : created).project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null], [exMember, "OWNER", "CO_OWNER"]]) {
    const { error } = await service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op });
    if (error) throw new Error(`adhésion ${u.label}: ${error.message}`);
  }
  // Un autre chantier, pour le lien d'étape étranger.
  const { data: other } = await contractor.client.rpc("create_draft_project", { p_name: "M045 — autre chantier", p_country: "ML", p_role: "CONTRACTOR" });
  const otherPid = (Array.isArray(other) ? other[0] : other).project_id;
  for (const p of [pid, otherPid]) {
    await contractor.client.rpc("upsert_phase_plan_draft", { p_project_id: p, p_phases: [{ position: 1, label: "Fondations", weight: 60 }, { position: 2, label: "Élévation", weight: 40 }], p_expected_revision: 0 });
    const plan = (await contractor.client.rpc("get_project_phase_plan", { p_project_id: p })).data;
    const pub = await contractor.client.rpc("publish_phase_plan", { p_project_id: p, p_expected_revision: (Array.isArray(plan) ? plan[0] : plan).revision });
    if (pub.error) throw new Error(`publication du plan : ${pub.error.message}`);
  }
  const phase = (await service.from("project_phases").select("id").eq("project_id", pid).order("position").limit(1).single()).data.id;
  const foreignPhase = (await service.from("project_phases").select("id").eq("project_id", otherPid).order("position").limit(1).single()).data.id;

  const save = (u, { id = null, rev = null, amount, date = "2026-10-05", category = "MATERIAUX", supplier = null, note = null, phaseId = null }) =>
    u.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: id, p_expected_revision: rev, p_amount_fcfa: amount, p_expense_date: date, p_category: category, p_supplier: supplier, p_note: note, p_phase_id: phaseId, p_no_receipt_reason: null });
  const submit = (u, e) => u.client.rpc("submit_expense", { p_expense_id: e.id, p_expected_revision: e.revision });
  const decide = (u, e, decision, reason = null) => u.client.rpc("decide_expense", { p_expense_id: e.id, p_expected_revision: e.revision, p_decision: decision, p_reason: reason });
  const correct = (u, e, reason, amount, extra = {}) => u.client.rpc("correct_expense", { p_expense_id: e.id, p_expected_revision: e.revision, p_reason: reason, p_amount_fcfa: amount, p_expense_date: extra.date ?? "2026-10-05", p_category: extra.category ?? "MATERIAUX", p_supplier: extra.supplier ?? null, p_note: extra.note ?? null, p_phase_id: extra.phaseId ?? null, p_no_receipt_reason: null });
  const cancel = (u, e, reason) => u.client.rpc("cancel_expense", { p_expense_id: e.id, p_expected_revision: e.revision, p_reason: reason });
  const list = (u) => u.client.rpc("list_project_expenses", { p_project_id: pid });
  const history = (u, e) => u.client.rpc("get_expense_history", { p_expense_id: e.id });
  const totals = (u) => u.client.rpc("get_expense_totals", { p_project_id: pid });
  const alert = (u) => u.client.rpc("get_expense_budget_alert", { p_project_id: pid });
  const fresh = async (e) => (await service.from("expenses").select("*").eq("id", e.id).single()).data;

  // 1. Brouillon : saisie et validations.
  for (const [label, args, code] of [
    ["montant nul", { amount: "0" }, "amount_out_of_bounds"],
    ["montant décimal", { amount: "1500.5" }, "invalid_amount"],
    ["montant négatif", { amount: "-10" }, "invalid_amount"],
    ["catégorie inconnue", { amount: "1000", category: "CADEAU" }, "category_invalid"],
    ["date absente", { amount: "1000", date: null }, "expense_date_required"],
    ["étape d'un autre chantier", { amount: "1000", phaseId: foreignPhase }, "phase_link_invalid"],
  ]) {
    const r = await save(sm, args);
    record(`Brouillon refusé : ${label}`, r.error?.message === code, err(r));
  }
  const gDraft = await save(sm, { amount: G, category: "TRANSPORT", supplier: "Transports Diallo", note: "Camion de sable", phaseId: phase });
  record("Chef de chantier : crée un brouillon (montant entier, étape facultative)", !gDraft.error && gDraft.data.status === "BROUILLON" && Number(gDraft.data.draft_amount_fcfa) === Number(G) && gDraft.data.draft_phase_id === phase, err(gDraft));
  const hDraft = await save(contractor, { amount: H, category: "LOCATION_MATERIEL" });
  record("Entreprise : crée un brouillon", !hDraft.error && hDraft.data.status === "BROUILLON", err(hDraft));
  const staleDraft = await save(sm, { id: gDraft.data.id, rev: 5, amount: G });
  record("Brouillon : révision périmée refusée", staleDraft.error?.message === "revision_conflict", err(staleDraft));
  const gUpd = await save(sm, { id: gDraft.data.id, rev: 0, amount: G, category: "TRANSPORT", supplier: "Transports Diallo", note: "Camion de sable, 2 voyages", phaseId: phase });
  record("Brouillon : modifié par son auteur (révision 1)", !gUpd.error && gUpd.data.revision === 1 && gUpd.data.draft_note === "Camion de sable, 2 voyages", err(gUpd));

  // H1 : brouillon visible par son auteur seul.
  const ctList0 = await list(contractor);
  const smList0 = await list(sm);
  record("H1 : l'entreprise ne voit pas le brouillon du chef de chantier, ni l'inverse", !ctList0.error && !smList0.error
    && !ctList0.data.some((e) => e.id === gDraft.data.id) && ctList0.data.some((e) => e.id === hDraft.data.id)
    && !smList0.data.some((e) => e.id === hDraft.data.id) && smList0.data.some((e) => e.id === gDraft.data.id && e.author_is_me && e.can_submit), `${ctList0.data?.length} / ${smList0.data?.length}`);
  const foreignEdit = await save(contractor, { id: gDraft.data.id, rev: 1, amount: "1000" });
  const foreignSubmit = await submit(contractor, gUpd.data);
  const foreignHist = await history(contractor, gUpd.data);
  const smEditCt = await save(sm, { id: hDraft.data.id, rev: 0, amount: "1000" });
  record("H1 : brouillon d'autrui ni modifiable, ni soumis, ni son historique lisible", [foreignEdit, foreignSubmit, foreignHist, smEditCt].every((r) => r.error?.message === "not_authorized"), [foreignEdit, foreignSubmit, foreignHist, smEditCt].map(err).join(" / "));

  // 2. Circuit du chef de chantier : soumission, approbation, refus (F3, F4, H4).
  const aDraft = (await save(sm, { amount: A, category: "MATERIAUX", supplier: "Quincaillerie Keita" })).data;
  const aSub = await submit(sm, aDraft);
  record("Chef de chantier : soumet sa dépense (SOUMISE, version 1)", !aSub.error && aSub.data.status === "SOUMISE" && !!aSub.data.current_version_id, err(aSub));
  const smSelfApprove = await decide(sm, aSub.data, "APPROUVEE");
  record("Chef de chantier : ne peut pas approuver (not_authorized)", smSelfApprove.error?.message === "not_authorized", err(smSelfApprove));
  const aEdit = await save(sm, { id: aDraft.id, rev: aSub.data.revision, amount: "1" });
  record("Dépense soumise : plus modifiable comme brouillon", aEdit.error?.message === "not_authorized", err(aEdit));
  const aOk = await decide(contractor, aSub.data, "APPROUVEE");
  record("Entreprise : approuve la dépense soumise", !aOk.error && aOk.data.status === "APPROUVEE", err(aOk));

  const bSub = (await submit(sm, (await save(sm, { amount: B, category: "MAIN_OEUVRE" })).data)).data;
  const bNoReason = await decide(contractor, bSub, "REFUSEE", "  ");
  record("Refus sans motif refusé", bNoReason.error?.message === "reason_required", err(bNoReason));
  const bRef = await decide(contractor, bSub, "REFUSEE", "Pas de justificatif");
  record("Entreprise : refuse avec motif", !bRef.error && bRef.data.status === "REFUSEE", err(bRef));
  const bAgain = await decide(contractor, bRef.data, "APPROUVEE");
  const bCorr = await correct(contractor, bRef.data, "Rattrapage", "1000");
  const bCanc = await cancel(contractor, bRef.data, "Annulation");
  record("H4 : refus définitif (ni approbation, ni correction, ni annulation ensuite)", [bAgain, bCorr, bCanc].every((r) => r.error?.message === "invalid_transition"), [bAgain, bCorr, bCanc].map(err).join(" / "));

  const eSub = (await submit(sm, (await save(sm, { amount: E, category: "FRAIS_DIVERS", phaseId: phase })).data)).data;
  record("Chef de chantier : une deuxième dépense reste en attente", eSub?.status === "SOUMISE");

  // 3. Dépense de l'entreprise : approuvée directement (F4).
  const cPub = await submit(contractor, (await save(contractor, { amount: C1, category: "SOUS_TRAITANCE", phaseId: phase })).data);
  record("Entreprise : sa dépense est approuvée directement (sans étape de soumission)", !cPub.error && cPub.data.status === "APPROUVEE", err(cPub));
  const cDec = await decide(contractor, cPub.data, "APPROUVEE");
  record("Dépense déjà approuvée : décision d'approbation refusée", cDec.error?.message === "invalid_transition", err(cDec));

  // 4. Contestation (entreprise seule, motif) puis correction liée (F7, H5).
  const smDispute = await decide(sm, cPub.data, "CONTESTEE", "Montant douteux");
  record("Chef de chantier : ne peut pas contester", smDispute.error?.message === "not_authorized", err(smDispute));
  const cDisNo = await decide(contractor, cPub.data, "CONTESTEE", "");
  record("Contestation sans motif refusée", cDisNo.error?.message === "reason_required", err(cDisNo));
  const cDis = await decide(contractor, cPub.data, "CONTESTEE", "Facture à vérifier");
  record("Entreprise : conteste avec motif (CONTESTEE)", !cDis.error && cDis.data.status === "CONTESTEE", err(cDis));
  const pendingDispute = await decide(contractor, eSub, "CONTESTEE", "Trop tôt");
  record("Dépense soumise : contestation refusée (approuvée seulement)", pendingDispute.error?.message === "invalid_transition", err(pendingDispute));
  const smCorr = await correct(sm, cDis.data, "Correction du chef", C2);
  const pendCorr = await correct(contractor, eSub, "Correction prématurée", "1000");
  const pendCanc = await cancel(contractor, eSub, "Annulation prématurée");
  record("H5 : correction et annulation refusées au chef de chantier et sur une dépense soumise", smCorr.error?.message === "not_authorized" && pendCorr.error?.message === "invalid_transition" && pendCanc.error?.message === "invalid_transition", [smCorr, pendCorr, pendCanc].map(err).join(" / "));
  const cNoReason = await correct(contractor, cDis.data, " ", C2, { category: "SOUS_TRAITANCE", phaseId: phase });
  const cSame = await correct(contractor, cDis.data, "Même contenu", C1, { category: "SOUS_TRAITANCE", phaseId: phase });
  record("Correction sans motif ou sans changement refusée", cNoReason.error?.message === "reason_required" && cSame.error?.message === "no_change", `${err(cNoReason)} / ${err(cSame)}`);
  const cCorr = await correct(contractor, cDis.data, "Facture définitive reçue", C2, { category: "SOUS_TRAITANCE", phaseId: phase });
  const cNow = await fresh(cDis.data);
  record("Correction : nouvelle version 2 liée, dépense de nouveau APPROUVEE", !cCorr.error && cCorr.data.version_number === 2 && !!cCorr.data.supersedes_version_id && cNow.status === "APPROUVEE" && cNow.current_version_id === cCorr.data.id, err(cCorr));
  const cHist = await history(sm, cNow);
  const cVersions = (cHist.data ?? []).filter((h) => h.kind === "VERSION");
  record("Correction : version d'origine consultable (historique, entreprise et chef de chantier)", !cHist.error && cVersions.length === 2 && cVersions.some((v) => Number(v.amount_fcfa) === Number(C1)) && (cHist.data ?? []).some((h) => h.kind === "DECISION:CORRIGEE" && h.reason === "Facture définitive reçue"), err(cHist));

  // 5. Annulation : contre-écriture motivée, original visible (F7).
  const dPub = (await submit(contractor, (await save(contractor, { amount: D, category: "AUTRE" })).data)).data;
  const dNo = await cancel(contractor, dPub, "");
  record("Annulation sans motif refusée", dNo.error?.message === "reason_required", err(dNo));
  const smCanc = await cancel(sm, dPub, "Annulation par le chef");
  record("Chef de chantier : ne peut pas annuler", smCanc.error?.message === "not_authorized", err(smCanc));
  const dCan = await cancel(contractor, dPub, "Doublon de saisie");
  record("Entreprise : annule avec motif (ANNULEE)", !dCan.error && dCan.data.status === "ANNULEE", err(dCan));
  const dAgain = await cancel(contractor, dCan.data, "Encore");
  const dCorr = await correct(contractor, dCan.data, "Résurrection", "1000");
  record("Annulation définitive (ni nouvelle annulation, ni correction)", dAgain.error?.message === "invalid_transition" && dCorr.error?.message === "invalid_transition", `${err(dAgain)} / ${err(dCorr)}`);
  const dHist = await history(contractor, dCan.data);
  const dListed = (await list(contractor)).data?.find((e) => e.id === dPub.id);
  record("Annulée : original visible (liste et historique), motif conservé", Number(dListed?.amount_fcfa) === Number(D) && dListed?.status === "ANNULEE" && dListed?.last_reason === "Doublon de saisie" && (dHist.data ?? []).some((h) => h.kind === "DECISION:ANNULEE"), err(dHist));

  // Une dépense laissée contestée : comptée (H2).
  const fPub = (await submit(contractor, (await save(contractor, { amount: F, category: "MATERIAUX" })).data)).data;
  const fDis = await decide(contractor, fPub, "CONTESTEE", "Quantité à recompter");
  record("Dépense laissée contestée", fDis.data?.status === "CONTESTEE", err(fDis));

  // 6. Totaux selon H2.
  const engaged = Number(A) + Number(C2) + Number(F);
  const ct = await totals(contractor);
  const st = await totals(sm);
  const t = ct.data;
  record("H2 : engagé = approuvées + contestées (version courante) ; refusée, annulée, version remplacée et brouillons exclus", !ct.error && Number(t.engaged_fcfa) === engaged && t.engaged_count === 3, `${t?.engaged_fcfa} attendu ${engaged}`);
  record("H2 : en attente affichée à part (soumise seulement)", Number(t?.pending_fcfa) === Number(E) && t?.pending_count === 1 && t?.refused_count === 1 && t?.cancelled_count === 1, JSON.stringify({ p: t?.pending_fcfa, r: t?.refused_count, c: t?.cancelled_count }));
  record("H2 : totaux par catégorie (engagé seulement)", Number(t?.by_category?.MATERIAUX) === Number(A) + Number(F) && Number(t?.by_category?.SOUS_TRAITANCE) === Number(C2) && !("MAIN_OEUVRE" in (t?.by_category ?? {})) && !("AUTRE" in (t?.by_category ?? {})) && !("FRAIS_DIVERS" in (t?.by_category ?? {})), JSON.stringify(t?.by_category));
  record("H3 : le chef de chantier lit les mêmes totaux", !st.error && JSON.stringify(st.data) === JSON.stringify(ct.data), err(st));

  // H3 : liste du chef de chantier = toutes les dépenses soumises ou décidées + ses brouillons.
  const smList = (await list(sm)).data ?? [];
  const ctList = (await list(contractor)).data ?? [];
  const decided = (l) => l.filter((e) => e.status !== "BROUILLON").map((e) => e.id).sort().join();
  record("H3 : le chef de chantier voit toutes les dépenses soumises ou décidées (dont celles de l'entreprise)", decided(smList) === decided(ctList) && smList.filter((e) => e.status !== "BROUILLON").length === 6, `${smList.length} / ${ctList.length}`);
  record("H3 : actions de décision absentes pour le chef de chantier", smList.every((e) => !e.can_decide && !e.can_dispute && !e.can_correct && !e.can_cancel) && ctList.some((e) => e.can_decide), "");

  // 7. Alerte de dépassement (F8, BR052) : entreprise seule.
  const a0 = await alert(contractor);
  record("Alerte sans budget : aucune comparaison", !a0.error && a0.data.has_budget === false && a0.data.over_budget === false, err(a0));
  const bud = await contractor.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: BUDGET, p_reason: null, p_expected_revision: 0 });
  if (bud.error) throw new Error(`budget : ${bud.error.message}`);
  const a1 = await alert(contractor);
  record("Alerte : total engagé comparé au budget, dépassement signalé (sans bloquer)", !a1.error && a1.data.over_budget === true && Number(a1.data.overrun_fcfa) === engaged - Number(BUDGET) && Number(a1.data.engaged_fcfa) === engaged, JSON.stringify(a1.data));
  const afterAlert = await save(sm, { amount: "1000" });
  record("Dépassement : la saisie reste possible", !afterAlert.error, err(afterAlert));
  const smAlert = await alert(sm);
  const smBudget = await sm.client.rpc("get_internal_budget", { p_project_id: pid });
  const smBudgetV = await sm.client.rpc("list_internal_budget_versions", { p_project_id: pid });
  const smTables = await sm.client.from("budget_versions").select("*").limit(1);
  record("H3 : le chef de chantier n'obtient jamais le budget ni l'alerte", smAlert.error?.message === "not_authorized" && smBudget.error?.message === "not_authorized" && smBudgetV.error?.message === "not_authorized" && smTables.error?.code === "42501", [smAlert, smBudget, smBudgetV].map(err).join(" / "));
  const smBody = JSON.stringify([smList, st.data]);
  record("H3 : aucune réponse du chef de chantier ne contient le montant du budget", !smBody.includes(BUDGET), "");

  // 8. Gardes (même service_role).
  const vUp = await service.from("expense_versions").update({ amount_fcfa: 1 }).eq("id", cCorr.data.id);
  const vDel = await service.from("expense_versions").delete().eq("id", cCorr.data.id);
  const dcDel = await service.from("expense_decisions").delete().eq("expense_id", dPub.id);
  const eDel = await service.from("expenses").delete().eq("id", aDraft.id);
  const eTerm = await service.from("expenses").update({ status: "APPROUVEE" }).eq("id", dPub.id);
  const eJump = await service.from("expenses").update({ status: "BROUILLON" }).eq("id", aDraft.id);
  const eFrozen = await service.from("expenses").update({ draft_amount_fcfa: 5 }).eq("id", aDraft.id);
  record("Versions et décisions immuables ; dépense jamais supprimée ; terminal figé ; transitions hors machine refusées ; contenu soumis figé",
    vUp.error?.message === "expense_record_immutable" && vDel.error?.message === "expense_record_immutable" && dcDel.error?.message === "expense_record_immutable"
    && eDel.error?.message === "expense_immutable" && eTerm.error?.message === "expense_terminal" && eJump.error?.message === "invalid_transition" && eFrozen.error?.message === "expense_immutable",
    [vUp, vDel, dcDel, eDel, eTerm, eJump, eFrozen].map(err).join(" / "));
  const { data: auditRows } = await service.from("audit_events").select("action").eq("project_id", pid).like("action", "EXPENSE_%");
  const actions = new Set((auditRows ?? []).map((r) => r.action));
  record("Audit : soumission, publication, approbation, refus, contestation, correction, annulation tracées", ["EXPENSE_SUBMITTED", "EXPENSE_PUBLISHED_APPROVED", "EXPENSE_APPROUVEE", "EXPENSE_REFUSEE", "EXPENSE_CONTESTEE", "EXPENSE_CORRECTED", "EXPENSE_CANCELLED"].every((a) => actions.has(a)), [...actions].join(", "));

  // 8b. B034 « décision vise version exacte » : la décision porte la version présentée ;
  //     une décision préparée sur une version remplacée entre-temps est refusée.
  const { data: aDecisions } = await service.from("expense_decisions").select("decision, version_id").eq("expense_id", aDraft.id);
  record("B034 : l'approbation porte exactement la version présentée (version 1)", aDecisions?.some((d) => d.decision === "APPROUVEE" && d.version_id === aSub.data.current_version_id), JSON.stringify(aDecisions));
  const xPub = (await submit(contractor, (await save(contractor, { amount: "123000", category: "TRANSPORT" })).data)).data;
  const xSeen = await fresh(xPub);
  const xCorr = await correct(contractor, xSeen, "Montant rectifié", "124000", { category: "TRANSPORT" });
  const xStaleDispute = await decide(contractor, xSeen, "CONTESTEE", "Basée sur l'ancienne version");
  const xStaleCancel = await cancel(contractor, xSeen, "Basée sur l'ancienne version");
  const { data: xDec1 } = await service.from("expense_decisions").select("decision").eq("expense_id", xPub.id);
  record("B034 : décision sur une version remplacée entre-temps refusée (revision_conflict), rien d'enregistré", xStaleDispute.error?.message === "revision_conflict" && xStaleCancel.error?.message === "revision_conflict" && !xDec1.some((d) => d.decision === "CONTESTEE" || d.decision === "ANNULEE"), `${err(xStaleDispute)} / ${err(xStaleCancel)}`);
  const xNow = await fresh(xPub);
  const xDispute = await decide(contractor, xNow, "CONTESTEE", "Vérification de la version 2");
  const { data: xDec2 } = await service.from("expense_decisions").select("decision, version_id").eq("expense_id", xPub.id).eq("decision", "CONTESTEE");
  record("B034 : la décision reprise sur la version en vigueur vise la version 2", !xCorr.error && !xDispute.error && xDec2?.length === 1 && xDec2[0].version_id === xCorr.data.id, err(xDispute));

  // 9. Confidentialité : fonctions.
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", exMember.id);
  const anyExpense = cNow;
  const calls = (u) => [
    list(u), totals(u), alert(u), history(u, anyExpense),
    save(u, { amount: "1000" }), submit(u, anyExpense), decide(u, anyExpense, "CONTESTEE", "Tentative"),
    correct(u, anyExpense, "Tentative", "1000"), cancel(u, anyExpense, "Tentative"),
  ];
  for (const u of [owner, coOwner, exMember, outsider]) {
    const rs = await Promise.all(calls(u));
    record(`${u.label} : les 9 fonctions des dépenses refusées (not_authorized), aucune donnée`, rs.every((r) => r.error?.message === "not_authorized" && !r.data), rs.map(err).join(" / "));
  }
  const an = await Promise.all(calls(anon));
  record("Visiteur sans session : les 9 fonctions refusées", an.every((r) => !!r.error && !r.data), an.map(err).join(" / "));

  // 10. Confidentialité : tables et audit, lecture directe (D186).
  const ctAudit = await contractor.client.from("audit_events").select("id, action").eq("project_id", pid).like("action", "EXPENSE_%");
  record("Témoin : l'entreprise active lit l'audit des dépenses", !ctAudit.error && ctAudit.data.length > 0, err(ctAudit));
  for (const u of [sm, owner, coOwner, exMember, outsider]) {
    const t1 = await u.client.from("expenses").select("*").limit(1);
    const t2 = await u.client.from("expense_versions").select("*").limit(1);
    const t3 = await u.client.from("expense_decisions").select("*").limit(1);
    const t4 = await u.client.from("audit_events").select("*").eq("project_id", pid);
    record(`${u.label} : tables expenses, expense_versions, expense_decisions refusées ; aucune ligne d'audit`, [t1, t2, t3].every((r) => r.error?.code === "42501") && !t4.error && t4.data.length === 0, `${[t1, t2, t3].map((r) => r.error?.code).join("/")} / audit ${t4.data?.length ?? t4.error?.code}`);
  }
  const anonT = await anon.client.from("expenses").select("*").limit(1);
  record("Visiteur sans session : table expenses refusée", !!anonT.error, err(anonT));

  // 11. Confidentialité : surfaces lisibles par le propriétaire, dont l'historique des étapes.
  const surfaces = [
    ["synthèse financière", (u) => u.client.rpc("get_project_financial_summary", { p_project_id: pid })],
    ["fiche chantier (projects)", (u) => u.client.from("projects").select("*").eq("id", pid)],
    ["plan d'étapes", (u) => u.client.rpc("get_project_phase_plan", { p_project_id: pid })],
    ["étapes", (u) => u.client.rpc("list_project_phase_details", { p_project_id: pid })],
    ["historique des étapes", (u) => u.client.rpc("list_phase_event_details", { p_project_id: pid })],
    ["avancement validé", (u) => u.client.rpc("get_project_validated_progress", { p_project_id: pid })],
    ["journaux publiés", (u) => u.client.rpc("list_published_daily_logs", { p_project_id: pid })],
    ["incidents", (u) => u.client.rpc("list_project_incidents", { p_project_id: pid })],
    ["documents", (u) => u.client.rpc("list_project_documents", { p_project_id: pid })],
    ["photos", (u) => u.client.rpc("list_project_media", { p_project_id: pid })],
    ["versements", (u) => u.client.rpc("list_advance_payments", { p_project_id: pid })],
  ];
  for (const u of [owner, coOwner]) {
    const leaks = [];
    for (const [name, call] of surfaces) {
      const r = await call(u);
      const body = JSON.stringify(r.data ?? null) + JSON.stringify(r.error ?? null);
      if (ALL.some((x) => body.includes(x)) || /expense|dépense|depense/i.test(body)) leaks.push(name);
    }
    record(`${u.label} : aucune des ${surfaces.length} surfaces lisibles (dont l'historique des étapes) ne contient de dépense, montant ou compteur`, leaks.length === 0, leaks.join(", ") || "aucune fuite");
  }

  // 12. Accès retirés : chef de chantier puis entreprise.
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", sm.id);
  const smRev = await Promise.all(calls(sm));
  record("Chef de chantier dont l'accès est retiré : tout refusé, y compris son brouillon", smRev.every((r) => r.error?.message === "not_authorized") && (await history(sm, gUpd.data)).error?.message === "not_authorized", smRev.map(err).join(" / "));
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", contractor.id);
  const ctRev = await Promise.all(calls(contractor));
  record("Entreprise dont l'accès est retiré : tout refusé", ctRev.every((r) => r.error?.message === "not_authorized"), ctRev.map(err).join(" / "));
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
