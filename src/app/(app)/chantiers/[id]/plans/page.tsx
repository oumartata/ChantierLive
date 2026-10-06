import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { AlertBanner, Button, Card, StatusChip, EmptyState } from "@/components/ui";
import { DepositPlanForm } from "./DepositPlanForm";
import { AttachCatalogForm } from "./AttachCatalogForm";
import { PlanVersionActionButton } from "./PlanVersionActionButton";
import { ResumeCatalogueCopyButton } from "./ResumeCatalogueCopyButton";
import type { PlanRequestRow } from "./actions";

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

interface PlanRequestOrigin {
  request_id: string;
  has_catalog_source: boolean;
  source_details_visible: boolean;
  catalog_item_label: string | null;
  catalog_version_number: number | null;
}

interface CatalogItemRow {
  id: string;
  label: string;
  published_version_id: string | null;
  archived_at: string | null;
}

interface PlanValidationView {
  validation_id: string;
  project_plan_version_id: string;
  status: "PENDING" | "VALIDATED" | "REJECTED" | "CANCELLED";
  submitted_at_server: string;
  decided_at_server: string | null;
  decision_note: string | null;
  engineer_identifier_masked: string;
  designation_active: boolean;
}

interface PlanEngineer {
  designation_id: string;
  identifier_masked: string;
}

interface PublicationView {
  publication_id: string;
  project_plan_version_id: string;
  published_at_server: string;
}

interface SiteManagerShare {
  id: string;
  project_plan_version_id: string;
  site_manager_membership_id: string;
}

const VALIDATION_CHIP: Record<PlanValidationView["status"], { variant: "info" | "success" | "danger" | "neutral"; label: string }> = {
  PENDING: { variant: "info", label: "En attente de validation technique" },
  VALIDATED: { variant: "success", label: "Validé techniquement" },
  REJECTED: { variant: "danger", label: "Rejeté par l'ingénieur" },
  CANCELLED: { variant: "neutral", label: "Demande annulée" },
};

// B064 — plan ACTUELLEMENT publié (D096/D111) : get_published_project_plan_file
// statue sur le droit de lecture avant toute signature Storage privilégiée.
async function PublishedPlanCard({ projectId, isSiteManager }: { projectId: string; isSiteManager: boolean }) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_published_project_plan_file", { p_project_id: projectId });
  const row = Array.isArray(data) ? data[0] : data;
  let url: string | null = null;
  if (!error && row?.storage_key) {
    const { data: signed } = await createServiceClient()
      .storage.from(row.bucket)
      .createSignedUrl(row.storage_key, READ_URL_TTL_SECONDS);
    url = signed?.signedUrl ?? null;
  }
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-h2 font-semibold text-ink">Plan publié</h2>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-label font-semibold text-primary">
          Ouvrir le plan publié
        </a>
      ) : error?.message === "not_published" ? (
        <p className="text-body text-muted">Aucun plan n&apos;est encore publié sur ce chantier.</p>
      ) : isSiteManager && error?.message === "not_authorized" ? (
        <p className="text-body text-muted">L&apos;entrepreneur ne vous a pas encore donné accès au plan publié.</p>
      ) : (
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      )}
    </Card>
  );
}

function depositorLabel(candidate: PlanCandidate, userId: string): string {
  if (candidate.created_by_profile_id === userId) return "vous";
  return candidate.deposited_as_role === "CONTRACTOR" ? "l'entrepreneur" : "le propriétaire";
}

// B063 (M020) — rattacher un plan au chantier. list_project_plan_candidates
// applique déjà le prédicat de lecture (project_plan_version_readable,
// D104/D105) ; cette page affiche ce qu'elle reçoit et ne propose une action
// qu'au rôle qui peut la faire, chaque RPC revérifiant les droits côté serveur.
// B064 : validation technique, publication et partage SITE_MANAGER ajoutés ci-dessous.
// Hors périmètre : devis (B065), autorisation de démarrage (B067), FR175.
export default async function PlansPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, organization_id, revision, published_plan_version_id")
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
  const isCoOwner = membership?.role === "OWNER" && membership.owner_profile === "CO_OWNER";
  const isSiteManager = membership?.role === "SITE_MANAGER";

  // B064 (D096/D111) : CO_OWNER et SITE_MANAGER ne voient que le plan publié,
  // jamais les candidats ni les brouillons.
  if (isCoOwner || isSiteManager) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Plans — {project.name}</h1>
        <PublishedPlanCard projectId={project.id} isSiteManager={isSiteManager} />
      </div>
    );
  }

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

  // Demandes de plan (Lot 2/3, PREPARATION_INTEGRATION_METIER.md, M031) —
  // mêmes lecteurs que les candidats (OWNER_PRIMARY/CONTRACTOR, déjà garanti
  // par le refus plus haut) ; list_plan_requests revérifie côté serveur.
  const { data: planRequestsData, error: planRequestsError } = await supabase.rpc("list_plan_requests", {
    p_project_id: id,
  });
  const planRequests: PlanRequestRow[] = Array.isArray(planRequestsData) ? planRequestsData : [];
  // Origine des demandes (M035) : mêmes lecteurs que list_plan_requests ;
  // libellé et version du modèle seulement pour qui lit déjà le catalogue.
  // Jamais d'accès au modèle ni à son fichier par ce chemin.
  const { data: originsData } = await supabase.rpc("list_plan_request_origins", { p_project_id: id });
  const origins = new Map<string, PlanRequestOrigin>(
    (Array.isArray(originsData) ? (originsData as PlanRequestOrigin[]) : []).map((o) => [o.request_id, o])
  );

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

  // B064 — validations (versions lisibles seulement), ingénieurs de l'agence
  // (CONTRACTOR, identifiant masqué), historique de publication, octrois.
  const [{ data: validationsData }, { data: publicationsData }] = await Promise.all([
    supabase.rpc("list_project_plan_validations", { p_project_id: id }),
    supabase.rpc("list_project_plan_publications", { p_project_id: id }),
  ]);
  const validations: PlanValidationView[] = Array.isArray(validationsData) ? validationsData : [];
  const publications: PublicationView[] = Array.isArray(publicationsData) ? publicationsData : [];
  const latestValidation = new Map<string, PlanValidationView>();
  for (const v of validations) {
    if (!latestValidation.has(v.project_plan_version_id)) latestValidation.set(v.project_plan_version_id, v);
  }
  const validatedVersions = new Set(validations.filter((v) => v.status === "VALIDATED").map((v) => v.project_plan_version_id));

  let engineers: PlanEngineer[] = [];
  let siteManagers: { id: string; created_at_server: string }[] = [];
  let shares: SiteManagerShare[] = [];
  if (isContractor) {
    if (project.organization_id) {
      const { data } = await supabase.rpc("list_project_plan_engineers", { p_project_id: id });
      engineers = Array.isArray(data) ? data : [];
    }
    const [{ data: members }, { data: sharesData }] = await Promise.all([
      supabase
        .from("project_memberships")
        .select("id, created_at_server")
        .eq("project_id", id)
        .eq("role", "SITE_MANAGER")
        .is("revoked_at", null)
        .order("created_at_server", { ascending: true }),
      supabase.rpc("list_project_plan_shares", { p_project_id: id }),
    ]);
    siteManagers = members ?? [];
    shares = Array.isArray(sharesData) ? sharesData : [];
  }
  const planNumber = new Map(candidates.map((c, index) => [c.version_id, candidates.length - index]));

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

      <PublishedPlanCard projectId={project.id} isSiteManager={false} />

      <Card className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <h2 className="text-h2 font-semibold text-ink">Importer un plan existant</h2>
          <p className="text-caption text-muted">
            {isContractor
              ? "Le plan reste visible par vous seul jusqu'à ce que vous le partagiez avec le propriétaire."
              : "Le plan est visible par vous et par l'entrepreneur du chantier."}
          </p>
          <DepositPlanForm projectId={project.id} />
        </div>

        <div className="flex flex-col gap-2 border-t border-sand pt-4">
          <h2 className="text-h2 font-semibold text-ink">Essayer le générateur 2D</h2>
          <p className="text-caption text-muted">
            Prototype d&apos;avant-projet. Le résultat n&apos;est pas enregistré automatiquement dans ce chantier.
          </p>
          {/* Amélioration de navigation uniquement — aucune intégration T1/T2.
              Seul l'identifiant du chantier est transmis (destination interne
              reconstruite et validée côté /prototype-plans), rien d'autre. */}
          <Link href={`/prototype-plans?retour=${project.id}`} className="w-fit">
            <Button variant="secondary" size="compact">
              Essayer le générateur 2D
            </Button>
          </Link>
        </div>

        <div className="flex flex-col gap-2 border-t border-sand pt-4">
          <h2 className="text-h2 font-semibold text-ink">Demandes de plan</h2>
          <p className="text-caption text-muted">
            Une demande regroupe les paramètres de génération et les variantes sauvegardées pour les explorer. Modifier
            les paramètres crée une nouvelle demande ; modifier une variante sauvegardée en crée une nouvelle, sans
            jamais écraser l&apos;historique.
          </p>
          <Link href={`/prototype-plans?retour=${project.id}&demande=new`} className="w-fit">
            <Button variant="secondary" size="compact">
              Créer une nouvelle demande
            </Button>
          </Link>
          {planRequestsError ? (
            <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
          ) : planRequests.length === 0 ? (
            <p className="text-caption text-muted">Aucune demande pour l&apos;instant.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {planRequests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded border border-sand p-2 text-caption">
                  <StatusChip
                    variant={r.status === "DEPOSITED" ? "success" : r.status === "CANCELLED" ? "neutral" : "info"}
                    label={r.status === "OPEN" ? "En cours" : r.status === "DEPOSITED" ? "Déposée" : "Annulée"}
                  />
                  <span>{new Date(r.created_at_server).toLocaleString("fr-FR")}</span>
                  <span className="text-muted">
                    {r.variant_count} variante{r.variant_count > 1 ? "s" : ""}
                  </span>
                  <span className="text-muted" data-testid="origine-demande">
                    {(() => {
                      const o = origins.get(r.id);
                      if (!o || !o.has_catalog_source) return "Origine non renseignée";
                      if (o.source_details_visible && o.catalog_item_label) {
                        return `Origine : modèle « ${o.catalog_item_label} », version ${o.catalog_version_number ?? "?"} (catalogue)`;
                      }
                      return "Origine : un modèle du catalogue de l'entreprise";
                    })()}
                  </span>
                  {r.status === "OPEN" && Number(r.variant_count) === 0 && origins.get(r.id)?.has_catalog_source ? (
                    // Copie de modèle interrompue avant sa variante 1 : seule
                    // la personne qui l'a lancée peut la terminer (revérifié
                    // côté serveur et en base, M035/M034).
                    r.created_by_profile_id === user.id ? (
                      <ResumeCatalogueCopyButton requestId={r.id} />
                    ) : (
                      <span className="text-muted">Copie interrompue : seule la personne qui l&apos;a lancée peut la terminer.</span>
                    )
                  ) : null}
                  {r.status === "OPEN" ? (
                    <Link href={`/prototype-plans?retour=${project.id}&demande=${r.id}`} className="font-semibold text-primary">
                      {Number(r.variant_count) === 0 && origins.get(r.id)?.has_catalog_source ? "Ouvrir la demande vide →" : "Reprendre →"}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
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
        {isContractor && !project.organization_id ? (
          <p className="text-caption text-muted">
            Ce chantier n&apos;est rattaché à aucune organisation : la soumission à un ingénieur n&apos;est pas disponible.
          </p>
        ) : null}
        {isContractor && project.organization_id && engineers.length === 0 ? (
          <p className="text-caption text-muted">Aucun ingénieur habilité actif dans votre organisation.</p>
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
                    <div className="flex flex-wrap justify-end gap-2">
                      {candidate.is_retained ? <StatusChip variant="success" label="Retenu" /> : null}
                      {project.published_plan_version_id === candidate.version_id ? (
                        <StatusChip variant="success" label="Publié" />
                      ) : null}
                    </div>
                  </div>
                  {latestValidation.has(candidate.version_id) ? (
                    <StatusChip
                      variant={VALIDATION_CHIP[latestValidation.get(candidate.version_id)!.status].variant}
                      label={`${VALIDATION_CHIP[latestValidation.get(candidate.version_id)!.status].label} (${latestValidation.get(candidate.version_id)!.engineer_identifier_masked})`}
                      className="self-start"
                    />
                  ) : null}
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
                  {latestValidation.get(candidate.version_id)?.status === "PENDING" &&
                  !latestValidation.get(candidate.version_id)?.designation_active ? (
                    <p className="text-caption text-muted">
                      L&apos;ingénieur de cette demande n&apos;est plus habilité : elle ne peut plus aboutir.
                    </p>
                  ) : null}
                  {/* Soumission : aucune demande en cours, ou demande PENDING dont la
                      désignation est révoquée (la RPC la clôt puis en crée une nouvelle). */}
                  {isContractor &&
                  engineers.length > 0 &&
                  !validatedVersions.has(candidate.version_id) &&
                  (latestValidation.get(candidate.version_id)?.status !== "PENDING" ||
                    !latestValidation.get(candidate.version_id)?.designation_active) ? (
                    <PlanVersionActionButton
                      kind="submit"
                      projectId={project.id}
                      versionId={candidate.version_id}
                      select={{
                        name: "designation_id",
                        label: "Ingénieur habilité",
                        options: engineers.map((e) => ({ value: e.designation_id, label: e.identifier_masked })),
                      }}
                    />
                  ) : null}
                  {isContractor &&
                  candidate.is_retained &&
                  validatedVersions.has(candidate.version_id) &&
                  project.published_plan_version_id !== candidate.version_id ? (
                    <PlanVersionActionButton
                      kind="publish"
                      projectId={project.id}
                      versionId={candidate.version_id}
                      expectedRevision={project.revision}
                    />
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

      {publications.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-h2 font-semibold text-ink">Historique des publications</h2>
          <ul className="flex flex-col gap-1">
            {publications.map((p) => (
              <li key={p.publication_id} className="text-caption text-ink">
                {planNumber.has(p.project_plan_version_id) ? `Plan ${planNumber.get(p.project_plan_version_id)}` : "Plan"} publié le{" "}
                {new Date(p.published_at_server).toLocaleString("fr-FR")}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {isContractor && project.published_plan_version_id && siteManagers.length > 0 ? (
        <Card className="flex flex-col gap-4">
          <h2 className="text-h2 font-semibold text-ink">Accès des chefs de chantier</h2>
          <p className="text-caption text-muted">
            L&apos;accès porte uniquement sur le plan actuellement publié ; une nouvelle publication demande un nouvel accès.
          </p>
          <ul className="flex flex-col gap-3">
            {siteManagers.map((sm, index) => {
              const share = shares.find(
                (s) => s.site_manager_membership_id === sm.id && s.project_plan_version_id === project.published_plan_version_id
              );
              return (
                <li key={sm.id} className="flex flex-col gap-2 border-b border-sand pb-3 last:border-b-0 last:pb-0">
                  <span className="text-label text-ink">
                    Chef de chantier {index + 1} — ajouté le {new Date(sm.created_at_server).toLocaleDateString("fr-FR")}
                  </span>
                  {share ? (
                    <PlanVersionActionButton kind="revokeSiteManager" projectId={project.id} hidden={{ share_id: share.id }} />
                  ) : (
                    <PlanVersionActionButton
                      kind="grantSiteManager"
                      projectId={project.id}
                      versionId={project.published_plan_version_id as string}
                      hidden={{ membership_id: sm.id }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
