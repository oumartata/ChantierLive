// Fixture LOCALE jetable pour le parcours navigateur manuel B062. Crée un
// utilisateur CONTRACTOR vérifié (organisation personnelle provisionnée par
// create_draft_project, B014 — chemin réel de l'application, pas une
// organisation fabriquée à la main) et un second utilisateur vérifié à
// désigner comme ingénieur. Affiche les identifiants de connexion (comptes
// de test locaux jetables, jamais une donnée réelle) pour un parcours
// navigateur one-shot.
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const service = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function createVerifiedUser(label) {
  const email = `b062-browser-${label}-${Date.now()}@example.test`;
  const password = `Browser-${randomUUID()}`;
  const { data: user, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  await service.from("profile_identifiers").insert({
    profile_id: user.user.id, kind: "EMAIL", value_normalized: email.toLowerCase(), verified_at_server: new Date().toISOString(),
  });
  return { id: user.user.id, email: email.toLowerCase(), password };
}

const owner = await createVerifiedUser("owner");
const engineer = await createVerifiedUser("engineer");

const ownerClient = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
const { error: draftErr } = await ownerClient.rpc("create_draft_project", {
  p_name: "Chantier démo B062", p_country: "SN", p_role: "CONTRACTOR",
});
if (draftErr) throw draftErr;

const { data: org, error: orgErr } = await service
  .from("organizations")
  .select("id, name")
  .eq("owner_profile_id", owner.id)
  .single();
if (orgErr) throw orgErr;

console.log(JSON.stringify({
  owner: { email: owner.email, password: owner.password },
  organizationId: org.id,
  organizationName: org.name,
  engineerEmailToDesignate: engineer.email,
}, null, 2));
