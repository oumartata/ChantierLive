"use client";

import { useActionState, useState } from "react";
import { Button, TextField, AlertBanner, Card } from "@/components/ui";
import { updateDraftProject, type UpdateDraftState } from "../../actions";

interface Project {
  id: string;
  name: string;
  country: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  // Chaîne, jamais number : voir le cast budget::text dans page.tsx —
  // préserve la précision exacte d'un bigint au-delà de 2^53-1.
  budget: string | null;
  revision: number;
}

export interface ModifierChantierFormProps {
  project: Project;
}

// Champs contrôlés, initialisés une seule fois au montage (useState sans
// resynchronisation sur les props). Nécessaire car Next.js re-render le
// Server Component parent (donc de nouvelles props `project`, révision
// incluse) après chaque appel de Server Action, même sans redirection —
// un champ non contrôlé (defaultValue) ou une valeur dérivée directement de
// `project.revision` serait silencieusement réinitialisé ou avancé à
// l'insu de l'utilisateur. Ici, ni la saisie ni la révision attendue ne
// bougent tant que le composant n'est pas réellement remonté (rechargement
// complet de la page, lien natif ci-dessous — jamais une nouvelle tentative
// automatique avec une révision plus récente).
export function ModifierChantierForm({ project }: ModifierChantierFormProps) {
  const [state, formAction, pending] = useActionState<UpdateDraftState, FormData>(
    updateDraftProject,
    null
  );

  const [initialProject] = useState(project);
  const [name, setName] = useState(project.name);
  const [country, setCountry] = useState(project.country);
  const [address, setAddress] = useState(project.address ?? "");
  const [latitude, setLatitude] = useState(project.latitude?.toString() ?? "");
  const [longitude, setLongitude] = useState(project.longitude?.toString() ?? "");
  const [plannedStartDate, setPlannedStartDate] = useState(project.planned_start_date ?? "");
  const [plannedEndDate, setPlannedEndDate] = useState(project.planned_end_date ?? "");
  // project.budget est déjà une chaîne exacte (cast SQL) : pas de
  // .toString() sur un number ici, ce qui ne ferait que reformater une
  // valeur potentiellement déjà tronquée par une lecture JSON antérieure.
  const [budget, setBudget] = useState(project.budget ?? "");

  return (
    <Card className="flex flex-col gap-4 p-6">
      {state?.error ? (
        <AlertBanner
          variant="error"
          title={state.conflict ? "Conflit de modification" : "Modification impossible"}
          explanation={state.error}
          action={
            state.conflict ? (
              // Lien natif (pas next/link) : force un rechargement complet
              // de la page pour relire la révision réelle. Jamais une
              // nouvelle tentative automatique.
              <a
                href={`/chantiers/${initialProject.id}/modifier`}
                className="text-label font-semibold text-primary"
              >
                Recharger les données
              </a>
            ) : undefined
          }
        />
      ) : null}
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="project_id" value={initialProject.id} />
        <input type="hidden" name="expected_revision" value={initialProject.revision} />

        <TextField
          label="Nom du chantier"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <TextField
          label="Pays"
          name="country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          required
        />
        <TextField
          label="Adresse"
          name="address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <TextField
          label="Latitude"
          name="latitude"
          type="number"
          step="any"
          value={latitude}
          onChange={(e) => setLatitude(e.target.value)}
        />
        <TextField
          label="Longitude"
          name="longitude"
          type="number"
          step="any"
          value={longitude}
          onChange={(e) => setLongitude(e.target.value)}
        />
        <TextField
          label="Date de début prévue"
          name="planned_start_date"
          type="date"
          value={plannedStartDate}
          onChange={(e) => setPlannedStartDate(e.target.value)}
        />
        <TextField
          label="Date de fin prévue"
          name="planned_end_date"
          type="date"
          value={plannedEndDate}
          onChange={(e) => setPlannedEndDate(e.target.value)}
        />
        {/* type="text" plutôt que "number" : un input number peut reformater
            un entier hors de la plage sûre de Number lors d'interactions du
            widget (incréments, validation native) — la validation réelle
            (entier décimal, plage bigint) reste dans actions.ts. */}
        <TextField
          label="Budget"
          name="budget"
          type="text"
          inputMode="numeric"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />

        <Button type="submit" loading={pending}>
          Enregistrer
        </Button>
      </form>
    </Card>
  );
}
