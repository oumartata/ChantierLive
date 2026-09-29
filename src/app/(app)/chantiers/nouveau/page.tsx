import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { NouveauChantierForm } from "./NouveauChantierForm";

// FR017/AC017 : précondition "utilisateur vérifié" contrôlée par la Server
// Action (requireVerifiedAccount) et par le RPC (is_account_provisional).
// Ici, seule l'authentification est revérifiée pour l'accès à la page.
export default async function NouveauChantierPage() {
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: organizations } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("owner_profile_id", user.id)
    .is("archived_at", null)
    .order("name");

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Créer un chantier</h1>
      <NouveauChantierForm organizations={organizations ?? []} />
    </div>
  );
}
