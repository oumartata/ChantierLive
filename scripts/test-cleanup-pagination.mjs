// Test d'intégration LOCAL uniquement — boucle 27 : le nettoyage des envois
// (scripts/cleanup_media_candidates.mjs) traite TOUTES les lignes, au-delà du
// plafond de 1 000 lignes par réponse de PostgREST (max_rows).
//
// Données jetables créées par ce script : un chantier, un document finalisé
// (fichier légitime à protéger), une opération d'envoi en attente servant de
// référence, et plus de 1 000 traces de clés synthétiques dans chacune des
// deux listes (à nettoyer, déjà nettoyées). Une clé de chaque liste a un
// identifiant choisi pour être rangée tout en fin d'ordre : elle est au-delà
// de la 1 000e ligne, là où l'ancienne lecture s'arrêtait. À la fin, le test
// retire les traces qu'il a créées (jamais d'autres lignes) : la table ne
// grossit pas d'une exécution à l'autre.
//
// 1. Cause : la lecture simple renvoie 1 000 lignes ; la lecture paginée les
//    renvoie toutes, dont nos clés rangées en dernier.
// 2. Script en --dry-run : sélection complète, clé tardive détectée, rien
//    n'est modifié.
// 3. Script réel : la clé rangée en dernier est nettoyée, l'écriture tardive
//    rangée en dernier est supprimée, le fichier du document finalisé reste
//    intact (même empreinte), même si une trace erronée pointe vers lui.
//
// Usage : node --env-file=.env.local scripts/test-cleanup-pagination.mjs

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readAllRpc } from "./lib/paginated-rpc.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const local = (() => { try { const { hostname } = new URL(SUPABASE_URL); return hostname === "127.0.0.1" || hostname === "localhost"; } catch { return false; } })();
if (!local) { console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`); process.exit(1); }
if (!SERVICE_KEY || !ANON_KEY) { console.error("Clés locales manquantes."); process.exit(1); }

const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const BUCKET = "project-documents";
const SYNTHETIC_PER_LIST = 1001;
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function must(res, what) { const r = await res; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; }
const lastId = () => `ffffffff-ffff-4fff-8fff-${randomUUID().slice(-12)}`;
const exists = async (key) => { const { data, error } = await service.storage.from(BUCKET).download(key); return !error && !!data; };
const hashOf = async (key) => { const { data, error } = await service.storage.from(BUCKET).download(key); return error || !data ? null : sha(Buffer.from(await data.arrayBuffer())); };
const countWhere = async (cleaned) => {
  const q = service.from("private_object_stale_keys").select("id", { count: "exact", head: true });
  const { count, error } = await (cleaned ? q.not("cleaned_at", "is", null) : q.is("cleaned_at", null));
  if (error) throw new Error(error.message);
  return count;
};
function runCleanup(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ["scripts/cleanup_media_candidates.mjs", ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve({ code, out }));
  });
}
const selected = (out, phase) => Number((out.match(new RegExp(`Phase ${phase} — sélection : (\\d+)`)) ?? [])[1] ?? NaN);

try {
  // Compte jetable, chantier, document finalisé (fichier légitime).
  const email = `b027-nettoyage-${Date.now()}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { error: uErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (uErr) throw new Error(uErr.message);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  await must(client.auth.signInWithPassword({ email, password }), "connexion");
  const created = await must(client.rpc("create_draft_project", { p_name: "Boucle 27 — nettoyage", p_country: "ML", p_role: "CONTRACTOR" }), "projet");
  const pid = (Array.isArray(created) ? created[0] : created).project_id;
  const prepareDoc = async (bytes) => {
    const op = randomUUID();
    const prep = await must(client.rpc("prepare_document_upload", { p_operation_uuid: op, p_project_id: pid, p_document_id: null, p_document_type: "AUTRE", p_title: "Fichier légitime", p_description: null, p_visibility: "ENTREPRISE", p_expected_checksum: sha(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "application/pdf" }), "préparation");
    return { op, prep };
  };
  const legitBytes = Buffer.from(`%PDF-1.4 légitime ${randomUUID()}`);
  const legit = await prepareDoc(legitBytes);
  const legitClaim = await must(client.rpc("claim_upload_attempt", { p_operation_uuid: legit.op, p_expected_attempt_id: legit.prep.attempt_id }), "revendication");
  await must(service.storage.from(BUCKET).upload(legitClaim.candidate_key, legitBytes, { contentType: "application/pdf", upsert: false }), "écriture");
  await must(service.rpc("attest_storage_verified", { p_operation_uuid: legit.op, p_attempt_id: legitClaim.attempt_id, p_actual_checksum: sha(legitBytes), p_actual_size_bytes: legitBytes.length, p_actual_mime_type: "application/pdf" }), "attestation");
  await must(client.rpc("finalize_document_upload", { p_operation_uuid: legit.op }), "finalisation");
  const legitKey = legitClaim.candidate_key;
  const legitHash = await hashOf(legitKey);
  // Opération en attente servant de référence aux traces synthétiques.
  const ref = await prepareDoc(Buffer.from(`%PDF-1.4 référence ${randomUUID()}`));
  const refId = ref.prep.id;
  const prefix = `_private/${pid}/document_version/${ref.op}/candidates`;

  // Traces synthétiques : > 1 000 dans chaque liste, une de chaque rangée en dernier.
  const lastPending = { id: lastId(), key: `${prefix}/dernier-a-nettoyer-${randomUUID()}` };
  const lastCleaned = { id: lastId(), key: `${prefix}/derniere-ecriture-tardive-${randomUUID()}` };
  const rows = [];
  for (let i = 0; i < SYNTHETIC_PER_LIST - 1; i++) rows.push({ private_object_upload_id: refId, storage_key: `${prefix}/syn-a-${randomUUID()}`, kind: "candidate" });
  for (let i = 0; i < SYNTHETIC_PER_LIST - 1; i++) rows.push({ private_object_upload_id: refId, storage_key: `${prefix}/syn-n-${randomUUID()}`, kind: "candidate", cleaned_at: new Date().toISOString() });
  rows.push({ id: lastPending.id, private_object_upload_id: refId, storage_key: lastPending.key, kind: "candidate" });
  rows.push({ id: lastCleaned.id, private_object_upload_id: refId, storage_key: lastCleaned.key, kind: "candidate", cleaned_at: new Date().toISOString() });
  // Trace ERRONÉE pointant vers le fichier finalisé : il ne doit jamais être touché.
  const wrongTrace = { id: lastId(), private_object_upload_id: legit.prep.id, storage_key: legitKey, kind: "candidate", cleaned_at: new Date().toISOString() };
  rows.push(wrongTrace);
  for (let i = 0; i < rows.length; i += 500) await must(service.from("private_object_stale_keys").insert(rows.slice(i, i + 500)), "traces synthétiques");
  // Écriture tardive sur la clé déjà nettoyée rangée en dernier.
  await must(service.storage.from(BUCKET).upload(lastCleaned.key, Buffer.from("%PDF-1.4 écriture tardive"), { contentType: "application/pdf", upsert: true }), "écriture tardive");

  // 1. Cause et lecture complète.
  const pendingCount = await countWhere(false);
  const plainPending = (await service.rpc("list_stale_media_keys")).data ?? [];
  const pagedPending = await readAllRpc(service, "list_stale_media_keys");
  record(`Cause : lecture simple plafonnée à 1 000 lignes (à nettoyer : ${pendingCount} en base)`, pendingCount > 1000 && plainPending.length === 1000, `${plainPending.length}`);
  const pendingPos = pagedPending.findIndex((k) => k.id === lastPending.id);
  record("Lecture paginée : toutes les clés à nettoyer, sans doublon, la nôtre au-delà de la 1 000e", pagedPending.length === pendingCount && new Set(pagedPending.map((k) => k.id)).size === pendingCount && pendingPos >= 1000, `${pagedPending.length}/${pendingCount}, position ${pendingPos + 1}`);
  const pagedCleaned = await readAllRpc(service, "list_recently_cleaned_media_keys");
  const cleanedPos = pagedCleaned.findIndex((k) => k.id === lastCleaned.id);
  record("Lecture paginée : clés nettoyées au-delà de 1 000, la nôtre au-delà de la 1 000e ; le fichier finalisé exclu", pagedCleaned.length > 1000 && cleanedPos >= 1000 && new Set(pagedCleaned.map((k) => k.id)).size === pagedCleaned.length && !pagedCleaned.some((k) => k.id === wrongTrace.id), `${pagedCleaned.length} lignes, position ${cleanedPos + 1}`);
  const tooBig = await readAllRpc(service, "list_stale_media_keys", {}, { pageSize: 1000 }).then(() => null, (e) => e.message);
  record("Page refusée si elle atteint le plafond du serveur (aucun plafond silencieux)", !!tooBig && /taille de page/.test(tooBig), tooBig ?? "acceptée");

  // 2. Script en --dry-run : sélection complète, aucune mutation.
  const dry = await runCleanup(["--dry-run"]);
  const pendingAfterDry = (await service.from("private_object_stale_keys").select("cleaned_at").eq("id", lastPending.id).single()).data;
  record("--dry-run : phase B sélectionne toutes les clés à nettoyer et cite la dernière", dry.code === 0 && selected(dry.out, "B") === pendingCount && dry.out.includes(lastPending.key), `sélection ${selected(dry.out, "B")}/${pendingCount}`);
  record("--dry-run : phase C revérifie au-delà de 1 000 et détecte l'écriture tardive rangée en dernier", selected(dry.out, "C") === pagedCleaned.length && dry.out.includes(`écriture tardive détectée, supprimerait à nouveau : (candidate) ${lastCleaned.key}`), `sélection ${selected(dry.out, "C")}`);
  record("--dry-run : rien n'est modifié (écriture tardive présente, trace non nettoyée, fichier finalisé intact)", (await exists(lastCleaned.key)) && pendingAfterDry.cleaned_at === null && (await hashOf(legitKey)) === legitHash);

  // 3. Script réel : traitement au-delà de 1 000 lignes, fichier légitime intact.
  const real = await runCleanup([]);
  const pendingAfter = (await service.from("private_object_stale_keys").select("cleaned_at").eq("id", lastPending.id).single()).data;
  record("Nettoyage réel : terminé sans erreur", real.code === 0, real.code === 0 ? "" : real.out.slice(-400));
  record("Nettoyage réel : la clé rangée en dernier (au-delà de 1 000) est nettoyée", pendingAfter.cleaned_at !== null);
  record("Nettoyage réel : l'écriture tardive rangée en dernier est supprimée", !(await exists(lastCleaned.key)));
  record("Nettoyage réel : fichier du document finalisé intact (même empreinte), malgré une trace erronée", (await hashOf(legitKey)) === legitHash);
  const { count: leftSynthetic } = await service.from("private_object_stale_keys").select("id", { count: "exact", head: true }).eq("private_object_upload_id", refId).is("cleaned_at", null);
  record(`Nettoyage réel : les ${SYNTHETIC_PER_LIST} traces synthétiques à nettoyer sont toutes traitées`, leftSynthetic === 0, String(leftSynthetic));

  // Retrait des seules traces créées par CETTE exécution (identifiées par leur opération de
  // référence et par l'identifiant de la trace erronée) ; aucun fichier n'est touché.
  const { count: removed, error: delErr } = await service.from("private_object_stale_keys").delete({ count: "exact" }).or(`private_object_upload_id.eq.${refId},id.eq.${wrongTrace.id}`);
  if (delErr) throw new Error(`retrait des traces du test : ${delErr.message}`);
  if (removed !== rows.length) throw new Error(`retrait des traces du test : ${removed} au lieu de ${rows.length}`);
  if ((await hashOf(legitKey)) !== legitHash) throw new Error("fichier finalisé modifié après le retrait des traces");
  console.log(`Données du test : ${removed} traces créées par cette exécution retirées ; fichier finalisé intact.`);
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
