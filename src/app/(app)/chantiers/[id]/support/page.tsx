import { redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState, StatusChip } from "@/components/ui";
import { SUPPORT_ACTIONS, SUPPORT_REFUSALS, SUPPORT_STATUS, categoryLabel, moduleLabel, partyLabel, supportStamp } from "@/lib/support/labels";
import { CloseRequestForm, GrantAccessForm, NewSupportRequestForm, RevokeAccessForm } from "./SupportForms";

// B051 (M051 ; D197) — aide et accès support, pour les deux parties
// principales (entreprise, propriétaire principal). L'accès n'existe qu'avec
// leur accord, en lecture seule, pour 15, 30 ou 60 minutes ; l'une ou l'autre
// peut l'arrêter. Le journal d'accès est le même pour les deux (S8).

interface RequestRow {
  request_id: string;
  category: string;
  description: string | null;
  requester_party: string;
  status: string;
  created_at_server: string;
  taken: boolean;
  closed_at_server: string | null;
  active_grant_id: string | null;
  active_modules: string[] | null;
  active_expires_at: string | null;
  active_granted_by_party: string | null;
}

interface JournalRow {
  request_id: string;
  grant_id: string | null;
  actor: string;
  action: string;
  module: string | null;
  object_count: number | null;
  detail: string | null;
  created_at_server: string;
}

function journalDetail(e: JournalRow): string {
  if (e.action === "ACCESS_READ" || e.action === "FILE_OPENED") return `${e.module ? moduleLabel(e.module) : ""}${e.object_count !== null ? ` — ${e.object_count} élément(s)` : ""}`;
  if (e.action === "ACCESS_DENIED") return `${e.module ? moduleLabel(e.module) + " — " : ""}${SUPPORT_REFUSALS[e.detail ?? ""] ?? e.detail ?? ""}`;
  if (e.action === "ACCESS_GRANTED" && e.detail) {
    const [mods, minutes] = e.detail.split(" ; ");
    return `${mods.split(",").map(moduleLabel).join(", ")} ; ${minutes}`;
  }
  if (e.action === "REQUEST_TAKEN" && e.detail) return `Motif : ${e.detail}`;
  return e.detail ?? "";
}

export default async function SupportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const [requests, journal] = await Promise.all([
    supabase.rpc("support_list_project_requests", { p_project_id: id }),
    supabase.rpc("support_list_access_journal", { p_project_id: id }),
  ]);

  if (requests.error || journal.error) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Aide et support</h1>
        <AlertBanner
          variant="information"
          title="Réservé aux parties principales"
          explanation="Seuls l'entreprise et le propriétaire principal peuvent demander de l'aide et autoriser un accès support à ce chantier."
        />
      </div>
    );
  }
  const rows = (requests.data ?? []) as RequestRow[];
  const events = (journal.data ?? []) as JournalRow[];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Aide et support</h1>
        <p className="text-body text-muted">
          Un accès au contenu privé n&apos;est possible qu&apos;avec un motif, un périmètre et une durée limités. Le support ne lit que ce que vous
          autorisez, en lecture seule, et chaque lecture apparaît ci-dessous, pour l&apos;entreprise comme pour le propriétaire principal.
        </p>
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Demander de l&apos;aide</h2>
        <NewSupportRequestForm projectId={id} />
      </Card>

      <section className="flex flex-col gap-3" data-testid="support-demandes">
        <h2 className="text-h2 font-semibold text-ink">Demandes ({rows.length})</h2>
        {rows.length === 0 ? (
          <EmptyState title="Aucune demande" description="Vos demandes d'aide apparaîtront ici." />
        ) : (
          rows.map((r) => (
            <Card key={r.request_id} className="flex flex-col gap-2" data-testid={`support-demande-${r.request_id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-label font-semibold text-ink">{categoryLabel(r.category)}</p>
                <StatusChip variant={r.status === "CLOSED" ? "neutral" : r.status === "TAKEN" ? "info" : "attention"} label={SUPPORT_STATUS[r.status] ?? r.status} />
              </div>
              <p className="text-caption text-muted">
                Ouverte par {partyLabel(r.requester_party)} le {supportStamp(r.created_at_server)}
                {r.taken ? " · prise en charge par le support" : ""}
              </p>
              {r.description ? <p className="break-words text-body text-ink">{r.description}</p> : null}
              {r.active_grant_id ? (
                <div className="flex flex-col gap-2 rounded-small border border-attention/40 bg-attention/10 p-3" data-testid="support-acces-ouvert">
                  <p className="text-caption font-semibold text-ink">
                    Accès ouvert par {partyLabel(r.active_granted_by_party)} jusqu&apos;à {supportStamp(r.active_expires_at!)} :{" "}
                    {(r.active_modules ?? []).map(moduleLabel).join(", ")}.
                  </p>
                  <RevokeAccessForm projectId={id} grantId={r.active_grant_id} />
                </div>
              ) : r.status !== "CLOSED" ? (
                <details className="rounded-small border border-muted/30 px-3 py-2">
                  <summary className="cursor-pointer text-label font-semibold text-primary">Autoriser un accès en lecture seule</summary>
                  <div className="mt-3">
                    <GrantAccessForm projectId={id} requestId={r.request_id} />
                  </div>
                </details>
              ) : null}
              {r.status !== "CLOSED" ? <CloseRequestForm projectId={id} requestId={r.request_id} /> : null}
            </Card>
          ))
        )}
      </section>

      <section className="flex flex-col gap-3" data-testid="support-journal">
        <h2 className="text-h2 font-semibold text-ink">Journal des accès support</h2>
        {events.length === 0 ? (
          <EmptyState title="Aucun accès" description="Chaque accord, lecture et arrêt sera inscrit ici." />
        ) : (
          <ul className="flex flex-col gap-2">
            {events.map((e, i) => (
              <li key={`${e.created_at_server}-${i}`} className="rounded-small border border-muted/20 bg-surface px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-label font-semibold text-ink">
                    {SUPPORT_ACTIONS[e.action] ?? e.action} <span className="font-normal text-muted">· {e.actor}</span>
                  </p>
                  <p className="text-caption text-muted">{supportStamp(e.created_at_server)}</p>
                </div>
                {journalDetail(e) ? <p className="break-words text-caption text-muted">{journalDetail(e)}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
