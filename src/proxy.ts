import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Rafraîchit la session Supabase à chaque requête (modèle SSR standard).
// Ne décide d'aucun contrôle d'accès sensible ici : chaque Server Function
// revérifie getUser() indépendamment (voir src/lib/supabase/server.ts) — un
// Server Function appelé sur une route exclue du matcher ci-dessous
// contournerait ce proxy, jamais le contrôle serveur propre à l'action.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        // `headers` (2e paramètre, @supabase/ssr >= 0.7) : en-têtes anti-cache
        // à poser dès qu'un cookie de session est écrit — une réponse qui
        // pose Set-Cookie ne doit jamais être mise en cache par un CDN/proxy
        // intermédiaire (le jeton d'un utilisateur serait servi à un autre).
        // Exemple exact de la doc @supabase/ssr (types.d.ts, SetAllCookies).
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
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

  // Déclenche le rafraîchissement si nécessaire (écrit les cookies via setAll).
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // Exclut aussi sw.js et icon.svg (ressources publiques statiques) en
    // plus des exclusions déjà en place — un service worker ou une icône
    // n'a besoin d'aucun rafraîchissement de session.
    "/((?!_next/static|_next/image|favicon.ico|icons|icon.svg|manifest.webmanifest|offline|sw.js).*)",
  ],
};
