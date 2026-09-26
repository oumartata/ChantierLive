import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { AlertBanner, Card, StatusChip, EmptyState } from "@/components/ui";
import { DepositPlanForm } from "./DepositPlanForm";
import { AttachCatalogForm } from "./AttachCatalogForm";
import { PlanVersionActionButton } from "./PlanVersionActionButton";

const READ_URL_TTL_SECONDS = 60 * 10;
// Le fichier d'un plan rattaché depuis le catalogue reste dans le bucket du
// catalogue (version figée, jamais copiée) ; un dépôt direct vit dans project-plans.
const BUCKET_BY_ORIGIN: Record<string, string> = {
  CATALOG: "organization-catalog",
  DIRECT: "project-plans",
};

interface PlanCandidate {
  version_id: string;
  project_plan_id: string;
  origin: "CATALOG" | "DIRECT";
  version_number: number;
  deposited_as_role: "OWNER_PRIMARY" | "CONTRACTOR";
  created_by_profile_id: string;
  created_at_server: string;
  is_shared: boolean;
  is_retained: boolean;
}

interface CatalogItemRow {
  id: string;
  label: string;
  published_version_id: string | null;
  archived_at: string | null;
}

function depositorLabel(candidate: PlanCandidate, userId: string): string {
  if (candidate.created_by_profile_id === userId) return "vous";
  return candidate.deposited_as_role === "CONTRACTOR" ? "l'entrepreneur" : "le propriétaire";
}

// B063 (M020) — rattacher un plan au chantier. list_project_plan_candidates
// applique déjà le prédicat de lecture (project_plan_version_readable,
// D104/D105) ; cette page affiche ce qu'elle reçoit et ne propose une action
// qu'au rôle qui peut la faire, chaque RPC revérifiant les droits côté serveur.
// Hors périmètre : validation technique (B064), devis (B065), FR175.
export default async function PlansPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, organization_id, revision")
    .eq("id", id)
    .maybeSingle();

  if (!project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Plans du chantier</h1>
        <AlertBanner variant="error" title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />
      </div>
    );
  }

  const { data: membership } = await supabase
    .from("project_memberships")
    .select("role, owner_profile")
    .eq("project_id", id)
    .eq("profile_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();

  const isOwnerPrimary = membership?.role === "OWNER" && membership.owner_profile === "PRIMARY";
  const isContractor = membership?.role === "CONTRACTOR";

  if (!isOwnerPrimary && !isContractor) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Plans — {project.name}</h1>
        <AlertBanner
          variant="warning"
          title="Action indisponible"
          explanation="Seuls le propriétaire principal et l'entrepreneur de ce chantier déposent et choisissent les plans."
        />
      </div>
    );
  }

  const { data: candidatesData, error: candidatesError } = await supabase.rpc("list_project_plan_candidates", {
    p_project_id: id,
  });
  const candidates: PlanCandidate[] = Array.isArray(candidatesData) ? candidatesData : [];

  // Accès au catalogue (D107) : propriétaire de l'organisation du chantier
  // uniquement. Affichage indicatif, attach_catalog_plan_to_project revérifie.
  let publishedItems: { id: string; label: string }[] = [];
  if (project.organization_id) {
    const { data: organization } = await supabase
      .from("organizations")
      .select("id, owner_profile_id")
      .eq("id", project.organization_id)
      .maybeSingle();
    if (organization?.owner_profile_id === user.id) {
      const { data: items } = await supabase.rpc("list_organization_catalog_items", {
        p_organization_id: organization.id,
      });
      publishedItems = ((items ?? []) as CatalogItemRow[])
        .filter((item) => item.published_version_id !== null && item.archived_at === null)
        .map((item) => ({ id: item.id, label: item.label }));
    }
  }

  // URLs de lecture : get_project_plan_version_file_key statue d'abord sur le
  // droit de lire le fichier (session utilisateur), la signature Storage
  // privilégiée vient seulement après — jamais l'inverse.
  const service = createServiceClient();
  const readUrls = new Map<string, string>();
  for (const candidate of candidates) {
    const { data: storageKey } = await supabase.rpc("get_project_plan_version_file_key", {
      p_version_id: candidate.version_id,
    });
    if (typeof storageKey !== "string") continue;
    const { data: signed } = await service.storage
      .from(BUCKET_BY_ORIGIN[candidate.origin])
      .createSignedUrl(storageKey, READ_URL_TTL_SECONDS);
    if (signed?.signedUrl) readUrls.set(candidate.version_id, signed.signedUrl);
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Plans — {project.name}</h1>

      <Card className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Déposer un plan</h2>
        <p className="text-caption text-muted">
          {isContractor
            ? "Le plan reste visible par vous seul jusqu'à ce que vous le partagiez avec le propriétaire."
            : "Le plan est visible par vous et par l'entrepreneur du chantier."}
        </p>
        <DepositPlanForm projectId={project.id} />
      </Card>

      {publishedItems.length > 0 ? (
        <Card className="flex flex-col gap-4">
          <h2 className="text-h2 font-semibold text-ink">Depuis le catalogue</h2>
          <p className="text-caption text-muted">La version publiée au moment du rattachement est conservée telle quelle.</p>
          <AttachCatalogForm projectId={project.id} items={publishedItems} />
        </Card>
      ) : null}

      <Card className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Plans candidats</h2>
        {isOwnerPrimary ? (
          <p className="text-caption text-muted">
            Retenir un plan n&apos;est ni une validation technique ni une autorisation de démarrer les travaux.
          </p>
        ) : null}
        {candidatesError ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
        ) : candidates.length === 0 ? (
          <EmptyState title="Aucun plan" description="Aucun plan n'est encore rattaché à ce chantier." />
        ) : (
          <ul className="flex flex-col gap-4">
            {candidates.map((candidate, index) => {
              const url = readUrls.get(candidate.version_id);
              const canShare =
                isContractor &&
                candidate.deposited_as_role === "CONTRACTOR" &&
                candidate.created_by_profile_id === user.id &&
                !candidate.is_shared;
              return (
                <li
                  key={candidate.version_id}
                  className="flex flex-col gap-3 border-b border-sand pb-4 last:border-b-0 last:pb-0"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-label font-semibold text-ink">Plan {candidates.length - index}</span>
                    {candidate.is_retained ? <StatusChip variant="success" label="Retenu" /> : null}
                  </div>
                  <p className="text-caption text-muted">
                    {candidate.origin === "CATALOG" ? "Rattaché depuis le catalogue" : "Déposé"} par{" "}
                    {depositorLabel(candidate, user.id)} le{" "}
                    {new Date(candidate.created_at_server).toLocaleDateString("fr-FR")}
                  </p>
                  {/* Dépôt direct ou rattachement catalogue : une version CONTRACTOR
                      reste privée jusqu'au partage explicite (D104). */}
                  {candidate.deposited_as_role === "CONTRACTOR" ? (
                    <StatusChip
                      variant={candidate.is_shared ? "info" : "neutral"}
                      label={candidate.is_shared ? "Partagé avec le propriétaire" : "Non partagé"}
                      className="self-start"
                    />
                  ) : null}
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="text-label font-semibold text-primary">
                      Ouvrir le fichier
                    </a>
                  ) : (
                    <p className="text-caption text-muted">Fichier indisponible pour le moment.</p>
                  )}
                  {canShare ? (
                    <PlanVersionActionButton kind="share" projectId={project.id} versionId={candidate.version_id} />
                  ) : null}
                  {isOwnerPrimary && !candidate.is_retained ? (
                    <PlanVersionActionButton
                      kind="retain"
                      projectId={project.id}
                      versionId={candidate.version_id}
                      expectedRevision={project.revision}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
