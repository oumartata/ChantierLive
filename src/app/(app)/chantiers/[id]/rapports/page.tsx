import { redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState } from "@/components/ui";
import { buttonClassName } from "@/components/ui/Button";
import { defaultPeriod } from "@/lib/report/report";

// SCR046 « Rapports » — B046 (M053 ; D200, D034). Un seul rapport de suivi
// pour les 4 rôles, chacun limité à ce qu'il voit ; régénéré à chaque demande
// et jamais conservé. Les traces listées ici sont celles de la personne
// connectée seulement.

const ERRORS: Record<string, string> = {
  period_invalid: "Choisissez une date de début antérieure ou égale à la date de fin.",
  period_too_long: "La période ne peut pas dépasser 12 mois.",
  period_in_future: "La date de fin ne peut pas être dans le futur.",
  generation_failed: "Le rapport n'a pas pu être généré. Réessayez.",
};
const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body text-ink h-12";

interface Trace {
  report_id: string;
  period_from: string;
  period_to: string;
  content_sha256: string;
  file_size_bytes: number;
  generated_at_server: string;
}

const dLong = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

export default async function ReportsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erreur?: string }> }) {
  const { id } = await params;
  const { erreur } = await searchParams;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_my_report_generations", { p_project_id: id });
  if (error) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Rapports</h1>
        <AlertBanner variant="information" title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />
      </div>
    );
  }
  const traces = (data ?? []) as Trace[];
  const { from, to } = defaultPeriod(new Date());

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Rapports</h1>
        <p className="text-body text-muted">
          Rapport de suivi en PDF, établi avec les seules informations que vous voyez dans ChantierLive : avancement déclaré et validé, journaux publiés,
          incidents, documents partagés, photos{" "}
          et, selon votre rôle, prix convenu, versements et reste dû. Il est régénéré à chaque demande et n&apos;est jamais conservé par ChantierLive.
        </p>
      </div>
      {erreur ? <AlertBanner variant="error" title="Rapport non généré" explanation={ERRORS[erreur] ?? ERRORS.generation_failed} /> : null}

      <Card className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Générer le rapport</h2>
        <form action={`/chantiers/${id}/rapports/pdf`} method="get" className="flex flex-col gap-3" data-testid="form-rapport">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-label font-semibold text-ink">
              Du
              <input type="date" name="du" required defaultValue={from} max={to} className={FIELD} />
            </label>
            <label className="flex flex-col gap-1 text-label font-semibold text-ink">
              Au
              <input type="date" name="au" required defaultValue={to} max={to} className={FIELD} />
            </label>
          </div>
          <p className="text-caption text-muted">Par défaut, les 30 derniers jours ; 12 mois au plus.</p>
          <div>
            <button type="submit" className={buttonClassName("primary", "regular")}>
              Générer le rapport
            </button>
          </div>
        </form>
        <p className="text-caption text-muted">
          Outil de suivi : ni expertise, ni certification, ni garantie de conformité. Aucune preuve n&apos;est garantie authentique par ChantierLive.
        </p>
      </Card>

      <section className="flex flex-col gap-3" data-testid="mes-rapports">
        <h2 className="text-h2 font-semibold text-ink">Mes rapports générés</h2>
        <p className="text-caption text-muted">Visible de vous seul. Seule une trace est gardée : le fichier lui-même n&apos;est pas conservé.</p>
        {traces.length === 0 ? (
          <EmptyState title="Aucun rapport" description="Vos générations de rapport apparaîtront ici." />
        ) : (
          <ul className="flex flex-col gap-2">
            {traces.map((t) => (
              <li key={t.report_id} className="rounded-small border border-muted/20 bg-surface px-3 py-2">
                <p className="text-label font-semibold text-ink">
                  Du {dLong(t.period_from)} au {dLong(t.period_to)}
                </p>
                <p className="break-all text-caption text-muted">
                  Généré le {stamp(t.generated_at_server)} · {(t.file_size_bytes / 1024).toFixed(1)} Ko · identifiant {t.report_id} · empreinte{" "}
                  {t.content_sha256.slice(0, 16)}…
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
