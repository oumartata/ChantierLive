// Ensemble FIXE de cas déterministes pour évaluer la génération et la
// régénération du moteur de plans prototype (lot "évaluer et améliorer la
// génération sur un ensemble fixe de cas"). Un outil de MESURE et de
// comparaison avant/après, pas une suite d'assertions pass/fail : plusieurs
// cas sont volontairement de faisabilité INCONNUE a priori, et un résultat
// "0 variante" y est une mesure légitime, jamais un échec de ce script.
// Jamais modifié après coup pour améliorer un résultat : toute évolution de
// ces cas doit être un lot séparé, explicitement justifié.
//
// Catégories (voir chaque cas ci-dessous) :
// - "connu"                : solution déjà vérifiée ailleurs, attendue ici.
// - "inconnu"               : faisabilité non déterminée a priori — ce
//   script sert justement à la mesurer, honnêtement, sans présumer.
// - "incompatible_demontre" : incompatibilité DÉMONTRÉE par un garde-fou
//   explicite du moteur (message précis, pas une recherche qui abandonne).
// - "hors_perimetre"        : combinaison explicitement hors du périmètre
//   déclaré de ce moteur général (ex. accès véhicule direct).
//
// Génération initiale (generateVariants) et régénération après verrou
// (regenerateUnlocked) sont TOUJOURS mesurées séparément : un refus attendu
// n'est jamais compté comme une réussite de génération, et l'échec de l'une
// n'est jamais confondu avec l'échec de l'autre.
//
// Usage : node scripts/test-plans-battery.mjs  (ou : npm run test:plans:battery)

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const geometrySourceRelative = join("src", "app", "prototype-plans", "geometry.ts");

const tmpDir = mkdtempSync(join(tmpdir(), "plans-battery-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(
    `"${tscBin}" "${geometrySourceRelative}" --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`,
    { shell: true, encoding: "utf8", cwd: repoRoot }
  );
  if (compile.status !== 0) {
    console.error("Échec de la compilation de geometry.ts pour la batterie :");
    console.error(compile.stdout);
    console.error(compile.stderr);
    process.exitCode = 1;
  } else {
    const g = await import(pathToFileURL(join(tmpDir, "geometry.js")).href);

    const SETBACKS = { front: 3, back: 2, left: 2, right: 2 };
    const NEEDS_2CH = [
      { type: "chambre", label: "Chambre", count: 2, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
      { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
      { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
      { type: "sanitaire", label: "Sanitaire", count: 1, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
      { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
    ];
    const NEEDS_3CH = [
      { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
      { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
      { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
      { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
      { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
    ];
    const NEEDS_3CH_GARAGE = NEEDS_3CH.map((n) => (n.type === "garage" ? { ...n, count: 1 } : n));
    const BASE = { orientation: "N", setbacks: SETBACKS, entryMode: "direct", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor" };

    // Cas FIXES — terrains/programmes/accès variés, couvrant le périmètre
    // déclaré. C4 utilise sanitaireConnectVia:"corridor" (comme la
    // Référence 2, déjà connue admissible), jamais "salon" (qui reproduirait
    // simplement l'incompatibilité démontrée de la Référence 3 sous un autre
    // nom) : un choix de conception fait AVANT toute mesure, pas ajusté
    // après coup.
    const CASES = [
      { id: "C1", desc: "Standard 15x20, avant, direct, 2 ch, corridor", category: "connu", regen: false,
        input: { ...BASE, terrainWidth: 15, terrainDepth: 20, accessSide: "front", needs: NEEDS_2CH } },
      { id: "C2", desc: "Large peu profond 20x14, avant, direct, 3 ch, corridor", category: "inconnu", regen: false,
        input: { ...BASE, terrainWidth: 20, terrainDepth: 14, accessSide: "front", needs: NEEDS_3CH } },
      // Terrain CORRIGÉ dans ce lot (15x26, pas 12x26) : la largeur de 12 m
      // s'est révélée, une fois la connexion entrée-corridor par accès
      // latéral réellement vérifiée (lot "transposition"), géométriquement
      // insuffisante pour ce programme avec un accès gauche — ni le corridor
      // en L ni le double-chargé pivoté ne tenaient dans les 8 m de largeur
      // utile restants (12 - 2 - 2). Le "succès" précédemment mesuré à cette
      // largeur ne provenait PAS d'un accès gauche réellement raccordé : il
      // profitait d'un cas particulier (l'entrée tombait par coïncidence sur
      // le salon, seule pièce acceptée sans toucher la circulation) jamais
      // conçu pour accréditer un accès latéral générique — corrigé en même
      // temps que le bug qui le permettait. 15x26 reste "étroit profond"
      // (comparé aux 15x20 des autres cas) tout en laissant une largeur
      // utile réellement suffisante (11 m) pour un accès gauche authentique.
      { id: "C3", desc: "Étroit profond 15x26, gauche, direct, 2 ch, corridor (L possible)", category: "connu", regen: false,
        input: { ...BASE, terrainWidth: 15, terrainDepth: 26, accessSide: "left", needs: NEEDS_2CH } },
      { id: "C4", desc: "Salon central (sans cour), 15x20, avant, 2 ch", category: "connu", regen: false,
        input: { ...BASE, terrainWidth: 15, terrainDepth: 20, accessSide: "front", centralSalon: true, roomsConnectVia: "salon", sanitaireConnectVia: "corridor", needs: NEEDS_2CH } },
      { id: "C5", desc: "Cour d'entrée seule (sans salon central), 15x22, avant, 2 ch", category: "inconnu", regen: false,
        input: { ...BASE, terrainWidth: 15, terrainDepth: 22, accessSide: "front", entryMode: "courtyard", needs: NEEDS_2CH } },
      { id: "C6", desc: "Incompatibilité démontrée (reprise Référence 3) : cour + salon central + 3 ch, 15x20", category: "incompatible_demontre", regen: false,
        input: { ...BASE, terrainWidth: 15, terrainDepth: 20, accessSide: "front", entryMode: "courtyard", centralSalon: true, roomsConnectVia: "salon", sanitaireConnectVia: "salon", needs: NEEDS_3CH } },
      { id: "C7", desc: "Hors périmètre déclaré (reprise Référence 5) : garage avec accès véhicule, avant", category: "hors_perimetre", regen: false,
        input: { ...BASE, terrainWidth: 15, terrainDepth: 20, accessSide: "front", needs: NEEDS_3CH_GARAGE } },
      { id: "C8", desc: "Standard 15x20, avant, 3 ch, AVEC verrou (régénération)", category: "connu", regen: true,
        input: { ...BASE, terrainWidth: 15, terrainDepth: 20, accessSide: "front", needs: NEEDS_3CH } },
      { id: "C9", desc: "Large peu profond 20x14, 3 ch, AVEC verrou (régénération)", category: "inconnu", regen: true,
        input: { ...BASE, terrainWidth: 20, terrainDepth: 14, accessSide: "front", needs: NEEDS_3CH } },
      { id: "C10", desc: "Accès droite, 15x20, direct, 2 ch, corridor", category: "inconnu", regen: false,
        input: { ...BASE, terrainWidth: 15, terrainDepth: 20, accessSide: "right", needs: NEEDS_2CH } },
      { id: "C11", desc: "Accès arrière, 15x20, direct, 2 ch, corridor", category: "inconnu", regen: false,
        input: { ...BASE, terrainWidth: 15, terrainDepth: 20, accessSide: "back", needs: NEEDS_2CH } },
    ];

    function programOf(needs) {
      const p = {};
      needs.forEach((n) => { if (n.count > 0) p[n.type] = n.count; });
      return p;
    }
    function checkProgram(layout, expectedProgram) {
      const counts = {};
      layout.rooms.forEach((r) => { if (!r.parked) counts[r.type] = (counts[r.type] || 0) + 1; });
      return Object.entries(expectedProgram).every(([t, n]) => counts[t] === n);
    }
    function dominantFailure(reasons) {
      const cat = { placement: 0, stranded: 0, window: 0, width_or_depth: 0, other: 0 };
      for (const r of reasons) {
        if (r.includes("n'a pas trouvé de place")) cat.placement++;
        else if (r.includes("segment de circulation réellement coupé")) cat.stranded++;
        else if (r.includes("ouverture extérieure") || r.includes("candidat invalide")) cat.window++;
        else if (r.includes("Largeur insuffisante") || r.includes("Profondeur insuffisante")) cat.width_or_depth++;
        else cat.other++;
      }
      const sorted = Object.entries(cat).sort((a, b) => b[1] - a[1]);
      return sorted[0][1] > 0 ? `${sorted[0][0]} (${sorted[0][1]})` : "aucun";
    }

    const results = [];
    for (const c of CASES) {
      const t0 = Date.now();
      const gen = g.generateVariants(c.input);
      const genTime = Date.now() - t0;
      const expectedProgram = programOf(c.input.needs);
      const genOk = gen.variants.length > 0;
      const genComplete = genOk && checkProgram(gen.variants[0], expectedProgram);

      let regenInfo = null;
      if (c.regen && genOk) {
        const base = gen.variants[0];
        const lockIdx = base.rooms.findIndex((r) => r.type === "chambre");
        const locked = g.lockRoom(base, lockIdx);
        const t1 = Date.now();
        const regen = g.regenerateUnlocked(locked);
        const regenTime = Date.now() - t1;
        const newOnes = regen.variants.filter((v) => v.variantLabel !== "Disposition actuelle (inchangée)");
        regenInfo = {
          time: regenTime,
          newCount: newOnes.length,
          newSurfaces: newOnes.map((v) => ({ circulation: +v.surfaces.circulation.toFixed(2), ext: +v.surfaces.cheminementExterieur.toFixed(2) })),
          dominantFailure: dominantFailure(regen.failureReasons),
          failureCount: regen.failureReasons.length,
          budgetHit: regen.searchStats.some((s) => s.includes("budget de recherche atteint")),
        };
      } else if (c.regen && !genOk) {
        regenInfo = { skipped: true };
      }

      results.push({
        id: c.id, desc: c.desc, category: c.category,
        genTime, genVariantCount: gen.variants.length, genComplete,
        genDominantFailure: dominantFailure(gen.attemptFailureReasons || []),
        genCirculation: genOk ? +gen.variants[0].surfaces.circulation.toFixed(2) : null,
        genExt: genOk ? +gen.variants[0].surfaces.cheminementExterieur.toFixed(2) : null,
        regen: regenInfo,
      });
    }

    for (const r of results) {
      console.log(`\n=== ${r.id} (${r.category}) — ${r.desc} ===`);
      console.log(
        `  Génération : ${r.genVariantCount} variante(s), ${r.genTime}ms, programme complet=${r.genComplete}, circulation=${r.genCirculation}, ext=${r.genExt}, motif dominant d'échec=${r.genDominantFailure}`
      );
      if (r.regen?.skipped) {
        console.log("  Régénération : non testée (génération initiale déjà sans solution — rien à verrouiller).");
      } else if (r.regen) {
        console.log(
          `  Régénération : ${r.regen.newCount} nouvelle(s) variante(s) [${r.regen.newSurfaces.map((s) => s.circulation).join(",")}], ${r.regen.time}ms, budget atteint=${r.regen.budgetHit}, motif dominant d'échec=${r.regen.dominantFailure} (${r.regen.failureCount} tentatives)`
        );
      }
    }
    console.log(`\n${results.length} cas mesurés. Rappel : "0 variante" sur un cas "inconnu" ou "incompatible_demontre"/"hors_perimetre" est une mesure attendue, jamais un échec de cette batterie.`);
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
