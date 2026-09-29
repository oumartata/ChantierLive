import Link from "next/link";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Card } from "@/components/ui";
import { DecisionButtons } from "./DecisionButtons";
import { RefuseOnlyButton } from "./RefuseOnlyButton";

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

// Aperçu pré-authentification (BR024) : accessible sans session (client
// Supabase anon, get_invitation_preview grant à anon+authenticated, M006).
// Aucune information au-delà de chantier/rôle/expiration/disponibilité —
// aucun nom d'émetteur (profiles n'en porte aucun), aucune donnée de cible.
// Cache-Control: no-store et Referrer-Policy: no-referrer posés par
// src/proxy.ts pour tout /invitations/*, car le jeton figure dans l'URL.
//
// B015 fournissait l'aperçu lecture seule ; B016 ajoute les décisions
// (accepter/refuser) — jamais déclenchées automatiquement : l'utilisateur
// non authentifié est seulement dirigé vers connexion/inscription (avec
// reprise, FR033), l'utilisateur authentifié doit cliquer explicitement
// (DecisionButtons). La révocation reste une action de l'émetteur, sur une
// page séparée (/chantiers/[id]/invitations), jamais proposée ici.
export default async function InvitationPreviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_invitation_preview", { p_token: token });
  const preview = Array.isArray(data) ? data[0] : data;
  const user = await getVerifiedUser();

  if (error || !preview || preview.available !== true) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Invitation</h1>
        <AlertBanner
          variant="warning"
          title="Invitation non disponible"
          explanation="Ce lien est invalide, expiré, ou l'invitation a déjà été traitée."
        />
        {/* B016 (corrections post-revue) : "non disponible" couvre aussi le
            cas où l'adhésion émettrice a été invalidée (get_invitation_preview,
            M006) — refuse_invitation (M006a) reste utilisable dans ce cas
            précis (aucune revérification de l'émetteur). Proposé seulement à
            un utilisateur déjà authentifié, sans aucune donnée de chantier. */}
        {user ? <RefuseOnlyButton token={token} /> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Invitation</h1>
      <Card className="flex flex-col gap-2 p-6">
        <p className="text-body text-ink">
          Chantier : <span className="font-semibold">{preview.project_name}</span>
        </p>
        <p className="text-body text-ink">
          Rôle proposé :{" "}
          <span className="font-semibold">{roleLabel(preview.role, preview.owner_profile)}</span>
        </p>
        <p className="text-caption text-muted">
          Expire le {new Date(preview.expires_at).toLocaleString("fr-FR")}.
        </p>
      </Card>
      {user ? (
        <DecisionButtons token={token} identity={user.email ?? user.phone ?? null} />
      ) : (
        <>
          <AlertBanner
            variant="information"
            title="Connexion requise pour continuer"
            explanation="Connectez-vous ou inscrivez-vous avec l'identifiant concerné pour donner suite à cette invitation."
          />
          <div className="flex flex-col gap-3">
            <Link
              href={`/connexion?invitation=${token}`}
              className="flex h-12 w-full items-center justify-center rounded-small bg-primary text-label font-semibold text-surface"
            >
              Se connecter
            </Link>
            <Link
              href={`/inscription?invitation=${token}`}
              className="flex h-12 w-full items-center justify-center rounded-small border border-primary text-label font-semibold text-primary"
            >
              Créer un compte
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
