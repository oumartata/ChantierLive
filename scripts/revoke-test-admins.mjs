// Opération serveur LOCALE (décision du fondateur, boucle 35) : retire le rôle
// d'administrateur de plateforme des comptes jetables créés par les tests
// M049 et M050, en conservant le compte administrateur de démonstration.
// Sélection stricte : note « test M049 » ou « test M050 » ET identifiant
// e-mail en m049-/m050-…@example.test. Chaque retrait est inscrit au journal
// de plateforme (scripts/lib/platform-admin.mjs). Sans --apply : comptage
// seulement. Rien n'est affiché hormis des comptes.
//
// Usage : node --env-file=.env.local scripts/revoke-test-admins.mjs [--apply]
import { createClient } from "@supabase/supabase-js";
import { revokeTestAdmin } from "./lib/platform-admin.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url))
  throw new Error("Destination non locale refusée.");
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: admins, error } = await service
  .from("platform_admins")
  .select("profile_id, note");
if (error) throw new Error(error.message);
const ids = admins.map((a) => a.profile_id);
const { data: idents, error: iErr } = await service
  .from("profile_identifiers")
  .select("profile_id, kind, value_normalized")
  .in("profile_id", ids);
if (iErr) throw new Error(iErr.message);
const isTestAccount = (a) =>
  /^test M0(49|50)$/.test(a.note ?? "") &&
  idents.some(
    (i) =>
      i.profile_id === a.profile_id &&
      i.kind === "EMAIL" &&
      /^m0(49|50)-administrateur-\d+-\d+@example\.test$/.test(
        i.value_normalized,
      ),
  );
const targets = admins.filter(isTestAccount);
console.log(
  `administrateurs avant : ${admins.length} ; comptes jetables de test : ${targets.length} ; conservés : ${admins.length - targets.length}`,
);
if (process.argv.includes("--apply")) {
  let done = 0;
  for (const t of targets) {
    const r = await revokeTestAdmin(
      service,
      t.profile_id,
      "Compte jetable de test : rôle retiré (décision du fondateur, boucle 35).",
    );
    if (!r.ok) throw new Error(`retrait refusé : ${r.error}`);
    done += 1;
  }
  const { count } = await service
    .from("platform_admins")
    .select("profile_id", { count: "exact", head: true });
  console.log(`retirés : ${done} ; administrateurs après : ${count}`);
}
