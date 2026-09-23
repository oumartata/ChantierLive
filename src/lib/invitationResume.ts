// B016 (FR033) : reprise d'une invitation après connexion/inscription/
// confirmation e-mail/OTP téléphone. Mécanisme DÉDIÉ, jamais un `next`
// générique : le paramètre ne porte qu'un jeton d'invitation, strictement
// validé, et ne sert jamais qu'à reconstruire /invitations/<jeton> — jamais
// une redirection vers une URL arbitraire fournie par l'appelant.
export const INVITATION_RESUME_PARAM = "invitation";

const INVITATION_TOKEN_RE = /^[0-9a-f]{64}$/;

// Ne retourne le jeton que s'il correspond exactement au format produit par
// create_invitation (encode(gen_random_bytes(32), 'hex') = 64 caractères
// hexadécimaux) — toute autre valeur (absente, tronquée, caractères hors
// plage) est traitée comme "pas de reprise en cours", jamais un cas
// d'erreur affiché à l'utilisateur : le parcours Auth habituel continue.
export function parseInvitationToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return INVITATION_TOKEN_RE.test(raw) ? raw : null;
}

// Reconstruit TOUJOURS le même chemin fixe — jamais une valeur transmise
// telle quelle : ferme toute tentative d'open redirect via ce paramètre.
export function invitationResumePath(token: string): string {
  return `/invitations/${token}`;
}
