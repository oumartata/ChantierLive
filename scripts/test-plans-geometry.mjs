// Test technique du moteur de plans prototype (src/app/prototype-plans/
// geometry.ts) : vérifie que l'accessibilité réelle (independentVerify,
// computeReachableRooms) n'accepte jamais un passage sur une simple
// proximité géométrique — seule une ouverture RÉELLEMENT modélisée (porte
// avec une largeur utilisable, ou l'entrée du bâti elle-même) compte.
//
// Fixture du défaut corrigé (signalé sur scenario2.projet.json, lot
// 68ae316) : un salon régénéré par regenerateUnlocked avait une porte
// propre (to.kind="circulation") dont le segment désigné avait été retiré
// par l'élagage, tandis qu'un AUTRE mur du salon touchait par coïncidence
// un couloir sans aucune baie à cet endroit — accepté à tort comme
// accessible (feasible=true, 0 erreur) avant ce correctif.
//
// Aucune dépendance supplémentaire : compile geometry.ts à la volée avec le
// compilateur TypeScript déjà présent dans ce projet (devDependency
// "typescript"), exactement comme `npm run typecheck`, puis exécute le
// module compilé directement en Node.
//
// Usage : node scripts/test-plans-geometry.mjs  (ou : npm run test:plans)

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const geometrySourceRelative = join("src", "app", "prototype-plans", "geometry.ts");

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const tmpDir = mkdtempSync(join(tmpdir(), "plans-geometry-test-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(
    `"${tscBin}" "${geometrySourceRelative}" --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`,
    { shell: true, encoding: "utf8", cwd: repoRoot }
  );
  if (compile.status !== 0) {
    console.error("Échec de la compilation de geometry.ts pour le test :");
    console.error(compile.stdout);
    console.error(compile.stderr);
    process.exitCode = 1;
  } else {
    const compiledPath = join(tmpDir, "geometry.js");
    const g = await import(pathToFileURL(compiledPath).href);

    function key(r) { return r.x.toFixed(2) + "," + r.y.toFixed(2) + "," + r.w.toFixed(2) + "," + r.d.toFixed(2); }
    function salonIndexOf(l) { return l.rooms.findIndex((r) => r.type === "salon"); }
    function isFullyAccessible(l) {
      const errors = g.independentVerify(l).filter((i) => i.severity === "error");
      const reach = g.computeReachableRooms(l);
      const allReachable = l.rooms.every((r, i) => r.parked || reach.has(i));
      return errors.length === 0 && allReachable;
    }

    // Fixture : un salon régénéré (18x28/15x24.5, Scénario 2 de la session de
    // correction) avec Chambre 1 verrouillée, obtenue via regenerateUnlocked
    // puis pruneUnneededCirculation. Figée ici en JSON (pas recalculée à
    // chaque exécution) : seule l'accessibilité est sous test, pas la
    // génération elle-même.
    const base = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-salon-regenerated.json"), "utf8"));
    const PASSAGE = { x: 8.2, y: 7.2, w: 4.5, d: 1.2 };
    const RACCORD = { x: 8, y: 7.2, w: 0.2, d: 1.2 };
    const removedKeys = new Set([key(PASSAGE), key(RACCORD)]);
    function withoutPassage() {
      const l = JSON.parse(JSON.stringify(base));
      l.circulations = l.circulations.filter((r) => !removedKeys.has(key(r)));
      return l;
    }

    // 1) Le fichier fautif (passage + raccord retirés) doit être signalé inaccessible.
    const faulty = withoutPassage();
    record("Salon régénéré sans son passage -> inaccessible", isFullyAccessible(faulty) === false);
    record(
      "Salon régénéré sans son passage -> erreur explicite sur le salon",
      g.independentVerify(faulty).some((i) => i.message.includes("Salon") && i.severity === "error")
    );

    // 2) Restaurer le passage ET son raccord doit rétablir l'accès complet.
    const restored = withoutPassage();
    restored.circulations.push(PASSAGE, RACCORD);
    record("Passage + raccord restaurés -> accès complet rétabli", isFullyAccessible(restored) === true);

    // 2bis) Restaurer SEULEMENT le passage (sans raccord) doit rester refusé.
    const partial = withoutPassage();
    partial.circulations.push(PASSAGE);
    record("Passage seul sans raccord -> toujours refusé (île non reliée)", isFullyAccessible(partial) === false);

    // 3) Proximité sans porte sur ce mur précis ne doit jamais suffire.
    const salonIdx = salonIndexOf(faulty);
    const salon = faulty.rooms[salonIdx];
    const corridor = faulty.corridor;
    const gapLeft = salon.x - (corridor.x + corridor.w);
    record(
      "Préalable du test : écart mur-gauche/corridor sous tolérance de mur",
      gapLeft > 0 && gapLeft < 0.4,
      `${gapLeft.toFixed(2)} m`
    );
    record("Proximité sans porte sur ce mur -> n'est jamais comptée comme un passage", isFullyAccessible(faulty) === false);

    // 4) Le salon central guidé (buildGuidedLayout) doit rester admissible :
    // il possède désormais lui aussi une vraie Door vers le corridor réel
    // (plus aucune exception de type nécessaire dans le graphe).
    const ref2Input = {
      terrainWidth: 15, terrainDepth: 20, accessSide: "front", orientation: "N",
      setbacks: { front: 3, back: 2, left: 2, right: 2 },
      entryMode: "direct", centralSalon: true, roomsConnectVia: "salon", sanitaireConnectVia: "corridor",
      needs: [
        { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
        { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
        { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
        { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
        { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
      ],
    };
    const ref2 = g.generateVariants(ref2Input);
    record("Salon central guidé (buildGuidedLayout) -> toujours admissible", ref2.variants.length > 0);
    if (ref2.variants.length > 0) {
      const ref2Layout = ref2.variants[0];
      const ref2SalonIdx = salonIndexOf(ref2Layout);
      record(
        "Salon central guidé -> possède une vraie Door vers la circulation",
        ref2Layout.doors.some((d) => d.roomIndex === ref2SalonIdx && d.to.kind === "circulation")
      );

      // 5) TEST NÉGATIF — déplacer l'entrée hors du salon doit invalider son accès.
      const movedEntry = JSON.parse(JSON.stringify(ref2Layout));
      movedEntry.entryDoor = { ...movedEntry.entryDoor, cx: movedEntry.entryDoor.cx + 3, cy: movedEntry.entryDoor.cy - 2 };
      record("Entrée déplacée hors du salon -> accès invalidé", isFullyAccessible(movedEntry) === false);
      record(
        "Entrée déplacée hors du salon -> erreur signalée",
        g.independentVerify(movedEntry).some((i) => i.severity === "error")
      );

      // 6) TEST NÉGATIF — supprimer l'ouverture salon->circulation doit couper
      // les pièces en aval sans autre chemin.
      const noSalonDoor = JSON.parse(JSON.stringify(ref2Layout));
      noSalonDoor.doors = noSalonDoor.doors.filter((d) => !(d.roomIndex === ref2SalonIdx && d.to.kind === "circulation"));
      const reachWithoutSalonDoor = g.computeReachableRooms(noSalonDoor);
      const downstreamRooms = noSalonDoor.rooms
        .map((r, i) => ({ r, i }))
        .filter(({ r, i }) => i !== ref2SalonIdx && !r.parked && r.type !== "salon");
      record(
        "Ouverture salon->circulation retirée -> pièces en aval sans autre chemin deviennent inaccessibles",
        downstreamRooms.length > 0 && downstreamRooms.some(({ i }) => !reachWithoutSalonDoor.has(i))
      );
    }

    // 7) RECHERCHE AVEC RETOUR ARRIÈRE — cas déterministe où le premier
    // placement (n'importe quel ordre fixe) bloque une pièce, mais où un
    // autre choix permet de compléter le plan. Emprise 14×10 m, un obstacle
    // (ex. pièce verrouillée) à x=[6,9] y=[0,4] découpe l'espace libre en 3
    // rectangles qui se chevauchent (gauche x=[0,6] profondeur pleine,
    // droite x=[9,14] profondeur pleine, bas x=[0,14] y=[4,10]) — le plus
    // grand par aire (le bas) est TOUJOURS traité en premier par l'algorithme
    // glouton à ordre fixe, et son remplissage (qui part toujours du bord
    // gauche) rogne le rectangle de gauche avant que "Grande" (qui a besoin
    // de sa pleine profondeur) n'ait sa chance. Les 5 ordres fixes échouent
    // tous pour cette seule et même raison structurelle (jamais un ordre des
    // besoins qui y changerait quoi que ce soit) ; le retour arrière, lui,
    // explore aussi le rectangle de GAUCHE en premier (voir
    // BACKTRACK_FR_BRANCHING) et trouve la disposition qui marche.
    function mkNeed(idx, label, w, d) { return { idx, label, type: label, width: w, depth: d, minW: w, minD: d }; }
    const btEmprise = { x: 0, y: 0, w: 14, d: 10 };
    const btObstacle = { x: 6, y: 0, w: 3, d: 4 };
    const btNeeds = [mkNeed(0, "Grande", 5.2, 5), mkNeed(1, "M1", 3.5, 2.2), mkNeed(2, "M2", 3.5, 2.2), mkNeed(3, "M3", 3.5, 2.2)];
    const byAreaDesc = (a, b) => b.width * b.depth - a.width * a.depth;
    const btOrders = {
      "aire décroissante": [...btNeeds].sort(byAreaDesc),
      "aire croissante": [...btNeeds].sort((a, b) => a.width * a.depth - b.width * b.depth),
      "largeur décroissante": [...btNeeds].sort((a, b) => b.width - a.width || byAreaDesc(a, b)),
      "profondeur décroissante": [...btNeeds].sort((a, b) => b.depth - a.depth || byAreaDesc(a, b)),
      "regroupé par type": [...btNeeds].sort((a, b) => a.type.localeCompare(b.type) || byAreaDesc(a, b)),
    };
    const fixedOrderResults = Object.entries(btOrders).map(([name, ordered]) => ({
      name,
      leftover: g.packNeedsIntoFreeSpace(btEmprise, [btObstacle], ordered).leftover,
    }));
    record(
      "Retour arrière — préalable : les 5 ordres fixes échouent tous (« Grande » bloquée)",
      fixedOrderResults.every((r) => r.leftover.some((n) => n.label === "Grande")),
      fixedOrderResults.map((r) => `${r.name}: ${r.leftover.map((n) => n.label).join(",") || "complet"}`).join(" | ")
    );
    const btOutcome = g.backtrackPackNeedsIntoFreeSpace(btEmprise, [btObstacle], btNeeds, 400, 150, 4);
    record(
      "Retour arrière — trouve une disposition complète là où tous les ordres fixes échouent",
      btOutcome.complete.length > 0,
      `${btOutcome.nodesExplored} noeud(s), ${btOutcome.deadEnds} impasse(s), ${btOutcome.elapsedMillis} ms, budget atteint: ${btOutcome.budgetHit}`
    );
    if (btOutcome.complete.length > 0) {
      const first = btOutcome.complete[0];
      const placedLabels = new Set(first.placements.map((p) => p.need.label));
      record("Retour arrière — la disposition complète place bien les 4 besoins", ["Grande", "M1", "M2", "M3"].every((l) => placedLabels.has(l)));
      // Contrôles géométriques habituels sur le résultat du retour arrière :
      // aucun chevauchement entre les pièces posées et le corridor de leur
      // propre groupe (même exigence que packNeedsIntoFreeSpace).
      const allRects = [...first.placements.map((p) => ({ x: p.x, y: p.y, w: p.w, d: p.d })), ...first.corridors];
      let overlapFound = false;
      for (let i = 0; i < allRects.length && !overlapFound; i++) {
        for (let j = i + 1; j < allRects.length; j++) {
          const a = allRects[i], b = allRects[j];
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
          if (overlapX > 1e-6 && overlapY > 1e-6) { overlapFound = true; break; }
        }
      }
      record("Retour arrière — aucun chevauchement entre pièces/corridors du résultat", !overlapFound);
    }

    // 8) COMPACITÉ — la fixture ci-dessus (plans-salon-regenerated.json) EST
    // elle-même la disposition "historique" étalée du lot précédent :
    // contour bâti 10.9×19.5 m = 212.5 m² pour seulement 51.1 m² de pièces
    // (chambre verrouillée comprise), déjà vérifiée admissible par
    // ailleurs (contrôles 1-7 ci-dessus). Elle sert ici de point de départ
    // CONNU pour prouver que le moteur RÉEL (jamais une réponse codée en
    // dur) peut reconstruire une disposition plus compacte qui quitte ce
    // contour historique, tout en respectant le même terrain, programme,
    // dimensions et le même verrou (position, dimensions, ouvertures).
    const spreadFootprintArea = base.footprint.w * base.footprint.d;
    const compactRegen = g.regenerateUnlocked(base);
    record("Compacité — au moins une disposition admissible retrouvée depuis la fixture étalée", compactRegen.variants.length > 0);
    if (compactRegen.variants.length > 0) {
      const best = compactRegen.variants[0];
      const bestFootprintArea = best.footprint.w * best.footprint.d;
      // Seuil large (60 % du contour historique) : prouve une compacité
      // réelle sans exiger LE résultat exact d'une exécution précédente,
      // qui peut varier avec le budget de recherche ou l'ordre interne.
      record(
        "Compacité — le contour bâti retrouvé est réellement plus compact que le contour historique",
        bestFootprintArea < spreadFootprintArea * 0.6,
        `historique ${spreadFootprintArea.toFixed(1)} m² -> retrouvé ${bestFootprintArea.toFixed(1)} m²`
      );
      const lockedIdx = base.rooms.findIndex((r) => r.locked);
      const lockedBefore = base.rooms[lockedIdx];
      const lockedAfter = best.rooms[lockedIdx];
      record(
        "Compacité — la pièce verrouillée garde exactement sa position et ses dimensions",
        lockedBefore.x === lockedAfter.x && lockedBefore.y === lockedAfter.y && lockedBefore.w === lockedAfter.w && lockedBefore.d === lockedAfter.d
      );
      record("Compacité — la disposition retrouvée reste admissible (0 erreur)", g.independentVerify(best).filter((i) => i.severity === "error").length === 0);
    }

    const total = results.length;
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${total} tests réussis.`);
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
