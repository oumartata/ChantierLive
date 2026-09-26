import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { AlertBanner, Card, StatusChip, EmptyState } from "@/components/ui";
import { MediaUploadForm } from "./MediaUploadForm";
import { PublishButton } from "./PublishButton";

const BUCKET = "project-media";
const READ_URL_TTL_SECONDS = 60 * 10;

// Rendu adapté au type réel du média (BR040 : "type" fait partie des
// attributs). video/mp4 -> <video controls> (lecture réelle, pas une simple
// image statique) ; tout le reste -> <img>. mime_type provient de
// media_assets.mime_type, lui-même issu du sniffing réel des octets côté
// serveur (finalize_media_upload/attest_storage_verified, jamais du seul
// type déclaré par le client) — voir src/lib/media/sniffMimeType.ts.
function MediaPreview({ url, mimeType, caption }: { url: string; mimeType: string; caption: string | null }) {
  if (mimeType.startsWith("video/")) {
    return (
      <video controls preload="metadata" className="max-h-64 w-full rounded-small bg-ink" src={url}>
        Votre navigateur ne peut pas lire cette vidéo.
      </video>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={caption ?? "Photo de suivi"} className="max-h-64 rounded-small object-cover" />;
}

interface MediaAssetView {
  id: string;
  project_id: string;
  uploaded_by_profile_id: string;
  origin: string;
  status: "BROUILLON" | "PUBLIE";
  caption: string | null;
  file_size_bytes: number;
  mime_type: string;
  storage_key: string;
  created_at_server: string;
  published_at_server: string | null;
}

// B027 — déposer / finaliser / aperçu / publier / galerie (media_asset).
// list_project_media (M010) applique déjà le prédicat READ (MEDIA_VIEW/D100) ;
// cette page se contente d'afficher ce qu'elle reçoit, jamais un filtrage
// supplémentaire côté client qui remplacerait l'autorité serveur.
export default async function PhotosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("id, name").eq("id", id).maybeSingle();

  if (!project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Photos du chantier</h1>
        <AlertBanner variant="error" title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />
      </div>
    );
  }

  const { data: mediaData, error: mediaError } = await supabase.rpc("list_project_media", { p_project_id: id });
  const media: MediaAssetView[] = Array.isArray(mediaData) ? mediaData : [];
  // B067 (D137) : résumé commun aux quatre rôles actifs — le serveur ne
  // renvoie que le fait et la date, aucune donnée financière.
  const { data: workStartData, error: workStartError } = await supabase.rpc("get_work_start_summary", { p_project_id: id });
  const workStart: { authorized: boolean; authorized_at_server: string | null } | null = Array.isArray(workStartData) ? workStartData[0] : workStartData;

  // Émission des URLs de lecture : opération Storage privilégiée, APRÈS que
  // list_project_media a déjà statué sur le droit de voir chaque ligne —
  // jamais l'inverse (privileged_boundary, DATA_MODEL.yaml).
  const service = createServiceClient();
  const readUrls = new Map<string, string>();
  for (const item of media) {
    const { data: signed } = await service.storage.from(BUCKET).createSignedUrl(item.storage_key, READ_URL_TTL_SECONDS);
    if (signed?.signedUrl) readUrls.set(item.id, signed.signedUrl);
  }

  const drafts = media.filter((m) => m.status === "BROUILLON" && m.uploaded_by_profile_id === user.id);
  const gallery = media.filter((m) => m.status === "PUBLIE");

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-h1 font-bold text-ink">Photos — {project.name}</h1>
        <p className="text-body text-muted">Suivi du chantier par photos, sans justificatif obligatoire.</p>
      </div>

      {!workStartError && workStart ? (
        <Card className="flex flex-col gap-1" data-testid="work-start-summary">
          <h2 className="text-h2 font-semibold text-ink">Démarrage des travaux</h2>
          {workStart.authorized ? (
            <p className="text-body text-ink">Autorisé le {new Date(workStart.authorized_at_server as string).toLocaleString("fr-FR")}</p>
          ) : (
            <p className="text-body text-muted">Non autorisé à ce jour.</p>
          )}
        </Card>
      ) : null}

      {mediaError && (
        <AlertBanner variant="error" title="Lecture indisponible" explanation="Réessayez plus tard." />
      )}

      <MediaUploadForm projectId={id} />

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Mes brouillons</h2>
        {drafts.length === 0 ? (
          <EmptyState title="Aucun brouillon" description="Les photos déposées restent visibles ici avant publication." />
        ) : (
          drafts.map((item) => (
            <Card key={item.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <StatusChip label="Brouillon" variant="neutral" />
                <span className="text-caption text-muted">{new Date(item.created_at_server).toLocaleString("fr-FR")}</span>
              </div>
              {readUrls.get(item.id) && (
                <MediaPreview url={readUrls.get(item.id)!} mimeType={item.mime_type} caption={item.caption} />
              )}
              {item.caption && <p className="text-body text-ink">{item.caption}</p>}
              <PublishButton projectId={id} mediaId={item.id} />
            </Card>
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Galerie de l&apos;équipe</h2>
        {gallery.length === 0 ? (
          <EmptyState title="Aucune photo publiée" description="Les photos publiées par l'équipe apparaîtront ici." />
        ) : (
          gallery.map((item) => (
            <Card key={item.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <StatusChip label="Publié" variant="success" />
                <span className="text-caption text-muted">
                  {item.published_at_server ? new Date(item.published_at_server).toLocaleString("fr-FR") : ""}
                </span>
              </div>
              {readUrls.get(item.id) && (
                <MediaPreview url={readUrls.get(item.id)!} mimeType={item.mime_type} caption={item.caption} />
              )}
              {item.caption && <p className="text-body text-ink">{item.caption}</p>}
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
