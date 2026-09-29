import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { parseInvitationToken, invitationResumePath } from "@/lib/invitationResume";

// Route Handler de confirmation e-mail, adaptée au flux PKCE retenu par
// @supabase/ssr (flowType "pkce", non configurable). Le lien envoyé par
// Mailpit/GoTrue pointe vers auth/v1/verify (GoTrue), qui valide le jeton
// pkce_* puis redirige ICI avec un paramètre `code` — cette route échange
// ce code contre une session réelle (exchangeCodeForSession), jamais une
// simple confirmation par appel API utilisée comme substitut du parcours.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // FR033 : jeton revalidé ici (paramètre transmis par signUp via
  // emailRedirectTo, jamais fait confiance tel quel) — reconstruit
  // uniquement /invitations/<jeton>, jamais une redirection arbitraire.
  const invitationToken = parseInvitationToken(searchParams.get("invitation"));
  const successPath = invitationToken ? invitationResumePath(invitationToken) : "/tableau-de-bord";
  // Échec : préserve la reprise pour que l'utilisateur ne perde pas son
  // contexte après un nouvel essai de connexion.
  const failurePath = invitationToken
    ? `/connexion?confirmation=echec&invitation=${invitationToken}`
    : "/connexion?confirmation=echec";

  const response = NextResponse.redirect(`${origin}${successPath}`);

  if (!code) {
    response.headers.set("Location", `${origin}${failurePath}`);
    return response;
  }

  const cookieStore = await cookies();

  // `response` est créée une seule fois et réutilisée pour les deux issues :
  // en cas d'échec, les cookies déjà écrits par setAll (nettoyage PKCE côté
  // Supabase) et les en-têtes anti-cache restent posés sur la redirection
  // finale au lieu d'être abandonnés par la création d'une réponse séparée.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [key, value] of Object.entries(headers)) {
            response.headers.set(key, value);
          }
        },
      },
    }
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    response.headers.set("Location", `${origin}${failurePath}`);
  }

  return response;
}
