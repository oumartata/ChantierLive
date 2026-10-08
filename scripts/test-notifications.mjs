// Test d'intégration LOCAL uniquement : M052, notifications internes et
// e-mail (B045 ; done_when « aucun e-mail non vérifié » ; D199 : N1 à N12
// dans le cadre de la boucle 36b ; D198 bandeau support pour tous).
// - destinataires par événement et par rôle, jamais l'auteur, une seule par
//   événement ; jamais de finance interne ni de document « Entreprise » vers
//   un propriétaire ; ex-membre et non-membre : rien ;
// - e-mail : file limitée aux adresses vérifiées, remise au capteur LOCAL
//   (Mailpit sur 127.0.0.1), texte sans nom de chantier ni contenu ;
// - rappels de licence J-30, J-7, jour même sans doublon ; préférences et
//   alertes obligatoires ; scanner de confidentialité (R15).
// Données jetables ; la désignation d'administrateur est retirée (D196).
//
// Usage : node --env-file=.env.local scripts/test-notifications.mjs

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { revokeTestAdmin } from "./lib/platform-admin.mjs";
import { makeScanner } from "./lib/private-scan.mjs";
import { deliverOutboxLocal, mailpitMessagesTo } from "./lib/email-outbox-local.mjs";

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
  const email = `m052-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, email, client, label };
}
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64"
);
const tag = String(Date.now()).slice(-7);
const M = {
  name: `CHANTIER-NOTIF-${tag}`,
  address: `ADRESSE-NOTIF-${tag}`,
  journal: `JOURNAL-NOTIF-${tag}`,
  incident: `INCIDENT-NOTIF-${tag}`,
  urgent: `URGENT-NOTIF-${tag}`,
  comment: `COMMENTAIRE-NOTIF-${tag}`,
  supplier: `FOURNISSEUR-NOTIF-${tag}`,
  expense: "717171717",
  budget: "626262626",
  docInternal: `DOC-ENTREPRISE-NOTIF-${tag}`,
  docShared: `DOC-PRINCIPAUX-NOTIF-${tag}`,
  docAll: `DOC-TOUS-NOTIF-${tag}`,
  paymentRef: `MP-NOTIF-${tag}`,
};
let designatedAdmin = null;

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
  return id;
}
async function uploadMedia(u, pid) {
  const op = randomUUID();
  await must(u.client.rpc("prepare_media_upload", { p_operation_uuid: op, p_project_id: pid, p_expected_checksum: sha(JPEG), p_expected_size_bytes: JPEG.length, p_expected_mime_type: "image/jpeg" }), "prepare_media_upload");
  const temp = `_private/${pid}/media_asset/${op}/source`;
  const signed = await must(service.storage.from("project-media").createSignedUploadUrl(temp), "createSignedUploadUrl");
  await must(u.client.storage.from("project-media").uploadToSignedUrl(signed.path, signed.token, JPEG, { contentType: "image/jpeg", upsert: true }), "uploadToSignedUrl");
  const claim = await must(u.client.rpc("claim_upload_attempt", { p_operation_uuid: op }), "claim media");
  await must(service.storage.from("project-media").upload(claim.candidate_key, JPEG, { contentType: "image/jpeg", upsert: false }), "write candidate");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(JPEG), p_actual_size_bytes: JPEG.length, p_actual_mime_type: "image/jpeg" }), "attest media");
  const row = one(await must(u.client.rpc("finalize_media_upload", { p_operation_uuid: op, p_origin: "IMPORTED", p_caption: null }), "finalize media"));
  await must(u.client.rpc("publish_media_asset", { p_media_asset_id: row.id }), "publish media");
}

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const exMember = await user("ex-chef");
  const outsider = await user("hors-chantier");
  const admin = await user("administrateur");
  await must(service.rpc("designate_platform_admin", { p_profile_id: admin.id, p_note: "test M052" }), "désignation");
  designatedAdmin = admin;
  const everyone = [contractor, owner, coOwner, sm, exMember, outsider];

  const pid = one(await must(contractor.client.rpc("create_draft_project", { p_name: M.name, p_country: "ML", p_role: "CONTRACTOR" }), "projet")).project_id;
  await must(service.from("projects").update({ address: M.address }).eq("id", pid), "adresse");
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null], [exMember, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  // Copropriétaire sans e-mail vérifié (N1 : aucun e-mail pour lui).
  await must(service.from("profile_identifiers").update({ verified_at_server: null }).eq("profile_id", coOwner.id), "copropriétaire non vérifié");

  const mine = async (u) => (await must(u.client.rpc("list_my_notifications", { p_limit: 200, p_offset: 0 }), `liste ${u.label}`)) ?? [];
  const kindsOf = async (u) => (await mine(u)).map((n) => n.kind);
  const raw = async (u, kind) => (await service.from("notifications").select("id, kind, project_id, title, group_count, mandatory").eq("recipient_profile_id", u.id).eq("kind", kind)).data ?? [];
  const who = async (kind) => {
    const out = [];
    for (const u of everyone) if ((await raw(u, kind)).some((n) => n.project_id === pid || n.project_id === null)) out.push(u.label);
    return out.join(",");
  };

  // 1. Journal publié : tous les membres sauf l'auteur.
  const today = new Date().toISOString().slice(0, 10);
  const log = await must(sm.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: today, p_works_done: M.journal, p_difficulties: null, p_team: null, p_next_actions: null }), "journal");
  await must(sm.client.rpc("publish_daily_log_draft", { p_log_id: log.id, p_expected_revision: log.revision }), "publication");
  record("Journal publié → entreprise, propriétaire, copropriétaire, ex-chef (encore membre) ; jamais l'auteur ni le hors-chantier", (await who("DAILY_LOG_PUBLISHED")) === "entreprise,proprietaire,coproprietaire,ex-chef", await who("DAILY_LOG_PUBLISHED"));
  const failedPublish = await sm.client.rpc("publish_daily_log_draft", { p_log_id: log.id, p_expected_revision: 999 });
  record("Action refusée : aucune notification créée (même transaction)", !!failedPublish.error && (await raw(owner, "DAILY_LOG_PUBLISHED")).length === 1, err(failedPublish));

  // 2. Retrait de l'ex-chef : un seul message sans nom de chantier ; plus rien du chantier.
  const { data: exMs } = await service.from("project_memberships").select("id").eq("project_id", pid).eq("profile_id", exMember.id).single();
  await must(contractor.client.rpc("remove_participant", { p_membership_id: exMs.id, p_reason: "Fin de mission" }), "retrait");
  const exList = await mine(exMember);
  record("Ex-membre : seulement « Votre accès à un chantier a été retiré », sans nom de chantier ; l'ancien journal n'est plus visible",
    exList.length === 1 && exList[0].title === "Votre accès à un chantier a été retiré" && exList[0].project_name === null && exList[0].link === "/tableau-de-bord", JSON.stringify(exList.map((n) => [n.title, n.project_name])));

  // 3. Incidents : moyen (tous sauf l'auteur), urgent (obligatoire), affectation, résolution unique.
  const inc = await must(owner.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "AUTRE", p_severity: "MOYENNE", p_occurred_at: new Date(Date.now() - 3600000).toISOString(), p_description: M.incident }), "incident");
  record("Incident moyen → entreprise, copropriétaire, chef ; ni l'auteur, ni l'ex-membre, ni le hors-chantier", (await who("INCIDENT_CREATED")) === "entreprise,coproprietaire,chef", await who("INCIDENT_CREATED"));
  const urgent = await must(sm.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "AUTRE", p_severity: "URGENTE", p_occurred_at: new Date(Date.now() - 600000).toISOString(), p_description: M.urgent }), "urgent");
  const urgentRows = await raw(owner, "INCIDENT_URGENT");
  record("Incident urgent → tous les membres qui le voient sauf l'auteur, alerte obligatoire", (await who("INCIDENT_URGENT")) === "entreprise,proprietaire,coproprietaire" && urgentRows[0]?.mandatory === true, await who("INCIDENT_URGENT"));
  const assigned = await must(contractor.client.rpc("assign_incident", { p_incident_id: urgent.id, p_expected_revision: urgent.revision, p_assignee_profile_id: sm.id, p_due_date: null }), "affectation");
  const assigned2 = await must(contractor.client.rpc("assign_incident", { p_incident_id: inc.id, p_expected_revision: inc.revision, p_assignee_profile_id: sm.id, p_due_date: null }), "affectation 2");
  record("Affectation (AC104) → le responsable seulement", (await who("INCIDENT_ASSIGNED")) === "chef" && (await raw(sm, "INCIDENT_ASSIGNED")).length === 2, await who("INCIDENT_ASSIGNED"));
  const move = (u, id, rev, to, resolution = null) => u.client.rpc("transition_incident", { p_incident_id: id, p_expected_revision: rev, p_to_status: to, p_note: null, p_resolution: resolution });
  const started = one(await must(move(sm, urgent.id, assigned.revision, "EN_COURS"), "en cours"));
  const resolved = await move(sm, urgent.id, started.revision, "RESOLU", "Réparé");
  record("Résolution par le chef (déclarant et responsable) : il n'est pas notifié de sa propre action", !resolved.error && (await raw(sm, "INCIDENT_RESOLU")).length === 0, err(resolved));
  const started2 = one(await must(move(sm, inc.id, assigned2.revision, "EN_COURS"), "en cours 2"));
  const closed = await move(contractor, inc.id, started2.revision, "RESOLU", "Fait");
  record("Résolution d'un incident : déclarant (propriétaire) et responsable (chef), une seule notification chacun", !closed.error && (await raw(owner, "INCIDENT_RESOLU")).length === 1 && (await raw(sm, "INCIDENT_RESOLU")).length === 1, err(closed));

  // 4. Commentaire : tous ceux qui voient l'élément, sauf l'auteur.
  await must(owner.client.rpc("add_comment", { p_target_type: "DAILY_LOG", p_target_id: log.id, p_body: M.comment }), "commentaire");
  record("Commentaire → entreprise, copropriétaire, chef ; jamais l'auteur", (await who("COMMENT_ADDED")) === "entreprise,coproprietaire,chef", await who("COMMENT_ADDED"));

  // 5. Documents selon la visibilité.
  await deposit(contractor, pid, M.docInternal, "ENTREPRISE");
  const afterInternal = (await raw(owner, "DOCUMENT_PUBLISHED")).length + (await raw(coOwner, "DOCUMENT_PUBLISHED")).length + (await raw(sm, "DOCUMENT_PUBLISHED")).length;
  record("Document « Entreprise » : aucune notification (ni propriétaire, ni copropriétaire, ni chef)", afterInternal === 0, String(afterInternal));
  await deposit(contractor, pid, M.docShared, "PRINCIPAUX");
  record("Document « principaux » → propriétaire et copropriétaire, jamais le chef", (await who("DOCUMENT_PUBLISHED")) === "proprietaire,coproprietaire", await who("DOCUMENT_PUBLISHED"));
  await deposit(owner, pid, M.docAll, "TOUS");
  record("Document « tous » → entreprise, copropriétaire, chef (le propriétaire, auteur, garde sa seule notification précédente)",
    (await raw(contractor, "DOCUMENT_PUBLISHED")).length === 1 && (await raw(sm, "DOCUMENT_PUBLISHED")).length === 1 && (await raw(coOwner, "DOCUMENT_PUBLISHED")).length === 2 && (await raw(owner, "DOCUMENT_PUBLISHED")).length === 1);

  // 6. Finances internes : jamais vers un propriétaire.
  const exp = await must(sm.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: null, p_expected_revision: null, p_amount_fcfa: M.expense, p_expense_date: today, p_category: "MATERIAUX", p_supplier: M.supplier, p_note: null, p_phase_id: null, p_no_receipt_reason: null }), "dépense");
  await must(sm.client.rpc("submit_expense", { p_expense_id: exp.id, p_expected_revision: exp.revision }), "soumission");
  const { data: expRow } = await service.from("expenses").select("revision").eq("id", exp.id).single();
  await must(contractor.client.rpc("decide_expense", { p_expense_id: exp.id, p_expected_revision: expRow.revision, p_decision: "APPROUVEE", p_reason: null }), "décision");
  await must(contractor.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: M.budget, p_reason: null, p_expected_revision: 0 }), "budget");
  record("Dépense soumise → entreprise seule (décision attendue, obligatoire) ; décidée → le chef auteur", (await who("EXPENSE_TO_DECIDE")) === "entreprise" && (await who("EXPENSE_APPROUVEE")) === "chef" && (await raw(contractor, "EXPENSE_TO_DECIDE"))[0]?.mandatory === true);
  const ownerKinds = [...(await kindsOf(owner)), ...(await kindsOf(coOwner))];
  record("Propriétaire et copropriétaire : aucune notification de dépense, de budget, de reçu", !ownerKinds.some((k) => /EXPENSE|BUDGET|RECEIPT/.test(k)), [...new Set(ownerKinds)].join(","));

  // 7. Photos regroupées.
  await uploadMedia(sm, pid);
  await uploadMedia(sm, pid);
  await uploadMedia(sm, pid);
  const ph = await raw(owner, "PHOTOS_PUBLISHED");
  record("Photos regroupées : une seule notification « 3 nouvelles photos » par destinataire, jamais l'auteur", ph.length === 1 && ph[0].group_count === 3 && ph[0].title === "3 nouvelles photos" && (await raw(sm, "PHOTOS_PUBLISHED")).length === 0 && (await who("PHOTOS_PUBLISHED")) === "entreprise,proprietaire,coproprietaire", JSON.stringify(ph));

  // 8. Licence : déclaration → administrateur seulement ; activation → déclarant ; rappels J-30, J-7, jour même.
  const lpBytes = Buffer.from(`%PDF-1.4 preuve M052 ${randomUUID()}`);
  const lpOp = randomUUID();
  const lpPrep = await must(owner.client.rpc("prepare_license_payment_upload", { p_operation_uuid: lpOp, p_project_id: pid, p_amount_fcfa: "100000", p_operator: "ORANGE_MONEY", p_payment_reference: M.paymentRef, p_paid_on: today, p_payer_name: null, p_disclaimer_ack: true, p_expected_checksum: sha(lpBytes), p_expected_size_bytes: lpBytes.length, p_expected_mime_type: "application/pdf" }), "licence");
  const lpClaim = await must(owner.client.rpc("claim_upload_attempt", { p_operation_uuid: lpOp, p_expected_attempt_id: lpPrep.attempt_id }), "licence claim");
  await must(service.storage.from("license-proofs").upload(lpClaim.candidate_key, lpBytes, { contentType: "application/pdf", upsert: false }), "licence write");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: lpOp, p_attempt_id: lpClaim.attempt_id, p_actual_checksum: sha(lpBytes), p_actual_size_bytes: lpBytes.length, p_actual_mime_type: "application/pdf" }), "licence attest");
  const payment = await must(owner.client.rpc("finalize_license_payment_upload", { p_operation_uuid: lpOp }), "licence finalize");
  const adminList = await mine(admin);
  const toReview = adminList.filter((n) => n.kind === "LICENSE_PAYMENT_TO_REVIEW");
  record("Déclaration de licence → administrateur seulement, sans nom de chantier ; aucun membre", toReview.length >= 1 && toReview.every((n) => n.project_name === null && n.title === "Déclaration de licence à vérifier") && (await who("LICENSE_PAYMENT_TO_REVIEW")) === "", `${toReview.length}`);
  record("Administrateur : aucune autre sorte de notification (cadre 36b)", adminList.every((n) => n.kind === "LICENSE_PAYMENT_TO_REVIEW"), [...new Set(adminList.map((n) => n.kind))].join(","));
  await must(admin.client.rpc("activate_license_payment", { p_payment_id: payment.id, p_verification_note: null }), "activation");
  record("Licence activée → le déclarant seulement", (await who("LICENSE_ACTIVATED")) === "proprietaire", await who("LICENSE_ACTIVATED"));
  const setEnds = async (days) => must(service.from("project_licenses").update({ ends_on: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) }).eq("project_id", pid), "échéance");
  const reminders = async (u) => (await service.from("notifications").select("kind").eq("recipient_profile_id", u.id).eq("project_id", pid).like("kind", "LICENSE_REMINDER_%")).data.map((n) => n.kind).sort().join(",");
  await setEnds(40);
  await owner.client.rpc("count_my_unread_notifications");
  const r40 = await reminders(owner);
  await setEnds(20);
  for (let i = 0; i < 3; i++) await owner.client.rpc("count_my_unread_notifications");
  await mine(owner);
  const r20 = await reminders(owner);
  await setEnds(5);
  await mine(owner);
  await mine(owner);
  const r5 = await reminders(owner);
  await setEnds(0);
  await mine(owner);
  await owner.client.rpc("count_my_unread_notifications");
  const r0 = await reminders(owner);
  record("Rappels de licence : rien à 40 jours ; J-30, J-7, jour même, un seul chacun malgré des ouvertures répétées", r40 === "" && r20 === "LICENSE_REMINDER_J30" && r5 === "LICENSE_REMINDER_J30,LICENSE_REMINDER_J7" && r0 === "LICENSE_REMINDER_J0,LICENSE_REMINDER_J30,LICENSE_REMINDER_J7", `${r40 || "∅"} | ${r20} | ${r5} | ${r0}`);
  await mine(sm);
  record("Rappel calculé à l'ouverture pour chaque membre (chef : jour même seulement, il n'a pas ouvert avant)", (await reminders(sm)) === "LICENSE_REMINDER_J0", await reminders(sm));
  record("Rappels obligatoires", (await service.from("notifications").select("mandatory").eq("project_id", pid).like("kind", "LICENSE_REMINDER_%")).data.every((n) => n.mandatory === true));

  // 9. Préférences par catégorie ; alertes obligatoires maintenues.
  const badPref = await coOwner.client.rpc("set_my_notification_preference", { p_category: "OBLIGATOIRE", p_in_app: false, p_email: false });
  await must(coOwner.client.rpc("set_my_notification_preference", { p_category: "CHANTIER", p_in_app: false, p_email: false }), "préférence copropriétaire");
  await must(owner.client.rpc("set_my_notification_preference", { p_category: "CHANTIER", p_in_app: true, p_email: false }), "préférence propriétaire");
  const log2 = await must(sm.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), p_works_done: `${M.journal}-2`, p_difficulties: null, p_team: null, p_next_actions: null }), "journal 2");
  await must(sm.client.rpc("publish_daily_log_draft", { p_log_id: log2.id, p_expected_revision: log2.revision }), "publication 2");
  const urgent2 = await must(sm.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "AUTRE", p_severity: "URGENTE", p_occurred_at: new Date(Date.now() - 300000).toISOString(), p_description: `${M.urgent}-2` }), "urgent 2");
  void urgent2;
  const ownerLogs = await raw(owner, "DAILY_LOG_PUBLISHED");
  const ownerOutboxLog2 = (await service.from("email_outbox").select("id").in("notification_id", ownerLogs.map((n) => n.id))).data.length;
  const ownerUrgent = await raw(owner, "INCIDENT_URGENT");
  const ownerOutboxUrgent = (await service.from("email_outbox").select("id").in("notification_id", ownerUrgent.map((n) => n.id))).data.length;
  record("Catégorie « obligatoire » non réglable", badPref.error?.message === "category_invalid", err(badPref));
  record("Copropriétaire : chantier désactivé → pas de nouveau journal ; incident urgent reçu quand même", (await raw(coOwner, "DAILY_LOG_PUBLISHED")).length === 1 && (await raw(coOwner, "INCIDENT_URGENT")).length === 2);
  record("Propriétaire : e-mail du chantier désactivé → journal 2 sans e-mail ; urgent avec e-mail malgré la préférence", ownerLogs.length === 2 && ownerOutboxLog2 === 1 && ownerUrgent.length === 2 && ownerOutboxUrgent === 2, `${ownerOutboxLog2} / ${ownerOutboxUrgent}`);

  // 10. Bandeau D198 et notifications support.
  const req = one(await must(owner.client.rpc("support_create_request", { p_project_id: pid, p_category: "TECHNIQUE", p_description: "Les photos ne s'affichent pas depuis hier.", p_grant_modules: ["JOURNAL", "PHOTOS"], p_grant_duration_minutes: 15 }), "support"));
  const banners = {};
  for (const u of [owner, contractor, coOwner, sm]) banners[u.label] = await u.client.rpc("support_active_access", { p_project_id: pid });
  const reduced = [coOwner, sm].every((u) => banners[u.label].data?.length === 1 && banners[u.label].data[0].grant_id === null && banners[u.label].data[0].modules === null && banners[u.label].data[0].granted_by_party === null && !!banners[u.label].data[0].expires_at_server);
  record("D198 : copropriétaire et chef voient le bandeau, réduit à l'heure de fin (ni module, ni dossier, ni partie)", reduced, JSON.stringify(banners.chef?.data));
  record("D198 : parties principales gardent la réponse complète", [owner, contractor].every((u) => banners[u.label].data?.[0]?.grant_id === req.grant_id && banners[u.label].data[0].modules.length === 2));
  const journals = await Promise.all([coOwner, sm, outsider, exMember].map((u) => u.client.rpc("support_list_access_journal", { p_project_id: pid })));
  const outBanner = await Promise.all([outsider, exMember].map((u) => u.client.rpc("support_active_access", { p_project_id: pid })));
  record("Journal d'accès toujours réservé aux parties principales ; ex-membre et hors-chantier : ni journal ni bandeau", journals.every((r) => r.error?.message === "not_authorized") && outBanner.every((r) => r.error?.message === "not_authorized"), journals.map(err).join(","));
  record("Accès support ouvert → l'autre partie principale seulement (entreprise)", (await who("SUPPORT_ACCESS_OPENED")) === "entreprise", await who("SUPPORT_ACCESS_OPENED"));

  // 11. Ex-membre et non-membre : rien.
  const exAfter = await mine(exMember);
  const outList = await mine(outsider);
  record("Ex-membre : toujours un seul message après tous les événements ; hors-chantier : aucune notification", exAfter.length === 1 && outList.length === 0, `${exAfter.length} / ${outList.length}`);

  // 12. Scanner de confidentialité (R15).
  const forbidden = [M.address, M.journal, M.incident, M.urgent, M.comment, M.supplier, M.expense, M.budget, M.docInternal, M.docShared, M.docAll, M.paymentRef,
    contractor.email, owner.email, coOwner.email, sm.email, exMember.email, contractor.id, owner.id, coOwner.id, sm.id, exMember.id, admin.id, "100000"];
  const scan = makeScanner(forbidden);
  const legit = await Promise.all([
    contractor.client.rpc("list_project_expenses", { p_project_id: pid }),
    owner.client.rpc("list_published_daily_logs", { p_project_id: pid }),
    contractor.client.rpc("list_project_documents", { p_project_id: pid }),
  ]);
  const legitHits = new Set(legit.flatMap((r) => scan(r.data)));
  record("Contrôle positif (R15) : le scanner trouve dépense, journal et titres de documents là où ils sont présents", [M.supplier, M.journal, M.docInternal, M.docShared].every((m) => legitHits.has(m)), [...legitHits].join(","));
  const forged = [{ title: `Dépense ${M.supplier} de ${M.expense} FCFA`, project_name: M.name, by: sm.email }];
  record("Contrôle positif (R15) : une notification altérée (fournisseur, montant, e-mail) est détectée", ["FOURNISSEUR", M.expense, sm.email].every((m) => scan(forged).some((h) => h.includes(m))), scan(forged).join(","));
  const hits = [];
  for (const u of [contractor, owner, coOwner, sm, exMember, outsider, admin]) for (const h of scan(await mine(u))) hits.push(`${u.label}:${h}`);
  const rawAll = (await service.from("notifications").select("title, link, kind, dedup_key").in("recipient_profile_id", [contractor.id, owner.id, coOwner.id, sm.id, exMember.id, admin.id])).data;
  for (const h of scan(rawAll)) hits.push(`table:${h}`);
  record("Toutes les notifications (listes et table) : ni contenu, ni titre, ni montant, ni identité, ni référence de paiement", hits.length === 0, hits.join(", ") || "rien");
  const nameInTitles = rawAll.some((n) => n.title.includes(M.name));
  record("Le nom du chantier n'est jamais stocké dans la notification (joint à l'affichage pour les membres seulement)", !nameInTitles);

  // 13. E-mail : adresses vérifiées seulement ; remise au capteur local ; texte minimal.
  const { data: outbox } = await service.from("email_outbox").select("id, notification_id, recipient_profile_id, to_address, subject, body").in("recipient_profile_id", [contractor.id, owner.id, coOwner.id, sm.id, exMember.id, outsider.id, admin.id]);
  const { data: verified } = await service.from("profile_identifiers").select("profile_id, value_normalized").eq("kind", "EMAIL").not("verified_at_server", "is", null).is("archived_at", null).in("profile_id", [contractor.id, owner.id, coOwner.id, sm.id, exMember.id, outsider.id, admin.id]);
  const verifiedSet = new Set(verified.map((v) => `${v.profile_id}|${v.value_normalized}`));
  record("File d'e-mails : aucune ligne pour le copropriétaire non vérifié ; chaque adresse est l'e-mail vérifié du destinataire", outbox.length > 0 && !outbox.some((o) => o.recipient_profile_id === coOwner.id) && outbox.every((o) => verifiedSet.has(`${o.recipient_profile_id}|${o.to_address}`)), `${outbox.length} e-mails`);
  record("File d'e-mails : sujet « Nouvelle notification », corps avec le seul lien /notifications, sans contenu", outbox.every((o) => o.subject === "Nouvelle notification" && /\/notifications$/.test(o.body) && scan([o.subject, o.body]).length === 0 && !o.body.includes(M.name)));
  const delivered = await deliverOutboxLocal(service, { notificationIds: [...new Set(outbox.map((o) => o.notification_id))] });
  const inbox = await mailpitMessagesTo(owner.email);
  const coInbox = await mailpitMessagesTo(coOwner.email);
  const ownerOutboxCount = outbox.filter((o) => o.recipient_profile_id === owner.id).length;
  record("Remise au capteur local : tous les e-mails remis ; la boîte du propriétaire les contient tous ; celle du copropriétaire est vide",
    delivered === outbox.length && inbox.length === ownerOutboxCount && coInbox.length === 0, `${delivered} remis ; propriétaire ${inbox.length}/${ownerOutboxCount} ; copropriétaire ${coInbox.length}`);
  const mailHits = inbox.flatMap((m) => scan([m.Subject, m.Text, m.HTML ?? ""]));
  record("E-mails reçus : « Nouvelle notification », ni nom de chantier, ni contenu, ni montant", inbox.every((m) => m.Subject === "Nouvelle notification" && !m.Text.includes(M.name) && m.Text.includes("/notifications")) && mailHits.length === 0, mailHits.join(",") || "rien");
  const { count: stillPending } = await service.from("email_outbox").select("id", { count: "exact", head: true }).in("id", outbox.map((o) => o.id)).eq("status", "PENDING");
  record("File marquée remise localement (DELIVERED_LOCAL)", stillPending === 0, String(stillPending));

  // 14. Lecture par le destinataire seulement.
  const ownerList = await mine(owner);
  const notMine = await contractor.client.rpc("mark_notification_read", { p_notification_id: ownerList[0].id });
  const readOne = await owner.client.rpc("mark_notification_read", { p_notification_id: ownerList[0].id });
  const exRead = await exMember.client.rpc("mark_notification_read", { p_notification_id: (await raw(exMember, "DAILY_LOG_PUBLISHED"))[0]?.id });
  const all = await owner.client.rpc("mark_all_my_notifications_read");
  const unread = await owner.client.rpc("count_my_unread_notifications");
  record("Marquer lu : refusé pour la notification d'un autre et pour une notification devenue invisible (ex-membre) ; tout marquer lu → 0 non lue",
    notMine.error?.message === "not_authorized" && !readOne.error && exRead.error?.message === "not_authorized" && !all.error && unread.data === 0, `${err(notMine)} / ${err(exRead)} / ${unread.data}`);
  const direct = await Promise.all(["notifications", "email_outbox", "notification_preferences"].map((t) => owner.client.from(t).select("*").limit(1)));
  record("Tables jamais lisibles directement", direct.every((r) => !!r.error), direct.map(err).join(" / "));
  const guards = await Promise.all([
    service.from("notifications").update({ title: "réécrit" }).eq("id", ownerList[0].id),
    service.from("notifications").delete().eq("id", ownerList[0].id),
    service.from("email_outbox").update({ to_address: "autre@example.test" }).eq("id", outbox[0].id),
  ]);
  record("Notification et file d'e-mails non réécrites ni supprimées", guards.every((r) => /immutable/.test(r.error?.message ?? "")), guards.map(err).join(" / "));
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
} finally {
  if (designatedAdmin) {
    const r = await revokeTestAdmin(service, designatedAdmin.id, "Fin du test M052 : désignation de test retirée.");
    record("Fin de test : désignation d'administrateur retirée et tracée", r.ok, r.error ?? "");
  }
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
