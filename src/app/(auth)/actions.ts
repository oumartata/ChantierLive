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
    return { error: error.message };
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
    return { error: error.message };
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
    return { error: error.message };
  }

  redirect(postAuthRedirectPath(formData, "/tableau-de-bord"));
}

// FR005 : déconnexion. Portée retenue : `scope: "local"` — ferme uniquement
// la session courante (ce navigateur/appareil), pas tous les appareils. Le
// SDK signOut() sans option utilise par défaut `scope: "global"` (déconnecte
// TOUS les appareils), un comportement surprenant pour un simple bouton
// "Se déconnecter" — écarté explicitement ici, pas le défaut du SDK.
// L'erreur est retournée à l'appelant, jamais un succès affiché à tort.
export async function signOut(
  _prevState: AuthActionState
): Promise<AuthActionState> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    return { error: error.message };
  }

  redirect("/connexion");
}
