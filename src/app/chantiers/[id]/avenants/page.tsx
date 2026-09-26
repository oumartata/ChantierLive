import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, StatusChip, EmptyState } from "@/components/ui";
import {
  AuthorizeExecutionButton,
  ChangeOrderEstimateForm,
  DecideChangeOrderForm,
  ProposeChangeOrderButton,
} from "./ChangeOrderForms";

type VersionStatus = "ESTIMATE" | "PROPOSED" | "ACCEPTED" | "REFUSED" | "SUPERSEDED";

interface ChangeOrderVersionView {
  change_order_id: string;
  revision: number | null;
  version_id: string;
  version_number: number;
  status: VersionStatus;
  title: string;
  reason: string;
  total_amount_fcfa: string;
  is_pending: boolean;
  is_accepted: boolean;
  created_at_server: string;
  proposed_at_server: string | null;
  decided_at_server: string | null;
  decision_reason: string | null;
  execution_authorized_at_server: string | null;
}

interface ContractAmount {
  quote_amount_fcfa: string | null;
  change_orders_amount_fcfa: string | null;
  accepted_change_order_count: number | null;
  contract_amount_fcfa: string | null;
}

interface Line {
  line_position: number;
  label: string;
  unit: string;
  quantity: string;
  unit_price_fcfa: string;
  line_amount_fcfa: string;
}

const STATUS_CHIP: Record<VersionStatus, { variant: "neutral" | "info" | "success" | "danger"; label: string }> = {
  ESTIMATE: { variant: "neutral", label: "Estimation privée, non contractuelle" },
  PROPOSED: { variant: "info", label: "Proposé, en attente de décision" },
  ACCEPTED: { variant: "success", label: "Accepté" },
  REFUSED: { variant: "danger", label: "Refusé" },
  SUPERSEDED: { variant: "neutral", label: "Remplacé par une nouvelle proposition" },
};

// Montants reçus en texte (bigint côté serveur) : formatés via BigInt, jamais Number.
function fcfa(amount: string | null): string {
  return amount === null ? "—" : `${BigInt(amount).toLocaleString("fr-FR")} FCFA`;
}

function quantityLabel(quantity: string): string {
  return quantity.includes(".") ? quantity.replace(/0+$/, "").replace(/\.$/, "").replace(".", ",") : quantity;
}

const date = (value: string) => new Date(value).toLocaleString("fr-FR");

function Unavailable({ title, heading, explanation }: { title: string; heading: string; explanation: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">{heading}</h1>
      <AlertBanner variant="warning" title={title} explanation={explanation} />
    </div>
  );
}

// B066 (M022) — avenants au devis accepté. list_change_orders et
// get_change_order_version_lines appliquent déjà le prédicat de lecture (D118 :
// estimations privées au CONTRACTOR, aucun accès SITE_MANAGER) ; les RPC
// restent l'autorité, l'affichage des boutons n'est qu'une commodité.
export default async function AvenantsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("id, name").eq("id", id).maybeSingle();
  if (!project) {
    return <Unavailable heading="Avenants" title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />;
  }

  const { data: membership } = await supabase
    .from("project_memberships")
    .select("role, owner_profile")
    .eq("project_id", id)
    .eq("profile_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();
  const isContractor = membership?.role === "CONTRACTOR";
  const isOwnerPrimary = membership?.role === "OWNER" && membership.owner_profile === "PRIMARY";
  const isCoOwner = membership?.role === "OWNER" && membership.owner_profile === "CO_OWNER";
  if (!isContractor && !isOwnerPrimary && !isCoOwner) {
    return <Unavailable heading="Avenants" title="Accès indisponible" explanation="Vous n'avez pas accès à cette page." />;
  }

  const [{ data: amountData, error: amountError }, { data: versionsData, error: listError }] = await Promise.all([
    supabase.rpc("get_contract_amount", { p_project_id: id }),
    supabase.rpc("list_change_orders", { p_project_id: id }),
  ]);
  if (amountError || listError) {
    return <Unavailable heading={`Avenants — ${project.name}`} title="Lecture impossible" explanation="Réessayez plus tard." />;
  }
  const amount: ContractAmount | null = Array.isArray(amountData) ? amountData[0] : amountData;
  const versions: ChangeOrderVersionView[] = Array.isArray(versionsData) ? versionsData : [];
  // Lecture fermée en cas d'échec : si les lignes d'une seule version ne
  // peuvent être lues, aucune donnée contractuelle partielle n'est affichée.
  const lineResults = await Promise.all(
    versions.map(async (v) => {
      const { data, error } = await supabase.rpc("get_change_order_version_lines", { p_version_id: v.version_id });
      return { versionId: v.version_id, data, error };
    })
  );
  if (lineResults.some((r) => r.error || !Array.isArray(r.data))) {
    return <Unavailable heading="Avenants" title="Lecture impossible" explanation="Réessayez plus tard." />;
  }
  const linesByVersion = new Map<string, Line[]>(lineResults.map((r) => [r.versionId, r.data as Line[]]));

  // Regroupement par avenant ; versions déjà triées (plus récente d'abord).
  const orders = new Map<string, ChangeOrderVersionView[]>();
  for (const v of versions) {
    orders.set(v.change_order_id, [...(orders.get(v.change_order_id) ?? []), v]);
  }
  const quoteAccepted = amount?.quote_amount_fcfa != null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Avenants — {project.name}</h1>
      <Link href={`/chantiers/${id}/devis`} className="text-label font-semibold text-primary">
        Retour au devis
      </Link>

      <Card className="flex flex-col gap-2">
        <h2 className="text-h2 font-semibold text-ink">Montant contractuel</h2>
        {quoteAccepted ? (
          <dl className="flex flex-col gap-1">
            <div className="flex justify-between gap-3">
              <dt className="text-body text-muted">Devis initial accepté</dt>
              <dd className="text-body text-ink" data-testid="quote-amount">{fcfa(amount?.quote_amount_fcfa ?? null)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-body text-muted">Avenants acceptés ({amount?.accepted_change_order_count ?? 0})</dt>
              <dd className="text-body text-ink" data-testid="change-orders-amount">{fcfa(amount?.change_orders_amount_fcfa ?? null)}</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-sand pt-2">
              <dt className="text-label font-semibold text-ink">Montant contractuel actuel</dt>
              <dd className="text-label font-bold text-ink" data-testid="contract-amount">{fcfa(amount?.contract_amount_fcfa ?? null)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-body text-muted">Aucun devis accepté : les avenants ne sont possibles qu&apos;après acceptation du devis initial.</p>
        )}
      </Card>

      {isContractor && quoteAccepted ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-h2 font-semibold text-ink">Nouvel avenant</h2>
          <p className="text-caption text-muted">
            Un avenant ajoute des prestations au contrat. Il reste une estimation privée jusqu&apos;à sa proposition au client.
          </p>
          <ChangeOrderEstimateForm projectId={project.id} expectedRevision={0} submitLabel="Enregistrer l'estimation d'avenant" />
        </Card>
      ) : null}

      {orders.size === 0 ? (
        <Card>
          <EmptyState
            title="Aucun avenant"
            description={isContractor ? "Aucun avenant n'a encore été enregistré." : "Aucun avenant ne vous a encore été proposé."}
          />
        </Card>
      ) : (
        [...orders.entries()].map(([orderId, orderVersions], index) => {
          const latest = orderVersions[0];
          const accepted = orderVersions.find((v) => v.is_accepted);
          const authorizedAt = accepted?.execution_authorized_at_server ?? null;
          const revision = latest.revision ?? 0;
          return (
            <Card key={orderId} className="flex flex-col gap-4" data-testid="change-order">
              <div className="flex flex-col gap-1">
                <h2 className="text-h2 font-semibold text-ink">
                  Avenant {index + 1} — {(accepted ?? latest).title}
                </h2>
                <p className="text-caption text-muted">Motif : {(accepted ?? latest).reason}</p>
                <StatusChip
                  variant={authorizedAt ? "success" : "neutral"}
                  label={authorizedAt ? `Exécution autorisée le ${date(authorizedAt)}` : "Exécution non autorisée"}
                  className="self-start"
                />
              </div>

              {isContractor && accepted && !authorizedAt ? (
                <AuthorizeExecutionButton projectId={project.id} changeOrderId={orderId} expectedRevision={revision} />
              ) : null}

              <ul className="flex flex-col gap-4">
                {orderVersions.map((v) => (
                  <li key={v.version_id} className="flex flex-col gap-2 border-b border-sand pb-4 last:border-b-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-label font-semibold text-ink">Version {v.version_number}</span>
                      <span className="text-label font-semibold text-ink">{fcfa(v.total_amount_fcfa)}</span>
                    </div>
                    <StatusChip variant={STATUS_CHIP[v.status].variant} label={STATUS_CHIP[v.status].label} className="self-start" />
                    {v.title !== (accepted ?? latest).title || v.reason !== (accepted ?? latest).reason ? (
                      <p className="text-caption text-muted">
                        {v.title} — {v.reason}
                      </p>
                    ) : null}
                    <ul className="flex flex-col gap-1">
                      {(linesByVersion.get(v.version_id) ?? []).map((l) => (
                        <li key={l.line_position} className="text-caption text-ink">
                          {l.label} — {quantityLabel(l.quantity)} {l.unit} × {fcfa(l.unit_price_fcfa)} = {fcfa(l.line_amount_fcfa)}
                        </li>
                      ))}
                    </ul>
                    {v.proposed_at_server ? <p className="text-caption text-muted">Proposé le {date(v.proposed_at_server)}</p> : null}
                    {v.decided_at_server ? (
                      <p className="text-caption text-muted">
                        Décidé le {date(v.decided_at_server)}
                        {v.decision_reason ? ` — ${v.decision_reason}` : ""}
                      </p>
                    ) : null}
                    {isContractor && !accepted && v.status === "ESTIMATE" ? (
                      <ProposeChangeOrderButton projectId={project.id} versionId={v.version_id} expectedRevision={revision} />
                    ) : null}
                    {isOwnerPrimary && v.status === "PROPOSED" && v.is_pending ? (
                      <DecideChangeOrderForm projectId={project.id} versionId={v.version_id} expectedRevision={revision} />
                    ) : null}
                  </li>
                ))}
              </ul>

              {isContractor && !accepted ? (
                <details className="flex flex-col gap-3">
                  <summary className="text-label font-semibold text-primary">Nouvelle version de cet avenant</summary>
                  <ChangeOrderEstimateForm
                    projectId={project.id}
                    changeOrderId={orderId}
                    expectedRevision={revision}
                    defaultTitle={latest.title}
                    defaultReason={latest.reason}
                    submitLabel="Enregistrer la nouvelle version"
                  />
                </details>
              ) : null}
            </Card>
          );
        })
      )}
    </div>
  );
}
