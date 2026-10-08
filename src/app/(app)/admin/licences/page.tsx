import { notFound, redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState, StatusChip, type StatusChipVariant } from "@/components/ui";
import { formatFcfa } from "@/lib/entreprise/chantierSummary";
import { ActivateForm, RejectForm } from "./AdminLicenseForms";

// SCR062 « Licences à vérifier » — B049 (M049, M049b ; D194). Réservée à
// l'administrateur de plateforme : tout autre compte obtient une page
// introuvable. Métadonnées minimales seulement (A9) : identifiant court du
// chantier, rôle du déclarant, montant, opérateur, référence, date, nom du
// payeur ; jamais le nom ou l'adresse du chantier ni l'identité des membres.
// La preuve s'ouvre par /admin/licences/preuve/[id], lecture auditée.

interface Row {
  payment_id: string;
  project_ref: string;
  license_status: string;
  declared_role: string;
  amount_fcfa: number | string;
  operator: string;
  payment_reference: string;
  paid_on: string;
  payer_name: string | null;
  offer_label: string;
  offer_price_fcfa: number | string;
  offer_price_is_demo: boolean;
  proof_mime_type: string;
  status: string;
  declared_at_server: string;
  decided_at_server: string | null;
  decision_note: string | null;
  other_pending_on_project: number;
}

const ROLE: Record<string, string> = { CONTRACTOR: "Entreprise", OWNER_PRIMARY: "Propriétaire principal" };
const OPERATOR: Record<string, string> = { ORANGE_MONEY: "Orange Money", MOOV_MONEY: "Moov Money", OTHER: "Autre" };
const STATUS: Record<string, { label: string; chip: StatusChipVariant }> = {
  PENDING_REVIEW: { label: "À vérifier", chip: "attention" },
  ACTIVATED: { label: "Activée", chip: "success" },
  REJECTED: { label: "Rejetée", chip: "danger" },
  CANCELLED: { label: "Annulée par le déclarant", chip: "neutral" },
};
const LICENSE: Record<string, string> = { NONE: "aucune", PENDING: "en attente", ACTIVE: "active", EXPIRING: "bientôt expirée", GRACE: "en grâce", READ_ONLY: "lecture seule" };
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

export default async function AdminLicensesPage() {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) notFound();
  const { data, error } = await supabase.rpc("list_license_payments_for_review", { p_include_decided: true });
  if (error) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Licences à vérifier</h1>
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      </div>
    );
  }
  const rows = (data ?? []) as Row[];
  const pending = rows.filter((r) => r.status === "PENDING_REVIEW");
  const decided = rows.filter((r) => r.status !== "PENDING_REVIEW").slice(0, 20);

  const card = (r: Row) => {
    const st = STATUS[r.status] ?? { label: r.status, chip: "neutral" as const };
    return (
      <Card key={r.payment_id} className="flex flex-col gap-2" data-testid={`admin-declaration-${r.payment_id}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-h2 font-semibold text-ink">{formatFcfa(String(r.amount_fcfa))}</p>
          <StatusChip variant={st.chip} label={st.label} />
        </div>
        <dl className="grid grid-cols-1 gap-1 text-caption text-muted sm:grid-cols-2">
          <div>
            <dt className="inline font-semibold">Chantier : </dt>
            <dd className="inline font-mono">{r.project_ref}</dd> (licence {LICENSE[r.license_status] ?? r.license_status})
          </div>
          <div>
            <dt className="inline font-semibold">Déclarant : </dt>
            <dd className="inline">{ROLE[r.declared_role] ?? r.declared_role}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">Paiement : </dt>
            <dd className="inline break-words">
              {OPERATOR[r.operator] ?? r.operator}, référence {r.payment_reference}, le {day(r.paid_on)}
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Payeur : </dt>
            <dd className="inline break-words">{r.payer_name ?? "non indiqué"}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">Formule : </dt>
            <dd className="inline">
              {r.offer_label}, {formatFcfa(String(r.offer_price_fcfa))}
              {r.offer_price_is_demo ? " (prix de démonstration)" : ""}
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Déclarée le : </dt>
            <dd className="inline">{stamp(r.declared_at_server)}</dd>
          </div>
        </dl>
        {r.other_pending_on_project > 0 && r.status === "PENDING_REVIEW" ? (
          <p className="text-caption font-semibold text-ink">Autre déclaration en attente pour ce chantier : {r.other_pending_on_project}. Une seule licence est nécessaire.</p>
        ) : null}
        <a href={`/admin/licences/preuve/${r.payment_id}`} target="_blank" rel="noopener noreferrer" className="text-caption font-semibold text-primary underline">
          Ouvrir la preuve ({r.proof_mime_type === "application/pdf" ? "PDF" : "image"}) — lecture enregistrée dans le journal
        </a>
        {r.decided_at_server ? (
          <p className="break-words text-caption text-ink">
            Décidée le {stamp(r.decided_at_server)}
            {r.decision_note ? ` — ${r.decision_note}` : ""}
          </p>
        ) : null}
        {r.status === "PENDING_REVIEW" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <details className="rounded-small border border-muted/30 px-3 py-2">
              <summary className="cursor-pointer text-label font-semibold text-primary">Activer</summary>
              <div className="mt-3">
                <ActivateForm paymentId={r.payment_id} />
              </div>
            </details>
            <details className="rounded-small border border-muted/30 px-3 py-2">
              <summary className="cursor-pointer text-label font-semibold text-primary">Rejeter</summary>
              <div className="mt-3">
                <RejectForm paymentId={r.payment_id} />
              </div>
            </details>
          </div>
        ) : null}
      </Card>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Licences à vérifier</h1>
        <p className="text-body text-muted">
          Administration de la plateforme. Vous voyez seulement les déclarations de paiement et leur preuve, jamais le contenu des chantiers. Activer une
          licence ne donne aucun droit au payeur.
        </p>
      </div>
      <section className="flex flex-col gap-3" data-testid="admin-a-verifier">
        <h2 className="text-h2 font-semibold text-ink">À vérifier ({pending.length})</h2>
        {pending.length === 0 ? <EmptyState title="Rien à vérifier" description="Les nouvelles déclarations de paiement apparaîtront ici." /> : pending.map(card)}
      </section>
      {decided.length > 0 ? (
        <section className="flex flex-col gap-3" data-testid="admin-decidees">
          <h2 className="text-h2 font-semibold text-ink">Dernières décisions</h2>
          {decided.map(card)}
        </section>
      ) : null}
    </div>
  );
}
