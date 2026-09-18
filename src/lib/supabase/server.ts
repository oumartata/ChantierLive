import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { validateEnv } from "@/lib/env";

// Client Supabase côté serveur (Server Components, Server Actions, Route
// Handlers). Lit/écrit les cookies de session via next/headers.
export async function createClient() {
  validateEnv();
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // `headers` (2e paramètre) : en-têtes anti-cache que @supabase/ssr
        // demande de poser avec toute réponse qui écrit un cookie de
        // session (voir proxy.ts pour l'exemple documenté et appliqué).
        // Depuis un Server Component/Server Action, l'API next/headers ne
        // permet pas de poser des en-têtes de réponse arbitraires (seuls
        // les cookies le sont) — limitation du framework, pas un choix.
        // Le proxy et le Route Handler de confirmation (src/app/auth/
        // confirmer/route.ts) sont les points qui posent réellement ces
        // en-têtes, quand ce contexte le permet.
        setAll(cookiesToSet, _headers) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Appelé depuis un Server Component (pas d'écriture de cookie
            // possible) : le proxy se charge du rafraîchissement.
          }
        },
      },
    }
  );
}

/**
 * Vérifie l'identité côté serveur via un aller-retour réseau à Auth
 * (getUser), jamais getSession seul (lecture locale du cookie, non
 * revérifiée). À utiliser avant toute action sensible.
 */
export async function getVerifiedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
