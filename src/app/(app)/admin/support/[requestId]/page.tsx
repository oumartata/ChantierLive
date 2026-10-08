import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Card, StatusChip } from "@/components/ui";
import { SUPPORT_STATUS, categoryLabel, moduleLabel, partyLabel, supportStamp } from "@/lib/support/labels";
import { AdminCloseForm, AdminRevokeForm } from "../AdminSupportForms";

// SCR064 « Accès exceptionnel » — B051 (M051 ; D197). Demande prise en charge
// par l'administrateur courant seulement : description (lecture tracée),
// accords accordés par la partie principale, liens de lecture par module
// (chaque lecture tracée ; jamais de préchargement).

interface Grant {
  grant_id: string;
  modules: string[];
  duration_minutes: number;
  granted_by_party: string;
  granted_at_server: string;
  expires_at_server: string;
  revoked_at_server: string | null;
  active: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminSupportRequestPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  if (!UUID_RE.test(requestId)) notFound();
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) notFound();
  const { data, error } = await supabase.rpc("admin_get_support_request", { p_request_id: requestId });
  const req = (Array.isArray(data) ? data[0] : data) as
    | { request_ref: string; project_ref: string; category: string; description: string; requester_party: string; status: string; created_at_server: string; take_reason: string; grants: Grant[] }
    | undefined;
  if (error || !req) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Demande d&apos;aide</h1>
        <AlertBanner variant="information" title="Demande non disponible" explanation="Seul l'administrateur qui a pris en charge cette demande peut l'ouvrir." />
      </div>
    );
  }
  const active = req.grants.find((g) => g.active);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <Link href="/admin/support" className="text-caption font-semibold text-muted hover:text-primary">
        &larr; Support
      </Link>
      <Card className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-h2 font-bold text-ink">
            Demande <span className="font-mono">{req.request_ref}</span> · {categoryLabel(req.category)}
          </h1>
          <StatusChip variant={req.status === "CLOSED" ? "neutral" : "info"} label={SUPPORT_STATUS[req.status] ?? req.status} />
        </div>
        <p className="text-caption text-muted">
          Chantier <span className="font-mono">{req.project_ref}</span> · {partyLabel(req.requester_party)} · {supportStamp(req.created_at_server)}
        </p>
        <p className="break-words text-body text-ink" data-testid="admin-support-description">
          {req.description}
        </p>
        <p className="break-words text-caption text-muted">Votre motif : {req.take_reason}</p>
      </Card>

      {active ? (
        <Card className="flex flex-col gap-3" data-testid="admin-support-acces">
          <AlertBanner
            variant="warning"
            title={`Accès en lecture seule jusqu'à ${supportStamp(active.expires_at_server)}`}
            explanation={`Accordé par ${partyLabel(active.granted_by_party)} pour ${active.duration_minutes} minutes. Chaque lecture est inscrite au journal du chantier.`}
          />
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {active.modules.map((m) => (
              <li key={m}>
                <Link
                  href={`/admin/support/${requestId}/lecture/${active.grant_id}/${m}`}
                  prefetch={false}
                  className="flex min-h-touch items-center rounded-small border border-muted/30 px-3 text-label font-semibold text-primary"
                >
                  Lire : {moduleLabel(m)}
                </Link>
              </li>
            ))}
          </ul>
          <AdminRevokeForm requestId={requestId} grantId={active.grant_id} />
        </Card>
      ) : (
        <AlertBanner
          variant="information"
          title="Aucun accès ouvert"
          explanation="Seule la partie principale du chantier peut ouvrir un accès, depuis sa page « Aide et support »."
        />
      )}

      {req.grants.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-h2 font-semibold text-ink">Accords</h2>
          <ul className="flex flex-col gap-2 text-caption text-muted">
            {req.grants.map((g) => (
              <li key={g.grant_id} className="break-words">
                {partyLabel(g.granted_by_party)}, {supportStamp(g.granted_at_server)}, {g.duration_minutes} min : {g.modules.map(moduleLabel).join(", ")} —{" "}
                {g.active ? "en cours" : g.revoked_at_server ? "arrêté" : "expiré"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {req.status !== "CLOSED" ? <AdminCloseForm requestId={requestId} /> : null}
    </div>
  );
}
