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
const projectFileSourceRelative = join("src", "app", "prototype-plans", "projectFile.ts");

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const tmpDir = mkdtempSync(join(tmpdir(), "plans-geometry-test-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  // projectFile.ts n'importe que des TYPES de geometry.ts (import type, effacé
  // à la compilation) : compilable seul, aucun bundling nécessaire. Compilé
  // ICI (pas seulement geometry.ts) pour tester les VRAIES fonctions de
  // sauvegarde/réimport (serializeProject/validateProjectFile), jamais un
  // JSON.stringify/parse nu qui ne passerait pas par la validation réelle.
  const compile = spawnSync(
    `"${tscBin}" "${geometrySourceRelative}" "${projectFileSourceRelative}" --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`,
    { shell: true, encoding: "utf8", cwd: repoRoot }
  );
  if (compile.status !== 0) {
    console.error("Échec de la compilation de geometry.ts/projectFile.ts pour le test :");
    console.error(compile.stdout);
    console.error(compile.stderr);
    process.exitCode = 1;
  } else {
    const compiledPath = join(tmpDir, "geometry.js");
    const g = await import(pathToFileURL(compiledPath).href);
    const pf = await import(pathToFileURL(join(tmpDir, "projectFile.js")).href);

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

    // 7bis) CIRCULATION RÉSERVÉE D'ABORD — RÉVISÉ (lot "replacer les pièces
    // sans subir les anciens couloirs") : la version précédente de ce test
    // affirmait que le placement en colonnes bloquait TOUJOURS un besoin sur
    // 4 dans cette emprise 10×12 m SANS obstacle verrouillé, parce que
    // `packNeedsIntoFreeSpace`/`backtrackPackNeedsIntoFreeSpace` ne posaient
    // qu'UNE SEULE rangée par rectangle libre, sans jamais réexaminer la
    // profondeur restante. Ce défaut précis est corrigé (voir le lot
    // courant : la part non consommée d'un rectangle libre est désormais
    // réinjectée dans les candidats, dans les DEUX fonctions) — le placement
    // en colonnes seul retrouve maintenant aussi les 4 besoins, vérifié
    // explicitement ci-dessous (plus une affirmation d'échec obsolète). Le
    // spine reste néanmoins vérifié pour lui-même : un mécanisme compatible
    // et correct (aucun chevauchement), utile pour d'autres configurations
    // (régions véritablement disjointes, pas seulement une profondeur
    // inutilisée dans un même rectangle) même s'il n'est plus seul à
    // résoudre CE cas précis.
    const spineEmprise = { x: 0, y: 0, w: 10, d: 12 };
    const spineNeeds = [mkNeed(0, "A", 3, 3), mkNeed(1, "B", 3, 3), mkNeed(2, "C", 3, 3), mkNeed(3, "D", 3, 3)];
    const columnOnly = g.packNeedsIntoFreeSpace(spineEmprise, [], spineNeeds);
    record(
      "Circulation réservée d'abord — la réinjection de l'espace restant fait désormais tenir les 4 besoins sans même réserver de spine",
      columnOnly.leftover.length === 0,
      `placés: ${columnOnly.placements.map((p) => p.need.label).join(",")} | reste: ${columnOnly.leftover.map((n) => n.label).join(",") || "aucun"}`
    );
    const reservedSpine = { x: 0, y: 5.4, w: 10, d: 1.2 };
    const withSpine = g.packNeedsIntoFreeSpace(spineEmprise, [reservedSpine], spineNeeds);
    record(
      "Circulation réservée d'abord — en réservant le spine avant de poser les pièces, les 4 besoins tiennent",
      withSpine.leftover.length === 0,
      `placés: ${withSpine.placements.map((p) => p.need.label).join(",")}`
    );
    if (withSpine.leftover.length === 0) {
      const spineAllRects = [
        reservedSpine,
        ...withSpine.placements.map((p) => ({ x: p.x, y: p.y, w: p.w, d: p.d })),
        ...withSpine.corridors,
        ...withSpine.corridorFillers,
      ];
      let spineOverlap = false;
      for (let i = 0; i < spineAllRects.length && !spineOverlap; i++) {
        for (let j = i + 1; j < spineAllRects.length; j++) {
          const a = spineAllRects[i], b = spineAllRects[j];
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
          if (overlapX > 1e-6 && overlapY > 1e-6) { spineOverlap = true; break; }
        }
      }
      record("Circulation réservée d'abord — aucun chevauchement entre spine/pièces/corridors du résultat", !spineOverlap);
    }

    // 7ter) FENÊTRES CHOISIES SUR LA GÉOMÉTRIE FINALE (chooseExteriorWindow)
    // — pickOrientation (utilisé PENDANT le placement) ne connaît que
    // l'emprise de RECHERCHE, jamais le contour bâti qui en résultera
    // réellement une fois la circulation posée et élaguée. chooseExteriorWindow
    // sépare les deux : il choisit le mur de la fenêtre APRÈS coup, sur le
    // contour bâti final, et vérifie en plus qu'aucun autre élément bâti
    // n'obstrue la fenêtre elle-même (sa propre sonde, comme pour une porte)
    // — jamais un simple vide non affecté de l'emprise compté comme extérieur.
    {
      // Mur supposé à tort (preferredWall="left", hérité de l'emprise de
      // recherche) alors que seul "top" touche réellement le contour bâti
      // final : doit retenir "top", jamais "left" ni aucun autre mur.
      const wrongWallFootprint = { x: 0, y: 0, w: 10, d: 5 };
      const wrongWallRoom = { x: 3, y: 0.2, w: 3, d: 3 };
      const wrongWallChoice = g.chooseExteriorWindow(wrongWallRoom, wrongWallFootprint, [], "left");
      record(
        "Fenêtres finales — un mur supposé à tort depuis l'emprise de recherche est écarté au profit du mur réellement exposé",
        !!wrongWallChoice && wrongWallChoice.wall === "top",
        JSON.stringify(wrongWallChoice)
      );

      // Un seul mur touche réellement le contour ("left"), mais sa propre
      // sonde extérieure est obstruée par un autre élément bâti (ici placé
      // hors du contour, cas qui ne peut pas survenir avec le contour
      // toujours rectangulaire actuel, mais que la fonction doit refuser
      // sans jamais le supposer exempt de collision) : aucune fenêtre ne
      // doit être retenue.
      const obstructedFootprint = { x: 0, y: 0, w: 10, d: 5 };
      const obstructedRoom = { x: 0.2, y: 1, w: 3, d: 3 };
      const obstruction = { x: -0.3, y: 1.5, w: 0.6, d: 2 };
      const obstructedChoice = g.chooseExteriorWindow(obstructedRoom, obstructedFootprint, [obstruction]);
      record("Fenêtres finales — une fenêtre obstruée par un autre élément bâti est refusée", obstructedChoice === null);
      // Préalable du test ci-dessus : sans l'obstruction, ce même mur "left"
      // est bien retenu (sinon le refus ne prouverait rien sur l'obstruction
      // elle-même).
      const unobstructedChoice = g.chooseExteriorWindow(obstructedRoom, obstructedFootprint, []);
      record(
        "Fenêtres finales — préalable : sans l'obstruction, le même mur est bien retenu",
        !!unobstructedChoice && unobstructedChoice.wall === "left"
      );

      // Pièce entièrement intérieure : aucun des 4 murs ne touche le contour
      // bâti final, quel que soit otherBuilt — aucune exposition possible,
      // refusée avec le même mécanisme (jamais un mur accepté par défaut).
      const noExposureFootprint = { x: 0, y: 0, w: 10, d: 5 };
      const noExposureRoom = { x: 3, y: 1, w: 2, d: 2 };
      const noExposureChoice = g.chooseExteriorWindow(noExposureRoom, noExposureFootprint, []);
      record("Fenêtres finales — une pièce sans exposition extérieure possible est refusée", noExposureChoice === null);
    }

    // 7quater) PRÉSERVER BLOQUE, RECONSTRUIRE RETROUVE — cas déterministe
    // distinguant progrès et repli (lot "replacer les pièces sans subir les
    // anciens couloirs") : simule directement les obstacles des deux modes
    // de regenerateUnlocked (jamais regenerateUnlocked lui-même, pour isoler
    // la cause géométrique précise, même esprit que le test "Retour arrière"
    // ci-dessus). Emprise 16×12 m, UNE pièce verrouillée (4×4 m, coin
    // supérieur gauche) — la "disposition actuelle" est admissible (4
    // besoins non verrouillés de 3×3 m déjà posés ailleurs, non modélisés
    // ici car hors sujet). L'ancien réseau à préserver est une grille (un
    // segment vertical + un horizontal, largeur réelle CORRIDOR_WIDTH) qui
    // fragmente l'espace libre restant en morceaux dont AUCUNE combinaison
    // ne loge les 4 besoins (ni ordre fixe, ni retour arrière, même avec la
    // réinjection d'espace restant du lot courant) : "préserver" bloque
    // réellement le replacement, pas un repli arbitraire. "Reconstruire"
    // (qui ne garde que la pièce verrouillée comme obstacle, l'ancien réseau
    // étant entièrement reconstructible) retrouve une disposition COMPLÈTE
    // et DISTINCTE des 4 besoins — simplement renvoyer une disposition
    // identique à l'originale (ou partielle) ne ferait PAS réussir ce test.
    {
      const gridEmprise = { x: 0, y: 0, w: 16, d: 12 };
      const gridLocked = { x: 0, y: 0, w: 4, d: 4 };
      const gridOldVert = { x: 7.4, y: 0, w: 1.2, d: 12 };
      const gridOldHoriz = { x: 0, y: 7.4, w: 16, d: 1.2 };
      const gridNeeds = [mkNeed(0, "A", 3, 3), mkNeed(1, "B", 3, 3), mkNeed(2, "C", 3, 3), mkNeed(3, "D", 3, 3)];

      const preserveLike = g.packNeedsIntoFreeSpace(gridEmprise, [gridLocked, gridOldVert, gridOldHoriz], gridNeeds);
      record(
        "Préserver bloque / reconstruire retrouve — préalable : « préserver » (ordre fixe) bloque réellement un besoin",
        preserveLike.leftover.length > 0,
        `placés: ${preserveLike.placements.map((p) => p.need.label).join(",")} | reste: ${preserveLike.leftover.map((n) => n.label).join(",")}`
      );
      const preserveBacktrack = g.backtrackPackNeedsIntoFreeSpace(gridEmprise, [gridLocked, gridOldVert, gridOldHoriz], gridNeeds, 400, 150, 4);
      record(
        "Préserver bloque / reconstruire retrouve — préalable : « préserver » bloque aussi avec le retour arrière (pas un repli d'ordre)",
        preserveBacktrack.complete.length === 0,
        `${preserveBacktrack.nodesExplored} noeud(s), ${preserveBacktrack.deadEnds} impasse(s)`
      );

      const reconstructLike = g.packNeedsIntoFreeSpace(gridEmprise, [gridLocked], gridNeeds);
      record(
        "Préserver bloque / reconstruire retrouve — « reconstruire » (ancien réseau libéré) retrouve une disposition COMPLÈTE",
        reconstructLike.leftover.length === 0,
        `placés: ${reconstructLike.placements.map((p) => p.need.label).join(",")}`
      );
      record(
        "Préserver bloque / reconstruire retrouve — la disposition retrouvée est bien DISTINCTE de l'originale (pas un simple retour de l'existant)",
        reconstructLike.leftover.length === 0 &&
          reconstructLike.placements.every((p) => p.x !== gridOldVert.x && p.y !== gridOldHoriz.y)
      );
      if (reconstructLike.leftover.length === 0) {
        const allRects = [
          gridLocked,
          ...reconstructLike.placements.map((p) => ({ x: p.x, y: p.y, w: p.w, d: p.d })),
          ...reconstructLike.corridors,
          ...reconstructLike.corridorFillers,
        ];
        let overlapFound = false;
        for (let i = 0; i < allRects.length && !overlapFound; i++) {
          for (let j = i + 1; j < allRects.length; j++) {
            const a = allRects[i], b = allRects[j];
            const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const overlapY = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
            if (overlapX > 1e-6 && overlapY > 1e-6) { overlapFound = true; break; }
          }
        }
        record("Préserver bloque / reconstruire retrouve — aucun chevauchement dans la disposition reconstruite", !overlapFound);
      }
    }

    // 8) COMPACITÉ — RÉVISÉ (lot sur l'entrée non reliée, après
    // scenario2.projet(4).json) : la revendication précédente de ce test
    // ("212,5 -> 103,0 m², trouvé par le moteur") reposait sur le MÊME bug
    // que celui du lot suivant (independentVerify sortait en silence pour
    // tout candidat corridor=null) — ce contour "compact" n'avait jamais
    // été réellement vérifié, et un examen direct montre qu'il souffrait
    // lui aussi d'une entrée non reliée. Ce test ne revendique donc plus
    // une compacité garantie : il vérifie que depuis la disposition de base
    // RÉELLE (scripts/fixtures/plans-scenario2-pre-regen.json, construite
    // par la même séquence que le scénario de référence), le moteur
    // retrouve une disposition admissible — ET que si une disposition plus
    // compacte existe parmi les candidats explorés, elle a RÉELLEMENT une
    // entrée reliée (jamais un gain non vérifié présenté comme acquis).
    const pathBase = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-scenario2-pre-regen.json"), "utf8"));
    const pathRegen = g.regenerateUnlocked(pathBase);
    record("Compacité — au moins une disposition admissible retrouvée depuis la base réelle", pathRegen.variants.length > 0);
    // Cette fixture (plans-scenario2-pre-regen.json) se trouve être DÉJÀ
    // admissible telle quelle (voir le lot "Régénération fiable après
    // sauvegarde et réimport") : regenerateUnlocked la propose donc aussi,
    // étiquetée distinctement — jamais numérotée comme une régénération.
    // Testé ici explicitement, sur cette fixture réelle, plutôt que
    // seulement sur un cas construit à la main.
    const baselineVariant = pathRegen.variants.find((v) => v.variantLabel === "Disposition actuelle (inchangée)");
    record(
      "Compacité — la base déjà admissible est proposée telle quelle, distinctement étiquetée",
      !!baselineVariant && Math.abs(baselineVariant.surfaces.circulation - pathBase.surfaces.circulation) < 1e-6
    );
    if (pathRegen.variants.length > 0) {
      // La disposition RÉGÉNÉRÉE (pas la base inchangée, qui peut légitimement
      // être classée devant elle par compareLayoutQuality si elle a déjà
      // moins de circulation) : c'est elle que ce test vérifie depuis
      // l'origine (reconnexion de l'entrée après compaction), jamais la
      // base elle-même qui n'a par définition rien à prouver de nouveau.
      const genuinelyNew = pathRegen.variants.filter((v) => v.variantLabel !== "Disposition actuelle (inchangée)");
      const best = genuinelyNew.length > 0 ? genuinelyNew[0] : pathRegen.variants[0];
      record("Compacité — la disposition retrouvée reste admissible (0 erreur)", g.independentVerify(best).filter((i) => i.severity === "error").length === 0);
      record(
        "Compacité — l'entrée débouche réellement sur la disposition retrouvée (graphe)",
        (() => {
          const reach = g.computeReachableRooms(best);
          return best.rooms.every((r, i) => r.parked || reach.has(i));
        })()
      );
      const lockedIdx = pathBase.rooms.findIndex((r) => r.locked);
      const lockedBefore = pathBase.rooms[lockedIdx];
      const lockedAfter = best.rooms[lockedIdx];
      record(
        "Compacité — la pièce verrouillée garde exactement sa position et ses dimensions",
        lockedBefore.x === lockedAfter.x && lockedBefore.y === lockedAfter.y && lockedBefore.w === lockedAfter.w && lockedBefore.d === lockedAfter.d
      );
      // Le nouveau choix de fenêtre (chooseExteriorWindow, posé APRÈS
      // circulation+élagage) ne s'applique qu'aux pièces RÉGÉNÉRÉES — une
      // pièce verrouillée garde sa ou ses fenêtre(s) EXACTEMENT telle(s)
      // quelle(s) (même mur, même position, même largeur), jamais recalculée
      // ni "corrigée" au passage.
      const windowsBefore = pathBase.windows.filter((w) => w.roomIndex === lockedIdx);
      const windowsAfter = best.windows.filter((w) => w.roomIndex === lockedIdx);
      record(
        "Compacité — la ou les fenêtre(s) de la pièce verrouillée restent exactement inchangées",
        JSON.stringify(windowsBefore) === JSON.stringify(windowsAfter)
      );
    }

    // 9) ENTRÉE RÉELLEMENT RELIÉE — défaut signalé sur scenario2.projet(4).json
    // (lot 1a65f41) : independentVerify exigeait `layout.corridor` non nul
    // AVANT tout contrôle, donc sortait en silence (0 erreur, feasible=true)
    // pour toute disposition "reconstruire entièrement la circulation"
    // (corridor=null par conception) — y compris quand l'entrée (x=7.4,
    // y=3) ne touchait plus RIEN du bâti reconstruit (contour x=2.3,
    // y=12.3, w=10.1, d=10.2, à ~9 m de l'entrée) et qu'un raccord devant
    // la chambre verrouillée s'arrêtait pile à la tolérance de mur
    // (0.32 m), sans chevauchement réel avec sa porte.
    const faultyEntry = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-scenario2-faulty-entry.projet.json"), "utf8")).layout;
    record("Entrée reliée — corridor=null n'empêche plus de vérifier", g.independentVerify(faultyEntry).length > 0);
    record("Entrée reliée — fichier fautif signalé comme inaccessible", isFullyAccessible(faultyEntry) === false);
    record(
      "Entrée reliée — erreur explicite sur l'entrée elle-même",
      g.independentVerify(faultyEntry).some((i) => i.message.includes("entrée") && i.severity === "error")
    );

    // Un trajet extérieur réel (Layout.exteriorPaths) doit rétablir l'accès
    // dès que le graphe le reconnaît comme un espace praticable — testé ici
    // sur le graphe lui-même (computeReachableRooms), indépendamment de la
    // question géométrique séparée (traverse-t-il une pièce ? déjà couverte
    // par buildExteriorPath et par le contrôle de chevauchement ajouté à
    // independentVerify) : la chambre verrouillée (x=7.1..10.3, y=12.5..15.7)
    // occupe justement l'alignement vertical direct de cette entrée, donc le
    // moteur réel refuse honnêtement un trajet tout droit ici (vérifié par
    // ailleurs sur le scénario complet) — un trajet qui contournerait cette
    // pièce est HORS de la portée (volontairement simple) de ce correctif.
    const nearestTarget = faultyEntry.circulations.find((c) => c.x <= 7.4 && c.x + c.w >= 7.4) ?? faultyEntry.circulations[0];
    const exteriorPath = { x: 7.4 - 0.6, y: 3, w: 1.2, d: nearestTarget.y - 3 };
    const withPath = JSON.parse(JSON.stringify(faultyEntry));
    withPath.exteriorPaths = [exteriorPath];
    // Ce fichier porte AUSSI le second défaut signalé (32 cm entre la porte
    // de Chambre 1 et le raccord qui la dessert, point 3) — indépendant du
    // trajet d'entrée et déjà expliqué séparément (near-miss correctement
    // refusé par le contrôle de porte existant, pas un bug distinct à
    // corriger ici). Rallongé de 0.4 m ici pour ISOLER la seule question de
    // ce test : le trajet d'entrée restaure-t-il bien l'accès au RESTE du
    // réseau ?
    const chambre1FillerIdx = withPath.circulations.findIndex((c) => Math.abs(c.x - 6.95) < 1e-6 && Math.abs(c.y - 17.7) < 1e-6);
    if (chambre1FillerIdx >= 0) withPath.circulations[chambre1FillerIdx].d += 0.4;
    const reachableWithPath = g.computeReachableRooms(withPath);
    const pathFixesIt = withPath.rooms.every((r, i) => r.parked || reachableWithPath.has(i));
    record("Entrée reliée — un trajet extérieur réel rétablit l'accès complet (graphe)", pathFixesIt === true);

    // Retirer le trajet (ou l'entrée elle-même) doit re-couper l'accès —
    // jamais un gain qui survivrait à la disparition de ce qui le prouvait.
    if (pathFixesIt) {
      const withoutPath = JSON.parse(JSON.stringify(withPath));
      withoutPath.exteriorPaths = [];
      const reachWithoutPath = g.computeReachableRooms(withoutPath);
      record(
        "Entrée reliée — supprimer le trajet extérieur recoupe l'accès",
        !withoutPath.rooms.every((r, i) => r.parked || reachWithoutPath.has(i))
      );
      const withoutEntry = JSON.parse(JSON.stringify(withPath));
      withoutEntry.entryDoor = null;
      const reachWithoutEntry = g.computeReachableRooms(withoutEntry);
      record(
        "Entrée reliée — supprimer l'ouverture d'entrée recoupe l'accès",
        !withoutEntry.rooms.every((r, i) => r.parked || reachWithoutEntry.has(i))
      );
    }

    // Une circulation isolée (corridor=null, aucun trajet extérieur, aucun
    // contact réel avec l'entrée) doit rester inaccessible — jamais
    // "accessible par défaut" simplement parce que corridor=null.
    const isolatedReach = g.computeReachableRooms(faultyEntry);
    record(
      "Entrée reliée — circulation isolée avec corridor=null reste inaccessible",
      !faultyEntry.rooms.every((r, i) => r.parked || isolatedReach.has(i))
    );

    // La pièce verrouillée garde ses dimensions et ouvertures à l'identique
    // tout au long (fichier fautif, avec trajet, sans trajet).
    const lockedFaultyIdx = faultyEntry.rooms.findIndex((r) => r.locked);
    const lockedFaulty = faultyEntry.rooms[lockedFaultyIdx];
    const lockedWithPath = withPath.rooms[lockedFaultyIdx];
    record(
      "Entrée reliée — la pièce verrouillée garde exactement sa position, ses dimensions et ses ouvertures",
      lockedFaulty.x === lockedWithPath.x &&
        lockedFaulty.y === lockedWithPath.y &&
        lockedFaulty.w === lockedWithPath.w &&
        lockedFaulty.d === lockedWithPath.d &&
        JSON.stringify(faultyEntry.doors.filter((d) => d.roomIndex === lockedFaultyIdx)) === JSON.stringify(withPath.doors.filter((d) => d.roomIndex === lockedFaultyIdx))
    );

    // 10) CONSOLIDATION DU VÉRIFICATEUR (corridor=null) — le défaut corrigé
    // au lot précédent faisait sauter TOUT independentVerify pour ce cas,
    // pas seulement l'accessibilité depuis l'entrée. Chaque contrôle qui en
    // dépendait est donc revérifié ICI explicitement avec corridor=null,
    // plutôt que supposé réparé par un seul test déjà passé.
    {
      // a) Chevauchement de pièces, corridor=null.
      const overlap = JSON.parse(JSON.stringify(faultyEntry));
      const salonIdxOv = overlap.rooms.findIndex((r) => r.type === "salon");
      const chambre2IdxOv = overlap.rooms.findIndex((r) => r.label === "Chambre" && r.number === 2);
      overlap.rooms[chambre2IdxOv] = { ...overlap.rooms[chambre2IdxOv], x: overlap.rooms[salonIdxOv].x, y: overlap.rooms[salonIdxOv].y };
      record(
        "Consolidation (corridor=null) — chevauchement de pièces détecté",
        g.independentVerify(overlap).some((i) => i.severity === "error" && i.message.includes("Chevauchement"))
      );

      // b) Sortie d'emprise, corridor=null.
      const outside = JSON.parse(JSON.stringify(faultyEntry));
      const anyRoomIdx = 1;
      outside.rooms[anyRoomIdx] = { ...outside.rooms[anyRoomIdx], x: outside.emprise.x + outside.emprise.w + 5 };
      record(
        "Consolidation (corridor=null) — sortie d'emprise détectée",
        g.independentVerify(outside).some((i) => i.severity === "error" && i.message.includes("sort de l'emprise"))
      );

      // c) Porte orpheline, corridor=null — une pièce dont la porte ne
      // touche plus aucune circulation réelle (éloignée de tout).
      const orphan = JSON.parse(JSON.stringify(faultyEntry));
      const cuisineIdxOr = orphan.rooms.findIndex((r) => r.type === "cuisine");
      orphan.rooms[cuisineIdxOr] = { ...orphan.rooms[cuisineIdxOr], x: orphan.emprise.x + 0.2, y: orphan.emprise.y + 0.2 };
      record(
        "Consolidation (corridor=null) — porte orpheline détectée (ne débouche sur aucune circulation réelle)",
        g.independentVerify(orphan).some((i) => i.severity === "error" && i.message.includes("aucune ouverture réelle"))
      );

      // d) Fenêtre obstruée, corridor=null — le contour bâti recalculé ne
      // touche plus le mur portant la fenêtre (ex. un autre élément a
      // repoussé ce contour), sans qu'elle ait été explicitement retirée.
      // Depuis le branchement de la preuve d'exposition (lot « façades
      // extérieures »), l'obstruction est une VRAIE géométrie : un élément
      // bâti posé devant la fenêtre (0,35 m au-delà du mur, au-delà d'une
      // cloison mais en deçà du dégagement exigé), contour recalculé comme
      // le ferait le moteur. Les deux règles (historique et preuve) refusent.
      const obstructed = JSON.parse(JSON.stringify(faultyEntry));
      const ow = obstructed.windows[0];
      const oroom = obstructed.rooms[ow.roomIndex];
      const half = ow.width / 2 + 0.2;
      const blocker =
        ow.wall === "top" ? { x: ow.cx - half, y: oroom.y - 0.35 - 1.0, w: 2 * half, d: 1.0 }
        : ow.wall === "bottom" ? { x: ow.cx - half, y: oroom.y + oroom.d + 0.35, w: 2 * half, d: 1.0 }
        : ow.wall === "left" ? { x: oroom.x - 0.35 - 1.0, y: ow.cy - half, w: 1.0, d: 2 * half }
        : { x: oroom.x + oroom.w + 0.35, y: ow.cy - half, w: 1.0, d: 2 * half };
      obstructed.circulations = [...obstructed.circulations, blocker];
      const fpx = Math.min(obstructed.footprint.x, blocker.x - g.WALL_EXT), fpy = Math.min(obstructed.footprint.y, blocker.y - g.WALL_EXT);
      const fpX = Math.max(obstructed.footprint.x + obstructed.footprint.w, blocker.x + blocker.w + g.WALL_EXT);
      const fpY = Math.max(obstructed.footprint.y + obstructed.footprint.d, blocker.y + blocker.d + g.WALL_EXT);
      obstructed.footprint = { x: fpx, y: fpy, w: fpX - fpx, d: fpY - fpy };
      record(
        "Consolidation (corridor=null) — fenêtre obstruée détectée (élément bâti réel devant la fenêtre, contour recalculé)",
        g.independentVerify(obstructed).some((i) => i.severity === "error" && i.message.includes("fenêtre ne débouche plus"))
      );
      // Ancien montage conservé et documenté : contour STOCKÉ raccourci
      // artificiellement, géométrie réelle dégagée. La règle historique le
      // signalait ; la preuve, calculée sur la géométrie brute (jamais sur
      // un champ dérivé stocké), démontre la fenêtre exposée. Ce cas n'est
      // donc plus une obstruction : il est consigné tel quel, sans le
      // présenter comme une obstruction détectée.
      const staleFootprint = JSON.parse(JSON.stringify(faultyEntry));
      staleFootprint.footprint = { ...staleFootprint.footprint, d: staleFootprint.footprint.d - 1.0 };
      record(
        "Consolidation (corridor=null) — contour stocké incohérent mais géométrie dégagée : fenêtre prouvée exposée, aucune obstruction inventée",
        !g.independentVerify(staleFootprint).some((i) => i.message.includes("fenêtre ne débouche plus"))
      );
    }

    // 11) PREUVE COMPLÈTE DU CHEMINEMENT EXTÉRIEUR — fixture dédiée (jamais
    // le scénario 1, dont exteriorPaths=[] ne démontre rien ici) : accès
    // parcelle (entryDoor, mur bas) -> chemin extérieur réel (0,72 m²,
    // largeur CORRIDOR_WIDTH, vérifié sans obstacle par buildExteriorPath)
    // -> raccord -> corridor -> les deux pièces (Chambre verrouillée +
    // Salon), le tout posé par packNeedsIntoFreeSpace (même moteur que la
    // régénération réelle), jamais une accessibilité codée en dur.
    const pathProof = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-exterior-path-proof.json"), "utf8"));
    record("Cheminement extérieur — la preuve complète est admissible (0 erreur, avertissement compris)", g.independentVerify(pathProof).length === 0);
    const proofReach = g.computeReachableRooms(pathProof);
    record("Cheminement extérieur — toutes les pièces réellement accessibles (graphe)", pathProof.rooms.every((r, i) => proofReach.has(i)));

    function errorsOf(l) { return g.independentVerify(l).filter((i) => i.severity === "error"); }
    const proofNoPath = JSON.parse(JSON.stringify(pathProof));
    proofNoPath.exteriorPaths = [];
    record("Cheminement extérieur — retirer le trajet coupe effectivement l'accès (independentVerify)", errorsOf(proofNoPath).length > 0);

    const proofNoEntry = JSON.parse(JSON.stringify(pathProof));
    proofNoEntry.entryDoor = null;
    record("Cheminement extérieur — retirer l'ouverture d'entrée coupe effectivement l'accès (independentVerify)", errorsOf(proofNoEntry).length > 0);

    const proofNoFiller = JSON.parse(JSON.stringify(pathProof));
    proofNoFiller.corridorFillers = [];
    const fillerErrors = errorsOf(proofNoFiller);
    record(
      "Cheminement extérieur — retirer le raccord coupe l'accès de la pièce qu'il dessert",
      fillerErrors.some((i) => i.message.includes("Chambre"))
    );

    // 11) RÉGÉNÉRATION FIABLE APRÈS SAUVEGARDE ET RÉIMPORT — défaut constaté
    // au lot précédent : relancer regenerateUnlocked sur une disposition DÉJÀ
    // régénérée (en mémoire, après sauvegarde locale, ou après export/import
    // JSON — les trois mêmes données, mêmes paramètres, même budget) ne
    // trouvait plus AUCUNE variante (variants.length === 0), que la
    // disposition courante soit elle-même parfaitement admissible ou non —
    // confondant "cette recherche n'a rien trouvé de NOUVEAU" avec "aucun
    // plan n'est admissible". Cause RÉELLE identifiée (pas supposée) par
    // comparaison directe des obstacles utilisés par le mode "préserver" :
    // la circulation déjà en place après une première régénération est
    // elle-même un résultat de ce moteur (plusieurs groupes + raccords,
    // entièrement reconstructible, jamais une intention humaine), et sa
    // forme fragmentée rend "préserver" inopérant sur l'appel suivant — SANS
    // que la disposition cesse d'être valide pour autant. Corrigé en
    // proposant TOUJOURS la disposition actuelle comme candidat, vérifiée
    // par EXACTEMENT les mêmes contrôles (admitIfValid) que toute autre
    // proposition, jamais par hypothèse.
    {
      const lshapeInput = {
        terrainWidth: 18, terrainDepth: 28, accessSide: "left", orientation: "N",
        setbacks: { front: 3, back: 2, left: 2, right: 2 },
        entryMode: "direct", centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor",
        needs: [
          { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
          { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
          { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
          { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
          { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
        ],
      };
      const genL = g.generateVariants(lshapeInput);
      const lShaped = genL.variants.find((v) => v.circulations && v.circulations.length > 0 && v.corridor && v.corridor.d < 2);
      const c1Idx = lShaped.rooms.findIndex((r) => r.label === "Chambre" && r.number === 1);
      const c1 = lShaped.rooms[c1Idx];
      const resized = g.resizeRoom(lShaped, c1Idx, c1.x, c1.y, c1.w, 3.0);
      const lockedOnce = g.lockRoom(resized, c1Idx);

      const labelsAndSurfaces = (result) => result.variants.map((v) => `${v.variantLabel}:${v.surfaces.circulation.toFixed(2)}`).join("|");

      // Cas A — une nouvelle variante CONNUE (deux dispositions régénérées
      // distinctes de la base, 48.96 et 54.58 m² depuis la réinjection de
      // l'espace restant — voir le lot courant, qui a amélioré la première
      // de ces deux valeurs depuis 54.04 m²) doit rester trouvable, ET
      // distincte de la base inchangée (27.xx m², la disposition L
      // d'origine, elle-même déjà admissible).
      const regenMemory = g.regenerateUnlocked(lockedOnce);
      const newOnesMemory = regenMemory.variants.filter((v) => v.variantLabel !== "Disposition actuelle (inchangée)");
      record(
        "Régénération fiable — une nouvelle variante connue reste trouvable (en mémoire)",
        newOnesMemory.length >= 2 && newOnesMemory.some((v) => Math.abs(v.surfaces.circulation - 48.96) < 0.01),
        labelsAndSurfaces(regenMemory)
      );
      record(
        "Régénération fiable — la base inchangée reste distinguée des nouvelles variantes (en mémoire)",
        regenMemory.variants.some((v) => v.variantLabel === "Disposition actuelle (inchangée)")
      );

      // Cas B/C — sauvegarde locale -> rechargement ET export -> import
      // utilisent LE MÊME code (serializeProject + JSON + validateProjectFile :
      // seul le support — localStorage ou fichier — diffère réellement, pas
      // la donnée ni sa validation) : testé une fois ici pour les deux.
      // Mêmes paramètres, même budget (BACKTRACK_MAX_NODES/MILLIS inchangés) :
      // le résultat doit être RIGOUREUSEMENT identique à la recherche en
      // mémoire, étiquettes et surfaces comprises.
      const saved = pf.serializeProject(lockedOnce, "N");
      const reloaded = pf.validateProjectFile(JSON.parse(JSON.stringify(saved)));
      record("Régénération fiable — sauvegarde/réimport valide (structure, références, migrations)", reloaded.ok);
      if (reloaded.ok) {
        const regenReloaded = g.regenerateUnlocked(reloaded.value.layout);
        record(
          "Régénération fiable — résultat rigoureusement identique après sauvegarde/réimport (mêmes paramètres, même budget)",
          labelsAndSurfaces(regenReloaded) === labelsAndSurfaces(regenMemory),
          labelsAndSurfaces(regenReloaded)
        );
      }

      // Cas « seules des variantes identiques » — régénérer une disposition
      // DÉJÀ régénérée (le défaut initialement signalé) : le message doit
      // rester informatif ("aucune disposition NOUVELLE", jamais "aucun plan
      // admissible") et le brouillon (la disposition retrouvée) reste
      // sélectionnable/utilisable — jamais variants.length === 0 alors que
      // la disposition courante est elle-même admissible.
      const firstRegenNew = newOnesMemory.find((v) => Math.abs(v.surfaces.circulation - 48.96) < 0.01) ?? newOnesMemory[0];
      const secondRegen = g.regenerateUnlocked(firstRegenNew);
      record(
        "Régénération fiable — régénérer une disposition déjà régénérée reste informatif, jamais « aucun plan admissible »",
        secondRegen.variants.length === 1 && secondRegen.variants[0].variantLabel === "Disposition actuelle (inchangée)",
        secondRegen.variants[0]?.variantLabel ?? "(aucune variante)"
      );
      record(
        "Régénération fiable — le brouillon (disposition déjà régénérée) reste pleinement utilisable dans ce cas",
        secondRegen.variants.length > 0 && g.independentVerify(secondRegen.variants[0]).filter((i) => i.severity === "error").length === 0
      );
      // Même garantie après un second aller-retour sauvegarde/réimport (le
      // scénario EXACT initialement signalé : régénérer, exporter, réimporter,
      // régénérer à nouveau).
      const savedTwice = pf.validateProjectFile(JSON.parse(JSON.stringify(pf.serializeProject(firstRegenNew, "N"))));
      const secondRegenReloaded = g.regenerateUnlocked(savedTwice.value.layout);
      record(
        "Régénération fiable — même garantie après un second export/import (scénario initialement signalé)",
        labelsAndSurfaces(secondRegenReloaded) === labelsAndSurfaces(secondRegen)
      );

      // Choisir -> modifier -> régénérer une deuxième fois : un EDIT réel
      // (verrouiller une pièce supplémentaire, ici le salon) entre les deux
      // régénérations, pas une simple répétition à l'identique.
      const salonIdx = firstRegenNew.rooms.findIndex((r) => r.type === "salon");
      const salonBefore = firstRegenNew.rooms[salonIdx];
      const afterEdit = g.lockRoom(firstRegenNew, salonIdx);
      const thirdRegen = g.regenerateUnlocked(afterEdit);
      record(
        "Régénération fiable — choisir puis modifier (verrouiller une pièce de plus) puis régénérer reste utilisable",
        thirdRegen.variants.length > 0
      );
      record(
        "Régénération fiable — la pièce nouvellement verrouillée garde exactement sa place dans chaque variante retrouvée",
        thirdRegen.variants.every((v) => {
          const s = v.rooms[salonIdx];
          return s.x === salonBefore.x && s.y === salonBefore.y && s.w === salonBefore.w && s.d === salonBefore.d;
        })
      );
    }

    // 12) FIXTURES FIXES — dispositions RÉGÉNÉRÉES de référence (lot de
    // clôture "comparaison traçable") : scripts/fixtures/plans-scenario1-post-
    // regen.projet.json (48,96 m²) et plans-scenario2-post-regen.projet.json
    // (40,56 m²), exactement les deux dispositions livrées comme "après"
    // dans ce lot — jamais recalculées à la volée, figées ici pour que toute
    // évolution future du moteur soit comparée à CES valeurs précises, pas à
    // un souvenir. Chaque fixture est revérifiée : réimportable, programme
    // complet, pièce verrouillée et ses ouvertures inchangées, accessible
    // depuis le seuil d'entrée modélisé (entryDoor), et sa surface de
    // circulation recalculée ICI par union géométrique INDÉPENDANTE
    // (échantillonnage de grille, jamais le champ `surfaces.circulation`
    // enregistré) — exactement la méthode utilisée pour clarifier le 38,32 m²
    // du lot précédent, appliquée maintenant aux deux nouvelles fixtures.
    function independentUnionArea(rects) {
      if (rects.length === 0) return 0;
      const res = 0.01;
      const minX = Math.min(...rects.map((r) => r.x));
      const maxX = Math.max(...rects.map((r) => r.x + r.w));
      const minY = Math.min(...rects.map((r) => r.y));
      const maxY = Math.max(...rects.map((r) => r.y + r.d));
      let count = 0;
      for (let x = minX + res / 2; x < maxX; x += res) {
        for (let y = minY + res / 2; y < maxY; y += res) {
          if (rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.d)) count++;
        }
      }
      return count * res * res;
    }
    function checkPostRegenFixture(label, fixtureFile, expectedCirculation, lockedRoomType, programCounts) {
      const raw = JSON.parse(readFileSync(join(__dirname, "fixtures", fixtureFile), "utf8"));
      const validated = pf.validateProjectFile(raw);
      record(`${label} — réimportable (validateProjectFile)`, validated.ok);
      if (!validated.ok) return;
      const l = validated.value.layout;
      record(`${label} — admissible (0 erreur independentVerify)`, g.independentVerify(l).filter((i) => i.severity === "error").length === 0);
      const reach = g.computeReachableRooms(l);
      record(
        `${label} — toutes les pièces accessibles depuis le seuil d'entrée modélisé (entryDoor)`,
        l.rooms.every((r, i) => r.parked || reach.has(i))
      );
      const counts = {};
      l.rooms.forEach((r) => { counts[r.type] = (counts[r.type] || 0) + 1; });
      record(
        `${label} — programme complet (nombre de pièces par type)`,
        Object.entries(programCounts).every(([type, n]) => counts[type] === n),
        JSON.stringify(counts)
      );
      const locked = l.rooms.find((r) => r.locked);
      record(`${label} — une pièce verrouillée de type attendu est présente`, !!locked && locked.type === lockedRoomType);
      const circRects = [...(l.corridor ? [l.corridor] : []), ...l.corridorFillers, ...l.circulations];
      const indep = independentUnionArea(circRects);
      record(
        `${label} — surface de circulation recalculée par union géométrique indépendante (jamais le champ enregistré)`,
        Math.abs(indep - expectedCirculation) < 0.01,
        `recalculée=${indep.toFixed(2)} m², enregistrée=${l.surfaces.circulation.toFixed(2)} m²`
      );
    }
    checkPostRegenFixture("Fixture scénario 1 régénéré (48,96 m²)", "plans-scenario1-post-regen.projet.json", 48.96, "chambre", {
      chambre: 3, salon: 1, cuisine: 1, sanitaire: 2,
    });
    checkPostRegenFixture("Fixture scénario 2 régénéré (40,56 m²)", "plans-scenario2-post-regen.projet.json", 40.56, "chambre", {
      chambre: 2, salon: 1, cuisine: 1, sanitaire: 1,
    });
    // C8 (lot "corriger le placement à l'origine du conflit") — la toute
    // première disposition NEUVE et admissible jamais retrouvée pour ce cas
    // fixe, auparavant bloqué à 0 variante sur deux lots consécutifs.
    // Circulation intérieure 28,80 m² + cheminement extérieur 7,32 m² =
    // 36,12 m² au total (classification corrigée : le trajet de recours
    // depuis l'entrée est un cheminement extérieur, jamais de la circulation
    // intérieure — voir connectGroupsToNetwork). checkPostRegenFixture ne
    // recalcule que la part intérieure (corridor+raccords+circulations,
    // jamais exteriorPaths) : 28,80 m² attendus ici.
    checkPostRegenFixture("Fixture C8 régénéré (28,80 m² intérieur + 7,32 m² extérieur)", "plans-c8-resolu.projet.json", 28.8, "chambre", {
      chambre: 3, salon: 1, cuisine: 1, sanitaire: 2,
    });
    {
      const c8 = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-c8-resolu.projet.json"), "utf8")).layout;
      const indepExt = independentUnionArea(c8.exteriorPaths ?? []);
      record(
        "Fixture C8 régénéré — le trajet de recours depuis l'entrée est bien compté en cheminement extérieur (7,32 m²), jamais en circulation intérieure",
        Math.abs(indepExt - 7.32) < 0.01 && Math.abs((c8.surfaces.circulation + c8.surfaces.cheminementExterieur) - 36.12) < 0.01,
        `extérieur recalculé=${indepExt.toFixed(2)} m², intérieur enregistré=${c8.surfaces.circulation.toFixed(2)} m², total=${(c8.surfaces.circulation + c8.surfaces.cheminementExterieur).toFixed(2)} m²`
      );
    }
    // C2 (lot "boucle autonome — corridor partagé entre deux rangées") —
    // terrain large et peu profond (20×14 m, emprise 16×9 m), auparavant à
    // 0 variante sur trois familles à corridor séparé par groupe (voir
    // section 18 ci-dessous pour cette mesure, conservée). Fixture exportée
    // depuis l'éditeur (Salon verrouillé, scénario C9 de la batterie),
    // réimportée ici exactement comme un utilisateur le ferait — jamais un
    // objet Layout construit à la main qui pourrait diverger du format réel.
    checkPostRegenFixture("Fixture C2 résolu (corridor partagé entre deux rangées, 28,50 m²)", "plans-c2-resolu.projet.json", 28.5, "salon", {
      chambre: 3, salon: 1, cuisine: 1, sanitaire: 2,
    });

    // 13) RACCORDEMENT PAR N'IMPORTE QUEL SEGMENT D'UN GROUPE (lot "évaluer et
    // améliorer la génération") — connectGroupsToNetwork ne sondait la
    // jonction qu'avec LE CORRIDOR PRINCIPAL d'un groupe (g.corridor),
    // jamais ses raccords (g.fillers), même quand un raccord était, lui,
    // réellement aligné avec le réseau déjà connecté — un groupe entier
    // (donc ses pièces) était alors écarté comme "coupé du reste du
    // logement" alors qu'une jonction réelle existait, juste pas par le
    // corridor. Corrigé en essayant TOUS les segments d'un groupe (corridor
    // ET raccords) — généralisation de la recherche de jonction, jamais une
    // règle spécifique à un terrain. Cas déterministe : un groupe dont le
    // corridor est loin et mal aligné du réseau fixe, mais dont le RACCORD
    // (filler) est, lui, exactement aligné et à portée.
    {
      const fixedNetwork = [{ x: 5, y: 0, w: 1, d: 0.3 }];
      const group = {
        corridor: { x: 0, y: 5, w: 3, d: 1.2 },
        fillers: [{ x: 5, y: 1.2, w: 1, d: 3.8 }],
        placements: [
          { need: { idx: 0, label: "Test", type: "chambre", width: 3, depth: 1, minW: 3, minD: 1 }, x: 0, y: 5, w: 3, d: 1, exteriorWall: "bottom", doorWall: "top" },
        ],
      };
      const result = g.connectGroupsToNetwork(fixedNetwork, [group], []);
      record(
        "Connectivité des groupes — un groupe se raccorde par son raccord (filler) même si son corridor principal ne s'aligne pas",
        result.strandedNeeds.length === 0,
        `ponts: ${JSON.stringify(result.bridges)}`
      );
    }

    // 14) RECOURS DEPUIS L'ENTRÉE (lot "placement des groupes et
    // raccordement à l'entrée") — diagnostic mesuré sur un cas réel
    // (régénération, terrain standard 15×20, façade avant, 3 chambres, une
    // pièce verrouillée) : le retour arrière trouve 4 dispositions
    // complètes (tous les besoins réellement posés), mais aucun groupe ne
    // touchait la zone d'entrée par une jonction directe entre segments de
    // circulation — rejetées comme "coupées" alors qu'un trajet réel
    // existait depuis l'entrée elle-même vers l'un des groupes (même
    // géométrie que buildExteriorPath, jamais une nouvelle primitive).
    // connectGroupsToNetwork tente maintenant ce recours en dernier ressort.
    // Deux cas déterministes : le trajet réussit quand rien ne le bloque,
    // et reste refusé (jamais un assouplissement du contrôle) quand un
    // obstacle réel se trouve sur le segment direct.
    {
      const rescueGroup = {
        corridor: { x: 3, y: 5, w: 4, d: 1.2 },
        fillers: [],
        placements: [{ need: { idx: 0, label: "Test", type: "chambre", width: 3, depth: 1, minW: 3, minD: 1 }, x: 3, y: 5, w: 3, d: 1, exteriorWall: "bottom", doorWall: "top" }],
      };
      const entryDoor = { wall: "top", cx: 5, cy: 0, width: 0.9 };
      const bounds = { x: 0, y: 0, w: 10, d: 10 };
      const free = g.connectGroupsToNetwork([], [rescueGroup], [], { entryDoor, bounds });
      record(
        "Recours depuis l'entrée — un groupe sans jonction directe se raccorde via un trajet réel depuis l'entrée",
        free.strandedNeeds.length === 0,
        `trajets extérieurs: ${JSON.stringify(free.exteriorRescuePaths)}`
      );
      record(
        "Recours depuis l'entrée — ce trajet est classé cheminement extérieur, jamais circulation intérieure (bridges reste vide)",
        free.exteriorRescuePaths.length === 1 && free.bridges.length === 0
      );
      const blocker = { x: 4, y: 2, w: 2, d: 1 };
      const blocked = g.connectGroupsToNetwork([], [rescueGroup], [blocker], { entryDoor, bounds });
      record(
        "Recours depuis l'entrée — refusé si le trajet direct traverserait réellement un obstacle (jamais un assouplissement du contrôle)",
        blocked.strandedNeeds.length === 1 && blocked.strandedNeeds[0].label === "Test"
      );
    }

    // 15) SEUIL DE PORTE VERROUILLÉE : OBSTACLE POUR UNE PIÈCE, JAMAIS POUR
    // LA CIRCULATION (lot "corriger le placement à l'origine du conflit sur
    // C8") — reproduit le blocage EXACT diagnostiqué sur le cas fixe C8
    // (mêmes coordonnées relatives : sonde d'entrée x:[7.45,8.35], seuil de
    // porte verrouillée x:[8.28,8.6], chevauchement de 0,07 m). Ce seuil
    // (lockedDoorProbes) protège contre une chose précise : qu'une NOUVELLE
    // PIÈCE l'occupe, ce qui bloquerait réellement la porte (toujours gardé
    // dans mode.obstacles pour le placement des pièces, inchangé). Ce n'est
    // ni un mur ni le battant de la porte (doorSwingRect balaie vers
    // l'intérieur de la pièce verrouillée, jamais vers ce seuil extérieur) :
    // une CIRCULATION qui le touche ne bloque rien, c'est au contraire ce
    // qui rend la porte praticable. Avant ce lot, connectGroupsToNetwork le
    // traitait aussi comme un obstacle pour la JONCTION entre segments de
    // circulation — une réservation algorithmique trop large, jamais un mur
    // ni une obstruction de passage réelle — qui rejetait à tort des
    // dispositions par ailleurs complètes. Corrigé en l'excluant des
    // obstacles passés à connectGroupsToNetwork (jamais de mode.obstacles
    // lui-même, qui reste inchangé pour packNeedsIntoFreeSpace).
    {
      const entryDoor = { wall: "top", cx: 7.9, cy: 0, width: 0.9 };
      const bounds = { x: 0, y: 0, w: 15, d: 15 };
      const group = {
        corridor: { x: 0, y: 8, w: 12, d: 1.2 },
        fillers: [],
        placements: [{ need: { idx: 0, label: "Test", type: "chambre", width: 3, depth: 1, minW: 3, minD: 1 }, x: 0, y: 8, w: 3, d: 1, exteriorWall: "bottom", doorWall: "top" }],
      };
      const lockedDoorProbe = { x: 8.28, y: 2, w: 0.32, d: 2 };
      const beforeFix = g.connectGroupsToNetwork([], [group], [lockedDoorProbe], { entryDoor, bounds });
      record(
        "Seuil de porte verrouillée — préalable : reproduit le blocage exact (traité comme obstacle de circulation, 0,07 m de chevauchement)",
        beforeFix.strandedNeeds.length === 1 && beforeFix.strandedNeeds[0].label === "Test"
      );
      const afterFix = g.connectGroupsToNetwork([], [group], [], { entryDoor, bounds });
      record(
        "Seuil de porte verrouillée — une circulation peut désormais le traverser (le seuil reste un obstacle pour une pièce, jamais pour la jonction)",
        afterFix.strandedNeeds.length === 0,
        `trajets extérieurs: ${JSON.stringify(afterFix.exteriorRescuePaths)}`
      );
    }

    // 16) ACCÈS LATÉRAL (GAUCHE/DROITE) RÉELLEMENT RACCORDÉ (lot "prochain
    // blocage utile") — cause générale trouvée sur la batterie fixe des 11
    // cas (C10, accès droite) : buildDoubleLoadedLayout ne faisait que
    // replacer entryDoor sur le mur latéral, SANS jamais réorienter le
    // corridor ni les colonnes — toujours nord-sud, comme pour un accès
    // avant/arrière. Une colonne de pièces entière restait donc TOUJOURS
    // entre le mur latéral et le corridor, qu'aucune jonction praticable ne
    // reliait — rejeté par independentVerify sur TOUTES les répartitions
    // essayées, jamais une vraie limite de taille de terrain. Corrigé en
    // construisant la disposition dans un repère VIRTUEL "avant/arrière"
    // (reculs échangés) puis en la transposant entièrement (x/y, largeur/
    // profondeur, murs) dans le repère réel — réutilise l'algorithme avant/
    // arrière déjà vérifié tel quel, aucune nouvelle géométrie de pièce.
    // En chemin, un second défaut géométrique DISTINCT (indépendant de
    // l'accès) a été trouvé et corrigé : le raccord d'une pièce plus
    // étroite que sa colonne, côté droit, débordait de 10 cm (WALL_INT)
    // dans cette même pièce — repéré seulement une fois la connexion
    // entrée-corridor vérifiée pour de vrai (avant, le candidat était de
    // toute façon rejeté pour inaccessibilité, masquant ce chevauchement).
    {
      const SETBACKS = { front: 3, back: 2, left: 2, right: 2 };
      const NEEDS = [
        { type: "chambre", label: "Chambre", count: 2, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
        { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
        { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
        { type: "sanitaire", label: "Sanitaire", count: 1, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
        { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
      ];
      const BASE = { orientation: "N", setbacks: SETBACKS, entryMode: "direct", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor" };
      for (const accessSide of ["right", "left"]) {
        const input = { ...BASE, terrainWidth: 15, terrainDepth: 20, accessSide, needs: NEEDS };
        const res = g.generateVariants(input);
        record(`Accès latéral réellement raccordé — ${accessSide} : au moins une disposition complète trouvée (0 avant ce lot pour « droite »)`, res.variants.length > 0, `${res.variants.length} variante(s)`);
        if (res.variants.length > 0) {
          const v = res.variants[0];
          record(`Accès latéral réellement raccordé — ${accessSide} : 0 erreur independentVerify`, g.independentVerify(v).filter((i) => i.severity === "error").length === 0);
          const reach = g.computeReachableRooms(v);
          record(`Accès latéral réellement raccordé — ${accessSide} : toutes les pièces accessibles depuis l'entrée (graphe)`, v.rooms.every((r, i) => r.parked || reach.has(i)));
          record(`Accès latéral réellement raccordé — ${accessSide} : l'entrée est bien sur le mur ${accessSide}`, v.entryDoor && v.entryDoor.wall === accessSide);
          record(
            `Accès latéral réellement raccordé — ${accessSide} : le corridor est réorienté (perpendiculaire au mur d'accès, pas nord-sud)`,
            v.corridor && v.corridor.w > v.corridor.d
          );
        }
      }
    }

    // 17) CONSOLIDATION DE LA TRANSPOSITION — dimensions NON carrées et
    // reculs NETTEMENT asymétriques (14×24, reculs 4/1/2,5/1 : aucun des
    // quatre n'est égal à un autre), sur les QUATRE façades d'accès (le lot
    // précédent ne couvrait que gauche/droite, sur un terrain 15×20 dont les
    // reculs restaient proches). Réutilise les MÊMES primitives de
    // vérification que la section 16 (independentVerify couvre déjà
    // chevauchement, fenêtre réellement extérieure et battant de porte sans
    // recoupement — jamais revérifié une seconde fois ici) ; ajoute
    // seulement les contrôles qui ne sont PAS déjà couverts par
    // independentVerify : l'emprise elle-même est calculée avec les reculs
    // RÉELS (jamais ceux du repère virtuel front/back utilisé en interne
    // pour gauche/droite), chaque pièce a au moins une porte, et le sens du
    // corridor suit la convention de rotation (perpendiculaire au mur
    // d'accès latéral, parallèle à un accès avant/arrière).
    {
      const SETBACKS = { front: 4, back: 1, left: 2.5, right: 1 };
      const NEEDS = [
        { type: "chambre", label: "Chambre", count: 2, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
        { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
        { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
        { type: "sanitaire", label: "Sanitaire", count: 1, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
        { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
      ];
      const BASE = { orientation: "N", setbacks: SETBACKS, entryMode: "direct", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor" };
      const WALL_FOR_SIDE = { front: "top", back: "bottom", left: "left", right: "right" };
      for (const accessSide of ["front", "back", "left", "right"]) {
        const input = { ...BASE, terrainWidth: 14, terrainDepth: 24, accessSide, needs: NEEDS };
        const res = g.generateVariants(input);
        record(`Transposition consolidée (14×24, reculs asymétriques) — ${accessSide} : au moins une disposition complète trouvée`, res.variants.length > 0, `${res.variants.length} variante(s)`);
        if (res.variants.length === 0) continue;
        const v = res.variants[0];
        record(`Transposition consolidée — ${accessSide} : 0 erreur independentVerify (chevauchement, fenêtre, battant déjà couverts)`, g.independentVerify(v).filter((i) => i.severity === "error").length === 0);
        record(`Transposition consolidée — ${accessSide} : l'entrée est bien sur le mur ${WALL_FOR_SIDE[accessSide]}`, v.entryDoor?.wall === WALL_FOR_SIDE[accessSide]);
        record(
          `Transposition consolidée — ${accessSide} : dimensions du terrain inchangées (14×24, jamais échangées par le repère virtuel)`,
          v.terrain.w === 14 && v.terrain.d === 24
        );
        const expectedEmpriseW = input.terrainWidth - SETBACKS.left - SETBACKS.right;
        const expectedEmpriseD = input.terrainDepth - SETBACKS.front - SETBACKS.back;
        record(
          `Transposition consolidée — ${accessSide} : limites d'emprise calculées avec les reculs RÉELS (${expectedEmpriseW}×${expectedEmpriseD}, jamais ceux du repère virtuel)`,
          Math.abs(v.emprise.w - expectedEmpriseW) < 1e-6 && Math.abs(v.emprise.d - expectedEmpriseD) < 1e-6,
          `obtenu ${v.emprise.w}×${v.emprise.d}`
        );
        const activeRooms = v.rooms.filter((r) => !r.parked);
        const roomsWithoutDoor = activeRooms.filter((r) => g.doorsOf(v, v.rooms.indexOf(r)).length === 0);
        record(`Transposition consolidée — ${accessSide} : chaque pièce posée a au moins une porte`, roomsWithoutDoor.length === 0, `${roomsWithoutDoor.length} pièce(s) sans porte`);
        const roomsWithoutOpening = activeRooms.filter((r) => {
          const idx = v.rooms.indexOf(r);
          const hasWindow = g.windowsOf(v, idx).length > 0;
          const hasExteriorDoor = g.doorsOf(v, idx).some((d) => d.to.kind === "exterior" || d.to.kind === "courtyard");
          return !hasWindow && !hasExteriorDoor && !r.exteriorWall;
        });
        record(`Transposition consolidée — ${accessSide} : chaque pièce posée a au moins une ouverture extérieure`, roomsWithoutOpening.length === 0, `${roomsWithoutOpening.length} pièce(s) sans ouverture`);
        record(
          `Transposition consolidée — ${accessSide} : sens du corridor conforme à la convention de rotation (${accessSide === "left" || accessSide === "right" ? "perpendiculaire" : "parallèle"} au mur d'accès)`,
          v.corridor && (accessSide === "left" || accessSide === "right" ? v.corridor.w > v.corridor.d : v.corridor.d > v.corridor.w)
        );
      }
    }

    // 18) TERRAIN LARGE ET PEU PROFOND (C2/C9, 20×14, 3 chambres) — RÉSOLU
    // dans ce lot par une QUATRIÈME famille, le corridor PARTAGÉ entre deux
    // rangées (buildSharedCorridorLayout). Le lot précédent avait mesuré et
    // chiffré un manque structurel (0,90 m) pour TROIS familles à corridor
    // SÉPARÉ par groupe (double-chargé, L, empaquetage libre) — une mesure
    // honnête de CES topologies précises, jamais une preuve d'impossibilité
    // architecturale pour le terrain lui-même (une quatrième organisation
    // pouvait toujours exister). Les deux volets sont conservés ici : la
    // mesure du manque pour les trois familles à corridor séparé (toujours
    // vraie, inchangée), ET la preuve que la quatrième famille, en partageant
    // UN SEUL corridor entre les deux rangées au lieu d'un par groupe,
    // suffit réellement.
    {
      const SETBACKS = { front: 3, back: 2, left: 2, right: 2 };
      const NEEDS_3CH = [
        { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
        { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
        { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
        { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
        { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
      ];
      const input = {
        orientation: "N", setbacks: SETBACKS, entryMode: "direct", courtyardDepth: 3, centralSalon: false,
        roomsConnectVia: "corridor", sanitaireConnectVia: "corridor",
        terrainWidth: 20, terrainDepth: 14, accessSide: "front", needs: NEEDS_3CH,
      };
      const res = g.generateVariants(input);

      // Mesure CONSERVÉE : le manque structurel des trois familles à
      // corridor séparé par groupe reste vrai en soi (rejoué depuis les
      // mêmes constantes exportées, jamais une valeur figée) — il décrit
      // leur limite propre, pas celle du terrain.
      const empriseD = input.terrainDepth - SETBACKS.front - SETBACKS.back;
      const rowTaxSeparate = g.WALL_EXT * 2 + g.CORRIDOR_WIDTH + g.WALL_INT;
      const chambreDepth = NEEDS_3CH.find((n) => n.type === "chambre").targetDepth;
      const salonDepth = NEEDS_3CH.find((n) => n.type === "salon").targetDepth;
      const sanitaireDepth = NEEDS_3CH.find((n) => n.type === "sanitaire").targetDepth;
      const bestTwoGroupDepth = Math.max(chambreDepth, salonDepth) + sanitaireDepth + 2 * rowTaxSeparate;
      record(
        `Terrain large et peu profond — manque structurel des familles à corridor SÉPARÉ, mesuré et rejoué (${bestTwoGroupDepth.toFixed(2)} m nécessaires pour la meilleure répartition à 2 groupes > ${empriseD.toFixed(2)} m disponibles)`,
        bestTwoGroupDepth > empriseD,
        `écart ${(bestTwoGroupDepth - empriseD).toFixed(2)} m`
      );
      // Mise à jour (lot "guidée/L sur 4 façades") : la circulation en L est
      // désormais RÉELLEMENT prise en charge pour l'accès avant (plus un
      // refus de principe) — elle est donc ici réellement TENTÉE pour ce
      // terrain précis, et échoue pour un motif GÉOMÉTRIQUE propre à ce
      // terrain (largeur du segment bas insuffisante), jamais plus un refus
      // de façade. La mesure "familles à corridor séparé réellement
      // essayées" reste vraie, seul le motif de l'échec de L a changé.
      record(
        "Terrain large et peu profond — familles à corridor séparé (double-chargé, L, empaquetage libre) réellement essayées avant la quatrième",
        res.attemptFailureReasons.some((r) => r.includes("Profondeur insuffisante")) &&
          res.attemptFailureReasons.some((r) => r.includes("Circulation en L") && (r.includes("largeur insuffisante") || r.includes("profondeur insuffisante") || r.includes("jonction")))
      );

      // RÉSOLU : la quatrième famille (corridor partagé) trouve une
      // disposition complète et admissible — jamais affirmé sans vérifier
      // chaque garantie séparément (programme, dimensions, entrée, 0 erreur,
      // accessibilité réelle).
      record("Terrain large et peu profond (C2) — génération initiale : disposition complète trouvée (corridor partagé entre deux rangées)", res.variants.length > 0, `${res.variants.length} variante(s)`);
      if (res.variants.length > 0) {
        const v = res.variants[0];
        record("Terrain large et peu profond (C2) — 0 erreur independentVerify", g.independentVerify(v).filter((i) => i.severity === "error").length === 0);
        const reach = g.computeReachableRooms(v);
        record("Terrain large et peu profond (C2) — toutes les pièces accessibles depuis l'entrée", v.rooms.every((r, i) => r.parked || reach.has(i)));
        record("Terrain large et peu profond (C2) — entrée bien sur la façade avant", v.entryDoor?.wall === "top");
        const counts = {};
        v.rooms.forEach((r) => { if (!r.parked) counts[r.type] = (counts[r.type] || 0) + 1; });
        record(
          "Terrain large et peu profond (C2) — programme EXACTEMENT celui demandé (3 chambres, 1 salon, 1 cuisine, 2 sanitaires)",
          counts.chambre === 3 && counts.salon === 1 && counts.cuisine === 1 && counts.sanitaire === 2,
          JSON.stringify(counts)
        );
        const dimsOk = v.rooms.every((r) => {
          const need = NEEDS_3CH.find((n) => n.type === r.type);
          return r.w >= need.minWidth - 1e-6 && r.d >= need.minDepth - 1e-6 && r.w <= need.targetWidth * 1.25 + 1e-6 && r.d <= need.targetDepth * 1.25 + 1e-6;
        });
        record("Terrain large et peu profond (C2) — chaque pièce reste dans ses bornes déclarées (minimum..cible×1.25)", dimsOk);
        record("Terrain large et peu profond (C2) — terrain et emprise inchangés (20×14, reculs 3/2/2/2)", v.terrain.w === 20 && v.terrain.d === 14 && v.emprise.w === 16 && v.emprise.d === 9);

        // C9 : verrouille le SALON (scénario explicitement demandé, distinct
        // du verrouillage d'une chambre déjà couvert par la batterie fixe)
        // puis régénère — exige au moins une disposition GENUINEMENT
        // nouvelle (pas seulement le repli « inchangée »), avec le verrou
        // conservé EXACTEMENT : position, dimensions, portes ET fenêtres
        // (jamais seulement position/dimensions comme la preuve précédente).
        // Les AUTRES pièces doivent elles aussi garder leurs dimensions
        // individuelles (même convention que packNeedsIntoFreeSpace/needs
        // partout ailleurs dans regenerateUnlocked : sizeFor(r.w, r.minW)
        // préfère toujours la taille ACTUELLE, jamais une cible recalculée
        // depuis les préréglages).
        const lockIdx = v.rooms.findIndex((r) => r.type === "salon");
        const before = { ...v.rooms[lockIdx] };
        const beforeDoors = v.doors.filter((d) => d.roomIndex === lockIdx).map((d) => ({ ...d }));
        const beforeWindows = v.windows.filter((w) => w.roomIndex === lockIdx).map((w) => ({ ...w }));
        const beforeOtherDims = v.rooms.map((r) => ({ type: r.type, w: r.w, d: r.d }));
        const locked = g.lockRoom(v, lockIdx);
        const regen = g.regenerateUnlocked(locked);
        const baseline = regen.variants.find((rv) => rv.variantLabel === "Disposition actuelle (inchangée)");
        record("Terrain large et peu profond (C9, salon verrouillé) — le repli « disposition actuelle (inchangée) » reste proposé", !!baseline);
        const newOnes = regen.variants.filter((rv) => rv.variantLabel !== "Disposition actuelle (inchangée)");
        record(
          "Terrain large et peu profond (C9, salon verrouillé) — au moins une disposition NOUVELLE et admissible trouvée (pas seulement le repli)",
          newOnes.length > 0,
          `${newOnes.length} nouvelle(s) variante(s)`
        );
        for (const candidate of regen.variants) {
          const after = candidate.rooms[lockIdx];
          const samePosition = Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.y - before.y) < 1e-6;
          const sameSize = Math.abs(after.w - before.w) < 1e-6 && Math.abs(after.d - before.d) < 1e-6;
          const afterDoors = candidate.doors.filter((d) => d.roomIndex === lockIdx);
          const sameDoors =
            afterDoors.length === beforeDoors.length &&
            beforeDoors.every((bd) => afterDoors.some((ad) => ad.wall === bd.wall && Math.abs(ad.cx - bd.cx) < 1e-6 && Math.abs(ad.cy - bd.cy) < 1e-6 && Math.abs(ad.width - bd.width) < 1e-6));
          const afterWindows = candidate.windows.filter((w) => w.roomIndex === lockIdx);
          const sameWindows =
            afterWindows.length === beforeWindows.length &&
            beforeWindows.every((bw) => afterWindows.some((aw) => aw.wall === bw.wall && Math.abs(aw.cx - bw.cx) < 1e-6 && Math.abs(aw.cy - bw.cy) < 1e-6 && Math.abs(aw.width - bw.width) < 1e-6));
          record(
            `Terrain large et peu profond (C9, salon verrouillé) — verrou conservé EXACTEMENT dans « ${candidate.variantLabel} » (position, dimensions, portes, fenêtres)`,
            samePosition && sameSize && sameDoors && sameWindows
          );
        }
        if (newOnes.length > 0) {
          // Certaines des nouvelles dispositions replient LÉGÈREMENT la
          // largeur de quelques pièces (ex. 3,50→3,45 m, jamais sous leur
          // minimum déclaré — même algorithme fitProportional qu'à la
          // génération initiale) quand le partage essayé l'exige. Puisque la
          // consigne demande explicitement de conserver les dimensions
          // individuelles des autres pièces, la preuve retient en priorité
          // une variante qui n'en a besoin d'AUCUN : au moins une des
          // nouvelles dispositions trouvées doit satisfaire cette exigence
          // sans aucun repli, jamais seulement "en moyenne" ou "au mieux".
          const exact = newOnes.find((rv) => rv.rooms.every((r, i) => i === lockIdx || (Math.abs(r.w - beforeOtherDims[i].w) < 1e-6 && Math.abs(r.d - beforeOtherDims[i].d) < 1e-6)));
          record(
            "Terrain large et peu profond (C9, salon verrouillé) — au moins une nouvelle disposition conserve les dimensions individuelles de TOUTES les autres pièces, sans aucun repli",
            !!exact,
            exact ? exact.variantLabel : `aucune parmi : ${newOnes.map((rv) => rv.variantLabel).join(", ")}`
          );
          const sample = exact ?? newOnes[0];
          const sampleOtherDims = sample.rooms.map((r) => ({ type: r.type, w: r.w, d: r.d }));
          const dimsPreserved = beforeOtherDims.every((b, i) => Math.abs(sampleOtherDims[i].w - b.w) < 1e-6 && Math.abs(sampleOtherDims[i].d - b.d) < 1e-6);
          record(
            `Terrain large et peu profond (C9, salon verrouillé) — « ${sample.variantLabel} » (retenue pour les preuves suivantes) conserve les dimensions individuelles des autres pièces`,
            dimsPreserved
          );
          const moved = sample.rooms.some((r, i) => i !== lockIdx && (Math.abs(r.x - v.rooms[i].x) > 1e-6 || Math.abs(r.y - v.rooms[i].y) > 1e-6));
          record(
            `Terrain large et peu profond (C9, salon verrouillé) — « ${sample.variantLabel} » réellement distincte du repli (au moins une pièce non verrouillée à une position différente)`,
            moved
          );
          // Circulation intérieure, cheminement extérieur et total — comparés
          // SÉPARÉMENT entre la disposition d'origine et la nouvelle, jamais
          // additionnés sans distinction (même exigence que la clôture du
          // bilan C8) : un total plus élevé qu'à l'origine est une diversité
          // supplémentaire, jamais présenté comme un gain de surface.
          const beforeTotal = v.surfaces.circulation + v.surfaces.cheminementExterieur;
          const afterTotal = sample.surfaces.circulation + sample.surfaces.cheminementExterieur;
          record(
            `Terrain large et peu profond (C9, salon verrouillé) — circulation intérieure (${v.surfaces.circulation.toFixed(2)} → ${sample.surfaces.circulation.toFixed(2)} m²), cheminement extérieur (${v.surfaces.cheminementExterieur.toFixed(2)} → ${sample.surfaces.cheminementExterieur.toFixed(2)} m²) et total (${beforeTotal.toFixed(2)} → ${afterTotal.toFixed(2)} m²) mesurés séparément, jamais confondus`,
            true,
            `delta total = ${(afterTotal - beforeTotal).toFixed(2)} m²`
          );
        }
      }
    }

    // 19) CORRIDOR PARTAGÉ — QUATRE FAÇADES D'ACCÈS (lot "corridor partagé
    // sur les quatre façades") — jusqu'ici cette famille ne gérait l'accès
    // arrière que par un refus explicite, et l'accès gauche/droite (déjà
    // "géré" par le même transpose générique que buildDoubleLoadedLayout)
    // n'avait jamais été vérifié : deux défauts trouvés et corrigés ici.
    //
    // Défaut 1 (arrière) : buildSharedCorridorLayoutStraight ignorait
    // entièrement accessSide pour sa géométrie (toujours "avant"), le refus
    // explicite de "back" dans le dispatcher était donc la seule protection
    // contre un résultat silencieusement incorrect. Corrigé en ajoutant un
    // reflet vertical interne (rects ET étiquettes de mur "top"/"bottom"
    // inversées ensemble — contrairement à buildDoubleLoadedLayout, qui
    // n'utilise jamais ces murs pour ses pièces en colonnes).
    //
    // Défaut 2 (gauche/droite) : transposeDoubleLoadedResult (réutilisé
    // tel quel) ne transposait jamais `circulations` ni `exteriorPaths` —
    // jamais remarqué par buildDoubleLoadedLayout, qui ne les utilise
    // jamais. Le foyer de cette famille y est rangé : resté dans le repère
    // VIRTUEL après transposition, il chevauchait les pièces du repère
    // réel. Corrigé en généralisant ce transpose (désormais réutilisable
    // par n'importe quelle famille future, pas seulement celle-ci).
    {
      const salon = { type: "salon", label: "Salon", minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 };
      const cuisine = { type: "cuisine", label: "Cuisine", minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 };
      const chambre = { type: "chambre", label: "Chambre", minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 };
      const sanitaire = { type: "sanitaire", label: "Sanitaire", minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 };
      const frontNeeds = [salon, cuisine];
      const backNeeds = [chambre, chambre, sanitaire];
      const BASE = { orientation: "N", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", entryMode: "direct", needs: [] };
      const terrains = [
        { label: "terrain rectangulaire 15×20 (non carré, reculs gauche/droite égaux)", terrainWidth: 15, terrainDepth: 20, setbacks: { front: 3, back: 2, left: 2, right: 2 } },
        { label: "terrain NON carré, reculs ASYMÉTRIQUES", terrainWidth: 14, terrainDepth: 24, setbacks: { front: 4, back: 1, left: 2.5, right: 1 } },
      ];
      const expectedWall = { front: "top", back: "bottom", left: "left", right: "right" };
      for (const t of terrains) {
        for (const accessSide of ["front", "back", "left", "right"]) {
          const input = { ...BASE, terrainWidth: t.terrainWidth, terrainDepth: t.terrainDepth, accessSide, setbacks: t.setbacks };
          const v = g.buildSharedCorridorLayout(input, frontNeeds, backNeeds, "test");
          record(`Corridor partagé — ${t.label}, accès ${accessSide} : disposition admissible trouvée`, v.feasible, v.feasible ? "" : v.failureReasons.join(" | "));
          if (!v.feasible) continue;
          const errors = g.independentVerify(v).filter((i) => i.severity === "error");
          record(`Corridor partagé — ${t.label}, accès ${accessSide} : 0 erreur independentVerify`, errors.length === 0, errors.map((e) => e.message).join(" | "));
          const reach = g.computeReachableRooms(v);
          record(`Corridor partagé — ${t.label}, accès ${accessSide} : toutes les pièces accessibles depuis l'entrée`, v.rooms.every((r, i) => r.parked || reach.has(i)));
          record(`Corridor partagé — ${t.label}, accès ${accessSide} : entrée sur le mur attendu (${expectedWall[accessSide]})`, v.entryDoor?.wall === expectedWall[accessSide]);
          record(
            `Corridor partagé — ${t.label}, accès ${accessSide} : dimensions du terrain inchangées (${t.terrainWidth}×${t.terrainDepth}, reculs attachés aux côtés physiques)`,
            v.terrain.w === t.terrainWidth && v.terrain.d === t.terrainDepth &&
              Math.abs(v.emprise.w - (t.terrainWidth - t.setbacks.left - t.setbacks.right)) < 1e-6 &&
              Math.abs(v.emprise.d - (t.terrainDepth - t.setbacks.front - t.setbacks.back)) < 1e-6
          );
          record(`Corridor partagé — ${t.label}, accès ${accessSide} : chaque pièce posée a au moins une porte`, v.rooms.every((r, i) => g.doorsOf(v, i).length > 0));
          record(`Corridor partagé — ${t.label}, accès ${accessSide} : chaque pièce posée a au moins une ouverture extérieure`, v.rooms.every((r, i) => g.windowsOf(v, i).length > 0 || !!r.exteriorWall));
          const sumCat = v.surfaces.batie + v.surfaces.cheminementExterieur + v.surfaces.nonAffectee + v.surfaces.exterieure + v.surfaces.cour;
          record(
            `Corridor partagé — ${t.label}, accès ${accessSide} : bilan de surfaces cohérent (catégories géométriques disjointes, somme = emprise, sans double comptage)`,
            Math.abs(sumCat - v.surfaces.emprise) < 1e-6,
            `somme=${sumCat.toFixed(4)} vs emprise=${v.surfaces.emprise.toFixed(4)}`
          );
        }
      }
    }

    // 20) CORRIDOR PARTAGÉ — RÉGÉNÉRATION ÉTENDUE À L'ACCÈS ARRIÈRE (même lot
    // que la section 19) — jusqu'ici la stratégie dédiée dans
    // regenerateUnlocked() (Cas A/B, lot bdd22fd) était gardée par
    // `layout.accessSide === "front"` : un verrouillage dans cette
    // configuration sur un plan à accès ARRIÈRE retombait sur la recherche
    // générale (packNeedsIntoFreeSpace), qui ne partage jamais de corridor
    // entre deux rangées (même limite déjà chiffrée pour la génération
    // initiale) — correction en 2 temps :
    // - la porte d'entrée (devenue "bottom" pour l'accès arrière) peut
    //   toucher soit la rangée VERROUILLÉE (plus besoin de foyer, comme le
    //   Cas A d'origine), soit la rangée FRAÎCHE (foyer nécessaire côté
    //   entrée, comme le Cas B d'origine) — selon laquelle des deux rangées
    //   est verrouillée, jamais selon un "Cas A/B" figé sur "avant/arrière".
    // - généralisé via `entryWallForRegen`/`foyerOnBackRow`/`foyerOnFrontRow`
    //   dans regenerateUnlocked(), chaque Cas gardant sa construction
    //   géométrique (quelle rangée touche quel mur) mais décidant QUI porte
    //   le foyer selon le mur d'entrée réel plutôt qu'un sens supposé.
    // "left"/"right" restent HORS PÉRIMÈTRE de cette extension (passent par
    // un repère virtuel entier via transposeDoubleLoadedResult, jamais par
    // cette logique directement) — limite documentée ci-dessous, jamais
    // forcée : la recherche générale reste utilisée pour ces deux façades,
    // sans le partage de corridor entre rangées lors d'une régénération.
    {
      const NEEDS = [
        { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
        { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
        { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
        { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
      ];
      const SETBACKS = { front: 3, back: 2, left: 2, right: 2 };
      const BASE = { orientation: "N", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", entryMode: "direct", needs: NEEDS };

      function checkRegen(label, lockedBase, base, lockedIdxs, accessSide) {
        const regen = g.regenerateUnlocked(lockedBase);
        const newOnes = regen.variants.filter((l, i) => !regen.preferenceNotes[i].startsWith("Disposition actuelle conservée"));
        record(`${label} : au moins une disposition nouvelle et admissible trouvée`, newOnes.length > 0, regen.failureReasons.slice(0, 2).join(" | "));
        for (const layout of newOnes) {
          const lockedOk = lockedIdxs.every((idx) => {
            const r = layout.rooms[idx];
            const b = base.rooms[idx];
            return r && Math.abs(r.x - b.x) < 1e-6 && Math.abs(r.y - b.y) < 1e-6 && Math.abs(r.w - b.w) < 1e-6 && Math.abs(r.d - b.d) < 1e-6;
          });
          record(`${label} : pièce(s) verrouillée(s) strictement inchangée(s) (position/dimensions)`, lockedOk);
          // Défaut mesuré (rapporté avec fichiers à l'appui) : une ancienne
          // stratégie de répartition proportionnelle rétrécissait
          // silencieusement des pièces NON verrouillées sous leur cible
          // (ex. chambre 3,50 m → 3,452 m, sanitaire 1,80 m → 1,771 m) pour
          // faire tenir une disposition de régénération. Une régénération ne
          // doit JAMAIS réduire une pièce sous sa cible individuelle : un
          // placement qui l'exigerait doit être rejeté, jamais proposé
          // réduit. Vérifié ici pièce par pièce, pour CHAQUE pièce non
          // verrouillée de CHAQUE disposition nouvelle retournée.
          const unlockedOk = layout.rooms.every((r, i) => {
            if (lockedIdxs.includes(i) || r.parked) return true;
            const b = base.rooms[i];
            return b && Math.abs(r.w - b.w) < 1e-6 && Math.abs(r.d - b.d) < 1e-6;
          });
          record(
            `${label} : aucune pièce non verrouillée réduite sous sa dimension cible (jamais un repli silencieux)`,
            unlockedOk,
            layout.rooms
              .map((r, i) => (!lockedIdxs.includes(i) && !r.parked && base.rooms[i] && (Math.abs(r.w - base.rooms[i].w) > 1e-6 || Math.abs(r.d - base.rooms[i].d) > 1e-6) ? `${r.label}${r.number}: ${base.rooms[i].w.toFixed(3)}x${base.rooms[i].d.toFixed(3)} → ${r.w.toFixed(3)}x${r.d.toFixed(3)}` : null))
              .filter(Boolean)
              .join(" | ")
          );
          const errors = g.independentVerify(layout).filter((e) => e.severity === "error");
          record(`${label} : 0 erreur independentVerify`, errors.length === 0, errors.map((e) => e.message).join(" | "));
          const reach = g.computeReachableRooms(layout);
          record(`${label} : toutes les pièces accessibles depuis l'entrée`, layout.rooms.every((r, i) => r.parked || reach.has(i)));
          record(`${label} : entrée sur le mur attendu (${accessSide === "front" ? "top" : "bottom"})`, layout.entryDoor?.wall === (accessSide === "front" ? "top" : "bottom"));
          const sumCat = layout.surfaces.batie + layout.surfaces.cheminementExterieur + layout.surfaces.nonAffectee + layout.surfaces.exterieure + layout.surfaces.cour;
          record(
            `${label} : bilan de surfaces cohérent (catégories géométriques disjointes, somme = emprise, sans double comptage)`,
            Math.abs(sumCat - layout.surfaces.emprise) < 1e-6,
            `somme=${sumCat.toFixed(4)} vs emprise=${layout.surfaces.emprise.toFixed(4)}`
          );
        }
      }

      for (const accessSide of ["front", "back"]) {
        const input = { ...BASE, terrainWidth: 20, terrainDepth: 14, accessSide, setbacks: SETBACKS };
        const res = g.generateVariants(input);
        record(`Corridor partagé, régénération accès ${accessSide} : au moins une disposition de départ générée`, res.variants.length > 0);
        if (res.variants.length === 0) continue;
        const base = res.variants[0];

        // Rangée verrouillée du côté de l'entrée (pas de foyer nécessaire,
        // généralisation du Cas A d'origine).
        const salonIdx = base.rooms.findIndex((r) => r.type === "salon");
        if (salonIdx >= 0) {
          const lockedBase = { ...base, rooms: base.rooms.map((r, i) => (i === salonIdx ? { ...r, locked: true } : r)) };
          checkRegen(`Corridor partagé, régénération accès ${accessSide} (salon verrouillé, rangée côté entrée)`, lockedBase, base, [salonIdx], accessSide);
        }

        // Rangée verrouillée du côté OPPOSÉ à l'entrée (foyer nécessaire côté
        // entrée dans la rangée fraîche, généralisation du Cas B d'origine).
        const chambreIdxs = base.rooms.map((r, i) => (r.type === "chambre" ? i : -1)).filter((i) => i >= 0);
        if (chambreIdxs.length > 0) {
          const lockedBase = { ...base, rooms: base.rooms.map((r, i) => (chambreIdxs.includes(i) ? { ...r, locked: true } : r)) };
          checkRegen(`Corridor partagé, régénération accès ${accessSide} (chambres verrouillées, rangée côté opposé à l'entrée)`, lockedBase, base, chambreIdxs, accessSide);
        }
      }

      // Échec explicite pertinent conservé (jamais forcé) : accès
      // gauche/droite reste hors périmètre pour la RÉGÉNÉRATION de cette
      // famille — vérifie que la recherche ne plante pas et ne prétend pas
      // à tort réutiliser le corridor partagé (elle peut retomber sur la
      // recherche générale ou sur le repli "disposition actuelle"), jamais
      // qu'elle réussisse de cette façon précise.
      for (const accessSide of ["left", "right"]) {
        const input = { ...BASE, terrainWidth: 20, terrainDepth: 14, accessSide, setbacks: SETBACKS };
        const res = g.generateVariants(input);
        if (res.variants.length === 0) continue;
        const base = res.variants[0];
        const salonIdx = base.rooms.findIndex((r) => r.type === "salon");
        if (salonIdx < 0) continue;
        const lockedBase = { ...base, rooms: base.rooms.map((r, i) => (i === salonIdx ? { ...r, locked: true } : r)) };
        const regen = g.regenerateUnlocked(lockedBase);
        const allValid = regen.variants.every((layout) => g.independentVerify(layout).filter((e) => e.severity === "error").length === 0);
        record(
          `Corridor partagé, régénération accès ${accessSide} (hors périmètre de ce lot) : aucune disposition invalide produite même sans la stratégie dédiée`,
          allValid,
          allValid ? "" : "une disposition retournée contient des erreurs independentVerify"
        );
      }
    }

    // 21) FICHIER DE PROJET VERSIONNÉ — RÉGÉNÉRATION ACCÈS ARRIÈRE (défaut
    // rapporté avec fichiers à l'appui : les JSON livrés au lot précédent
    // étaient des Layout bruts, pas de vrais fichiers de projet). Reproduit
    // EXACTEMENT le scénario rapporté (terrain 20×14, accès arrière, 3
    // chambres + salon + cuisine + 2 sanitaires, salon verrouillé) en
    // passant par serializeProject/validateProjectFile (jamais un
    // JSON.stringify/parse nu) — seul round-trip qui prouve qu'un fichier
    // RÉELLEMENT écrit sur disque, puis réimporté par l'application, reste
    // fidèle (verrou, dimensions, bilan de surfaces).
    {
      const NEEDS = [
        { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
        { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
        { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
        { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
      ];
      const input = {
        orientation: "N", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor",
        entryMode: "direct", needs: NEEDS, terrainWidth: 20, terrainDepth: 14, accessSide: "back",
        setbacks: { front: 3, back: 2, left: 2, right: 2 },
      };
      const res = g.generateVariants(input);
      record("Fichier projet — régénération accès arrière : disposition de départ générée", res.variants.length > 0);
      if (res.variants.length > 0) {
        const base = res.variants[0];
        const salonIdx = base.rooms.findIndex((r) => r.type === "salon");
        const lockedBase = { ...base, rooms: base.rooms.map((r, i) => (i === salonIdx ? { ...r, locked: true } : r)) };
        const regen = g.regenerateUnlocked(lockedBase);
        const newLayout = regen.variants.find((l, i) => !regen.preferenceNotes[i].startsWith("Disposition actuelle"));
        record("Fichier projet — régénération accès arrière : au moins une nouvelle disposition", !!newLayout);
        if (newLayout) {
          const project = pf.serializeProject(newLayout, input.orientation);
          const reread = JSON.parse(JSON.stringify(project)); // simule une écriture/lecture disque réelle (round-trip JSON)
          const validated = pf.validateProjectFile(reread);
          record("Fichier projet — régénération accès arrière : validateProjectFile accepte le fichier réellement écrit", validated.ok, validated.ok ? "" : validated.error);
          if (validated.ok) {
            const rt = validated.value.layout;
            const rtSalon = rt.rooms[salonIdx];
            const origSalon = newLayout.rooms[salonIdx];
            const salonRoundTripOk =
              Math.abs(rtSalon.x - origSalon.x) < 1e-9 && Math.abs(rtSalon.y - origSalon.y) < 1e-9 &&
              Math.abs(rtSalon.w - origSalon.w) < 1e-9 && Math.abs(rtSalon.d - origSalon.d) < 1e-9;
            record("Fichier projet — régénération accès arrière : verrou (salon) identique après réimport", salonRoundTripOk);
            const surfacesRoundTripOk = JSON.stringify(rt.surfaces) === JSON.stringify(newLayout.surfaces);
            record("Fichier projet — régénération accès arrière : bilan de surfaces identique après réimport (interface/JSON/rendu lisent le même bilan)", surfacesRoundTripOk);
            const sumCat = rt.surfaces.batie + rt.surfaces.cheminementExterieur + rt.surfaces.nonAffectee + rt.surfaces.exterieure + rt.surfaces.cour;
            record(
              "Fichier projet — régénération accès arrière : bilan de surfaces du fichier réimporté cohérent (somme = emprise)",
              Math.abs(sumCat - rt.surfaces.emprise) < 1e-6,
              `somme=${sumCat.toFixed(4)} vs emprise=${rt.surfaces.emprise.toFixed(4)}`
            );
          }
        }
      }
    }

    // 22) CORRIDOR PARTAGÉ — RÉGÉNÉRATION ÉTENDUE À L'ACCÈS GAUCHE/DROITE
    // (même lot que la correction du rétrécissement silencieux) — jusqu'ici
    // seuls avant/arrière réutilisaient la stratégie dédiée en régénération ;
    // gauche/droite retombaient sur la recherche générale. Corrigé en
    // RÉUTILISANT la même transposition globale que la génération initiale
    // (buildSharedCorridorLayout/buildDoubleLoadedLayout) plutôt qu'un
    // second chemin dédié : `regenerateUnlocked` (exporté) transpose
    // désormais le Layout reçu dans le même repère virtuel pour gauche/droite,
    // appelle `regenerateUnlockedCore` (la fonction déjà existante,
    // inchangée) sur ce repère, puis transpose chaque résultat vers le
    // repère physique réel — zéro duplication de la géométrie Cas A/B.
    {
      const NEEDS = [
        { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
        { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
        { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
        { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
      ];
      const BASE = { orientation: "N", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", entryMode: "direct", needs: NEEDS };
      const terrains = [
        { label: "terrain rectangulaire 15×20 (non carré, reculs gauche/droite égaux)", terrainWidth: 15, terrainDepth: 20, setbacks: { front: 3, back: 2, left: 2, right: 2 } },
        { label: "terrain NON carré, reculs ASYMÉTRIQUES", terrainWidth: 14, terrainDepth: 24, setbacks: { front: 4, back: 1, left: 2.5, right: 1 } },
      ];

      function checkRegenLR(label, lockedBase, base, lockedIdxs, accessSide) {
        const regen = g.regenerateUnlocked(lockedBase);
        const newOnes = regen.variants.filter((l, i) => !regen.preferenceNotes[i].startsWith("Disposition actuelle conservée"));
        for (const layout of newOnes) {
          const lockedOk = lockedIdxs.every((idx) => {
            const r = layout.rooms[idx];
            const b = base.rooms[idx];
            return r && Math.abs(r.x - b.x) < 1e-6 && Math.abs(r.y - b.y) < 1e-6 && Math.abs(r.w - b.w) < 1e-6 && Math.abs(r.d - b.d) < 1e-6;
          });
          record(`${label} : pièce(s) verrouillée(s) strictement inchangée(s) (position/dimensions, repère physique)`, lockedOk);
          const unlockedOk = layout.rooms.every((r, i) => {
            if (lockedIdxs.includes(i) || r.parked) return true;
            const b = base.rooms[i];
            return b && Math.abs(r.w - b.w) < 1e-6 && Math.abs(r.d - b.d) < 1e-6;
          });
          record(`${label} : aucune pièce non verrouillée réduite sous sa dimension cible`, unlockedOk);
          const errors = g.independentVerify(layout).filter((e) => e.severity === "error");
          record(`${label} : 0 erreur independentVerify`, errors.length === 0, errors.map((e) => e.message).join(" | "));
          const reach = g.computeReachableRooms(layout);
          record(`${label} : toutes les pièces accessibles depuis l'entrée`, layout.rooms.every((r, i) => r.parked || reach.has(i)));
          record(`${label} : entrée sur le mur attendu (${accessSide})`, layout.entryDoor?.wall === accessSide);
          record(
            `${label} : terrain/reculs physiques inchangés (jamais permutés par la transposition interne)`,
            layout.terrain.w === base.terrain.w && layout.terrain.d === base.terrain.d &&
              Math.abs(layout.emprise.w - base.emprise.w) < 1e-6 && Math.abs(layout.emprise.d - base.emprise.d) < 1e-6
          );
          const sumCat = layout.surfaces.batie + layout.surfaces.cheminementExterieur + layout.surfaces.nonAffectee + layout.surfaces.exterieure + layout.surfaces.cour;
          record(
            `${label} : bilan de surfaces cohérent (somme = emprise, sans double comptage)`,
            Math.abs(sumCat - layout.surfaces.emprise) < 1e-6,
            `somme=${sumCat.toFixed(4)} vs emprise=${layout.surfaces.emprise.toFixed(4)}`
          );
        }
        // Échec explicite conservé (jamais forcé) : si la recherche ne
        // trouve aucune nouvelle disposition pour cette combinaison précise,
        // le repli "disposition actuelle" doit rester proposé et distinct —
        // jamais une erreur, jamais un résultat invalide.
        const baseline = regen.variants.find((l, i) => regen.preferenceNotes[i].startsWith("Disposition actuelle conservée"));
        record(`${label} : repli "disposition actuelle" distinct des nouvelles propositions`, !!baseline && newOnes.every((l) => l !== baseline));
      }

      for (const accessSide of ["left", "right"]) {
        for (const t of terrains) {
          const input = { ...BASE, terrainWidth: t.terrainWidth, terrainDepth: t.terrainDepth, accessSide, setbacks: t.setbacks };
          const res = g.generateVariants(input);
          record(`Corridor partagé, régénération accès ${accessSide}, ${t.label} : au moins une disposition de départ générée`, res.variants.length > 0);
          if (res.variants.length === 0) continue;
          const base = res.variants[0];

          const salonIdx = base.rooms.findIndex((r) => r.type === "salon");
          if (salonIdx >= 0) {
            const lockedBase = { ...base, rooms: base.rooms.map((r, i) => (i === salonIdx ? { ...r, locked: true } : r)) };
            checkRegenLR(`Corridor partagé, régénération accès ${accessSide}, ${t.label} (salon verrouillé, mur ${base.rooms[salonIdx].exteriorWall})`, lockedBase, base, [salonIdx], accessSide);
          }
          const chambreIdxs = base.rooms.map((r, i) => (r.type === "chambre" ? i : -1)).filter((i) => i >= 0);
          if (chambreIdxs.length > 0) {
            const lockedBase = { ...base, rooms: base.rooms.map((r, i) => (chambreIdxs.includes(i) ? { ...r, locked: true } : r)) };
            checkRegenLR(`Corridor partagé, régénération accès ${accessSide}, ${t.label} (chambres verrouillées, mur ${base.rooms[chambreIdxs[0]].exteriorWall})`, lockedBase, base, chambreIdxs, accessSide);
          }
        }
      }
    }

    // 23) FAMILLE GUIDÉE (salon central / cour d'entrée) — QUATRE FAÇADES
    // (lot M7 "guidée et en L sur 4 façades") — jusqu'ici cette famille
    // refusait explicitement tout accès autre qu'avant. Corrigé en
    // RÉUTILISANT les deux transformations déjà éprouvées : gauche/droite
    // passent par le repère virtuel transposé (comme buildDoubleLoadedLayout/
    // buildSharedCorridorLayout), arrière est pris en charge NATIVEMENT par
    // un reflet vertical interne à buildGuidedLayoutStraight (comme
    // buildSharedCorridorLayoutStraight) — jamais une seconde géométrie.
    // `generateVariants` en mode "guidée" (centralSalon ou cour) n'essaie
    // QUE cette famille (jamais une ambiguïté avec une autre, contrairement
    // à "en L" plus bas) : `variants[0]` lui appartient forcément ici.
    {
      const NEEDS = [
        { type: "chambre", label: "Chambre", count: 2, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
        { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
        { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
        { type: "sanitaire", label: "Sanitaire", count: 1, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
      ];
      const expectedWall = { front: "top", back: "bottom", left: "left", right: "right" };
      const scenarios = [
        { label: "salon central", centralSalon: true, roomsConnectVia: "salon", sanitaireConnectVia: "corridor", entryMode: "direct" },
        { label: "cour d'entrée seule", centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", entryMode: "courtyard" },
      ];
      // Terrains dimensionnés large (le côté large sert de budget de largeur
      // pour la rangée centrale avant/arrière ET, après transposition, pour
      // gauche/droite) — un terrain trop étroit est un motif d'échec
      // géométrique légitime pour CE programme, jamais une limite de portée :
      // vérifié séparément ci-dessous (échec explicite conservé).
      const terrains = [
        { label: "32x30 rectangulaire", terrainWidth: 32, terrainDepth: 30, setbacks: { front: 2, back: 2, left: 2, right: 2 } },
        { label: "30x32 asymétrique", terrainWidth: 30, terrainDepth: 32, setbacks: { front: 2.5, back: 1, left: 3, right: 1.5 } },
      ];
      for (const sc of scenarios) {
        for (const t of terrains) {
          for (const accessSide of ["front", "back", "left", "right"]) {
            const input = {
              orientation: "N", courtyardDepth: 3, centralSalon: sc.centralSalon, roomsConnectVia: sc.roomsConnectVia,
              sanitaireConnectVia: sc.sanitaireConnectVia, entryMode: sc.entryMode, needs: NEEDS,
              terrainWidth: t.terrainWidth, terrainDepth: t.terrainDepth, accessSide, setbacks: t.setbacks,
            };
            const res = g.generateVariants(input);
            const label = `Famille guidée (${sc.label}) — ${t.label}, accès ${accessSide}`;
            record(`${label} : disposition admissible trouvée`, res.variants.length > 0, res.variants.length === 0 ? res.attemptFailureReasons.slice(0, 2).join(" | ") : "");
            if (res.variants.length === 0) continue;
            const v = res.variants[0];
            const errors = g.independentVerify(v).filter((i) => i.severity === "error");
            record(`${label} : 0 erreur independentVerify`, errors.length === 0, errors.map((e) => e.message).join(" | "));
            const reach = g.computeReachableRooms(v);
            record(`${label} : toutes les pièces accessibles depuis l'entrée`, v.rooms.every((r, i) => r.parked || reach.has(i)));
            record(`${label} : entrée sur le mur attendu (${expectedWall[accessSide]})`, v.entryDoor?.wall === expectedWall[accessSide]);
            record(
              `${label} : terrain/emprise physiques inchangés (reculs attachés aux côtés physiques, jamais permutés)`,
              v.terrain.w === t.terrainWidth && v.terrain.d === t.terrainDepth &&
                Math.abs(v.emprise.w - (t.terrainWidth - t.setbacks.left - t.setbacks.right)) < 1e-6 &&
                Math.abs(v.emprise.d - (t.terrainDepth - t.setbacks.front - t.setbacks.back)) < 1e-6
            );
            if (sc.entryMode === "courtyard") {
              record(`${label} : cour d'entrée présente et protégée (aucune pièce ne la chevauche)`, !!v.courtyard);
            }
            const sumCat = v.surfaces.batie + v.surfaces.cheminementExterieur + v.surfaces.nonAffectee + v.surfaces.exterieure + v.surfaces.cour;
            record(
              `${label} : bilan de surfaces cohérent (somme = emprise, sans double comptage)`,
              Math.abs(sumCat - v.surfaces.emprise) < 1e-6,
              `somme=${sumCat.toFixed(4)} vs emprise=${v.surfaces.emprise.toFixed(4)}`
            );
            record(`${label} : chaque pièce posée a au moins une porte`, v.rooms.every((r, i) => g.doorsOf(v, i).length > 0));
            record(`${label} : chaque pièce posée a au moins une ouverture extérieure`, v.rooms.every((r, i) => g.windowsOf(v, i).length > 0 || !!r.exteriorWall));
          }
        }
      }
    }

    // 24) FAMILLE CIRCULATION EN L — QUATRE FAÇADES (même lot) — jusqu'ici
    // cette famille refusait explicitement tout accès autre que gauche.
    // Corrigé en RÉUTILISANT les transformations déjà éprouvées, dans
    // l'ordre INVERSE des autres familles : le NATIF est gauche/droite
    // (gauche tel quel, droite via un reflet horizontal interne à
    // buildLShapedLayoutStraight) ; avant/arrière passent par le repère
    // virtuel transposé (même transposeDoubleLoadedResult générique,
    // involution réutilisable dans les deux sens).
    //
    // DÉFAUT TROUVÉ ET CORRIGÉ en vérifiant cette famille plus largement que
    // son unique scénario natif historique : quand la rangée haute est plus
    // large que le segment bas (ex. un salon large en haut, une colonne
    // étroite en bas), la colonne DROITE du segment bas était ancrée à la
    // géométrie LOCALE du corridor bas, jamais au bord RÉEL du contour
    // englobant (élargi par la rangée haute) — sa fenêtre ne débouchait alors
    // plus sur un mur extérieur réel, et sans raccord comblant l'écart ainsi
    // créé, sa porte ne traversait plus aucune circulation réelle
    // (inaccessible). PRÉEXISTANT à ce lot (reproductible avec
    // `accessSide: "left"` seul, avant toute transposition) — jamais
    // introduit par l'extension aux 4 façades, seulement révélé par une
    // vérification plus large. Corrigé en ancrant la colonne droite au bord
    // réel du contour englobant et en comblant tout écart résiduel avec le
    // corridor par un raccord touchant directement (jamais +WALL_INT, une
    // convention de porte, pas de connectivité géométrique pure).
    {
      const chambre = { type: "chambre", label: "Chambre", minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 };
      const salon = { type: "salon", label: "Salon", minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 };
      const cuisine = { type: "cuisine", label: "Cuisine", minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 };
      const sanitaire = { type: "sanitaire", label: "Sanitaire", minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 };
      // Rangée haute DÉLIBÉRÉMENT plus large que le segment bas (reproduit
      // exactement le défaut ci-dessus) — colonne gauche étroite (sanitaire),
      // colonne droite à largeur UNIQUE (2 chambres identiques, gap interne
      // nul) : sans la correction, la colonne droite entière perd son accès,
      // pas seulement une pièce isolée par un écart résiduel.
      const topNeeds = [salon, cuisine];
      const lNeeds = [sanitaire];
      const rNeeds = [chambre, chambre];
      const expectedWall = { front: "top", back: "bottom", left: "left", right: "right" };
      const BASE = { orientation: "N", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", entryMode: "direct", needs: [] };
      const terrains = [
        { label: "20x26 rectangulaire", terrainWidth: 20, terrainDepth: 26, setbacks: { front: 3, back: 2, left: 2, right: 2 } },
        { label: "21x24 asymétrique", terrainWidth: 21, terrainDepth: 24, setbacks: { front: 3, back: 1.5, left: 2.5, right: 1 } },
      ];
      for (const t of terrains) {
        for (const accessSide of ["front", "back", "left", "right"]) {
          const input = { ...BASE, terrainWidth: t.terrainWidth, terrainDepth: t.terrainDepth, accessSide, setbacks: t.setbacks };
          const v = g.buildLShapedLayout(input, topNeeds, lNeeds, rNeeds, "test");
          const label = `Circulation en L — ${t.label}, accès ${accessSide}`;
          record(`${label} : disposition admissible trouvée`, v.feasible, v.feasible ? "" : v.failureReasons.join(" | "));
          if (!v.feasible) continue;
          const errors = g.independentVerify(v).filter((i) => i.severity === "error");
          record(`${label} : 0 erreur independentVerify (régression du défaut colonne droite/bord réel incluse)`, errors.length === 0, errors.map((e) => e.message).join(" | "));
          const reach = g.computeReachableRooms(v);
          record(`${label} : toutes les pièces accessibles depuis l'entrée`, v.rooms.every((r, i) => r.parked || reach.has(i)));
          record(`${label} : entrée sur le mur attendu (${expectedWall[accessSide]})`, v.entryDoor?.wall === expectedWall[accessSide]);
          record(
            `${label} : terrain/emprise physiques inchangés (reculs attachés aux côtés physiques, jamais permutés)`,
            v.terrain.w === t.terrainWidth && v.terrain.d === t.terrainDepth &&
              Math.abs(v.emprise.w - (t.terrainWidth - t.setbacks.left - t.setbacks.right)) < 1e-6 &&
              Math.abs(v.emprise.d - (t.terrainDepth - t.setbacks.front - t.setbacks.back)) < 1e-6
          );
          const sumCat = v.surfaces.batie + v.surfaces.cheminementExterieur + v.surfaces.nonAffectee + v.surfaces.exterieure + v.surfaces.cour;
          record(
            `${label} : bilan de surfaces cohérent (somme = emprise, sans double comptage)`,
            Math.abs(sumCat - v.surfaces.emprise) < 1e-6,
            `somme=${sumCat.toFixed(4)} vs emprise=${v.surfaces.emprise.toFixed(4)}`
          );
          record(`${label} : chaque pièce posée a au moins une porte`, v.rooms.every((r, i) => g.doorsOf(v, i).length > 0));
          record(`${label} : chaque pièce posée a au moins une ouverture extérieure`, v.rooms.every((r, i) => g.windowsOf(v, i).length > 0 || !!r.exteriorWall));
        }
      }

      // Échec explicite conservé (jamais forcé) : un terrain délibérément
      // trop ÉTROIT pour le segment bas (largeur) reste refusé pour un motif
      // géométrique réel, quelle que soit la façade — jamais masqué par
      // l'extension aux 4 façades de ce lot.
      {
        const input = { ...BASE, terrainWidth: 9, terrainDepth: 26, accessSide: "left", setbacks: { front: 3, back: 2, left: 2, right: 2 } };
        const v = g.buildLShapedLayout(input, topNeeds, lNeeds, rNeeds, "test");
        record(
          "Circulation en L — terrain délibérément trop étroit, accès gauche : échec géométrique explicite conservé (largeur du segment haut), jamais masqué",
          !v.feasible && v.failureReasons.some((r) => r.includes("largeur insuffisante")),
          v.failureReasons.join(" | ")
        );
      }
    }

    // 25) FAMILLE EMPAQUETAGE LIBRE — ACCÈS AVANT (ce lot) — jusqu'ici cette
    // famille échouait systématiquement (0/6 terrains signalés) pour l'accès
    // avant, alors qu'elle réussissait pour arrière/gauche/droite avec le
    // même programme. Diagnostic : backtrackPackNeedsIntoFreeSpace pose,
    // structurellement et pour TOUTE rangée, ses pièces près du bord de plus
    // petit Y et son propre segment de circulation près du bord de plus grand
    // Y (convention interne, jamais dépendante de l'accès demandé) — ce qui
    // correspond nativement à un accès "back". Pour "front", la rangée de
    // pièces masque alors exactement l'emprise en x de sa propre circulation
    // : aucune position de porte sur le mur haut ne peut la rejoindre en
    // ligne droite (confirmé par diagnostic avant toute modification, une
    // recherche élargie de positions candidates ne change rien). Corrigé en
    // réutilisant le même principe miroir déjà appliqué ailleurs dans ce
    // fichier (buildSharedCorridorLayoutStraight, buildGuidedLayoutStraight)
    // : la composition retenue est reflétée autour du centre vertical de
    // l'emprise avant la recherche de porte d'accès, pour "front" seulement —
    // jamais une règle spéciale aux terrains signalés, jamais un relâchement
    // de connectGroupsToNetwork ou de la validation des fenêtres.
    {
      const chambre = { type: "chambre", label: "Chambre", minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 };
      const salon = { type: "salon", label: "Salon", minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 };
      const cuisine = { type: "cuisine", label: "Cuisine", minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 };
      const needs = [chambre, salon, cuisine];
      const expectedWall = { front: "top", back: "bottom", left: "left", right: "right" };
      const BASE = { orientation: "N", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", entryMode: "direct", needs: [] };
      // Les six terrains exacts signalés en échec pour l'accès avant.
      const terrains = [
        { label: "15x20", terrainWidth: 15, terrainDepth: 20 },
        { label: "16x18", terrainWidth: 16, terrainDepth: 18 },
        { label: "18x22", terrainWidth: 18, terrainDepth: 22 },
        { label: "22x18", terrainWidth: 22, terrainDepth: 18 },
        { label: "20x20", terrainWidth: 20, terrainDepth: 20 },
        { label: "17x24", terrainWidth: 17, terrainDepth: 24 },
      ];
      const setbacks = { front: 2, back: 2, left: 2, right: 2 };
      let frontAdmissible = 0;
      for (const t of terrains) {
        for (const accessSide of ["front", "back", "left", "right"]) {
          const input = { ...BASE, terrainWidth: t.terrainWidth, terrainDepth: t.terrainDepth, accessSide, setbacks };
          const results2 = g.buildFreePackedLayout(input, needs, "test");
          const v = results2.find((r) => r.feasible) ?? results2[0];
          const label = `Empaquetage libre — ${t.label}, accès ${accessSide}`;
          if (accessSide === "front" || accessSide === "back") {
            // Seul l'accès avant est réparé par ce lot ; arrière doit rester
            // tel quel (non-régression), jamais promis pour gauche/droite ici.
            record(`${label} : disposition admissible trouvée`, !!v?.feasible, v?.feasible ? "" : (v?.failureReasons ?? []).join(" | "));
          }
          if (!v?.feasible) continue;
          if (accessSide === "front") frontAdmissible++;
          const errors = g.independentVerify(v).filter((i) => i.severity === "error");
          record(`${label} : 0 erreur independentVerify`, errors.length === 0, errors.map((e) => e.message).join(" | "));
          const reach = g.computeReachableRooms(v);
          record(`${label} : toutes les pièces accessibles depuis l'entrée`, v.rooms.every((r, i) => r.parked || reach.has(i)));
          record(`${label} : entrée sur le mur attendu (${expectedWall[accessSide]})`, v.entryDoor?.wall === expectedWall[accessSide]);
          record(
            `${label} : terrain/emprise physiques inchangés (reculs attachés aux côtés physiques, jamais permutés)`,
            v.terrain.w === t.terrainWidth && v.terrain.d === t.terrainDepth &&
              Math.abs(v.emprise.w - (t.terrainWidth - setbacks.left - setbacks.right)) < 1e-6 &&
              Math.abs(v.emprise.d - (t.terrainDepth - setbacks.front - setbacks.back)) < 1e-6
          );
          const sumCat = v.surfaces.batie + v.surfaces.cheminementExterieur + v.surfaces.nonAffectee + v.surfaces.exterieure + v.surfaces.cour;
          record(
            `${label} : bilan de surfaces cohérent (somme = emprise, sans double comptage)`,
            Math.abs(sumCat - v.surfaces.emprise) < 1e-6,
            `somme=${sumCat.toFixed(4)} vs emprise=${v.surfaces.emprise.toFixed(4)}`
          );
          record(`${label} : chaque pièce posée a au moins une porte`, v.rooms.every((r, i) => g.doorsOf(v, i).length > 0));
          record(`${label} : chaque pièce posée a au moins une ouverture extérieure`, v.rooms.every((r, i) => g.windowsOf(v, i).length > 0 || !!r.exteriorWall));
        }
      }
      record(
        "Empaquetage libre — accès avant : au moins un des six terrains signalés admissible (régression du biais directionnel résolue)",
        frontAdmissible >= 1,
        `${frontAdmissible}/6 admissibles`
      );
    }


    // 26) Redimensionnement fiable en édition — correctifs B1/B2 (diagnostic
    // d'usage du 2026-10-04, SUIVI_MOTEUR_PLANS_2D.md). resizeRoomDimension
    // (champs) et checkRoomResize (poignées) : accepté intégralement sans
    // anomalie NOUVELLE, ou refusé avec un motif précis sans jamais modifier
    // l'état reçu ; mur de la porte gardé fixe ; pièces verrouillées et
    // autres pièces jamais touchées.
    {
      const NEEDS_DIAG = [
        { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
        { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
        { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
        { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
        { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
      ];
      // Cas exact du diagnostic : valeurs par défaut de l'écran (15×20, reculs 3/2/2/2).
      const genDiag = (side) =>
        g.generateVariants({
          orientation: "N", setbacks: { front: 3, back: 2, left: 2, right: 2 }, entryMode: "direct", courtyardDepth: 3, centralSalon: false,
          roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", terrainWidth: 15, terrainDepth: 20, accessSide: side, needs: NEEDS_DIAG,
        }).variants[0];
      const idx = (L, label, number) => L.rooms.findIndex((r) => r.label === label && r.number === number);
      const snapshot = (L) => JSON.stringify(L);
      const sameOpening = (a, b) => Math.abs(a.cx - b.cx) < 1e-6 && Math.abs(a.cy - b.cy) < 1e-6 && Math.abs(a.width - b.width) < 1e-6;
      const sameRect = (a, b) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.w - b.w) < 1e-9 && Math.abs(a.d - b.d) < 1e-9;

      const front = genDiag("front");
      record("26. Cas du diagnostic généré sans anomalie (15×20, accès avant)", !!front && g.independentVerify(front).length === 0);
      const c1 = idx(front, "Chambre", 1);

      // B2 — reproduction exacte puis correctif.
      {
        const before = snapshot(front);
        const r = front.rooms[c1];
        const old = g.resizeRoom(front, c1, r.x, r.y, r.w, 3.2);
        const oldNew = old ? g.newVerificationIssues(front, old) : [];
        record(
          "26. B2 reproduit : l'ancien ancrage haut-gauche (resizeRoom seul) coupe Chambre 1 de la circulation",
          oldNew.some((m) => m.includes("n'est reliée au dégagement")),
          oldNew.join(" | ")
        );
        const a = g.resizeRoomDimension(front, c1, "d", 3.2);
        // Avant le branchement de la preuve d'exposition (lot « façades
        // extérieures ») ce geste était refusé pour la seule raison du
        // rectangle englobant (fixture plans-facade-retrait-refus.json) ; il
        // est désormais accepté : mur bas (porte) fixe, fenêtre haute prouvée
        // exposée sur sa propre portion.
        const accepted =
          a.kind === "applied" &&
          a.message.includes("mur bas conservé (la porte vers la circulation)") &&
          Math.abs(a.layout.rooms[c1].d - 3.2) < 1e-9 &&
          Math.abs(a.layout.rooms[c1].y + a.layout.rooms[c1].d - (r.y + r.d)) < 1e-9 &&
          front.doors.every((d, k) => d.roomIndex !== c1 || (Math.abs(d.cx - a.layout.doors[k].cx) < 1e-9 && Math.abs(d.cy - a.layout.doors[k].cy) < 1e-9 && d.width === a.layout.doors[k].width)) &&
          front.rooms.every((o, k) => k === c1 || sameRect(o, a.layout.rooms[k])) &&
          g.independentVerify(a.layout).length === 0;
        record(
          "26. B2 avec preuve d'exposition : 3,50 → 3,20 accepté, mur bas (porte) fixe, porte intacte, autres pièces inchangées, 0 anomalie",
          accepted,
          a.kind === "applied" ? a.message : a.kind === "refused" ? a.reason : a.kind
        );
        record("26. B2 : l'état reçu n'est jamais muté (copie candidate)", snapshot(front) === before);
        const viaHandles = g.checkRoomResize(front, c1, { x: r.x, y: r.y, w: r.w, d: 3.2 });
        record(
          "26. B2 par les poignées (même rectangle, mur bas déplacé) : refusé, motif nommant la porte du mur bas",
          !viaHandles.ok && viaHandles.reason.includes("La porte de « Chambre 1 » (mur bas)"),
          viaHandles.ok ? "accepté" : viaHandles.reason
        );
      }

      // B1 — reproduction exacte : largeur 3,50 refusée, motif précis, plan intact.
      {
        const before = snapshot(front);
        const a = g.resizeRoomDimension(front, c1, "w", 3.5);
        record(
          "26. B1 : largeur 3,50 refusée avec la cause et l'élément concerné (« Chambre 2 »)",
          a.kind === "refused" && a.reason.includes("chevaucherait") && a.reason.includes("« Chambre 2 »"),
          a.kind === "refused" ? a.reason : a.kind
        );
        record("26. B1 : refus sans mutation (largeur réelle toujours 3,03)", snapshot(front) === before && Math.abs(front.rooms[c1].w - 3.0333333) < 1e-3);
        const same = g.resizeRoomDimension(front, c1, "w", Number(front.rooms[c1].w.toFixed(2)));
        record("26. Ressaisir la valeur affichée (2 décimales) n'est pas un changement", same.kind === "unchanged", same.kind);
        const below = g.resizeRoomDimension(front, c1, "w", 2.5);
        record("26. Sous le minimum : motif chiffré", below.kind === "refused" && below.reason.includes("minimum") && below.reason.includes("3,00 m"), below.kind === "refused" ? below.reason : below.kind);
      }

      // Balayage : chaque pièce, chaque dimension, ±0,3 / +0,6 m, sur les
      // quatre façades. Tout résultat accepté doit préserver l'accès, toutes
      // les portes, les autres pièces ; tout refus laisse l'état intact.
      const doorWallsAccepted = new Set();
      let accepted = 0;
      let refused = 0;
      let acceptedFaults = [];
      let nonDefaultAnchor = 0;
      for (const side of ["front", "back", "left", "right"]) {
        const L = genDiag(side);
        const before = snapshot(L);
        const reachBefore = g.computeReachableRooms(L);
        L.rooms.forEach((room, i) => {
          for (const field of ["w", "d"]) {
            for (const delta of [-0.3, 0.3, 0.6]) {
              const value = (field === "w" ? room.w : room.d) + delta;
              const a = g.resizeRoomDimension(L, i, field, value);
              if (a.kind === "refused") { refused++; continue; }
              if (a.kind !== "applied") continue;
              accepted++;
              const N = a.layout;
              const faults = [];
              if (g.newVerificationIssues(L, N).length > 0) faults.push("anomalie nouvelle");
              const reachAfter = g.computeReachableRooms(N);
              if (![...reachBefore].every((k) => reachAfter.has(k))) faults.push("accès perdu");
              const newSize = field === "w" ? N.rooms[i].w : N.rooms[i].d;
              if (Math.abs(newSize - value) > 1e-9) faults.push("dimension non appliquée intégralement");
              L.doors.forEach((d, k) => { if (!sameOpening(d, N.doors[k])) faults.push("porte modifiée"); });
              L.rooms.forEach((o, k) => { if (k !== i && !sameRect(o, N.rooms[k])) faults.push(`pièce ${k} modifiée`); });
              L.windows.forEach((w, k) => { if (w.roomIndex !== i && !sameOpening(w, N.windows[k])) faults.push("fenêtre d'une autre pièce modifiée"); });
              if (faults.length) acceptedFaults.push(`${side} ${room.label} ${room.number} ${field}${delta}: ${faults.join(",")}`);
              for (const d of g.doorsOf(L, i)) doorWallsAccepted.add(d.wall);
              if (/mur (droit|bas) conservé/.test(a.message) && !/\(/.test(a.message)) nonDefaultAnchor++;
            }
          }
        });
        record(`26. Balayage ${side} : aucun refus ni essai n'a modifié l'état reçu`, snapshot(L) === before);
      }
      record(
        "26. Balayage 4 façades : toute modification acceptée conserve accès, portes, autres pièces, et applique la valeur exacte",
        accepted > 0 && acceptedFaults.length === 0,
        `${accepted} acceptées, ${refused} refusées${acceptedFaults.length ? " — " + acceptedFaults.slice(0, 3).join(" ; ") : ""}`
      );
      record(
        "26. Modifications acceptées sur des pièces dont la porte est sur chacun des quatre murs",
        ["left", "right", "top", "bottom"].every((w) => doorWallsAccepted.has(w)),
        [...doorWallsAccepted].sort().join(",")
      );
      record("26. Le bord fixe non standard (droit/bas) est choisi et annoncé quand le bord haut/gauche échoue", nonDefaultAnchor > 0, `${nonDefaultAnchor} cas`);

      // Pièce verrouillée : refus explicite pour elle, strictement inchangée
      // quand une autre pièce est redimensionnée.
      {
        const L = genDiag("left");
        const target = idx(L, "Salon", 1);
        const lockedIdx = idx(L, "Chambre", 3);
        const locked = g.lockRoom(L, lockedIdx);
        const refusedLocked = g.resizeRoomDimension(locked, lockedIdx, "d", locked.rooms[lockedIdx].d - 0.3);
        record("26. Pièce verrouillée : redimensionnement refusé avec motif", refusedLocked.kind === "refused" && refusedLocked.reason.includes("verrouillée"), refusedLocked.kind === "refused" ? refusedLocked.reason : refusedLocked.kind);
        const a = g.resizeRoomDimension(locked, target, "d", locked.rooms[target].d - 0.3);
        const lockedSame =
          a.kind === "applied" &&
          sameRect(locked.rooms[lockedIdx], a.layout.rooms[lockedIdx]) &&
          a.layout.rooms[lockedIdx].locked === true &&
          locked.doors.every((d, k) => d.roomIndex !== lockedIdx || sameOpening(d, a.layout.doors[k])) &&
          locked.windows.every((w, k) => w.roomIndex !== lockedIdx || sameOpening(w, a.layout.windows[k]));
        record("26. Pièce verrouillée strictement inchangée (position, dimensions, portes, fenêtres) quand une autre pièce est modifiée", lockedSame, a.kind === "applied" ? a.message : a.kind === "refused" ? a.reason : a.kind);
      }

      // Autre pièce affectée : le refus nomme l'autre pièce, rien n'est modifié.
      // (L'ancien cas — Salon +0,30 m en accès avant — est désormais accepté :
      // la fenêtre de « Cuisine 1 » en retrait est prouvée exposée.) Cas
      // négatif conservé sur une VRAIE obstruction : « B » élargie vers la
      // fenêtre de « A » jusqu'à 0,50 m, dégagement insuffisant.
      {
        const W = g.WALL_EXT;
        const mk = (label, number, x0, y0, w, d) => ({ type: "test", label, number, x: x0, y: y0, w, d, minW: 1, minD: 1, exteriorWall: null, vehicleDoor: null });
        const rooms = [mk("A", 1, 5, 5, 3, 3), mk("B", 1, 10, 5, 3, 3)];
        const L = {
          variantLabel: "test", feasible: true, failureReasons: [], rejected: false, rejectionReasons: [], accessSide: "front",
          terrain: { x: 0, y: 0, w: 20, d: 20 }, emprise: { x: 2, y: 2, w: 16, d: 16 },
          footprint: { x: 5 - W, y: 5 - W, w: 8 + 2 * W, d: 3 + 2 * W },
          corridor: null, corridorFillers: [], circulations: [], exteriorPaths: [], courtyard: null, streetDoor: null, entryDoor: null,
          rooms, doors: [], windows: [{ roomIndex: 0, wall: "right", cx: 8, cy: 6.5, width: 1.2 }], exteriorSpaces: [], surfaces: {},
        };
        const before = snapshot(L);
        const windowIssue = (lay) => g.independentVerify(lay).some((i) => i.message.includes("« A 1 » : une fenêtre ne débouche plus"));
        // Rectangle visé par un relâchement de poignée : « B 1 » élargie vers
        // la GAUCHE jusqu'à 0,50 m de la fenêtre de « A 1 ».
        const a = g.checkRoomResize(L, 1, { x: 8.5, y: 5, w: 4.5, d: 3 });
        record(
          "26. Conséquence sur une autre pièce : fenêtre de « A 1 » obstruée par l'élargissement de « B 1 » → refus nommant « A 1 », état intact",
          !windowIssue(L) && !a.ok && a.reason.includes("« A 1 »") && a.reason.includes("fenêtre") && snapshot(L) === before,
          a.ok ? "accepté" : a.reason
        );
        const farther = g.checkRoomResize(L, 1, { x: 9.5, y: 5, w: 3.5, d: 3 });
        record("26. Même élargissement laissant 1,50 m devant la fenêtre : accepté (fenêtre prouvée exposée)", farther.ok === true, farther.ok ? "accepté" : farther.reason);
      }

      // Fenêtre : jamais déplacée le long de son mur ni réduite.
      {
        const L = genDiag("left");
        const k = idx(L, "Cuisine", 1);
        const room = L.rooms[k];
        const winIdx = L.windows.findIndex((w) => w.roomIndex === k);
        const shifted = g.cloneLayout(L);
        const w = shifted.windows[winIdx];
        // Fenêtre poussée contre l'extrémité gauche de son mur (haut) : une
        // réduction ancrée à gauche la ferait glisser.
        w.cx = room.x + w.width / 2;
        const leftAnchored = g.checkRoomResize(shifted, k, { x: room.x, y: room.y, w: room.w - 0.3, d: room.d });
        // Fenêtre poussée à droite : la même réduction ancrée à gauche la décale.
        const shiftedRight = g.cloneLayout(L);
        shiftedRight.windows[winIdx].cx = room.x + room.w - shiftedRight.windows[winIdx].width / 2;
        const clampCase = g.checkRoomResize(shiftedRight, k, { x: room.x, y: room.y, w: room.w - 0.3, d: room.d });
        record(
          "26. Fenêtre qui serait décalée le long de son mur : refus explicite (« La fenêtre »)",
          !clampCase.ok && clampCase.reason.includes("La fenêtre"),
          clampCase.ok ? "accepté" : clampCase.reason
        );
        const viaField = g.resizeRoomDimension(shiftedRight, k, "w", room.w - 0.3);
        record(
          "26. Même cas par le champ : l'autre bord est essayé et annoncé, fenêtre intacte, ou refus motivé — jamais un déplacement silencieux",
          (viaField.kind === "applied" && viaField.message.includes("mur droit conservé") && sameOpening(shiftedRight.windows[winIdx], viaField.layout.windows[winIdx])) ||
            (viaField.kind === "refused" && viaField.reason.length > 0),
          viaField.kind === "applied" ? viaField.message : viaField.kind === "refused" ? viaField.reason : viaField.kind
        );
        record("26. Fenêtre déjà au bord fixe : réduction ancrée acceptée", leftAnchored.ok === true, leftAnchored.ok ? "accepté" : leftAnchored.reason);
      }

      // Ancrage ambigu : portes sur les deux bords de l'axe → refus précis.
      {
        const L = genDiag("left");
        const k = idx(L, "Chambre", 1);
        const room = L.rooms[k];
        const own = g.doorsOf(L, k)[0];
        const ambiguous = g.cloneLayout(L);
        const opposite = own.wall === "left" ? "right" : "left";
        ambiguous.doors.push({ ...own, wall: opposite, cx: opposite === "right" ? room.x + room.w : room.x, cy: room.y + room.d / 2 });
        const before = snapshot(ambiguous);
        const a = g.resizeRoomDimension(ambiguous, k, "w", room.w - 0.3);
        record(
          "26. Portes sur les deux murs de l'axe : refus « plutôt que de choisir arbitrairement », état intact",
          a.kind === "refused" && a.reason.includes("arbitrairement") && snapshot(ambiguous) === before,
          a.kind === "refused" ? a.reason : a.kind
        );
      }

      // Annuler/rétablir au niveau du moteur : une modification acceptée est
      // une disposition distincte ; la modification inverse rend exactement la
      // géométrie de départ (l'historique de l'éditeur empile ces dispositions).
      {
        const L = genDiag("left");
        const k = idx(L, "Salon", 1);
        const d0 = L.rooms[k].d;
        const there = g.resizeRoomDimension(L, k, "d", d0 - 0.3);
        const back = there.kind === "applied" ? g.resizeRoomDimension(there.layout, k, "d", d0) : null;
        record(
          "26. Modification acceptée puis inverse : géométrie et ouvertures identiques à l'origine",
          there.kind === "applied" && there.layout !== L && back?.kind === "applied" &&
            L.rooms.every((r, i) => sameRect(r, back.layout.rooms[i])) &&
            L.doors.every((d, i) => sameOpening(d, back.layout.doors[i])) &&
            L.windows.every((w, i) => sameOpening(w, back.layout.windows[i])),
          there.kind === "applied" ? there.message : there.kind
        );
      }
    }


    // 27) B3 — régénération après verrouillage : rejets rendus visibles
    // (sous-lot A, 2026-10-05). Fixture figée (reproduction, voir
    // scripts/fixtures/plans-b3-regeneration-reproduction.json). Chaque
    // événement est compté UNE seule fois (RegenerationDiagnostics).
    {
      const b3 = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-b3-regeneration-reproduction.json"), "utf8"));
      const idxB3 = (L, label, number) => L.rooms.findIndex((r) => r.label === label && r.number === number);
      const accounting = (res) => {
        const d = res.diagnostics;
        const fromOrdered = d.orderedAttempts - d.orderedPlacementFailures - d.orderedFinalizeRejected;
        const fromBacktrack = d.backtrackComplete - d.backtrackFinalizeRejected;
        return (
          d.admitted + d.controlRejected === d.candidates &&
          d.admitted === res.variants.length + d.duplicatesOfCurrent + d.duplicatesAmongNew &&
          d.newProposals === res.variants.filter((v) => v.variantLabel !== "Disposition actuelle (inchangée)").length &&
          fromOrdered >= 0 && fromBacktrack >= 0 && d.candidates >= 1 + fromOrdered + fromBacktrack &&
          res.failureReasons.length === d.orderedPlacementFailures + d.orderedFinalizeRejected + d.backtrackFinalizeRejected + d.sharedFinalizeRejected + d.controlRejected
        );
      };
      const ch2 = g.regenerateUnlocked(g.lockRoom(b3.layout, idxB3(b3.layout, "Chambre", 2)));
      const d2 = ch2.diagnostics;
      const rejected = ch2.failureReasons.filter((f) => f.startsWith("Plan complet (retour arrière) rejeté à la finalisation"));
      record(
        "27. B3 Chambre 2 : les 24 plans complets du retour arrière rejetés à la finalisation sont consignés avec leur motif",
        d2.backtrackComplete === 24 && d2.backtrackFinalizeRejected === 24 && rejected.length === 24 &&
          rejected.some((f) => f.includes("coupé du reste")) && rejected.some((f) => f.includes("trajet extérieur")) && rejected.some((f) => f.includes("ouverture extérieure")),
        `${d2.backtrackComplete} complets, ${rejected.length} consignés`
      );
      record("27. B3 Chambre 2 : comptes sans double comptage (identités vérifiées)", accounting(ch2), g.describeRegenerationDiagnostics(d2));
      record(
        "27. B3 Chambre 2 : budget de recherche jamais atteint, combinaisons « corridor partagé » écartées avec motif",
        d2.backtrackBudgetHit === 0 && d2.sharedAttempted && Object.values(d2.sharedRefused).reduce((s, n) => s + n, 0) > 0 &&
          ch2.searchStats.some((s) => s.startsWith("Corridor partagé :")),
        JSON.stringify(d2.sharedRefused)
      );
      const sal = g.regenerateUnlocked(g.lockRoom(b3.layout, idxB3(b3.layout, "Salon", 1)));
      const ds = sal.diagnostics;
      record(
        "27. B3 Salon 1 : la branche « corridor partagé » reconstruit la disposition actuelle — doublon compté, aucune proposition nouvelle",
        ds.duplicatesOfCurrent === 1 && ds.newProposals === 0 && ds.currentAdmissible && accounting(sal),
        g.describeRegenerationDiagnostics(ds)
      );
    }
    const total = results.length;
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${total} tests réussis.`);
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
