// Décisions PURES de reprise pour MediaUploadForm (revue v3, §1 et §2).
// Extraites dans ce module (aucune E/S) pour rester testables directement,
// sans navigateur — voir scripts/test-media-upload.mjs (copie locale, même
// principe que sniffMimeType.ts).

// §1 — la SEULE valeur qui prouve qu'une opération n'existe pas / n'est pas
// la sienne est le code `not_authorized` (voir get_upload_status et
// recover_media_upload_attempt, M010 : ce code sert exactement à ça, sans
// fuite vers un tiers). Toute autre valeur — `operation_access_revoked`, une
// erreur réseau/session (code absent), ou un code inconnu — est INCONCLUANTE
// et ne doit jamais faire abandonner l'identité de l'opération en cours : une
// panne transitoire ne doit jamais provoquer une seconde opération.
export function isConfirmedNonExistent(code: string | undefined): boolean {
  return code === "not_authorized";
}

// §2 — ne jamais redéposer la source par défaut. "skip" : la source n'est de
// toute façon plus utile (candidate déjà revendiquée, ou déjà attestée).
// "try-skip" : rien ne prouve l'absence de la source (candidate jamais
// revendiquée) — tenter le commit directement, c'est le serveur
// (commitMediaUpload, code `source_not_found`) qui confirmera ou infirmera
// réellement sa présence. "deposit" : opération neuve, dépôt normal.
export type ResumeUploadPlan = "skip" | "try-skip" | "deposit";

export function resumeUploadPlan(status: string, writeClaimed: boolean): ResumeUploadPlan {
  if (writeClaimed || status === "FINALIZING") return "skip";
  if (status === "PENDING") return "try-skip";
  return "deposit";
}
