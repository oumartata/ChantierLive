import { notFound, redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState } from "@/components/ui";

// B050 (M050 ; D195 E6, D186) — journal de plateforme en lecture : action,
// acteur (« vous », « autre administrateur », « opération serveur »),
// identifiant court du chantier, motif, date. Jamais l'audit des chantiers.

interface Row {
  action: string;
  actor: string;
  project_ref: string | null;
  reason: string | null;
  created_at_server: string;
}

const ACTION: Record<string, string> = {
  PLATFORM_ADMIN_DESIGNATED: "Administrateur désigné",
  LICENSE_ACTIVATED: "Licence activée",
  LICENSE_PAYMENT_REJECTED: "Déclaration de licence rejetée",
  LICENSE_PROOF_VIEWED: "Preuve de licence consultée",
  ADMIN_ACCOUNT_LOOKUP: "Recherche de compte",
  LICENSE_OFFER_CHANGED: "Prix de la licence modifié",
};
const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

export default async function AdminAuditPage() {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) notFound();
  const { data, error } = await supabase.rpc("admin_list_platform_audit", { p_limit: 100 });
  const rows = (data ?? []) as Row[];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Journal de la plateforme</h1>
        <p className="text-body text-muted">Les 100 dernières actions d&apos;administration. Le journal des chantiers n&apos;est jamais affiché ici.</p>
      </div>
      {error ? (
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      ) : rows.length === 0 ? (
        <EmptyState title="Journal vide" description="Les actions d'administration apparaîtront ici." />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="admin-journal">
          {rows.map((r, i) => (
            <li key={`${r.created_at_server}-${i}`}>
              <Card className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-label font-semibold text-ink">{ACTION[r.action] ?? r.action}</p>
                  <p className="text-caption text-muted">{stamp(r.created_at_server)}</p>
                </div>
                <p className="break-words text-caption text-muted">
                  Par {r.actor}
                  {r.project_ref ? <> · chantier <span className="font-mono">{r.project_ref}</span></> : null}
                  {r.reason ? ` · ${r.reason}` : ""}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
