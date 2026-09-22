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

export type VerifiedAccountGuardResult =
  | { ok: true; user: NonNullable<Awaited<ReturnType<typeof getVerifiedUser>>> }
  | {
      ok: false;
      reason: "unauthenticated" | "provisional" | "verification_unavailable";
      message: string;
    };

// B013 (FR008/AC008) : garde-fou générique à appeler avant toute action
// sensible (BR006 : approbation, refus, transfert de rôle, retrait du
// principal, activation — aucune n'est encore implémentée ; ce garde-fou est
// le point de branchement commun qu'elles devront toutes utiliser).
//
// Fail-closed strict : seul `data === false` SANS erreur laisse passer.
// Une identité absente, une erreur RPC ou un résultat indéterminé refusent
// tous — jamais traités comme "vérifié" par défaut. Ne vérifie que
// l'identité/la confirmation d'un identifiant ; les permissions métier
// (rôle, adhésion, délégation) restent un contrôle séparé, propre à chaque
// action, non couvert ici.
export async function requireVerifiedAccount(): Promise<VerifiedAccountGuardResult> {
  const user = await getVerifiedUser();
  if (!user) {
    return {
      ok: false,
      reason: "unauthenticated",
      message: "Connexion requise.",
    };
  }

  const supabase = await createClient();
  const { data: provisional, error } = await supabase.rpc("is_account_provisional");

  // Comparaisons strictes uniquement : is_account_provisional() est typée
  // boolean côté SQL, mais rien ne garantit que la couche réseau/PostgREST
  // ne renvoie jamais autre chose que true/false/null. `provisional` seul
  // (truthy check) laisserait passer 0 ou "" par erreur — exclu ici.
  if (error) {
    return {
      ok: false,
      reason: "verification_unavailable",
      message: "Vérification indisponible. Réessayez plus tard.",
    };
  }

  if (provisional === true) {
    return {
      ok: false,
      reason: "provisional",
      message: "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.",
    };
  }

  if (provisional === false) {
    return { ok: true, user };
  }

  // Toute autre valeur (null, undefined, 0, "", ...) : refusé, jamais admis
  // par défaut.
  return {
    ok: false,
    reason: "verification_unavailable",
    message: "Vérification indisponible. Réessayez plus tard.",
  };
}
