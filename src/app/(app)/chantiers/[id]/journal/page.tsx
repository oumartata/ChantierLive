import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState, StatusChip } from "@/components/ui";
import { DailyLogForm, type DailyLogDraftView } from "./DailyLogForm";

// B021 — journal quotidien en brouillon (M036, D144–D150). Visible et
// modifiable par son auteur SEUL (entreprise ou chef de chantier actif) ;
// la liste vient de list_my_daily_log_drafts, qui ne renvoie jamais le
// brouillon d'un autre. Publication et correction : B022 (non construites).
export default async function JournalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("id, name").eq("id", id).maybeSingle();
  const { data: drafts, error } = await supabase.rpc("list_my_daily_log_drafts", { p_project_id: id });

  if (!project || (error && error.message === "not_authorized")) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Journal</h1>
        <AlertBanner
          variant="warning"
          title="Journal non accessible"
          explanation="Le journal quotidien est tenu par l'entreprise et le chef de chantier actifs de ce chantier."
        />
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Journal</h1>
        <AlertBanner variant="error" title="Lecture impossible" explanation="Vos brouillons n'ont pas pu être lus. Réessayez plus tard." />
      </div>
    );
  }

  const list = (drafts ?? []) as DailyLogDraftView[];
  // Date du jour à Bamako (UTC, sans heure d'été) ; seulement une valeur
  // proposée, modifiable.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Journal — {project.name}</h1>
        <p className="text-body text-muted">
          Vos brouillons ne sont visibles que par vous. Un brouillon par date ; la publication n&apos;est pas encore
          disponible.
        </p>
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Nouveau brouillon</h2>
        <DailyLogForm projectId={project.id} draft={null} today={today} />
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Mes brouillons</h2>
        {list.length === 0 ? (
          <EmptyState title="Aucun brouillon" description="Vos brouillons de journal apparaîtront ici." />
        ) : (
          list.map((d) => (
            <Card key={`${d.id}-${d.revision}`} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-label font-semibold text-ink">
                  {new Date(`${d.log_date}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                </p>
                <StatusChip variant="neutral" label="Brouillon" />
              </div>
              <DailyLogForm projectId={project.id} draft={d} today={today} />
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
