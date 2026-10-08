import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState } from "@/components/ui";

// B050 (M050 ; D195 E3) — chantiers en métadonnées : identifiant court,
// statut, pays, état de la licence, date de création, nombre de membres
// actifs par rôle. Ni nom, ni adresse, ni identité des membres ; aucun lien
// vers le chantier (l'administrateur n'en est pas membre).

interface Row {
  project_ref: string;
  status: string;
  country: string;
  license_status: string;
  created_at_server: string;
  contractors: number;
  owners_primary: number;
  co_owners: number;
  site_managers: number;
  total_count: number | string;
}

const PAGE = 50;
const STATUS: Record<string, string> = { DRAFT: "brouillon", ACTIVE: "actif", SUSPENDED: "suspendu", COMPLETED: "terminé", ARCHIVED: "archivé", READ_ONLY: "lecture seule" };
const LICENSE: Record<string, string> = { NONE: "aucune", PENDING: "en attente", ACTIVE: "active", EXPIRING: "bientôt expirée", GRACE: "en grâce", READ_ONLY: "lecture seule" };
const day = (ts: string) => new Date(ts).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });

export default async function AdminProjectsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) notFound();
  const { page } = await searchParams;
  const current = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);
  const { data, error } = await supabase.rpc("admin_list_projects", { p_limit: PAGE, p_offset: (current - 1) * PAGE });
  const rows = (data ?? []) as Row[];
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Chantiers</h1>
        <p className="text-body text-muted">
          Métadonnées seulement : ni nom, ni adresse, ni membres nommés, ni contenu. {total > 0 ? `${total.toLocaleString("fr-FR")} chantiers, page ${current} sur ${pages}.` : ""}
        </p>
      </div>
      {error ? (
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      ) : rows.length === 0 ? (
        <EmptyState title="Aucun chantier" description="Aucun chantier sur cette page." />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="admin-chantiers">
          {rows.map((r) => (
            <li key={r.project_ref + r.created_at_server}>
              <Card className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-mono text-label font-bold text-ink">{r.project_ref}</p>
                  <p className="text-caption text-muted">créé le {day(r.created_at_server)}</p>
                </div>
                <p className="text-caption text-ink">
                  Statut {STATUS[r.status] ?? r.status} · pays {r.country} · licence {LICENSE[r.license_status] ?? r.license_status}
                </p>
                <p className="text-caption text-muted">
                  Membres actifs : entreprise {r.contractors}, propriétaire principal {r.owners_primary}, copropriétaires {r.co_owners}, chefs de chantier{" "}
                  {r.site_managers}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center justify-between gap-2 text-label font-semibold">
          {current > 1 ? <Link href={`/admin/chantiers?page=${current - 1}`} className="text-primary underline">Page précédente</Link> : <span />}
          {current < pages ? <Link href={`/admin/chantiers?page=${current + 1}`} className="text-primary underline">Page suivante</Link> : <span />}
        </nav>
      ) : null}
    </div>
  );
}
