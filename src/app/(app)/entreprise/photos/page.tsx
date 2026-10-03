import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { Card, EmptyState, Button } from "@/components/ui";

// Sélecteur de chantier — maquette « Photos, vidéos et avancement »
// (2026-10-26). Réutilise intégralement chantiers/[id]/photos (déjà
// construit, M010) : la partie « avancement » de cette maquette reste
// indisponible (PREPARATION_ESPACES_PROPRIETAIRE_ENTREPRISE.md §3.1).
export default async function EntreprisePhotosPage() {
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from("project_memberships")
    .select("projects(id, name)")
    .eq("profile_id", user.id)
    .eq("role", "CONTRACTOR")
    .is("revoked_at", null);

  const projects = (memberships ?? [])
    .map((m) => (Array.isArray(m.projects) ? m.projects[0] : m.projects))
    .filter((p): p is { id: string; name: string } => Boolean(p));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Photos et vidéos</h1>
      {projects.length === 0 ? (
        <EmptyState title="Aucun chantier autorisé" description="Sélectionnez un chantier pour gérer ses photos et vidéos." />
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((project) => (
            <Card key={project.id} className="flex items-center justify-between gap-3 p-5">
              <p className="text-label font-semibold text-ink">{project.name}</p>
              <Link href={`/chantiers/${project.id}/photos`}>
                <Button variant="secondary" size="compact">
                  Voir les photos et vidéos
                </Button>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
