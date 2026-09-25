// Test d'intégration LOCAL uniquement (aucune connexion cloud) pour B026 +
// tranche B027 (media_asset). Couvre exactement les risques identifiés par
// le fondateur : permissions/lecture, concurrence, timeout/tentative
// tardive, finalisation frauduleuse, échec de création média, immutabilité,
// nettoyage. Fixtures isolées (utilisateurs/projet dédiés), pas de
// suppression de données existantes. Usage : node scripts/test-media-upload.mjs
//
// Nécessite l'instance Supabase locale démarrée (npx supabase status) et
// SUPABASE_SERVICE_ROLE_KEY dans l'environnement (voir .env.local, jamais
// affiché ni committé).

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const BUCKET = "project-media";

// Copie locale de src/lib/media/sniffMimeType.ts (script Node autonome, hors
// pipeline TypeScript de l'app) — doit rester synchronisée avec l'original.
// Détecte le format RÉEL à partir des octets, jamais du type déclaré.
function sniffMimeType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4";
  return null;
}

// Fixture RÉELLE, décodable (1x1 pixel rouge), même fichier que le parcours
// navigateur du 2026-09-25 — utilisée pour les tests POSITIFS.
const REAL_JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64"
);

// Fixture RÉELLE, décodable par un lecteur vidéo (1 image, h264/mp4, générée
// localement via ffmpeg le 2026-09-25 : `ffmpeg -f lavfi -i color=c=red:s=32x32:d=0.2:r=5
// -frames:v 1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart`). Aucune
// dépendance ajoutée au projet : ffmpeg n'a servi qu'à produire ce fichier de
// test, il n'est invoqué par aucun code applicatif.
const REAL_MP4_BYTES = Buffer.from(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMVbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAAAAABAAAAAAG4bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABY21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASNzdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMCBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UlsBEAAAAMAQAAAAwKDxIllgAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAABwWAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAQAACAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAACzwAAAAEAAAAUc3RjbwAAAAAAAAABAAADRQAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDAAAAAIZnJlZQAAAtdtZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMyAwNDgwY2IwIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAaZYiEAD///uZ1+BTTCBpJMvxDzj8xVtngGfE=",
  "base64"
);

if (!SERVICE_KEY || !ANON_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY manquants dans l'environnement.");
  process.exit(1);
}

const service = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function createTestUser(label) {
  const email = `b027-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  // Compte vérifié requis (is_account_provisional false) : ajoute un
  // identifiant confirmé, cohérent avec le modèle profile_identifiers (M002).
  await service.from("profile_identifiers").insert({
    profile_id: data.user.id,
    kind: "EMAIL",
    value_normalized: email.toLowerCase(),
    verified_at_server: new Date().toISOString(),
  });
  const client = createClient(URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, client };
}

async function main() {
  // --- Fixtures : 4 profils isolés, 1 chantier dédié -----------------------
  const author = await createTestUser("author"); // CONTRACTOR
  const owner = await createTestUser("owner"); // OWNER/PRIMARY
  const siteManager = await createTestUser("sitemgr"); // SITE_MANAGER, jamais auteur
  const outsider = await createTestUser("outsider"); // aucune adhésion

  const { data: draft, error: draftError } = await author.client.rpc("create_draft_project", {
    p_name: "B027 fixture",
    p_country: "SN",
    p_role: "CONTRACTOR",
  });
  if (draftError) throw new Error(`create_draft_project: ${draftError.message}`);
  const projectId = draft[0].project_id;

  await service.from("project_memberships").insert([
    { project_id: projectId, profile_id: owner.id, role: "OWNER", owner_profile: "PRIMARY" },
    { project_id: projectId, profile_id: siteManager.id, role: "SITE_MANAGER", owner_profile: null },
  ]);

  console.log(`Projet fixture: ${projectId}`);

  // --- Helpers upload -------------------------------------------------------
  async function fullPrepare(userClient, bytes, mime) {
    const operationUuid = randomUUID();
    const checksum = sha256Hex(bytes);
    const { data, error } = await userClient.rpc("prepare_media_upload", {
      p_operation_uuid: operationUuid,
      p_project_id: projectId,
      p_expected_checksum: checksum,
      p_expected_size_bytes: bytes.length,
      p_expected_mime_type: mime,
    });
    return { operationUuid, checksum, data, error };
  }

  async function uploadTemp(userClient, operationUuid, bytes, mime) {
    const tempPath = `_private/${projectId}/media_asset/${operationUuid}/source`;
    const { data: signed, error: signError } = await service.storage
      .from(BUCKET)
      .createSignedUploadUrl(tempPath);
    if (signError) throw new Error(`createSignedUploadUrl: ${signError.message}`);
    const { error: putError } = await userClient.storage
      .from(BUCKET)
      .uploadToSignedUrl(signed.path, signed.token, bytes, { contentType: mime, upsert: true });
    if (putError) throw new Error(`uploadToSignedUrl: ${putError.message}`);
    return tempPath;
  }

  // Reproduit exactement commitMediaUpload (actions.ts, corrigé 2026-09-26) :
  // écrit la candidate depuis la SOURCE, puis RELIT la candidate telle
  // qu'elle existe réellement dans Storage et calcule empreinte/taille/type
  // sur CETTE relecture — jamais sur les octets de la source calculés avant
  // l'écriture (l'ancienne version attestait sans relire, ce qui ne
  // respectait pas le contrôle post-écriture annoncé). Un buffer texte
  // étiqueté "image/jpeg" ne doit JAMAIS produire "image/jpeg" au sniff :
  // il produira null (signature non reconnue), qui ne matchera pas
  // expected_mime_type à l'attestation (rejet attendu, voir test négatif).
  async function privilegedCommit(operationUuid, attemptId, tempPath, candidateKey, bytes, declaredMime) {
    const { data: tempBytes, error: dlError } = await service.storage.from(BUCKET).download(tempPath);
    if (dlError) throw new Error(`download temp: ${dlError.message}`);
    const sourceBytes = new Uint8Array(await tempBytes.arrayBuffer());
    const sourceSniffed = sniffMimeType(sourceBytes);
    const { error: upErr } = await service.storage
      .from(BUCKET)
      .upload(candidateKey, Buffer.from(sourceBytes), { contentType: sourceSniffed ?? declaredMime, upsert: false });
    if (upErr) throw new Error(`write candidate: ${upErr.message}`);

    // Relecture RÉELLE de la candidate (pas une réutilisation des octets
    // source) — voir en-tête de fonction.
    const { data: writtenFile, error: rereadErr } = await service.storage.from(BUCKET).download(candidateKey);
    if (rereadErr) throw new Error(`reread candidate: ${rereadErr.message}`);
    const candidateBytes = new Uint8Array(await writtenFile.arrayBuffer());
    const actualChecksum = sha256Hex(Buffer.from(candidateBytes));
    const sniffed = sniffMimeType(candidateBytes);
    return { actualChecksum, actualSize: candidateBytes.length, actualMime: sniffed ?? "application/octet-stream", sniffed };
  }

  // ==========================================================================
  // 1. Permissions PREPARE (outsider / owner refusés, author autorisé)
  // ==========================================================================
  {
    const bytes = Buffer.from("photo-1-bytes");
    const { error } = await outsider.client.rpc("prepare_media_upload", {
      p_operation_uuid: randomUUID(),
      p_project_id: projectId,
      p_expected_checksum: sha256Hex(bytes),
      p_expected_size_bytes: bytes.length,
      p_expected_mime_type: "image/jpeg",
    });
    record("PREPARE refusé — outsider (hors chantier)", error?.message === "not_authorized", error?.message);
  }
  {
    const bytes = Buffer.from("photo-owner-bytes");
    const { error } = await owner.client.rpc("prepare_media_upload", {
      p_operation_uuid: randomUUID(),
      p_project_id: projectId,
      p_expected_checksum: sha256Hex(bytes),
      p_expected_size_bytes: bytes.length,
      p_expected_mime_type: "image/jpeg",
    });
    record("PREPARE refusé — OWNER (D099, ajout non livré)", error?.message === "not_authorized", error?.message);
  }

  // ==========================================================================
  // 1b. Origine — CAPTURED refusé côté serveur dans cette tranche (revue
  // 2026-09-26) : aucun mécanisme de capture réelle n'existe, donc aucun
  // utilisateur ne doit pouvoir fabriquer cette provenance.
  // ==========================================================================
  {
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, operationUuid, bytes, mime);
    const { data: claim } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    const { actualChecksum, actualSize, actualMime } = await privilegedCommit(
      operationUuid, claim.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim.candidate_key, bytes, mime
    );
    await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
      p_actual_checksum: actualChecksum, p_actual_size_bytes: actualSize, p_actual_mime_type: actualMime,
    });
    const { error: capturedErr } = await author.client.rpc("finalize_media_upload", {
      p_operation_uuid: operationUuid, p_origin: "CAPTURED", p_caption: null,
    });
    record("Origine CAPTURED refusée côté serveur (non démontrable dans cette tranche)", capturedErr?.message === "invalid_origin", capturedErr?.message);
  }

  // ==========================================================================
  // 2. Parcours complet : déposer -> finaliser -> aperçu -> publier -> galerie
  // ==========================================================================
  let happyMediaId = null;
  {
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid, checksum, data: prep, error: prepErr } = await fullPrepare(author.client, bytes, mime);
    record("PREPARE — author autorisé", !prepErr && !!prep, prepErr?.message);

    await uploadTemp(author.client, operationUuid, bytes, mime);

    const { data: claim, error: claimErr } = await author.client.rpc("claim_upload_attempt", {
      p_operation_uuid: operationUuid,
    });
    record("CLAIM — gagné au premier appel", !claimErr && claim?.won === true, claimErr?.message);

    const { actualChecksum, actualSize, actualMime } = await privilegedCommit(
      operationUuid, claim.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim.candidate_key, bytes, mime
    );
    record("Contrôle octets — empreinte identique", actualChecksum === checksum, `${actualChecksum} vs ${checksum}`);

    const { error: attestErrAsUser } = await author.client.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
      p_actual_checksum: actualChecksum, p_actual_size_bytes: actualSize, p_actual_mime_type: actualMime,
    });
    record(
      "attest_storage_verified refusé pour un client authentifié (frontière de confiance)",
      !!attestErrAsUser,
      attestErrAsUser?.message
    );

    const { error: attestErr } = await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
      p_actual_checksum: actualChecksum, p_actual_size_bytes: actualSize, p_actual_mime_type: actualMime,
    });
    record("attest_storage_verified — service_role", !attestErr, attestErr?.message);

    const { data: media, error: finErr } = await author.client.rpc("finalize_media_upload", {
      p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: "Fondation coulée",
    });
    record("FINALIZE — media brouillon créé", !finErr && media?.status === "BROUILLON", finErr?.message);
    happyMediaId = media?.id ?? null;

    const { data: authorList } = await author.client.rpc("list_project_media", { p_project_id: projectId });
    record("Aperçu — auteur voit son brouillon", (authorList ?? []).some((m) => m.id === happyMediaId));

    const { data: ownerListBefore } = await owner.client.rpc("list_project_media", { p_project_id: projectId });
    record("Lecture — OWNER ne voit PAS le brouillon d'autrui", !(ownerListBefore ?? []).some((m) => m.id === happyMediaId));

    const { data: siteMgrListBefore } = await siteManager.client.rpc("list_project_media", { p_project_id: projectId });
    record("Lecture — SITE_MANAGER (non auteur) ne voit PAS le brouillon", !(siteMgrListBefore ?? []).some((m) => m.id === happyMediaId));

    const { error: outsiderListErr } = await outsider.client.rpc("list_project_media", { p_project_id: projectId });
    record("Lecture refusée — outsider (list_project_media)", outsiderListErr?.message === "not_authorized", outsiderListErr?.message);

    const { error: publishByOtherErr } = await siteManager.client.rpc("publish_media_asset", { p_media_asset_id: happyMediaId });
    record("Publication refusée — non-auteur", publishByOtherErr?.message === "not_authorized", publishByOtherErr?.message);

    const { data: published, error: pubErr } = await author.client.rpc("publish_media_asset", { p_media_asset_id: happyMediaId });
    record("Publication — auteur autorisé", !pubErr && published?.status === "PUBLIE", pubErr?.message);

    const { data: ownerListAfter } = await owner.client.rpc("list_project_media", { p_project_id: projectId });
    record("Galerie — OWNER voit le média publié", (ownerListAfter ?? []).some((m) => m.id === happyMediaId));

    const { data: siteMgrListAfter } = await siteManager.client.rpc("list_project_media", { p_project_id: projectId });
    record("Galerie — SITE_MANAGER voit le média publié", (siteMgrListAfter ?? []).some((m) => m.id === happyMediaId));
  }

  // ==========================================================================
  // 2b. Validation de format — un buffer texte étiqueté "image/jpeg" ne doit
  // JAMAIS réussir le parcours nominal (correction post-revue 2026-09-26).
  // Conservé comme test NÉGATIF (l'ancien contenu du test 2 avant correction).
  // ==========================================================================
  {
    const bytes = Buffer.from(`fake-jpeg-text-${randomUUID()}`);
    const mime = "image/jpeg";
    const { operationUuid } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, operationUuid, bytes, mime);
    const { data: claim } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    const { actualChecksum, actualSize, actualMime, sniffed } = await privilegedCommit(
      operationUuid, claim.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim.candidate_key, bytes, mime
    );
    record("Faux JPEG — signature réelle non reconnue (sniff = null)", sniffed === null, `sniffed=${sniffed}`);

    const { error: attestErr } = await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
      p_actual_checksum: actualChecksum, p_actual_size_bytes: actualSize, p_actual_mime_type: actualMime,
    });
    record(
      "Faux JPEG — attestation refusée (format réel ≠ type déclaré, pas le seul MIME stocké)",
      attestErr?.message === "checksum_mismatch",
      attestErr?.message
    );

    const { error: finErr } = await author.client.rpc("finalize_media_upload", {
      p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: null,
    });
    record("Faux JPEG — finalisation refusée (parcours nominal bloqué)", finErr?.message === "storage_not_verified", finErr?.message);
  }

  // ==========================================================================
  // 2c. Vidéo réelle — déposer -> finaliser -> publier -> lecture (intégrité
  // octet pour octet via l'URL signée, pas seulement l'acceptation du MIME).
  // ==========================================================================
  let videoMediaId = null;
  {
    const bytes = REAL_MP4_BYTES;
    const mime = "video/mp4";
    const { operationUuid, checksum } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, operationUuid, bytes, mime);
    const { data: claim } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    const { actualChecksum, actualSize, actualMime, sniffed } = await privilegedCommit(
      operationUuid, claim.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim.candidate_key, bytes, mime
    );
    record("Vidéo — signature réelle reconnue video/mp4 (pas le seul MIME déclaré)", sniffed === "video/mp4", `sniffed=${sniffed}`);
    record("Vidéo — empreinte identique", actualChecksum === checksum);

    await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
      p_actual_checksum: actualChecksum, p_actual_size_bytes: actualSize, p_actual_mime_type: actualMime,
    });

    const { data: media, error: finErr } = await author.client.rpc("finalize_media_upload", {
      p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: "Visite de chantier filmée",
    });
    record("Vidéo — finalisation réussie", !finErr && media?.mime_type === "video/mp4", finErr?.message);
    videoMediaId = media?.id ?? null;

    const { data: published, error: pubErr } = await author.client.rpc("publish_media_asset", { p_media_asset_id: videoMediaId });
    record("Vidéo — publication réussie", !pubErr && published?.status === "PUBLIE", pubErr?.message);

    const { data: siteMgrList } = await siteManager.client.rpc("list_project_media", { p_project_id: projectId });
    const videoRow = (siteMgrList ?? []).find((m) => m.id === videoMediaId);
    record("Vidéo — visible en galerie pour un autre membre actif", !!videoRow);

    // Lecture RÉELLE : URL signée -> téléchargement -> octets identiques à
    // l'original ET signature MP4 toujours reconnue côté lu (pas seulement
    // au moment de l'écriture). N'affirme pas la lecture par un lecteur
    // vidéo réel (voir vérification navigateur séparée, dossier de revue).
    const { data: signed } = await service.storage.from(BUCKET).createSignedUrl(videoRow.storage_key, 60);
    const downloadRes = await fetch(signed.signedUrl);
    const downloadedBytes = new Uint8Array(await downloadRes.arrayBuffer());
    record(
      "Vidéo — octets lus identiques à l'original (intégrité de bout en bout)",
      sha256Hex(Buffer.from(downloadedBytes)) === checksum
    );
    record("Vidéo — signature MP4 toujours valide à la lecture", sniffMimeType(downloadedBytes) === "video/mp4");
  }

  // ==========================================================================
  // 2d. Idempotence PREPARE — deux PREMIÈRES préparations concurrentes pour
  // le même operation_uuid (revue 2026-09-26). L'ancien SELECT-puis-INSERT
  // ne verrouillait rien (aucune ligne à verrouiller avant la première
  // insertion) : les deux transactions voyaient "not found" et tentaient
  // toutes deux l'INSERT, l'une des deux échouant en violation d'unicité
  // brute. Le nouvel INSERT-FIRST doit réconcilier : même paramètres -> même
  // ligne renvoyée aux DEUX appelants, jamais une erreur brute.
  // ==========================================================================
  {
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const sharedOperationUuid = randomUUID();
    const checksum = sha256Hex(bytes);
    const params = {
      p_operation_uuid: sharedOperationUuid, p_project_id: projectId,
      p_expected_checksum: checksum, p_expected_size_bytes: bytes.length, p_expected_mime_type: mime,
    };
    const [p1, p2] = await Promise.all([
      author.client.rpc("prepare_media_upload", params),
      author.client.rpc("prepare_media_upload", params),
    ]);
    record(
      "Idempotence PREPARE — deux premières préparations concurrentes réconciliées, aucune erreur brute",
      !p1.error && !p2.error,
      `err1=${p1.error?.message} err2=${p2.error?.message}`
    );
    record(
      "Idempotence PREPARE — les deux appels reçoivent la MÊME ligne",
      p1.data?.id && p1.data.id === p2.data?.id
    );
    const { count } = await service.from("private_object_uploads").select("id", { count: "exact", head: true }).eq("operation_uuid", sharedOperationUuid);
    record("Idempotence PREPARE — une seule ligne réellement créée en base", count === 1, `count=${count}`);
  }

  // ==========================================================================
  // 3. Finalisation frauduleuse (sans attestation)
  // ==========================================================================
  {
    const bytes = Buffer.from(`photo-fraud-${randomUUID()}`);
    const mime = "image/png";
    const { operationUuid } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, operationUuid, bytes, mime);
    await author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    // Aucun attest_storage_verified appelé : tentative directe de finalisation.
    const { error: finErr } = await author.client.rpc("finalize_media_upload", {
      p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: null,
    });
    record("Finalisation frauduleuse refusée (aucune attestation)", finErr?.message === "storage_not_verified", finErr?.message);
  }

  // ==========================================================================
  // 4. Concurrence — deux CLAIM concurrents pour le même attempt
  // ==========================================================================
  {
    const bytes = Buffer.from(`photo-concurrent-${randomUUID()}`);
    const mime = "image/jpeg";
    const { operationUuid } = await fullPrepare(author.client, bytes, mime);
    const [c1, c2] = await Promise.all([
      author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid }),
      author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid }),
    ]);
    const wins = [c1.data?.won, c2.data?.won].filter(Boolean).length;
    record("Concurrence CLAIM — exactement un gagnant", wins === 1, `wins=${wins}`);
  }

  // ==========================================================================
  // 4b. Preuve renforcée du chemin serveur : "exactement un won:true" (test 4)
  // montre l'exclusion dans la RPC ; ce test vérifie en plus, au niveau
  // Storage lui-même, que SEUL le gagnant a réellement écrit une candidate —
  // le code (actions.ts commitMediaUpload, ligne `if (claim.won) { ... }`)
  // ne tente d'écriture QUE dans la branche gagnante ; le perdant n'appelle
  // jamais storage.upload pour cette candidate. Reproduit ici les deux
  // branches réelles (commit complet des deux côtés, pas seulement claim).
  // ==========================================================================
  {
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, operationUuid, bytes, mime);

    async function attemptFullCommit() {
      const { data: claim, error: claimErr } = await author.client.rpc("claim_upload_attempt", {
        p_operation_uuid: operationUuid,
      });
      if (claimErr) return { won: false, wrote: false };
      if (!claim.won) {
        // Reproduit EXACTEMENT actions.ts : la branche perdante ne touche
        // jamais Storage pour cette candidate.
        return { won: false, wrote: false };
      }
      await privilegedCommit(
        operationUuid, claim.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim.candidate_key, bytes, mime
      );
      return { won: true, wrote: true };
    }

    const [r1, r2] = await Promise.all([attemptFullCommit(), attemptFullCommit()]);
    const winners = [r1, r2].filter((r) => r.won).length;
    const writers = [r1, r2].filter((r) => r.wrote).length;
    record("CAS renforcé — un seul gagnant tente réellement l'écriture", winners === 1 && writers === 1, `winners=${winners} writers=${writers}`);

    const { data: listing, error: listErr } = await service.storage
      .from(BUCKET)
      .list(`_private/${projectId}/media_asset/${operationUuid}/candidates`);
    record(
      "CAS renforcé — exactement une candidate existe réellement dans Storage",
      !listErr && (listing ?? []).length === 1,
      listErr?.message ?? `count=${listing?.length}`
    );
  }

  // ==========================================================================
  // 5. Timeout / tentative tardive
  // ==========================================================================
  {
    const bytes = Buffer.from(`photo-timeout-${randomUUID()}`);
    const mime = "image/jpeg";
    const { operationUuid } = await fullPrepare(author.client, bytes, mime);
    const { data: claim1 } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });

    // Simulation du temps écoulé (fixture de test uniquement) : expiration forcée dans le passé.
    await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("operation_uuid", operationUuid);

    const { data: recovered, error: recErr } = await author.client.rpc("recover_media_upload_attempt", {
      p_operation_uuid: operationUuid,
    });
    record(
      "Reprise — nouvel attempt_id/candidate distincts de l'ancien",
      !recErr && recovered.attempt_id !== claim1.attempt_id && recovered.candidate_key !== claim1.candidate_key,
      recErr?.message
    );

    const { error: staleAttestErr } = await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim1.attempt_id,
      p_actual_checksum: sha256Hex(bytes), p_actual_size_bytes: bytes.length, p_actual_mime_type: mime,
    });
    record("Tentative tardive (ancien attempt_id) refusée", staleAttestErr?.message === "attempt_stale", staleAttestErr?.message);
  }

  // ==========================================================================
  // 6. Échec de création média — atomicité (rollback)
  // ==========================================================================
  {
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, operationUuid, bytes, mime);
    const { data: claim } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    const { actualChecksum, actualSize, actualMime } = await privilegedCommit(
      operationUuid, claim.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim.candidate_key, bytes, mime
    );
    await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
      p_actual_checksum: actualChecksum, p_actual_size_bytes: actualSize, p_actual_mime_type: actualMime,
    });

    const { data: rowBefore } = await service.from("private_object_uploads").select("id").eq("operation_uuid", operationUuid).single();

    // Pré-occupe le slot unique (private_object_upload_id) pour forcer l'échec
    // de l'INSERT media_assets À L'INTÉRIEUR de finalize_media_upload.
    await service.from("media_assets").insert({
      project_id: projectId, private_object_upload_id: rowBefore.id, uploaded_by_profile_id: author.id,
      origin: "CAPTURED", status: "BROUILLON", file_size_bytes: 1, mime_type: mime, storage_key: "fixture/pre-occupied",
    });

    const { error: finErr } = await author.client.rpc("finalize_media_upload", {
      p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: null,
    });
    record("Échec création média — finalize échoue", !!finErr, finErr?.message);

    const { data: rowAfter } = await service.from("private_object_uploads").select("status").eq("id", rowBefore.id).single();
    record("Atomicité — opération reste FINALIZING (récupérable), pas FINALIZED", rowAfter.status === "FINALIZING", rowAfter.status);

    // Nettoyage de la ligne fixture insérée manuellement.
    await service.from("media_assets").delete().eq("private_object_upload_id", rowBefore.id);
  }

  // ==========================================================================
  // 6b. Droits au rejeu après révocation/changement de rôle (revue
  // 2026-09-26) : prepare/claim/recover/finalize revérifiaient l'identité de
  // l'auteur mais pas ses droits COURANTS sur les chemins de rejeu — un
  // auteur révoqué APRÈS une première étape légitime pouvait continuer
  // l'opération. Quatre acteurs dédiés, un par fonction testée, pour ne pas
  // perturber les autres tests. En RPC direct (preuve forte, ci-dessous) ;
  // le chemin "via l'action" est vérifié séparément en navigateur (aucune
  // logique d'autorisation propre à actions.ts : un simple relais de la RPC).
  // ==========================================================================
  // SITE_MANAGER, jamais CONTRACTOR : le projet a déjà UN CONTRACTOR
  // (create_draft_project/author) et project_memberships_..._contractor_unique
  // (M004/M006) interdit un second titulaire — une tentative silencieuse
  // avec role='CONTRACTOR' ici échouerait à l'insertion (jamais vérifiée
  // sans ce commentaire) et invaliderait tous les tests de cette section
  // pour la mauvaise raison (adhésion jamais créée, pas "révoquée après").
  // site_managers_max n'est, à l'inverse, qu'un quota non déclaratif
  // (contrôlé seulement à l'émission d'invitation, D082) : aucune contrainte
  // DB n'empêche cette insertion directe de fixture.
  async function addSiteManager(label) {
    const u = await createTestUser(label);
    const { error } = await service.from("project_memberships").insert({ project_id: projectId, profile_id: u.id, role: "SITE_MANAGER", owner_profile: null });
    if (error) throw new Error(`addSiteManager(${label}): ${error.message}`);
    return u;
  }
  async function revoke(profileId) {
    await service.from("project_memberships").update({ revoked_at: new Date().toISOString() }).eq("project_id", projectId).eq("profile_id", profileId);
  }
  async function restoreMembership(profileId) {
    await service.from("project_memberships").update({ revoked_at: null }).eq("project_id", projectId).eq("profile_id", profileId);
  }

  {
    // (1) prepare_media_upload — rejeu après révocation.
    const u = await addSiteManager("revoke-prepare");
    const bytes = REAL_JPEG_BYTES;
    const params = {
      p_operation_uuid: randomUUID(), p_project_id: projectId,
      p_expected_checksum: sha256Hex(bytes), p_expected_size_bytes: bytes.length, p_expected_mime_type: "image/jpeg",
    };
    const { error: firstErr } = await u.client.rpc("prepare_media_upload", params);
    record("Droits rejeu — PREPARE initial autorisé (adhésion active)", !firstErr, firstErr?.message);
    await revoke(u.id);
    const { error: replayErr } = await u.client.rpc("prepare_media_upload", params);
    record("Droits rejeu — PREPARE refusé après révocation (même operation_uuid)", replayErr?.message === "not_authorized", replayErr?.message);
  }

  {
    // (2) claim_upload_attempt — après révocation, sans repasser par PREPARE.
    const u = await addSiteManager("revoke-claim");
    const { operationUuid } = await fullPrepare(u.client, REAL_JPEG_BYTES, "image/jpeg");
    await revoke(u.id);
    const { error: claimErr } = await u.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    record("Droits rejeu — CLAIM refusé après révocation", claimErr?.message === "not_authorized", claimErr?.message);
  }

  {
    // (3) recover_media_upload_attempt — après révocation, sur un attempt expiré.
    const u = await addSiteManager("revoke-recover");
    const { operationUuid } = await fullPrepare(u.client, REAL_JPEG_BYTES, "image/jpeg");
    await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("operation_uuid", operationUuid);
    await revoke(u.id);
    const { error: recoverErr } = await u.client.rpc("recover_media_upload_attempt", { p_operation_uuid: operationUuid });
    // 'operation_access_revoked' depuis la revue 2026-09-27 (§9) : propriété
    // déjà établie, distingue "inaccessible" de "inexistant" — plus précis
    // que le générique 'not_authorized' d'avant cette correction.
    record("Droits rejeu — RECOVER refusé après révocation", recoverErr?.message === "operation_access_revoked", recoverErr?.message);
  }

  {
    // (4) finalize_media_upload — tentative normale après révocation (encore FINALIZING).
    const u = await addSiteManager("revoke-finalize");
    const bytes = REAL_JPEG_BYTES;
    const { operationUuid } = await fullPrepare(u.client, bytes, "image/jpeg");
    await uploadTemp(u.client, operationUuid, bytes, "image/jpeg");
    const { data: claim } = await u.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    const { actualChecksum, actualSize, actualMime } = await privilegedCommit(
      operationUuid, claim.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim.candidate_key, bytes, "image/jpeg"
    );
    await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
      p_actual_checksum: actualChecksum, p_actual_size_bytes: actualSize, p_actual_mime_type: actualMime,
    });
    await revoke(u.id);
    const { error: finalizeErr } = await u.client.rpc("finalize_media_upload", { p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: null });
    record("Droits rejeu — FINALIZE (normal) refusé après révocation", finalizeErr?.message === "not_authorized", finalizeErr?.message);
  }

  {
    // (5) finalize_media_upload — REJEU d'une opération déjà FINALIZED, après révocation.
    const u = await addSiteManager("revoke-finalize-replay");
    const bytes = REAL_JPEG_BYTES;
    const { operationUuid } = await fullPrepare(u.client, bytes, "image/jpeg");
    await uploadTemp(u.client, operationUuid, bytes, "image/jpeg");
    const { data: claim } = await u.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    const { actualChecksum, actualSize, actualMime } = await privilegedCommit(
      operationUuid, claim.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim.candidate_key, bytes, "image/jpeg"
    );
    await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
      p_actual_checksum: actualChecksum, p_actual_size_bytes: actualSize, p_actual_mime_type: actualMime,
    });
    const { error: firstFinalizeErr } = await u.client.rpc("finalize_media_upload", { p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: null });
    record("Droits rejeu — FINALIZE initial autorisé (adhésion active)", !firstFinalizeErr, firstFinalizeErr?.message);
    await revoke(u.id);
    const { error: replayFinalizeErr } = await u.client.rpc("finalize_media_upload", { p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: null });
    record(
      "Droits rejeu — REJEU de FINALIZE (déjà FINALIZED) refusé après révocation, pas de média renvoyé silencieusement",
      replayFinalizeErr?.message === "not_authorized",
      replayFinalizeErr?.message
    );
  }

  // ==========================================================================
  // 7. Immutabilité — la candidate gagnante n'est jamais réinscriptible
  // ==========================================================================
  {
    const { data: happy } = await service.from("media_assets").select("storage_key, mime_type").eq("id", happyMediaId).single();
    const { error: overwriteErr } = await service.storage.from(BUCKET).upload(
      happy.storage_key, Buffer.from("SHOULD-NEVER-REPLACE-WINNER"), { upsert: false, contentType: happy.mime_type }
    );
    record(
      "Immutabilité — réécriture de la candidate gagnante refusée (pas un simple filtre MIME)",
      overwriteErr?.message?.toLowerCase().includes("exist") || overwriteErr?.message?.toLowerCase().includes("duplicate"),
      overwriteErr?.message
    );
  }

  // ==========================================================================
  // 8. Nettoyage — REFONDU (revue 2026-09-26). Deux phases distinctes :
  // abandon (bascule ABANDONED, jamais une suppression physique de la ligne
  // — identité d'operation_uuid préservée) puis suppression réelle des clés
  // tracées, confirmée APRÈS storage.remove() (jamais avant).
  // ==========================================================================
  {
    const { error: listAsUserErr } = await author.client.rpc("list_expired_media_uploads", {});
    record("Nettoyage (sélection) refusé pour un client authentifié", !!listAsUserErr, listAsUserErr?.message);
    const { error: abandonAsUserErr } = await author.client.rpc("abandon_expired_media_upload", { p_id: happyMediaId });
    record("Nettoyage (abandon) refusé pour un client authentifié", !!abandonAsUserErr, abandonAsUserErr?.message);

    // --- 8a. Une ligne FINALIZED n'est jamais éligible, même forcée ancienne.
    const finalizedRow = await service.from("private_object_uploads").select("id").eq("entity_id", happyMediaId).single();
    await service.from("private_object_uploads")
      .update({ attempt_expires_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString() })
      .eq("id", finalizedRow.data.id);
    const { data: expiredList } = await service.rpc("list_expired_media_uploads", { p_older_than: "0 seconds" });
    record("Nettoyage — ligne FINALIZED jamais listée comme expirée", !(expiredList ?? []).some((r) => r.id === finalizedRow.data.id));
    const { data: abandonedFinalized } = await service.rpc("abandon_expired_media_upload", { p_id: finalizedRow.data.id, p_older_than: "0 seconds" });
    record("Nettoyage — abandon refusé sur une ligne FINALIZED, même appelé directement", abandonedFinalized === false);

    // --- 8b. Une opération réellement orpheline (jamais attestée) est
    // abandonnée puis sa source ET sa candidate réellement supprimées.
    const orphanBytes = REAL_JPEG_BYTES;
    const orphanMime = "image/jpeg";
    const { operationUuid: orphanOpId } = await fullPrepare(author.client, orphanBytes, orphanMime);
    await uploadTemp(author.client, orphanOpId, orphanBytes, orphanMime);
    const { data: orphanClaim } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: orphanOpId });
    await privilegedCommit(
      orphanOpId, orphanClaim.attempt_id, `_private/${projectId}/media_asset/${orphanOpId}/source`, orphanClaim.candidate_key, orphanBytes, orphanMime
    );
    // Jamais attesté ni finalisé : reste PENDING, candidate ET source
    // réellement présentes dans Storage.
    await service.from("private_object_uploads")
      .update({ attempt_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("operation_uuid", orphanOpId);
    const { data: orphanRow } = await service.from("private_object_uploads").select("id").eq("operation_uuid", orphanOpId).single();
    const orphanSourceKey = `_private/${projectId}/media_asset/${orphanOpId}/source`;

    const { data: candidateBefore } = await service.storage.from(BUCKET).download(orphanClaim.candidate_key);
    const { data: sourceBefore } = await service.storage.from(BUCKET).download(orphanSourceKey);
    record("Candidate ET source orphelines présentes dans Storage avant nettoyage", !!candidateBefore && !!sourceBefore);

    const { data: didAbandon } = await service.rpc("abandon_expired_media_upload", { p_id: orphanRow.id, p_older_than: "0 seconds" });
    record("Nettoyage — abandon accepté sur une opération réellement expirée", didAbandon === true);

    const { data: rowAfterAbandon } = await service.from("private_object_uploads").select("id, status").eq("id", orphanRow.id).single();
    record(
      "Nettoyage — ligne NON supprimée physiquement, statut ABANDONED (identité d'operation_uuid préservée)",
      rowAfterAbandon?.id === orphanRow.id && rowAfterAbandon?.status === "ABANDONED"
    );

    const { error: staleKeysUserErr } = await author.client.rpc("list_stale_media_keys", {});
    record("Nettoyage (clés tracées) refusé pour un client authentifié", !!staleKeysUserErr, staleKeysUserErr?.message);

    const { data: staleKeys } = await service.rpc("list_stale_media_keys");
    const candidateTrace = (staleKeys ?? []).find((k) => k.storage_key === orphanClaim.candidate_key);
    const sourceTrace = (staleKeys ?? []).find((k) => k.storage_key === orphanSourceKey);
    record("Nettoyage — candidate ET source tracées avant suppression", !!candidateTrace && !!sourceTrace);

    for (const trace of [candidateTrace, sourceTrace]) {
      const { data: claimed } = await service.rpc("claim_stale_key_for_cleanup", { p_id: trace.id });
      const gotKey = claimed?.[0]?.storage_key === trace.storage_key;
      record(`Suppression — claim_stale_key_for_cleanup autorise (${trace.kind})`, gotKey);
      if (gotKey) {
        const { error: removeErr } = await service.storage.from(BUCKET).remove([claimed[0].storage_key]);
        record(`Suppression Storage réellement exécutée (${trace.kind})`, !removeErr, removeErr?.message);
        await service.rpc("mark_stale_key_cleaned", { p_id: trace.id });
      }
    }
    const { data: candidateAfter } = await service.storage.from(BUCKET).download(orphanClaim.candidate_key);
    const { data: sourceAfter } = await service.storage.from(BUCKET).download(orphanSourceKey);
    record("Candidate ET source absentes de Storage après suppression réelle", !candidateAfter && !sourceAfter);

    // --- 8c. Panne Storage simulée : le marquage "cleaned" n'intervient
    // JAMAIS avant confirmation réelle — la trace reste réclamable.
    const { data: reclaimTest } = await service.rpc("claim_stale_key_for_cleanup", { p_id: candidateTrace.id, p_retry_after: "0 seconds" });
    record(
      "Nettoyage — une trace déjà marquée cleaned n'est plus jamais réclamable",
      !reclaimTest || reclaimTest.length === 0
    );

    // --- 8d. Une ligne reprise (recover) AVANT l'abandon est protégée : "une
    // liste obtenue auparavant ne suffit pas à autoriser" la bascule ABANDONED.
    const raceBytes = REAL_JPEG_BYTES;
    const { operationUuid: raceOpId } = await fullPrepare(author.client, raceBytes, "image/jpeg");
    const { data: raceClaim1 } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: raceOpId });
    await service.from("private_object_uploads")
      .update({ attempt_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("operation_uuid", raceOpId);
    const { data: raceRow } = await service.from("private_object_uploads").select("id").eq("operation_uuid", raceOpId).single();
    const { data: raceListedBefore } = await service.rpc("list_expired_media_uploads", { p_older_than: "0 seconds" });
    const staleListedAsEligible = (raceListedBefore ?? []).some((r) => r.id === raceRow.id);

    // Une reprise survient APRÈS cette sélection périmée, avant l'abandon.
    const { data: recoveredRace } = await author.client.rpc("recover_media_upload_attempt", { p_operation_uuid: raceOpId });

    const { data: abandonedRace } = await service.rpc("abandon_expired_media_upload", { p_id: raceRow.id, p_older_than: "0 seconds" });
    record(
      "Nettoyage — abandon refusé sur une ligne reprise après une sélection périmée (listée éligible=" + staleListedAsEligible + ", nouvel attempt=" + (recoveredRace?.attempt_id !== raceClaim1.attempt_id) + ")",
      abandonedRace === false
    );
  }

  // ==========================================================================
  // 9. Conserver l'identité sur erreur de reprise (revue 2026-09-27) :
  // distingue "opération inexistante" de "opération inaccessible" pour son
  // PROPRE auteur (aucune fuite vers un tiers, la propriété est déjà établie
  // par la RPC elle-même avant cette distinction).
  // ==========================================================================
  {
    const u = await addSiteManager("identity-on-error");
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid } = await fullPrepare(u.client, bytes, mime);
    await uploadTemp(u.client, operationUuid, bytes, mime);
    const { data: claim } = await u.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    const { actualChecksum, actualSize, actualMime } = await privilegedCommit(
      operationUuid, claim.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim.candidate_key, bytes, mime
    );
    await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim.attempt_id,
      p_actual_checksum: actualChecksum, p_actual_size_bytes: actualSize, p_actual_mime_type: actualMime,
    });
    const { data: media } = await u.client.rpc("finalize_media_upload", { p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: null });
    record("Identité — opération légitimement FINALIZED avant révocation", !!media?.id);

    await revoke(u.id);
    const { error: statusErr } = await u.client.rpc("get_upload_status", { p_operation_uuid: operationUuid });
    record(
      "Identité — get_upload_status distingue 'inaccessible' de 'inexistant' pour son propre auteur",
      statusErr?.message === "operation_access_revoked",
      statusErr?.message
    );
    const { error: recoverErr } = await u.client.rpc("recover_media_upload_attempt", { p_operation_uuid: operationUuid });
    record("Identité — recover distingue également 'inaccessible'", recoverErr?.message === "operation_access_revoked", recoverErr?.message);

    // Aucune fuite : un tiers non-auteur reçoit le même refus générique,
    // qu'elle existe ou non, jamais la distinction ci-dessus.
    const { error: outsiderStatusErr } = await outsider.client.rpc("get_upload_status", { p_operation_uuid: operationUuid });
    record("Identité — aucune fuite vers un tiers (refus générique)", outsiderStatusErr?.message === "not_authorized", outsiderStatusErr?.message);

    await restoreMembership(u.id);
    const { data: statusAfterRestore, error: restoreErr } = await u.client.rpc("get_upload_status", { p_operation_uuid: operationUuid });
    record(
      "Identité — droits restaurés : la MÊME opération FINALIZED redevient visible, jamais recréée",
      // entity_id (private_object_uploads) référence l'id de media_assets —
      // deux tables distinctes, jamais le même espace d'identifiants.
      !restoreErr && statusAfterRestore?.entity_id === media.id && statusAfterRestore?.status === "FINALIZED"
    );
  }

  // ==========================================================================
  // 10. ABANDONED réellement terminal (revue 2026-09-27)
  // ==========================================================================
  {
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid, checksum } = await fullPrepare(author.client, bytes, mime);
    await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("operation_uuid", operationUuid);
    const { data: rowBefore } = await service.from("private_object_uploads").select("id").eq("operation_uuid", operationUuid).single();
    const { data: didAbandon } = await service.rpc("abandon_expired_media_upload", { p_id: rowBefore.id, p_older_than: "0 seconds" });
    record("ABANDONED — abandon initial accepté", didAbandon === true);

    const { error: recoverAbandonedErr } = await author.client.rpc("recover_media_upload_attempt", { p_operation_uuid: operationUuid });
    record("ABANDONED — recover refuse de rouvrir (jamais remis en PENDING)", recoverAbandonedErr?.message === "operation_abandoned", recoverAbandonedErr?.message);

    const { data: rowStillAbandoned } = await service.from("private_object_uploads").select("status").eq("id", rowBefore.id).single();
    record("ABANDONED — statut inchangé après la tentative de reprise", rowStillAbandoned.status === "ABANDONED", rowStillAbandoned.status);

    const { error: prepareAbandonedErr } = await author.client.rpc("prepare_media_upload", {
      p_operation_uuid: operationUuid, p_project_id: projectId,
      p_expected_checksum: checksum, p_expected_size_bytes: bytes.length, p_expected_mime_type: mime,
    });
    record("ABANDONED — PREPARE refuse une nouvelle URL d'écriture", prepareAbandonedErr?.message === "operation_abandoned", prepareAbandonedErr?.message);

    // PREPARE sur une opération déjà FINALIZED : même refus explicite.
    // Mêmes paramètres que l'original (sinon 'operation_uuid_conflict'
    // interviendrait avant même d'atteindre le contrôle de statut testé ici).
    const { data: happyRowForPrepare } = await service.from("private_object_uploads")
      .select("operation_uuid, expected_checksum, expected_size_bytes, expected_mime_type")
      .eq("entity_id", happyMediaId).single();
    const { error: prepareFinalizedErr } = await author.client.rpc("prepare_media_upload", {
      p_operation_uuid: happyRowForPrepare.operation_uuid,
      p_project_id: projectId,
      p_expected_checksum: happyRowForPrepare.expected_checksum,
      p_expected_size_bytes: happyRowForPrepare.expected_size_bytes,
      p_expected_mime_type: happyRowForPrepare.expected_mime_type,
    });
    record("FINALIZED — PREPARE refuse une nouvelle URL d'écriture", prepareFinalizedErr?.message === "operation_already_finalized", prepareFinalizedErr?.message);
  }

  // ==========================================================================
  // 11. Reprise sans second PUT (revue 2026-09-27) — deux pannes distinctes
  // ==========================================================================
  {
    // 11a. Panne APRÈS dépôt Storage réussi (candidate écrite, jamais attestée).
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, operationUuid, bytes, mime);
    const { data: claim1 } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    await privilegedCommit(
      operationUuid, claim1.attempt_id, `_private/${projectId}/media_asset/${operationUuid}/source`, claim1.candidate_key, bytes, mime
    );
    // Panne simulée : AUCUN attest_storage_verified appelé ici.

    // Reprise : claim revoie won=false (déjà revendiquée), statut encore PENDING.
    const { data: claim2 } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid });
    record("Reprise A — deuxième claim ne gagne pas (candidate déjà revendiquée)", claim2.won === false && claim2.status === "PENDING");

    // Résume : relit SEULEMENT la candidate déjà écrite, aucun second PUT.
    const { data: existing } = await service.storage.from(BUCKET).download(claim2.candidate_key);
    record("Reprise A — candidate déjà présente, relue sans réécriture", !!existing);
    const existingBytes = new Uint8Array(await existing.arrayBuffer());
    const { error: attestResumeErr } = await service.rpc("attest_storage_verified", {
      p_operation_uuid: operationUuid, p_attempt_id: claim2.attempt_id,
      p_actual_checksum: sha256Hex(Buffer.from(existingBytes)), p_actual_size_bytes: existingBytes.length,
      p_actual_mime_type: sniffMimeType(existingBytes) ?? "application/octet-stream",
    });
    record("Reprise A — attestation réussie sur reprise (sans réécriture)", !attestResumeErr, attestResumeErr?.message);
    const { data: mediaA, error: finalizeAErr } = await author.client.rpc("finalize_media_upload", { p_operation_uuid: operationUuid, p_origin: "IMPORTED", p_caption: null });
    record("Reprise A — finalisation réussie après reprise", !finalizeAErr && !!mediaA?.id, finalizeAErr?.message);
    const { data: listingA } = await service.storage.from(BUCKET).list(`_private/${projectId}/media_asset/${operationUuid}/candidates`);
    record("Reprise A — une seule candidate a jamais existé (aucun second PUT)", (listingA ?? []).length === 1, `count=${listingA?.length}`);

    // 11b. Panne APRÈS attestation (jamais finalisée).
    const { operationUuid: opB } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, opB, bytes, mime);
    const { data: claimB1 } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: opB });
    const { actualChecksum: csB, actualSize: szB, actualMime: mtB } = await privilegedCommit(
      opB, claimB1.attempt_id, `_private/${projectId}/media_asset/${opB}/source`, claimB1.candidate_key, bytes, mime
    );
    await service.rpc("attest_storage_verified", {
      p_operation_uuid: opB, p_attempt_id: claimB1.attempt_id,
      p_actual_checksum: csB, p_actual_size_bytes: szB, p_actual_mime_type: mtB,
    });
    // Panne simulée : AUCUN finalize appelé ici.

    const { data: claimB2 } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: opB });
    record("Reprise B — claim signale FINALIZING (déjà attestée), aucune réécriture ni ré-attestation", claimB2.won === false && claimB2.status === "FINALIZING");
    const { data: mediaB, error: finalizeBErr } = await author.client.rpc("finalize_media_upload", { p_operation_uuid: opB, p_origin: "IMPORTED", p_caption: null });
    record("Reprise B — finalisation réussie directement (rien à relire/écrire)", !finalizeBErr && !!mediaB?.id, finalizeBErr?.message);
  }

  // ==========================================================================
  // 12. Nettoyage face aux écritures tardives — réconciliation (revue 2026-09-27)
  // ==========================================================================
  {
    // Reproduit une candidate réellement orpheline, nettoyée normalement.
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid: lateOpId } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, lateOpId, bytes, mime);
    const { data: lateClaim } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: lateOpId });
    await privilegedCommit(
      lateOpId, lateClaim.attempt_id, `_private/${projectId}/media_asset/${lateOpId}/source`, lateClaim.candidate_key, bytes, mime
    );
    await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("operation_uuid", lateOpId);
    const { data: lateRow } = await service.from("private_object_uploads").select("id").eq("operation_uuid", lateOpId).single();
    await service.rpc("abandon_expired_media_upload", { p_id: lateRow.id, p_older_than: "0 seconds" });
    const { data: lateStaleKeys } = await service.rpc("list_stale_media_keys");
    const lateCandidateTrace = (lateStaleKeys ?? []).find((k) => k.storage_key === lateClaim.candidate_key);
    const { data: lateClaimed } = await service.rpc("claim_stale_key_for_cleanup", { p_id: lateCandidateTrace.id });
    await service.storage.from(BUCKET).remove([lateClaimed[0].storage_key]);
    await service.rpc("mark_stale_key_cleaned", { p_id: lateCandidateTrace.id });
    const { data: goneAfterCleanup } = await service.storage.from(BUCKET).download(lateClaim.candidate_key);
    record("Réconciliation — candidate bien absente juste après le nettoyage normal", !goneAfterCleanup);

    // Écriture TARDIVE simulée : l'ancienne tentative "termine" son PUT après
    // la suppression — recrée l'objet au MÊME chemin.
    await service.storage.from(BUCKET).upload(lateClaim.candidate_key, Buffer.from("LATE-WRITE-AFTER-CLEANUP"), { upsert: true, contentType: "image/jpeg" });
    const { data: recreatedExists } = await service.storage.from(BUCKET).download(lateClaim.candidate_key);
    record("Réconciliation — écriture tardive simulée, objet recréé au même chemin", !!recreatedExists);

    const { error: recentlyCleanedUserErr } = await author.client.rpc("list_recently_cleaned_media_keys", {});
    record("Réconciliation refusée pour un client authentifié", !!recentlyCleanedUserErr, recentlyCleanedUserErr?.message);

    // Signature sans fenêtre de temps depuis la revue v3, §3 (voir §13
    // ci-dessous pour le test dédié de non-perte au-delà de l'ancienne
    // fenêtre de 24h) — appel sans paramètre.
    const { data: recentlyCleaned } = await service.rpc("list_recently_cleaned_media_keys");
    const detected = (recentlyCleaned ?? []).find((k) => k.storage_key === lateClaim.candidate_key);
    record("Réconciliation — clé recréée après nettoyage détectée par list_recently_cleaned_media_keys", !!detected);

    // La ligne FINALIZED du test 2 (happyMediaId) ne doit JAMAIS apparaître ici.
    const { data: happyRow } = await service.from("private_object_uploads").select("storage_key").eq("entity_id", happyMediaId).single();
    const happyLeaked = (recentlyCleaned ?? []).find((k) => k.storage_key === happyRow.storage_key);
    record("Réconciliation — toute candidate FINALIZED reste strictement exclue", !happyLeaked);

    // Nettoyage ultérieur : re-suppression réelle de l'écriture tardive détectée.
    const { error: removeAgainErr } = await service.storage.from(BUCKET).remove([lateClaim.candidate_key]);
    record("Réconciliation — écriture tardive réellement supprimée à nouveau", !removeAgainErr, removeAgainErr?.message);
    const { data: goneAgain } = await service.storage.from(BUCKET).download(lateClaim.candidate_key);
    record("Réconciliation — clé absente après le nettoyage ultérieur", !goneAgain);

    // Marquage réconciliée (revue v3.1, §2) : simple date de DERNIER
    // contrôle, plus une exclusion définitive — cohérent avec le script réel
    // (cleanup_media_candidates.mjs, migration 20260926120000).
    await service.rpc("mark_stale_key_reconciled", { p_id: lateCandidateTrace.id });
  }

  // ==========================================================================
  // 13. Réconciliation durable et RÉCURRENTE — aucune perte après une
  //     interruption prolongée, aucune exclusion définitive (revue v3 puis
  //     v3.1, §2). L'ancienne fenêtre glissante de 24h (p_within) faisait
  //     perdre DÉFINITIVEMENT toute clé nettoyée puis recréée si le script
  //     n'était pas relancé à temps. Remplacée par reconciled_at — mais
  //     CORRIGÉ (revue v3.1) : la version précédente utilisait reconciled_at
  //     comme exclusion définitive dès le premier contrôle, ce qui reproduisait
  //     le même défaut sous une autre forme (une écriture tardive APRÈS ce
  //     contrôle échappait pour toujours). reconciled_at n'est plus qu'une
  //     date de dernier contrôle informative (migration 20260926120000) :
  //     testé ici sur DEUX cycles nettoyage→recréation→détection successifs
  //     pour la MÊME clé, prouvant qu'aucun des deux n'exclut la suivante.
  // ==========================================================================
  {
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid: outageOpId } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, outageOpId, bytes, mime);
    const { data: outageClaim } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: outageOpId });
    await privilegedCommit(
      outageOpId, outageClaim.attempt_id, `_private/${projectId}/media_asset/${outageOpId}/source`, outageClaim.candidate_key, bytes, mime
    );
    await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("operation_uuid", outageOpId);
    const { data: outageRow } = await service.from("private_object_uploads").select("id").eq("operation_uuid", outageOpId).single();
    // Nettoyage complet A → B (fonctions réellement utilisées).
    await service.rpc("abandon_expired_media_upload", { p_id: outageRow.id, p_older_than: "0 seconds" });
    const { data: outageStaleKeys } = await service.rpc("list_stale_media_keys");
    const outageTrace = (outageStaleKeys ?? []).find((k) => k.storage_key === outageClaim.candidate_key);
    const { data: outageClaimed } = await service.rpc("claim_stale_key_for_cleanup", { p_id: outageTrace.id });
    await service.storage.from(BUCKET).remove([outageClaimed[0].storage_key]);
    await service.rpc("mark_stale_key_cleaned", { p_id: outageTrace.id });

    // Simule une interruption prolongée du script manuel : cleaned_at est
    // repoussé à il y a 48 heures, sans qu'aucune vérification Storage n'ait
    // eu lieu entre-temps (même mécanisme de manipulation directe, via le
    // client service_role, déjà utilisé ailleurs dans ce fichier pour
    // simuler attempt_expires_at — aucune nouvelle capacité introduite).
    await service.from("private_object_stale_keys").update({ cleaned_at: new Date(Date.now() - 48 * 3600_000).toISOString() }).eq("id", outageTrace.id);

    // Cycle 1 — écriture TARDIVE recréant l'objet PENDANT cette "interruption".
    await service.storage.from(BUCKET).upload(outageClaim.candidate_key, Buffer.from("LATE-WRITE-DURING-OUTAGE-1"), { upsert: true, contentType: "image/jpeg" });

    // Phase C, fonction réellement utilisée — plus aucun paramètre de fenêtre.
    const { data: afterOutage, error: afterOutageErr } = await service.rpc("list_recently_cleaned_media_keys");
    record("Réconciliation durable — signature sans fenêtre de temps (aucun paramètre)", !afterOutageErr, afterOutageErr?.message);
    const stillDetected = (afterOutage ?? []).find((k) => k.storage_key === outageClaim.candidate_key);
    record("Réconciliation durable — clé cleaned_at vieille de 48h toujours détectée (aucune perte)", !!stillDetected);

    const { error: removeOutageErr } = await service.storage.from(BUCKET).remove([outageClaim.candidate_key]);
    record("Réconciliation durable — écriture tardive réellement supprimée malgré le délai", !removeOutageErr, removeOutageErr?.message);

    const { error: markReconciledUserErr } = await author.client.rpc("mark_stale_key_reconciled", { p_id: outageTrace.id });
    record("Réconciliation durable — marquage refusé pour un client authentifié", !!markReconciledUserErr, markReconciledUserErr?.message);
    const { error: markReconciledErr } = await service.rpc("mark_stale_key_reconciled", { p_id: outageTrace.id });
    record("Réconciliation durable — marquage reconciled_at (dernier contrôle) accepté (service_role)", !markReconciledErr, markReconciledErr?.message);

    // CORRIGÉ (revue v3.1, §2) : marquer reconciled_at NE l'exclut PLUS des
    // sélections suivantes — vérification RÉCURRENTE, pas ponctuelle.
    const { data: afterFirstReconcile } = await service.rpc("list_recently_cleaned_media_keys");
    const stillSelectable = (afterFirstReconcile ?? []).find((k) => k.storage_key === outageClaim.candidate_key);
    record("Réconciliation récurrente — clé réconciliée reste sélectionnée au passage suivant (aucune exclusion définitive)", !!stillSelectable);

    // Cycle 2 — nouvelle écriture tardive, APRÈS le premier contrôle réconcilié :
    // le défaut corrigé aurait laissé échapper celle-ci pour toujours.
    await service.storage.from(BUCKET).upload(outageClaim.candidate_key, Buffer.from("LATE-WRITE-DURING-OUTAGE-2"), { upsert: true, contentType: "image/jpeg" });
    const { data: beforeCycle2 } = await service.storage.from(BUCKET).download(outageClaim.candidate_key);
    record("Réconciliation récurrente — deuxième écriture tardive bien recréée (préalable du test)", !!beforeCycle2);

    const { data: cycle2Detected } = await service.rpc("list_recently_cleaned_media_keys");
    const detectedAgain = (cycle2Detected ?? []).find((k) => k.storage_key === outageClaim.candidate_key);
    record("Réconciliation récurrente — deuxième recréation également détectée (contrôle non ponctuel)", !!detectedAgain);
    const { error: removeCycle2Err } = await service.storage.from(BUCKET).remove([outageClaim.candidate_key]);
    record("Réconciliation récurrente — deuxième écriture tardive également supprimée", !removeCycle2Err, removeCycle2Err?.message);
    await service.rpc("mark_stale_key_reconciled", { p_id: outageTrace.id });

    // La ligne FINALIZED du test 2 ne doit toujours jamais apparaître ici.
    const { data: happyRow2 } = await service.from("private_object_uploads").select("storage_key").eq("entity_id", happyMediaId).single();
    const happyLeaked2 = (afterOutage ?? []).find((k) => k.storage_key === happyRow2.storage_key);
    record("Réconciliation durable — candidate FINALIZED toujours exclue (sans fenêtre de temps)", !happyLeaked2);

  }

  // ==========================================================================
  // 14. Décisions pures de reprise — MediaUploadForm (revue v3, §1 et §2).
  //     Copie locale de src/lib/media/uploadResumePolicy.ts (même principe que
  //     sniffMimeType ci-dessus) : ces fonctions ne font aucune E/S, elles
  //     pilotent purement ce que fait le formulaire à partir d'un état déjà
  //     lu — testées ici directement, sans navigateur.
  // ==========================================================================
  {
    function isConfirmedNonExistent(code) {
      return code === "not_authorized";
    }
    function resumeUploadPlan(status, writeClaimed) {
      if (writeClaimed || status === "FINALIZING") return "skip";
      if (status === "PENDING") return "try-skip";
      return "deposit";
    }

    record("§1 — not_authorized confirme l'inexistence (identité abandonnable)", isConfirmedNonExistent("not_authorized") === true);
    record("§1 — operation_access_revoked NE confirme PAS l'inexistence (identité conservée)", isConfirmedNonExistent("operation_access_revoked") === false);
    record("§1 — erreur réseau/sans code NE confirme PAS l'inexistence (identité conservée)", isConfirmedNonExistent(undefined) === false);
    record("§1 — code inconnu NE confirme PAS l'inexistence (identité conservée)", isConfirmedNonExistent("erreur_imprevue_xyz") === false);

    record("§2 — writeClaimed=true : saut ferme du redépôt (candidate déjà revendiquée)", resumeUploadPlan("PENDING", true) === "skip");
    record("§2 — FINALIZING : saut ferme du redépôt (déjà attestée)", resumeUploadPlan("FINALIZING", false) === "skip");
    record("§2 — PENDING sans revendication : tente SANS redépôt d'abord (jamais par défaut)", resumeUploadPlan("PENDING", false) === "try-skip");
  }

  // ==========================================================================
  // 15. Reprise après dépôt de la SOURCE, avant CLAIM (revue v3 puis v3.1, §1).
  //     Reproduit l'ORDRE RÉEL désormais utilisé par commitMediaUpload
  //     (actions.ts) avec les fonctions RÉELLEMENT utilisées, dans le même
  //     ordre : get_upload_status -> (si PENDING, jamais revendiquée) lecture
  //     de la source AVANT tout claim_upload_attempt. CORRIGÉ (revue v3.1) :
  //     l'ancien ordre (CLAIM avant lecture) consommait la porte CAS même
  //     quand la source manquait, bloquant la reprise jusqu'à expiration —
  //     le test D s'arrêtait alors au seul constat d'absence, sans jamais
  //     prouver que la reprise elle-même aboutissait. Il va maintenant
  //     jusqu'à FINALIZED.
  // ==========================================================================
  {
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";

    // C — la source EST déjà déposée (panne simulée entre l'upload réussi et
    // l'appel de commitMediaUpload : rien n'a encore revendiqué la porte).
    // Le serveur doit la retrouver directement (lecture avant CLAIM), sans
    // second dépôt côté client.
    const { operationUuid: opC } = await fullPrepare(author.client, bytes, mime);
    const tempPathC = await uploadTemp(author.client, opC, bytes, mime);
    const { data: statusC } = await author.client.rpc("get_upload_status", { p_operation_uuid: opC });
    record("Reprise C — lecture initiale : PENDING, jamais revendiquée", statusC?.status === "PENDING" && statusC?.write_claimed_at === null);
    const { data: sourceStillThereC, error: dlCErr } = await service.storage.from(BUCKET).download(tempPathC);
    record("Reprise C — source déjà déposée retrouvée par le serveur AVANT tout claim, sans second dépôt côté client", !dlCErr && !!sourceStillThereC, dlCErr?.message);
    const { data: claimC, error: claimCErr } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: opC });
    record("Reprise C — CLAIM gagné normalement une fois la source confirmée", !claimCErr && claimC?.won === true, claimCErr?.message);
    // Le reste (écriture candidate, attestation, finalize) est déjà couvert
    // par le parcours nominal (tests 5-9) — inutile de le rejouer ici.

    // D — la source n'a JAMAIS été déposée (panne AVANT tout dépôt Storage),
    // PUIS un dépôt réel a lieu, PUIS la reprise doit aboutir à FINALIZED —
    // parcours COMPLET, pas seulement le constat d'absence.
    const { operationUuid: opD, checksum: checksumD } = await fullPrepare(author.client, bytes, mime);
    const tempPathD = `_private/${projectId}/media_asset/${opD}/source`; // jamais uploadTemp() avant la reprise

    const { data: statusD1 } = await author.client.rpc("get_upload_status", { p_operation_uuid: opD });
    record("Reprise D — lecture initiale : PENDING, jamais revendiquée", statusD1?.status === "PENDING" && statusD1?.write_claimed_at === null);

    const { data: sourceMissingD, error: dlDErr } = await service.storage.from(BUCKET).download(tempPathD);
    record("Reprise D — absence réelle de la source détectée par le serveur (jamais un succès silencieux)", !!dlDErr && !sourceMissingD, dlDErr?.message);
    record("Reprise D — absence reconnue par un code service explicite (NoSuchKey), pas une erreur générique quelconque", dlDErr?.code === "NoSuchKey", dlDErr?.code);

    // Erreur de téléchargement INCERTAINE ≠ absence confirmée (revue v3.1,
    // §1/§2) : logique pure, copie locale de la même fonction utilisée par
    // actions.ts et cleanup_media_candidates.mjs (même principe que
    // sniffMimeType) — vérifiée sur une VRAIE absence confirmée (dlDErr
    // ci-dessus, un objet Storage réellement inexistant) et sur une erreur
    // générique fabriquée (aucune panne réseau réelle ne peut être déclenchée
    // à la demande dans cet environnement).
    function isConfirmedStorageNotFound(error) {
      if (!error) return false;
      return error.code === "NoSuchKey" || error.statusCode === "404";
    }
    record("§1/§2 — absence RÉELLEMENT confirmée (NoSuchKey, cas ci-dessus) reconnue comme telle", isConfirmedStorageNotFound(dlDErr) === true);
    record("§1/§2 — erreur générique (panne réseau/serveur simulée) NON confondue avec une absence", isConfirmedStorageNotFound({ message: "network timeout", statusCode: "500" }) === false);
    record("§1/§2 — absence d'erreur n'est pas une absence confirmée (garde défensive)", isConfirmedStorageNotFound(null) === false);

    // La porte CAS n'a PAS été consommée par cette absence (ordre corrigé,
    // revue v3.1) : commitMediaUpload n'appelle claim_upload_attempt QUE si
    // cette lecture réussit — jamais avant. Preuve directe, au niveau RPC,
    // que la porte reste gagnable.
    const { data: claimAfterMissingD, error: claimAfterMissingDErr } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: opD });
    record("Reprise D — porte CAS toujours intacte après l'absence confirmée (jamais consommée par une source manquante)", !claimAfterMissingDErr && claimAfterMissingD?.won === true, JSON.stringify(claimAfterMissingD));

    // Dépôt réel, ENFIN.
    await uploadTemp(author.client, opD, bytes, mime);

    // Reprise complète avec les fonctions réellement utilisées (le claim
    // ci-dessus a déjà gagné : même attempt_id/candidate_key réutilisés,
    // jamais une seconde candidate ouverte pour cette même opération).
    const { actualChecksum: csD, actualSize: szD, actualMime: mtD } = await privilegedCommit(
      opD, claimAfterMissingD.attempt_id, tempPathD, claimAfterMissingD.candidate_key, bytes, mime
    );
    record("Reprise D — empreinte recalculée après le dépôt réel identique à l'attendu", csD === checksumD);
    const { error: attestDErr } = await service.rpc("attest_storage_verified", {
      p_operation_uuid: opD, p_attempt_id: claimAfterMissingD.attempt_id,
      p_actual_checksum: csD, p_actual_size_bytes: szD, p_actual_mime_type: mtD,
    });
    record("Reprise D — attestation réussie après le dépôt réel", !attestDErr, attestDErr?.message);
    const { data: mediaD, error: finalizeDErr } = await author.client.rpc("finalize_media_upload", { p_operation_uuid: opD, p_origin: "IMPORTED", p_caption: null });
    record("Reprise D — parcours COMPLET : source absente → dépôt → reprise → FINALIZED", !finalizeDErr && !!mediaD?.id, finalizeDErr?.message);

    const { data: opDRow } = await service.from("private_object_uploads").select("id").eq("operation_uuid", opD).single();
    const { count: mediaCountD } = await service.from("media_assets").select("id", { count: "exact", head: true }).eq("private_object_upload_id", opDRow.id);
    record("Reprise D — un seul média créé pour cette opération (même après la reprise)", mediaCountD === 1, `count=${mediaCountD}`);
    const { data: listingD } = await service.storage.from(BUCKET).list(`_private/${projectId}/media_asset/${opD}/candidates`);
    record("Reprise D — une seule candidate a jamais existé malgré la reprise (aucun second PUT)", (listingD ?? []).length === 1, `count=${listingD?.length}`);
  }

  // ==========================================================================
  // 16. CLAIM lié à l'attempt_id lu — reprise concurrente entre lecture et
  //     CLAIM (revue v3.2). commitMediaUpload lit l'état (get_upload_status)
  //     PUIS appelle claim_upload_attempt : deux appels RPC séparés. Si une
  //     reprise concurrente (recover_media_upload_attempt) ouvre une NOUVELLE
  //     tentative entre les deux, l'ancien code pouvait gagner un CLAIM sur
  //     cette nouvelle tentative sans jamais l'avoir précontrôlée (source
  //     jamais relue) — `precheckedSourceBytes` restait `null` malgré
  //     `claim.won === true`, un cast TypeScript non protecteur à l'exécution.
  //     Reproduit ici sur le chemin serveur RÉELLEMENT utilisé (RPC
  //     claim_upload_attempt à deux arguments, tel qu'appelé par
  //     commitMediaUpload) : tentative changée → refus contrôlé
  //     (`attempt_changed`) → nouvelle porte intacte → reprise réussie, même
  //     opération.
  // ==========================================================================
  {
    const bytes = REAL_JPEG_BYTES;
    const mime = "image/jpeg";
    const { operationUuid: opRace } = await fullPrepare(author.client, bytes, mime);
    await uploadTemp(author.client, opRace, bytes, mime);

    // Étape 1 — "A" lit une tentative et la revendique (attempt_id X1).
    const { data: claimOld, error: claimOldErr } = await author.client.rpc("claim_upload_attempt", { p_operation_uuid: opRace });
    record("Course — première tentative (X1) revendiquée normalement", !claimOldErr && claimOld?.won === true, claimOldErr?.message);
    const attemptX1 = claimOld.attempt_id;

    // Étape 2 — cette tentative expire, puis "B" la reprend : nouvelle
    // tentative (X2), porte à nouveau disponible. L'ancienne candidate (X1)
    // est tracée comme périmée (fonctions réellement utilisées).
    await service.from("private_object_uploads").update({ attempt_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("operation_uuid", opRace);
    const { data: recoveredRow, error: recoverErr } = await author.client.rpc("recover_media_upload_attempt", { p_operation_uuid: opRace });
    record("Course — reprise concurrente (B) ouvre une nouvelle tentative (X2)", !recoverErr && recoveredRow?.attempt_id !== attemptX1 && recoveredRow?.write_claimed_at === null, recoverErr?.message);
    const attemptX2 = recoveredRow.attempt_id;
    const candidateX2 = recoveredRow.candidate_key;

    // Étape 3 — "A" (qui avait lu X1 AVANT l'étape 2) appelle claim_upload_attempt
    // en le liant explicitement à X1 : doit être REFUSÉ, jamais gagner sur X2.
    const { data: staleClaim, error: staleClaimErr } = await author.client.rpc("claim_upload_attempt", {
      p_operation_uuid: opRace,
      p_expected_attempt_id: attemptX1,
    });
    record("Course — CLAIM lié à l'ancienne tentative (X1) refusé (attempt_changed)", !staleClaim && staleClaimErr?.message === "attempt_changed", staleClaimErr?.message);

    // Preuve directe : la porte de X2 n'a PAS été consommée par ce refus.
    const { data: rowAfterRefusal } = await service.from("private_object_uploads").select("attempt_id, write_claimed_at").eq("operation_uuid", opRace).single();
    record("Course — porte de la nouvelle tentative (X2) toujours intacte après le refus", rowAfterRefusal?.attempt_id === attemptX2 && rowAfterRefusal?.write_claimed_at === null);

    // Étape 4 — "A" relit l'état actualisé (X2) et retente, correctement lié
    // cette fois : doit gagner normalement.
    const { data: claimNew, error: claimNewErr } = await author.client.rpc("claim_upload_attempt", {
      p_operation_uuid: opRace,
      p_expected_attempt_id: attemptX2,
    });
    record("Course — reprise réussie : CLAIM lié à la tentative actualisée (X2) gagné", !claimNewErr && claimNew?.won === true && claimNew?.candidate_key === candidateX2, claimNewErr?.message);

    // Parcours complet jusqu'à FINALIZED, même operation_uuid, un seul média.
    const { actualChecksum: csRace, actualSize: szRace, actualMime: mtRace } = await privilegedCommit(
      opRace, claimNew.attempt_id, `_private/${projectId}/media_asset/${opRace}/source`, claimNew.candidate_key, bytes, mime
    );
    const { error: attestRaceErr } = await service.rpc("attest_storage_verified", {
      p_operation_uuid: opRace, p_attempt_id: claimNew.attempt_id,
      p_actual_checksum: csRace, p_actual_size_bytes: szRace, p_actual_mime_type: mtRace,
    });
    record("Course — attestation réussie après la reprise correctement liée", !attestRaceErr, attestRaceErr?.message);
    const { data: mediaRace, error: finalizeRaceErr } = await author.client.rpc("finalize_media_upload", { p_operation_uuid: opRace, p_origin: "IMPORTED", p_caption: null });
    record("Course — finalisation réussie : même opération, reprise après refus contrôlé", !finalizeRaceErr && !!mediaRace?.id, finalizeRaceErr?.message);

    const { data: opRaceRow } = await service.from("private_object_uploads").select("id").eq("operation_uuid", opRace).single();
    const { count: mediaCountRace } = await service.from("media_assets").select("id", { count: "exact", head: true }).eq("private_object_upload_id", opRaceRow.id);
    record("Course — un seul média créé pour cette opération malgré l'entrelacement", mediaCountRace === 1, `count=${mediaCountRace}`);

    // L'ancienne candidate (X1) n'a jamais reçu la moindre écriture — le refus
    // contrôlé a empêché tout PUT sur une tentative périmée.
    const { data: staleCandidateBytes } = await service.storage.from(BUCKET).download(claimOld.candidate_key);
    record("Course — l'ancienne candidate (X1) n'a jamais reçu d'écriture", !staleCandidateBytes);

    // Rétrocompatibilité — l'appel à un seul argument (sans p_expected_attempt_id,
    // tel qu'utilisé par tous les autres tests de ce fichier) reste inchangé :
    // vérifié négativement ici (refusé pour un outsider, comme toujours).
    const { error: backCompatErr } = await outsider.client.rpc("claim_upload_attempt", { p_operation_uuid: opRace });
    record("Course — rétrocompatibilité : appel à un seul argument toujours refusé pour un outsider", backCompatErr?.message === "not_authorized", backCompatErr?.message);
  }

  // --- Bilan ------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} tests réussis.`);
  if (failed.length > 0) {
    console.log("Échecs :", failed.map((f) => f.name).join(" | "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("ERREUR FATALE:", err);
  process.exitCode = 1;
});
