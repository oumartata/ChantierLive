import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Button, Card, StatusChip } from "@/components/ui";
import { financeSummary, paymentsSummary, progressSummary } from "@/lib/entreprise/chantierSummary";
import { ChantierSelector } from "./ChantierSelector";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Espace entreprise — chantier sélectionné (ESPACES-3/5, sans migration).
// Accès : adhésion CONTRACTOR ACTIVE du profil sur CE chantier, vérifiée
// ici côté serveur avant toute lecture ; jamais déduit de l'appartenance à
// une organisation. Chaque fonction lue (M033, M014, M028) revérifie
// elle-même ses lecteurs. Les actions restent sur les pages existantes du
// chantier (liens) : aucun second circuit de versement, aucune validation
// nouvelle. Aucune dépense interne n'est lue ni affichée ici.
export default async function EntrepriseChantierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const supabase = await createClient();
  const { data: memberships, error: membershipsError } = await supabase
    .from("project_memberships")
    .select("project_id, projects(id, name)")
    .eq("profile_id", user.id)
    .eq("role", "CONTRACTOR")
    .is("revoked_at", null);
  const projects = (memberships ?? [])
    .map((m) => (Array.isArray(m.projects) ? m.projects[0] : m.projects))
    .filter((p): p is { id: string; name: string } => Boolean(p))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const project = UUID_RE.test(id) ? projects.find((p) => p.id === id) : undefined;

  if (membershipsError || !project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-6" data-testid="chantier-non-autorise">
        <h1 className="text-h1 font-bold text-ink">Chantier</h1>
        <AlertBanner
          variant="warning"
          title={membershipsError ? "Lecture impossible" : "Chantier non accessible"}
          explanation={
            membershipsError
              ? "Vos chantiers n'ont pas pu être lus. Réessayez plus tard."
              : "Ce chantier n'existe pas ou vous n'y êtes pas l'entreprise active."
          }
        />
        <Link href="/entreprise" className="text-label font-semibold text-primary">
          ← Mes chantiers
        </Link>
      </div>
    );
  }

  const [planRes, paymentsRes, financeRes] = await Promise.all([
    supabase.rpc("get_project_phase_plan", { p_project_id: id }),
    supabase.rpc("list_advance_payments", { p_project_id: id }),
    supabase.rpc("get_project_financial_summary", { p_project_id: id }),
  ]);
  const progress = progressSummary(planRes);
  const payments = paymentsSummary(paymentsRes);
  const finance = financeSummary(financeRes);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-h1 font-bold text-ink">{project.name}</h1>
        {projects.length > 1 ? <ChantierSelector currentId={project.id} projects={projects} /> : null}
      </div>

      <Card className="flex flex-col gap-3" data-testid="avancement">
        <h2 className="text-h2 font-semibold text-ink">Avancement déclaré</h2>
        {progress.kind === "error" ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="L'avancement n'a pas pu être lu. Réessayez plus tard." />
        ) : progress.kind === "absent" ? (
          <p className="text-body text-muted">Aucun avancement publié : le plan des étapes n&apos;est pas encore publié.</p>
        ) : (
          <>
            <p className="text-display font-bold text-ink">{progress.percent}</p>
            {progress.lastEventAt ? (
              <p className="text-caption text-muted">
                Dernière mise à jour le {new Date(progress.lastEventAt).toLocaleString("fr-FR")}
                {progress.lastEventBy ? ` par ${progress.lastEventBy}` : ""}.
              </p>
            ) : null}
            <StatusChip variant="info" label="Déclaré par l'entreprise — aucune validation automatique" className="self-start" />
          </>
        )}
        <Link href={`/chantiers/${project.id}/avancement`} className="w-fit">
          <Button variant="secondary" size="compact">
            Ouvrir l&apos;avancement
          </Button>
        </Link>
      </Card>

      <Card className="flex flex-col gap-3" data-testid="versements">
        <h2 className="text-h2 font-semibold text-ink">Versements du client</h2>
        {finance.kind === "error" ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="Le récapitulatif financier n'a pas pu être lu." />
        ) : (
          <dl className="grid grid-cols-1 gap-2 text-body sm:grid-cols-2" data-testid="recapitulatif">
            <div>
              <dt className="text-caption text-muted">Prix convenu</dt>
              <dd className="font-semibold text-ink">{finance.contract ?? "Non établi (aucun devis accepté)"}</dd>
            </div>
            <div>
              <dt className="text-caption text-muted">Reste dû</dt>
              <dd className="font-semibold text-ink">{finance.remainingDue ?? "Non calculable sans prix convenu"}</dd>
            </div>
            <div>
              <dt className="text-caption text-muted">Reconnu par les deux parties</dt>
              <dd className="font-semibold text-ink">
                {finance.recognized} ({finance.recognizedCount} versement{finance.recognizedCount > 1 ? "s" : ""})
              </dd>
            </div>
            <div>
              <dt className="text-caption text-muted">En attente de confirmation</dt>
              <dd className="font-semibold text-ink">
                {finance.pending} ({finance.pendingCount} versement{finance.pendingCount > 1 ? "s" : ""})
              </dd>
            </div>
          </dl>
        )}
        {payments.kind === "error" ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="La liste des versements n'a pas pu être lue." />
        ) : payments.kind === "empty" ? (
          <p className="text-body text-muted">Aucun versement déclaré pour ce chantier.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="liste-versements">
            {payments.items.map((p) => (
              <li key={p.id} className="flex flex-col gap-1 rounded-small border border-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col">
                  <span className="text-label font-semibold text-ink">{p.amount}</span>
                  <span className="text-caption text-muted">
                    {new Date(p.date).toLocaleDateString("fr-FR")} · {p.mode} · déclaré par {p.declaredBy}
                    {p.hasReceipt ? " · justificatif joint" : ""}
                  </span>
                </div>
                <StatusChip variant={p.status.variant} label={p.status.label} />
              </li>
            ))}
          </ul>
        )}
        <Link href={`/chantiers/${project.id}/acomptes`} className="w-fit">
          <Button variant="secondary" size="compact">
            Gérer les versements
          </Button>
        </Link>
      </Card>

      <Card className="flex flex-col gap-3" data-testid="medias-plans">
        <h2 className="text-h2 font-semibold text-ink">Photos, vidéos et plans</h2>
        <div className="flex flex-wrap gap-2">
          <Link href={`/chantiers/${project.id}/photos`}>
            <Button variant="secondary" size="compact">
              Photos et vidéos
            </Button>
          </Link>
          <Link href={`/chantiers/${project.id}/plans`}>
            <Button variant="secondary" size="compact">
              Plans
            </Button>
          </Link>
          <Link href={`/chantiers/${project.id}`}>
            <Button variant="ghost" size="compact">
              Fiche du chantier
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
