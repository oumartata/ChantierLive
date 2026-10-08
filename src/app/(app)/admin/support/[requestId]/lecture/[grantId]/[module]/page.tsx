import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState } from "@/components/ui";
import { SUPPORT_REFUSALS, moduleLabel, supportStamp } from "@/lib/support/labels";

// B051 (M051 ; D197 S4, S6) — lecture seule d'un module accordé. Chaque
// affichage appelle support_read, qui revérifie l'accord (prise en charge,
// périmètre, expiration, révocation) et inscrit la lecture au journal du
// chantier ; un refus est lui aussi inscrit. Aucun formulaire d'écriture.

type Item = Record<string, unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
const day = (v: unknown) => (s(v) ? new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }) : null);

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <p className="break-words text-caption text-ink">
      <span className="font-semibold">{label} : </span>
      {value}
    </p>
  );
}

function ItemCard({ module, item, fileHref }: { module: string; item: Item; fileHref: (kind: string, id: string) => string }) {
  switch (module) {
    case "JOURNAL":
      return (
        <Card className="flex flex-col gap-1">
          <p className="text-label font-semibold text-ink">Journal du {day(item.log_date)}</p>
          <Field label="Travaux" value={s(item.works_done)} />
          <Field label="Difficultés" value={s(item.difficulties)} />
          <Field label="Équipe" value={s(item.team)} />
          <Field label="Prochaines actions" value={s(item.next_actions)} />
          <Field label="Étape" value={s(item.phase)} />
        </Card>
      );
    case "INCIDENTS":
      return (
        <Card className="flex flex-col gap-1">
          <p className="text-label font-semibold text-ink">
            {s(item.incident_type)} · {s(item.severity)} · {s(item.status)}
          </p>
          <Field label="Description" value={s(item.description)} />
          <Field label="Signalé par" value={s(item.reporter_role)} />
          <Field label="Résolution" value={s(item.resolution)} />
          <Field label="Survenu le" value={s(item.occurred_at) ? supportStamp(String(item.occurred_at)) : null} />
        </Card>
      );
    case "PHOTOS":
      return (
        <Card className="flex flex-col gap-1">
          <p className="text-label font-semibold text-ink">{s(item.caption) ?? "Photo sans légende"}</p>
          <Field label="Publiée le" value={s(item.published_at_server) ? supportStamp(String(item.published_at_server)) : null} />
          <a href={fileHref("PHOTO", String(item.id))} target="_blank" rel="noopener noreferrer" className="text-caption font-semibold text-primary underline">
            Ouvrir (lien de 60 s au plus, ouverture tracée)
          </a>
        </Card>
      );
    case "DOCUMENTS":
      return (
        <Card className="flex flex-col gap-1">
          <p className="text-label font-semibold text-ink">{s(item.title)}</p>
          <Field label="Type" value={s(item.document_type)} />
          <Field label="Visibilité" value={s(item.visibility)} />
          <Field label="Description" value={s(item.description)} />
          <Field label="Version" value={s(item.version_number)} />
          <a href={fileHref("DOCUMENT", String(item.id))} target="_blank" rel="noopener noreferrer" className="text-caption font-semibold text-primary underline">
            Ouvrir (lien de 60 s au plus, ouverture tracée)
          </a>
        </Card>
      );
    case "AVANCEMENT":
      return (
        <Card className="flex flex-col gap-1">
          <p className="text-label font-semibold text-ink">
            {s(item.position)}. {s(item.label)}
          </p>
          <Field label="Statut" value={s(item.status)} />
          <Field label="Progression" value={s(item.progression) ? `${s(item.progression)} %` : null} />
          <Field label="Prévu" value={[day(item.planned_start), day(item.planned_end)].filter(Boolean).join(" → ") || null} />
        </Card>
      );
    case "COMMENTAIRES":
      return (
        <Card className="flex flex-col gap-1">
          <p className="text-label font-semibold text-ink">
            {s(item.author_role)} sur {s(item.target_type) === "DAILY_LOG" ? "un journal" : "un incident"}
          </p>
          <Field label="Texte" value={s(item.body)} />
        </Card>
      );
    case "EQUIPE":
      return (
        <Card className="flex flex-col gap-1">
          <p className="text-label font-semibold text-ink">
            {s(item.role)}
            {s(item.owner_profile) ? ` (${s(item.owner_profile)})` : ""}
          </p>
          <Field label="Depuis" value={day(item.since)} />
        </Card>
      );
    default:
      return null;
  }
}

export default async function SupportModulePage({ params }: { params: Promise<{ requestId: string; grantId: string; module: string }> }) {
  const { requestId, grantId, module } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  if (!UUID_RE.test(requestId) || !UUID_RE.test(grantId)) notFound();
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) notFound();
  const { data, error } = await supabase.rpc("support_read", { p_grant_id: grantId, p_module: module });
  const res = data as { ok: boolean; error?: string; module?: string; project_ref?: string; expires_at_server?: string; items?: Item[] } | null;
  const back = (
    <Link href={`/admin/support/${requestId}`} prefetch={false} className="text-caption font-semibold text-muted hover:text-primary">
      &larr; Demande
    </Link>
  );
  if (error || !res?.ok) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
        {back}
        <AlertBanner variant="error" title="Lecture refusée" explanation={`Motif : ${SUPPORT_REFUSALS[res?.error ?? ""] ?? "non autorisé"}. Ce refus est inscrit au journal.`} />
      </div>
    );
  }
  const items = res.items ?? [];
  const fileHref = (kind: string, id: string) => `/admin/support/fichier/${grantId}/${kind}/${id}`;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
      {back}
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">{moduleLabel(res.module ?? module)}</h1>
        <p className="text-caption text-muted">
          Chantier <span className="font-mono">{res.project_ref}</span> · lecture seule jusqu&apos;à {supportStamp(res.expires_at_server!)} · cette lecture est
          inscrite au journal du chantier.
        </p>
      </div>
      {items.length === 0 ? (
        <EmptyState title="Rien à afficher" description="Ce module ne contient aucun élément lisible." />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="support-lecture">
          {items.map((item, i) => (
            <li key={String(item.id ?? i)}>
              <ItemCard module={res.module ?? module} item={item} fileHref={fileHref} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
