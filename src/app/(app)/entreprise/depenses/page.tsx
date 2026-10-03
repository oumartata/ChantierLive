import { redirect } from "next/navigation";
import { getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner } from "@/components/ui";

// Dépenses internes — fonctionnalité non construite (aucune table expenses/
// expense_categories/receipts en base, conception seule dans
// DATABASE_TABLES.csv T024-T027). Confidentialité déjà actée (D086/D090/
// BR098/BR099) pour le jour où elle sera construite — voir
// PREPARATION_ESPACES_PROPRIETAIRE_ENTREPRISE.md §3.3. Cette page indique
// clairement l'indisponibilité, n'affiche aucun montant ni journal inventé.
export default async function EntrepriseDepensesPage() {
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Dépenses internes</h1>
      <AlertBanner
        variant="information"
        title="Fonctionnalité pas encore disponible"
        explanation="Le suivi des dépenses internes et des justificatifs n'est pas encore construit. Une proposition séparée (modèle de données, permissions, migrations) doit être validée avant toute mise en service. Privé par défaut envers le client dès sa construction (BR098), avec l'exception déjà prévue (seuil configurable ou activation explicite du chantier, BR050)."
      />
    </div>
  );
}
