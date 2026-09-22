"use client";

import { useActionState, useState } from "react";
import { Button, TextField, AlertBanner, Card } from "@/components/ui";
import { createDraftProject, type CreateDraftState } from "../actions";

interface Organization {
  id: string;
  name: string;
}

export interface NouveauChantierFormProps {
  organizations: Organization[];
}

// M004b create_draft_project : l'organisation n'est demandée explicitement
// que si plusieurs existent (jamais de choix arbitraire côté serveur) ;
// réutilisation ou création automatique sinon.
export function NouveauChantierForm({ organizations }: NouveauChantierFormProps) {
  const [state, formAction, pending] = useActionState<CreateDraftState, FormData>(
    createDraftProject,
    null
  );
  const [role, setRole] = useState<"OWNER" | "CONTRACTOR">("OWNER");

  return (
    <Card className="flex flex-col gap-4 p-6">
      {state?.error ? (
        <AlertBanner variant="error" title="Création impossible" explanation={state.error} />
      ) : null}
      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-label font-semibold text-ink">Rôle initial</span>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            <label className="flex items-center gap-2 text-body text-ink">
              <input
                type="radio"
                name="role"
                value="OWNER"
                checked={role === "OWNER"}
                onChange={() => setRole("OWNER")}
                className="h-4 w-4 accent-primary"
              />
              Propriétaire (OWNER)
            </label>
            <label className="flex items-center gap-2 text-body text-ink">
              <input
                type="radio"
                name="role"
                value="CONTRACTOR"
                checked={role === "CONTRACTOR"}
                onChange={() => setRole("CONTRACTOR")}
                className="h-4 w-4 accent-primary"
              />
              Entrepreneur (CONTRACTOR)
            </label>
          </div>
        </div>

        {role === "CONTRACTOR" && organizations.length > 1 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="organization_id" className="text-label font-semibold text-ink">
              Espace professionnel
              <span aria-hidden="true" className="text-danger">
                {" "}
                *
              </span>
            </label>
            <select
              id="organization_id"
              name="organization_id"
              required
              defaultValue=""
              className="h-12 rounded-small border border-muted bg-surface px-4 text-body text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <option value="" disabled>
                Choisir…
              </option>
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          // Le champ doit toujours être transmis (actions.ts distingue
          // désormais un champ absent d'un champ vide : l'absence est un
          // refus explicite, pas une résolution automatique). Vide ici =
          // résolution automatique par le RPC (réutilisation ou création).
          <input type="hidden" name="organization_id" value="" />
        )}

        {role === "CONTRACTOR" && organizations.length === 1 ? (
          <p className="text-caption text-muted">
            Chantier rattaché à : {organizations[0].name}
          </p>
        ) : null}

        {role === "CONTRACTOR" && organizations.length === 0 ? (
          <p className="text-caption text-muted">
            Aucun espace professionnel actif : « Espace professionnel » sera créé
            automatiquement.
          </p>
        ) : null}

        <TextField label="Nom du chantier" name="name" required />
        <TextField label="Pays" name="country" required />

        <Button type="submit" loading={pending}>
          Créer le chantier brouillon
        </Button>
      </form>
    </Card>
  );
}
