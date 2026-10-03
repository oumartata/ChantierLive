import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, StatusChip } from "@/components/ui";
import { CreateItemForm } from "./CreateItemForm";
import { UploadVersionForm } from "./UploadVersionForm";
import { UploadModifiableVersionForm } from "./UploadModifiableVersionForm";
import { CatalogVersionFileLinks } from "./CatalogVersionFileLinks";
import { SubmitForValidationForm } from "./SubmitForValidationForm";
import { PublishVersionButton } from "./PublishVersionButton";

interface CatalogItemRow {
  id: string;
  label: string;
  published_version_id: string | null;
  published_at_server: string | null;
  archived_at: string | null;
  latest_version_id: string | null;
  latest_version_number: number | null;
  latest_validation_status: string | null;
  // CORRIGÉ (revue ciblée, point 6) : numéro PROPRE à la version publiée,
  // jamais déduit de latest_version_number — un dépôt v2 après publication
  // de v1 ne doit jamais faire apparaître "Publié (v2)".
  published_version_number: number | null;
  // CORRIGÉ (revue ciblée, point 5) : permet de proposer une nouvelle
  // soumission quand la demande PENDING actuelle référence une désignation
  // révoquée, sans jamais le faire pour une désignation encore active.
  latest_validation_designation_active: boolean | null;
}

interface EngineerDesignation {
  id: string;
  designated_identifier_value_normalized: string;
  revoked_at: string | null;
}

// B061 (M019) — terminée et validée par le fondateur : catalogue de plans par agence.
// Réservé au propriétaire COURANT de l'organisation, revérifié ici pour
// l'affichage ET par chaque RPC appelée (defense in depth). Le statut de
// validation affiché (latest_validation_status) est une LECTURE seule, la
// décision réelle reste entièrement portée par decide_catalog_item_validation
// (parcours ingénieur, /validations-plans).
export default async function OrganisationCataloguePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: organizationId } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select("id, name, owner_profile_id")
    .eq("id", organizationId)
    .maybeSingle();

  if (organizationError || !organization) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <AlertBanner variant="error" title="Organisation introuvable" explanation="Vérifiez le lien ou vos droits d'accès." />
      </div>
    );
  }

  if (organization.owner_profile_id !== user.id) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <AlertBanner
          variant="warning"
          title="Réservé au propriétaire"
          explanation="Seul le propriétaire de l'organisation gère le catalogue de plans."
        />
      </div>
    );
  }

  const [{ data: items, error: itemsError }, { data: engineers, error: engineersError }] = await Promise.all([
    supabase.rpc("list_organization_catalog_items", { p_organization_id: organizationId }),
    supabase.rpc("list_organization_engineers", { p_organization_id: organizationId }),
  ]);

  const activeEngineers = ((engineers ?? []) as EngineerDesignation[]).filter((e) => e.revoked_at === null);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Catalogue de plans — {organization.name}</h1>
      <Card className="flex flex-col gap-4">
        <CreateItemForm organizationId={organization.id} />
      </Card>
      <Card className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Modèles</h2>
        {itemsError ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
        ) : (items ?? []).length === 0 ? (
          <p className="text-body text-muted">Aucun modèle pour l&apos;instant.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {(items as CatalogItemRow[]).map((item) => (
              <li key={item.id} className="flex flex-col gap-3 border-b border-sand pb-4 last:border-b-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-label font-semibold text-ink">{item.label}</span>
                  {item.published_version_id ? (
                    <StatusChip variant="success" label={`Publié (v${item.published_version_number ?? "?"})`} />
                  ) : (
                    <StatusChip variant="neutral" label="Non publié" />
                  )}
                </div>
                {item.latest_version_id ? (
                  <p className="text-caption text-muted">
                    Dernière version : v{item.latest_version_number} —{" "}
                    {item.latest_validation_status === "VALIDATED"
                      ? "validée techniquement"
                      : item.latest_validation_status === "REJECTED"
                        ? "rejetée par l'ingénieur"
                        : item.latest_validation_status === "PENDING"
                          ? "en attente de décision"
                          : item.latest_validation_status === "CANCELLED"
                            ? "demande annulée (désignation révoquée), à re-soumettre"
                            : "jamais soumise"}
                  </p>
                ) : (
                  <p className="text-caption text-muted">Aucune version déposée.</p>
                )}
                <UploadVersionForm organizationId={organization.id} catalogItemId={item.id} />
                <UploadModifiableVersionForm organizationId={organization.id} catalogItemId={item.id} />
                {item.latest_version_id ? <CatalogVersionFileLinks versionId={item.latest_version_id} /> : null}
                {(() => {
                  // CORRIGÉ (revue ciblée, point 5) : une demande PENDING dont
                  // la désignation a été révoquée ne bloque plus la
                  // resoumission dans l'interface — submit_catalog_item_
                  // version_for_validation la clôt (CANCELLED) puis accepte
                  // la nouvelle. Le refus already_pending reste opposé par la
                  // RPC elle-même tant que la désignation référencée est
                  // encore active — l'affichage suit cette même règle, ne la
                  // contourne pas.
                  const pendingWithRevokedDesignation =
                    item.latest_validation_status === "PENDING" && item.latest_validation_designation_active === false;
                  const canSubmit =
                    !!item.latest_version_id &&
                    (item.latest_validation_status !== "PENDING" || pendingWithRevokedDesignation);
                  if (!canSubmit) return null;
                  return (
                    <>
                      {pendingWithRevokedDesignation ? (
                        <p className="text-caption text-muted">
                          La désignation précédente a été révoquée : vous pouvez soumettre à nouveau.
                        </p>
                      ) : null}
                      {activeEngineers.length === 0 ? (
                        <p className="text-caption text-muted">
                          Aucun ingénieur habilité actif. Désignez-en un pour soumettre cette version.
                        </p>
                      ) : (
                        <SubmitForValidationForm
                          organizationId={organization.id}
                          versionId={item.latest_version_id as string}
                          engineers={activeEngineers.map((e) => ({ id: e.id, label: e.designated_identifier_value_normalized }))}
                        />
                      )}
                    </>
                  );
                })()}
                {item.latest_version_id && item.latest_validation_status === "VALIDATED" && item.published_version_id !== item.latest_version_id ? (
                  <PublishVersionButton organizationId={organization.id} versionId={item.latest_version_id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {engineersError ? (
          <AlertBanner variant="error" title="Lecture des ingénieurs impossible" explanation="Réessayez plus tard." />
        ) : null}
      </Card>
    </div>
  );
}
