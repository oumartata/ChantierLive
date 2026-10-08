"use client";

import { useActionState } from "react";
import { AlertBanner, Button } from "@/components/ui";
import { SUPPORT_CATEGORIES, SUPPORT_DURATIONS, SUPPORT_MODULES } from "@/lib/support/labels";
import {
  closeSupportRequestAction,
  createSupportRequestAction,
  grantSupportAccessAction,
  revokeSupportAccessAction,
  type SupportActionState,
} from "./actions";

// B051 (D197) — formulaires de la partie principale : demande d'aide, accord
// en lecture seule (modules et durée choisis ici), arrêt, clôture.

const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function Feedback({ state, title }: { state: SupportActionState; title: string }) {
  if (!state) return null;
  if ("error" in state) return <AlertBanner variant="error" title={title} explanation={state.error} />;
  return <AlertBanner variant="information" title={state.message} explanation="Le journal des accès support ci-dessous est à jour." />;
}

function GrantFields() {
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-label font-semibold text-ink">Ce que le support pourra lire</legend>
        {SUPPORT_MODULES.map((m) => (
          <label key={m.value} className="flex min-h-touch items-center gap-2 text-body text-ink">
            <input type="checkbox" name="modules" value={m.value} className="h-5 w-5" />
            {m.label}
          </label>
        ))}
        <p className="text-caption text-muted">Jamais vos finances internes, ni le journal d&apos;audit du chantier.</p>
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-label font-semibold text-ink">Pendant</legend>
        <div className="flex flex-wrap gap-4">
          {SUPPORT_DURATIONS.map((d) => (
            <label key={d} className="flex min-h-touch items-center gap-2 text-body text-ink">
              <input type="radio" name="duration" value={d} defaultChecked={d === 15} className="h-5 w-5" />
              {d} minutes
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export function NewSupportRequestForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState<SupportActionState, FormData>(createSupportRequestAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="form-demande-aide">
      <input type="hidden" name="project_id" value={projectId} />
      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
        Catégorie
        <select name="category" required defaultValue="" className={`${FIELD} h-12`}>
          <option value="" disabled>
            Choisir…
          </option>
          {SUPPORT_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
        Décrivez le problème
        <textarea name="description" required minLength={10} maxLength={1000} rows={4} className={FIELD} />
      </label>
      <label className="flex min-h-touch items-center gap-2 text-body font-semibold text-ink">
        <input type="checkbox" name="consent" className="h-5 w-5" />
        J&apos;autorise dès maintenant le support à lire ces éléments, en lecture seule
      </label>
      <GrantFields />
      <Feedback state={state} title="Demande impossible" />
      <div>
        <Button type="submit" loading={pending}>
          Envoyer la demande
        </Button>
      </div>
    </form>
  );
}

export function GrantAccessForm({ projectId, requestId }: { projectId: string; requestId: string }) {
  const [state, formAction, pending] = useActionState<SupportActionState, FormData>(grantSupportAccessAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="request_id" value={requestId} />
      <GrantFields />
      <Feedback state={state} title="Accès impossible" />
      <div>
        <Button type="submit" size="compact" loading={pending}>
          Ouvrir l&apos;accès en lecture seule
        </Button>
      </div>
    </form>
  );
}

export function RevokeAccessForm({ projectId, grantId }: { projectId: string; grantId: string }) {
  const [state, formAction, pending] = useActionState<SupportActionState, FormData>(revokeSupportAccessAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="grant_id" value={grantId} />
      <Feedback state={state} title="Arrêt impossible" />
      <div>
        <Button type="submit" size="compact" variant="danger" loading={pending}>
          Arrêter l&apos;accès maintenant
        </Button>
      </div>
    </form>
  );
}

export function CloseRequestForm({ projectId, requestId }: { projectId: string; requestId: string }) {
  const [state, formAction, pending] = useActionState<SupportActionState, FormData>(closeSupportRequestAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="request_id" value={requestId} />
      <Feedback state={state} title="Clôture impossible" />
      <div>
        <Button type="submit" size="compact" variant="secondary" loading={pending}>
          Clore la demande
        </Button>
      </div>
    </form>
  );
}
