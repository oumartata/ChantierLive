"use server";

import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { buildOfflineReference, type ReferenceClient } from "@/lib/offline/reference";
import type { Reference } from "@/lib/offline/account";

// L06 (B036 ; O1, D202) — référence minimale pour l'appareil, lue avec la
// session de la personne. Aucune écriture.
export async function getOfflineReference(): Promise<{ ok: true; profileId: string; reference: Reference } | { ok: false }> {
  const user = await getVerifiedUser();
  if (!user) return { ok: false };
  try {
    const supabase = await createClient();
    return { ok: true, profileId: user.id, reference: await buildOfflineReference(supabase as unknown as ReferenceClient, user.id) };
  } catch {
    return { ok: false };
  }
}
