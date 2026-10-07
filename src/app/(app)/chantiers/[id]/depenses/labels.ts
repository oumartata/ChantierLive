import type { StatusChipVariant } from "@/components/ui";

// B031 (M045) — libellés des dépenses internes.

export const CATEGORIES = [
  { value: "MATERIAUX", label: "Matériaux" },
  { value: "MAIN_OEUVRE", label: "Main-d'œuvre" },
  { value: "TRANSPORT", label: "Transport" },
  { value: "LOCATION_MATERIEL", label: "Location de matériel" },
  { value: "SOUS_TRAITANCE", label: "Sous-traitance" },
  { value: "FRAIS_DIVERS", label: "Frais divers" },
  { value: "AUTRE", label: "Autre" },
];

export const categoryLabel = (c: string | null) => CATEGORIES.find((x) => x.value === c)?.label ?? "—";

export const STATUS: Record<string, { label: string; chip: StatusChipVariant }> = {
  BROUILLON: { label: "Brouillon", chip: "neutral" },
  SOUMISE: { label: "En attente de décision", chip: "attention" },
  APPROUVEE: { label: "Approuvée", chip: "success" },
  REFUSEE: { label: "Refusée", chip: "danger" },
  CONTESTEE: { label: "Contestée", chip: "attention" },
  ANNULEE: { label: "Annulée", chip: "neutral" },
};

export const DECISION_LABEL: Record<string, string> = {
  SOUMISE: "Soumise à l'entreprise",
  APPROUVEE: "Approuvée",
  REFUSEE: "Refusée",
  CONTESTEE: "Contestée",
  CORRIGEE: "Corrigée (nouvelle version)",
  ANNULEE: "Annulée",
};

export const roleLabel = (r: string) => (r === "CONTRACTOR" ? "l'entreprise" : "le chef de chantier");
