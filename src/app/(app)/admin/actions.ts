"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

// B050 (M050 ; D195 E4, E5, E7) — recherche d'un compte sur identifiant exact
// et prix de la licence. Chaque fonction en base revérifie que l'appelant est
// administrateur et trace l'action dans le journal de plateforme.
// L'identifiant cherché passe par le corps de la requête, jamais par l'URL.

export interface FoundOrganization {
  organization_ref: string;
  name: string;
  created_at_server: string;
  owner: boolean;
  members: number;
  projects: number;
}

export interface FoundAccount {
  account_ref: string;
  created_at_server: string;
  verified: boolean;
  active_memberships: number;
  is_admin: boolean;
  organizations: FoundOrganization[];
}

export type AccountLookupState = { error: string } | { found: FoundAccount | null } | null;
export type LicenseOfferState = { error: string } | { ok: true; price: number; isDemo: boolean } | null;

function mapError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Action réservée à l'administration de la plateforme.";
    case "identifier_invalid":
      return "Saisissez l'e-mail ou le numéro de téléphone complet du compte.";
    case "invalid_amount":
      return "Le prix doit être un nombre entier de FCFA, supérieur à zéro.";
    case "revision_conflict":
      return "Le prix a été modifié entre-temps. Rechargez la page et recommencez.";
    case "no_change":
      return "Le prix et la mention « démonstration » sont déjà ceux-là.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

export async function findAccountAction(_prev: AccountLookupState, formData: FormData): Promise<AccountLookupState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const identifier = formData.get("identifier");
  if (typeof identifier !== "string" || identifier.trim().length === 0) return { error: mapError("identifier_invalid") };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_find_account", { p_identifier: identifier });
  if (error) return { error: mapError(error.message) };
  const row = (Array.isArray(data) ? data[0] : data) as FoundAccount | undefined;
  return { found: row ?? null };
}

export async function setLicenseOfferAction(_prev: LicenseOfferState, formData: FormData): Promise<LicenseOfferState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const price = formData.get("price_fcfa");
  const expected = Number(formData.get("expected_price_fcfa"));
  if (typeof price !== "string" || !Number.isSafeInteger(expected)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_set_license_offer", {
    p_price_fcfa: price,
    p_price_is_demo: formData.get("price_is_demo") === "on",
    p_expected_price_fcfa: expected,
  });
  if (error) return { error: mapError(error.message) };
  const row = (Array.isArray(data) ? data[0] : data) as { price_fcfa: number; price_is_demo: boolean };
  revalidatePath("/admin/licences");
  return { ok: true, price: Number(row.price_fcfa), isDemo: row.price_is_demo };
}
