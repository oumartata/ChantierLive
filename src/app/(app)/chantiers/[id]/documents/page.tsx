import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { AlertBanner, Card, EmptyState, StatusChip } from "@/components/ui";
import { formatFileSize } from "@/lib/media/mediaDisplay";
import { ArchiveDocumentForm, NewDocumentForm, NewVersionForm, PublishDocumentButton } from "./DocumentForms";
import { COPY_NOTICE, VISIBILITY, fileKindLabel, formatStamp, partyLabel, typeLabel } from "./labels";

// SCR044 — B028 (M039, D169–D176). La liste vient de list_project_documents,
// qui applique au serveur la visibilité et le brouillon visible par son
// auteur seul ; chaque lien de fichier est signé par le serveur APRÈS
// get_document_version_file_key (droit revérifié à chaque émission, FR110).
const URL_TTL_SECONDS = 300;

interface DocumentRow {
  id: string;
  document_type: string;
  title: string;
  description: string | null;
  visibility: string;
  status: "BROUILLON" | "PUBLIE" | "ARCHIVE";
  deposited_as_role: string;
  author_is_me: boolean;
  current_version_number: number | null;
  current_mime_type: string | null;
  current_file_size_bytes: number | null;
  created_at_server: string;
  published_at_server: string | null;
  archived_at_server: string | null;
  archive_reason: string | null;
  revision: number;
  can_publish: boolean;
  can_new_version: boolean;
  can_archive: boolean;
}

interface VersionRow {
  id: string;
  version_number: number;
  mime_type: string;
  file_size_bytes: number;
  created_by_role: string;
  author_is_me: boolean;
  created_at_server: string;
  is_current: boolean;
}

function Action({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-small border border-muted/30 px-3 py-2">
      <summary className="cursor-pointer text-label font-semibold text-primary">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export default async function DocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const supabase = await createClient();
  const [{ data: project }, docs, { data: me }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", id).maybeSingle(),
    supabase.rpc("list_project_documents", { p_project_id: id }),
    supabase.from("project_memberships").select("role, owner_profile").eq("project_id", id).eq("profile_id", user.id).is("revoked_at", null).maybeSingle(),
  ]);

  if (!project || (docs.error && docs.error.message === "not_authorized")) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Documents</h1>
        <AlertBanner variant="warning" title="Documents non accessibles" explanation="Les documents sont réservés aux membres actifs de ce chantier." />
      </div>
    );
  }
  if (docs.error) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Documents</h1>
        <AlertBanner variant="error" title="Lecture impossible" explanation="Les documents n'ont pas pu être lus. Réessayez plus tard." />
      </div>
    );
  }

  // D171 : dépôt réservé à l'entreprise et au propriétaire principal ; rôle
  // RÉEL de l'adhésion active, revérifié de toute façon au serveur.
  const isContractor = me?.role === "CONTRACTOR";
  const canDeposit = isContractor || (me?.role === "OWNER" && me?.owner_profile === "PRIMARY");
  const rows = (docs.data ?? []) as DocumentRow[];

  // Versions et liens temporaires, document par document.
  const service = createServiceClient();
  const versions = new Map<string, (VersionRow & { url: string | null })[]>();
  await Promise.all(
    rows.map(async (d) => {
      const { data } = await supabase.rpc("list_document_versions", { p_document_id: d.id });
      const list = (data ?? []) as VersionRow[];
      const withUrls = await Promise.all(
        list.map(async (v) => {
          const { data: keyData } = await supabase.rpc("get_document_version_file_key", { p_version_id: v.id });
          const key = Array.isArray(keyData) ? keyData[0] : keyData;
          if (!key?.storage_key) return { ...v, url: null };
          const { data: signed } = await service.storage.from(key.bucket).createSignedUrl(key.storage_key, URL_TTL_SECONDS);
          return { ...v, url: signed?.signedUrl ?? null };
        })
      );
      versions.set(d.id, withUrls);
    })
  );

  const drafts = rows.filter((d) => d.status === "BROUILLON");
  const active = rows.filter((d) => d.status === "PUBLIE");
  const archived = rows.filter((d) => d.status === "ARCHIVE");

  const card = (d: DocumentRow) => {
    const vs = versions.get(d.id) ?? [];
    const current = vs.find((v) => v.is_current);
    return (
      <Card key={`${d.id}-${d.revision}`} className="flex flex-col gap-3" data-testid={`document-${d.id}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="break-words text-label font-semibold text-ink">{d.title}</p>
          <div className="flex flex-wrap gap-2">
            <StatusChip variant="neutral" label={typeLabel(d.document_type)} />
            <StatusChip variant={d.visibility === "ENTREPRISE" ? "attention" : "info"} label={VISIBILITY[d.visibility]?.label ?? d.visibility} />
            {d.status === "BROUILLON" ? <StatusChip variant="neutral" label="Brouillon" /> : null}
            {d.status === "ARCHIVE" ? <StatusChip variant="neutral" label="Archivé" /> : null}
          </div>
        </div>
        {d.description ? <p className="whitespace-pre-line break-words text-body text-ink">{d.description}</p> : null}
        {COPY_NOTICE[d.document_type] ? <p className="text-caption text-muted">{COPY_NOTICE[d.document_type]}</p> : null}
        <dl className="grid grid-cols-1 gap-1 text-caption text-muted sm:grid-cols-2">
          <div>
            <dt className="inline font-semibold">Déposé par : </dt>
            <dd className="inline">
              {partyLabel(d.deposited_as_role)}
              {d.author_is_me ? " (vous)" : ""}
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Visible par : </dt>
            <dd className="inline">{VISIBILITY[d.visibility]?.audience ?? d.visibility}</dd>
          </div>
          {d.published_at_server ? (
            <div>
              <dt className="inline font-semibold">Publié le : </dt>
              <dd className="inline">{formatStamp(d.published_at_server)}</dd>
            </div>
          ) : null}
          <div>
            <dt className="inline font-semibold">Version actuelle : </dt>
            <dd className="inline">
              {d.current_version_number ?? "—"}
              {d.current_mime_type ? ` — ${fileKindLabel(d.current_mime_type)}, ${formatFileSize(d.current_file_size_bytes)}` : ""}
            </dd>
          </div>
        </dl>
        {d.status === "ARCHIVE" && d.archive_reason ? (
          <p className="break-words text-caption text-muted">
            Archivé le {d.archived_at_server ? formatStamp(d.archived_at_server) : "—"} — motif : {d.archive_reason}
          </p>
        ) : null}
        {current?.url ? (
          <a href={current.url} target="_blank" rel="noopener noreferrer" className="text-label font-semibold text-primary">
            Ouvrir la version actuelle (lien valable 5 minutes)
          </a>
        ) : null}
        {d.can_publish ? (
          <div>
            <PublishDocumentButton projectId={id} documentId={d.id} revision={d.revision} visibility={d.visibility} />
          </div>
        ) : null}
        {d.can_new_version ? (
          <Action title="Déposer une nouvelle version">
            <NewVersionForm projectId={id} documentId={d.id} />
          </Action>
        ) : null}
        {vs.length > 1 ? (
          <details className="rounded-small border border-muted/30 px-3 py-2">
            <summary className="cursor-pointer text-label font-semibold text-primary">Versions ({vs.length})</summary>
            <ol className="mt-3 flex flex-col gap-2">
              {vs.map((v) => (
                <li key={v.id} className="flex flex-col gap-1 border-l-2 border-muted/30 pl-3">
                  <p className="text-caption font-semibold text-ink">
                    Version {v.version_number}
                    {v.is_current ? " (actuelle)" : ""} — {partyLabel(v.created_by_role)}
                    {v.author_is_me ? " (vous)" : ""}, le {formatStamp(v.created_at_server)}
                  </p>
                  <p className="text-caption text-muted">
                    {fileKindLabel(v.mime_type)}, {formatFileSize(v.file_size_bytes)}
                    {v.url ? (
                      <>
                        {" — "}
                        <a href={v.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary">
                          Ouvrir
                        </a>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        {d.can_archive ? (
          <Action title={d.status === "BROUILLON" ? "Archiver ce brouillon" : "Archiver le document"}>
            <ArchiveDocumentForm projectId={id} documentId={d.id} revision={d.revision} />
          </Action>
        ) : null}
      </Card>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Documents — {project.name}</h1>
        <p className="text-body text-muted">Un document remplacé garde toutes ses versions ; rien n&apos;est jamais écrasé ni supprimé.</p>
      </div>

      {canDeposit ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-h2 font-semibold text-ink">Ajouter un document</h2>
          <NewDocumentForm projectId={id} canChooseEnterprise={isContractor} />
        </Card>
      ) : null}

      {canDeposit ? (
        <section className="flex flex-col gap-3" data-testid="documents-brouillons">
          <h2 className="text-h2 font-semibold text-ink">Mes brouillons</h2>
          {drafts.length === 0 ? <EmptyState title="Aucun brouillon" description="Les documents déposés restent ici, visibles par vous seul, jusqu'à leur publication." /> : drafts.map(card)}
        </section>
      ) : null}

      <section className="flex flex-col gap-3" data-testid="documents-publies">
        <h2 className="text-h2 font-semibold text-ink">Documents du chantier</h2>
        {active.length === 0 ? <EmptyState title="Aucun document" description="Les documents publiés que vous pouvez consulter apparaîtront ici." /> : active.map(card)}
      </section>

      {archived.length > 0 ? (
        <section className="flex flex-col gap-3" data-testid="documents-archives">
          <h2 className="text-h2 font-semibold text-ink">Archivés</h2>
          {archived.map(card)}
        </section>
      ) : null}
    </div>
  );
}
