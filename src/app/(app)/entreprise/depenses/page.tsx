import { redirect } from "next/navigation";
import { getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner } from "@/components/ui";

// Dépenses internes — fonctionnalité non construite (aucune table expenses/
// expense_categories/receipts en base, conception seule dans
// DATABASE_TABLES.csv T024-T027). Confidentialité absolue actée (D183 :
// aucune exception de seuil ni d'activation ; BR098/BR099 révisées) — voir
// PROPOSITION_D4_FINANCES_INTERNES.md. Cette page indique clairement
// l'indisponibilité, n'affiche aucun montant ni journal inventé.
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
        explanation="Le suivi des dépenses internes et des justificatifs n'est pas encore construit ; il arrive par étapes (le budget interne de chaque chantier est déjà disponible dans le chantier, menu « Budget interne »). Les dépenses, budgets et justificatifs internes ne seront jamais visibles du propriétaire, sans aucune exception."
      />
    </div>
  );
}
