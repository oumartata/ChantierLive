import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, StatusChip, EmptyState } from "@/components/ui";
import { EstimateForm } from "./EstimateForm";
import { DecideQuoteForm, ProposeQuoteButton } from "./QuoteActionButton";

interface QuoteState {
  has_quote: boolean;
  revision: number | null;
  pending_version_id: string | null;
  accepted_version_id: string | null;
  contract_amount_fcfa: string | null;
}

interface QuoteVersionView {
  version_id: string;
  version_number: number;
  status: "ESTIMATE" | "PROPOSED" | "ACCEPTED" | "REFUSED" | "SUPERSEDED";
  total_amount_fcfa: string;
  created_at_server: string;
  proposed_at_server: string | null;
  decided_at_server: string | null;
  decision_reason: string | null;
}

interface QuoteLine {
  line_position: number;
  label: string;
  unit: string;
  quantity: string;
  unit_price_fcfa: string;
  line_amount_fcfa: string;
}

const STATUS_CHIP: Record<QuoteVersionView["status"], { variant: "neutral" | "info" | "success" | "danger"; label: string }> = {
  ESTIMATE: { variant: "neutral", label: "Estimation privée, non contractuelle" },
  PROPOSED: { variant: "info", label: "Proposé, en attente de décision" },
  ACCEPTED: { variant: "success", label: "Accepté" },
  REFUSED: { variant: "danger", label: "Refusé" },
  SUPERSEDED: { variant: "neutral", label: "Remplacé par une nouvelle proposition" },
};

// Montants reçus en texte (bigint côté serveur) : formatés sans passer par un flottant.
function fcfa(amount: string | null): string {
  return amount === null ? "—" : `${BigInt(amount).toLocaleString("fr-FR")} FCFA`;
}

function quantityLabel(quantity: string): string {
  return quantity.includes(".") ? quantity.replace(/0+$/, "").replace(/\.$/, "").replace(".", ",") : quantity;
}

// B065 (M021) — devis du chantier. list_quote_versions et get_quote_version_lines
// appliquent déjà le prédicat de lecture (D116 : estimations privées au
// CONTRACTOR) ; cette page n'affiche que ce qu'elle reçoit. Hors périmètre :
// avenants (B066), paiements et reste dû (B068), démarrage (B067).
export default async function DevisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("id, name").eq("id", id).maybeSingle();
  if (!project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Devis</h1>
        <AlertBanner variant="error" title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />
      </div>
    );
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
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Devis — {project.name}</h1>
        <AlertBanner variant="warning" title="Accès indisponible" explanation="Le devis est réservé à l'entrepreneur et aux propriétaires du chantier." />
      </div>
    );
  }

  const [{ data: stateData, error: stateError }, { data: versionsData }] = await Promise.all([
    supabase.rpc("get_quote_state", { p_project_id: id }),
    supabase.rpc("list_quote_versions", { p_project_id: id }),
  ]);
  const quoteState: QuoteState | null = Array.isArray(stateData) ? stateData[0] : stateData;
  const versions: QuoteVersionView[] = Array.isArray(versionsData) ? versionsData : [];
  const linesByVersion = new Map<string, QuoteLine[]>();
  await Promise.all(
    versions.map(async (v) => {
      const { data } = await supabase.rpc("get_quote_version_lines", { p_version_id: v.version_id });
      linesByVersion.set(v.version_id, Array.isArray(data) ? data : []);
    })
  );
  const revision = quoteState?.revision ?? 0;
  const accepted = !!quoteState?.accepted_version_id;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Devis — {project.name}</h1>

      <Card className="flex flex-col gap-2">
        <h2 className="text-h2 font-semibold text-ink">Montant contractuel</h2>
        {stateError ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
        ) : accepted ? (
          <p className="text-h2 font-bold text-ink">{fcfa(quoteState?.contract_amount_fcfa ?? null)}</p>
        ) : (
          <p className="text-body text-muted">Aucun devis accepté : le montant contractuel n&apos;est pas encore fixé.</p>
        )}
        {accepted ? (
          <p className="text-caption text-muted">Toute modification après acceptation passe par un avenant.</p>
        ) : null}
      </Card>

      {isContractor && !accepted ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-h2 font-semibold text-ink">Nouvelle estimation</h2>
          <p className="text-caption text-muted">
            Une estimation reste privée et non contractuelle jusqu&apos;à sa proposition au client.
          </p>
          <EstimateForm projectId={project.id} expectedRevision={revision} />
        </Card>
      ) : null}

      <Card className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">{isContractor ? "Versions du devis" : "Propositions et historique"}</h2>
        {versions.length === 0 ? (
          <EmptyState
            title="Aucune version"
            description={isContractor ? "Aucune estimation n'a encore été enregistrée." : "Aucun devis ne vous a encore été proposé."}
          />
        ) : (
          <ul className="flex flex-col gap-4">
            {versions.map((v) => (
              <li key={v.version_id} className="flex flex-col gap-2 border-b border-sand pb-4 last:border-b-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-label font-semibold text-ink">Version {v.version_number}</span>
                  <span className="text-label font-semibold text-ink">{fcfa(v.total_amount_fcfa)}</span>
                </div>
                <StatusChip variant={STATUS_CHIP[v.status].variant} label={STATUS_CHIP[v.status].label} className="self-start" />
                <ul className="flex flex-col gap-1">
                  {(linesByVersion.get(v.version_id) ?? []).map((l) => (
                    <li key={l.line_position} className="text-caption text-ink">
                      {l.label} — {quantityLabel(l.quantity)} {l.unit} × {fcfa(l.unit_price_fcfa)} = {fcfa(l.line_amount_fcfa)}
                    </li>
                  ))}
                </ul>
                {v.proposed_at_server ? (
                  <p className="text-caption text-muted">Proposé le {new Date(v.proposed_at_server).toLocaleString("fr-FR")}</p>
                ) : null}
                {v.decided_at_server ? (
                  <p className="text-caption text-muted">
                    Décidé le {new Date(v.decided_at_server).toLocaleString("fr-FR")}
                    {v.decision_reason ? ` — ${v.decision_reason}` : ""}
                  </p>
                ) : null}
                {isContractor && !accepted && v.status === "ESTIMATE" ? (
                  <ProposeQuoteButton projectId={project.id} versionId={v.version_id} expectedRevision={revision} />
                ) : null}
                {isOwnerPrimary && v.status === "PROPOSED" && quoteState?.pending_version_id === v.version_id ? (
                  <DecideQuoteForm projectId={project.id} versionId={v.version_id} expectedRevision={revision} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
