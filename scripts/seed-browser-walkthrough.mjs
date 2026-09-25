// Fixture LOCALE jetable pour le parcours navigateur manuel B026/B027.
// Crée un utilisateur CONTRACTOR vérifié + un chantier draft. Affiche les
// identifiants de connexion (compte de test local jetable, jamais une
// donnée réelle) pour un parcours navigateur one-shot.
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const service = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const email = `b027-browser-${Date.now()}@example.test`;
const password = `Browser-${randomUUID()}`;

const { data: user, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw error;

await service.from("profile_identifiers").insert({
  profile_id: user.user.id, kind: "EMAIL", value_normalized: email.toLowerCase(), verified_at_server: new Date().toISOString(),
});

const anon = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
await anon.auth.signInWithPassword({ email, password });
const { data: draft, error: draftErr } = await anon.rpc("create_draft_project", {
  p_name: "Villa Almadies (démo B027)", p_country: "SN", p_role: "CONTRACTOR",
});
if (draftErr) throw draftErr;

console.log(JSON.stringify({ email, password, projectId: draft[0].project_id }, null, 2));
