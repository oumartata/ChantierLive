"use server";

import { redirect } from "next/navigation";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

export type CreateDraftState = { error: string } | null;

export type UpdateDraftState = { error: string; conflict?: boolean } | null;

const INT4_MAX = 2147483647;
// BigInt(...) plutôt que le suffixe littéral `n` : la syntaxe littérale
// exige ES2020, hors de portée de ce correctif ciblé (tsconfig cible ES2017).
const BIGINT_MIN = BigInt("-9223372036854775808");
const BIGINT_MAX = BigInt("9223372036854775807");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Traduit les messages d'erreur bruts des RPC M004b (create_draft_project,
// update_draft_project) en texte destiné à l'utilisateur. Le message de
// conflit de révision est celui explicitement retenu par le fondateur.
function mapRpcError(message: string | undefined): string {
  switch (message) {
    case "name_required":
      return "Le nom du chantier est obligatoire.";
    case "country_required":
      return "Le pays est obligatoire.";
    case "invalid_initial_role":
      return "Rôle initial invalide.";
    case "organization_choice_required":
      return "Plusieurs espaces professionnels existent pour ce compte : veuillez en choisir un.";
    case "organization_not_owned_or_archived":
      return "Cet espace professionnel n'est pas disponible.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'avez pas accès à ce chantier.";
    case "not_draft":
      return "Ce chantier n'est plus en brouillon et ne peut plus être modifié depuis cette page.";
    case "revision_conflict":
      return "Ce chantier a été modifié depuis votre ouverture. Vos modifications n'ont pas été enregistrées. Rechargez les données avant de réessayer.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

type FieldResult<T> = { ok: true; value: T } | { ok: false };

// Base de toute validation de champ texte : un champ FormData peut être
// absent (null), une chaîne, ou un File (si un client détourné soumet un
// fichier sous le nom d'un champ texte). Seule une vraie chaîne est
// acceptée ici — jamais de String(...) qui transformerait silencieusement
// un File en "[object File]". Absent ou File -> échec explicite.
function requireString(value: FormDataEntryValue | null): FieldResult<string> {
  if (typeof value !== "string") {
    return { ok: false };
  }
  return { ok: true, value };
}

// Champ facultatif : absent ou File -> échec (aucun RPC). Chaîne, même
// vide -> succès ; chaîne vide (après trim) -> NULL, la seule façon
// d'effacer un champ facultatif.
function parseOptionalText(value: FormDataEntryValue | null): FieldResult<string | null> {
  const text = requireString(value);
  if (!text.ok) return text;
  const trimmed = text.value.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

// Champ requis : absent, File, ou chaîne vide -> échec. Jamais NULL.
function requireNonEmptyText(value: FormDataEntryValue | null): FieldResult<string> {
  const text = parseOptionalText(value);
  if (!text.ok) return text;
  if (text.value === null) return { ok: false };
  return { ok: true, value: text.value };
}

function parseRole(value: FormDataEntryValue | null): FieldResult<"OWNER" | "CONTRACTOR"> {
  const text = requireNonEmptyText(value);
  if (!text.ok) return text;
  if (text.value !== "OWNER" && text.value !== "CONTRACTOR") {
    return { ok: false };
  }
  return { ok: true, value: text.value };
}

function requireUuid(value: FormDataEntryValue | null): FieldResult<string> {
  const text = requireNonEmptyText(value);
  if (!text.ok) return text;
  if (!UUID_RE.test(text.value)) return { ok: false };
  return { ok: true, value: text.value };
}

function parseOptionalUuid(value: FormDataEntryValue | null): FieldResult<string | null> {
  const text = parseOptionalText(value);
  if (!text.ok) return text;
  if (text.value === null) return { ok: true, value: null };
  if (!UUID_RE.test(text.value)) return { ok: false };
  return { ok: true, value: text.value };
}

// Champ facultatif : absent/File -> échec ; vide -> NULL (autorisé) ;
// saisie non vide non numérique -> échec explicite, jamais convertie en
// NULL silencieusement.
function parseOptionalFiniteNumber(value: FormDataEntryValue | null): FieldResult<number | null> {
  const text = parseOptionalText(value);
  if (!text.ok) return text;
  if (text.value === null) return { ok: true, value: null };
  const parsed = Number(text.value);
  if (!Number.isFinite(parsed)) return { ok: false };
  return { ok: true, value: parsed };
}

function parseOptionalLatitude(value: FormDataEntryValue | null): FieldResult<number | null> {
  const result = parseOptionalFiniteNumber(value);
  if (!result.ok) return result;
  if (result.value !== null && (result.value < -90 || result.value > 90)) {
    return { ok: false };
  }
  return result;
}

function parseOptionalLongitude(value: FormDataEntryValue | null): FieldResult<number | null> {
  const result = parseOptionalFiniteNumber(value);
  if (!result.ok) return result;
  if (result.value !== null && (result.value < -180 || result.value > 180)) {
    return { ok: false };
  }
  return result;
}

// Format exact attendu de <input type="date"> (YYYY-MM-DD), avec
// vérification qu'il s'agit d'une date réelle (rejette par exemple
// "2024-02-30") via un aller-retour Date sans dérive de composants.
function parseOptionalDate(value: FormDataEntryValue | null): FieldResult<string | null> {
  const text = parseOptionalText(value);
  if (!text.ok) return text;
  if (text.value === null) return { ok: true, value: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.value);
  if (!match) {
    return { ok: false };
  }
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const roundTrips =
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d);
  if (!roundTrips) {
    return { ok: false };
  }
  return { ok: true, value: text.value };
}

// expected_revision : jamais facultatif. Absent, File, chaîne vide, non
// entière, négative ou hors plage SQL integer -> échec, aucun cas traité
// comme "pas de contrainte de révision".
function parseRequiredRevision(value: FormDataEntryValue | null): FieldResult<number> {
  const text = requireNonEmptyText(value);
  if (!text.ok) return text;
  if (!/^\d+$/.test(text.value)) {
    return { ok: false };
  }
  const parsed = Number(text.value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > INT4_MAX) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

// budget (bigint côté SQL) : Number perd en précision au-delà de 2^53-1,
// bien en-deçà de la plage bigint. La valeur est validée en tant que chaîne
// décimale (signe optionnel + chiffres) via BigInt (précision exacte, pas
// de conversion Number), puis transmise au RPC comme chaîne — PostgREST/
// Postgres l'interprète nativement en bigint sans jamais passer par un
// nombre JS. Champ vide -> NULL ; saisie non vide invalide -> échec.
function parseOptionalBigintString(value: FormDataEntryValue | null): FieldResult<string | null> {
  const text = parseOptionalText(value);
  if (!text.ok) return text;
  if (text.value === null) return { ok: true, value: null };
  if (!/^-?\d+$/.test(text.value)) {
    return { ok: false };
  }
  let big: bigint;
  try {
    big = BigInt(text.value);
  } catch {
    return { ok: false };
  }
  if (big < BIGINT_MIN || big > BIGINT_MAX) {
    return { ok: false };
  }
  return { ok: true, value: big.toString() };
}

// FR017/AC017 : précondition "utilisateur vérifié" — premier appelant réel
// du garde-fou B013, avant même d'atteindre le RPC (qui revérifie aussi côté
// SQL, indépendamment de cet appel).
export async function createDraftProject(
  _prevState: CreateDraftState,
  formData: FormData
): Promise<CreateDraftState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) {
    return { error: guard.message };
  }

  const role = parseRole(formData.get("role"));
  if (!role.ok) {
    return { error: "Rôle initial invalide." };
  }
  const name = requireNonEmptyText(formData.get("name"));
  if (!name.ok) {
    return { error: "Le nom du chantier est obligatoire." };
  }
  const country = requireNonEmptyText(formData.get("country"));
  if (!country.ok) {
    return { error: "Le pays est obligatoire." };
  }
  const organizationId = parseOptionalUuid(formData.get("organization_id"));
  if (!organizationId.ok) {
    return { error: "Espace professionnel invalide." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_draft_project", {
    p_name: name.value,
    p_country: country.value,
    p_role: role.value,
    p_organization_id: organizationId.value,
    p_organization_name: null,
  });

  if (error) {
    return { error: mapRpcError(error.message) };
  }

  // La réponse doit contenir une ligne avec un identifiant de chantier
  // valide avant toute utilisation : jamais d'accès direct à .project_id
  // sur une valeur non vérifiée. En cas d'anomalie, erreur contrôlée —
  // aucune nouvelle tentative de création automatique.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.project_id !== "string" || !UUID_RE.test(row.project_id)) {
    return { error: "Le chantier a peut-être été créé, mais la réponse est invalide. Consultez votre liste de chantiers." };
  }

  redirect(`/chantiers/${row.project_id}/modifier`);
}

// Formulaire complet à chaque appel (voir update_draft_project, M004b) :
// tous les champs sont explicitement vérifiés présents et de type chaîne
// avant toute conversion — un champ absent ou un File soumis à la place du
// texte est refusé sans jamais atteindre le RPC. Pour les champs
// facultatifs, seule une chaîne vide devient NULL (efface le champ) ;
// jamais un COALESCE côté serveur qui empêcherait l'effacement, et jamais
// une valeur non vide mais invalide convertie en effacement silencieux.
export async function updateDraftProject(
  _prevState: UpdateDraftState,
  formData: FormData
): Promise<UpdateDraftState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) {
    return { error: guard.message };
  }

  const projectId = requireUuid(formData.get("project_id"));
  if (!projectId.ok) {
    return { error: "Identifiant de chantier invalide." };
  }
  const revision = parseRequiredRevision(formData.get("expected_revision"));
  if (!revision.ok) {
    return { error: "Révision attendue manquante ou invalide. Rechargez la page." };
  }
  const name = requireNonEmptyText(formData.get("name"));
  if (!name.ok) {
    return { error: "Le nom du chantier est obligatoire." };
  }
  const country = requireNonEmptyText(formData.get("country"));
  if (!country.ok) {
    return { error: "Le pays est obligatoire." };
  }
  const address = parseOptionalText(formData.get("address"));
  if (!address.ok) {
    return { error: "Adresse invalide." };
  }
  const latitude = parseOptionalLatitude(formData.get("latitude"));
  if (!latitude.ok) {
    return { error: "Latitude invalide (nombre entre -90 et 90 attendu)." };
  }
  const longitude = parseOptionalLongitude(formData.get("longitude"));
  if (!longitude.ok) {
    return { error: "Longitude invalide (nombre entre -180 et 180 attendu)." };
  }
  const plannedStartDate = parseOptionalDate(formData.get("planned_start_date"));
  if (!plannedStartDate.ok) {
    return { error: "Date de début invalide." };
  }
  const plannedEndDate = parseOptionalDate(formData.get("planned_end_date"));
  if (!plannedEndDate.ok) {
    return { error: "Date de fin invalide." };
  }
  const budget = parseOptionalBigintString(formData.get("budget"));
  if (!budget.ok) {
    return { error: "Budget invalide (nombre entier attendu)." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_draft_project", {
    p_project_id: projectId.value,
    p_expected_revision: revision.value,
    p_name: name.value,
    p_country: country.value,
    p_address: address.value,
    p_latitude: latitude.value,
    p_longitude: longitude.value,
    p_planned_start_date: plannedStartDate.value,
    p_planned_end_date: plannedEndDate.value,
    p_budget: budget.value,
  });

  if (error) {
    // Ne jamais réessayer automatiquement avec une nouvelle révision : en
    // cas de conflit, l'état retourné laisse le formulaire tel quel — les
    // champs sont contrôlés (useState figé au montage, voir
    // ModifierChantierForm), la saisie et la révision attendue restent donc
    // inchangées côté client ; seul un rechargement manuel de la page relit
    // la révision réelle.
    return {
      error: mapRpcError(error.message),
      conflict: error.message === "revision_conflict",
    };
  }

  redirect(`/chantiers/${projectId.value}/modifier?enregistre=1`);
}
