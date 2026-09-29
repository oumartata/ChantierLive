"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseInvitationToken, invitationResumePath } from "@/lib/invitationResume";

export type AuthActionState = { error: string } | null;

// FR033 : destination après une étape Auth réussie — reprend l'invitation
// en cours si le formulaire en portait une (jeton strictement validé),
// sinon le parcours habituel est inchangé. Jamais un `next` arbitraire.
function postAuthRedirectPath(formData: FormData, fallback: string): string {
  const token = parseInvitationToken(formData.get("invitation")?.toString() ?? null);
  return token ? invitationResumePath(token) : fallback;
}

// Traduit les erreurs BRUTES du fournisseur (GoTrue/Twilio) en messages
// français utiles. Diagnostic (lecture seule de supabase/config.toml, aucun
// secret affiché ici) : [auth.sms.twilio] est activé avec des identifiants
// FICTIFS en local (B012, essai volontaire) — seuls les deux numéros de
// [auth.sms.test_otp] évitent un vrai appel à l'API Twilio. Tout autre
// numéro déclenche un rejet réel de Twilio ("Authentication Error - invalid
// username", l'identifiant Twilio étant fictif), renvoyé tel quel par GoTrue
// aujourd'hui. Ne PAS activer un compte Twilio réel (service payant) ni
// désactiver enable_confirmations : le message est seulement rendu clair,
// avec une orientation vers le parcours e-mail (toujours fonctionnel en
// local) ou les deux numéros de test.
function mapAuthError(message: string | undefined): string {
  if (!message) return "Une erreur est survenue. Réessayez.";
  const lower = message.toLowerCase();
  if (lower.includes("authentication error") || lower.includes("invalid username")) {
    return "L'envoi de SMS n'est pas connecté sur cet environnement de démonstration. Utilisez un e-mail, ou l'un des deux numéros de test (+15550001111 / +15550001112, code 123456).";
  }
  if (lower.includes("user already registered") || lower.includes("already registered")) {
    return "Un compte existe déjà avec cet identifiant. Connectez-vous plutôt.";
  }
  if (lower.includes("invalid login credentials")) {
    return "Identifiant ou mot de passe incorrect.";
  }
  if (lower.includes("password should be at least")) {
    return "Le mot de passe doit contenir au moins 6 caractères.";
  }
  if (lower.includes("invalid phone") || lower.includes("phone number")) {
    return "Numéro de téléphone invalide. Utilisez le format international (ex. +223 70 00 00 00).";
  }
  if (lower.includes("token has expired") || lower.includes("otp expired")) {
    return "Le code a expiré. Demandez-en un nouveau.";
  }
  if (lower.includes("invalid otp") || lower.includes("invalid token")) {
    return "Code incorrect. Vérifiez le code reçu et réessayez.";
  }
  return "Une erreur est survenue. Réessayez.";
}

// FR001/FR002 : inscription. Ne fait que créer le compte (provisional) —
// la confirmation et la connexion restent des étapes séparées.
export async function signUp(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const isEmail = identifier.includes("@");
  // Revalidé ici (pas seulement transmis depuis le champ caché du
  // formulaire) : seule une valeur au format exact est jamais réutilisée.
  const invitationToken = parseInvitationToken(formData.get("invitation")?.toString() ?? null);

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp(
    isEmail
      ? {
          email: identifier,
          password,
          // Flux PKCE (@supabase/ssr) : GoTrue redirige ici après validation
          // du lien, avec un `code` à échanger — voir src/app/auth/confirmer.
          // Le jeton d'invitation (déjà validé ci-dessus) est répercuté tel
          // quel dans cette seule URL fixe, jamais une valeur arbitraire.
          options: {
            emailRedirectTo: invitationToken
              ? `${process.env.NEXT_PUBLIC_APP_URL}/auth/confirmer?invitation=${invitationToken}`
              : `${process.env.NEXT_PUBLIC_APP_URL}/auth/confirmer`,
          },
        }
      : { phone: identifier, password }
  );

  if (error) {
    return { error: mapAuthError(error.message) };
  }

  if (isEmail) {
    redirect(
      invitationToken
        ? `/connexion?inscription=ok&invitation=${invitationToken}`
        : "/connexion?inscription=ok"
    );
  }
  // Téléphone : pas de lien, un code OTP est envoyé — étape de saisie dédiée.
  const phoneStep = `/verification-telephone?phone=${encodeURIComponent(identifier)}`;
  redirect(invitationToken ? `${phoneStep}&invitation=${invitationToken}` : phoneStep);
}

// FR005 : connexion.
export async function signIn(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const isEmail = identifier.includes("@");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(
    isEmail
      ? { email: identifier, password }
      : { phone: identifier, password }
  );

  if (error) {
    return { error: mapAuthError(error.message) };
  }

  redirect(postAuthRedirectPath(formData, "/tableau-de-bord"));
}

// Confirmation téléphone : saisie du code OTP reçu (FR001, parcours
// inscription téléphone). Établit la session au succès.
export async function verifyPhoneOtp(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const phone = String(formData.get("phone") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ phone, token, type: "sms" });

  if (error) {
    return { error: mapAuthError(error.message) };
  }

  redirect(postAuthRedirectPath(formData, "/tableau-de-bord"));
}

// FR005 : déconnexion. Portée retenue : `scope: "local"` — ferme uniquement
// la session courante (ce navigateur/appareil), pas tous les appareils. Le
// SDK signOut() sans option utilise par défaut `scope: "global"` (déconnecte
// TOUS les appareils), un comportement surprenant pour un simple bouton
// "Se déconnecter" — écarté explicitement ici, pas le défaut du SDK.
// L'erreur est retournée à l'appelant, jamais un succès affiché à tort.
//
// "Changer de compte" (page d'invitation) réutilise cette MÊME action —
// jamais une seconde implémentation de déconnexion — avec un jeton
// d'invitation optionnel dans le formulaire : /connexion redirigeant
// immédiatement une session valide, il faut se déconnecter D'ABORD pour
// réellement atteindre le formulaire de connexion, jeton d'invitation
// préservé (même validation stricte que partout ailleurs, jamais un `next`
// arbitraire).
export async function signOut(
  _prevState: AuthActionState,
  formData?: FormData
): Promise<AuthActionState> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    return { error: error.message };
  }

  const token = parseInvitationToken(formData?.get("invitation")?.toString() ?? null);
  redirect(token ? `/connexion?invitation=${token}` : "/connexion");
}
