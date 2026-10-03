import Link from "next/link";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { PrototypeClient } from "./PrototypeClient";
import type { DepositContext } from "./PrototypeClient";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Route volontairement HORS du groupe (app) — même raisonnement que /offline :
// aucune session, aucune base, aucune permission PAR DÉFAUT. Prototype
// géométrique T0 isolé, autorisé par le fondateur, sans lien avec le reste de
// l'application — ceci reste vrai quand `retour` est absent ou invalide
// (aucune lecture de session déclenchée dans ce cas, usage local inchangé).
//
// `retour` n'est JAMAIS une autorisation (Lot 1, PREPARATION_INTEGRATION_METIER.md) :
// seul un identifiant est accepté, revalidé ici par un format strict, pour (a)
// reconstruire un chemin interne fixe (aucun risque de redirection ouverte) et
// (b) lire — avec la session réelle de l'appelant, jamais déduite du
// paramètre — si cette personne a une adhésion ACTIVE sur ce chantier précis.
// Sans adhésion active, rien n'est révélé (ni le nom du chantier, ni son
// existence) : deviner un identifiant ne donne accès à aucune donnée. Le
// dépôt réel (depositProjectPlanAction, action serveur inchangée) revérifie
// de toute façon le rôle lui-même — ceci ne sert qu'à l'affichage.
export default async function PrototypePlansPage({
  searchParams,
}: {
  searchParams: Promise<{ retour?: string; demande?: string }>;
}) {
  const { retour, demande } = await searchParams;
  const returnHref = retour && UUID_RE.test(retour) ? `/chantiers/${retour}/plans` : null;
  // "demande" suit la même règle que "retour" : jamais une autorisation,
  // seulement reconstruit par la session réelle de l'appelant au moment de
  // l'appel RPC (list_plan_request_variants/get_plan_request_variant, M031b).
  // "new" signale une intention (créer une demande au premier "Générer"),
  // jamais un identifiant réel.
  const requestParam = demande === "new" || (demande && UUID_RE.test(demande)) ? demande : null;

  let depositContext: DepositContext | null = null;
  if (returnHref && retour) {
    const user = await getVerifiedUser();
    if (user) {
      const supabase = await createClient();
      const { data: project } = await supabase.from("projects").select("id, name").eq("id", retour).maybeSingle();
      const { data: membership } = await supabase
        .from("project_memberships")
        .select("role, owner_profile")
        .eq("project_id", retour)
        .eq("profile_id", user.id)
        .is("revoked_at", null)
        .maybeSingle();
      if (project && membership) {
        const canDeposit = membership.role === "CONTRACTOR" || (membership.role === "OWNER" && membership.owner_profile === "PRIMARY");
        depositContext = { projectId: project.id, projectName: project.name, canDeposit };
      }
    }
  }

  return (
    <div>
      {returnHref ? (
        <div className="mx-auto max-w-3xl px-6 pt-4">
          <Link href={returnHref} className="text-label font-semibold text-primary">
            ← Retour au chantier
          </Link>
        </div>
      ) : null}
      <PrototypeClient depositContext={depositContext} requestParam={requestParam} />
    </div>
  );
}
