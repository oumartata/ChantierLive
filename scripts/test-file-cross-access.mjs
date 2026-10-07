// Test d'intégration LOCAL uniquement : B029, accès croisé aux fichiers.
// Done_when : « fichier d'un autre chantier refusé ». Données jetables
// créées par ce script (deux chantiers, deux organisations).
//
// Deux portes d'accès existent et sont testées séparément :
// 1. Stockage direct (API Storage avec le jeton de l'utilisateur) : aucune
//    politique sur storage.objects, donc tout doit être refusé pour tout le
//    monde, membres compris — lister, lire, URL signée, envoyer, remplacer,
//    supprimer, sur les 4 compartiments.
// 2. Chemin applicatif : le serveur n'émet une URL signée (service_role)
//    qu'après une fonction en base qui statue sur le droit ; ces fonctions
//    sont appelées ici avec le jeton de chaque acteur.
//
// Usage : node --env-file=.env.local scripts/test-file-cross-access.mjs

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
const observations = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
function observe(text) {
  observations.push(text);
  console.log(`CONSTAT ${text}`);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function must(res, what) {
  const r = await res;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}
async function user(label) {
  const email = `b029-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, email, client, label };
}

// JPEG réel 1x1 (même fixture que scripts/test-media-upload.mjs).
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64"
);
const PDF = (label) => Buffer.from(`%PDF-1.4 B029 ${label} ${randomUUID()}`);

// Flux serveur reproduits (même discipline que les tests B026/B063/B033/B061).
async function uploadMedia(client, projectId, publish) {
  const op = randomUUID();
  await must(client.rpc("prepare_media_upload", { p_operation_uuid: op, p_project_id: projectId, p_expected_checksum: sha(JPEG), p_expected_size_bytes: JPEG.length, p_expected_mime_type: "image/jpeg" }), "prepare_media_upload");
  const temp = `_private/${projectId}/media_asset/${op}/source`;
  const signed = await must(service.storage.from("project-media").createSignedUploadUrl(temp), "createSignedUploadUrl");
  await must(client.storage.from("project-media").uploadToSignedUrl(signed.path, signed.token, JPEG, { contentType: "image/jpeg", upsert: true }), "uploadToSignedUrl");
  const claim = await must(client.rpc("claim_upload_attempt", { p_operation_uuid: op }), "claim media");
  await must(service.storage.from("project-media").upload(claim.candidate_key, JPEG, { contentType: "image/jpeg", upsert: false }), "write candidate");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(JPEG), p_actual_size_bytes: JPEG.length, p_actual_mime_type: "image/jpeg" }), "attest media");
  const media = await must(client.rpc("finalize_media_upload", { p_operation_uuid: op, p_origin: "IMPORTED", p_caption: null }), "finalize media");
  const row = Array.isArray(media) ? media[0] : media;
  if (publish) await must(client.rpc("publish_media_asset", { p_media_asset_id: row.id }), "publish media");
  return { id: row.id, key: claim.candidate_key };
}
async function depositPlan(client, projectId, label) {
  const bytes = PDF(label);
  const op = randomUUID();
  const prep = await must(client.rpc("prepare_project_plan_upload", { p_operation_uuid: op, p_project_id: projectId, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "prepare plan");
  const claim = await must(client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "claim plan");
  await must(service.storage.from("project-plans").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "write plan");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "attest plan");
  const version = await must(client.rpc("finalize_project_plan_upload", { p_operation_uuid: op }), "finalize plan");
  return { id: version.id, key: claim.candidate_key };
}
async function attachReceipt(client, advanceId) {
  const bytes = PDF("recu");
  const op = randomUUID();
  const prep = await must(client.rpc("prepare_advance_receipt_upload", { p_operation_uuid: op, p_advance_id: advanceId, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "prepare receipt");
  const claim = await must(client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "claim receipt");
  await must(service.storage.from("advance-receipts").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "write receipt");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "attest receipt");
  await must(client.rpc("finalize_advance_receipt_upload", { p_operation_uuid: op }), "finalize receipt");
  return { key: claim.candidate_key };
}
async function depositCatalog(client, organizationId, itemId) {
  const bytes = PDF("catalogue");
  const op = randomUUID();
  const prep = await must(client.rpc("prepare_catalog_item_upload", { p_operation_uuid: op, p_organization_id: organizationId, p_catalog_item_id: itemId, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "prepare catalog");
  const claim = await must(client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "claim catalog");
  await must(service.storage.from("organization-catalog").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "write catalog");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "attest catalog");
  const version = await must(client.rpc("finalize_catalog_item_upload", { p_operation_uuid: op }), "finalize catalog");
  return { id: version.id, key: claim.candidate_key };
}
// B028 (M039) : document déposé puis publié, même discipline.
async function depositDocument(client, projectId, visibility) {
  const bytes = PDF(`document-${visibility}`);
  const op = randomUUID();
  const prep = await must(client.rpc("prepare_document_upload", { p_operation_uuid: op, p_project_id: projectId, p_document_id: null, p_document_type: "CONTRAT", p_title: `B029 — document ${visibility}`, p_description: null, p_visibility: visibility, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "prepare document");
  const claim = await must(client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.attempt_id }), "claim document");
  await must(service.storage.from("project-documents").upload(claim.candidate_key, bytes, { contentType: "application/pdf", upsert: false }), "write document");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: op, p_attempt_id: claim.attempt_id, p_actual_checksum: sha(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: "application/pdf" }), "attest document");
  const version = await must(client.rpc("finalize_document_upload", { p_operation_uuid: op }), "finalize document");
  const rev = (await service.from("documents").select("revision").eq("id", version.document_id).single()).data.revision;
  await must(client.rpc("publish_document", { p_document_id: version.document_id, p_expected_revision: rev }), "publish document");
  return { id: version.document_id, versionId: version.id, key: claim.candidate_key };
}
const objectExists = async (bucket, key) => {
  const { data, error } = await service.storage.from(bucket).download(key);
  return !error && !!data;
};
const storedHash = async (bucket, key) => {
  const { data, error } = await service.storage.from(bucket).download(key);
  return error || !data ? null : sha(Buffer.from(await data.arrayBuffer()));
};
const prefixOf = (key) => key.split("/").slice(0, -1).join("/");
const errCode = (r) => r.error?.message ?? r.error?.code ?? "aucune erreur";

try {
  // ------------------------------------------------------------------------
  // Chantier A (organisation A) : devis accepté, acompte avec justificatif,
  // plan publié (déposé par le propriétaire), plan candidat privé de
  // l'entreprise, médias publié et brouillons, modèle de catalogue privé.
  // ------------------------------------------------------------------------
  const contractorA = await user("entreprise-a");
  const ownerA = await user("proprietaire-a");
  const smA = await user("chef-a");
  const exMember = await user("ex-membre-a");
  const engineer = await user("ingenieur-a");
  const contractorB = await user("entreprise-b");
  const outsider = await user("hors-chantier");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };

  const projA = await must(contractorA.client.rpc("create_draft_project", { p_name: "B029 — chantier A", p_country: "ML", p_role: "CONTRACTOR" }), "projet A");
  const { project_id: pidA, organization_id: orgA } = Array.isArray(projA) ? projA[0] : projA;
  const projB = await must(contractorB.client.rpc("create_draft_project", { p_name: "B029 — chantier B", p_country: "ML", p_role: "CONTRACTOR" }), "projet B");
  const { project_id: pidB, organization_id: orgB } = Array.isArray(projB) ? projB[0] : projB;
  for (const [u, role, op] of [[ownerA, "OWNER", "PRIMARY"], [smA, "SITE_MANAGER", null], [exMember, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pidA, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  const revA = async () => (await service.from("projects").select("revision").eq("id", pidA).single()).data.revision;
  const designation = await must(contractorA.client.rpc("designate_plan_engineer", { p_organization_id: orgA, p_identifier_kind: "EMAIL", p_identifier_value: engineer.email }), "designate");
  const published = await depositPlan(ownerA.client, pidA, "plan-publie");
  await must(ownerA.client.rpc("set_retained_project_plan_version", { p_project_id: pidA, p_version_id: published.id, p_expected_revision: await revA() }), "retain");
  const val = await must(contractorA.client.rpc("submit_plan_version_for_validation", { p_version_id: published.id, p_designation_id: designation.id }), "submit");
  await must(engineer.client.rpc("decide_plan_validation", { p_validation_id: val.id, p_decision: "VALIDATED", p_note: null }), "validate");
  await must(contractorA.client.rpc("publish_project_plan_version", { p_project_id: pidA, p_version_id: published.id, p_expected_revision: await revA() }), "publish plan");
  const quote = await must(contractorA.client.rpc("create_quote_estimate", { p_project_id: pidA, p_lines: [{ label: "Gros œuvre", unit: "forfait", quantity: "1", unit_price_fcfa: "10000000" }], p_expected_revision: 0 }), "quote");
  const qRev = async () => (await service.from("quotes").select("revision").eq("project_id", pidA).single()).data.revision;
  await must(contractorA.client.rpc("propose_quote_version", { p_version_id: quote.id, p_expected_revision: await qRev() }), "propose");
  await must(ownerA.client.rpc("decide_quote_version", { p_version_id: quote.id, p_decision: "ACCEPTED", p_reason: null, p_expected_revision: await qRev() }), "accept");
  const ledgerRev = async () => (await service.from("advance_ledgers").select("revision").eq("project_id", pidA).maybeSingle()).data?.revision ?? 0;
  await must(contractorA.client.rpc("set_advance_requirement", { p_operation_uuid: randomUUID(), p_project_id: pidA, p_amount_fcfa: "1000000", p_expected_revision: await ledgerRev() }), "requirement");
  const declared = await must(ownerA.client.rpc("declare_advance_payment", {
    p_operation_uuid: randomUUID(), p_project_id: pidA, p_amount_fcfa: "500000", p_payment_date: new Date().toISOString().slice(0, 10),
    p_mode: "ORANGE_MONEY", p_reference: null, p_disclaimer_ack: true, p_expected_revision: await ledgerRev(),
  }), "declare");
  const advanceId = (Array.isArray(declared) ? declared[0] : declared).advance_id;
  const receipt = await attachReceipt(ownerA.client, advanceId);
  const privatePlan = await depositPlan(contractorA.client, pidA, "plan-candidat-prive");
  const mediaPub = await uploadMedia(contractorA.client, pidA, true);
  const mediaDraftC = await uploadMedia(contractorA.client, pidA, false);
  const mediaDraftSM = await uploadMedia(smA.client, pidA, false);
  const item = await must(contractorA.client.rpc("create_catalog_item", { p_organization_id: orgA, p_label: "B029 — modèle privé" }), "catalog item");
  const catalog = await depositCatalog(contractorA.client, orgA, item.id);
  const docPrinc = await depositDocument(contractorA.client, pidA, "PRINCIPAUX");
  const docEnt = await depositDocument(contractorA.client, pidA, "ENTREPRISE");
  // Ex-membre : accès retiré avant les essais.
  await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pidA).eq("profile_id", exMember.id), "révocation ex-membre");
  console.log(`Chantier A ${pidA} (organisation ${orgA}) ; chantier B ${pidB} (organisation ${orgB}).`);

  const files = [
    { bucket: "project-media", key: mediaPub.key, what: "photo publiée" },
    { bucket: "project-plans", key: published.key, what: "plan publié" },
    { bucket: "advance-receipts", key: receipt.key, what: "justificatif d'acompte" },
    { bucket: "organization-catalog", key: catalog.key, what: "modèle de catalogue" },
    { bucket: "project-documents", key: docPrinc.key, what: "document PRINCIPAUX" },
    { bucket: "project-documents", key: docEnt.key, what: "document ENTREPRISE" },
  ];
  for (const f of files) {
    if (!(await objectExists(f.bucket, f.key))) throw new Error(`fixture absente : ${f.bucket}/${f.key}`);
  }

  // ------------------------------------------------------------------------
  // 1. Stockage direct : refusé pour TOUS, membres compris.
  // ------------------------------------------------------------------------
  const directActors = [contractorA, ownerA, contractorB, exMember, outsider, anon];
  for (const f of files) {
    for (const a of directActors) {
      const st = a.client.storage.from(f.bucket);
      const tag = `${f.bucket} (${f.what}) — ${a.label}`;
      const ls = await st.list(prefixOf(f.key));
      record(`Direct ${tag} : lister ne révèle rien`, !!ls.error || (Array.isArray(ls.data) && ls.data.length === 0), ls.error?.message ?? `${ls.data?.length} élément(s)`);
      const dl = await st.download(f.key);
      record(`Direct ${tag} : lire refusé`, !!dl.error && !dl.data, errCode(dl));
      const su = await st.createSignedUrl(f.key, 60);
      record(`Direct ${tag} : URL signée refusée`, !!su.error && !su.data?.signedUrl, errCode(su));
      // Contenu ADMIS par le compartiment (type et taille) : un refus ne peut
      // venir que des droits, jamais d'un contrôle de type MIME.
      const isMedia = f.bucket === "project-media";
      const payload = () => (isMedia ? Buffer.concat([JPEG, Buffer.from(randomUUID())]) : PDF("intrus"));
      const mime = isMedia ? "image/jpeg" : "application/pdf";
      const forged = `${prefixOf(f.key)}/force-${randomUUID()}`;
      const up = await st.upload(forged, payload(), { contentType: mime, upsert: false });
      record(`Direct ${tag} : envoyer (chemin forgé dans le dossier du fichier) refusé`, !!up.error && !/mime|size/i.test(errCode(up)) && !(await objectExists(f.bucket, forged)), errCode(up));
      const before = await storedHash(f.bucket, f.key);
      const rep = await st.update(f.key, payload(), { contentType: mime, upsert: true });
      const ups = await st.upload(f.key, payload(), { contentType: mime, upsert: true });
      const unchanged = before !== null && before === (await storedHash(f.bucket, f.key));
      record(`Direct ${tag} : remplacer refusé (empreinte inchangée)`, !!rep.error && !!ups.error && !/mime|size/i.test(`${errCode(rep)} ${errCode(ups)}`) && unchanged, `${errCode(rep)} / ${errCode(ups)}`);
      const rm = await st.remove([f.key]);
      record(`Direct ${tag} : supprimer sans effet (fichier toujours présent)`, (!!rm.error || (rm.data ?? []).length === 0) && (await objectExists(f.bucket, f.key)), rm.error?.message ?? `${rm.data?.length} supprimé(s)`);
    }
  }

  // ------------------------------------------------------------------------
  // 2. Chemin applicatif : fonctions qui décident de l'émission d'une URL.
  // ------------------------------------------------------------------------
  const strangers = [contractorB, exMember, outsider];
  // Photos (list_project_media → storage_key → URL signée par le serveur).
  const mediaIds = async (u) => {
    const r = await u.client.rpc("list_project_media", { p_project_id: pidA });
    return { error: r.error, ids: (r.data ?? []).map((m) => m.id) };
  };
  const cm = await mediaIds(contractorA);
  record("Photos A — entreprise : voit la publiée et SON brouillon, pas celui du chef", !cm.error && cm.ids.includes(mediaPub.id) && cm.ids.includes(mediaDraftC.id) && !cm.ids.includes(mediaDraftSM.id), cm.error?.message);
  const sm = await mediaIds(smA);
  record("Photos A — chef : brouillon de l'entreprise (même chantier) invisible (D100)", !sm.error && sm.ids.includes(mediaDraftSM.id) && !sm.ids.includes(mediaDraftC.id), sm.error?.message);
  const ow = await mediaIds(ownerA);
  record("Photos A — propriétaire : la publiée seulement, aucun brouillon", !ow.error && ow.ids.includes(mediaPub.id) && !ow.ids.includes(mediaDraftC.id) && !ow.ids.includes(mediaDraftSM.id), ow.error?.message);
  for (const s of strangers) {
    const r = await mediaIds(s);
    record(`Photos A — ${s.label} : liste refusée`, r.error?.message === "not_authorized", r.error?.message);
  }
  const anonMedia = await anon.client.rpc("list_project_media", { p_project_id: pidA });
  record("Photos A — visiteur sans session : refusé", !!anonMedia.error && !anonMedia.data, anonMedia.error?.code);

  // Plans.
  const planKey = (u, id) => u.client.rpc("get_project_plan_version_file_key", { p_version_id: id });
  const pk = await planKey(contractorA, privatePlan.id);
  record("Plan candidat privé — entreprise auteure : clé délivrée", !pk.error && pk.data === privatePlan.key, pk.error?.message);
  const po = await planKey(ownerA, privatePlan.id);
  record("Plan candidat privé de l'entreprise — propriétaire : refusé", po.error?.message === "not_authorized", po.error?.message);
  const pubOwner = await ownerA.client.rpc("get_published_project_plan_file", { p_project_id: pidA });
  const pubRow = Array.isArray(pubOwner.data) ? pubOwner.data[0] : pubOwner.data;
  record("Plan publié A — propriétaire : délivré", !pubOwner.error && pubRow?.storage_key === published.key, pubOwner.error?.message);
  for (const s of [...strangers, anon]) {
    const a = await planKey(s, published.id);
    const b = await planKey(s, privatePlan.id);
    const c = await s.client.rpc("get_published_project_plan_file", { p_project_id: pidA });
    const cRow = Array.isArray(c.data) ? c.data[0] : c.data;
    record(`Plans A — ${s.label} : aucune clé (publié, candidat, plan publié du chantier)`, !!a.error && !!b.error && (!!c.error || !cRow?.storage_key), `${errCode(a)} / ${errCode(b)} / ${errCode(c)}`);
  }

  // Justificatifs d'acompte.
  const rk = (u) => u.client.rpc("get_advance_receipt_file_key", { p_advance_id: advanceId });
  for (const u of [contractorA, ownerA]) {
    const r = await rk(u);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    record(`Justificatif A — ${u.label} : délivré`, !r.error && row?.storage_key === receipt.key, r.error?.message);
  }
  for (const s of [...strangers, anon]) {
    const r = await rk(s);
    record(`Justificatif A — ${s.label} : refusé`, !!r.error && !r.data?.length, errCode(r));
  }

  // Catalogue de l'organisation A (privé à l'organisation).
  const ck = (u) => u.client.rpc("get_catalog_item_version_file", { p_version_id: catalog.id });
  const cOk = await ck(contractorA);
  record("Catalogue A — propriétaire de l'organisation : délivré", !cOk.error, cOk.error?.message);
  for (const s of [ownerA, smA, ...strangers, anon]) {
    const r = await ck(s);
    record(`Catalogue A (privé de l'entreprise) — ${s.label} : refusé`, !!r.error, errCode(r));
  }

  // Documents (B028, M039).
  const docKey = (u, versionId) => u.client.rpc("get_document_version_file_key", { p_version_id: versionId });
  const dkOwner = await docKey(ownerA, docPrinc.versionId);
  const dkRow = Array.isArray(dkOwner.data) ? dkOwner.data[0] : dkOwner.data;
  record("Document PRINCIPAUX A — propriétaire : délivré", !dkOwner.error && dkRow?.storage_key === docPrinc.key, dkOwner.error?.message);
  const dkEnt = await docKey(ownerA, docEnt.versionId);
  record("Document ENTREPRISE A (privé de l'entreprise) — propriétaire : refusé", dkEnt.error?.message === "not_authorized", dkEnt.error?.message);
  const dkSm = await docKey(smA, docPrinc.versionId);
  record("Document PRINCIPAUX A — chef de chantier : refusé (TOUS seulement)", dkSm.error?.message === "not_authorized", dkSm.error?.message);
  for (const s of [...strangers, anon]) {
    const l = await s.client.rpc("list_project_documents", { p_project_id: pidA });
    const k1 = await docKey(s, docPrinc.versionId);
    const k2 = await docKey(s, docEnt.versionId);
    const v = await s.client.rpc("list_document_versions", { p_document_id: docPrinc.id });
    record(`Documents A — ${s.label} : liste, clés et versions refusées`, !!l.error && !!k1.error && !!k2.error && !!v.error, [l, k1, k2, v].map(errCode).join(" / "));
  }

  // ------------------------------------------------------------------------
  // 3. Envoyer / remplacer par le chemin applicatif : préparation refusée,
  //    opération d'autrui jamais revendiquée ni consultée.
  // ------------------------------------------------------------------------
  const bytes = PDF("intrus");
  for (const s of [...strangers, anon]) {
    const m = await s.client.rpc("prepare_media_upload", { p_operation_uuid: randomUUID(), p_project_id: pidA, p_expected_checksum: sha(JPEG), p_expected_size_bytes: JPEG.length, p_expected_mime_type: "image/jpeg" });
    const p = await s.client.rpc("prepare_project_plan_upload", { p_operation_uuid: randomUUID(), p_project_id: pidA, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" });
    const r = await s.client.rpc("prepare_advance_receipt_upload", { p_operation_uuid: randomUUID(), p_advance_id: advanceId, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" });
    const c = await s.client.rpc("prepare_catalog_item_upload", { p_operation_uuid: randomUUID(), p_organization_id: orgA, p_catalog_item_id: item.id, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" });
    const d = await s.client.rpc("prepare_document_upload", { p_operation_uuid: randomUUID(), p_project_id: pidA, p_document_id: null, p_document_type: "AUTRE", p_title: "Intrus", p_description: null, p_visibility: "TOUS", p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" });
    const dv = await s.client.rpc("prepare_document_upload", { p_operation_uuid: randomUUID(), p_project_id: pidA, p_document_id: docPrinc.id, p_document_type: null, p_title: null, p_description: null, p_visibility: null, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" });
    record(`Envoyer vers A — ${s.label} : photo, plan, justificatif, catalogue, document et nouvelle version refusés`, !!m.error && !!p.error && !!r.error && !!c.error && !!d.error && !!dv.error, [m, p, r, c, d, dv].map(errCode).join(" / "));
  }
  const ownerCat = await ownerA.client.rpc("prepare_catalog_item_upload", { p_operation_uuid: randomUUID(), p_organization_id: orgA, p_catalog_item_id: item.id, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" });
  record("Envoyer dans le catalogue de l'entreprise — propriétaire du chantier : refusé", !!ownerCat.error, errCode(ownerCat));
  // Opération en attente d'un membre de A : un tiers ne peut ni la lire ni la revendiquer.
  const pendingOp = randomUUID();
  await must(contractorA.client.rpc("prepare_media_upload", { p_operation_uuid: pendingOp, p_project_id: pidA, p_expected_checksum: sha(JPEG), p_expected_size_bytes: JPEG.length, p_expected_mime_type: "image/jpeg" }), "pending op");
  for (const s of [contractorB, outsider, ownerA]) {
    const st = await s.client.rpc("get_upload_status", { p_operation_uuid: pendingOp });
    const cl = await s.client.rpc("claim_upload_attempt", { p_operation_uuid: pendingOp });
    const fin = await s.client.rpc("finalize_media_upload", { p_operation_uuid: pendingOp, p_origin: "IMPORTED", p_caption: null });
    record(`Opération d'envoi de l'entreprise A — ${s.label} : statut, revendication, finalisation refusés`, !!st.error && !!cl.error && !!fin.error, [st, cl, fin].map(errCode).join(" / "));
  }

  // ------------------------------------------------------------------------
  // 4. Chemin forgé vers un autre chantier.
  // ------------------------------------------------------------------------
  // a) Jeton d'envoi signé émis pour le chantier B, réutilisé vers un chemin de A.
  const opB = randomUUID();
  await must(contractorB.client.rpc("prepare_media_upload", { p_operation_uuid: opB, p_project_id: pidB, p_expected_checksum: sha(JPEG), p_expected_size_bytes: JPEG.length, p_expected_mime_type: "image/jpeg" }), "prepare B");
  const signedB = await must(service.storage.from("project-media").createSignedUploadUrl(`_private/${pidB}/media_asset/${opB}/source`), "signed B");
  const forgedA = `_private/${pidA}/media_asset/${randomUUID()}/source`;
  const forgedUp = await contractorB.client.storage.from("project-media").uploadToSignedUrl(forgedA, signedB.token, JPEG, { contentType: "image/jpeg", upsert: true });
  record("Chemin forgé : jeton d'envoi du chantier B vers un chemin du chantier A refusé", !!forgedUp.error && !(await objectExists("project-media", forgedA)), errCode(forgedUp));
  // b) Même jeton vers la photo publiée de A (remplacement).
  const replaceUp = await contractorB.client.storage.from("project-media").uploadToSignedUrl(mediaPub.key, signedB.token, JPEG, { contentType: "image/jpeg", upsert: true });
  record("Chemin forgé : jeton du chantier B pour écraser une photo de A refusé", !!replaceUp.error, errCode(replaceUp));
  // c) Préparation dans B mais identifiant de chantier A dans les appels suivants : la clé vient toujours de la ligne serveur.
  const stB = await must(contractorB.client.rpc("get_upload_status", { p_operation_uuid: opB }), "status B");
  record("Chemin forgé : l'opération de B reste rattachée à B (clé construite par le serveur)", stB.project_id === pidB);
  // d) Fonctions de lecture appelées avec l'identifiant d'un fichier de A par un membre de B.
  const crossKey = await planKey(contractorB, published.id);
  record("Chemin forgé : identifiant de version de plan de A appelé depuis B refusé", crossKey.error?.message === "not_authorized", crossKey.error?.message);
  // e) Nouvelle version d'un document de A demandée depuis le chantier B.
  const forgedDoc = await contractorB.client.rpc("prepare_document_upload", { p_operation_uuid: randomUUID(), p_project_id: pidB, p_document_id: docPrinc.id, p_document_type: null, p_title: null, p_description: null, p_visibility: null, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" });
  record("Chemin forgé : nouvelle version d'un document de A depuis le chantier B refusée", forgedDoc.error?.message === "not_authorized", forgedDoc.error?.message);

  // ------------------------------------------------------------------------
  // 5. URL signée émise avant le retrait d'accès (constat, sans conclusion).
  // ------------------------------------------------------------------------
  const smList = await mediaIds(smA);
  const issued = await must(service.storage.from("project-media").createSignedUrl(mediaPub.key, 600), "URL de lecture");
  record("Avant retrait : le chef voit la photo publiée, URL émise (durée 600 s comme photos/page.tsx)", smList.ids.includes(mediaPub.id) && !!issued.signedUrl);
  await must(service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pidA).eq("profile_id", smA.id), "révocation chef");
  const afterRevoke = await mediaIds(smA);
  record("Après retrait : le chef ne peut plus obtenir de nouvelle URL (liste refusée)", afterRevoke.error?.message === "not_authorized", afterRevoke.error?.message);
  const reuse = await fetch(issued.signedUrl);
  observe(`URL signée émise avant le retrait d'accès, réutilisée après : HTTP ${reuse.status} — elle reste valable jusqu'à son expiration. Durées d'émission dans le code : photos et plans 600 s (photos/page.tsx, plans/page.tsx), justificatifs 300 s (acomptes/page.tsx), catalogue et validations 300 s. Aucune révocation possible d'une URL déjà émise.`);
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis ; ${observations.length} constat(s).`);
if (passed !== results.length) process.exitCode = 1;
