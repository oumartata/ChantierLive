// Ajoute une vraie vidéo (fixture MP4 valide) au projet de démonstration
// existant, publiée, pour une vérification navigateur ciblée de la lecture
// réelle. Réutilise le compte de test créé par seed-browser-walkthrough.mjs.
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const BUCKET = "project-media";

const [, , email, password, projectId] = process.argv;
if (!email || !password || !projectId) {
  console.error("Usage: node scripts/seed-video-for-browser-check.mjs <email> <password> <projectId>");
  process.exit(1);
}

const service = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const author = createClient(URL, ANON_KEY);
const { error: signInErr } = await author.auth.signInWithPassword({ email, password });
if (signInErr) throw signInErr;

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

const bytes = readFileSync(
  "C:/Users/HP/AppData/Local/Temp/claude/C--ChantierLive/a9ab9b02-2514-4baf-8ea2-961ef8c6117f/scratchpad/fixtures/test-video.mp4"
);
const operationUuid = randomUUID();
const checksum = sha256Hex(bytes);

const { error: prepErr } = await author.rpc("prepare_media_upload", {
  p_operation_uuid: operationUuid, p_project_id: projectId,
  p_expected_checksum: checksum, p_expected_size_bytes: bytes.length, p_expected_mime_type: "video/mp4",
});
if (prepErr) throw prepErr;

const tempPath = `_private/${projectId}/media_asset/${operationUuid}/source`;
const { data: signed, error: signErr } = await service.storage.from(BUCKET).createSignedUploadUrl(tempPath);
if (signErr) throw signErr;
const { error: putErr } = await author.storage.from(BUCKET).uploadToSignedUrl(signed.path, signed.token, bytes, { contentType: "video/mp4" });
if (putErr) throw putErr;

const { data: claim, error: claimErr } = await author.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
if (claimErr) throw claimErr;

const { data: tempFile } = await service.storage.from(BUCKET).download(tempPath);
const realBytes = new Uint8Array(await tempFile.arrayBuffer());
const { error: writeErr } = await service.storage.from(BUCKET).upload(claim.candidate_key, Buffer.from(realBytes), {
  contentType: "video/mp4", upsert: false,
});
if (writeErr) throw writeErr;

const { error: attestErr } = await service.rpc("attest_storage_verified", {
  p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
  p_actual_checksum: sha256Hex(Buffer.from(realBytes)), p_actual_size_bytes: realBytes.length, p_actual_mime_type: "video/mp4",
});
if (attestErr) throw attestErr;

const { data: media, error: finErr } = await author.rpc("finalize_media_upload", {
  p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: "Vidéo de test — vérification lecture réelle",
});
if (finErr) throw finErr;

const { error: pubErr } = await author.rpc("publish_media_asset", { p_media_asset_id: media.id });
if (pubErr) throw pubErr;

console.log(JSON.stringify({ mediaId: media.id }, null, 2));
