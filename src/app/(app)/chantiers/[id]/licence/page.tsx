import { notFound, redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { AlertBanner, Card, EmptyState, StatusChip, type StatusChipVariant } from "@/components/ui";
import { formatFcfa } from "@/lib/entreprise/chantierSummary";
import { CancelLicensePaymentForm, DeclareLicensePaymentForm } from "./LicenseForms";

// SCR051 (licence du chantier) avec SCR052 (déclaration) — B048 (M048 ;
// D193, D004, D012). Tout membre actif voit l'état de la licence, sans
// montant ni preuve. Le propriétaire principal et l'entreprise déclarent un
// paiement ; chacun ne voit que ses propres déclarations, et la preuve n'est
// délivrée qu'à son déclarant (URL signée de 300 s émise après
// get_license_proof_file_key). Payer ne donne aucun droit.

const PROOF_URL_TTL_SECONDS = 300;

interface LicenseState {
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  has_pending_declaration: boolean;
  can_declare: boolean;
}
interface Offer {
  label: string;
  duration_months: number;
  price_fcfa: number | string;
  price_is_demo: boolean;
}
interface MyPayment {
  id: string;
  status: string;
  offer_label: string;
  offer_price_fcfa: number | string;
  offer_price_is_demo: boolean;
  amount_fcfa: number | string;
  operator: string;
  payment_reference: string;
  paid_on: string;
  payer_name: string | null;
  proof_mime_type: string;
  proof_size_bytes: number;
  created_at_server: string;
  cancelled_at_server: string | null;
  cancel_reason: string | null;
  can_cancel: boolean;
  decided_at_server: string | null;
  decision_note: string | null;
}

const LICENSE_STATUS: Record<string, { label: string; chip: StatusChipVariant; text: string }> = {
  NONE: { label: "Aucune licence", chip: "neutral", text: "Aucun paiement de licence n'a encore été déclaré pour ce chantier." },
  PENDING: { label: "En attente de vérification", chip: "attention", text: "Un paiement a été déclaré ; la licence sera active après sa vérification par ChantierLive." },
  ACTIVE: { label: "Active", chip: "success", text: "La licence du chantier est active." },
  EXPIRING: { label: "Bientôt expirée", chip: "attention", text: "La licence arrive à échéance." },
  GRACE: { label: "En période de grâce", chip: "attention", text: "La licence a expiré ; la période de grâce de 30 jours est en cours." },
  READ_ONLY: { label: "Lecture seule", chip: "danger", text: "Le chantier est en lecture seule pour tous ses membres ; les données restent consultables." },
  CANCELLED: { label: "Annulée", chip: "neutral", text: "La licence a été annulée." },
};
const PAYMENT_STATUS: Record<string, { label: string; chip: StatusChipVariant }> = {
  PENDING_REVIEW: { label: "En attente de vérification", chip: "attention" },
  CANCELLED: { label: "Annulée", chip: "neutral" },
  ACTIVATED: { label: "Vérifiée — licence activée", chip: "success" },
  REJECTED: { label: "Rejetée", chip: "danger" },
};
const OPERATOR: Record<string, string> = { ORANGE_MONEY: "Orange Money", MOOV_MONEY: "Moov Money", OTHER: "Autre" };
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

export default async function LicensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const supabase = await createClient();
  const [licenseRes, offerRes, mineRes] = await Promise.all([
    supabase.rpc("get_project_license", { p_project_id: id }),
    supabase.rpc("get_license_offer"),
    supabase.rpc("list_my_license_payments", { p_project_id: id }),
  ]);
  if (licenseRes.error?.message === "not_authorized") notFound();
  if (licenseRes.error || mineRes.error) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Licence du chantier</h1>
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      </div>
    );
  }
  const license = (Array.isArray(licenseRes.data) ? licenseRes.data[0] : licenseRes.data) as LicenseState;
  const offer = (offerRes.error ? null : Array.isArray(offerRes.data) ? offerRes.data[0] : offerRes.data) as Offer | null;
  const mine = (mineRes.data ?? []) as MyPayment[];
  const service = createServiceClient();
  const proofUrls = new Map<string, string | null>();
  await Promise.all(
    mine.map(async (p) => {
      const { data } = await supabase.rpc("get_license_proof_file_key", { p_payment_id: p.id });
      const key = Array.isArray(data) ? data[0] : data;
      if (!key?.storage_key) return proofUrls.set(p.id, null);
      const { data: signed } = await service.storage.from(key.bucket).createSignedUrl(key.storage_key, PROOF_URL_TTL_SECONDS);
      proofUrls.set(p.id, signed?.signedUrl ?? null);
    })
  );
  const st = LICENSE_STATUS[license.status] ?? { label: license.status, chip: "neutral" as const, text: "" };
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Licence du chantier</h1>
        <p className="text-body text-muted">ChantierLive ne détient ni ne transfère d&apos;argent. Payer la licence ne donne aucun droit supplémentaire : chaque membre garde son rôle.</p>
      </div>

      <Card className="flex flex-col gap-2" data-testid="etat-licence">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-h2 font-semibold text-ink">État</h2>
          <StatusChip variant={st.chip} label={st.label} />
        </div>
        <p className="text-body text-ink">{st.text}</p>
        {license.starts_on && license.ends_on ? (
          <p className="text-caption text-muted">
            Du {day(license.starts_on)} au {day(license.ends_on)}.
          </p>
        ) : null}
        {license.has_pending_declaration ? (
          <div data-testid="declaration-en-attente">
            <AlertBanner variant="information" title="Une déclaration est déjà en attente" explanation="Avant de payer à nouveau, vérifiez avec les autres parties du chantier : une seule licence est nécessaire." />
          </div>
        ) : null}
      </Card>

      {offer ? (
        <Card className="flex flex-col gap-2" data-testid="formule-licence">
          <h2 className="text-h2 font-semibold text-ink">Formule</h2>
          <p className="text-body text-ink">
            {offer.label} — {formatFcfa(String(offer.price_fcfa))}
          </p>
          {offer.price_is_demo ? <StatusChip variant="attention" label="Prix de démonstration" /> : null}
          <p className="text-caption text-muted">Durée {offer.duration_months} mois. La licence est active après vérification manuelle du paiement.</p>
        </Card>
      ) : (
        <AlertBanner variant="warning" title="Formule indisponible" explanation="La formule de licence n'est pas disponible pour l'instant." />
      )}

      {license.can_declare && offer ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-h2 font-semibold text-ink">Déclarer un paiement</h2>
          <DeclareLicensePaymentForm projectId={id} priceFcfa={Number(offer.price_fcfa)} today={today} />
        </Card>
      ) : null}

      {license.can_declare ? (
        <section className="flex flex-col gap-3" data-testid="mes-declarations">
          <h2 className="text-h2 font-semibold text-ink">Mes déclarations ({mine.length})</h2>
          {mine.length === 0 ? <EmptyState title="Aucune déclaration" description="Vos déclarations de paiement apparaîtront ici, visibles de vous seul." /> : null}
          {mine.map((p) => {
            const ps = PAYMENT_STATUS[p.status] ?? { label: p.status, chip: "neutral" as const };
            const url = proofUrls.get(p.id);
            return (
              <Card key={p.id} className="flex flex-col gap-2" data-testid={`declaration-${p.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-h2 font-semibold text-ink">{formatFcfa(String(p.amount_fcfa))}</p>
                  <StatusChip variant={ps.chip} label={ps.label} />
                </div>
                <p className="break-words text-caption text-muted">
                  {OPERATOR[p.operator] ?? p.operator}, référence {p.payment_reference}, payé le {day(p.paid_on)}
                  {p.payer_name ? `, par ${p.payer_name}` : ""} — déclaré le {stamp(p.created_at_server)}
                </p>
                <p className="text-caption text-muted">
                  {p.offer_label} au prix de {formatFcfa(String(p.offer_price_fcfa))}
                  {p.offer_price_is_demo ? " (prix de démonstration)" : ""}
                </p>
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-caption font-semibold text-primary underline">
                    Voir ma preuve ({p.proof_mime_type === "application/pdf" ? "PDF" : "image"})
                  </a>
                ) : null}
                {p.cancelled_at_server ? (
                  <p className="break-words text-caption text-ink">
                    Annulée le {stamp(p.cancelled_at_server)} — motif : {p.cancel_reason}
                  </p>
                ) : null}
                {p.decided_at_server ? (
                  <p className="break-words text-caption text-ink" data-testid="decision-licence">
                    {p.status === "REJECTED" ? "Rejetée" : "Vérifiée"} par ChantierLive le {stamp(p.decided_at_server)}
                    {p.decision_note ? ` — ${p.status === "REJECTED" ? "motif" : "note"} : ${p.decision_note}` : ""}
                  </p>
                ) : null}
                {p.can_cancel ? (
                  <details className="rounded-small border border-muted/30 px-3 py-2">
                    <summary className="cursor-pointer text-label font-semibold text-primary">Annuler ma déclaration</summary>
                    <div className="mt-3">
                      <CancelLicensePaymentForm projectId={id} paymentId={p.id} />
                    </div>
                  </details>
                ) : null}
              </Card>
            );
          })}
        </section>
      ) : (
        <p className="text-caption text-muted">Le paiement de la licence est déclaré par le propriétaire principal ou l&apos;entreprise du chantier.</p>
      )}
    </div>
  );
}
