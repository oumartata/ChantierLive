import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card } from "@/components/ui";
import { modelReference } from "@/app/prototype-plans/catalogueCopy";
import { listCatalogueCopyDestinations, loadCatalogueCopySource } from "@/lib/plans/catalogueCopySource";
import { CopyToProjectForm } from "./CopyToProjectForm";

// Catalogue modifiable — copier un modèle vers un chantier (premier sous-lot,
// sans migration). Mêmes droits que la gestion du catalogue pour lire le
// modèle (propriétaire de l'organisation, revérifié par les fonctions
// appelées) ; le chantier destinataire est contrôlé séparément (adhésion
// active + rattachement à l'organisation, D107).
export default async function CopyCatalogItemPage({ params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id: organizationId, itemId } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const supabase = await createClient();
  const backHref = `/organisations/${organizationId}/catalogue`;
  const source = await loadCatalogueCopySource(supabase, organizationId, itemId);

  if (!source.ok) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <Link href={backHref} className="text-label font-semibold text-primary">
          ← Retour au catalogue
        </Link>
        <AlertBanner
          variant="warning"
          title={"flat" in source ? `« ${source.label} » n'est pas éditable` : "Copie impossible"}
          explanation={source.message}
        />
      </div>
    );
  }

  const destinations = await listCatalogueCopyDestinations(supabase, user.id, organizationId);
  const reference = modelReference(source.value.file);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <Link href={backHref} className="text-label font-semibold text-primary">
        ← Retour au catalogue
      </Link>
      <h1 className="text-h1 font-bold text-ink">Copier « {source.value.label} » vers un chantier</h1>
      <Card className="flex flex-col gap-2">
        <p className="text-body text-ink">
          La copie est un plan <strong>indépendant</strong> : le modèle et sa version publiée (v{source.value.versionNumber ?? "?"}) restent
          inchangés. Elle reprend la disposition du modèle telle quelle — sans redimensionnement, sans autorisation
          d&apos;adaptation, sans le statut de validation du catalogue — posée sur le terrain <strong>du chantier</strong>.
        </p>
        <p className="text-caption text-muted">
          Elle n&apos;est ni déposée, ni retenue, ni validée : elle s&apos;ouvre dans l&apos;éditeur pour être adaptée, puis suit le
          circuit habituel du chantier (dépôt, validation technique, publication). La demande créée conserve, comme
          origine, cette version précise du modèle.
        </p>
      </Card>
      <CopyToProjectForm
        organizationId={organizationId}
        catalogItemId={itemId}
        versionId={source.value.versionId}
        versionNumber={source.value.versionNumber}
        modelLabel={source.value.label}
        reference={reference}
        destinations={destinations}
      />
    </div>
  );
}
