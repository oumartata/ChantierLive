import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card } from "@/components/ui";
import { RevokeButton } from "./RevokeButton";

const ROLE_LABEL: Record<string, string> = {
  OWNER_PRIMARY: "Propriétaire principal",
  OWNER_CO_OWNER: "Copropriétaire",
  CONTRACTOR: "Entrepreneur",
  SITE_MANAGER: "Chef de chantier",
};

function roleLabel(role: string, ownerProfile: string | null): string {
  const key = role === "OWNER" ? `OWNER_${ownerProfile}` : role;
  return ROLE_LABEL[key] ?? role;
}

interface ManageableInvitation {
  id: string;
  role: string;
  owner_profile: string | null;
  target_kind: string | null;
  target_value_normalized: string | null;
  status: string;
  expires_at: string;
  revocable: boolean;
  created_at_server: string;
}

// B016 : consultation + révocation des invitations relevant du PÉRIMÈTRE de
// l'appelant — list_manageable_invitations (M006a) filtre déjà par rôle
// habilitant courant côté SQL ; cette page ne fait qu'afficher, jamais de
// contrôle d'autorisation supplémentaire ou différent ici. "revocable"
// distingue une PENDING encore utile d'une PENDING déjà expirée en
// pratique (lazy expiry) — pas de bouton Révoquer proposé pour cette
// dernière (action inutilisable, pas un oubli).
export default async function ManageInvitationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();

  if (!project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Invitations</h1>
        <AlertBanner
          variant="error"
          title="Chantier inaccessible"
          explanation="Ce chantier n'existe pas ou vous n'y avez pas accès."
        />
      </div>
    );
  }

  const { data, error } = await supabase.rpc("list_manageable_invitations", {
    p_project_id: id,
  });
  const invitations: ManageableInvitation[] = Array.isArray(data) ? data : [];

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Invitations — {project.name}</h1>
      {error ? (
        <AlertBanner
          variant="error"
          title="Lecture impossible"
          explanation="Les invitations n'ont pas pu être chargées. Réessayez."
        />
      ) : invitations.length === 0 ? (
        <AlertBanner
          variant="information"
          title="Aucune invitation à gérer"
          explanation="Aucune invitation en attente ne relève de votre rôle sur ce chantier."
        />
      ) : (
        invitations.map((inv) => (
          <Card key={inv.id} className="flex flex-col gap-2 p-6">
            <p className="text-body text-ink">
              Rôle proposé :{" "}
              <span className="font-semibold">{roleLabel(inv.role, inv.owner_profile)}</span>
            </p>
            {inv.target_kind ? (
              <p className="text-caption text-muted">Cible : {inv.target_value_normalized}</p>
            ) : (
              <p className="text-caption text-muted">Lien partagé (aucune cible)</p>
            )}
            {inv.revocable ? (
              <>
                <p className="text-caption text-muted">
                  Expire le {new Date(inv.expires_at).toLocaleString("fr-FR")}.
                </p>
                <RevokeButton invitationId={inv.id} projectId={project.id} />
              </>
            ) : (
              <p className="text-caption text-danger">Expirée</p>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
