"use client";

import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, TextField, AlertBanner, Card } from "@/components/ui";
import { parseInvitationToken } from "@/lib/invitationResume";
import { verifyPhoneOtp, type AuthActionState } from "../actions";

function PhoneField() {
  const searchParams = useSearchParams();
  const phone = searchParams.get("phone") ?? "";
  return (
    <TextField
      label="Téléphone"
      name="phone"
      type="text"
      defaultValue={phone}
      autoComplete="tel"
      required
    />
  );
}

// FR033 : voir connexion/page.tsx — même mécanisme dédié, revalidé côté
// serveur dans verifyPhoneOtp.
function InvitationHiddenField() {
  const searchParams = useSearchParams();
  const token = parseInvitationToken(searchParams.get("invitation"));
  return <input type="hidden" name="invitation" value={token ?? ""} />;
}

export default function VerificationTelephonePage() {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    verifyPhoneOtp,
    null
  );

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-title font-bold text-ink">Confirmer le téléphone</h1>
      <Card className="flex flex-col gap-4 p-6">
        <AlertBanner
          variant="information"
          title="Code envoyé"
          explanation="Saisissez le code reçu par SMS pour confirmer ce numéro."
        />
        {state?.error ? (
          <AlertBanner variant="error" title="Confirmation impossible" explanation={state.error} />
        ) : null}
        <form action={formAction} className="flex flex-col gap-4">
          <Suspense fallback={<TextField label="Téléphone" name="phone" type="text" required />}>
            <PhoneField />
          </Suspense>
          <TextField
            label="Code reçu"
            name="token"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
          <Suspense fallback={<input type="hidden" name="invitation" value="" />}>
            <InvitationHiddenField />
          </Suspense>
          <Button type="submit" loading={pending}>
            Confirmer
          </Button>
        </form>
      </Card>
    </div>
  );
}
