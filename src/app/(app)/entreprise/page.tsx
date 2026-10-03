import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { Card, StatusChip, EmptyState, Button } from "@/components/ui";

const STATUS_LABEL: Record<string, { label: string; variant: "neutral" | "info" | "success" | "attention" }> = {
  DRAFT: { label: "Brouillon", variant: "neutral" },
  ACTIVE: { label: "Actif", variant: "success" },
  SUSPENDED: { label: "Suspendu", variant: "attention" },
  COMPLETED: { label: "Terminé", variant: "info" },
  ARCHIVED: { label: "Archivé", variant: "neutral" },
  READ_ONLY: { label: "Lecture seule", variant: "neutral" },
};

// Tableau de bord entreprise — liste les chantiers où le profil courant a
// une adhésion CONTRACTOR active (project_memberships, RLS déjà existante,
// M004 — jamais « tous les chantiers de mon organisation » : un membre
// d'organisation n'a pas nécessairement d'adhésion active sur chaque
// chantier, règle fondateur explicite). Aucun compteur (versements à
// confirmer, mises à jour à partager...) n'est affiché : ces agrégats ne
// sont pas encore disponibles de façon fiable sans RPC dédiée — mieux vaut
// les omettre que les inventer. « Chantiers » (menu) pointe vers ce même
// écran pour l'instant : un seul écran réel, honnête, plutôt que deux
// doublons.
export default async function EntrepriseTableauDeBordPage() {
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from("project_memberships")
    .select("projects(id, name, status)")
    .eq("profile_id", user.id)
    .eq("role", "CONTRACTOR")
    .is("revoked_at", null);

  const projects = (memberships ?? [])
    .map((m) => (Array.isArray(m.projects) ? m.projects[0] : m.projects))
    .filter((p): p is { id: string; name: string; status: string } => Boolean(p));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Mes chantiers</h1>

      {projects.length === 0 ? (
        <EmptyState
          title="Aucun chantier autorisé pour l'instant"
          description="Les chantiers où vous êtes l'entreprise active apparaîtront ici."
        />
      ) : (
        <div className="flex flex-col gap-3" data-testid="entreprise-chantiers">
          {projects.map((project) => {
            const status = STATUS_LABEL[project.status] ?? { label: project.status, variant: "neutral" as const };
            return (
              <Card key={project.id} className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                  <p className="text-label font-semibold text-ink">{project.name}</p>
                  <StatusChip variant={status.variant} label={status.label} />
                </div>
                <Link href={`/chantiers/${project.id}`}>
                  <Button variant="secondary" size="compact">
                    Ouvrir le chantier
                  </Button>
                </Link>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
