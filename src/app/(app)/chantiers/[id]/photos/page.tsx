import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { AlertBanner, Card, StatusChip, EmptyState } from "@/components/ui";
import { MediaUploadForm } from "./MediaUploadForm";
import { PublishButton } from "./PublishButton";
import { ORIGIN_NOTICE, formatFileSize, mediaKindLabel, originLabel } from "@/lib/media/mediaDisplay";

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

// B027 (FR062, AC062, BR041) : origine d'ajout toujours affichée, avec le
// libellé exact d'UX_COPY ; jamais « Vérifiée ».
function OriginChip({ origin }: { origin: string }) {
  const o = originLabel(origin);
  return <StatusChip label={o.label} variant={o.known ? "info" : "attention"} data-testid="origine-media" />;
}

// Heure serveur affichée à l'heure de Bamako (UTC).
function stamp(ts: string) {
  return new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";
}

// Métadonnées (BR040) : auteur, dates serveur, type réel, taille.
function MediaMeta({ item, author }: { item: MediaAssetView; author: string }) {
  return (
    <dl className="grid grid-cols-1 gap-1 text-caption text-muted sm:grid-cols-2">
      <div>
        <dt className="inline font-semibold">Ajoutée par : </dt>
        <dd className="inline">{author}</dd>
      </div>
      <div>
        <dt className="inline font-semibold">Ajoutée le : </dt>
        <dd className="inline">{stamp(item.created_at_server)}</dd>
      </div>
      {item.published_at_server ? (
        <div>
          <dt className="inline font-semibold">Publiée le : </dt>
          <dd className="inline">{stamp(item.published_at_server)}</dd>
        </div>
      ) : null}
      <div>
        <dt className="inline font-semibold">Fichier : </dt>
        <dd className="inline">
          {mediaKindLabel(item.mime_type)}, {formatFileSize(item.file_size_bytes)}
        </dd>
      </div>
    </dl>
  );
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

  // B027 : auteur désigné par son rôle actif (les profils n'ont pas de nom) ;
  // adhésions lues avec la session de l'utilisateur (RLS, comme Équipe).
  const { data: memberRows } = await supabase
    .from("project_memberships")
    .select("profile_id, role, owner_profile")
    .eq("project_id", id)
    .is("revoked_at", null);
  const authorLabel = (profileId: string) => {
    const m = (memberRows ?? []).find((r) => r.profile_id === profileId);
    const base = !m ? "Ancien membre" : m.role === "CONTRACTOR" ? "Entreprise" : m.role === "SITE_MANAGER" ? "Chef de chantier" : m.owner_profile === "CO_OWNER" ? "Copropriétaire" : "Propriétaire";
    return profileId === user.id ? `${base} (vous)` : base;
  };

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
            <Card key={item.id} className="flex flex-col gap-2" data-testid={`brouillon-media-${item.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusChip label="Brouillon" variant="neutral" />
                <OriginChip origin={item.origin} />
              </div>
              {readUrls.get(item.id) && (
                <MediaPreview url={readUrls.get(item.id)!} mimeType={item.mime_type} caption={item.caption} />
              )}
              {item.caption && <p className="break-words text-body text-ink">{item.caption}</p>}
              <MediaMeta item={item} author={authorLabel(item.uploaded_by_profile_id)} />
              <PublishButton projectId={id} mediaId={item.id} />
            </Card>
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Galerie de l&apos;équipe</h2>
        <p className="text-caption text-muted" data-testid="mention-origine">{ORIGIN_NOTICE}</p>
        {gallery.length === 0 ? (
          <EmptyState title="Aucune photo publiée" description="Les photos publiées par l'équipe apparaîtront ici." />
        ) : (
          gallery.map((item) => (
            <Card key={item.id} className="flex flex-col gap-2" data-testid={`media-${item.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusChip label="Publié" variant="success" />
                <OriginChip origin={item.origin} />
              </div>
              {readUrls.get(item.id) && (
                <MediaPreview url={readUrls.get(item.id)!} mimeType={item.mime_type} caption={item.caption} />
              )}
              {item.caption && <p className="break-words text-body text-ink">{item.caption}</p>}
              <MediaMeta item={item} author={authorLabel(item.uploaded_by_profile_id)} />
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
