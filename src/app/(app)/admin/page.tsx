import { notFound, redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Card } from "@/components/ui";

// SCR060 « Tableau de bord plateforme » — B050 (M050 ; D195 E2). Comptages
// seulement, chacun avec sa définition telle que calculée en base ; aucun
// montant, aucun contenu de chantier (R13 : aucun chiffre inventé).

interface Stat {
  metric: string;
  label: string;
  definition: string;
  value: number | string;
}

export default async function AdminDashboardPage() {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) notFound();
  const { data, error } = await supabase.rpc("admin_platform_stats");
  const stats = (data ?? []) as Stat[];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Tableau de bord de la plateforme</h1>
        <p className="text-body text-muted">
          Comptages calculés à l&apos;instant, chacun avec sa définition. Aucun montant ni contenu de chantier n&apos;est affiché ici.
        </p>
      </div>
      {error ? (
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="admin-stats">
          {stats.map((s) => (
            <li key={s.metric}>
              <Card className="flex h-full flex-col gap-1" data-testid={`admin-stat-${s.metric}`}>
                <p className="text-label font-semibold text-muted">{s.label}</p>
                <p className="text-h1 font-bold text-ink">{Number(s.value).toLocaleString("fr-FR")}</p>
                <p className="text-caption text-muted">{s.definition}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
