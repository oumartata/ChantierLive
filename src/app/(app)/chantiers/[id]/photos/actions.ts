"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { sniffMimeType } from "@/lib/media/sniffMimeType";

const BUCKET = "project-media";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Traduit les codes d'erreur bruts des RPC B026/B027 (M010) en texte
// destiné à l'utilisateur — même principe que equipe/actions.ts.
function mapUploadError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à effectuer cette action.";
    case "checksum_required":
    case "size_required":
    case "mime_type_required":
    case "invalid_origin":
      return "Fichier invalide. Réessayez avec une autre photo.";
    case "operation_uuid_conflict":
      return "Un envoi différent est déjà en cours pour cette référence. Réessayez.";
    case "attempt_expired":
      return "L'envoi a expiré. Une nouvelle tentative va démarrer.";
    case "attempt_stale":
      return "Cette tentative n'est plus valide. Réessayez.";
    case "storage_not_verified":
      return "Le fichier n'a pas encore été vérifié par le serveur. Réessayez.";
    case "checksum_mismatch":
      return "Le fichier reçu diffère de celui envoyé. Réessayez.";
    case "media_not_draft":
      return "Cette photo est déjà publiée.";
    case "operation_already_finalized":
      return "Cet envoi est déjà terminé.";
    case "operation_abandoned":
      return "Cet envoi a expiré et ne peut plus être repris. Recommencez avec une nouvelle photo.";
    case "operation_access_revoked":
      return "Vos droits sur ce chantier semblent avoir changé. Réessayez une fois rétablis.";
    case "attempt_changed":
      // Ne devrait normalement jamais atteindre l'affichage : commitMediaUpload
      // absorbe ce code en relisant l'état actualisé (revue v3.2) — conservé
      // ici uniquement en repli défensif si un appel direct le laissait passer.
      return "L'envoi a changé d'état entre-temps. Réessayez.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

function tempSourceKey(projectId: string, operationUuid: string) {
  return `_private/${projectId}/media_asset/${operationUuid}/source`;
}

// Absence CONFIRMÉE d'un objet Storage (revue v3.1, §1) : "NoSuchKey" est le
// code service documenté par storage-js pour ce cas précis (vérifié
// empiriquement en local : statusCode "404" pour le même cas). Toute autre
// erreur (panne réseau, 5xx, etc.) reste INCERTAINE — jamais confondue avec
// une absence réelle, jamais traduite en `source_not_found`.
function isConfirmedStorageNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return code === "NoSuchKey" || statusCode === "404";
}

// `code` (optionnel) porte le code d'erreur BRUT de la RPC pour les actions
// où l'appelant doit distinguer les cas (ex. MediaUploadForm : conserver ou
// abandonner un operationUuid en cours) — jamais un texte destiné à
// l'affichage, qui reste `message` (déjà traduit, voir mapUploadError).
type ActionResult<T> = { ok: true; value: T } | { ok: false; message: string; code?: string };

// Étape 1/4 — PREPARE (RPC, session utilisateur) + URL signée d'upload vers
// la SOURCE TEMPORAIRE (jamais la candidate, jamais construite/choisie par
// le client). Voir DATA_MODEL.yaml upload_immutability.
export async function prepareMediaUpload(input: {
  projectId: string;
  operationUuid: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
}): Promise<ActionResult<{ uploadUrl: string; token: string; path: string }>> {
  if (!UUID_RE.test(input.projectId) || !UUID_RE.test(input.operationUuid)) {
    return { ok: false, message: "Requête invalide." };
  }

  const account = await requireVerifiedAccount();
  if (!account.ok) return { ok: false, message: account.message };

  const supabase = await createClient();
  const { data: prepared, error } = await supabase.rpc("prepare_media_upload", {
    p_operation_uuid: input.operationUuid,
    p_project_id: input.projectId,
    p_expected_checksum: input.checksum,
    p_expected_size_bytes: input.sizeBytes,
    p_expected_mime_type: input.mimeType,
  });

  if (error || !prepared) {
    return { ok: false, message: mapUploadError(error?.message) };
  }

  // Chemin construit depuis le project_id RENVOYÉ par la RPC (rapproché,
  // revérifié), jamais depuis input.projectId seul — corrige la revue
  // 2026-09-26 (le paramètre client n'est utile qu'à identifier l'opération
  // attendue ; l'autorité est toujours la ligne réellement écrite en base).
  const preparedProjectId: string = prepared.project_id;
  const path = tempSourceKey(preparedProjectId, input.operationUuid);
  const service = createServiceClient();
  const { data: signed, error: signError } = await service.storage.from(BUCKET).createSignedUploadUrl(path);

  if (signError || !signed) {
    return { ok: false, message: "Impossible de préparer l'envoi. Réessayez." };
  }

  return { ok: true, value: { uploadUrl: signed.signedUrl, token: signed.token, path: signed.path } };
}

// Étape 3/4 — commit : claim (session utilisateur) -> lecture source
// temporaire + écriture candidate + contrôle des octets + attestation
// (service_role uniquement) -> finalize (session utilisateur, atomique avec
// la création du média brouillon). Voir plan B026-B027 §5.
export async function commitMediaUpload(input: {
  projectId: string;
  operationUuid: string;
  // "CAPTURED" retiré du type : le serveur (finalize_media_upload) refuse
  // toute provenance autre que "IMPORTED" dans cette tranche (revue
  // 2026-09-26) — la capture réelle et ses preuves restent différées.
  origin: "IMPORTED";
  caption: string | null;
}): Promise<ActionResult<{ mediaId: string }>> {
  if (!UUID_RE.test(input.projectId) || !UUID_RE.test(input.operationUuid)) {
    return { ok: false, message: "Requête invalide." };
  }

  const account = await requireVerifiedAccount();
  if (!account.ok) return { ok: false, message: account.message };

  const supabase = await createClient();
  const service = createServiceClient();

  // Lecture seule D'ABORD (revue v3.1, §1) : ne jamais consommer la porte CAS
  // (claim_upload_attempt — "au plus une tentative d'écriture jamais") avant
  // d'avoir confirmé que la source existe réellement, tant que rien ne l'a
  // encore revendiquée. En vérifiant la source avant le CLAIM, une absence
  // confirmée ne consomme jamais la porte : un redépôt réel peut ensuite
  // gagner un CLAIM normalement.
  //
  // CORRIGÉ (revue v3.2) : get_upload_status et claim_upload_attempt sont deux
  // appels RPC séparés, donc deux lectures de la ligne dans le temps. Entre
  // les deux, une REPRISE CONCURRENTE (recover_media_upload_attempt) sur une
  // tentative expirée peut ouvrir une NOUVELLE tentative (nouvel attempt_id,
  // write_claimed_at remis à null) : la lecture ci-dessus avait alors pu
  // sauter le précontrôle (write_claimed_at non null à CE moment-là, sur
  // l'ANCIENNE tentative), puis claim_upload_attempt gagnait quand même sur la
  // NOUVELLE tentative — `precheckedSourceBytes` restait `null` malgré
  // `claim.won === true`. Corrigé en liant le CLAIM à l'attempt_id
  // EFFECTIVEMENT lu (`p_expected_attempt_id`) : si la tentative a changé
  // entre-temps, la fonction refuse (`attempt_changed`) SANS consommer la
  // porte de la nouvelle tentative — on relit alors l'état actualisé et on
  // retente, une seule fois (fenêtre de course, jamais un blocage réel).
  let statusRow: { status: string; write_claimed_at: string | null; project_id: string; attempt_id: string };
  let precheckedSourceBytes: Uint8Array | null = null;
  let claim: {
    won: boolean;
    status: string;
    project_id: string;
    candidate_key: string;
    expected_mime_type: string;
    attempt_id: string;
  } | null = null;

  for (let attempt = 0; attempt < 2 && !claim; attempt++) {
    const { data: freshStatus, error: statusError } = await supabase.rpc("get_upload_status", {
      p_operation_uuid: input.operationUuid,
    });
    if (statusError) return { ok: false, message: mapUploadError(statusError.message), code: statusError.message };
    statusRow = freshStatus;
    precheckedSourceBytes = null;

    if (statusRow.status === "PENDING" && statusRow.write_claimed_at === null) {
      // Rien n'a encore revendiqué la porte : c'est le SEUL cas où
      // claim_upload_attempt pourra encore renvoyer won=true ci-dessous
      // (sinon il renvoie toujours won=false — voir M010) — donc le seul cas
      // où une vérification de la source a un sens avant de la consommer.
      const tempPath = tempSourceKey(statusRow.project_id, input.operationUuid);
      const { data: tempFile, error: dlError } = await service.storage.from(BUCKET).download(tempPath);
      if (dlError) {
        if (isConfirmedStorageNotFound(dlError)) {
          // Absence CONFIRMÉE : rien n'a jamais été écrit pour cette opération,
          // la porte CAS n'est pas encore consommée — sûr d'autoriser un
          // redépôt côté client (seul cas où `source_not_found` est renvoyé).
          return { ok: false, message: "Fichier introuvable côté serveur. Réessayez l'envoi.", code: "source_not_found" };
        }
        // Toute autre erreur (panne réseau/Storage, etc.) reste INCERTAINE —
        // jamais confondue avec une absence confirmée, jamais de redépôt déclenché.
        return { ok: false, message: "Erreur de lecture côté serveur. Réessayez." };
      }
      precheckedSourceBytes = new Uint8Array(await tempFile.arrayBuffer());
    }

    const { data: claimResult, error: claimError } = await supabase.rpc("claim_upload_attempt", {
      p_operation_uuid: input.operationUuid,
      p_expected_attempt_id: statusRow.attempt_id,
    });
    if (claimError) {
      if (claimError.message === "attempt_changed") {
        // Refus contrôlé : la porte de la tentative courante (nouvelle ou
        // non) n'a PAS été consommée — on relit l'état actualisé ci-dessus.
        continue;
      }
      return { ok: false, message: mapUploadError(claimError.message) };
    }
    claim = claimResult;
  }

  if (!claim) {
    // Deux lectures consécutives ont chacune vu la tentative changer sous nos
    // pieds — conjonction de reprises concurrentes extrêmement improbable,
    // jamais un état incohérent : retryable, jamais un blocage.
    return { ok: false, message: "Une reprise concurrente est en cours sur cet envoi. Réessayez." };
  }
  // Capturé dans une const (jamais réassignée) : TypeScript ne propage pas le
  // rétrécissement de `claim` (déclaré `let`) dans les fonctions imbriquées
  // ci-dessous (même limitation que `currentFile` dans MediaUploadForm.tsx).
  const wonClaim = claim;

  async function attestFromBytes(bytes: Uint8Array) {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
    const actualChecksum = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const actualSniffed = sniffMimeType(bytes);
    return service.rpc("attest_storage_verified", {
      p_operation_uuid: input.operationUuid,
      p_attempt_id: wonClaim.attempt_id,
      p_actual_checksum: actualChecksum,
      p_actual_size_bytes: bytes.length,
      p_actual_mime_type: actualSniffed ?? "application/octet-stream",
    });
  }

  if (wonClaim.won) {
    // claim_upload_attempt ne renvoie won=true QUE si write_claimed_at était
    // encore null (M010) — donc que si le pré-contrôle ci-dessus a tourné et
    // réussi : les octets de la source sont déjà en main, aucun second
    // téléchargement (et donc aucune seconde fenêtre d'incertitude Storage).
    const sourceBytes = precheckedSourceBytes as Uint8Array;
    // Format RÉEL détecté à partir des octets de la SOURCE, pour choisir le
    // content-type d'écriture — jamais le type déclaré par le client.
    const sourceSniffed = sniffMimeType(sourceBytes);

    const { error: writeError } = await service.storage
      .from(BUCKET)
      .upload(wonClaim.candidate_key, sourceBytes, { contentType: sourceSniffed ?? wonClaim.expected_mime_type, upsert: false });
    if (writeError) {
      return { ok: false, message: "Échec de l'écriture serveur. Réessayez." };
    }

    // Contrôle post-écriture RÉEL (revue 2026-09-26) : l'empreinte/taille/type
    // attestés portent sur les octets RELUS depuis la candidate telle qu'elle
    // existe réellement dans Storage — jamais sur les octets de la source
    // calculés avant l'écriture.
    const { data: writtenFile, error: rereadError } = await service.storage.from(BUCKET).download(wonClaim.candidate_key);
    if (rereadError || !writtenFile) {
      return { ok: false, message: "Impossible de relire le fichier écrit. Réessayez." };
    }
    const candidateBytes = new Uint8Array(await writtenFile.arrayBuffer());
    const { error: attestError } = await attestFromBytes(candidateBytes);
    if (attestError) return { ok: false, message: mapUploadError(attestError.message) };
  } else if (wonClaim.status === "PENDING") {
    // CORRIGÉ (revue 2026-09-27) : ne présume plus qu'un autre appelant
    // "s'en occupe déjà". write_claimed_at déjà posé + statut encore PENDING
    // signifie soit une tentative concurrente réellement en cours ailleurs,
    // soit — le cas visé ici — une panne SURVENUE APRÈS un dépôt Storage
    // réussi (la candidate a été écrite, mais l'attestation n'a jamais été
    // appelée avant l'interruption). On ne réécrit JAMAIS la candidate ici
    // (aucun second PUT) : on se contente de la RELIRE. Si elle existe, on
    // l'atteste ; sinon, l'écriture est encore en cours ailleurs et on
    // demande de réessayer sans rien tenter.
    const { data: existingCandidate, error: dlErr } = await service.storage.from(BUCKET).download(wonClaim.candidate_key);
    if (dlErr || !existingCandidate) {
      return { ok: false, message: "Traitement en cours. Réessayez dans un instant." };
    }
    const candidateBytes = new Uint8Array(await existingCandidate.arrayBuffer());
    const { error: attestError } = await attestFromBytes(candidateBytes);
    if (attestError) return { ok: false, message: mapUploadError(attestError.message) };
  }
  // claim.status === "FINALIZING" (won=false) : attestation déjà faite lors
  // d'une tentative précédente (panne APRÈS attestation) — rien à relire ni
  // à écrire, on passe directement à la finalisation ci-dessous.

  const { data: media, error: finalizeError } = await supabase.rpc("finalize_media_upload", {
    p_operation_uuid: input.operationUuid,
    p_origin: input.origin,
    p_caption: input.caption,
  });
  if (finalizeError) return { ok: false, message: mapUploadError(finalizeError.message) };

  revalidatePath(`/chantiers/${input.projectId}/photos`);
  return { ok: true, value: { mediaId: media.id } };
}

// Reprise après un commit dont le résultat côté client est incertain
// (timeout réseau) — plan B026-B027 §1/§6. Jamais un second PUT sur
// l'ancienne candidate : nouvel attempt_id/nouvelle clé si expirée.
export async function recoverMediaUpload(input: {
  operationUuid: string;
}): Promise<ActionResult<{ status: string }>> {
  if (!UUID_RE.test(input.operationUuid)) return { ok: false, message: "Requête invalide." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("recover_media_upload_attempt", {
    p_operation_uuid: input.operationUuid,
  });
  if (error) return { ok: false, message: mapUploadError(error.message), code: error.message };
  return { ok: true, value: { status: data.status } };
}

// Lecture seule de l'état courant d'une opération — pilote la reprise côté
// client (MediaUploadForm) sans réécriture obligatoire de la source ni
// second PUT sur une candidate déjà revendiquée (revue 2026-09-27) : le
// client décide quelles étapes rejouer à partir de cet état réel, jamais
// d'une hypothèse.
export async function getUploadStatus(input: {
  operationUuid: string;
}): Promise<ActionResult<{ status: string; writeClaimed: boolean }>> {
  if (!UUID_RE.test(input.operationUuid)) return { ok: false, message: "Requête invalide." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_upload_status", { p_operation_uuid: input.operationUuid });
  if (error) return { ok: false, message: mapUploadError(error.message), code: error.message };
  return { ok: true, value: { status: data.status, writeClaimed: data.write_claimed_at !== null } };
}

export async function publishMediaAsset(input: { projectId: string; mediaId: string }): Promise<ActionResult<null>> {
  if (!UUID_RE.test(input.mediaId)) return { ok: false, message: "Requête invalide." };

  const account = await requireVerifiedAccount();
  if (!account.ok) return { ok: false, message: account.message };

  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_media_asset", { p_media_asset_id: input.mediaId });
  if (error) return { ok: false, message: mapUploadError(error.message) };

  revalidatePath(`/chantiers/${input.projectId}/photos`);
  return { ok: true, value: null };
}
