// Libellés des incidents (D159 gravité, D160 type, STATE_MACHINES incident).
import type { StatusChipVariant } from "@/components/ui/StatusChip";

export const INCIDENT_TYPES: { value: string; label: string }[] = [
  { value: "SECURITE", label: "Sécurité" },
  { value: "MALFACON", label: "Malfaçon ou qualité" },
  { value: "RETARD", label: "Retard" },
  { value: "MATERIAUX", label: "Matériaux" },
  { value: "INTEMPERIES", label: "Intempéries" },
  { value: "AUTRE", label: "Autre" },
];

export const SEVERITIES: { value: string; label: string; chip: StatusChipVariant }[] = [
  { value: "FAIBLE", label: "Faible", chip: "neutral" },
  { value: "MOYENNE", label: "Moyenne", chip: "info" },
  { value: "ELEVEE", label: "Élevée", chip: "attention" },
  { value: "URGENTE", label: "Urgente", chip: "danger" },
];

export const STATUS: Record<string, { label: string; chip: StatusChipVariant }> = {
  OUVERT: { label: "Ouvert", chip: "attention" },
  AFFECTE: { label: "Affecté", chip: "info" },
  EN_COURS: { label: "En cours", chip: "info" },
  RESOLU: { label: "Résolu", chip: "success" },
  CLOS: { label: "Clos", chip: "neutral" },
  ANNULE: { label: "Annulé", chip: "neutral" },
};

export const typeLabel = (v: string) => INCIDENT_TYPES.find((t) => t.value === v)?.label ?? v;
export const severityOf = (v: string) => SEVERITIES.find((s) => s.value === v) ?? { value: v, label: v, chip: "neutral" as const };

export function roleLabel(role: string | null, ownerProfile: string | null): string {
  if (role === "CONTRACTOR") return "Entreprise";
  if (role === "SITE_MANAGER") return "Chef de chantier";
  if (role === "OWNER") return ownerProfile === "CO_OWNER" ? "Copropriétaire" : "Propriétaire";
  return "Ancien membre";
}

// Heure de Bamako (UTC, sans heure d'été).
export function formatStamp(ts: string) {
  return new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";
}
export function formatDay(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
}
// Valeur d'un champ datetime-local (heure UTC).
export const toLocalInput = (ts: string) => new Date(ts).toISOString().slice(0, 16);
