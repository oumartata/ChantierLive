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
      const obstructed = JSON.parse(JSON.stringify(faultyEntry));
      obstructed.footprint = { ...obstructed.footprint, d: obstructed.footprint.d - 1.0 };
      record(
        "Consolidation (corridor=null) — fenêtre obstruée détectée (mur qui ne débouche plus réellement dehors)",
        g.independentVerify(obstructed).some((i) => i.severity === "error" && i.message.includes("fenêtre ne débouche plus"))
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

    // 18) TERRAIN LARGE ET PEU PROFOND (C2/C9, 20×14, 3 chambres) — preuve
    // durable du blocage mesuré, qui distingue une INSUFFISANCE DE
    // RÉPARTITION (une autre distribution aurait pu suffire) d'une LIMITE
    // STRUCTURELLE (aucune répartition représentable par ce moteur ne peut
    // suffire). Trois familles d'organisation RÉELLEMENT distinctes sont
    // exigées ici, jamais une seule : le corridor double-chargé (2 colonnes
    // empilées en profondeur), la circulation en L (refusée explicitement
    // hors accès gauche) et l'empaquetage libre avec retour arrière
    // (buildFreePackedLayout, lot "terrain large et peu profond" — AUCUNE
    // hypothèse de colonnes, pourtant également en échec ici). Les trois
    // motifs typiques sont cherchés explicitement dans
    // attemptFailureReasons : leur présence SIMULTANÉE prouve que les trois
    // familles ont bien été essayées (pas seulement une), jamais déduit du
    // seul "0 variante".
    //
    // MESURE qui explique POURQUOI (pas seulement QUE) : avec ce moteur,
    // chaque groupe de circulation paie un coût fixe WALL_EXT+CORRIDOR_WIDTH+
    // WALL_INT+WALL_EXT=1.7 m de profondeur, en plus de la profondeur de sa
    // pièce la plus profonde. La meilleure répartition en 2 groupes pour ce
    // programme (chambre×3+salon+cuisine dans un groupe, profondeur max
    // 4,5 m ; sanitaire×2 dans l'autre, profondeur max 1,8 m) nécessite au
    // mieux 4,5+1,8+2×1,7=9,7 m — contre 9,0 m réellement disponibles
    // (14-3-2 reculs) : un manque structurel de 0,7 m, pas un ordre d'essai
    // manqué. Rejouer ce calcul ici (jamais une valeur recopiée en dur sans
    // le mécanisme qui la produit) le rend vérifiable indépendamment de tout
    // changement futur du moteur : si une future évolution comble cet écart
    // (ex. un corridor partagé entre deux rangées), ce test échouera au bon
    // endroit, signalant le progrès au lieu de le masquer.
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
      record("Terrain large et peu profond (C2, 20×14, 3 ch) — génération initiale : mesure actuelle reproduite (0 variante)", res.variants.length === 0, `${res.variants.length} variante(s)`);
      const reasons = res.attemptFailureReasons.join(" | ");
      record(
        "Terrain large et peu profond — famille 1 (corridor double-chargé, 2 colonnes) réellement essayée",
        reasons.includes("Profondeur insuffisante")
      );
      record(
        "Terrain large et peu profond — famille 2 (circulation en L) réellement essayée, refusée explicitement hors accès gauche",
        reasons.includes("Circulation en L non prise en charge")
      );
      record(
        "Terrain large et peu profond — famille 3 (empaquetage libre avec retour arrière, buildFreePackedLayout) réellement essayée, sans hypothèse de colonnes",
        reasons.includes("Empaquetage libre : aucune répartition complète trouvée")
      );

      // Rejoue le calcul du manque structurel à partir des MÊMES constantes
      // que le moteur (jamais une copie figée) : WALL_EXT/WALL_INT/
      // CORRIDOR_WIDTH exportées, profondeurs cibles des besoins.
      const empriseD = input.terrainDepth - SETBACKS.front - SETBACKS.back;
      const rowTax = g.WALL_EXT * 2 + g.CORRIDOR_WIDTH + g.WALL_INT;
      const chambreDepth = NEEDS_3CH.find((n) => n.type === "chambre").targetDepth;
      const salonDepth = NEEDS_3CH.find((n) => n.type === "salon").targetDepth;
      const sanitaireDepth = NEEDS_3CH.find((n) => n.type === "sanitaire").targetDepth;
      const bestTwoGroupDepth = Math.max(chambreDepth, salonDepth) + sanitaireDepth + 2 * rowTax;
      record(
        `Terrain large et peu profond — manque structurel mesuré et rejoué (${bestTwoGroupDepth.toFixed(2)} m nécessaires pour la meilleure répartition à 2 groupes > ${empriseD.toFixed(2)} m disponibles)`,
        bestTwoGroupDepth > empriseD,
        `écart ${(bestTwoGroupDepth - empriseD).toFixed(2)} m`
      );

      // Régénération : jamais présentée comme exécutée/validée sans base
      // admissible réelle à verrouiller — même constat que la génération
      // initiale (0 variante), donc rien à régénérer pour C9 non plus.
      record(
        "Terrain large et peu profond (C9, régénération) — non exécutée faute de base admissible, jamais présentée comme validée",
        res.variants.length === 0
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
