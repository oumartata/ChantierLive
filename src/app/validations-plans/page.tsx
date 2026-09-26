import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card } from "@/components/ui";
import { DecideValidationCard } from "./DecideValidationCard";

interface SubmittedProjectValidation {
  validation_id: string;
  project_plan_version_id: string;
  origin: "CATALOG" | "DIRECT";
  submitted_at_server: string;
}

interface SubmittedValidation {
  validation_id: string;
  version_id: string;
  catalog_item_id: string;
  organization_id: string;
  version_number: number;
  submitted_at_server: string;
}

// B061 (M019) — terminée et validée par le fondateur : parcours INGÉNIEUR. Une seule liste,
// tous droits organisationnels confondus (un ingénieur peut être désigné par
// plusieurs agences) — list_submitted_catalog_item_validations limite déjà
// strictement aux demandes PENDING dont la désignation référencée est active
// et lui appartient (jamais un brouillon, jamais une autre agence).
export default async function ValidationsPlansPage() {
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const [{ data: validations, error }, { data: projectValidations, error: projectError }] = await Promise.all([
    supabase.rpc("list_submitted_catalog_item_validations"),
    // B064 : plans de chantier, liste distincte (aucune équivalence avec le catalogue).
    supabase.rpc("list_submitted_plan_validations"),
  ]);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Plans à valider</h1>
      <Card className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Plans de chantier</h2>
        {projectError ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
        ) : (projectValidations ?? []).length === 0 ? (
          <p className="text-body text-muted">Aucun plan de chantier en attente.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {(projectValidations as SubmittedProjectValidation[]).map((v) => (
              <DecideValidationCard
                key={v.validation_id}
                validationId={v.validation_id}
                variant="project"
                title={`Plan de chantier ${v.origin === "CATALOG" ? "(issu du catalogue)" : "(dépôt direct)"} — soumis le ${new Date(v.submitted_at_server).toLocaleDateString("fr-FR")}`}
              />
            ))}
          </ul>
        )}
      </Card>
      <Card className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Modèles de catalogue</h2>
        {error ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
        ) : (validations ?? []).length === 0 ? (
          <p className="text-body text-muted">Aucune demande de validation en attente.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {(validations as SubmittedValidation[]).map((v) => (
              <DecideValidationCard key={v.validation_id} validationId={v.validation_id} versionNumber={v.version_number} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
