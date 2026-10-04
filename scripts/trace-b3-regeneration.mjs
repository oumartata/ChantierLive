// Trace ciblée B3 — régénération après verrouillage (diagnostic, 2026-10-05).
// LECTURE SEULE : n'écrit que la fixture des entrées (option --write-fixture)
// et n'utilise que des fonctions existantes du moteur. Aucune stratégie de
// génération modifiée. REPRODUCTION (pas le brouillon original, non
// conservé) : paramètres par défaut de l'écran, première variante affichée.
//
// Usage :
//   node scripts/trace-b3-regeneration.mjs                  # trace
//   node scripts/trace-b3-regeneration.mjs --write-fixture  # fige les entrées

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const FIXTURE = join(__dirname, "fixtures", "plans-b3-regeneration-reproduction.json");
const tmpDir = mkdtempSync(join(tmpdir(), "plans-b3-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "${join("src", "app", "prototype-plans", "geometry.ts")}" --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
  const g = await import(pathToFileURL(join(tmpDir, "geometry.js")).href);

  const input = {
    orientation: "N", setbacks: { front: 3, back: 2, left: 2, right: 2 }, entryMode: "direct", courtyardDepth: 3, centralSalon: false,
    roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", terrainWidth: 15, terrainDepth: 20, accessSide: "front",
    needs: [
      { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
      { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
      { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
      { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
      { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
    ],
  };
  const idx = (L, label, number) => L.rooms.findIndex((r) => r.label === label && r.number === number);
  let base;
  if (process.argv.includes("--write-fixture") || !existsSync(FIXTURE)) {
    base = g.generateVariants(input).variants[0];
    writeFileSync(FIXTURE, JSON.stringify({
      description: "B3 — REPRODUCTION (le brouillon du diagnostic initial du 2026-10-04 n'est pas conservé). Paramètres par défaut de l'écran, première variante affichée, AUCUNE modification ; verrou appliqué au moment de la trace (Chambre 2, puis Salon 1). Comptes d'origine : 75 puis 50 explorations écartées.",
      generationInput: input,
      cases: [{ lock: ["Chambre", 2], originalRejected: 75 }, { lock: ["Salon", 1], originalRejected: 50 }],
      layout: base,
    }, null, 2) + "\n");
    console.log(`Fixture écrite : ${FIXTURE}`);
  } else {
    base = JSON.parse(readFileSync(FIXTURE, "utf8")).layout;
  }
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  console.log(`Base : ${base.variantLabel}, ${base.rooms.length} pièces, anomalies ${g.independentVerify(base).length}`);

  for (const { lock, originalRejected } of fx.cases) {
    const li = idx(base, lock[0], lock[1]);
    const L = g.lockRoom(base, li);
    const t0 = Date.now();
    const res = g.regenerateUnlocked(L);
    const ms = Date.now() - t0;
    const current = res.variants.filter((v) => v.variantLabel === "Disposition actuelle (inchangée)").length;
    const fresh = res.variants.length - current;
    const cat = { placement: 0, accesOuVerif: 0, fenetre: 0, autre: 0 };
    const leftoverCount = {};
    const verifMsgs = {};
    for (const f of res.failureReasons) {
      if (f.includes("n'a pas trouvé de place")) {
        cat.placement++;
        const m = f.match(/pour (.*?) — pas une impossibilité/);
        const key = m ? m[1] : "?";
        leftoverCount[key] = (leftoverCount[key] ?? 0) + 1;
      } else if (f.includes("candidat invalide")) {
        cat.accesOuVerif++;
        const m = f.split("candidat invalide — ")[1] ?? "";
        verifMsgs[m.slice(0, 120)] = (verifMsgs[m.slice(0, 120)] ?? 0) + 1;
      } else if (f.includes("ouverture extérieure réellement exposée")) cat.fenetre++;
      else cat.autre++;
    }
    const backtrack = res.searchStats.map((s) => ({
      complete: Number((s.match(/(\d+) disposition\(s\) complète/) || [0, 0])[1]),
      budget: s.includes("budget de recherche atteint"),
    }));
    const fixedAttempts = res.searchStats.length * 5;
    const fixedFailures = res.failureReasons.filter((f) => f.startsWith("Ordre ")).length;
    console.log(`\n=== Verrou ${lock[0]} ${lock[1]} (diagnostic initial : ${originalRejected} écartées) — ${ms} ms`);
    console.log(`  disposition actuelle admissible : ${current === 1 ? "oui" : "non"} ; propositions nouvelles : ${fresh}`);
    console.log(`  écartées (failureReasons) : ${res.failureReasons.length} = placement ${cat.placement}, contrôles (accès/vérif.) ${cat.accesOuVerif}, fenêtre ${cat.fenetre}, autre ${cat.autre}`);
    console.log(`  besoins non placés (par tentative) : ${JSON.stringify(leftoverCount)}`);
    if (Object.keys(verifMsgs).length) console.log(`  rejets de contrôle : ${JSON.stringify(verifMsgs)}`);
    console.log(`  essais à ordre fixe : ${fixedAttempts} (${res.searchStats.length} emprise×mode × 5 ordres), échoués ${fixedFailures}, donc admis puis absorbés comme doublons : ${fixedAttempts - fixedFailures}`);
    console.log(`  retour arrière : ${backtrack.length} recherches, dispositions complètes ${backtrack.reduce((s, b) => s + b.complete, 0)}, budget atteint ${backtrack.filter((b) => b.budget).length}/${backtrack.length}`);
    console.log(`  modes/emprises : ${res.searchStats.map((s) => s.split(" : ")[0].replace("Retour arrière, ", "")).join(" | ")}`);

  }

  // Preuve constructive à paramètres constants (cas Chambre 2) : le générateur
  // lui-même produit, avec la MÊME entrée, une disposition nouvelle qui garde
  // Chambre 2 à l'identique (position, dimensions, porte, fenêtre).
  const gen = g.generateVariants(fx.generationInput);
  const key = (L) => L.rooms.map((r) => `${r.type}@${r.x.toFixed(2)},${r.y.toFixed(2)},${r.w.toFixed(2)},${r.d.toFixed(2)}`).sort().join(";");
  const openings = (L, i) => JSON.stringify({ d: L.doors.filter((d) => d.roomIndex === i).map((d) => [d.wall, d.cx.toFixed(3), d.cy.toFixed(3), d.width.toFixed(3), d.to.kind]), w: L.windows.filter((w) => w.roomIndex === i).map((w) => [w.wall, w.cx.toFixed(3), w.cy.toFixed(3), w.width.toFixed(3)]) });
  for (const { lock } of fx.cases) {
    const bi = idx(base, lock[0], lock[1]);
    const br = base.rooms[bi];
    const proofs = gen.variants.filter((v) => {
      const vi = idx(v, lock[0], lock[1]);
      const vr = v.rooms[vi];
      return vi >= 0 && Math.abs(vr.x - br.x) < 1e-9 && Math.abs(vr.y - br.y) < 1e-9 && vr.w === br.w && vr.d === br.d && openings(v, vi) === openings(base, bi) && key(v) !== key(base) && !v.rejected && g.independentVerify(v).length === 0;
    });
    console.log(`
Preuve constructive, verrou ${lock[0]} ${lock[1]} : ${proofs.length ? proofs.map((v) => v.variantLabel).join(", ") + " — même entrée, pièce verrouillée identique (position, dimensions, ouvertures), disposition différente non réductible à une permutation, 0 anomalie" : "aucune variante du générateur ne la conserve à l'identique — non démontrée par ce moyen (limite de recherche, pas une impossibilité)"}`);
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
