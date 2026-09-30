import Link from "next/link";
import { PrototypeClient } from "./PrototypeClient";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Route volontairement HORS du groupe (app) — même raisonnement que /offline :
// aucune session, aucune base, aucune permission. Prototype géométrique T0
// isolé, autorisé par le fondateur, sans lien avec le reste de l'application.
//
// Le lien retour depuis la page Plans d'un chantier n'ajoute aucune
// intégration métier : `retour` n'est jamais utilisé comme une destination
// littérale (aucun risque de redirection ouverte) — seul un identifiant est
// accepté, revalidé ici par un format strict, pour reconstruire un chemin
// interne fixe. Rien d'autre n'est transmis depuis le chantier d'origine.
export default async function PrototypePlansPage({
  searchParams,
}: {
  searchParams: Promise<{ retour?: string }>;
}) {
  const { retour } = await searchParams;
  const returnHref = retour && UUID_RE.test(retour) ? `/chantiers/${retour}/plans` : null;

  return (
    <div>
      {returnHref ? (
        <div className="mx-auto max-w-3xl px-6 pt-4">
          <Link href={returnHref} className="text-label font-semibold text-primary">
            ← Retour au chantier
          </Link>
        </div>
      ) : null}
      <PrototypeClient />
    </div>
  );
}
