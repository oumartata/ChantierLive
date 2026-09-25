// Détection du format RÉEL d'un fichier à partir de ses octets (signature
// "magic bytes"), jamais du seul type MIME déclaré par le client ni
// recopié tel quel. Utilisé exclusivement côté serveur privilégié
// (commitMediaUpload, service_role), avant d'attester quoi que ce soit
// (attest_storage_verified, M010) — voir DATA_MODEL.yaml private_object_access.
// Périmètre volontairement limité aux types acceptés par le bucket
// project-media (M010) : image/jpeg, image/png, image/webp, video/mp4.
// Aucune dépendance ajoutée (pas de librairie de détection de type).
export function sniffMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) {
    return "image/webp";
  }

  // Boîte ISO BMFF "ftyp" à l'offset 4 : couvre les conteneurs MP4 produits
  // par un encodeur standard (ex. ffmpeg). Vérification de conteneur, pas du
  // codec interne — suffisant pour ce périmètre (un seul type vidéo accepté).
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 // "ftyp"
  ) {
    return "video/mp4";
  }

  return null;
}
