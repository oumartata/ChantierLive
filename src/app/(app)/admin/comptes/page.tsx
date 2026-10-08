import { notFound, redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AccountLookupForm } from "../AdminForms";

// SCR061 « Comptes et organisations » — B050 (M050 ; D195 E4, E5). Aucune
// liste nominative : recherche d'un compte sur son identifiant exact,
// réponse minimale, recherche auditée (identifiant masqué).

export default async function AdminAccountsPage() {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Comptes</h1>
        <p className="text-body text-muted">
          Aucune liste de comptes. Recherchez un compte à partir de l&apos;identifiant que la personne vous a donné ; vous ne verrez ni son nom, ni ses
          chantiers.
        </p>
      </div>
      <AccountLookupForm />
    </div>
  );
}
