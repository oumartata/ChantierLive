// Présentation des propositions de régénération (lot « comparer et
// choisir », 2026-10-05) — src/app/prototype-plans/regenerationView.ts.
// Vérifie que la vue ne fait que RÉORDONNER des références et relire des
// grandeurs existantes : nombre et données des résultats du moteur
// inchangés, disposition actuelle séparée, numérotation continue et
// stable, identité = indice moteur, ordre = classement selon les surfaces
// (critères du moteur, premier critère = circulation intérieure +
// cheminement extérieur ; compareLayoutQuality du moteur non modifié).
//
// Usage : node scripts/test-plans-regeneration-view.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const tmpDir = mkdtempSync(join(tmpdir(), "plans-regen-view-test-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const sources = ["geometry.ts", "regenerationView.ts"].map((f) => `"${join("src", "app", "prototype-plans", f)}"`).join(" ");
  const compile = spawnSync(`"${tscBin}" ${sources} --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`, {
    shell: true,
    encoding: "utf8",
    cwd: repoRoot,
  });
  if (compile.status !== 0) {
    console.error(compile.stdout, compile.stderr);
    process.exitCode = 1;
  } else {
    const g = await import(pathToFileURL(join(tmpDir, "geometry.js")).href);
    const v = await import(pathToFileURL(join(tmpDir, "regenerationView.js")).href);

    const NEEDS = [
      { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
      { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
      { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
      { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
      { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
    ];
    const BASE = { orientation: "N", setbacks: { front: 3, back: 2, left: 2, right: 2 }, entryMode: "direct", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", needs: NEEDS };
    const lockedCase = (side, W, D, label, number) => {
      const L = g.generateVariants({ ...BASE, accessSide: side, terrainWidth: W, terrainDepth: D }).variants[0];
      return g.lockRoom(L, L.rooms.findIndex((r) => r.label === label && r.number === number));
    };
    const b3 = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-b3-regeneration-reproduction.json"), "utf8"));
    const b3Locked = (label, number) => g.lockRoom(b3.layout, b3.layout.rooms.findIndex((r) => r.label === label && r.number === number));

    // Vérifications communes à chaque cas.
    function checkCase(name, base) {
      const result = g.regenerateUnlocked(base);
      const before = JSON.stringify(result);
      const view = v.buildRegenerationView(base, result);
      const again = v.buildRegenerationView(base, result);
      const nonCurrent = result.variants.map((x, i) => i).filter((i) => result.variants[i].variantLabel !== v.CURRENT_VARIANT_LABEL);
      record(`${name} : résultats du moteur inchangés (nombre et données) après construction de la vue`, JSON.stringify(result) === before, `${result.variants.length} résultat(s)`);
      record(
        `${name} : chaque proposition nouvelle présente une fois, la disposition actuelle à part`,
        view.proposals.length === nonCurrent.length &&
          new Set(view.proposals.map((p) => p.engineIndex)).size === nonCurrent.length &&
          view.proposals.every((p) => nonCurrent.includes(p.engineIndex)),
        `${view.proposals.length} nouvelle(s), actuelle ${view.currentEngineIndex === null ? "non retrouvée" : `= résultat #${view.currentEngineIndex}`}`
      );
      record(
        `${name} : numérotation continue 1..N et stable (même résultat → mêmes numéros)`,
        view.proposals.every((p, k) => p.displayNumber === k + 1) && JSON.stringify(again.proposals.map((p) => [p.engineIndex, p.displayNumber])) === JSON.stringify(view.proposals.map((p) => [p.engineIndex, p.displayNumber]))
      );
      const ordered = view.proposals.every((p, k) => {
        if (k === 0) return true;
        const prev = view.proposals[k - 1];
        const c = v.compareBySurfaces(result.variants[prev.engineIndex], result.variants[p.engineIndex]);
        return c < -1e-12 || (Math.abs(c) <= 1e-12 && prev.engineIndex < p.engineIndex);
      });
      record(`${name} : ordre par défaut = classement selon les surfaces (tri stable, égalité → ordre du moteur)`, ordered);
      record(
        `${name} : chaque carte désigne le bon candidat (indicateurs recalculés depuis result.variants[engineIndex] identiques)`,
        view.proposals.every((p) => JSON.stringify(v.metricsOf(result.variants[p.engineIndex], base)) === JSON.stringify(p.metrics))
      );
      const pages = [];
      for (let shown = v.REGEN_PAGE_SIZE; shown < view.proposals.length + v.REGEN_PAGE_SIZE; shown += v.REGEN_PAGE_SIZE) pages.push(view.proposals.slice(0, shown));
      record(
        `${name} : « Afficher davantage » ne fait qu'étendre la liste (numéros et candidats des cartes déjà visibles inchangés, toutes atteintes)`,
        pages.every((pg, k) => k === 0 || pg.slice(0, pages[k - 1].length).every((p, i) => p === pages[k - 1][i])) && (pages.at(-1)?.length ?? 0) === view.proposals.length
      );
      const metricsOk = [view.current, ...view.proposals.map((p) => p.metrics)].every(
        (m) => Math.abs(m.total - (m.circulation + m.cheminementExterieur)) < 1e-9 && m.footprint && Math.abs(m.footprint.area - m.footprint.w * m.footprint.d) < 1e-9
      );
      record(`${name} : indicateurs relus tels quels (total = circulation intérieure + cheminement extérieur ; contour = largeur × profondeur)`, metricsOk);
      record(`${name} : contrôles et verrous de chaque proposition (0 erreur, verrous conservés)`, view.proposals.every((p) => p.metrics.errors === 0 && p.metrics.locksPreserved && p.metrics.lockedCount === 1));
      const tradeoffOk = view.proposals.every(
        (p) => p.exteriorTradeoff === (p.metrics.circulation < view.current.circulation - 0.05 && p.metrics.cheminementExterieur > view.current.cheminementExterieur + 0.05)
      );
      record(`${name} : signalement « moins de circulation intérieure mais plus de cheminement extérieur » cohérent`, tradeoffOk, `${view.proposals.filter((p) => p.exteriorTradeoff).length} signalée(s)`);
      return { result, view };
    }

    // 1) Aucune nouvelle proposition.
    {
      const { result, view } = checkCase("Accès gauche 15×20, Chambre 1 verrouillée", lockedCase("left", 15, 20, "Chambre", 1));
      record("Zéro nouveauté : aucune proposition, la disposition actuelle reste admissible", view.proposals.length === 0 && view.currentEngineIndex !== null && result.variants.length === 1);
    }
    // 2) Salon 1 (fixture B3) : 2 propositions, cheminement extérieur plus long.
    {
      const salonBase = b3Locked("Salon", 1);
      const { result: salonRes, view } = checkCase("Fixture B3 Salon 1", salonBase);
      const cur = salonRes.variants[view.currentEngineIndex];
      record(
        "Salon 1 : le moteur classe les 2 propositions AVANT l'actuelle (circulation intérieure seule), le classement selon les surfaces les placerait APRÈS (total) — compareLayoutQuality n'est pas modifié",
        view.currentEngineIndex === 2 && view.proposals.every((p) => v.compareBySurfaces(salonRes.variants[p.engineIndex], cur) > 0)
      );
      record(
        "Salon 1 : 2 propositions, toutes deux signalées (circulation intérieure plus faible, cheminement extérieur plus long, total plus élevé : 29,98 contre 29,74 m²)",
        view.proposals.length === 2 && view.proposals.every((p) => p.exteriorTradeoff && p.metrics.total > view.current.total) &&
          Math.abs(view.current.total - 29.74) < 0.005 && view.proposals.every((p) => Math.abs(p.metrics.total - 29.98) < 0.005 && Math.abs(p.metrics.cheminementExterieur - 4.56) < 0.005),
        view.proposals.map((p) => `${p.metrics.circulation.toFixed(2)} + ${p.metrics.cheminementExterieur.toFixed(2)} = ${p.metrics.total.toFixed(2)}`).join(" ; ") + ` (actuelle ${view.current.total.toFixed(2)})`
      );
    }
    // 3) Chambre 2 (fixture B3) : 1 proposition.
    {
      const { view } = checkCase("Fixture B3 Chambre 2", b3Locked("Chambre", 2));
      record("Chambre 2 : 1 proposition", view.proposals.length === 1);
    }
    // 4) Beaucoup de propositions, accès latéral (résultats du repère
    //    transposé ajoutés en fin de liste par le moteur).
    {
      const { result, view } = checkCase("Accès gauche 15×25, Chambre 3 verrouillée", lockedCase("left", 15, 25, "Chambre", 3));
      record("Beaucoup de propositions : toutes présentées (aucune limite), pages de " + v.REGEN_PAGE_SIZE, view.proposals.length === result.variants.length - (view.currentEngineIndex === null ? 0 : 1) && view.proposals.length > v.REGEN_PAGE_SIZE, `${view.proposals.length} proposition(s), ${Math.ceil(view.proposals.length / v.REGEN_PAGE_SIZE)} page(s)`);
      const engineNew = result.variants.map((x, i) => i).filter((i) => result.variants[i].variantLabel !== v.CURRENT_VARIANT_LABEL);
      record(
        "Accès latéral : classement appliqué après réception de tous les résultats (repère transposé compris) — l'ordre de la vue diffère de l'ordre brut",
        JSON.stringify(view.proposals.map((p) => p.engineIndex)) !== JSON.stringify(engineNew) && JSON.stringify([...view.proposals.map((p) => p.engineIndex)].sort((a, b) => a - b)) === JSON.stringify(engineNew)
      );
    }
    // 5) Accès avant : l'ordre de la vue est exactement celui du moteur.
    {
      const { result, view } = checkCase("Accès avant 15×25, Chambre 2 verrouillée", lockedCase("front", 15, 25, "Chambre", 2));
      const engineNew = result.variants.map((x, i) => i).filter((i) => result.variants[i].variantLabel !== v.CURRENT_VARIANT_LABEL);
      record("Accès avant : mêmes candidats que le moteur, seul l'ordre de présentation peut changer", JSON.stringify([...view.proposals.map((p) => p.engineIndex)].sort((a, b) => a - b)) === JSON.stringify(engineNew));
    }
    record("Écart négligeable non affiché (même seuil que le classement)", v.deltaOf(10.02, 10) === null && v.deltaOf(10.2, 10) !== null);

    const total = results.length;
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${total} tests réussis.`);
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
