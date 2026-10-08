// Test d'intégration LOCAL uniquement : M051, accès support limité et
// expirant (B051 ; done_when « motif périmètre et audit obligatoires » ;
// D197 : S1 à S10 dans le cadre de la boucle 35b ; BR089, EC061, EC062).
// - aucun accès sans dossier, sans motif de prise en charge, sans accord d'une
//   partie principale, hors périmètre, après expiration, révocation ou
//   clôture ; refus journalisés ;
// - lecture seule : aucune écriture, contenus inchangés ;
// - jamais de finance interne ni d'audit du chantier : scanner partagé avec
//   test-admin-console (scripts/lib/private-scan.mjs), capable d'échouer (R15) ;
// - journal d'accès visible des deux parties principales seulement.
// Données jetables créées ici ; les désignations d'administrateur sont
// retirées à la fin (D196).
//
// Usage : node --env-file=.env.local scripts/test-support-access.mjs

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { revokeTestAdmin } from "./lib/platform-admin.mjs";
import { makeScanner } from "./lib/private-scan.mjs";

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
const err = (r) => r?.error?.message ?? r?.error?.code ?? r?.data?.error ?? "aucune erreur";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const one = (d) => (Array.isArray(d) ? d[0] : d);
async function must(res, what) { const r = await res; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; }
async function user(label) {
  const email = `m051-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
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
  name: `CHANTIER-SUPPORT-${tag}`,
  address: `ADRESSE-SUPPORT-${tag}`,
  journal: `JOURNAL-PUBLIE-${tag}`,
  draftLog: `JOURNAL-BROUILLON-${tag}`,
  incident: `INCIDENT-SUPPORT-${tag}`,
  comment: `COMMENTAIRE-VISIBLE-${tag}`,
  retracted: `COMMENTAIRE-RETIRE-${tag}`,
  supplier: `FOURNISSEUR-INTERNE-${tag}`,
  expense: "818181818",
  budget: "929292929",
  budget2: "939393939",
  budgetReason: `MOTIF-BUDGET-${tag}`,
  docShared: `DOC-PRINCIPAUX-${tag}`,
  docInternal: `DOC-ENTREPRISE-${tag}`,
  description: `DOSSIER-SUPPORT-${tag} : les photos ne s'affichent plus`,
  photo: `PHOTO-PUBLIEE-${tag}`,
  draftPhoto: `PHOTO-BROUILLON-${tag}`,
};
const designated = [];
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64"
);

// Photo (même flux que test-file-cross-access).
async function uploadMedia(u, pid, caption, publish) {
  const op = randomUUID();
  await must(u.client.rpc("prepare_media_upload", { p_operation_uuid: op, p_project_id: pid, p_expected_checksum: sha(JPEG), p_expected_size_bytes: JPEG.length, p_expected_mime_type: "image/jpeg" }), "prepare_media_upload");
  const temp = `_private/${pid}/media_asset/${op}/source`;
  const signed = await must(service.storage.from("project-media").createSignedUploadUrl(temp), "createSignedUploadUrl");
  await must(u.client.storage.from("project-media").uploadToSignedUrl(signed.path, signed.token, JPEG, { contentType: "image/jpeg", upsert: true }), "uploadToSignedUrl");
  const claim = await must(u.client.rpc("claim_upload_attempt", { p_operation_uuid: op }), "claim media");
  await must(service.storage.from("project-media").upload(claim.candidate_key, JPEG, { contentType: "image/jpeg", upsert: false }), "write candidate");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(JPEG), p_actual_size_bytes: JPEG.length, p_actual_mime_type: "image/jpeg" }), "attest media");
  const row = one(await must(u.client.rpc("finalize_media_upload", { p_operation_uuid: op, p_origin: "IMPORTED", p_caption: caption }), "finalize media"));
  if (publish) await must(u.client.rpc("publish_media_asset", { p_media_asset_id: row.id }), "publish media");
  return row.id;
}

async function deposit(u, pid, title, visibility) {
  const bytes = Buffer.from(`%PDF-1.4 ${title} ${randomUUID()}`);
  const op = randomUUID();
  const prep = await must(u.client.rpc("prepare_document_upload", { p_operation_uuid: op, p_project_id: pid, p_document_id: null, p_document_type: "AUTRE", p_title: title, p_description: null, p_visibility: visibility, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "doc");
  const claim = await must(u.client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "doc claim");
  await must(service.storage.from("project-documents").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "doc write");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "doc attest");
  const fin = one(await must(u.client.rpc("finalize_document_upload", { p_operation_uuid: op }), "doc finalize"));
  const id = fin.document_id ?? fin.id;
  const { data: row } = await service.from("documents").select("revision").eq("id", id).single();
  await must(u.client.rpc("publish_document", { p_document_id: id, p_expected_revision: row.revision }), "doc publish");
  return { id };
}

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const outsider = await user("hors-chantier");
  const admin = await user("administrateur");
  const admin2 = await user("administrateur2");
  const anon = { label: "visiteur", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  for (const a of [admin, admin2]) {
    await must(service.rpc("designate_platform_admin", { p_profile_id: a.id, p_note: "test M051" }), "désignation");
    designated.push(a);
  }

  // Chantier semé.
  const pid = one(await must(contractor.client.rpc("create_draft_project", { p_name: M.name, p_country: "ML", p_role: "CONTRACTOR" }), "projet")).project_id;
  await must(service.from("projects").update({ address: M.address }).eq("id", pid), "adresse");
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const log = await must(sm.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: today, p_works_done: M.journal, p_difficulties: null, p_team: null, p_next_actions: null }), "journal");
  await must(sm.client.rpc("publish_daily_log_draft", { p_log_id: log.id, p_expected_revision: log.revision }), "publication");
  await must(sm.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: yesterday, p_works_done: M.draftLog, p_difficulties: null, p_team: null, p_next_actions: null }), "brouillon");
  await must(sm.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "AUTRE", p_severity: "FAIBLE", p_occurred_at: new Date(Date.now() - 3600000).toISOString(), p_description: M.incident }), "incident");
  await must(owner.client.rpc("add_comment", { p_target_type: "DAILY_LOG", p_target_id: log.id, p_body: M.comment }), "commentaire");
  const toRetract = await must(owner.client.rpc("add_comment", { p_target_type: "DAILY_LOG", p_target_id: log.id, p_body: M.retracted }), "commentaire 2");
  await must(owner.client.rpc("retract_comment", { p_comment_id: toRetract.id, p_expected_revision: toRetract.revision }), "retrait");
  const exp = await must(sm.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: null, p_expected_revision: null, p_amount_fcfa: M.expense, p_expense_date: today, p_category: "MATERIAUX", p_supplier: M.supplier, p_note: null, p_phase_id: null, p_no_receipt_reason: null }), "dépense");
  await must(sm.client.rpc("submit_expense", { p_expense_id: exp.id, p_expected_revision: exp.revision }), "soumission");
  const b1 = await must(contractor.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: M.budget, p_reason: null, p_expected_revision: 0 }), "budget");
  await must(contractor.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: M.budget2, p_reason: M.budgetReason, p_expected_revision: b1.version_number ?? 1 }), "révision budget");
  const docShared = await deposit(contractor, pid, M.docShared, "PRINCIPAUX");
  const docInternal = await deposit(contractor, pid, M.docInternal, "ENTREPRISE");
  const photoId = await uploadMedia(sm, pid, M.photo, true);
  const draftPhotoId = await uploadMedia(sm, pid, M.draftPhoto, false);
  const docSharedId = docShared.id;
  const docInternalId = docInternal.id;
  // Marqueurs d'audit réels : identifiants des événements d'audit du chantier.
  const { data: auditRows } = await service.from("audit_events").select("id").eq("project_id", pid);
  const auditIds = (auditRows ?? []).map((a) => a.id);

  // Scanner : finances internes, audit, brouillons, commentaires retirés,
  // identités, nom et adresse du chantier, chemins de fichiers privés.
  const forbiddenAlways = [M.name, M.address, M.draftLog, M.draftPhoto, M.retracted, M.supplier, M.expense, M.budget, M.budget2, M.budgetReason,
    contractor.email, owner.email, coOwner.email, sm.email, admin.email, contractor.id, owner.id, coOwner.id, sm.id, admin.id, pid, ...auditIds];
  const scan = makeScanner(forbiddenAlways);

  // R15 : le scanner détecte ces marqueurs là où ils sont légitimement présents.
  const legit = await Promise.all([
    contractor.client.rpc("list_project_expenses", { p_project_id: pid }),
    contractor.client.from("audit_events").select("id, action").eq("project_id", pid),
    sm.client.rpc("list_my_daily_log_drafts", { p_project_id: pid }).then((r) => (r.error ? sm.client.from("daily_logs").select("works_done").eq("project_id", pid) : r)),
    owner.client.from("projects").select("id, name, address").eq("id", pid),
    service.from("budget_versions").select("amount_fcfa, reason").eq("project_id", pid),
    sm.client.rpc("list_project_media", { p_project_id: pid }),
  ]);
  const legitHits = new Set(legit.flatMap((r) => scan(r.data)));
  const mustSee = [M.supplier, M.budgetReason, M.budget2, M.draftLog, M.draftPhoto, M.name, M.address, pid, ...auditIds];
  record("Contrôle positif (R15) : le scanner trouve dépense, budget et son motif, audit du chantier, brouillon, nom, adresse et identifiant là où ils sont présents",
    mustSee.every((m) => legitHits.has(m)), "manquants : " + (mustSee.filter((m) => !legitHits.has(m)).join(", ") || "aucun") + " ; " + legit.map(err).join(" / "));
  record("L'audit du chantier a des événements à repérer (marqueurs d'audit réels)", auditIds.length >= 5, String(auditIds.length));
  const forged = { ok: true, items: [{ note: `${M.supplier} ${M.budget2} ${M.retracted}`, by: owner.email, key: `${pid}/_private/x.pdf`, bucket: "expense-receipts" }] };
  const forgedHits = scan(forged);
  record("Contrôle positif (R15) : une réponse support altérée (dépense, budget, commentaire retiré, e-mail, clé privée) est détectée",
    [M.supplier, M.budget2, M.retracted, owner.email, pid, "chemin de fichier privé"].every((m) => forgedHits.includes(m)), `${forgedHits.length} détections`);

  // 1. Qui peut demander (S2) ; validation du dossier et de l'accord.
  const ask = (u, extra = {}) => u.client.rpc("support_create_request", { p_project_id: pid, p_category: "TECHNIQUE", p_description: M.description, p_grant_modules: null, p_grant_duration_minutes: null, ...extra });
  const refusedAsk = await Promise.all([ask(coOwner), ask(sm), ask(outsider), ask(admin)]);
  record("Copropriétaire, chef de chantier, compte hors chantier et administrateur ne peuvent pas ouvrir de dossier", refusedAsk.every((r) => r.error?.message === "not_authorized"), refusedAsk.map(err).join(" / "));
  const anonAsk = await ask(anon);
  record("Visiteur sans session refusé", !!anonAsk.error, err(anonAsk));
  const bad = await Promise.all([
    ask(owner, { p_description: "court" }),
    ask(owner, { p_category: "URGENT" }),
    ask(owner, { p_grant_modules: ["JOURNAL", "BUDGET"], p_grant_duration_minutes: 15 }),
    ask(owner, { p_grant_modules: ["DEPENSES"], p_grant_duration_minutes: 15 }),
    ask(owner, { p_grant_modules: ["AUDIT"], p_grant_duration_minutes: 15 }),
    ask(owner, { p_grant_modules: ["JOURNAL"], p_grant_duration_minutes: 20 }),
  ]);
  record("Motif trop court, catégorie inconnue, finances internes, audit du chantier et durée hors 15/30/60 refusés",
    bad.map((r) => r.error?.message).join(",") === "description_invalid,category_invalid,scope_invalid,scope_invalid,scope_invalid,duration_invalid", bad.map(err).join(" / "));
  const { count: leftover } = await service.from("support_requests").select("id", { count: "exact", head: true }).eq("project_id", pid);
  record("Aucun dossier créé par une demande refusée (transaction annulée)", leftover === 0, String(leftover));

  // 2. Dossier du propriétaire principal, sans accord ; liste minimisée.
  const reqO = one(await must(ask(owner), "dossier propriétaire"));
  const adminList = await admin.client.rpc("admin_list_support_requests", { p_include_closed: true });
  const listed = (adminList.data ?? []).find((r) => r.request_id === reqO.request_id);
  record("Liste du support minimisée : catégorie, chantier en identifiant court, partie, statut ; ni description ni identité", !!listed && listed.project_ref === pid.slice(0, 8).toUpperCase() && !JSON.stringify(adminList.data).includes(M.description) && scan(adminList.data).length === 0, scan(adminList.data).join(", ") || "rien");

  // 3. Prise en charge motivée (motif obligatoire) ; un seul administrateur.
  const noReason = await admin.client.rpc("admin_take_support_request", { p_request_id: reqO.request_id, p_reason: "court" });
  const getBefore = await admin.client.rpc("admin_get_support_request", { p_request_id: reqO.request_id });
  record("Sans motif de prise en charge : refus ; description illisible avant prise en charge", noReason.error?.message === "reason_required" && getBefore.error?.message === "not_assigned", `${err(noReason)} / ${err(getBefore)}`);
  await must(admin.client.rpc("admin_take_support_request", { p_request_id: reqO.request_id, p_reason: "Diagnostic de l'affichage des photos" }), "prise en charge");
  const take2 = await admin2.client.rpc("admin_take_support_request", { p_request_id: reqO.request_id, p_reason: "Second administrateur" });
  const get2 = await admin2.client.rpc("admin_get_support_request", { p_request_id: reqO.request_id });
  const got = one((await admin.client.rpc("admin_get_support_request", { p_request_id: reqO.request_id })).data);
  record("Prise en charge unique ; l'autre administrateur ne lit pas le dossier ; description rendue à celui qui l'a pris en charge",
    take2.error?.message === "request_already_taken" && get2.error?.message === "not_assigned" && got?.description === M.description && got?.grants?.length === 0, `${err(take2)} / ${err(get2)}`);
  const ghost = await admin.client.rpc("support_read", { p_grant_id: randomUUID(), p_module: "JOURNAL" });
  const { data: ghostAudit } = await service.from("platform_audit_events").select("reason").eq("actor_profile_id", admin.id).eq("action", "SUPPORT_ACCESS_DENIED");
  record("Sans accord : aucune lecture possible (accord inconnu refusé et journalisé, EC061)", ghost.data?.ok === false && ghost.data?.error === "grant_not_found" && (ghostAudit ?? []).length === 1, err(ghost));

  // 4. Accord du propriétaire principal : JOURNAL et DOCUMENTS, 15 min.
  const gO = one(await must(owner.client.rpc("support_grant_access", { p_request_id: reqO.request_id, p_modules: ["journal", "DOCUMENTS"], p_duration_minutes: 15 }), "accord propriétaire"));
  const ttl = (new Date(gO.expires_at_server) - new Date(gO.granted_at_server)) / 60000;
  const again = await owner.client.rpc("support_grant_access", { p_request_id: reqO.request_id, p_modules: ["JOURNAL"], p_duration_minutes: 15 });
  record("Accord de 15 min, modules normalisés ; second accord simultané refusé", ttl === 15 && gO.modules.join(",") === "DOCUMENTS,JOURNAL" && again.error?.message === "grant_already_active", `${ttl} min / ${err(again)}`);
  const rd = (u, g, m) => u.client.rpc("support_read", { p_grant_id: g, p_module: m });
  const jO = await rd(admin, gO.grant_id, "JOURNAL");
  const dO = await rd(admin, gO.grant_id, "DOCUMENTS");
  const outO = await rd(admin, gO.grant_id, "INCIDENTS");
  const otherAdmin = await rd(admin2, gO.grant_id, "JOURNAL");
  record("Journal publié lu ; jamais le brouillon", jO.data?.ok === true && JSON.stringify(jO.data).includes(M.journal) && !JSON.stringify(jO.data).includes(M.draftLog), err(jO));
  record("Documents vus comme le propriétaire principal : le document « principaux » oui, le document « entreprise » non",
    dO.data?.ok === true && JSON.stringify(dO.data).includes(M.docShared) && !JSON.stringify(dO.data).includes(M.docInternal), err(dO));
  record("Hors périmètre refusé (incidents non accordés) ; autre administrateur refusé", outO.data?.error === "out_of_scope" && otherAdmin.data?.error === "not_assigned", `${err(outO)} / ${err(otherAdmin)}`);
  const fileOut = await admin.client.rpc("support_get_file", { p_grant_id: gO.grant_id, p_kind: "DOCUMENT", p_object_id: docInternalId });
  const fileOk = await admin.client.rpc("support_get_file", { p_grant_id: gO.grant_id, p_kind: "DOCUMENT", p_object_id: docSharedId });
  record("Fichier : document « entreprise » refusé sous l'accord du propriétaire ; document partagé ouvert, lien de 60 s au plus",
    fileOut.data?.error === "object_not_found" && fileOk.data?.ok === true && fileOk.data?.bucket === "project-documents" && fileOk.data?.expires_in <= 60 && fileOk.data?.expires_in > 0, `${err(fileOut)} / ${fileOk.data?.expires_in}`);

  // 5. Révocation par l'AUTRE partie principale (cadre 35b).
  const rev = await contractor.client.rpc("support_revoke_access", { p_grant_id: gO.grant_id, p_reason: "Plus nécessaire" });
  const afterRev = await rd(admin, gO.grant_id, "JOURNAL");
  const revAgain = await owner.client.rpc("support_revoke_access", { p_grant_id: gO.grant_id, p_reason: null });
  const revBy = await Promise.all([coOwner, sm].map((u) => u.client.rpc("support_revoke_access", { p_grant_id: gO.grant_id, p_reason: null })));
  record("Révocation par l'entreprise d'un accord donné par le propriétaire ; lecture ensuite refusée ; pas de seconde révocation ; copropriétaire et chef refusés",
    !rev.error && afterRev.data?.error === "access_revoked" && revAgain.error?.message === "grant_already_revoked" && revBy.every((r) => r.error?.message === "not_authorized"), `${err(afterRev)} / ${err(revAgain)} / ${revBy.map(err).join(",")}`);

  // 6. Expiration (EC062) : accord antidaté par une opération serveur.
  const past = new Date(Date.now() - 20 * 60000);
  const expired = await must(service.from("support_access_grants").insert({ request_id: reqO.request_id, project_id: pid, granted_by_profile_id: owner.id, granted_by_party: "OWNER_PRIMARY", modules: ["JOURNAL"], duration_minutes: 15, granted_at_server: past.toISOString(), expires_at_server: new Date(past.getTime() + 15 * 60000).toISOString() }).select("id").single(), "accord antidaté");
  const afterExp = await rd(admin, expired.id, "JOURNAL");
  const revExp = await owner.client.rpc("support_revoke_access", { p_grant_id: expired.id, p_reason: null });
  const inconsistent = await service.from("support_access_grants").insert({ request_id: reqO.request_id, project_id: pid, granted_by_profile_id: owner.id, granted_by_party: "OWNER_PRIMARY", modules: ["JOURNAL"], duration_minutes: 15, granted_at_server: past.toISOString(), expires_at_server: new Date(Date.now() + 86400000).toISOString() });
  record("Après expiration : lecture refusée (access_expired), révocation inutile refusée ; échéance incohérente avec la durée refusée en base",
    afterExp.data?.error === "access_expired" && revExp.error?.message === "grant_expired" && !!inconsistent.error, `${err(afterExp)} / ${err(revExp)} / ${inconsistent.error?.message}`);

  // 7. Dossier de l'entreprise avec accord immédiat de tous les modules, 30 min.
  const reqC = one(await must(ask(contractor, { p_category: "DONNEES", p_grant_modules: ["JOURNAL", "INCIDENTS", "PHOTOS", "DOCUMENTS", "AVANCEMENT", "COMMENTAIRES", "EQUIPE"], p_grant_duration_minutes: 30 }), "dossier entreprise"));
  await must(admin.client.rpc("admin_take_support_request", { p_request_id: reqC.request_id, p_reason: "Contrôle des données du chantier" }), "prise en charge 2");
  const counts = async () => {
    const out = {};
    for (const t of ["daily_logs", "incidents", "documents", "comments", "expenses", "media_assets", "project_memberships", "budgets"]) {
      out[t] = (await service.from(t).select("id", { count: "exact", head: true }).eq("project_id", pid)).count;
    }
    return JSON.stringify(out);
  };
  const before = await counts();
  const modules = ["JOURNAL", "INCIDENTS", "PHOTOS", "DOCUMENTS", "AVANCEMENT", "COMMENTAIRES", "EQUIPE"];
  const reads = {};
  for (const m of modules) reads[m] = await rd(admin, reqC.grant_id, m);
  record("Les 7 modules accordés sont lisibles", modules.every((m) => reads[m].data?.ok === true && Array.isArray(reads[m].data.items)), modules.map((m) => `${m}:${reads[m].data?.items?.length ?? err(reads[m])}`).join(" "));
  const allTxt = JSON.stringify(reads);
  record("Contenus attendus présents (journal publié, incident, commentaire visible, document « entreprise » sous l'accord de l'entreprise)",
    [M.journal, M.incident, M.comment, M.docShared, M.docInternal, M.photo].every((m) => allTxt.includes(m)));
  const photoFile = await admin.client.rpc("support_get_file", { p_grant_id: reqC.grant_id, p_kind: "PHOTO", p_object_id: photoId });
  const draftFile = await admin.client.rpc("support_get_file", { p_grant_id: reqC.grant_id, p_kind: "PHOTO", p_object_id: draftPhotoId });
  record("Photo publiée ouverte (lien de 60 s au plus) ; photo en brouillon refusée", photoFile.data?.ok === true && photoFile.data?.bucket === "project-media" && photoFile.data?.expires_in <= 60 && draftFile.data?.error === "object_not_found", `${err(photoFile)} / ${err(draftFile)}`);
  const hits = modules.flatMap((m) => scan(reads[m].data).map((h) => `${m}:${h}`));
  record("Scanner sur chaque module : aucune finance interne, aucun motif d'audit, aucun brouillon, aucun commentaire retiré, aucune identité, ni nom ni adresse",
    hits.length === 0, hits.join(", ") || "rien");
  const equipe = reads.EQUIPE.data.items;
  record("Équipe : rôles seulement, sans coordonnées", equipe.length === 4 && equipe.every((e) => Object.keys(e).sort().join(",") === "owner_profile,role,since"), JSON.stringify(equipe));
  const finance = await Promise.all(["BUDGET", "DEPENSES", "FINANCES", "AUDIT", "RECUS"].map((m) => rd(admin, reqC.grant_id, m)));
  record("Finances internes et audit du chantier jamais lisibles, même sous l'accord de l'entreprise", finance.every((r) => r.data?.error === "out_of_scope"), finance.map(err).join(","));
  const fileC = await admin.client.rpc("support_get_file", { p_grant_id: reqC.grant_id, p_kind: "DOCUMENT", p_object_id: docInternalId });
  const { storage_key: fk, bucket: fb, ...fileRest } = fileC.data ?? {};
  record("Fichier sous l'accord de l'entreprise : document « entreprise » ouvert ; réponse sans autre contenu privé", fileC.data?.ok === true && fb === "project-documents" && !!fk && scan(fileRest).length === 0, err(fileC));

  // 8. Lecture seule (S6) : aucune écriture, contenus inchangés.
  const writes = await Promise.all([
    admin.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: today, p_works_done: "écriture support", p_difficulties: null, p_team: null, p_next_actions: null }),
    admin.client.rpc("add_comment", { p_target_type: "DAILY_LOG", p_target_id: log.id, p_body: "écriture support" }),
    admin.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "AUTRE", p_severity: "FAIBLE", p_occurred_at: new Date().toISOString(), p_description: "écriture support" }),
    admin.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: null, p_expected_revision: null, p_amount_fcfa: "1000", p_expense_date: today, p_category: "MATERIAUX", p_supplier: null, p_note: null, p_phase_id: null, p_no_receipt_reason: null }),
    admin.client.from("daily_logs").insert({ project_id: pid, author_profile_id: admin.id, log_date: today, status: "BROUILLON" }),
    admin.client.from("support_access_events").insert({ project_id: pid, request_id: reqC.request_id, actor_kind: "ADMIN", actor_profile_id: admin.id, action: "ACCESS_READ" }),
  ]);
  record("Pendant un accès ouvert, toute écriture de l'administrateur est refusée (journal, commentaire, incident, dépense, tables, journal d'accès)", writes.every((r) => !!r.error), writes.map(err).join(" / "));
  const ordinary = await Promise.all([
    admin.client.rpc("list_published_daily_logs", { p_project_id: pid }),
    admin.client.rpc("list_project_expenses", { p_project_id: pid }),
    admin.client.from("audit_events").select("id").eq("project_id", pid),
    admin.client.from("budget_versions").select("id").eq("project_id", pid),
  ]);
  record("Pendant un accès ouvert, les lectures ordinaires restent fermées à l'administrateur (journaux, dépenses, audit, budget)",
    ordinary[0].error?.message === "not_authorized" && !!ordinary[1].error && (ordinary[2].data ?? []).length === 0 && (ordinary[3].data ?? []).length === 0, ordinary.map((r) => r.error?.message ?? `${r.data?.length} ligne(s)`).join(" / "));
  record("Contenus du chantier inchangés après toutes les lectures support", (await counts()) === before, before);

  // 9. Journal d'accès (S8) et bandeau (S9).
  const banner = await owner.client.rpc("support_active_access", { p_project_id: pid });
  record("Bandeau : l'accès ouvert par l'entreprise est visible du propriétaire principal", (banner.data ?? []).length === 1 && banner.data[0].granted_by_party === "CONTRACTOR", err(banner));
  const jOwner = await owner.client.rpc("support_list_access_journal", { p_project_id: pid });
  const jCt = await contractor.client.rpc("support_list_access_journal", { p_project_id: pid });
  const acts = (jOwner.data ?? []).map((e) => e.action);
  record("Journal d'accès lisible par les deux parties principales, identique", !jOwner.error && !jCt.error && JSON.stringify(jOwner.data) === JSON.stringify(jCt.data), `${jOwner.data?.length} événements`);
  record("Journal complet : dossier, accord, prise en charge (avec motif), lecture du dossier, lectures, fichiers, refus, révocation, expiration",
    ["REQUEST_CREATED", "ACCESS_GRANTED", "REQUEST_TAKEN", "REQUEST_VIEWED", "ACCESS_READ", "FILE_OPENED", "ACCESS_DENIED", "ACCESS_REVOKED", "ACCESS_EXPIRED"].every((a) => acts.includes(a))
      && (jOwner.data ?? []).some((e) => e.action === "REQUEST_TAKEN" && e.detail === "Diagnostic de l'affichage des photos")
      && (jOwner.data ?? []).some((e) => e.action === "ACCESS_REVOKED" && e.actor === "entreprise"), [...new Set(acts)].join(","));
  const readsLogged = (jOwner.data ?? []).filter((e) => e.action === "ACCESS_READ").length;
  const { data: rawReads } = await service.from("support_access_events").select("module, object_count, object_ids").eq("project_id", pid).eq("action", "ACCESS_READ");
  record("Chaque lecture auditée avec module et objets consultés (9 lectures réussies)", readsLogged === 9 && (rawReads ?? []).every((e) => e.module && e.object_count === (e.object_ids ?? []).length), `${readsLogged}`);
  const journalHits = makeScanner([...forbiddenAlways, M.docInternal, M.docShared, M.journal, M.incident, M.comment, M.description])(jOwner.data);
  record("Journal vu du propriétaire : aucun contenu lu, aucun titre (même du document « entreprise »), aucune description de dossier", journalHits.length === 0, journalHits.join(", ") || "rien");
  const hidden = await Promise.all([coOwner, sm, outsider].flatMap((u) => [
    u.client.rpc("support_list_access_journal", { p_project_id: pid }),
    u.client.rpc("support_active_access", { p_project_id: pid }),
    u.client.rpc("support_list_project_requests", { p_project_id: pid }),
  ]));
  record("Copropriétaire, chef de chantier et compte hors chantier : ni journal, ni bandeau, ni dossiers", hidden.every((r) => r.error?.message === "not_authorized"), hidden.map(err).join(","));
  const reqsOwner = (await owner.client.rpc("support_list_project_requests", { p_project_id: pid })).data ?? [];
  record("Dossiers : chaque partie ne lit que la description qu'elle a écrite", reqsOwner.find((r) => r.request_id === reqO.request_id)?.description === M.description && reqsOwner.find((r) => r.request_id === reqC.request_id)?.description === null);
  const direct = await Promise.all(["support_requests", "support_access_grants", "support_access_events"].map((t) => owner.client.from(t).select("id").eq("project_id", pid)));
  record("Tables support jamais lisibles directement par un membre", direct.every((r) => !!r.error || (r.data ?? []).length === 0), direct.map((r) => r.error?.message ?? r.data.length).join(" / "));

  // 10. Clôture : l'accès en cours tombe.
  await must(contractor.client.rpc("support_close_request", { p_request_id: reqC.request_id }), "clôture");
  const afterClose = await rd(admin, reqC.grant_id, "JOURNAL");
  const bannerAfter = await owner.client.rpc("support_active_access", { p_project_id: pid });
  const regrant = await contractor.client.rpc("support_grant_access", { p_request_id: reqC.request_id, p_modules: ["JOURNAL"], p_duration_minutes: 15 });
  record("Après clôture : lecture refusée, bandeau retiré, aucun nouvel accord sur le dossier clos", afterClose.data?.error === "request_closed" && (bannerAfter.data ?? []).length === 0 && regrant.error?.message === "request_closed", `${err(afterClose)} / ${err(regrant)}`);

  // 11. Insertion seule et transitions gardées.
  const guards = await Promise.all([
    service.from("support_requests").update({ description: "réécrite" }).eq("id", reqO.request_id),
    service.from("support_access_grants").update({ modules: ["JOURNAL", "INCIDENTS"] }).eq("id", gO.grant_id),
    service.from("support_access_events").delete().eq("project_id", pid),
    service.from("support_requests").delete().eq("id", reqO.request_id),
  ]);
  record("Dossier, accord et journal non réécrits ni supprimés, même par le serveur", guards.every((r) => r.error?.message?.includes("support_record_immutable")), guards.map((r) => r.error?.message).join(" / "));

  // 12. Journal de plateforme : prises en charge tracées, sans contenu.
  const pAudit = await admin.client.rpc("admin_list_platform_audit", { p_limit: 200 });
  const takes = (pAudit.data ?? []).filter((a) => a.action === "SUPPORT_REQUEST_TAKEN" && a.project_ref === pid.slice(0, 8).toUpperCase());
  record("Journal de plateforme : les deux prises en charge, sans contenu privé", takes.length === 2 && scan(pAudit.data).length === 0, `${takes.length} ; ${scan(pAudit.data).join(", ") || "rien"}`);
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
} finally {
  for (const a of designated) {
    const r = await revokeTestAdmin(service, a.id, "Fin du test M051 : désignation de test retirée.");
    const still = await a.client.rpc("is_platform_admin");
    record(`Fin de test : désignation de ${a.label} retirée et tracée`, r.ok && still.data === false, r.error ?? "");
  }
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
