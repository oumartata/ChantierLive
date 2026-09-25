import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Client Supabase privilégié (service_role) — B026, DATA_MODEL.yaml
// privileged_boundary : "seule la copie Storage elle-même s'exécute côté
// serveur avec des identifiants privilégiés (service_role), jamais transmis
// ni accessibles au navigateur." Aucune nouvelle dépendance ajoutée (pas de
// package "server-only") : la garde repose sur SUPABASE_SERVICE_ROLE_KEY,
// jamais préfixée NEXT_PUBLIC_ (voir src/lib/env.ts), donc absente du bundle
// navigateur par construction Next.js — et sur l'usage exclusif de ce module
// depuis des fichiers "use server" (jamais importé par un composant client).
//
// N'utiliser CE client QUE pour : (1) émettre l'URL signée d'upload vers la
// source temporaire, (2) lire la source temporaire et écrire la candidate,
// (3) appeler attest_storage_verified (RPC dont l'EXECUTE est réservé au
// rôle service_role — voir M010). Toute autre opération (PREPARE, FINALIZE,
// lecture métier) doit utiliser le client de session utilisateur
// (@/lib/supabase/server), jamais celui-ci — service_role contourne RLS.
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY ou NEXT_PUBLIC_SUPABASE_URL manquant : le client privilégié ne peut pas être créé."
    );
  }

  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
