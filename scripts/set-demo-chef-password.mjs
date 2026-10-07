// Boucle 25 (en passant, décision du fondateur) : le compte local jetable
// « m045-chef-demo-…@example.test » (chef de chantier du chantier DÉMO
// AVANCEMENT, créé en boucle 24b) devient le compte de démonstration
// « chef de chantier ». Nouveau mot de passe aléatoire, enregistré
// UNIQUEMENT dans scripts/.demo-credentials.avancement.json (non versionné),
// sous la clé « chef ». Rien n'est affiché : ni l'adresse, ni le mot de passe.
//
// Usage : node --env-file=.env.local scripts/set-demo-chef-password.mjs <profile_id>
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Destination non locale refusée.");
const profileId = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(profileId ?? "")) throw new Error("Identifiant de profil attendu.");
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: u, error: gErr } = await service.auth.admin.getUserById(profileId);
if (gErr || !u?.user?.email?.startsWith("m045-chef-demo-") || !u.user.email.endsWith("@example.test")) throw new Error("Compte attendu introuvable.");
const { data: m } = await service.from("project_memberships").select("role").eq("profile_id", profileId).eq("project_id", "100c28c0-7ad5-4cc0-8da4-b664ce8713e3").is("revoked_at", null).maybeSingle();
if (m?.role !== "SITE_MANAGER") throw new Error("Adhésion chef de chantier active attendue.");
const password = `Demo-${randomBytes(18).toString("base64url")}`;
const { error: uErr } = await service.auth.admin.updateUserById(profileId, { password });
if (uErr) throw new Error("Mise à jour refusée.");
const file = join(dirname(fileURLToPath(import.meta.url)), ".demo-credentials.avancement.json");
const saved = JSON.parse(readFileSync(file, "utf8"));
saved.chef = { email: u.user.email, password, role: "SITE_MANAGER", project_id: "100c28c0-7ad5-4cc0-8da4-b664ce8713e3" };
writeFileSync(file, JSON.stringify(saved, null, 2) + "\n", "utf8");
// Vérification : connexion réelle avec le mot de passe enregistré.
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const re = JSON.parse(readFileSync(file, "utf8")).chef;
const { error: sErr } = await anon.auth.signInWithPassword({ email: re.email, password: re.password });
console.log(sErr ? "échec de la connexion de contrôle" : "mot de passe enregistré sous la clé « chef » ; connexion de contrôle réussie");
