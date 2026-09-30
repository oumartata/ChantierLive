import { PrototypeClient } from "./PrototypeClient";

// Route volontairement HORS du groupe (app) — même raisonnement que /offline :
// aucune session, aucune base, aucune permission. Prototype géométrique T0
// isolé, autorisé par le fondateur, sans lien avec le reste de l'application.
export default function PrototypePlansPage() {
  return <PrototypeClient />;
}
