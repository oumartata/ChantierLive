// B051 (M051 ; D197) — libellés de l'accès support, partagés par l'espace du
// chantier et l'administration. La liste des modules est celle acceptée par
// la base (support_normalize_modules) : jamais les finances internes ni
// l'audit du chantier (D197 S5, D195 E6).

export const SUPPORT_MODULES: { value: string; label: string }[] = [
  { value: "JOURNAL", label: "Journal publié" },
  { value: "INCIDENTS", label: "Incidents" },
  { value: "PHOTOS", label: "Photos publiées" },
  { value: "DOCUMENTS", label: "Documents (selon votre visibilité)" },
  { value: "AVANCEMENT", label: "Avancement et étapes" },
  { value: "COMMENTAIRES", label: "Commentaires" },
  { value: "EQUIPE", label: "Équipe (rôles seulement)" },
];

export const SUPPORT_CATEGORIES: { value: string; label: string }[] = [
  { value: "TECHNIQUE", label: "Problème technique" },
  { value: "ACCES", label: "Accès ou compte" },
  { value: "DONNEES", label: "Données du chantier" },
  { value: "AUTRE", label: "Autre" },
];

export const SUPPORT_DURATIONS = [15, 30, 60] as const;

export const moduleLabel = (m: string) => SUPPORT_MODULES.find((x) => x.value === m)?.label ?? m;
export const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find((x) => x.value === c)?.label ?? c;
export const partyLabel = (p: string | null) => (p === "CONTRACTOR" ? "entreprise" : p === "OWNER_PRIMARY" ? "propriétaire principal" : "—");

export const SUPPORT_STATUS: Record<string, string> = { OPEN: "En attente", TAKEN: "Pris en charge", CLOSED: "Clos" };

export const SUPPORT_ACTIONS: Record<string, string> = {
  REQUEST_CREATED: "Demande d'aide ouverte",
  ACCESS_GRANTED: "Accès accordé",
  REQUEST_TAKEN: "Demande prise en charge",
  REQUEST_VIEWED: "Demande lue par le support",
  ACCESS_READ: "Lecture",
  FILE_OPENED: "Fichier ouvert",
  ACCESS_DENIED: "Lecture refusée",
  ACCESS_REVOKED: "Accès arrêté",
  ACCESS_EXPIRED: "Accès expiré",
  REQUEST_CLOSED: "Demande close",
};

export const SUPPORT_REFUSALS: Record<string, string> = {
  grant_not_found: "accord introuvable",
  not_assigned: "demande prise en charge par un autre administrateur ou non prise en charge",
  request_closed: "demande close",
  access_revoked: "accès arrêté",
  access_expired: "accès expiré",
  out_of_scope: "module non accordé",
  object_not_found: "élément non accessible",
};

export const supportStamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";
