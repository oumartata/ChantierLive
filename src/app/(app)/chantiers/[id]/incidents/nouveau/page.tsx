import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card } from "@/components/ui";
import { NewIncidentForm } from "../IncidentForms";
import { formatStamp, typeLabel } from "../labels";

// SCR041 — déclarer un incident (FR101, D159–D161, D165, D166). Tout membre
// actif ; la liste des incidents clos (pour un nouvel incident lié) vient de
// list_project_incidents, qui revérifie l'adhésion.
export default async function NewIncidentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ lie?: string }> }) {
  const { id } = await params;
  const { lie } = await searchParams;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const supabase = await createClient();
  const [{ data: project }, incidents] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", id).maybeSingle(),
    supabase.rpc("list_project_incidents", { p_project_id: id, p_limit: 100 }),
  ]);
  if (!project || incidents.error) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Signaler un incident</h1>
        <AlertBanner variant="warning" title="Incidents non accessibles" explanation="Les incidents sont réservés aux membres actifs de ce chantier." />
      </div>
    );
  }
  const closed = ((incidents.data ?? []) as { id: string; status: string; incident_type: string; occurred_at: string }[])
    .filter((i) => i.status === "CLOS")
    .map((i) => ({ value: i.id, label: `${typeLabel(i.incident_type)} du ${formatStamp(i.occurred_at)}` }));
  const linkedId = lie && closed.some((c) => c.value === lie) ? lie : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <Link href={`/chantiers/${id}/incidents`} className="text-caption font-semibold text-muted hover:text-primary">
          &larr; Incidents
        </Link>
        <h1 className="text-h1 font-bold text-ink">Signaler un incident</h1>
        <p className="text-body text-muted">L&apos;incident est visible par tous les membres du chantier, propriétaire compris, dès son enregistrement.</p>
      </div>
      <Card className="flex flex-col gap-3">
        <NewIncidentForm projectId={id} now={new Date().toISOString().slice(0, 16)} closedIncidents={closed} linkedId={linkedId} />
      </Card>
    </div>
  );
}
