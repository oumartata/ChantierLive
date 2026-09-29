import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, Button, StatusChip } from "@/components/ui";

const STATUS_LABEL: Record<string, { label: string; variant: "neutral" | "info" | "success" | "attention" }> = {
  DRAFT: { label: "Brouillon", variant: "neutral" },
  ACTIVE: { label: "Actif", variant: "success" },
  SUSPENDED: { label: "Suspendu", variant: "attention" },
  COMPLETED: { label: "Terminé", variant: "info" },
  ARCHIVED: { label: "Archivé", variant: "neutral" },
  READ_ONLY: { label: "Lecture seule", variant: "neutral" },
};

function field(label: string, value: string | null) {
  return (
    <div>
      <p className="text-caption text-muted">{label}</p>
      <p className="text-body text-ink">{value ?? "—"}</p>
    </div>
  );
}

// Fiche chantier — écran de LECTURE par défaut à l'ouverture (constat
// fondateur : "Ouvrir" menait directement au formulaire /modifier, sans que
// l'utilisateur sache ce qui était consultable ou modifiable). "Modifier"
// reste un clic explicite, réservé aux mêmes personnes déjà autorisées par
// update_draft_project aujourd'hui (CONTRACTOR ou OWNER/PRIMARY, chantier en
// DRAFT) — aucun droit serveur changé ici, seulement son reflet dans l'UI.
export default async function ChantierFichePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ enregistre?: string; invitation?: string }>;
}) {
  const { id } = await params;
  const { enregistre, invitation } = await searchParams;

  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "name, country, address, latitude, longitude, planned_start_date, planned_end_date, budget::text, status"
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("project_memberships")
      .select("role, owner_profile")
      .eq("project_id", id)
      .eq("profile_id", user.id)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);

  if (!project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Chantier</h1>
        <AlertBanner
          variant="error"
          title="Chantier inaccessible"
          explanation="Ce chantier n'existe pas ou vous n'y avez pas accès."
        />
      </div>
    );
  }

  // Même garde EXACTE que update_draft_project (M004b) : CONTRACTOR ou
  // OWNER/PRIMARY, chantier en DRAFT — reflet, pas une nouvelle règle.
  const canEdit =
    project.status === "DRAFT" &&
    (membership?.role === "CONTRACTOR" ||
      (membership?.role === "OWNER" && membership.owner_profile === "PRIMARY"));

  const status = STATUS_LABEL[project.status] ?? { label: project.status, variant: "neutral" as const };
  const budgetLabel = project.budget ? `${Number(project.budget).toLocaleString("fr-FR")} FCFA` : null;
  const locationLabel =
    project.latitude != null && project.longitude != null ? `${project.latitude}, ${project.longitude}` : null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      {enregistre ? (
        <AlertBanner
          variant="information"
          title="Enregistré"
          explanation="Vos modifications ont été enregistrées."
        />
      ) : null}
      {invitation === "acceptee" ? (
        <AlertBanner
          variant="information"
          title="Invitation acceptée"
          explanation="Vous êtes désormais membre de ce chantier."
        />
      ) : null}

      <div className="flex items-center justify-between">
        <h1 className="text-h1 font-bold text-ink">Chantier</h1>
        <StatusChip variant={status.variant} label={status.label} />
      </div>

      <Card className="flex flex-col gap-4 p-6">
        {field("Nom du chantier", project.name)}
        {field("Pays", project.country)}
        {field("Adresse", project.address)}
        {field("Position (latitude, longitude)", locationLabel)}
        {field("Date de début prévue", project.planned_start_date)}
        {field("Date de fin prévue", project.planned_end_date)}
        {field("Budget", budgetLabel)}
      </Card>

      {canEdit ? (
        <Link href={`/chantiers/${id}/modifier`}>
          <Button className="w-full">Modifier</Button>
        </Link>
      ) : null}
    </div>
  );
}
