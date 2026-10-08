// Test d'intégration LOCAL uniquement : M050, interface d'administration à
// métadonnées minimales (B050 ; done_when « contenus privés absents » ;
// D195 E1 à E8, D194). Chaque réponse de chaque fonction d'administration
// (B050 et B049) est parcourue à la recherche de marqueurs semés dans le
// chantier (journal, incident, commentaire, dépense, budget, document, nom,
// adresse et description du chantier, identités des membres, chemins de
// fichiers privés). Un contrôle positif prouve que le scanner détecte ces
// marqueurs quand ils sont présents (R15). Données jetables créées ici.
//
// Usage : node --env-file=.env.local scripts/test-admin-console.mjs

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

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
const sha = (b) => createHash("sha256").update(b).digest("hex");
const one = (d) => (Array.isArray(d) ? d[0] : d);
async function must(res, what) { const r = await res; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; }
async function user(label) {
  const email = `m050-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, email, client, label };
}
const tag = String(Date.now()).slice(-7);
const M = {
  name: `CHANTIER-SECRET-${tag}`,
  address: `ADRESSE-SECRETE-${tag}`,
  journal: `JOURNAL-SECRET-${tag}`,
  incident: `INCIDENT-SECRET-${tag}`,
  comment: `COMMENTAIRE-SECRET-${tag}`,
  supplier: `FOURNISSEUR-SECRET-${tag}`,
  expense: "616161616",
  budget: "727272727",
  document: `DOCUMENT-SECRET-${tag}`,
};
const PRIVATE_BUCKETS = /project-media|project-documents|expense-receipts|advance-receipts|project-plans|organization-catalog/;

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const outsider = await user("hors-chantier");
  const admin = await user("administrateur");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  await must(service.rpc("designate_platform_admin", { p_profile_id: admin.id, p_note: "test M050" }), "désignation");

  // Chantier semé de contenus privés repérables.
  const pid = one(await must(contractor.client.rpc("create_draft_project", { p_name: M.name, p_country: "ML", p_role: "CONTRACTOR" }), "projet")).project_id;
  await must(service.from("projects").update({ address: M.address }).eq("id", pid), "adresse");
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const draft = await must(sm.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: today, p_works_done: M.journal, p_difficulties: null, p_team: null, p_next_actions: null }), "journal");
  await must(sm.client.rpc("publish_daily_log_draft", { p_log_id: draft.id, p_expected_revision: draft.revision }), "publication");
  await must(sm.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "AUTRE", p_severity: "FAIBLE", p_occurred_at: new Date(Date.now() - 3600000).toISOString(), p_description: M.incident }), "incident");
  await must(owner.client.rpc("add_comment", { p_target_type: "DAILY_LOG", p_target_id: draft.id, p_body: M.comment }), "commentaire");
  const exp = await must(sm.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: null, p_expected_revision: null, p_amount_fcfa: M.expense, p_expense_date: today, p_category: "MATERIAUX", p_supplier: M.supplier, p_note: null, p_phase_id: null, p_no_receipt_reason: null }), "dépense");
  await must(sm.client.rpc("submit_expense", { p_expense_id: exp.id, p_expected_revision: exp.revision }), "soumission");
  await must(contractor.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: M.budget, p_reason: null, p_expected_revision: 0 }), "budget");
  // Document « Entreprise seulement » au titre repérable.
  const docBytes = Buffer.from(`%PDF-1.4 ${M.document}`);
  const docOp = randomUUID();
  const docPrep = await must(contractor.client.rpc("prepare_document_upload", { p_operation_uuid: docOp, p_project_id: pid, p_document_id: null, p_document_type: "FACTURE", p_title: M.document, p_description: null, p_visibility: "ENTREPRISE", p_expected_checksum: sha(docBytes), p_expected_size_bytes: docBytes.length, p_expected_mime_type: "application/pdf" }), "doc");
  const docClaim = await must(contractor.client.rpc("claim_upload_attempt", { p_operation_uuid: docOp, p_expected_attempt_id: docPrep.attempt_id }), "doc claim");
  await must(service.storage.from("project-documents").upload(docClaim.candidate_key, docBytes, { contentType: "application/pdf", upsert: false }), "doc write");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: docOp, p_attempt_id: docClaim.attempt_id, p_actual_checksum: sha(docBytes), p_actual_size_bytes: docBytes.length, p_actual_mime_type: "application/pdf" }), "doc attest");
  await must(contractor.client.rpc("finalize_document_upload", { p_operation_uuid: docOp }), "doc finalize");
  // Déclaration de licence (pour les fonctions de B049).
  const lpBytes = Buffer.from(`%PDF-1.4 preuve M050 ${randomUUID()}`);
  const lpOp = randomUUID();
  const lpPrep = await must(owner.client.rpc("prepare_license_payment_upload", { p_operation_uuid: lpOp, p_project_id: pid, p_amount_fcfa: "100000", p_operator: "ORANGE_MONEY", p_payment_reference: `MP-M050-${tag}`, p_paid_on: today, p_payer_name: null, p_disclaimer_ack: true, p_expected_checksum: sha(lpBytes), p_expected_size_bytes: lpBytes.length, p_expected_mime_type: "application/pdf" }), "licence");
  const lpClaim = await must(owner.client.rpc("claim_upload_attempt", { p_operation_uuid: lpOp, p_expected_attempt_id: lpPrep.attempt_id }), "licence claim");
  await must(service.storage.from("license-proofs").upload(lpClaim.candidate_key, lpBytes, { contentType: "application/pdf", upsert: false }), "licence write");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: lpOp, p_attempt_id: lpClaim.attempt_id, p_actual_checksum: sha(lpBytes), p_actual_size_bytes: lpBytes.length, p_actual_mime_type: "application/pdf" }), "licence attest");
  const payment = await must(owner.client.rpc("finalize_license_payment_upload", { p_operation_uuid: lpOp }), "licence finalize");

  // Scanner : toute trace de contenu privé, d'identité de membre ou de fichier privé.
  const forbidden = [...Object.values(M), contractor.email, owner.email, coOwner.email, sm.email, contractor.id, owner.id, coOwner.id, sm.id, admin.id, admin.email, pid];
  const scan = (payload) => {
    const txt = JSON.stringify(payload ?? null);
    const hits = forbidden.filter((x) => txt.includes(x));
    if (PRIVATE_BUCKETS.test(txt) || txt.includes("_private/")) hits.push("chemin de fichier privé");
    return hits;
  };

  // R15 : le scanner détecte bien ces marqueurs là où ils sont légitimement présents.
  const ownerView = await Promise.all([
    owner.client.from("projects").select("id, name, address").eq("id", pid),
    owner.client.rpc("list_published_daily_logs", { p_project_id: pid }),
    contractor.client.rpc("list_project_expenses", { p_project_id: pid }),
    contractor.client.rpc("list_project_documents", { p_project_id: pid }),
  ]);
  const controlHits = new Set(ownerView.flatMap((r) => scan(r.data)));
  record("Contrôle positif (R15) : le scanner détecte nom, adresse, journal, dépense, document et identité là où ils sont présents", [M.name, M.address, M.journal, M.supplier, M.document, pid].every((m) => controlHits.has(m)), "manquants : " + ([M.name, M.address, M.journal, M.supplier, M.document, pid].filter((m) => !controlHits.has(m)).join(", ") || "aucun") + " ; erreurs : " + ownerView.map(err).join(" / "));

  const forged = { account_ref: "X", note: `${M.comment} ${M.incident} ${M.budget} ${M.expense}`, email: owner.email, key: `${pid}/_private/x.pdf`, bucket: "project-media" };
  const forgedHits = scan(forged);
  record("Contrôle positif (R15) : une réponse d'administration altérée (commentaire, incident, budget, montant, e-mail, clé privée) est détectée", [M.comment, M.incident, M.budget, M.expense, owner.email, pid, "chemin de fichier privé"].every((m) => forgedHits.includes(m)), forgedHits.length + " détections");

  // 1. Fonctions refusées à tout non-administrateur.
  const adminCalls = (u) => [
    u.client.rpc("admin_platform_stats"),
    u.client.rpc("admin_list_projects", { p_limit: 50, p_offset: 0 }),
    u.client.rpc("admin_find_account", { p_identifier: owner.email }),
    u.client.rpc("admin_list_platform_audit", { p_limit: 50 }),
    u.client.rpc("admin_set_license_offer", { p_price_fcfa: "1", p_price_is_demo: true, p_expected_price_fcfa: 1 }),
    u.client.rpc("list_license_payments_for_review", { p_include_decided: true }),
  ];
  for (const u of [owner, coOwner, contractor, sm, outsider]) {
    const rs = await Promise.all(adminCalls(u));
    record(`${u.label} : les 6 fonctions d'administration refusées (not_authorized)`, rs.every((r) => r.error?.message === "not_authorized" && !r.data), rs.map(err).join(" / "));
  }
  const an = await Promise.all(adminCalls(anon));
  record("Visiteur sans session : fonctions d'administration refusées", an.every((r) => !!r.error && !r.data), an.map(err).join(" / "));

  // 2. Tableau de bord (E2) : comptages seulement, chacun défini, aucun montant.
  const stats = await admin.client.rpc("admin_platform_stats");
  const rows = stats.data ?? [];
  record("Tableau de bord : chaque indicateur a un libellé et une définition, valeur entière positive ou nulle", !stats.error && rows.length >= 6 && rows.every((r) => r.label && r.definition && r.definition.length > 10 && Number.isInteger(Number(r.value)) && Number(r.value) >= 0), `${rows.length} indicateurs`);
  record("Tableau de bord : aucun montant (ni FCFA, ni prix, ni total financier)", rows.every((r) => !/fcfa|amount|montant|prix|price|total_/i.test(`${r.metric} ${r.label} ${r.definition}`)), rows.map((r) => r.metric).join(","));
  const pendingStat = rows.find((r) => r.metric === "license_payments_pending");
  const { count: pendingDb } = await service.from("license_payments").select("id", { count: "exact", head: true }).eq("status", "PENDING_REVIEW");
  const { count: projectsDb } = await service.from("projects").select("id", { count: "exact", head: true });
  const projectsStat = rows.filter((r) => r.metric.startsWith("projects_")).reduce((s, r) => s + Number(r.value), 0);
  record("Tableau de bord : comptages exacts (déclarations à vérifier, chantiers par statut)", Number(pendingStat?.value) === pendingDb && projectsStat === projectsDb, `${pendingStat?.value}/${pendingDb} ; ${projectsStat}/${projectsDb}`);
  record("Tableau de bord : aucun contenu privé", scan(stats.data).length === 0, scan(stats.data).join(", ") || "rien");

  // 3. Chantiers en métadonnées (E3).
  const projects = await admin.client.rpc("admin_list_projects", { p_limit: 200, p_offset: 0 });
  const mine = (projects.data ?? []).find((p) => p.project_ref === pid.slice(0, 8).toUpperCase());
  record("Chantiers : le chantier apparaît par son identifiant court, avec statut, pays, licence et membres par rôle", !projects.error && mine?.country === "ML" && mine?.license_status === "PENDING" && mine?.contractors === 1 && mine?.owners_primary === 1 && mine?.co_owners === 1 && mine?.site_managers === 1 && Number(mine?.total_count) >= 1, JSON.stringify(mine));
  record("Chantiers : ni nom, ni adresse, ni description, ni identité, ni identifiant complet", scan(projects.data).length === 0, scan(projects.data).join(", ") || "rien");

  // 4. Recherche de compte (E4, E5).
  const found = await admin.client.rpc("admin_find_account", { p_identifier: `  ${owner.email.toUpperCase()}  ` });
  const f = one(found.data);
  record("Recherche exacte (casse et espaces normalisés) : réponse minimale", !found.error && f?.account_ref === owner.id.slice(0, 8).toUpperCase() && f?.verified === true && f?.active_memberships === 1 && f?.is_admin === false, JSON.stringify(f));
  record("Recherche : la réponse ne contient ni l'e-mail cherché, ni identifiant complet, ni contenu de chantier", scan(found.data).length === 0, scan(found.data).join(", ") || "rien");
  const ctFound = one((await admin.client.rpc("admin_find_account", { p_identifier: contractor.email })).data);
  const org = ctFound?.organizations?.[0];
  record("E5 : organisation de l'entreprise avec son nom, identifiant court, membres et chantiers", !!org?.name && /^[0-9A-F]{8}$/.test(org?.organization_ref ?? "") && org?.owner === true && Number(org?.projects) >= 1, JSON.stringify(ctFound?.organizations));
  const partial = await admin.client.rpc("admin_find_account", { p_identifier: owner.email.slice(0, 12) + "@example.test" });
  const tooShort = await admin.client.rpc("admin_find_account", { p_identifier: "ab" });
  record("Recherche : aucun résultat sans identifiant exact ; identifiant trop court refusé ; aucune fonction de liste nominative", !partial.error && (partial.data ?? []).length === 0 && tooShort.error?.message === "identifier_invalid", `${(partial.data ?? []).length} / ${err(tooShort)}`);
  const { data: lookups } = await service.from("platform_audit_events").select("context, target_id").eq("actor_profile_id", admin.id).eq("action", "ADMIN_ACCOUNT_LOOKUP");
  const ownerLookup = (lookups ?? []).find((l) => l.target_id === owner.id);
  record("Chaque recherche est auditée (trouvée ou non), identifiant masqué, jamais en clair", (lookups ?? []).length >= 3 && (lookups ?? []).some((l) => l.context?.found === false) && !!ownerLookup && !JSON.stringify(lookups).includes(owner.email) && /•••@example\.test/.test(ownerLookup.context.identifier_masked), `${(lookups ?? []).length} recherches`);

  // 5. Prix de la licence (E7).
  const before = one((await owner.client.rpc("get_license_offer")).data);
  const stale = await admin.client.rpc("admin_set_license_offer", { p_price_fcfa: "125000", p_price_is_demo: true, p_expected_price_fcfa: Number(before.price_fcfa) + 1 });
  const same = await admin.client.rpc("admin_set_license_offer", { p_price_fcfa: String(before.price_fcfa), p_price_is_demo: before.price_is_demo, p_expected_price_fcfa: Number(before.price_fcfa) });
  const bad = await admin.client.rpc("admin_set_license_offer", { p_price_fcfa: "12.5", p_price_is_demo: true, p_expected_price_fcfa: Number(before.price_fcfa) });
  record("Prix : valeur attendue périmée, sans changement ou montant invalide refusés", stale.error?.message === "revision_conflict" && same.error?.message === "no_change" && bad.error?.message === "invalid_amount", `${err(stale)} / ${err(same)} / ${err(bad)}`);
  const changed = await admin.client.rpc("admin_set_license_offer", { p_price_fcfa: "125000", p_price_is_demo: true, p_expected_price_fcfa: Number(before.price_fcfa) });
  const after = one((await owner.client.rpc("get_license_offer")).data);
  const declStill = (await service.from("license_payments").select("offer_price_fcfa").eq("id", payment.id).single()).data;
  record("Prix modifié par l'administrateur ; la déclaration existante garde son prix figé", !changed.error && Number(after.price_fcfa) === 125000 && Number(declStill.offer_price_fcfa) === Number(before.price_fcfa), `${before.price_fcfa} → ${after.price_fcfa} ; déclaration ${declStill.offer_price_fcfa}`);
  const { data: priceAudit } = await service.from("platform_audit_events").select("context").eq("actor_profile_id", admin.id).eq("action", "LICENSE_OFFER_CHANGED");
  record("Modification du prix auditée avec ancienne et nouvelle valeur", (priceAudit ?? []).some((a) => Number(a.context?.old?.price_fcfa) === Number(before.price_fcfa) && Number(a.context?.new?.price_fcfa) === 125000), JSON.stringify(priceAudit?.[0]?.context));
  record("Réponse de modification du prix sans contenu privé", scan(changed.data).length === 0);
  const restored = await admin.client.rpc("admin_set_license_offer", { p_price_fcfa: String(before.price_fcfa), p_price_is_demo: before.price_is_demo, p_expected_price_fcfa: 125000 });
  record("Prix d'origine rétabli (données de démonstration inchangées)", !restored.error && Number(one(restored.data)?.price_fcfa) === Number(before.price_fcfa), err(restored));

  // 6. Journal de plateforme (E6) et fonctions de licence (B049) : aucun contenu privé.
  const audit = await admin.client.rpc("admin_list_platform_audit", { p_limit: 200 });
  record("Journal de plateforme lisible par l'administrateur (acteur « vous », chantier en identifiant court), sans contenu privé", !audit.error && (audit.data ?? []).some((a) => a.action === "ADMIN_ACCOUNT_LOOKUP" && a.actor === "vous") && scan(audit.data).length === 0, scan(audit.data).join(", ") || "rien");
  const review = await admin.client.rpc("list_license_payments_for_review", { p_include_decided: true });
  record("Licences à vérifier : sans contenu privé", !review.error && scan(review.data).length === 0, scan(review.data).join(", ") || "rien");
  const proof = await admin.client.rpc("get_license_proof_file_key_for_admin", { p_payment_id: payment.id });
  const proofRow = one(proof.data);
  const { storage_key: proofKey, ...proofRest } = proofRow ?? {};
  record("Preuve de licence (L5) : seule la clé du compartiment license-proofs, aucun autre contenu privé", !proof.error && proofRow?.bucket === "license-proofs" && proofKey?.includes("/license_proof/") && scan(proofRest).length === 0, err(proof));
  const rejected = await admin.client.rpc("reject_license_payment", { p_payment_id: payment.id, p_reason: "Test M050 : référence introuvable" });
  record("Rejet par l'administrateur : réponse sans contenu privé", !rejected.error && scan(rejected.data).length === 0, scan(rejected.data).join(", ") || err(rejected));

  // 7. L'administrateur ne lit jamais l'audit des chantiers ni leurs contenus.
  const projAudit = await admin.client.from("audit_events").select("id").eq("project_id", pid);
  const projRow = await admin.client.from("projects").select("name").eq("id", pid);
  const logs = await admin.client.rpc("list_published_daily_logs", { p_project_id: pid });
  record("Administrateur : audit du chantier, fiche et journaux inaccessibles", !projAudit.error && projAudit.data.length === 0 && !projRow.error && projRow.data.length === 0 && logs.error?.message === "not_authorized", `${projAudit.data?.length} / ${projRow.data?.length} / ${err(logs)}`);
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
