import { createBrowserClient } from "@supabase/ssr";

// Modèle SSR standard (@supabase/ssr) : le cookie de session n'est PAS
// HttpOnly, ce client navigateur doit pouvoir le lire pour rafraîchir la
// session. Décision B012, voir DECISIONS.yaml.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
