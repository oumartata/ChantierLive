// Préparation de démonstration ciblée — validation navigateur du lot
// « Avancement des travaux » (M033). LOCAL UNIQUEMENT.
//
// Effets, et seulement ceux-ci :
//   - crée 2 comptes NEUFS dédiés (demo-avancement-entreprise@ / -proprietaire@
//     chantierlive.test), mot de passe aléatoire écrit dans
//     scripts/.demo-credentials.avancement.json (ignoré par Git) ;
//   - marque comme vérifiés les identifiants de CES DEUX comptes uniquement ;
//   - crée UN chantier « DÉMO AVANCEMENT — validation navigateur » via
//     create_draft_project (CONTRACTOR), puis ajoute le propriétaire PRIMARY
//     par invitation réelle (create_invitation + accept_invitation).
// Aucun reset, aucune suppression, aucun mot de passe ni rôle modifié sur un
// compte existant : si un compte dédié existe déjà sans fichier
// d'identifiants, le script s'arrête au lieu de le réinitialiser. Rejouable
// sans doublon (comptes et chantier retrouvés, jamais recréés).
//
// Usage : node --env-file=.env.local scripts/seed-demo-avancement.mjs

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const { hostname } = new URL(SUPABASE_URL);
if (hostname !== "127.0.0.1" && hostname !== "localhost") {
  console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`);
  process.exit(1);
}
if (!SERVICE_KEY || !ANON_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY manquants.");
  process.exit(1);
}
const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const PROJECT_NAME = "DÉMO AVANCEMENT — validation navigateur";
const CREDENTIALS_FILE = new URL("./.demo-credentials.avancement.json", import.meta.url);
const ACCOUNTS = {
  entreprise: "demo-avancement-entreprise@chantierlive.test",
  proprietaire: "demo-avancement-proprietaire@chantierlive.test",
};

async function must(promise, what) {
  const r = await promise;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}

async function findUserByEmail(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
}

async function main() {
  console.log(`Cible : ${SUPABASE_URL}`);
  const saved = existsSync(CREDENTIALS_FILE) ? JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) : {};
  const users = {};

  for (const [label, email] of Object.entries(ACCOUNTS)) {
    const existing = await findUserByEmail(email);
    let password = saved[label]?.password;
    let id;
    if (existing) {
      if (!password) throw new Error(`Compte ${email} déjà présent sans identifiants locaux : arrêt (aucune réinitialisation).`);
      id = existing.id;
      console.log(`Compte ${label} déjà présent — réutilisé sans modification.`);
    } else {
      password = `Demo-${randomBytes(12).toString("base64url")}`;
      const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `createUser(${label})`);
      id = created.user.id;
      // Écrit immédiatement : un échec plus loin ne laisse jamais un compte sans identifiants.
      saved[label] = { email, password };
      writeFileSync(CREDENTIALS_FILE, JSON.stringify(saved, null, 2));
      // Vérification de l'identifiant de CE compte neuf uniquement (même
      // convention que demo_seed_chantierlive.mjs, limitée au profil créé ici).
      await must(service.from("profile_identifiers").update({ verified_at_server: new Date().toISOString() }).eq("profile_id", id), `verify(${label})`);
      console.log(`Compte ${label} créé.`);
    }
    const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    await must(client.auth.signInWithPassword({ email, password }), `signIn(${label})`);
    users[label] = { id, email, client };
  }

  const { entreprise, proprietaire } = users;
  const { data: existingMembership } = await service
    .from("project_memberships")
    .select("project_id, projects!inner(name)")
    .eq("profile_id", entreprise.id)
    .eq("role", "CONTRACTOR")
    .eq("projects.name", PROJECT_NAME)
    .is("revoked_at", null)
    .maybeSingle();

  let projectId;
  if (existingMembership) {
    projectId = existingMembership.project_id;
    console.log(`Chantier démo déjà présent (${projectId}) — réutilisé.`);
  } else {
    const created = await must(
      entreprise.client.rpc("create_draft_project", { p_name: PROJECT_NAME, p_country: "ML", p_role: "CONTRACTOR" }),
      "create_draft_project"
    );
    projectId = (Array.isArray(created) ? created[0] : created).project_id;
    console.log(`Chantier démo créé (${projectId}).`);
  }

  const { data: ownerMembership } = await service
    .from("project_memberships")
    .select("id")
    .eq("project_id", projectId)
    .eq("profile_id", proprietaire.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (ownerMembership) {
    console.log("Propriétaire déjà membre — invitation non renvoyée.");
  } else {
    const invitation = await must(
      entreprise.client.rpc("create_invitation", { p_project_id: projectId, p_role: "OWNER", p_target_kind: "EMAIL", p_target_value_raw: proprietaire.email }),
      "create_invitation"
    );
    await must(proprietaire.client.rpc("accept_invitation", { p_token: invitation.token }), "accept_invitation");
    console.log("Propriétaire ajouté par invitation acceptée.");
  }

  const { data: roles } = await service
    .from("project_memberships")
    .select("role, owner_profile, profile_id")
    .eq("project_id", projectId)
    .is("revoked_at", null);
  const label = (pid) => (pid === entreprise.id ? "entreprise" : pid === proprietaire.id ? "proprietaire" : "autre");
  console.log("Adhésions actives :", roles.map((r) => `${label(r.profile_id)}=${r.role}${r.owner_profile ? "/" + r.owner_profile : ""}`).join(", "));
  saved.projectId = projectId;
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(saved, null, 2));
  console.log(`Identifiants écrits dans ${CREDENTIALS_FILE.pathname.split("/").pop()} (non affichés).`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
