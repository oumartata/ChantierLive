import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, StatusChip } from "@/components/ui";

interface FinancialSummary {
  quote_amount_fcfa: string | null;
  change_orders_amount_fcfa: string | null;
  accepted_change_order_count: number | null;
  contract_amount_fcfa: string | null;
  recognized_count: number;
  recognized_fcfa: string;
  pending_count: number;
  pending_fcfa: string;
  disputed_count: number;
  disputed_fcfa: string;
  cancelled_count: number;
  balance_fcfa: string | null;
  remaining_due_fcfa: string | null;
  overpaid_fcfa: string | null;
  work_start_authorized: boolean;
  work_start_at: string | null;
  start_contract_amount_fcfa: string | null;
  start_advance_required_fcfa: string | null;
  start_advance_recognized_fcfa: string | null;
  current_advance_shortfall_fcfa: string | null;
}

// Montants reçus en texte (numeric côté serveur) : formatés via BigInt, jamais Number.
const fcfa = (amount: string) => `${BigInt(amount).toLocaleString("fr-FR")} FCFA`;

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-body text-muted">{label}</dt>
      <dd className="text-body text-ink text-right" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function Unavailable({ title, explanation }: { title: string; explanation: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Synthèse financière</h1>
      <AlertBanner variant="warning" title={title} explanation={explanation} />
    </div>
  );
}

// B068 (M028) — synthèse financière consolidée (D140-D142, BR112). La RPC
// applique les droits (OWNER/PRIMARY, CO_OWNER, CONTRACTOR, compte vérifié)
// et lit tous les agrégats dans un même instantané ; aucune donnée de budget
// ni de dépense interne. Étapes différées (D141) : AC172 partiellement couvert.
export default async function FinancesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("id, name").eq("id", id).maybeSingle();
  if (!project) {
    return <Unavailable title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />;
  }
  const { data, error } = await supabase.rpc("get_project_financial_summary", { p_project_id: id });
  if (error?.message === "not_authorized" || error?.message === "account_provisional") {
    return <Unavailable title="Accès indisponible" explanation="La synthèse financière est réservée à l'entreprise et aux propriétaires du chantier." />;
  }
  // Lecture fermée : aucune donnée partielle si la lecture échoue.
  const s: FinancialSummary | null = Array.isArray(data) ? data[0] : data;
  if (error || !s) {
    return <Unavailable title="Lecture impossible" explanation="Réessayez plus tard." />;
  }
  const contractDefined = s.contract_amount_fcfa !== null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Synthèse financière — {project.name}</h1>
      <AlertBanner
        variant="information"
        title="Aucun argent détenu"
        explanation="ChantierLive ne détient, ne reçoit ni ne transfère aucun argent. Les paiements reconnus sont des déclarations confirmées par les deux parties."
      />

      <Card className="flex flex-col gap-2">
        <h2 className="text-h2 font-semibold text-ink">Montant contractuel</h2>
        {contractDefined ? (
          <dl className="flex flex-col gap-1">
            <Row label="Devis accepté" value={fcfa(s.quote_amount_fcfa as string)} />
            <Row label={`Avenants acceptés (${s.accepted_change_order_count})`} value={fcfa(s.change_orders_amount_fcfa as string)} />
            <Row label="Montant contractuel" value={fcfa(s.contract_amount_fcfa as string)} testId="contract-amount" />
          </dl>
        ) : (
          <p className="text-body text-muted" data-testid="contract-amount">
            Non défini : aucun devis accepté.
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-h2 font-semibold text-ink">Paiements</h2>
        <dl className="flex flex-col gap-1">
          <Row label={`Reconnus par les deux parties (${s.recognized_count})`} value={fcfa(s.recognized_fcfa)} testId="recognized" />
        </dl>
        <p className="text-caption text-muted">Non comptés dans les paiements reconnus :</p>
        <dl className="flex flex-col gap-1">
          <Row label={`En attente de confirmation (${s.pending_count})`} value={fcfa(s.pending_fcfa)} testId="pending" />
          <Row label={`Contestés (${s.disputed_count})`} value={fcfa(s.disputed_fcfa)} testId="disputed" />
          <Row label="Annulés" value={String(s.cancelled_count)} testId="cancelled" />
        </dl>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-h2 font-semibold text-ink">Solde</h2>
        {contractDefined ? (
          <dl className="flex flex-col gap-1">
            <Row label="Reste dû" value={fcfa(s.remaining_due_fcfa as string)} testId="remaining-due" />
            {s.overpaid_fcfa !== "0" ? <Row label="Trop-perçu (excédent, aucun remboursement)" value={fcfa(s.overpaid_fcfa as string)} testId="overpaid" /> : null}
          </dl>
        ) : (
          <p className="text-body text-muted" data-testid="remaining-due">
            Non défini tant qu&apos;aucun devis n&apos;est accepté.
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-2" data-testid="start-block">
        <h2 className="text-h2 font-semibold text-ink">Démarrage des travaux</h2>
        {s.work_start_authorized ? (
          <>
            <p className="text-caption text-muted">Valeurs figées au démarrage du {new Date(s.work_start_at as string).toLocaleString("fr-FR")} :</p>
            <dl className="flex flex-col gap-1">
              <Row label="Montant contractuel au démarrage" value={fcfa(s.start_contract_amount_fcfa as string)} />
              <Row label="Avance exigée figée" value={fcfa(s.start_advance_required_fcfa as string)} />
              <Row label="Somme reconnue au démarrage" value={fcfa(s.start_advance_recognized_fcfa as string)} />
            </dl>
            {s.current_advance_shortfall_fcfa !== "0" ? (
              <AlertBanner
                variant="warning"
                title="Avance figée plus intégralement reconnue"
                explanation={`Aujourd'hui, il manque ${fcfa(s.current_advance_shortfall_fcfa as string)} de paiements reconnus par rapport à l'avance figée.`}
              />
            ) : null}
          </>
        ) : (
          <StatusChip variant="neutral" label="Démarrage non autorisé" className="self-start" />
        )}
      </Card>

      <nav className="flex flex-wrap gap-4" aria-label="Détails">
        <Link href={`/chantiers/${id}/devis`} className="text-label font-semibold text-primary">Devis</Link>
        <Link href={`/chantiers/${id}/avenants`} className="text-label font-semibold text-primary">Avenants</Link>
        <Link href={`/chantiers/${id}/acomptes`} className="text-label font-semibold text-primary">Acomptes</Link>
        <Link href={`/chantiers/${id}/photos`} className="text-label font-semibold text-primary">Photos</Link>
      </nav>
    </div>
  );
}
