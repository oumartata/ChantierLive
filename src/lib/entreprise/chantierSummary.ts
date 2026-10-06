// Espace entreprise — résumé d'UN chantier sélectionné (ESPACES-3/5).
// Fonctions pures qui traduisent les réponses des fonctions EXISTANTES
// (get_project_phase_plan M033, list_advance_payments M014,
// get_project_financial_summary M028) en états d'affichage, en distinguant
// toujours : lecture impossible, information absente, zéro. Aucun calcul
// nouveau : les montants et pourcentages sont ceux du serveur, jamais
// recalculés ni agrégés entre chantiers.

type RpcResult<T> = { data: T | null; error: unknown };

const NBSP = " ";
const PERCENT = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

// Montants reçus en texte (bigint côté serveur) : formatés via BigInt.
export function formatFcfa(amount: string | null | undefined): string | null {
  if (amount === null || amount === undefined || !/^-?\d+$/.test(amount)) return null;
  return `${BigInt(amount).toLocaleString("fr-FR")}${NBSP}FCFA`;
}

export type ProgressSummary =
  | { kind: "error" }
  | { kind: "absent" }
  | { kind: "published"; percent: string; lastEventAt: string | null; lastEventBy: "l'entreprise" | "le chef de chantier" | null };

export function progressSummary(res: RpcResult<unknown>): ProgressSummary {
  if (res.error) return { kind: "error" };
  const plan = (Array.isArray(res.data) ? res.data[0] : res.data) as Record<string, unknown> | null | undefined;
  if (!plan || typeof plan !== "object") return { kind: "error" };
  // Brouillon ou absent : aucun pourcentage n'existe encore (jamais « 0 % »).
  if (plan.status !== "PUBLIE") return { kind: "absent" };
  const value = Number(plan.global_progress);
  if (plan.global_progress === null || plan.global_progress === undefined || !Number.isFinite(value)) return { kind: "error" };
  const by = plan.last_event_by_role === "CONTRACTOR" ? "l'entreprise" : plan.last_event_by_role === "SITE_MANAGER" ? "le chef de chantier" : null;
  return {
    kind: "published",
    percent: `${PERCENT.format(value)}${NBSP}%`,
    lastEventAt: typeof plan.last_event_at === "string" ? plan.last_event_at : null,
    lastEventBy: by,
  };
}

export const PAYMENT_STATUS: Record<string, { label: string; variant: "neutral" | "info" | "success" | "danger" }> = {
  DECLARED: { variant: "info", label: "Déclaré, en attente de confirmation" },
  RECEIVED: { variant: "success", label: "Confirmé par les deux parties" },
  DISPUTED: { variant: "danger", label: "Contesté — exclu de la somme reconnue" },
  CANCELLED: { variant: "neutral", label: "Annulé (contre-écriture)" },
};
const MODE_LABEL: Record<string, string> = { ORANGE_MONEY: "Orange Money", MOOV_MONEY: "Moov Money", CASH: "Espèces", BANK: "Virement bancaire", OTHER: "Autre" };

export interface PaymentLine {
  id: string;
  amount: string;
  date: string;
  mode: string;
  declaredBy: "le client" | "l'entreprise";
  status: { label: string; variant: "neutral" | "info" | "success" | "danger" };
  hasReceipt: boolean;
}

export type PaymentsSummary = { kind: "error" } | { kind: "empty" } | { kind: "list"; items: PaymentLine[] };

export function paymentsSummary(res: RpcResult<unknown>): PaymentsSummary {
  if (res.error || !Array.isArray(res.data)) return { kind: "error" };
  if (res.data.length === 0) return { kind: "empty" };
  const items: PaymentLine[] = [];
  for (const raw of res.data as Record<string, unknown>[]) {
    const amount = formatFcfa(raw.amount_fcfa as string);
    const status = PAYMENT_STATUS[raw.status as string];
    if (!amount || !status) return { kind: "error" };
    items.push({
      id: String(raw.advance_id),
      amount,
      date: String(raw.external_payment_date),
      mode: MODE_LABEL[raw.mode as string] ?? String(raw.mode),
      declaredBy: raw.declared_role === "CONTRACTOR" ? "l'entreprise" : "le client",
      status,
      hasReceipt: raw.has_receipt === true,
    });
  }
  return { kind: "list", items };
}

export type FinanceSummary =
  | { kind: "error" }
  | {
      kind: "ok";
      // null = aucun devis accepté : prix convenu non établi (jamais 0).
      contract: string | null;
      recognized: string;
      recognizedCount: number;
      pending: string;
      pendingCount: number;
      remainingDue: string | null;
    };

export function financeSummary(res: RpcResult<unknown>): FinanceSummary {
  if (res.error) return { kind: "error" };
  const v = (Array.isArray(res.data) ? res.data[0] : res.data) as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== "object") return { kind: "error" };
  const recognized = formatFcfa(v.recognized_fcfa as string);
  const pending = formatFcfa(v.pending_fcfa as string);
  if (recognized === null || pending === null) return { kind: "error" };
  return {
    kind: "ok",
    contract: formatFcfa(v.contract_amount_fcfa as string | null),
    recognized,
    recognizedCount: Number(v.recognized_count ?? 0),
    pending,
    pendingCount: Number(v.pending_count ?? 0),
    remainingDue: formatFcfa(v.remaining_due_fcfa as string | null),
  };
}
