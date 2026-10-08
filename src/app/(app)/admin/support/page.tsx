import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState, StatusChip } from "@/components/ui";
import { SUPPORT_STATUS, categoryLabel, moduleLabel, partyLabel, supportStamp } from "@/lib/support/labels";
import { TakeRequestForm } from "./AdminSupportForms";

// SCR063 « Tickets de support » — B051 (M051 ; D197 S3, FR157). Liste
// minimisée : catégorie, chantier en identifiant court, partie, statut, dates ;
// jamais la description avant une prise en charge motivée.

interface Row {
  request_id: string;
  request_ref: string;
  project_ref: string;
  category: string;
  requester_party: string;
  status: string;
  created_at_server: string;
  taken_by: string | null;
  active_grant_id: string | null;
  active_modules: string[] | null;
  active_expires_at: string | null;
}

export default async function AdminSupportPage() {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) notFound();
  const { data, error } = await supabase.rpc("admin_list_support_requests", { p_include_closed: true });
  const rows = (data ?? []) as Row[];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Support</h1>
        <p className="text-body text-muted">
          Demandes d&apos;aide des chantiers. Vous ne lisez la description qu&apos;après une prise en charge motivée, et le contenu d&apos;un chantier
          seulement pendant l&apos;accès que la partie principale a accordé, en lecture seule.
        </p>
      </div>
      {error ? (
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      ) : rows.length === 0 ? (
        <EmptyState title="Aucune demande" description="Les demandes d'aide apparaîtront ici." />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="admin-support">
          {rows.map((r) => (
            <li key={r.request_id}>
              <Card className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-label font-semibold text-ink">
                    <span className="font-mono">{r.request_ref}</span> · {categoryLabel(r.category)}
                  </p>
                  <StatusChip variant={r.status === "CLOSED" ? "neutral" : r.status === "TAKEN" ? "info" : "attention"} label={SUPPORT_STATUS[r.status] ?? r.status} />
                </div>
                <p className="text-caption text-muted">
                  Chantier <span className="font-mono">{r.project_ref}</span> · demandé par {partyLabel(r.requester_party)} le {supportStamp(r.created_at_server)}
                  {r.taken_by ? ` · pris en charge par ${r.taken_by}` : ""}
                </p>
                {r.active_grant_id ? (
                  <p className="text-caption font-semibold text-ink">
                    Accès accordé jusqu&apos;à {supportStamp(r.active_expires_at!)} : {(r.active_modules ?? []).map(moduleLabel).join(", ")}
                  </p>
                ) : null}
                {r.status === "OPEN" ? (
                  <details className="rounded-small border border-muted/30 px-3 py-2">
                    <summary className="cursor-pointer text-label font-semibold text-primary">Prendre en charge</summary>
                    <div className="mt-3">
                      <TakeRequestForm requestId={r.request_id} />
                    </div>
                  </details>
                ) : r.taken_by === "vous" ? (
                  <Link href={`/admin/support/${r.request_id}`} prefetch={false} className="text-label font-semibold text-primary underline">
                    Ouvrir la demande (lecture tracée)
                  </Link>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
