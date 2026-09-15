// Pipeline qualité local (lot B005) : exécute lint, vérification de types,
// tests automatisés puis build, dans cet ordre, et s'arrête immédiatement au
// premier échec avec un message indiquant clairement l'étape fautive et un
// code de sortie non nul. Aucune dépendance : uniquement `node:child_process`.
// Fonctionne à l'identique sous Windows et sous Linux (GitHub Actions) —
// chaque étape est lancée en sous-processus via spawnSync, sans dépendre du
// comportement d'un enchaînement shell `&&` qui diffère entre cmd.exe et sh.
//
// Usage : npm run verify  (ou : node scripts/quality-gate.mjs)

import { spawnSync } from "node:child_process";

// Sous Windows, npm est installé sous forme de script .cmd : spawnSync ne
// peut pas l'exécuter directement sans passer par un interpréteur de
// commandes (erreur EINVAL sinon). `shell: true` couvre les deux
// plateformes : cmd.exe sous Windows, /bin/sh ailleurs (GitHub Actions
// Linux inclus). Node déconseille shell:true avec un tableau d'arguments
// (DEP0190, risque d'injection si les arguments étaient dynamiques) : la
// commande est donc construite comme une seule chaîne, à partir des noms
// d'étapes fixes ci-dessous — jamais d'entrée externe ou dynamique.
const STEP_NAMES = ["lint", "typecheck", "test", "build"];

for (const name of STEP_NAMES) {
  console.log(`\n▶ Étape : ${name}`);

  const result = spawnSync(`npm run ${name}`, { stdio: "inherit", shell: true });

  if (result.error) {
    console.error(`\n✖ Échec de l'étape "${name}" : ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`\n✖ Échec de l'étape "${name}" (code de sortie ${result.status}).`);
    process.exit(result.status ?? 1);
  }

  console.log(`✔ Étape "${name}" réussie.`);
}

console.log("\n✔ Pipeline qualité complet : toutes les étapes ont réussi.");
