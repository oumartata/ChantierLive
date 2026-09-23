"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION_CODES = ["PHASE_EDIT_DRAFT", "EXPENSE_PUBLISH", "PHASE_VALIDATE", "APPROVAL_DECIDE"] as const;

// Traduit les codes d'erreur bruts de remove_participant/grant_delegation/
// revoke_delegation (M004c) en texte destiné à l'utilisateur. 'not_authorized'
// couvre volontairement une cible inexistante ET une cible hors périmètre de
// l'appelant — jamais de détail qui distinguerait les deux (même principe
// que revoke_invitation, M006a).
function mapRpcError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à effectuer cette action.";
    case "reason_required":
      return "Un motif est obligatoire pour retirer un participant.";
    case "participant_already_removed":
      return "Ce participant a déjà été retiré.";
    case "beneficiary_not_eligible":
      return "Ce participant ne peut pas recevoir cette délégation.";
    case "active_delegation_exists":
      return "Une délégation active existe déjà pour ce code — révoquez-la avant d'en accorder une nouvelle.";
    case "delegation_already_revoked":
      return "Cette délégation est déjà révoquée.";
    case "invalid_permission_code":
      return "Type de délégation invalide.";
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

function requirePermissionCode(
  value: FormDataEntryValue | null
): FieldResult<(typeof PERMISSION_CODES)[number]> {
  if (typeof value !== "string") return { ok: false };
  if (!(PERMISSION_CODES as readonly string[]).includes(value)) return { ok: false };
  return { ok: true, value: value as (typeof PERMISSION_CODES)[number] };
}

export type EquipeActionState = { error: string } | null;

// B017 : retrait = révocation d'adhésion (remove_participant, M004c), jamais
// une suppression de profil ou de contributions (BR028/FR040). Motif
// obligatoire, revérifié aussi côté RPC (reason_required).
export async function removeParticipantAction(
  _prevState: EquipeActionState,
  formData: FormData
): Promise<EquipeActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) {
    return { error: guard.message };
  }

  const projectId = requireUuid(formData.get("project_id"));
  const membershipId = requireUuid(formData.get("membership_id"));
  const reason = requireNonEmptyText(formData.get("reason"));
  if (!projectId.ok || !membershipId.ok) {
    return { error: "Requête invalide." };
  }
  if (!reason.ok) {
    return { error: "Un motif est obligatoire pour retirer un participant." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_participant", {
    p_membership_id: membershipId.value,
    p_reason: reason.value,
  });

  if (error) {
    return { error: mapRpcError(error.message) };
  }

  revalidatePath(`/chantiers/${projectId.value}/equipe`);
  return null;
}

// B017 : octroi (grant_delegation, M004c) — jamais de champ de motif proposé
// ici, la fonction SQL génère elle-même un motif technique (qui, quoi, à
// qui), jamais une justification utilisateur inventée.
export async function grantDelegationAction(
  _prevState: EquipeActionState,
  formData: FormData
): Promise<EquipeActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) {
    return { error: guard.message };
  }

  const projectId = requireUuid(formData.get("project_id"));
  const membershipId = requireUuid(formData.get("project_membership_id"));
  const permissionCode = requirePermissionCode(formData.get("permission_code"));
  if (!projectId.ok || !membershipId.ok || !permissionCode.ok) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("grant_delegation", {
    p_project_membership_id: membershipId.value,
    p_permission_code: permissionCode.value,
  });

  if (error) {
    return { error: mapRpcError(error.message) };
  }

  revalidatePath(`/chantiers/${projectId.value}/equipe`);
  return null;
}

// B017 : révocation (revoke_delegation, M004c) — autorisée au détenteur
// ACTUEL du rôle délégant, jamais restreinte à granted_by (contrôle côté
// RPC, ce guard applicatif n'est qu'une première ligne).
export async function revokeDelegationAction(
  _prevState: EquipeActionState,
  formData: FormData
): Promise<EquipeActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) {
    return { error: guard.message };
  }

  const projectId = requireUuid(formData.get("project_id"));
  const delegationId = requireUuid(formData.get("delegation_id"));
  if (!projectId.ok || !delegationId.ok) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_delegation", {
    p_delegation_id: delegationId.value,
  });

  if (error) {
    return { error: mapRpcError(error.message) };
  }

  revalidatePath(`/chantiers/${projectId.value}/equipe`);
  return null;
}
