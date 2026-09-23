"use server";

import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

export type CreateInvitationState =
  | {
      error: string;
    }
  | {
      role: "OWNER" | "CONTRACTOR" | "SITE_MANAGER";
      ownerProfile: "PRIMARY" | "CO_OWNER" | null;
      expiresAt: string;
      token: string;
    }
  | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Traduit les codes d'erreur bruts de create_invitation (M006) en texte
// destiné à l'utilisateur. Même principe que mapRpcError (src/app/chantiers/
// actions.ts) : jamais un message générique masquant une cause distincte,
// jamais un détail qui révélerait une information non autorisée (voir
// 'not_authorized', générique par construction côté SQL).
function mapRpcError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'avez pas accès à ce chantier.";
    case "role_not_allowed_for_sender":
      return "Vous ne pouvez pas proposer ce rôle depuis votre adhésion actuelle.";
    case "quota_exceeded":
      return "Le nombre maximal d'invitations pour ce rôle est déjà atteint sur ce chantier.";
    case "target_kind_required":
      return "Précisez le type d'identifiant (e-mail ou téléphone) si vous renseignez une cible.";
    case "target_value_required":
      return "Saisissez l'identifiant de la personne invitée, ou laissez les deux champs vides.";
    case "target_value_invalid":
      return "Identifiant invalide (format e-mail ou téléphone international attendu).";
    case "project_id_required":
      return "Chantier invalide.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

type FieldResult<T> = { ok: true; value: T } | { ok: false };

// Mêmes primitives de validation que src/app/chantiers/actions.ts (B014) :
// un champ FormData peut être absent, une chaîne, ou un File détourné —
// jamais un String(...) implicite qui masquerait un File.
function requireString(value: FormDataEntryValue | null): FieldResult<string> {
  if (typeof value !== "string") return { ok: false };
  return { ok: true, value };
}

function parseOptionalText(value: FormDataEntryValue | null): FieldResult<string | null> {
  const text = requireString(value);
  if (!text.ok) return text;
  const trimmed = text.value.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

function requireUuid(value: FormDataEntryValue | null): FieldResult<string> {
  const text = requireString(value);
  if (!text.ok) return text;
  if (!UUID_RE.test(text.value)) return { ok: false };
  return { ok: true, value: text.value };
}

function parseRequestedRole(
  value: FormDataEntryValue | null
): FieldResult<"OWNER" | "CONTRACTOR" | "SITE_MANAGER"> {
  const text = requireString(value);
  if (!text.ok) return text;
  if (text.value !== "OWNER" && text.value !== "CONTRACTOR" && text.value !== "SITE_MANAGER") {
    return { ok: false };
  }
  return { ok: true, value: text.value };
}

function parseOptionalTargetKind(value: FormDataEntryValue | null): FieldResult<"EMAIL" | "PHONE" | null> {
  const text = parseOptionalText(value);
  if (!text.ok) return text;
  if (text.value === null) return { ok: true, value: null };
  if (text.value !== "EMAIL" && text.value !== "PHONE") return { ok: false };
  return { ok: true, value: text.value };
}

// Formulaire complet : cible et type de cible sont soit tous les deux vides,
// soit tous les deux renseignés — jamais l'un sans l'autre côté client (le
// RPC revérifie indépendamment, voir target_kind_required/target_value_required).
export async function createInvitation(
  _prevState: CreateInvitationState,
  formData: FormData
): Promise<CreateInvitationState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) {
    return { error: guard.message };
  }

  const projectId = requireUuid(formData.get("project_id"));
  if (!projectId.ok) {
    return { error: "Chantier invalide." };
  }

  const role = parseRequestedRole(formData.get("role"));
  if (!role.ok) {
    return { error: "Rôle demandé invalide." };
  }

  const targetKind = parseOptionalTargetKind(formData.get("target_kind"));
  if (!targetKind.ok) {
    return { error: "Type d'identifiant invalide." };
  }

  const targetValue = parseOptionalText(formData.get("target_value"));
  if (!targetValue.ok) {
    return { error: "Identifiant de la personne invitée invalide." };
  }

  if ((targetKind.value === null) !== (targetValue.value === null)) {
    return { error: "Renseignez le type ET la valeur de l'identifiant, ou laissez les deux vides." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_invitation", {
    p_project_id: projectId.value,
    p_role: role.value,
    p_target_kind: targetKind.value,
    p_target_value_raw: targetValue.value,
  });

  if (error) {
    return { error: mapRpcError(error.message) };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.token !== "string" || row.token.length === 0) {
    return { error: "L'invitation a peut-être été créée, mais la réponse est invalide. Rechargez la page." };
  }

  // Le jeton en clair n'est renvoyé qu'une seule fois par le RPC : jamais
  // reconstitué ni relu ensuite (seul son hash existe en base). Aucun log
  // applicatif ne doit jamais l'inclure — voir aussi Cache-Control/Referrer-
  // Policy sur /invitations/[token] (src/proxy.ts).
  return {
    role: row.role,
    ownerProfile: row.owner_profile ?? null,
    expiresAt: row.expires_at,
    token: row.token,
  };
}
