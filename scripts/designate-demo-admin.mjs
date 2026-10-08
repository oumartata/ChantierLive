// Opération serveur LOCALE (D194 A1) : crée un compte de démonstration
// « administrateur de plateforme » et le désigne par designate_platform_admin
// (service_role ; aucune fonction de l'application ne peut le faire).
// Le compte n'a et n'aura aucune adhésion de chantier (A2). Mot de passe
// aléatoire enregistré UNIQUEMENT dans scripts/.demo-credentials.avancement.json
// (non versionné), sous la clé « administrateur ». Rien n'est affiché : ni
// l'adresse, ni le mot de passe. Sans effet si la clé existe déjà.
//
// Usage : node --env-file=.env.local scripts/designate-demo-admin.mjs
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Destination non locale refusée.");
const file = join(dirname(fileURLToPath(import.meta.url)), ".demo-credentials.avancement.json");
const saved = JSON.parse(readFileSync(file, "utf8"));
if (saved.administrateur) {
  console.log("compte administrateur de démonstration déjà présent ; rien n'est modifié");
  process.exit(0);
}
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const email = `b049-administrateur-demo-${Date.now()}@example.test`;
const password = `Demo-${randomBytes(18).toString("base64url")}`;
const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw new Error("Création du compte refusée.");
const { error: dErr } = await service.rpc("designate_platform_admin", { p_profile_id: data.user.id, p_note: "Compte de démonstration local (boucle 32b, D194 A1)" });
if (dErr) throw new Error(`Désignation refusée : ${dErr.message}`);
saved.administrateur = { email, password, role: "PLATFORM_ADMIN" };
writeFileSync(file, JSON.stringify(saved, null, 2) + "\n", "utf8");
// Vérification : connexion réelle et rôle reconnu.
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const re = JSON.parse(readFileSync(file, "utf8")).administrateur;
const { error: sErr } = await anon.auth.signInWithPassword({ email: re.email, password: re.password });
const { data: isAdmin } = await anon.rpc("is_platform_admin");
console.log(sErr ? "échec de la connexion de contrôle" : `compte enregistré sous la clé « administrateur » ; connexion de contrôle réussie ; administrateur reconnu : ${isAdmin === true}`);
