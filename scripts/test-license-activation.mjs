// Test d'intégration LOCAL uniquement : M049, activation manuelle de licence
// et rôle administrateur de plateforme (B049 ; done_when « payeur ne gagne
// aucun droit » ; D194 A1 à A9). Données jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-license-activation.mjs

import { createClient } from "@supabase/supabase-js";
import { revokeTestAdmin } from "./lib/platform-admin.mjs";
import { createHash, randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const local = (() => { try { const { hostname } = new URL(SUPABASE_URL); return hostname === "127.0.0.1" || hostname === "localhost"; } catch { return false; } })();
if (!local) { console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`); process.exit(1); }
if (!SERVICE_KEY || !ANON_KEY) { console.error("Clés locales manquantes."); process.exit(1); }

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const BUCKET = "license-proofs";
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const err = (r) => r?.error?.message ?? r?.error?.code ?? "aucune erreur";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const one = (d) => (Array.isArray(d) ? d[0] : d);
async function must(res, what) { const r = await res; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; }
async function user(label) {
  const email = `m049-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, email, client, label };
}
const PDF = (label) => Buffer.from(`%PDF-1.4 M049 ${label} ${randomUUID()}`);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const plus12Months = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 12); return d.toISOString().slice(0, 10); })();

async function declare(u, pid, reference) {
  const bytes = PDF(reference);
  const op = randomUUID();
  const prep = await must(u.client.rpc("prepare_license_payment_upload", { p_operation_uuid: op, p_project_id: pid, p_amount_fcfa: "100000", p_operator: "ORANGE_MONEY", p_payment_reference: reference, p_paid_on: yesterday, p_payer_name: null, p_disclaimer_ack: true, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "préparation");
  const claim = await must(u.client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "revendication");
  await must(service.storage.from(BUCKET).upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "écriture");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "attestation");
  const payment = await must(u.client.rpc("finalize_license_payment_upload", { p_operation_uuid: op }), "finalisation");
  return { ...payment, key: claim.candidate_key, bytes };
}

let designatedAdmin = null;
try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const outsider = await user("hors-chantier");
  const admin = await user("administrateur");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  const PROJECT_NAME = `M049 — Villa Keita ${Date.now()}`;
  const pid = one(await must(contractor.client.rpc("create_draft_project", { p_name: PROJECT_NAME, p_country: "ML", p_role: "CONTRACTOR" }), "projet")).project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  const projectRow = (await service.from("projects").select("*").eq("id", pid).single()).data;

  // 1. Devenir administrateur : jamais par l'application (A1).
  const selfInsert = await owner.client.from("platform_admins").insert({ profile_id: owner.id });
  const selfDesignate = await owner.client.rpc("designate_platform_admin", { p_profile_id: owner.id, p_note: "auto-promotion" });
  const anonDesignate = await anon.client.rpc("designate_platform_admin", { p_profile_id: outsider.id, p_note: "x" });
  const ownerIsAdmin = await owner.client.rpc("is_platform_admin");
  record("Impossible de devenir administrateur par l'application (table fermée, désignation réservée au serveur)", selfInsert.error?.code === "42501" && /permission denied/.test(err(selfDesignate)) && !!anonDesignate.error && ownerIsAdmin.data === false, `${err(selfInsert)} / ${err(selfDesignate)} / ${err(anonDesignate)}`);
  const memberDesignated = await service.rpc("designate_platform_admin", { p_profile_id: owner.id, p_note: "membre" });
  record("A2 : désignation refusée pour un compte membre d'un chantier", memberDesignated.error?.message === "admin_has_project_membership", err(memberDesignated));
  await must(service.rpc("designate_platform_admin", { p_profile_id: admin.id, p_note: "test M049" }), "désignation");
  designatedAdmin = admin;
  record("Opération serveur : désignation d'un compte sans adhésion ; il est reconnu administrateur", (await admin.client.rpc("is_platform_admin")).data === true);
  const adminJoins = await service.from("project_memberships").insert({ project_id: pid, profile_id: admin.id, role: "SITE_MANAGER", owner_profile: null });
  const adminCreates = await admin.client.rpc("create_draft_project", { p_name: "Projet de l'administrateur", p_country: "ML", p_role: "CONTRACTOR" });
  record("A2 : un administrateur n'obtient aucune adhésion (ajout direct ou création de chantier refusés)", adminJoins.error?.message === "admin_cannot_be_project_member" && !!adminCreates.error, `${err(adminJoins)} / ${err(adminCreates)}`);

  // 2. Déclarations en attente.
  const dOwner = await declare(owner, pid, "MP-M049-PROPRIO");
  const dCt = await declare(contractor, pid, "MV-M049-ENTREPRISE");
  const rightsSnapshot = async () => JSON.stringify({
    memberships: (await service.from("project_memberships").select("profile_id, role, owner_profile, revoked_at").eq("project_id", pid).order("profile_id")).data,
    permissions: ((await service.from("membership_permissions").select("*")).data ?? []).filter((p) => JSON.stringify(p).includes(pid)),
    organizations: (await service.from("organization_memberships").select("*").in("profile_id", [owner.id, contractor.id]).order("profile_id")).data ?? [],
    admins: (await service.from("platform_admins").select("profile_id").in("profile_id", [owner.id, contractor.id])).data,
  });
  const rightsBefore = await rightsSnapshot();

  // 3. Fonctions d'administration refusées à tout autre.
  const adminCalls = (u) => [
    u.client.rpc("list_license_payments_for_review", { p_include_decided: true }),
    u.client.rpc("get_license_proof_file_key_for_admin", { p_payment_id: dOwner.id }),
    u.client.rpc("activate_license_payment", { p_payment_id: dOwner.id, p_verification_note: null }),
    u.client.rpc("reject_license_payment", { p_payment_id: dOwner.id, p_reason: "Tentative" }),
  ];
  for (const u of [owner, coOwner, contractor, sm, outsider]) {
    const rs = await Promise.all(adminCalls(u));
    record(`${u.label} : liste, preuve, activation et rejet d'administration refusés`, rs.every((r) => r.error?.message === "not_authorized" && !r.data), rs.map(err).join(" / "));
  }
  const an = await Promise.all(adminCalls(anon));
  record("Visiteur sans session : fonctions d'administration refusées", an.every((r) => !!r.error && !r.data), an.map(err).join(" / "));

  // 4. Ce que voit l'administrateur (A9).
  const forbidden = [PROJECT_NAME, owner.email, contractor.email, admin.email, owner.id, contractor.id, coOwner.id, sm.id, admin.id, projectRow.locality, projectRow.address, projectRow.description].filter((x) => typeof x === "string" && x.length > 3);
  const leaksIn = (payload) => forbidden.filter((x) => JSON.stringify(payload).includes(x));
  const listing = await admin.client.rpc("list_license_payments_for_review", { p_include_decided: false });
  const mineInList = (listing.data ?? []).filter((r) => r.payment_id === dOwner.id || r.payment_id === dCt.id);
  record("Administrateur : déclarations en attente listées (identifiant court du chantier, rôle du déclarant, montant, opérateur, référence, date, autre déclaration en attente signalée)", !listing.error && mineInList.length === 2 && mineInList.every((r) => r.project_ref === pid.slice(0, 8).toUpperCase() && r.other_pending_on_project === 1) && mineInList.some((r) => r.declared_role === "OWNER_PRIMARY") && mineInList.some((r) => r.declared_role === "CONTRACTOR"), err(listing));
  record("A9 : la liste ne contient ni nom ni adresse de chantier, ni identité de membre", leaksIn(listing.data).length === 0, leaksIn(listing.data).join(", ") || "rien");
  const proof = await admin.client.rpc("get_license_proof_file_key_for_admin", { p_payment_id: dOwner.id });
  const signed = await service.storage.from(BUCKET).createSignedUrl(one(proof.data).storage_key, 300);
  const body = Buffer.from(await (await fetch(signed.data.signedUrl)).arrayBuffer());
  record("Administrateur : preuve délivrée (contenu exact) ; réponse sans nom de chantier ni identité", !proof.error && sha(body) === sha(dOwner.bytes) && leaksIn(proof.data).length === 0, err(proof));

  // 5. Activation (A4, A6, A8) : payeur sans aucun droit nouveau.
  const shortNote = await admin.client.rpc("activate_license_payment", { p_payment_id: dOwner.id, p_verification_note: "ok" });
  record("Activation : note de vérification trop courte refusée", shortNote.error?.message === "note_invalid", err(shortNote));
  const activated = await admin.client.rpc("activate_license_payment", { p_payment_id: dOwner.id, p_verification_note: "Référence retrouvée chez l'opérateur" });
  const lic = (await service.from("project_licenses").select("*").eq("project_id", pid).single()).data;
  record("Activation par l'administrateur : déclaration ACTIVATED ; licence ACTIVE du jour pour 12 mois (A4)", !activated.error && one(activated.data)?.status === "ACTIVATED" && one(activated.data)?.license_status === "ACTIVE" && lic.status === "ACTIVE" && lic.starts_on === today && lic.ends_on === plus12Months, `${err(activated)} ${lic.starts_on} → ${lic.ends_on}`);
  record("A9 : la réponse d'activation ne contient ni nom ni adresse de chantier, ni identité de membre", leaksIn(activated.data).length === 0, leaksIn(activated.data).join(", ") || "rien");
  record("Payeur sans aucun droit nouveau : adhésions, rôles, permissions, organisations et administrateurs identiques après l'activation", (await rightsSnapshot()) === rightsBefore);
  const ownerExp = await owner.client.rpc("list_project_expenses", { p_project_id: pid });
  record("Le propriétaire payeur n'accède toujours pas aux finances internes (D183)", ownerExp.error?.message === "not_authorized", err(ownerExp));
  const ctStill = (await service.from("license_payments").select("status").eq("id", dCt.id).single()).data;
  const projAfter = (await service.from("projects").select("status").eq("id", pid).single()).data;
  record("A6 : l'autre déclaration reste en attente ; A8 : le statut du chantier est inchangé", ctStill.status === "PENDING_REVIEW" && projAfter.status === projectRow.status, `${ctStill.status} / ${projAfter.status}`);

  // 6. A7 : jamais d'activation sur une licence active ; rejet motivé (A5).
  const second = await admin.client.rpc("activate_license_payment", { p_payment_id: dCt.id, p_verification_note: null });
  record("A7 : activation impossible sur une licence déjà active", second.error?.message === "license_already_active", err(second));
  const noReason = await admin.client.rpc("reject_license_payment", { p_payment_id: dCt.id, p_reason: " " });
  const rejected = await admin.client.rpc("reject_license_payment", { p_payment_id: dCt.id, p_reason: "Doublon : licence déjà payée par le propriétaire, à régler hors application" });
  record("Rejet : motif obligatoire ; déclaration REJECTED avec motif", noReason.error?.message === "reason_required" && !rejected.error && one(rejected.data)?.status === "REJECTED" && !!one(rejected.data)?.decision_note, `${err(noReason)} / ${err(rejected)}`);
  record("A9 : la réponse de rejet ne contient ni nom ni adresse de chantier, ni identité de membre", leaksIn(rejected.data).length === 0, leaksIn(rejected.data).join(", ") || "rien");
  const again = await Promise.all([admin.client.rpc("activate_license_payment", { p_payment_id: dOwner.id, p_verification_note: null }), admin.client.rpc("reject_license_payment", { p_payment_id: dOwner.id, p_reason: "Revenir dessus" })]);
  record("Une déclaration décidée ne se redécide pas", again.every((r) => r.error?.message === "invalid_transition"), again.map(err).join(" / "));
  const ctMine = (await contractor.client.rpc("list_my_license_payments", { p_project_id: pid })).data?.[0];
  const ownerMine = (await owner.client.rpc("list_my_license_payments", { p_project_id: pid })).data?.[0];
  record("Déclarants : décision visible (rejet avec motif pour l'entreprise, activation pour le propriétaire), plus d'annulation possible", ctMine?.status === "REJECTED" && /Doublon/.test(ctMine?.decision_note ?? "") && ctMine?.can_cancel === false && ownerMine?.status === "ACTIVATED" && ownerMine?.can_cancel === false);
  for (const u of [owner, coOwner, contractor, sm]) {
    const l = one((await u.client.rpc("get_project_license", { p_project_id: pid })).data);
    record(`${u.label} : licence ACTIVE avec ses dates, sans montant ni preuve`, l?.status === "ACTIVE" && l?.starts_on === today && l?.ends_on === plus12Months && !/amount|fcfa|proof|reference/i.test(JSON.stringify(l)), JSON.stringify(l));
  }

  // 7. L'administrateur n'a accès à aucun contenu de chantier ni aux finances internes.
  const contentCalls = [
    ["projets (lecture directe)", () => admin.client.from("projects").select("id, name").eq("id", pid)],
    ["journaux publiés", () => admin.client.rpc("list_published_daily_logs", { p_project_id: pid })],
    ["incidents", () => admin.client.rpc("list_project_incidents", { p_project_id: pid })],
    ["documents", () => admin.client.rpc("list_project_documents", { p_project_id: pid })],
    ["photos", () => admin.client.rpc("list_project_media", { p_project_id: pid })],
    ["étapes", () => admin.client.rpc("list_project_phase_details", { p_project_id: pid })],
    ["synthèse financière", () => admin.client.rpc("get_project_financial_summary", { p_project_id: pid })],
    ["versements", () => admin.client.rpc("list_advance_payments", { p_project_id: pid })],
    ["dépenses", () => admin.client.rpc("list_project_expenses", { p_project_id: pid })],
    ["totaux des dépenses", () => admin.client.rpc("get_expense_totals", { p_project_id: pid })],
    ["budget interne", () => admin.client.rpc("get_internal_budget", { p_project_id: pid })],
    ["licence du chantier (vue membre)", () => admin.client.rpc("get_project_license", { p_project_id: pid })],
    ["preuve via la fonction du déclarant", () => admin.client.rpc("get_license_proof_file_key", { p_payment_id: dOwner.id })],
    ["audit du chantier", () => admin.client.from("audit_events").select("id").eq("project_id", pid)],
    ["adhésions", () => admin.client.from("project_memberships").select("profile_id").eq("project_id", pid)],
  ];
  const opened = [];
  for (const [name, call] of contentCalls) {
    const r = await call();
    const hasData = Array.isArray(r.data) ? r.data.length > 0 : r.data !== null && r.data !== undefined;
    if (!r.error && hasData) opened.push(name);
  }
  record(`Administrateur : aucun contenu de chantier ni finance interne (${contentCalls.length} surfaces refusées ou vides)`, opened.length === 0, opened.join(", ") || "rien");

  // 8. Audit de chaque action, dans le journal de plateforme (lisible du seul serveur).
  const { data: pa } = await service.from("platform_audit_events").select("action, actor_kind, actor_profile_id, project_id").or(`project_id.eq.${pid},target_id.eq.${admin.id}`);
  const actions = new Set((pa ?? []).map((a) => a.action));
  record("Audit de plateforme : désignation, lecture de preuve, activation et rejet tracés, avec l'administrateur comme acteur", ["PLATFORM_ADMIN_DESIGNATED", "LICENSE_PROOF_VIEWED", "LICENSE_ACTIVATED", "LICENSE_PAYMENT_REJECTED"].every((a) => actions.has(a)) && (pa ?? []).filter((a) => a.actor_kind === "ADMIN").every((a) => a.actor_profile_id === admin.id), [...actions].join(", "));
  const readAudit = await Promise.all([admin, contractor, owner].map((u) => u.client.from("platform_audit_events").select("id").limit(1)));
  const ctProjectAudit = (await contractor.client.from("audit_events").select("actor_profile_id, action").eq("project_id", pid)).data ?? [];
  record("Journal de plateforme illisible par l'application ; l'identité de l'administrateur n'entre pas dans l'audit du chantier", readAudit.every((r) => r.error?.code === "42501") && !ctProjectAudit.some((a) => a.actor_profile_id === admin.id), readAudit.map((r) => r.error?.code).join("/"));

  // 9. Gardes (même service_role).
  const g = await Promise.all([
    service.from("license_payments").update({ status: "PENDING_REVIEW", decided_at_server: null, decided_by_profile_id: null, decision_note: null }).eq("id", dOwner.id),
    service.from("license_payments").update({ decision_note: "réécrite" }).eq("id", dCt.id),
    service.from("platform_audit_events").delete().eq("project_id", pid),
  ]);
  record("Service : décision défaite, motif réécrit, audit de plateforme supprimé : refusés", g[0].error?.message === "license_record_immutable" && g[1].error?.message === "license_record_immutable" && g[2].error?.message === "platform_audit_immutable", g.map(err).join(" / "));
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
} finally {
  // Décision du fondateur (boucle 35) : la désignation de test est retirée.
  if (designatedAdmin) {
    const r = await revokeTestAdmin(service, designatedAdmin.id, "Fin du test M049 : désignation de test retirée.");
    const still = await designatedAdmin.client.rpc("is_platform_admin");
    record("Fin de test : désignation d'administrateur retirée et tracée, le compte n'est plus administrateur", r.ok && still.data === false, r.error ?? "");
  }
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
