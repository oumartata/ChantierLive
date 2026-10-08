// Boucle 27 réduite (décision du fondateur) : le compte local jetable
// « b044-coproprietaire-demo-…@example.test » (copropriétaire du chantier
// DÉMO AVANCEMENT, créé en boucle 26b) devient un compte de démonstration.
// Nouveau mot de passe aléatoire, enregistré UNIQUEMENT dans
// scripts/.demo-credentials.avancement.json (non versionné), sous la clé
// « coproprietaire ». Rien n'est affiché : ni l'adresse, ni le mot de passe.
//
// Usage : node --env-file=.env.local scripts/set-demo-coproprietaire-password.mjs
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "100c28c0-7ad5-4cc0-8da4-b664ce8713e3";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Destination non locale refusée.");
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: members, error: mErr } = await service.from("project_memberships").select("profile_id").eq("project_id", PROJECT_ID).eq("role", "OWNER").eq("owner_profile", "CO_OWNER").is("revoked_at", null);
if (mErr) throw new Error("Lecture des adhésions refusée.");
const candidates = [];
for (const m of members ?? []) {
  const { data: u } = await service.auth.admin.getUserById(m.profile_id);
  const email = u?.user?.email ?? "";
  if (email.startsWith("b044-coproprietaire-demo-") && email.endsWith("@example.test")) candidates.push({ id: m.profile_id, email });
}
if (candidates.length !== 1) throw new Error(`Compte attendu : exactement un, trouvé ${candidates.length}.`);
const [account] = candidates;
const password = `Demo-${randomBytes(18).toString("base64url")}`;
const { error: uErr } = await service.auth.admin.updateUserById(account.id, { password });
if (uErr) throw new Error("Mise à jour refusée.");
const file = join(dirname(fileURLToPath(import.meta.url)), ".demo-credentials.avancement.json");
const saved = JSON.parse(readFileSync(file, "utf8"));
saved.coproprietaire = { email: account.email, password, role: "OWNER", owner_profile: "CO_OWNER", project_id: PROJECT_ID };
writeFileSync(file, JSON.stringify(saved, null, 2) + "\n", "utf8");
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const re = JSON.parse(readFileSync(file, "utf8")).coproprietaire;
const { error: sErr } = await anon.auth.signInWithPassword({ email: re.email, password: re.password });
console.log(sErr ? "échec de la connexion de contrôle" : "mot de passe enregistré sous la clé « coproprietaire » ; connexion de contrôle réussie");
