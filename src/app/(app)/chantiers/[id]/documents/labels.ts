// Libellés des documents (BR064/D175, D169).

export const DOCUMENT_TYPES: { value: string; label: string }[] = [
  { value: "PLAN", label: "Plan" },
  { value: "DEVIS", label: "Devis" },
  { value: "CONTRAT", label: "Contrat" },
  { value: "RECU", label: "Reçu" },
  { value: "FACTURE", label: "Facture" },
  { value: "AUTORISATION", label: "Autorisation" },
  { value: "RAPPORT", label: "Rapport" },
  { value: "PROCES_VERBAL", label: "Procès-verbal" },
  { value: "AUTRE", label: "Autre" },
];
export const typeLabel = (v: string) => DOCUMENT_TYPES.find((t) => t.value === v)?.label ?? v;

// D175 : copies sans effet sur les modules qui les gèrent déjà.
export const COPY_NOTICE: Record<string, string> = {
  PLAN: "Copie déposée : sans effet sur les plans du chantier.",
  DEVIS: "Copie déposée : sans effet sur le devis du chantier.",
  RECU: "Copie déposée : sans effet sur les acomptes du chantier.",
};

// D169 : qui voit le document ; texte repris dans la confirmation de
// publication (D173).
export const VISIBILITY: Record<string, { label: string; audience: string }> = {
  TOUS: { label: "Tous les membres", audience: "tous les membres actifs du chantier : l'entreprise, le propriétaire, le copropriétaire et le chef de chantier" },
  PRINCIPAUX: { label: "Rôles principaux", audience: "l'entreprise, le propriétaire et le copropriétaire — pas le chef de chantier" },
  ENTREPRISE: { label: "Entreprise seulement", audience: "l'entreprise seulement — jamais le propriétaire, le copropriétaire ni le chef de chantier" },
};

const KIND: Record<string, string> = { "application/pdf": "PDF", "image/jpeg": "Image JPEG", "image/png": "Image PNG", "image/webp": "Image WebP" };
export const fileKindLabel = (mime: string | null) => (mime ? KIND[mime] ?? "Fichier" : "—");

export function partyLabel(role: string): string {
  return role === "CONTRACTOR" ? "Entreprise" : role === "OWNER_PRIMARY" ? "Propriétaire" : role;
}

export function formatStamp(ts: string) {
  return new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";
}
