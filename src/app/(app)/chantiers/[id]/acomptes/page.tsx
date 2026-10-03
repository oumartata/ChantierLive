import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { AlertBanner, Card, StatusChip, EmptyState } from "@/components/ui";
import { AdvanceActions, DeclareForm, ReceiptForm, RequirementForm, WorkStartForm } from "./AdvanceForms";

type Status = "DECLARED" | "RECEIVED" | "DISPUTED" | "CANCELLED";

interface AdvanceStatus {
  has_requirement: boolean;
  requirement_amount_fcfa: string | null;
  requirement_version_number: number | null;
  requirement_frozen: boolean;
  recognized_sum_fcfa: string;
  fully_recognized: boolean;
  recognized_above_advance_fcfa: string | null;
  contract_amount_fcfa: string | null;
  recognized_above_contract_fcfa: string | null;
  requirement_above_contract: boolean;
  revision: number | null;
}

interface Payment {
  advance_id: string;
  declared_role: "OWNER_PRIMARY" | "CONTRACTOR";
  declared_by_me: boolean;
  amount_fcfa: string;
  external_payment_date: string;
  mode: string;
  external_reference: string | null;
  status: Status;
  declared_event_seq: number;
  has_receipt: boolean;
  can_confirm: boolean;
  can_dispute: boolean;
  can_cancel: boolean;
  can_attach_receipt: boolean;
}

interface EventRow {
  event_seq: number;
  kind: string;
  advance_id: string | null;
  requirement_amount_fcfa: string | null;
  requirement_version_number: number | null;
  actor_role: "OWNER_PRIMARY" | "CONTRACTOR";
  reason: string | null;
  created_at_server: string;
}

interface FinancialSummaryHeader {
  contract_amount_fcfa: string | null;
  recognized_fcfa: string;
  remaining_due_fcfa: string | null;
}

interface WorkStart {
  authorized: boolean;
  authorized_at_server: string | null;
  authorized_by_me: boolean | null;
  authorized_by_membership_id: string | null;
  authorized_by_role: "CONTRACTOR" | null;
  quote_version_number: number | null;
  quote_total_fcfa: string | null;
  contract_amount_fcfa: string | null;
  plan_version_number: number | null;
  advance_required_fcfa: string | null;
  advance_recognized_at_start_fcfa: string | null;
  advance_event_seq: number | null;
  current_recognized_fcfa: string | null;
  deficit_fcfa: string | null;
}

const RECEIPT_URL_TTL_SECONDS = 300;
const MODE_LABEL: Record<string, string> = { ORANGE_MONEY: "Orange Money", MOOV_MONEY: "Moov Money", CASH: "Espèces", BANK: "Virement bancaire", OTHER: "Autre" };
const ROLE_LABEL = { OWNER_PRIMARY: "le client", CONTRACTOR: "l'entreprise" } as const;
const STATUS_CHIP: Record<Status, { variant: "neutral" | "info" | "success" | "danger"; label: string }> = {
  DECLARED: { variant: "info", label: "Déclaré, en attente de confirmation" },
  RECEIVED: { variant: "success", label: "Confirmé par les deux parties" },
  DISPUTED: { variant: "danger", label: "Contesté — exclu de la somme reconnue" },
  CANCELLED: { variant: "neutral", label: "Annulé (contre-écriture)" },
};
const EVENT_LABEL: Record<string, string> = {
  REQUIREMENT_SET: "Avance exigée fixée",
  REQUIREMENT_FROZEN: "Démarrage autorisé, avance exigée figée",
  DECLARED: "Versement déclaré",
  CONFIRMED: "Versement confirmé",
  DISPUTED: "Versement contesté",
  CANCELLED: "Déclaration annulée",
  RECEIPT_ATTACHED: "Justificatif joint",
};

// Montants reçus en texte (bigint côté serveur) : formatés via BigInt, jamais Number.
const fcfa = (amount: string | null) => (amount === null ? "—" : `${BigInt(amount).toLocaleString("fr-FR")} FCFA`);

function Unavailable({ heading, title, explanation }: { heading: string; title: string; explanation: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">{heading}</h1>
      <AlertBanner variant="warning" title={title} explanation={explanation} />
    </div>
  );
}

// B033 (M014) — SCR040 : acomptes déclaratifs et avance exigée. Les RPC
// appliquent droits, séquence et confidentialité ; l'affichage des actions
// n'est qu'une commodité (les indicateurs can_* viennent du serveur).
export default async function AcomptesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("id, name").eq("id", id).maybeSingle();
  if (!project) {
    return <Unavailable heading="Acomptes" title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />;
  }

  const [statusRes, paymentsRes, eventsRes, membershipRes, workStartRes, financialSummaryRes] = await Promise.all([
    supabase.rpc("get_advance_status", { p_project_id: id }),
    supabase.rpc("list_advance_payments", { p_project_id: id }),
    supabase.rpc("list_advance_events", { p_project_id: id }),
    supabase.from("project_memberships").select("role, owner_profile").eq("project_id", id).eq("profile_id", user.id).is("revoked_at", null).maybeSingle(),
    supabase.rpc("get_work_start", { p_project_id: id }),
    // Résumé (prix convenu/versements confirmés/reste à payer) — maquettes
    // fondateur 2026-10-03 : même RPC que la Synthèse (get_project_financial_summary,
    // M028, inchangée), simple ajout de présentation sur cette page déjà
    // alimentée. Échec silencieux accepté ici (section facultative) : le
    // reste de la page (déjà protégée par statusRes/paymentsRes/eventsRes
    // ci-dessus) ne dépend pas de cette lecture.
    supabase.rpc("get_project_financial_summary", { p_project_id: id }),
  ]);
  if (statusRes.error?.message === "not_authorized") {
    return <Unavailable heading="Acomptes" title="Accès indisponible" explanation="Vous n'avez pas accès à cette page." />;
  }
  // Lecture fermée : aucune donnée partielle si une lecture échoue.
  if (statusRes.error || paymentsRes.error || eventsRes.error || workStartRes.error || !Array.isArray(paymentsRes.data) || !Array.isArray(eventsRes.data)) {
    return <Unavailable heading="Acomptes" title="Lecture impossible" explanation="Réessayez plus tard." />;
  }
  const status: AdvanceStatus = Array.isArray(statusRes.data) ? statusRes.data[0] : statusRes.data;
  const payments: Payment[] = paymentsRes.data;
  const events: EventRow[] = eventsRes.data;
  const workStart: WorkStart = Array.isArray(workStartRes.data) ? workStartRes.data[0] : workStartRes.data;
  const isContractor = membershipRes.data?.role === "CONTRACTOR";
  const canAct = status.revision !== null;
  const revision = status.revision ?? 0;
  const financialSummaryData = Array.isArray(financialSummaryRes.data) ? financialSummaryRes.data[0] : financialSummaryRes.data;
  const financialSummary: FinancialSummaryHeader | null = financialSummaryRes.error ? null : financialSummaryData ?? null;

  // Liens de justificatifs : chaque émission repasse par la RPC (droits
  // courants) ; la signature Storage est faite ici, côté serveur uniquement.
  const receiptUrls = new Map<string, string>();
  const withReceipt = payments.filter((p) => p.has_receipt);
  if (withReceipt.length > 0) {
    const service = createServiceClient();
    for (const p of withReceipt) {
      const { data: keyData } = await supabase.rpc("get_advance_receipt_file_key", { p_advance_id: p.advance_id });
      const key = Array.isArray(keyData) ? keyData[0] : keyData;
      if (!key?.storage_key) continue;
      const { data: signed } = await service.storage.from(key.bucket).createSignedUrl(key.storage_key, RECEIPT_URL_TTL_SECONDS);
      if (signed?.signedUrl) receiptUrls.set(p.advance_id, signed.signedUrl);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Versements — {project.name}</h1>
      <Link href={`/chantiers/${id}/devis`} className="text-label font-semibold text-primary">
        Retour au devis
      </Link>
      <Link href={`/chantiers/${id}/finances`} className="text-label font-semibold text-primary">
        Synthèse financière
      </Link>

      {/* Résumé (maquettes fondateur 2026-10-03) — mêmes données que la
          Synthèse financière, présentation seule, aucune donnée inventée. */}
      {financialSummary && financialSummary.contract_amount_fcfa !== null ? (
        <Card className="flex flex-col gap-2" data-testid="versements-summary">
          <div className="flex justify-between gap-3">
            <dt className="text-body text-muted">Prix convenu</dt>
            <dd className="text-body text-ink">{fcfa(financialSummary.contract_amount_fcfa)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-body text-muted">Versements confirmés</dt>
            <dd className="text-body text-ink">{fcfa(financialSummary.recognized_fcfa)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-body text-muted">Reste à payer</dt>
            <dd className="text-body text-ink">{fcfa(financialSummary.remaining_due_fcfa as string)}</dd>
          </div>
        </Card>
      ) : null}

      <AlertBanner
        variant="information"
        title="Déclarations uniquement"
        explanation="ChantierLive n'encaisse, ne détient ni ne transfère aucun argent. Un versement enregistré ici est une déclaration confirmée par l'autre partie ; il ne remplace pas la preuve de l'opérateur."
      />

      <Card className="flex flex-col gap-2">
        <h2 className="text-h2 font-semibold text-ink">Avance</h2>
        <dl className="flex flex-col gap-1">
          <div className="flex justify-between gap-3">
            <dt className="text-body text-muted">Avance exigée</dt>
            <dd className="text-body text-ink" data-testid="requirement-amount">
              {status.has_requirement ? `${fcfa(status.requirement_amount_fcfa)} (version ${status.requirement_version_number})` : "Non fixée"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-body text-muted">Somme reconnue</dt>
            <dd className="text-body text-ink" data-testid="recognized-sum">{fcfa(status.recognized_sum_fcfa)}</dd>
          </div>
          {status.recognized_above_advance_fcfa ? (
            <div className="flex justify-between gap-3">
              <dt className="text-body text-muted">Montant reconnu au-delà de l&apos;avance</dt>
              <dd className="text-body text-ink" data-testid="above-advance">{fcfa(status.recognized_above_advance_fcfa)}</dd>
            </div>
          ) : null}
          {status.recognized_above_contract_fcfa ? (
            <div className="flex justify-between gap-3">
              <dt className="text-body text-muted">Trop-perçu (au-delà du montant contractuel)</dt>
              <dd className="text-body text-ink" data-testid="above-contract">{fcfa(status.recognized_above_contract_fcfa)}</dd>
            </div>
          ) : null}
        </dl>
        <StatusChip
          variant={status.fully_recognized ? "success" : "neutral"}
          label={status.fully_recognized ? "Avance intégralement reconnue" : "Avance non intégralement reconnue"}
          className="self-start"
        />
        {status.requirement_above_contract ? (
          <p className="text-caption text-muted">L&apos;avance exigée dépasse le montant contractuel actuel ; elle n&apos;est jamais modifiée automatiquement.</p>
        ) : null}
        {status.requirement_frozen ? <p className="text-caption text-muted">Démarrage autorisé : l&apos;avance exigée est figée.</p> : null}
        {isContractor && canAct && !status.requirement_frozen ? (
          status.contract_amount_fcfa === null ? (
            <p className="text-caption text-muted">L&apos;avance pourra être fixée après acceptation du devis.</p>
          ) : (
            <RequirementForm projectId={id} expectedRevision={revision} hasRequirement={status.has_requirement} initialOperationUuid={randomUUID()} />
          )
        ) : null}
        {/* Constat fondateur : le propriétaire ne voyait aucune explication
            tant que l'entreprise n'avait pas fixé l'avance — "Déclarer un
            versement" restait invisible sans qu'on sache pourquoi. Message
            informatif seulement, aucune action ni droit ajouté ici. */}
        {!isContractor && canAct && !status.has_requirement ? (
          <p className="text-caption text-muted">
            {status.contract_amount_fcfa === null
              ? "Un versement pourra être déclaré une fois le devis accepté, puis l'avance fixée par l'entreprise."
              : "L'entreprise doit encore fixer le montant de l'avance exigée avant qu'un versement puisse être déclaré ici."}
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-2" data-testid="work-start">
        <h2 className="text-h2 font-semibold text-ink">Démarrage des travaux</h2>
        {workStart.authorized ? (
          <>
            <StatusChip variant="success" label="Démarrage autorisé" className="self-start" />
            <p className="text-caption text-muted">
              Autorisé par l&apos;entreprise{workStart.authorized_by_me ? " (vous)" : ""} le {new Date(workStart.authorized_at_server as string).toLocaleString("fr-FR")}
            </p>
            {/* Auteur historique : repère d'adhésion figé à l'autorisation (convention de l'écran Équipe, jamais un contact privé). */}
            <p className="text-caption text-muted break-all" data-testid="work-start-author">
              Repère de l&apos;auteur : {workStart.authorized_by_membership_id}
            </p>
            {workStart.deficit_fcfa ? (
              <AlertBanner
                variant="warning"
                title="Avance figée plus intégralement reconnue"
                explanation={`La somme reconnue actuelle (${fcfa(workStart.current_recognized_fcfa)}) est inférieure de ${fcfa(workStart.deficit_fcfa)} à l'avance exigée figée. L'autorisation de démarrage reste enregistrée telle quelle.`}
              />
            ) : null}
            <dl className="flex flex-col gap-1" data-testid="work-start-snapshot">
              <div className="flex justify-between gap-3">
                <dt className="text-body text-muted">Devis accepté</dt>
                <dd className="text-body text-ink">version {workStart.quote_version_number} — {fcfa(workStart.quote_total_fcfa)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-body text-muted">Montant contractuel au démarrage</dt>
                <dd className="text-body text-ink">{fcfa(workStart.contract_amount_fcfa)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-body text-muted">Plan validé</dt>
                <dd className="text-body text-ink">version {workStart.plan_version_number}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-body text-muted">Avance exigée figée</dt>
                <dd className="text-body text-ink">{fcfa(workStart.advance_required_fcfa)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-body text-muted">Somme reconnue au démarrage</dt>
                <dd className="text-body text-ink">{fcfa(workStart.advance_recognized_at_start_fcfa)}</dd>
              </div>
            </dl>
          </>
        ) : (
          <>
            <StatusChip variant="neutral" label="Démarrage non autorisé" className="self-start" />
            {isContractor && canAct ? <WorkStartForm projectId={id} expectedRevision={revision} initialOperationUuid={randomUUID()} /> : null}
          </>
        )}
      </Card>

      {canAct && status.has_requirement ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-h2 font-semibold text-ink">Déclarer un versement</h2>
          <DeclareForm projectId={id} expectedRevision={revision} isContractor={isContractor} initialOperationUuid={randomUUID()} />
        </Card>
      ) : null}

      <Card className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Versements</h2>
        {payments.length === 0 ? (
          <EmptyState title="Aucun versement" description="Aucun versement n'a encore été déclaré." />
        ) : (
          <ul className="flex flex-col gap-4">
            {payments.map((p) => (
              <li key={p.advance_id} className="flex flex-col gap-2 border-b border-sand pb-4 last:border-b-0 last:pb-0" data-testid="payment">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-label font-semibold text-ink">
                    {fcfa(p.amount_fcfa)} — déclaré par {ROLE_LABEL[p.declared_role]}
                  </span>
                  <span className="text-caption text-muted">n° {p.declared_event_seq}</span>
                </div>
                <StatusChip variant={STATUS_CHIP[p.status].variant} label={STATUS_CHIP[p.status].label} className="self-start" />
                <p className="text-caption text-muted">
                  {new Date(`${p.external_payment_date}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" })} · {MODE_LABEL[p.mode] ?? p.mode}
                  {p.external_reference ? ` · réf. ${p.external_reference}` : ""}
                </p>
                {receiptUrls.has(p.advance_id) ? (
                  <a href={receiptUrls.get(p.advance_id)} className="text-label font-semibold text-primary" target="_blank" rel="noreferrer">
                    Voir le justificatif
                  </a>
                ) : null}
                <AdvanceActions
                  projectId={id}
                  advanceId={p.advance_id}
                  expectedRevision={revision}
                  confirmLabel={p.declared_role === "OWNER_PRIMARY" ? "Confirmer la réception" : "Confirmer le paiement"}
                  canConfirm={p.can_confirm}
                  canDispute={p.can_dispute}
                  canCancel={p.can_cancel}
                  initialOperationUuid={randomUUID()}
                />
                {p.can_attach_receipt ? <ReceiptForm projectId={id} advanceId={p.advance_id} initialOperationUuid={randomUUID()} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-h2 font-semibold text-ink">Historique</h2>
        {events.length === 0 ? (
          <p className="text-body text-muted">Aucun événement.</p>
        ) : (
          <ol className="flex flex-col gap-1" data-testid="history">
            {events.map((e) => (
              <li key={e.event_seq} className="text-caption text-ink">
                n° {e.event_seq} — {EVENT_LABEL[e.kind] ?? e.kind} par {ROLE_LABEL[e.actor_role]}
                {e.requirement_amount_fcfa ? ` : ${fcfa(e.requirement_amount_fcfa)} (version ${e.requirement_version_number})` : ""}
                {e.reason ? ` — ${e.reason}` : ""} · {new Date(e.created_at_server).toLocaleString("fr-FR")}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
