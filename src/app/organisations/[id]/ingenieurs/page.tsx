import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, StatusChip } from "@/components/ui";
import { DesignateEngineerForm } from "./DesignateEngineerForm";
import { RevokeEngineerButton } from "./RevokeEngineerButton";

interface EngineerDesignation {
  id: string;
  designated_identifier_kind: "EMAIL" | "PHONE";
  designated_identifier_value_normalized: string;
  revoked_at: string | null;
  created_at_server: string;
}

// B062 (D092) : première page organisation de ce projet — aucune n'existait
// avant (organizations n'avait jusqu'ici aucune UI dédiée, seulement un
// provisioning implicite via la création de chantier, B014). Réservée au
// propriétaire COURANT de l'organisation (organizations.owner_profile_id),
// revérifié ici pour l'affichage ET par chaque RPC appelée (defense in
// depth, l'autorité réelle reste toujours côté serveur). La désignation ne
// donne ici aucun accès aux plans ni aux finances — aucune fonction appelée
// par cette page n'écrit dans project_memberships/membership_permissions.
export default async function OrganisationIngenieursPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: organizationId } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select("id, name, owner_profile_id")
    .eq("id", organizationId)
    .maybeSingle();

  if (organizationError || !organization) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <AlertBanner
          variant="error"
          title="Organisation introuvable"
          explanation="Vérifiez le lien ou vos droits d'accès."
        />
      </div>
    );
  }

  if (organization.owner_profile_id !== user.id) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <AlertBanner
          variant="warning"
          title="Réservé au propriétaire"
          explanation="Seul le propriétaire de l'organisation peut désigner ou révoquer un ingénieur habilité."
        />
      </div>
    );
  }

  const { data: designations, error: designationsError } = await supabase.rpc(
    "list_organization_engineers",
    { p_organization_id: organizationId }
  );

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Ingénieurs habilités — {organization.name}</h1>
      <Card className="flex flex-col gap-4">
        <DesignateEngineerForm organizationId={organization.id} />
      </Card>
      <Card className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Désignations</h2>
        {designationsError ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
        ) : (designations ?? []).length === 0 ? (
          <p className="text-body text-muted">Aucun ingénieur désigné pour l&apos;instant.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {(designations as EngineerDesignation[]).map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-3 border-b border-sand pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-col">
                  <span className="text-label font-semibold text-ink break-all">
                    {d.designated_identifier_value_normalized}
                  </span>
                  <span className="text-caption text-muted">
                    {d.designated_identifier_kind === "EMAIL" ? "E-mail" : "Téléphone"} — désigné le{" "}
                    {new Date(d.created_at_server).toLocaleDateString("fr-FR")}
                  </span>
                </div>
                {d.revoked_at ? (
                  <StatusChip variant="neutral" label="Révoqué" />
                ) : (
                  <RevokeEngineerButton organizationId={organization.id} designationId={d.id} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
