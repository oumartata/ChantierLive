// Tests ciblés — défauts reproduits en navigateur le 2026-10-04 sur l'écran
// Avancement (aucune migration, M033 inchangée) :
//   D1 « Publier » publiait le brouillon ENREGISTRÉ, pas les étapes affichées
//      (écran à 100 % + « Publication impossible : somme ≠ 100 » ; ou, pire,
//      publication silencieuse d'une version antérieure).
//      Correctif : publishPlanAction enregistre d'abord les étapes affichées
//      (upsert_phase_plan_draft, révision attendue) puis publie la révision
//      obtenue. Ce script rejoue cette séquence RPC exacte.
//   D3 Une restructuration identique (second clic) créait une nouvelle entrée
//      STRUCTURE_CHANGED. Correctif : isSameStructure() refusée côté action,
//      éditeur fermé après succès.
//   Affichage : formatPercent() en français (« 22,5 % », espace insécable).
// Limite : les Server Actions Next ne sont pas appelées ici (preuve
// navigateur séparée) ; ce script vérifie la logique pure et la séquence RPC.
//
// Usage : node --env-file=.env.local scripts/test-phase-plan-actions.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { isSameStructure, formatPercent } from "../src/app/(app)/chantiers/[id]/avancement/phasePlanDiff.ts";

const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail !== undefined ? " — " + detail : ""}`);
}

// ---------------------------------------------------------------- A. Pur
const current = [
  { phase_id: "a", position: 1, label: "Fondations", weight: "40" },
  { phase_id: "b", position: 2, label: "Toiture", weight: 60 },
];
record("A. Structure identique détectée (poids texte/nombre, espaces)", isSameStructure([{ phase_id: "a", position: 1, label: " Fondations ", weight: 40 }, { phase_id: "b", position: 2, label: "Toiture", weight: 60 }], current));
record("A. Poids modifié → différent", !isSameStructure([{ phase_id: "a", position: 1, label: "Fondations", weight: 50 }, { phase_id: "b", position: 2, label: "Toiture", weight: 50 }], current));
record("A. Libellé modifié → différent", !isSameStructure([{ phase_id: "a", position: 1, label: "Fondations profondes", weight: 40 }, { phase_id: "b", position: 2, label: "Toiture", weight: 60 }], current));
record("A. Ordre modifié → différent", !isSameStructure([{ phase_id: "b", position: 1, label: "Toiture", weight: 60 }, { phase_id: "a", position: 2, label: "Fondations", weight: 40 }], current));
record("A. Étape ajoutée (sans phase_id) → différent", !isSameStructure([...current, { position: 3, label: "Finitions", weight: 0 }], current));
record("A. Étape retirée → différent", !isSameStructure([{ phase_id: "a", position: 1, label: "Fondations", weight: 100 }], current));
record("A. Entrée invalide → jamais « identique »", !isSameStructure(null, current) && !isSameStructure([null, null], current));
record("A. formatPercent(22.5) = « 22,5 % » (espace insécable)", formatPercent(22.5) === "22,5 %", JSON.stringify(formatPercent(22.5)));
record("A. formatPercent(\"13.333\") = « 13,33 % », formatPercent(null) = « 0 % »", formatPercent("13.333") === "13,33 %" && formatPercent(null) === "0 %", `${formatPercent("13.333")} / ${formatPercent(null)}`);

// ---------------------------------------------------------------- B. RPC
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
const one = (r) => ({ ...r, row: Array.isArray(r.data) ? r.data[0] : r.data });

async function createTestUser(label) {
  const email = `avancement-actions-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, client };
}

const rows = (weights) =>
  ["Préparation du chantier", "Fondations", "Gros œuvre", "Toiture / étanchéité", "Second œuvre", "Finitions"].map((label, i) => ({ position: i + 1, label, weight: weights[i] }));

async function main() {
  const contractor = await createTestUser("contractor");
  const created = await contractor.client.rpc("create_draft_project", { p_name: "AVANCEMENT ACTIONS — test", p_country: "ML", p_role: "CONTRACTOR" });
  if (created.error) throw new Error(`create_draft_project: ${created.error.message}`);
  const pid = (Array.isArray(created.data) ? created.data[0] : created.data).project_id;
  const c = contractor.client;

  // Brouillon enregistré à 95 %, écran à 100 % (cas observé en navigateur).
  const saved95 = await c.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: rows([10, 20, 30, 15, 15, 5]), p_expected_revision: 0 }).then(one);
  record("B. Brouillon enregistré à 95 %", !saved95.error && saved95.row.status === "BROUILLON", saved95.error?.message);

  const legacy = await c.rpc("publish_phase_plan", { p_project_id: pid, p_expected_revision: saved95.row.revision }).then(one);
  record("B. Ancienne séquence (publier seul) : refus weight_sum_invalid — mécanisme de D1", legacy.error?.message === "weight_sum_invalid", legacy.error?.message);

  // Séquence corrigée de publishPlanAction : enregistrer l'affiché puis publier la révision obtenue.
  const displayed = rows([10, 20, 30, 15, 15, 10]);
  const savedDisplayed = await c.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: displayed, p_expected_revision: saved95.row.revision }).then(one);
  const published = await c.rpc("publish_phase_plan", { p_project_id: pid, p_expected_revision: savedDisplayed.row?.revision }).then(one);
  record("B. Séquence corrigée : publication acceptée", !savedDisplayed.error && !published.error && published.row.status === "PUBLIE", savedDisplayed.error?.message ?? published.error?.message);
  const after = (await c.rpc("list_project_phases", { p_project_id: pid })).data ?? [];
  record("B. Les étapes publiées sont exactement celles affichées", JSON.stringify(after.map((p) => [p.position, p.label, Number(p.weight)])) === JSON.stringify(displayed.map((p) => [p.position, p.label, p.weight])), JSON.stringify(after.map((p) => Number(p.weight))));

  // Révision périmée : l'enregistrement préalable échoue, rien n'est publié.
  const stale = await c.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: displayed, p_expected_revision: saved95.row.revision }).then(one);
  record("B. Brouillon déjà publié : l'enregistrement préalable est refusé (plan_already_published)", stale.error?.message === "plan_already_published", stale.error?.message);

  // D3 : comparaison sur les données réelles renvoyées par list_project_phases.
  const resubmitted = after.map((p) => ({ phase_id: p.phase_id, position: p.position, label: p.label, weight: Number(p.weight) }));
  record("B. Restructuration identique détectée sur les données réelles (action refusée)", isSameStructure(resubmitted, after));
  const changed = resubmitted.map((p) => (p.position === 2 ? { ...p, weight: 25 } : p.position === 3 ? { ...p, weight: 25 } : p));
  record("B. Restructuration réelle (poids modifiés) non bloquée", !isSameStructure(changed, after));
  const eventsBefore = ((await c.rpc("list_phase_events", { p_project_id: pid })).data ?? []).length;
  record("B. Aucun événement STRUCTURE_CHANGED créé par la comparaison seule", eventsBefore === 1, `${eventsBefore} événement(s)`);

  console.log(`\n${results.filter(Boolean).length}/${results.length} tests réussis.`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => {
  console.error("ÉCHEC INATTENDU:", e.message);
  process.exit(1);
});
