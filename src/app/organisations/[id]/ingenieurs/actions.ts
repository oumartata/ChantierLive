"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Traduit les codes d'erreur bruts de designate_plan_engineer/revoke_plan_engineer_designation
// (M023) en texte destiné à l'utilisateur — même principe que equipe/actions.ts.
// 'not_authorized' couvre volontairement une organisation/désignation inexistante
// ET hors périmètre de l'appelant, jamais de détail qui distinguerait les deux.
function mapEngineerRpcError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à effectuer cette action.";
    case "identifier_required":
      return "Indiquez l'e-mail ou le téléphone de l'ingénieur.";
    case "engineer_not_found_or_unverified":
      return "Aucun compte vérifié ne correspond à cet identifiant.";
    case "already_designated":
      return "Cet ingénieur est déjà désigné pour cette organisation.";
    case "already_revoked":
      return "Cette désignation est déjà révoquée.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

type FieldResult<T> = { ok: true; value: T } | { ok: false };

function requireUuid(value: FormDataEntryValue | null): FieldResult<string> {
  if (typeof value !== "string" || !UUID_RE.test(value)) return { ok: false };
  return { ok: true, value };
}

function requireNonEmptyText(value: FormDataEntryValue | null): FieldResult<string> {
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false };
  return { ok: true, value: trimmed };
}

export type IngenieursActionState = { error: string } | null;

// B062 : désignation par le propriétaire de l'organisation (D092). Le type
// d'identifiant (EMAIL/PHONE) n'est jamais demandé explicitement à
// l'utilisateur — un seul champ, inféré ici par la présence de "@" (même
// forme canonique que profile_identifiers_email_canonical, M002) : évite
// d'ajouter un contrôle de sélection au formulaire pour ce lot minimal.
// Aucun annuaire : designate_plan_engineer résout l'identifiant EN INTERNE,
// jamais une recherche exposée côté client.
export async function designateEngineerAction(
  _prevState: IngenieursActionState,
  formData: FormData
): Promise<IngenieursActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) {
    return { error: guard.message };
  }

  const organizationId = requireUuid(formData.get("organization_id"));
  const identifier = requireNonEmptyText(formData.get("identifier"));
  if (!organizationId.ok) {
    return { error: "Requête invalide." };
  }
  if (!identifier.ok) {
    return { error: "Indiquez l'e-mail ou le téléphone de l'ingénieur." };
  }

  const kind = identifier.value.includes("@") ? "EMAIL" : "PHONE";

  const supabase = await createClient();
  const { error } = await supabase.rpc("designate_plan_engineer", {
    p_organization_id: organizationId.value,
    p_identifier_kind: kind,
    p_identifier_value: identifier.value,
  });

  if (error) {
    return { error: mapEngineerRpcError(error.message) };
  }

  revalidatePath(`/organisations/${organizationId.value}/ingenieurs`);
  return null;
}

// B062 : révocation par le propriétaire de l'organisation (D092) — jamais une
// suppression, revoke_plan_engineer_designation (M023) marque revoked_at.
export async function revokeEngineerAction(
  _prevState: IngenieursActionState,
  formData: FormData
): Promise<IngenieursActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) {
    return { error: guard.message };
  }

  const organizationId = requireUuid(formData.get("organization_id"));
  const designationId = requireUuid(formData.get("designation_id"));
  if (!organizationId.ok || !designationId.ok) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_plan_engineer_designation", {
    p_designation_id: designationId.value,
  });

  if (error) {
    return { error: mapEngineerRpcError(error.message) };
  }

  revalidatePath(`/organisations/${organizationId.value}/ingenieurs`);
  return null;
}
