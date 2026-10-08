"use client";

import { useActionState } from "react";
import { AlertBanner, Button, TextField } from "@/components/ui";
import { cancelLicensePaymentAction, declareLicensePaymentAction, type LicenseActionState } from "./actions";

// B048 (D193) — SCR052 : déclaration d'un paiement de licence. Aucun champ
// de téléphone, de carte ou de compte (L6) ; avertissement avec accusé (L7).

const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function Feedback({ state, title, okText }: { state: LicenseActionState; title: string; okText?: string }) {
  if (state && "error" in state) return <AlertBanner variant="error" title={title} explanation={state.error} />;
  if (state && "ok" in state && okText) return <p className="text-caption text-muted">{okText}</p>;
  return null;
}

export function DeclareLicensePaymentForm({ projectId, priceFcfa, today }: { projectId: string; priceFcfa: number; today: string }) {
  const [state, formAction, pending] = useActionState<LicenseActionState, FormData>(declareLicensePaymentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="declarer-paiement-licence">
      <input type="hidden" name="project_id" value={projectId} />
      <TextField label="Montant payé (FCFA)" name="amount" inputMode="numeric" required defaultValue={String(priceFcfa)} />
      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
        Moyen de paiement
        <select name="operator" required defaultValue="" className={`${FIELD} h-12`}>
          <option value="" disabled>
            Choisir…
          </option>
          <option value="ORANGE_MONEY">Orange Money</option>
          <option value="MOOV_MONEY">Moov Money</option>
          <option value="OTHER">Autre</option>
        </select>
      </label>
      <TextField label="Référence de la transaction" name="reference" required minLength={4} maxLength={120} />
      <TextField label="Date du paiement" name="paid_on" type="date" required max={today} defaultValue={today} />
      <TextField label="Nom du payeur (facultatif)" name="payer_name" maxLength={120} />
      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
        Preuve du paiement (capture ou reçu)
        <input type="file" name="proof" required accept="application/pdf,image/jpeg,image/png,image/webp" className="text-body font-normal text-ink" />
      </label>
      <p className="text-caption text-muted">
        Avant d&apos;envoyer une capture, masquez votre numéro de téléphone ou de compte. Ne saisissez jamais de numéro de carte, de compte ni de code
        secret : seule la référence de la transaction est demandée.
      </p>
      <label className="flex items-start gap-2 text-body text-ink">
        <input type="checkbox" name="disclaimer_ack" required className="mt-1 h-5 w-5" />
        <span>
          J&apos;ai compris que ChantierLive ne détient ni ne transfère d&apos;argent : cette déclaration sera vérifiée, et la licence ne sera active
          qu&apos;après cette vérification. Payer ne donne aucun droit supplémentaire sur le chantier.
        </span>
      </label>
      <Feedback state={state} title="Déclaration non envoyée" okText="Déclaration envoyée : elle est en attente de vérification." />
      <div>
        <Button type="submit" loading={pending}>
          Envoyer la déclaration
        </Button>
      </div>
    </form>
  );
}

export function CancelLicensePaymentForm({ projectId, paymentId }: { projectId: string; paymentId: string }) {
  const [state, formAction, pending] = useActionState<LicenseActionState, FormData>(cancelLicensePaymentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="payment_id" value={paymentId} />
      <TextField label="Motif de l'annulation" name="reason" required minLength={3} maxLength={1000} />
      <p className="text-caption text-muted">La déclaration reste visible, marquée annulée ; rien n&apos;est supprimé.</p>
      <Feedback state={state} title="Annulation impossible" />
      <div>
        <Button type="submit" size="compact" variant="danger" loading={pending}>
          Annuler ma déclaration
        </Button>
      </div>
    </form>
  );
}
