import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner } from "@/components/ui";

function Unavailable({ title, explanation }: { title: string; explanation: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Avancement</h1>
      <AlertBanner variant="warning" title={title} explanation={explanation} />
    </div>
  );
}

// Fonctionnalité « étapes de chantier / avancement » non construite —
// confirmé : aucune table phases/project_phases, aucune RPC correspondante
// (voir PREPARATION_ESPACES_PROPRIETAIRE_ENTREPRISE.md §3.1, D141). Cette
// page existe pour donner au menu propriétaire une destination réelle
// (maquette fondateur 2026-10-03) sans jamais afficher de pourcentage, de
// jalon ou de date inventés — la règle de calcul doit être préparée et
// validée séparément avant toute implémentation.
export default async function AvancementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", id).maybeSingle(),
    supabase
      .from("project_memberships")
      .select("role")
      .eq("project_id", id)
      .eq("profile_id", user.id)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);

  if (!project || !membership) {
    return <Unavailable title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />;
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Avancement — {project.name}</h1>
      <AlertBanner
        variant="information"
        title="Fonctionnalité pas encore disponible"
        explanation="Le suivi des étapes du chantier (fondations, élévation, toiture, finitions...) et le calcul d'un pourcentage d'avancement ne sont pas encore construits. Cette fonction sera proposée séparément, avec sa règle de calcul, avant toute mise en service."
      />
    </div>
  );
}
