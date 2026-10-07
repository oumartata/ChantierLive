// Test d'intégration LOCAL uniquement : M039, documents et versions (B028,
// D169–D176). Données jetables créées par ce script.
//
// Usage : node --env-file=.env.local scripts/test-documents.mjs

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const local = (() => { try { const { hostname } = new URL(SUPABASE_URL); return hostname === "127.0.0.1" || hostname === "localhost"; } catch { return false; } })();
if (!local) { console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`); process.exit(1); }
if (!SERVICE_KEY || !ANON_KEY) { console.error("Clés locales manquantes."); process.exit(1); }

const BUCKET = "project-documents";
const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const err = (r) => r?.error?.message ?? r?.error?.code ?? "aucune erreur";
async function user(label) {
  const email = `m039-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`signIn(${label}): ${e.message}`);
  return { id: data.user.id, client, label };
}
// Même détection par signature que l'action serveur (documents/actions.ts).
function sniff(b) {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
const PDF = (label) => Buffer.from(`%PDF-1.4 B028 ${label} ${randomUUID()}`);

// Reproduit l'action serveur : préparation, revendication, écriture de la
// candidate, relecture des octets RÉELLEMENT stockés, type réel détecté,
// attestation, finalisation.
async function deposit(u, projectId, { documentId = null, type = "CONTRAT", title = "Contrat de construction", description = null, visibility = "PRINCIPAUX", bytes = PDF("doc"), mime = "application/pdf" } = {}) {
  const op = randomUUID();
  const prep = await u.client.rpc("prepare_document_upload", {
    p_operation_uuid: op, p_project_id: projectId, p_document_id: documentId,
    p_document_type: documentId ? null : type, p_title: documentId ? null : title, p_description: documentId ? null : description,
    p_visibility: documentId ? null : visibility, p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: mime,
  });
  if (prep.error) return { stage: "prepare", error: prep.error, op };
  const claim = await u.client.rpc("claim_upload_attempt", { p_operation_uuid: op, p_expected_attempt_id: prep.data.attempt_id });
  if (claim.error) return { stage: "claim", error: claim.error, op };
  const up = await service.storage.from(BUCKET).upload(claim.data.candidate_key, bytes, { contentType: mime, upsert: false });
  if (up.error) return { stage: "upload", error: up.error, op };
  const dl = await service.storage.from(BUCKET).download(claim.data.candidate_key);
  const stored = new Uint8Array(await dl.data.arrayBuffer());
  const attest = await service.rpc("attest_storage_verified", {
    p_operation_uuid: op, p_attempt_id: claim.data.attempt_id, p_actual_checksum: sha(stored), p_actual_size_bytes: stored.length,
    p_actual_mime_type: sniff(stored) ?? "application/octet-stream",
  });
  const fin = await u.client.rpc("finalize_document_upload", { p_operation_uuid: op });
  return { stage: attest.error ? "attest" : "finalize", attestError: attest.error, error: fin.error, version: fin.data, op, key: claim.data.candidate_key };
}
const docRow = async (id) => (await service.from("documents").select("*").eq("id", id).single()).data;
const list = (u, pid) => u.client.rpc("list_project_documents", { p_project_id: pid });
const ids = async (u, pid) => { const r = await list(u, pid); return { error: r.error, ids: (r.data ?? []).map((d) => d.id), rows: r.data ?? [] }; };
const fileKey = (u, versionId) => u.client.rpc("get_document_version_file_key", { p_version_id: versionId });
const versions = (u, documentId) => u.client.rpc("list_document_versions", { p_document_id: documentId });
const publish = async (u, documentId) => u.client.rpc("publish_document", { p_document_id: documentId, p_expected_revision: (await docRow(documentId)).revision });
const archive = async (u, documentId, reason) => u.client.rpc("archive_document", { p_document_id: documentId, p_expected_revision: (await docRow(documentId)).revision, p_reason: reason });

try {
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const exMember = await user("ex-coproprietaire");
  const outsider = await user("hors-chantier");
  const contractorB = await user("entreprise-b");
  const anon = { label: "visiteur sans session", client: createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) };
  const { data: created, error: projErr } = await contractor.client.rpc("create_draft_project", { p_name: "M039 — documents", p_country: "ML", p_role: "CONTRACTOR" });
  if (projErr) throw new Error(projErr.message);
  const pid = (Array.isArray(created) ? created[0] : created).project_id;
  const createdB = await contractorB.client.rpc("create_draft_project", { p_name: "M039 — autre chantier", p_country: "ML", p_role: "CONTRACTOR" });
  const pidB = (Array.isArray(createdB.data) ? createdB.data[0] : createdB.data).project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null], [exMember, "OWNER", "CO_OWNER"]]) {
    const { error } = await service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op });
    if (error) throw new Error(`adhésion ${u.label}: ${error.message}`);
  }

  // 1. Dépôt (D171, D169, D176).
  const cPrinc = await deposit(contractor, pid, { title: "Contrat signé", visibility: "PRINCIPAUX" });
  record("Entreprise : dépose un document PRINCIPAUX (brouillon, version 1)", !cPrinc.error && cPrinc.version?.version_number === 1 && (await docRow(cPrinc.version.document_id)).status === "BROUILLON", `${cPrinc.stage} ${err(cPrinc)}`);
  const cEnt = await deposit(contractor, pid, { type: "FACTURE", title: "Facture fournisseur interne", visibility: "ENTREPRISE" });
  const cTous = await deposit(contractor, pid, { type: "PROCES_VERBAL", title: "PV de réception des fondations", visibility: "TOUS", bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(randomUUID())]), mime: "image/jpeg" });
  const oTous = await deposit(owner, pid, { type: "AUTORISATION", title: "Permis de construire", visibility: "TOUS" });
  const oPrinc = await deposit(owner, pid, { type: "RECU", title: "Reçu terrain", visibility: "PRINCIPAUX" });
  record("Dépôts : entreprise ENTREPRISE et TOUS (JPEG), propriétaire TOUS et PRINCIPAUX", [cEnt, cTous, oTous, oPrinc].every((d) => !d.error && d.version), [cEnt, cTous, oTous, oPrinc].map((d) => `${d.stage}:${err(d)}`).join(" / "));
  const oEnt = await deposit(owner, pid, { visibility: "ENTREPRISE" });
  record("Propriétaire : visibilité ENTREPRISE refusée", oEnt.error?.message === "visibility_not_allowed", err(oEnt));
  for (const u of [coOwner, sm, outsider, contractorB]) {
    const r = await deposit(u, pid);
    record(`${u.label} : dépôt refusé`, r.stage === "prepare" && r.error?.message === "not_authorized", err(r));
  }
  const ra = await deposit(anon, pid);
  record("Visiteur sans session : dépôt refusé", ra.stage === "prepare" && !!ra.error, err(ra));
  for (const [label, opts, code] of [
    ["type hors liste", { type: "CONTRAT_SECRET" }, "document_type_invalid"],
    ["titre trop court", { title: "ab" }, "document_invalid"],
    ["type de fichier non admis", { mime: "application/x-msdownload" }, "mime_type_required"],
  ]) {
    const r = await deposit(contractor, pid, opts);
    record(`Dépôt refusé : ${label}`, r.error?.message === code, err(r));
  }
  const big = await contractor.client.rpc("prepare_document_upload", { p_operation_uuid: randomUUID(), p_project_id: pid, p_document_id: null, p_document_type: "AUTRE", p_title: "Trop lourd", p_description: null, p_visibility: "TOUS", p_expected_checksum: sha(Buffer.from("x")), p_expected_size_bytes: 20971521, p_expected_mime_type: "application/pdf" });
  record("Dépôt refusé : plus de 20 Mo", big.error?.message === "size_required", err(big));

  // 2. Type réel contrôlé : un exécutable déclaré PDF n'est jamais finalisé (EC046).
  const exe = await deposit(contractor, pid, { title: "Faux PDF", bytes: Buffer.concat([Buffer.from("MZ"), Buffer.from(randomUUID())]), mime: "application/pdf" });
  const { count: exeDocs } = await service.from("documents").select("id", { count: "exact", head: true }).eq("project_id", pid).eq("title", "Faux PDF");
  record("Type réel : exécutable déclaré PDF refusé à l'attestation, aucun document créé", !!exe.attestError && !!exe.error && exeDocs === 0, `${err({ error: exe.attestError })} / ${err(exe)}`);

  const D = { cPrinc: cPrinc.version.document_id, cEnt: cEnt.version.document_id, cTous: cTous.version.document_id, oTous: oTous.version.document_id, oPrinc: oPrinc.version.document_id };
  const V1 = { cPrinc: cPrinc.version.id, cEnt: cEnt.version.id };

  // 3. Brouillon visible par l'auteur seul (D170).
  const cDraft = await ids(contractor, pid);
  record("Entreprise : voit ses 3 brouillons, pas ceux du propriétaire", [D.cPrinc, D.cEnt, D.cTous].every((i) => cDraft.ids.includes(i)) && !cDraft.ids.includes(D.oTous) && !cDraft.ids.includes(D.oPrinc));
  const oDraft = await ids(owner, pid);
  record("Propriétaire : voit ses 2 brouillons, aucun de l'entreprise", oDraft.ids.length === 2 && oDraft.ids.includes(D.oTous) && oDraft.ids.includes(D.oPrinc));
  for (const u of [coOwner, sm]) {
    const r = await ids(u, pid);
    record(`${u.label} : aucun brouillon visible`, !r.error && r.ids.length === 0, err(r));
  }
  const kDraft = await fileKey(owner, V1.cPrinc);
  const vDraft = await versions(owner, D.cPrinc);
  record("Propriétaire : fichier et versions d'un brouillon de l'entreprise refusés", kDraft.error?.message === "not_authorized" && vDraft.error?.message === "not_authorized", `${err(kDraft)} / ${err(vDraft)}`);

  // 4. Publication explicite par l'auteur (D170, D173).
  const pOther = await publish(owner, D.cPrinc);
  record("Propriétaire : publication d'un brouillon de l'entreprise refusée", pOther.error?.message === "not_authorized", err(pOther));
  const stale = await contractor.client.rpc("publish_document", { p_document_id: D.cPrinc, p_expected_revision: 99 });
  record("Publication sur révision périmée refusée", stale.error?.message === "revision_conflict", err(stale));
  const published = [];
  for (const [u, id] of [[contractor, D.cPrinc], [contractor, D.cEnt], [contractor, D.cTous], [owner, D.oTous], [owner, D.oPrinc]]) {
    const r = await publish(u, id);
    published.push(!r.error && r.data?.status === "PUBLIE");
  }
  record("Auteurs : publient leurs 5 documents", published.every(Boolean));

  // 5. Visibilité (D169).
  const seen = async (u) => (await ids(u, pid)).ids;
  const cS = await seen(contractor), oS = await seen(owner), coS = await seen(coOwner), smS = await seen(sm);
  record("Entreprise : voit les 5 documents publiés", Object.values(D).every((i) => cS.includes(i)));
  record("Propriétaire principal : PRINCIPAUX et TOUS, jamais ENTREPRISE", [D.cPrinc, D.cTous, D.oTous, D.oPrinc].every((i) => oS.includes(i)) && !oS.includes(D.cEnt));
  record("Copropriétaire : PRINCIPAUX et TOUS, jamais ENTREPRISE", [D.cPrinc, D.cTous, D.oTous, D.oPrinc].every((i) => coS.includes(i)) && !coS.includes(D.cEnt));
  record("Chef de chantier : TOUS seulement", smS.length === 2 && smS.includes(D.cTous) && smS.includes(D.oTous));
  for (const u of [owner, coOwner, sm]) {
    const k = await fileKey(u, V1.cEnt);
    const v = await versions(u, D.cEnt);
    record(`${u.label} : fichier et versions du document ENTREPRISE refusés`, k.error?.message === "not_authorized" && v.error?.message === "not_authorized", `${err(k)} / ${err(v)}`);
  }
  const smP = await fileKey(sm, V1.cPrinc);
  record("Chef de chantier : fichier d'un document PRINCIPAUX refusé", smP.error?.message === "not_authorized", err(smP));
  const okKey = await fileKey(owner, V1.cPrinc);
  const okRow = Array.isArray(okKey.data) ? okKey.data[0] : okKey.data;
  record("Propriétaire : fichier d'un document PRINCIPAUX délivré (compartiment project-documents)", !okKey.error && okRow?.bucket === BUCKET && okRow?.storage_key === cPrinc.key, err(okKey));

  // 6. Versions (D172) : jamais d'écrasement, ancienne lisible.
  const v1Bytes = sha(Buffer.from(await (await service.storage.from(BUCKET).download(cPrinc.key)).data.arrayBuffer()));
  const nv = await deposit(contractor, pid, { documentId: D.cPrinc, bytes: PDF("v2") });
  record("Entreprise : nouvelle version de son document (v2 liée à v1, publiée)", !nv.error && nv.version?.version_number === 2 && nv.version?.supersedes_version_id === V1.cPrinc && (await docRow(D.cPrinc)).current_version_id === nv.version.id, `${nv.stage} ${err(nv)}`);
  const vl = await versions(owner, D.cPrinc);
  record("Propriétaire : historique des 2 versions (v2 courante)", !vl.error && vl.data.length === 2 && vl.data[0].version_number === 2 && vl.data[0].is_current && !vl.data[1].is_current, err(vl));
  const oldKey = await fileKey(owner, V1.cPrinc);
  const oldRow = Array.isArray(oldKey.data) ? oldKey.data[0] : oldKey.data;
  const v1After = sha(Buffer.from(await (await service.storage.from(BUCKET).download(cPrinc.key)).data.arrayBuffer()));
  record("Ancienne version toujours lisible et intacte (clé et octets inchangés)", !oldKey.error && oldRow?.storage_key === cPrinc.key && cPrinc.key !== nv.key && v1Bytes === v1After, err(oldKey));
  const dRow = await docRow(D.cPrinc);
  record("Nouvelle version : type et visibilité repris", dRow.document_type === "CONTRAT" && dRow.visibility === "PRINCIPAUX");
  const ovC = await deposit(owner, pid, { documentId: D.cPrinc });
  record("Propriétaire : nouvelle version d'un document de l'entreprise refusée", ovC.stage === "prepare" && ovC.error?.message === "not_authorized", err(ovC));
  const cvO = await deposit(contractor, pid, { documentId: D.oTous });
  record("Entreprise : nouvelle version d'un document du propriétaire refusée", cvO.stage === "prepare" && cvO.error?.message === "not_authorized", err(cvO));
  const ovO = await deposit(owner, pid, { documentId: D.oTous, bytes: PDF("permis-v2") });
  record("Propriétaire : nouvelle version de son propre document", !ovO.error && ovO.version?.version_number === 2, `${ovO.stage} ${err(ovO)}`);
  const smV = await deposit(sm, pid, { documentId: D.cTous });
  record("Chef de chantier : nouvelle version refusée", smV.error?.message === "not_authorized", err(smV));
  const draftDoc = await deposit(contractor, pid, { title: "Brouillon à remplacer" });
  const draftV = await deposit(contractor, pid, { documentId: draftDoc.version.document_id });
  record("Nouvelle version d'un brouillon refusée (versions seulement après publication)", draftV.error?.message === "not_authorized", err(draftV));
  const upV = await service.from("document_versions").update({ mime_type: "image/png" }).eq("id", V1.cPrinc);
  const delV = await service.from("document_versions").delete().eq("id", V1.cPrinc);
  record("Version jamais modifiée ni supprimée (même service_role)", upV.error?.message === "document_version_immutable" && delV.error?.message === "document_version_immutable", `${err(upV)} / ${err(delV)}`);
  const vis = await service.from("documents").update({ visibility: "TOUS" }).eq("id", D.cEnt);
  record("Visibilité figée après publication (même service_role)", vis.error?.message === "document_published_immutable", err(vis));
  const delD = await service.from("documents").delete().eq("id", D.cEnt);
  record("Document jamais supprimé (même service_role)", delD.error?.message === "document_immutable", err(delD));

  // 7. Archivage (D174).
  const aOther = await archive(owner, D.cPrinc, "Pas le mien");
  record("Propriétaire : archivage d'un document de l'entreprise refusé", aOther.error?.message === "not_authorized", err(aOther));
  const aOther2 = await archive(contractor, D.oPrinc, "Pas le mien");
  record("Entreprise : archivage d'un document du propriétaire refusé", aOther2.error?.message === "not_authorized", err(aOther2));
  const aNo = await archive(contractor, D.cPrinc, " ");
  record("Archivage sans motif refusé", aNo.error?.message === "reason_required", err(aNo));
  const aOk = await archive(contractor, D.cPrinc, "Remplacé par l'avenant signé");
  record("Entreprise : archive son document avec motif", !aOk.error && aOk.data?.status === "ARCHIVE" && aOk.data?.archive_reason === "Remplacé par l'avenant signé", err(aOk));
  const oArch = await ids(owner, pid);
  const archRow = oArch.rows.find((r) => r.id === D.cPrinc);
  const archKeyV1 = await fileKey(owner, V1.cPrinc);
  const archKeyV2 = await fileKey(owner, nv.version.id);
  record("Document archivé : toujours listé comme archivé, ses 2 versions restent consultables", archRow?.status === "ARCHIVE" && !archKeyV1.error && !archKeyV2.error, `${err(archKeyV1)} / ${err(archKeyV2)}`);
  const vArch = await deposit(contractor, pid, { documentId: D.cPrinc });
  const aAgain = await archive(contractor, D.cPrinc, "Encore");
  record("Document archivé : ni nouvelle version, ni second archivage", vArch.error?.message === "not_authorized" && aAgain.error?.message === "document_archived", `${err(vArch)} / ${err(aAgain)}`);
  const aDraftOther = await archive(owner, draftDoc.version.document_id, "Pas le mien");
  const aDraft = await archive(contractor, draftDoc.version.document_id, "Déposé par erreur");
  record("Brouillon : archivé par son auteur seul", aDraftOther.error?.message === "not_authorized" && !aDraft.error, `${err(aDraftOther)} / ${err(aDraft)}`);
  const oArchOwn = await archive(owner, D.oPrinc, "Reçu en double");
  record("Propriétaire : archive son propre document", !oArchOwn.error && oArchOwn.data?.status === "ARCHIVE", err(oArchOwn));
  const { count: auditArch } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("project_id", pid).eq("action", "DOCUMENT_ARCHIVE");
  const { count: auditPub } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("project_id", pid).eq("action", "DOCUMENT_PUBLISH");
  const { count: auditVer } = await service.from("audit_events").select("id", { count: "exact", head: true }).eq("project_id", pid).eq("action", "DOCUMENT_NEW_VERSION");
  record("Audit : publications, nouvelles versions et archivages tracés", auditPub === 5 && auditVer === 2 && auditArch === 3, `${auditPub}/${auditVer}/${auditArch}`);

  // 8. Opération d'envoi d'autrui, non-membre, ex-membre, sans session.
  const pending = randomUUID();
  const b = PDF("pending");
  await contractor.client.rpc("prepare_document_upload", { p_operation_uuid: pending, p_project_id: pid, p_document_id: null, p_document_type: "AUTRE", p_title: "En cours", p_description: null, p_visibility: "TOUS", p_expected_checksum: sha(b), p_expected_size_bytes: b.length, p_expected_mime_type: "application/pdf" });
  for (const u of [owner, outsider]) {
    const st = await u.client.rpc("get_upload_status", { p_operation_uuid: pending });
    const cl = await u.client.rpc("claim_upload_attempt", { p_operation_uuid: pending });
    const fi = await u.client.rpc("finalize_document_upload", { p_operation_uuid: pending });
    record(`${u.label} : envoi en cours de l'entreprise ni lu, ni revendiqué, ni finalisé`, !!st.error && !!cl.error && !!fi.error, [st, cl, fi].map(err).join(" / "));
  }
  const exBefore = await seen(exMember);
  await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", pid).eq("profile_id", exMember.id);
  for (const u of [exMember, outsider, contractorB]) {
    const l = await list(u, pid);
    const k = await fileKey(u, cTous.version.id);
    const v = await versions(u, D.cTous);
    record(`${u.label} : liste, fichier et versions refusés`, l.error?.message === "not_authorized" && k.error?.message === "not_authorized" && v.error?.message === "not_authorized", [l, k, v].map(err).join(" / "));
  }
  record("Ex-membre : voyait les documents avant le retrait", exBefore.includes(D.cTous));
  const al = await list(anon, pid);
  record("Visiteur sans session : refusé", !!al.error && !al.data, err(al));
  const crossB = await deposit(contractorB, pid, { documentId: D.cTous });
  record("Entreprise d'un autre chantier : nouvelle version refusée", crossB.error?.message === "not_authorized", err(crossB));
  const tbl = await owner.client.from("documents").select("id").limit(1);
  const tblV = await owner.client.from("document_versions").select("id").limit(1);
  record("Lecture directe des tables refusée", tbl.error?.code === "42501" && tblV.error?.code === "42501", `${tbl.error?.code} / ${tblV.error?.code}`);
  console.log(`(chantier B ${pidB} : témoin d'appartenance)`);
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
