"use client";

import { useActionState } from "react";
import { AlertBanner, Button, Card, EmptyState, TextField } from "@/components/ui";
import { findAccountAction, setLicenseOfferAction, type AccountLookupState, type LicenseOfferState } from "./actions";

// B050 (D195 E4, E5, E7) — formulaires de l'administration de la plateforme.

const day = (ts: string) => new Date(ts).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });

export function AccountLookupForm() {
  const [state, formAction, pending] = useActionState<AccountLookupState, FormData>(findAccountAction, null);
  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-2">
        <TextField label="E-mail ou téléphone exact du compte" name="identifier" required autoComplete="off" maxLength={320} />
        <p className="text-caption text-muted">
          Seul un identifiant complet donne un résultat. Chaque recherche est enregistrée dans le journal de la plateforme, identifiant masqué.
        </p>
        <div>
          <Button type="submit" size="compact" loading={pending}>
            Rechercher
          </Button>
        </div>
      </form>
      {state && "error" in state ? <AlertBanner variant="error" title="Recherche impossible" explanation={state.error} /> : null}
      {state && "found" in state && state.found === null ? (
        <EmptyState title="Aucun compte" description="Aucun compte ne correspond exactement à cet identifiant." />
      ) : null}
      {state && "found" in state && state.found ? (
        <Card className="flex flex-col gap-2" data-testid="admin-compte-trouve">
          <p className="font-mono text-label font-bold text-ink">Compte {state.found.account_ref}</p>
          <dl className="grid grid-cols-1 gap-1 text-caption text-muted sm:grid-cols-2">
            <div>
              <dt className="inline font-semibold">Créé le : </dt>
              <dd className="inline">{day(state.found.created_at_server)}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">État : </dt>
              <dd className="inline">{state.found.verified ? "vérifié" : "provisoire"}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Adhésions actives : </dt>
              <dd className="inline">{state.found.active_memberships}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Administrateur : </dt>
              <dd className="inline">{state.found.is_admin ? "oui" : "non"}</dd>
            </div>
          </dl>
          {state.found.organizations.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-label font-semibold text-ink">Organisations</p>
              <ul className="flex flex-col gap-1 text-caption text-muted">
                {state.found.organizations.map((o) => (
                  <li key={o.organization_ref} className="break-words">
                    <span className="font-semibold text-ink">{o.name}</span> (<span className="font-mono">{o.organization_ref}</span>) — créée le{" "}
                    {day(o.created_at_server)}, {o.owner ? "titulaire" : "membre"}, {o.members} membre(s), {o.projects} chantier(s)
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-caption text-muted">Aucune organisation.</p>
          )}
        </Card>
      ) : null}
    </div>
  );
}

export function LicenseOfferForm({ price, isDemo }: { price: number; isDemo: boolean }) {
  const [state, formAction, pending] = useActionState<LicenseOfferState, FormData>(setLicenseOfferAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="expected_price_fcfa" value={price} />
      <TextField label="Nouveau prix (FCFA)" name="price_fcfa" required inputMode="numeric" defaultValue={String(price)} maxLength={12} />
      <label className="flex items-center gap-2 text-label text-ink">
        <input type="checkbox" name="price_is_demo" defaultChecked={isDemo} className="h-5 w-5" />
        Prix de démonstration (affiché comme tel aux déclarants)
      </label>
      <p className="text-caption text-muted">
        Le nouveau prix s&apos;applique aux prochaines déclarations ; les déclarations déjà faites gardent leur prix. L&apos;ancienne et la nouvelle valeur sont
        enregistrées dans le journal.
      </p>
      {state && "error" in state ? <AlertBanner variant="error" title="Modification impossible" explanation={state.error} /> : null}
      {state && "ok" in state ? <AlertBanner variant="information" title="Prix enregistré" explanation={`${state.price.toLocaleString("fr-FR")} FCFA${state.isDemo ? " (démonstration)" : ""}.`} /> : null}
      <div>
        <Button type="submit" size="compact" loading={pending}>
          Enregistrer le prix
        </Button>
      </div>
    </form>
  );
}
