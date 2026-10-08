"use client";

import { useActionState } from "react";
import { AlertBanner, Button } from "@/components/ui";
import { savePreferencesAction, type NotificationPrefState } from "./actions";

// B045 (D199) — préférences par catégorie (dans l'application, par e-mail).
// Les alertes obligatoires (incident urgent, décision attendue, échéance de
// licence) ne figurent pas ici : elles arrivent toujours.

const LABELS: Record<string, string> = {
  CHANTIER: "Vie du chantier (journal, incidents, commentaires, documents, photos, étapes)",
  FINANCES: "Décisions financières (devis, avenants, versements, dépenses)",
  LICENCE: "Licence (activation, rejet)",
  SUPPORT: "Accès support",
  COMPTE: "Compte (transfert de rôle, accès retiré)",
};

export interface Preference {
  category: string;
  in_app: boolean;
  email: boolean;
}

export function PreferencesForm({ preferences }: { preferences: Preference[] }) {
  const [state, formAction, pending] = useActionState<NotificationPrefState, FormData>(savePreferencesAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="preferences-notifications">
      <ul className="flex flex-col gap-3">
        {preferences.map((p) => (
          <li key={p.category} className="flex flex-col gap-1 rounded-small border border-muted/20 px-3 py-2">
            <p className="text-label font-semibold text-ink">{LABELS[p.category] ?? p.category}</p>
            <div className="flex flex-wrap gap-4">
              <label className="flex min-h-touch items-center gap-2 text-body text-ink">
                <input type="checkbox" name={`${p.category}_in_app`} defaultChecked={p.in_app} className="h-5 w-5" />
                Dans l&apos;application
              </label>
              <label className="flex min-h-touch items-center gap-2 text-body text-ink">
                <input type="checkbox" name={`${p.category}_email`} defaultChecked={p.email} className="h-5 w-5" />
                Par e-mail (adresse vérifiée seulement)
              </label>
            </div>
          </li>
        ))}
      </ul>
      {state && "error" in state ? <AlertBanner variant="error" title="Préférences non enregistrées" explanation={state.error} /> : null}
      {state && "ok" in state ? <AlertBanner variant="information" title="Préférences enregistrées" explanation="Elles s'appliquent aux prochaines notifications." /> : null}
      <div>
        <Button type="submit" size="compact" variant="secondary" loading={pending}>
          Enregistrer mes préférences
        </Button>
      </div>
    </form>
  );
}
