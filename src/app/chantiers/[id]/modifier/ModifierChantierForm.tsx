"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button, TextField, AlertBanner, Card } from "@/components/ui";
import { updateDraftProject, type UpdateDraftState } from "../../actions";

interface LocationPreview {
  latitude: number;
  longitude: number;
  accuracy: number;
}

type LocationStatus = "idle" | "pending" | "preview" | "error";

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

  // Position sur demande (B014, tranche 1) — jamais de suivi continu
  // (aucun watchPosition). La position reçue reste en PRÉVISUALISATION
  // séparée : elle n'écrit jamais directement latitude/longitude tant que
  // l'utilisateur n'a pas cliqué "Confirmer" — une erreur, une annulation ou
  // une réponse tardive ne touche donc jamais la saisie manuelle en cours.
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("idle");
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationPreview, setLocationPreview] = useState<LocationPreview | null>(null);
  // Identifiant croissant plutôt qu'un simple booléen "en cours" : si une
  // demande est annulée puis qu'une nouvelle est lancée avant que l'ancienne
  // réponse du navigateur n'arrive, un booléen ne distinguerait pas laquelle
  // des deux réponses est la bonne. Chaque callback ne s'applique que s'il
  // porte encore l'identifiant courant au moment où il arrive.
  const locationRequestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      // Démontage : invalide toute réponse encore en vol pour ce composant.
      locationRequestIdRef.current += 1;
    };
  }, []);

  function handleUseMyLocation() {
    setLocationError(null);
    setLocationPreview(null);

    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setLocationStatus("error");
      setLocationError("La géolocalisation n'est pas disponible sur cet appareil.");
      return;
    }

    const requestId = ++locationRequestIdRef.current;
    setLocationStatus("pending");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (locationRequestIdRef.current !== requestId) return; // réponse tardive : ignorée
        setLocationPreview({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setLocationStatus("preview");
      },
      (err) => {
        if (locationRequestIdRef.current !== requestId) return; // réponse tardive : ignorée
        setLocationStatus("error");
        if (err.code === err.PERMISSION_DENIED) {
          setLocationError("Autorisation de localisation refusée. Saisissez les coordonnées manuellement.");
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setLocationError("Position indisponible. Réessayez ou saisissez les coordonnées manuellement.");
        } else if (err.code === err.TIMEOUT) {
          setLocationError("Délai dépassé. Réessayez ou saisissez les coordonnées manuellement.");
        } else {
          setLocationError("Impossible d'obtenir la position. Saisissez les coordonnées manuellement.");
        }
      },
      { timeout: 10000 }
    );
  }

  function handleCancelLocation() {
    // Invalide aussi une réponse déjà en vol pour cette demande précise.
    locationRequestIdRef.current += 1;
    setLocationStatus("idle");
    setLocationPreview(null);
    setLocationError(null);
  }

  function handleConfirmLocation() {
    if (!locationPreview) return;
    // Seule action qui copie la prévisualisation dans le formulaire : la
    // position n'est toujours pas enregistrée, seul "Enregistrer" persiste.
    setLatitude(locationPreview.latitude.toString());
    setLongitude(locationPreview.longitude.toString());
    setLocationStatus("idle");
    setLocationPreview(null);
  }

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
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="compact"
              loading={locationStatus === "pending"}
              disabled={locationStatus === "pending"}
              onClick={handleUseMyLocation}
            >
              Utiliser ma position
            </Button>
            {locationStatus === "pending" ? (
              <Button type="button" variant="ghost" size="compact" onClick={handleCancelLocation}>
                Annuler
              </Button>
            ) : null}
          </div>

          {locationStatus === "preview" && locationPreview ? (
            <AlertBanner
              variant="information"
              title="Position reçue — à confirmer"
              explanation={`Latitude ${locationPreview.latitude}, longitude ${locationPreview.longitude}. Précision affichée par l'appareil : environ ${Math.round(locationPreview.accuracy)} m.`}
              action={
                <div className="flex gap-2">
                  <Button type="button" size="compact" onClick={handleConfirmLocation}>
                    Cette position correspond au chantier
                  </Button>
                  <Button type="button" variant="ghost" size="compact" onClick={handleCancelLocation}>
                    Annuler
                  </Button>
                </div>
              }
            />
          ) : null}

          {locationStatus === "error" && locationError ? (
            <AlertBanner variant="error" title="Position non obtenue" explanation={locationError} />
          ) : null}
        </div>

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
