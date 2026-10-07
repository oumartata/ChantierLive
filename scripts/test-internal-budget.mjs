// Test d'intégration LOCAL uniquement : M043, budget interne (B030 ; D183,
// D184, D185). Confidentialité « jamais, à aucun niveau » : propriétaire
// principal, copropriétaire, chef de chantier, non-membre, ex-membre et
// visiteur sans session n'obtiennent rien, sur aucune surface. Données
// jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-internal-budget.mjs

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
  const email = `m043-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client, label };
}

// Montants repérables : aucune réponse lisible hors entreprise ne doit les contenir.
const AMOUNT_1 = "987654321";
const AMOUNT_2 = "987654999";

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const exMember = await user("ex-coproprietaire");
  const outsider = await user("hors-chantier");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  const { data: created, error: pErr } = await contractor.client.rpc("create_draft_project", { p_name: "M043 — budget interne", p_country: "ML", p_role: "CONTRACTOR" });
  if (pErr) throw new Error(pErr.message);
  const pid = (Array.isArray(created) ? created[0] : created).project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null], [exMember, "OWNER", "CO_OWNER"]]) {
    const { error } = await service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op });
    if (error) throw new Error(`adhésion ${u.label}: ${error.message}`);
  }
  // Une étape publiée, pour vérifier que l'historique des étapes reste vierge de tout montant.
  await contractor.client.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: [{ position: 1, label: "Fondations", weight: 100 }], p_expected_revision: 0 });
  const planRev = (await contractor.client.rpc("get_project_phase_plan", { p_project_id: pid })).data;
  await contractor.client.rpc("publish_phase_plan", { p_project_id: pid, p_expected_revision: (Array.isArray(planRev) ? planRev[0] : planRev).revision });

  const set = (u, amount, reason, rev) => u.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: amount, p_reason: reason, p_expected_revision: rev });
  const get = (u) => u.client.rpc("get_internal_budget", { p_project_id: pid });
  const versions = (u) => u.client.rpc("list_internal_budget_versions", { p_project_id: pid });

  // 1. Entreprise : déclaration et montants (FCFA, entiers, positifs).
  for (const [label, amount, code] of [["zéro", "0", "amount_out_of_bounds"], ["négatif", "-5", "invalid_amount"], ["décimal", "1500.5", "invalid_amount"], ["texte", "un million", "invalid_amount"], ["trop grand", "99999999999999", "invalid_amount"]]) {
    const r = await set(contractor, amount, null, 0);
    record(`Montant refusé : ${label}`, r.error?.message === code, err(r));
  }
  const v1 = await set(contractor, AMOUNT_1, null, 0);
  record("Entreprise : déclare le budget interne (version 1, entier FCFA, bigint)", !v1.error && v1.data.version_number === 1 && Number(v1.data.amount_fcfa) === 987654321, err(v1));
  const g1 = await get(contractor);
  const g1row = Array.isArray(g1.data) ? g1.data[0] : g1.data;
  record("Entreprise : lit le budget courant", !g1.error && Number(g1row.amount_fcfa) === 987654321 && g1row.current_version_number === 1, err(g1));

  // 2. Révision directe (D185 G2 A).
  const noReason = await set(contractor, AMOUNT_2, " ", 1);
  record("Révision sans motif refusée", noReason.error?.message === "reason_required", err(noReason));
  const stale = await set(contractor, AMOUNT_2, "Hausse du ciment", 0);
  record("Révision sur révision périmée refusée", stale.error?.message === "revision_conflict", err(stale));
  const same = await set(contractor, AMOUNT_1, "Même montant", 1);
  record("Révision sans changement refusée", same.error?.message === "no_change", err(same));
  const v2 = await set(contractor, AMOUNT_2, "Hausse du ciment", 1);
  const vl = await versions(contractor);
  record("Révision : version 2 courante immédiatement, version 1 visible (BR045)", !v2.error && v2.data.version_number === 2 && vl.data?.length === 2 && vl.data[0].is_current && Number(vl.data[1].amount_fcfa) === 987654321 && vl.data[0].reason === "Hausse du ciment", err(v2));
  const upV = await service.from("budget_versions").update({ amount_fcfa: 1 }).eq("id", v1.data.id);
  const delV = await service.from("budget_versions").delete().eq("id", v1.data.id);
  const delB = await service.from("budgets").delete().eq("project_id", pid);
  record("Versions jamais modifiées ni supprimées ; budget jamais supprimé (même service_role)", upV.error?.message === "budget_version_immutable" && delV.error?.message === "budget_version_immutable" && delB.error?.message === "budget_immutable", `${err(upV)} / ${err(delV)} / ${err(delB)}`);
  const { count: audits } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("project_id", pid).in("action", ["INTERNAL_BUDGET_SET", "INTERNAL_BUDGET_REVISED"]);
  record("Audit : déclaration et révision tracées", audits === 2, String(audits));

  // 3. Confidentialité : fonctions du budget (lecture, versions, écriture).
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", exMember.id);
  for (const u of [owner, coOwner, sm, exMember, outsider]) {
    const a = await get(u);
    const b = await versions(u);
    const c = await set(u, "1000", "Tentative", 2);
    record(`${u.label} : lecture, versions et écriture du budget refusées (not_authorized)`, a.error?.message === "not_authorized" && b.error?.message === "not_authorized" && c.error?.message === "not_authorized" && !a.data && !b.data, [a, b, c].map(err).join(" / "));
  }
  const an = [await get(anon), await versions(anon), await set(anon, "1000", "x", 2)];
  record("Visiteur sans session : tout refusé", an.every((r) => !!r.error && !r.data), an.map(err).join(" / "));

  // 4. Confidentialité : tables et audit, lecture directe.
  // D186 (M044) : aucune lecture directe de l'audit hors entreprise active.
  const ctAudit = await contractor.client.from("audit_events").select("id, action").eq("project_id", pid);
  record("Témoin : l'entreprise active lit l'audit du chantier (dont le budget)", !ctAudit.error && ctAudit.data.some((e) => e.action === "INTERNAL_BUDGET_SET"), err(ctAudit));
  for (const u of [owner, coOwner, sm, exMember, outsider]) {
    const t1 = await u.client.from("budgets").select("*").limit(1);
    const t2 = await u.client.from("budget_versions").select("*").limit(1);
    const t3 = await u.client.from("audit_events").select("*").eq("project_id", pid);
    const t4 = await u.client.from("audit_events").select("id").limit(50);
    record(`${u.label} : tables budgets, budget_versions refusées ; aucune ligne d'audit (ce chantier ni aucun autre)`, t1.error?.code === "42501" && t2.error?.code === "42501" && !t3.error && t3.data.length === 0 && !t4.error && t4.data.length === 0, `${t1.error?.code} / ${t2.error?.code} / audit ${t3.data?.length ?? t3.error?.code} + ${t4.data?.length ?? t4.error?.code}`);
  }
  const anonAudit = await anon.client.from("audit_events").select("id").limit(5);
  record("Visiteur sans session : audit refusé", !!anonAudit.error || anonAudit.data.length === 0, err(anonAudit));

  // 5. Confidentialité : aucun total ni compteur dans les surfaces lisibles par le propriétaire.
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
      if (body.includes(AMOUNT_1) || body.includes(AMOUNT_2) || /budget_version|internal_budget/i.test(body)) leaks.push(name);
    }
    record(`${u.label} : aucune des ${surfaces.length} surfaces lisibles ne contient le budget interne (montants, versions)`, leaks.length === 0, leaks.join(", ") || "aucune fuite");
  }
  const projRow = (await service.from("projects").select("budget").eq("id", pid).single()).data;
  record("Enveloppe indicative partagée (projects.budget, D143) distincte du budget interne", String(projRow.budget ?? "") !== AMOUNT_2);

  // 6. Entreprise dont l'accès est retiré : elle lisait le budget, elle n'obtient plus rien.
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", contractor.id);
  const ra = await get(contractor);
  const rb = await versions(contractor);
  const rc = await set(contractor, "1000", "Après retrait", 2);
  record("Entreprise dont l'accès est retiré : lecture, versions et écriture refusées", ra.error?.message === "not_authorized" && rb.error?.message === "not_authorized" && rc.error?.message === "not_authorized", [ra, rb, rc].map(err).join(" / "));
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
