// Test d'intégration LOCAL uniquement pour M029 (complément B014 : validation
// serveur de la position d'un chantier). Aucune suite dédiée n'existait pour
// create_draft_project/update_draft_project avant ce script — les tests
// couvrant les autres champs (name/country/address/dates/budget) sont donc
// exécutés ici en non-régression ciblée, pas repris d'un nombre supposé.
//
// Fixtures dédiées uniquement (nouveaux comptes, nouveaux chantiers créés par
// ce script) — jamais les chantiers "Famille Touré".
//
// Usage : node scripts/test-project-location.mjs

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

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

const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail !== undefined ? " — " + detail : ""}`);
}
const err = (res) => res.error?.message ?? "aucune erreur";

async function createTestUser(label) {
  const email = `m029-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createTestUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${label}): ${signInError.message}`);
  return { id: data.user.id, email: email.toLowerCase(), client };
}

function psql(sql) {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", ["exec", "-i", "supabase_db_ChantierLive", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`psql exit ${code}: ${stderr}`))));
    proc.stdin.write(sql);
    proc.stdin.end();
  });
}
// Exécute un SQL privilégié et renvoie soit la sortie, soit le message d'erreur.
const psqlTry = (sql) => psql(sql).then((out) => ({ ok: true, out }), (e) => ({ ok: false, error: e.message }));

async function main() {
  // ---- Fixture : un OWNER/PRIMARY et un chantier DRAFT dédiés ----
  const owner = await createTestUser("owner");
  const { data: created, error: createErr } = await owner.client.rpc("create_draft_project", {
    p_name: "Chantier test M029",
    p_country: "FR",
    p_role: "OWNER",
  });
  if (createErr) throw new Error(`create_draft_project: ${createErr.message}`);
  const projectId = created[0].project_id;

  async function currentRevision() {
    const { data } = await service.from("projects").select("revision").eq("id", projectId).single();
    return data.revision;
  }
  async function update(fields) {
    const revision = await currentRevision();
    return owner.client.rpc("update_draft_project", {
      p_project_id: projectId,
      p_expected_revision: revision,
      p_name: "Chantier test M029",
      p_country: "FR",
      p_address: null,
      p_latitude: null,
      p_longitude: null,
      p_planned_start_date: null,
      p_planned_end_date: null,
      p_budget: null,
      ...fields,
    });
  }

  // ---- 1. Réussite (bornes inclusives) ----
  {
    const r1 = await update({ p_latitude: 48.8566, p_longitude: 2.3522 });
    record("Position valide acceptée (Paris)", !r1.error && r1.data?.latitude === 48.8566 && r1.data?.longitude === 2.3522, err(r1));

    const r2 = await update({ p_latitude: 90, p_longitude: 180 });
    record("Borne inclusive haute acceptée (90, 180)", !r2.error, err(r2));

    const r3 = await update({ p_latitude: -90, p_longitude: -180 });
    record("Borne inclusive basse acceptée (-90, -180)", !r3.error, err(r3));
  }

  // ---- 2. Hors bornes ----
  {
    const r1 = await update({ p_latitude: 90.0001, p_longitude: 0 });
    record("Latitude > 90 refusée", r1.error?.message === "latitude_out_of_range", err(r1));

    const r2 = await update({ p_latitude: -90.0001, p_longitude: 0 });
    record("Latitude < -90 refusée", r2.error?.message === "latitude_out_of_range", err(r2));

    const r3 = await update({ p_latitude: 0, p_longitude: 180.0001 });
    record("Longitude > 180 refusée", r3.error?.message === "longitude_out_of_range", err(r3));

    const r4 = await update({ p_latitude: 0, p_longitude: -180.0001 });
    record("Longitude < -180 refusée", r4.error?.message === "longitude_out_of_range", err(r4));
  }

  // ---- 3. Paire incomplète / effacement complet ----
  {
    const r1 = await update({ p_latitude: 10, p_longitude: null });
    record("Paire incomplète (latitude seule) refusée", r1.error?.message === "location_pair_incomplete", err(r1));

    const r2 = await update({ p_latitude: null, p_longitude: 10 });
    record("Paire incomplète (longitude seule) refusée", r2.error?.message === "location_pair_incomplete", err(r2));

    // Position déjà posée à l'étape 1, puis effacement complet demandé.
    await update({ p_latitude: 48.8566, p_longitude: 2.3522 });
    const r3 = await update({ p_latitude: null, p_longitude: null });
    record("Effacement complet (NULL/NULL) accepté", !r3.error && r3.data?.latitude === null && r3.data?.longitude === null, err(r3));
  }

  // ---- 4. NaN / valeurs non finies (chemin SQL direct, hors JSON/PostgREST,
  //         qui ne peut transmettre ni NaN ni Infinity). auth.uid() lit le GUC
  //         request.jwt.claims : la session psql brute est authentifiée en
  //         posant ce GUC pour le uid du owner de test, dans une transaction
  //         annulée dans tous les cas (rollback), sans effet de bord réel. ----
  {
    const revision = await currentRevision();
    const asOwner = (sql) => `
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '${owner.id}', 'role', 'authenticated')::text, true);
${sql}
rollback;
`;

    const nanCall = await psqlTry(
      asOwner(`select update_draft_project('${projectId}'::uuid, ${revision}, 'Chantier test M029', 'FR', null, 'NaN'::numeric, 0, null, null, null);`)
    );
    // NaN est classé supérieur à toute valeur réelle par l'ordre numeric de
    // Postgres : "NaN <= 90" est faux, donc le garde de plage le rejette déjà.
    record(
      "Latitude NaN refusée (chemin SQL direct)",
      !nanCall.ok && /latitude_out_of_range/.test(nanCall.error),
      nanCall.ok ? "acceptée à tort" : nanCall.error
    );

    const infCall = await psqlTry(
      asOwner(`select update_draft_project('${projectId}'::uuid, ${revision}, 'Chantier test M029', 'FR', null, 'Infinity'::numeric, 0, null, null, null);`)
    );
    // Constaté empiriquement (pas supposé) : cette version de Postgres admet
    // 'Infinity'::numeric (support ajouté en amont, PG 14+) — le cast ne lève
    // donc aucune erreur de type. C'est notre PROPRE garde de plage qui
    // rejette la valeur (Infinity > 90 = vrai) : latitude_out_of_range, pas
    // une limite du type. Corrige une hypothèse initiale erronée.
    record(
      "Latitude Infinity refusée par le garde de plage",
      !infCall.ok && /latitude_out_of_range/.test(infCall.error),
      infCall.ok ? "acceptée à tort" : infCall.error
    );
  }

  // ---- 5. Droits, statut, révision inchangés ----
  {
    const stranger = await createTestUser("stranger");
    const { data: strangerRevision } = await service.from("projects").select("revision").eq("id", projectId).single();
    const rStranger = await stranger.client.rpc("update_draft_project", {
      p_project_id: projectId,
      p_expected_revision: strangerRevision.revision,
      p_name: "Chantier test M029",
      p_country: "FR",
      p_address: null,
      p_latitude: 1,
      p_longitude: 1,
      p_planned_start_date: null,
      p_planned_end_date: null,
      p_budget: null,
    });
    record("Non-membre refusé (not_authorized), position incluse", rStranger.error?.message === "not_authorized", err(rStranger));

    const staleRevision = await currentRevision();
    await update({ p_latitude: 5, p_longitude: 5 }); // fait avancer la révision réelle
    const rStale = await owner.client.rpc("update_draft_project", {
      p_project_id: projectId,
      p_expected_revision: staleRevision,
      p_name: "Chantier test M029",
      p_country: "FR",
      p_address: null,
      p_latitude: 6,
      p_longitude: 6,
      p_planned_start_date: null,
      p_planned_end_date: null,
      p_budget: null,
    });
    record("Révision obsolète refusée (revision_conflict), position incluse", rStale.error?.message === "revision_conflict", err(rStale));

    await service.from("projects").update({ status: "ACTIVE" }).eq("id", projectId);
    const rNotDraft = await update({ p_latitude: 7, p_longitude: 7 });
    record("Hors DRAFT refusé (not_draft), position incluse", rNotDraft.error?.message === "not_draft", err(rNotDraft));
    await service.from("projects").update({ status: "DRAFT" }).eq("id", projectId);
  }

  // ---- 6. Non-régression ciblée : les autres champs restent inchangés ----
  {
    const r = await update({ p_address: "12 rue Test", p_budget: "150000", p_latitude: 2, p_longitude: 2 });
    // budget (bigint) est sérialisé en nombre JS par PostgREST pour les
    // valeurs sous 2^53-1 (vérifié empiriquement) : comparaison numérique,
    // pas de chaîne stricte.
    record(
      "Autres champs (adresse, budget) toujours écrits normalement",
      !r.error && r.data?.address === "12 rue Test" && Number(r.data?.budget) === 150000,
      err(r)
    );
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} tests réussis.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
