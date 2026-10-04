// Preuve isolée — reconnaissance des façades extérieures (lot du 2026-10-04,
// SUIVI_MOTEUR_PLANS_2D.md). Compare, cas par cas, la règle ACTUELLE (mur
// extérieur seulement s'il touche le rectangle englobant, via
// chooseExteriorWindow, fonction réellement utilisée par le moteur) et la
// classification PROPOSÉE (src/app/prototype-plans/exteriorExposure.ts, non
// branchée). Pour chaque cas : attendu, obtenu, raison géométrique.
//
// Usage : node scripts/test-plans-exterior-exposure.mjs

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

const tmpDir = mkdtempSync(join(tmpdir(), "plans-exposure-test-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const sources = ["geometry.ts", "exteriorExposure.ts"].map((f) => `"${join("src", "app", "prototype-plans", f)}"`).join(" ");
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
    const x = await import(pathToFileURL(join(tmpDir, "exteriorExposure.js")).href);

    // Règle actuelle, par la fonction réellement utilisée par le moteur.
    const currentSaysExterior = (L, i, wall) => {
      const r = L.rooms[i];
      const c = g.chooseExteriorWindow({ x: r.x, y: r.y, w: r.w, d: r.d }, L.footprint, [], wall);
      return !!c && c.wall === wall;
    };
    const spanOf = (o) => {
      const v = o.wall === "left" || o.wall === "right";
      const c = v ? o.cy : o.cx;
      return { alongMin: c - o.width / 2, alongMax: c + o.width / 2 };
    };
    const centralHalf = (r, wall) => {
      const v = wall === "left" || wall === "right";
      return v ? { alongMin: r.y + r.d / 4, alongMax: r.y + (3 * r.d) / 4 } : { alongMin: r.x + r.w / 4, alongMax: r.x + (3 * r.w) / 4 };
    };
    const table = [];
    function check(name, expected, L, i, wall, span, why) {
      const got = x.classifyWallExposure(L, i, wall, span);
      const cur = currentSaysExterior(L, i, wall) ? "extérieur" : "refusé";
      table.push({ name, expected, got: got.kind, current: cur, reason: got.reason });
      record(`${name} : attendu ${expected}, obtenu ${got.kind} (règle actuelle : ${cur})`, got.kind === expected, `${got.reason}${why ? " | " + why : ""} ${JSON.stringify(got.evidence)}`);
      return got;
    }

    // Disposition manuelle minimale (seuls les champs lus par la preuve et
    // par chooseExteriorWindow) : murs implicites WALL_INT entre pièces.
    function manual(rooms, terrain = { x: 0, y: 0, w: 20, d: 20 }, courtyard = null) {
      const placed = rooms.map(([label, x0, y0, w, d], k) => ({ type: "test", label, number: k + 1, x: x0, y: y0, w, d, minW: 1, minD: 1, exteriorWall: null, vehicleDoor: null }));
      const xs = placed.map((r) => r.x), ys = placed.map((r) => r.y);
      const maxX = Math.max(...placed.map((r) => r.x + r.w)), maxY = Math.max(...placed.map((r) => r.y + r.d));
      const footprint = { x: Math.min(...xs) - g.WALL_EXT, y: Math.min(...ys) - g.WALL_EXT, w: maxX - Math.min(...xs) + 2 * g.WALL_EXT, d: maxY - Math.min(...ys) + 2 * g.WALL_EXT };
      return { terrain, emprise: { x: 2, y: 2, w: terrain.w - 4, d: terrain.d - 4 }, footprint, corridor: null, corridorFillers: [], circulations: [], exteriorPaths: [], courtyard, rooms: placed, doors: [], windows: [] };
    }

    // ---- 1. Refus actuel reproduit depuis la fixture figée AVANT modification.
    const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-facade-retrait-refus.json"), "utf8"));
    const L = fx.layout;
    const i1 = fx.roomIndex;
    const replay = g.resizeRoomDimension(L, i1, fx.gesture.field, fx.gesture.to);
    record("1. Fixture : le refus actuel est reproduit à l'identique (geste et motif figés)", replay.kind === "refused" && replay.reason === fx.observedRefusal, replay.reason);
    const r1 = L.rooms[i1];
    const candidate = g.resizeRoom(L, i1, r1.x, r1.y + (r1.d - fx.gesture.to), r1.w, fx.gesture.to);
    const newIssues = g.newVerificationIssues(L, candidate);
    record(
      "1. Cause isolée : seules des anomalies d'« extérieur » (rectangle englobant) motivent le refus",
      newIssues.length > 0 && newIssues.every((m) => /ouverture extérieure possible|ne débouche plus sur un mur extérieur/.test(m)),
      newIssues.join(" | ")
    );
    const win1 = candidate.windows.find((w) => w.roomIndex === i1);

    // ---- 2. Cas ciblés.
    const rect = check("Bâtiment rectangulaire simple — fenêtre de Chambre 1 (avant geste)", "exterieur", L, i1, L.windows.find((w) => w.roomIndex === i1).wall, spanOf(L.windows.find((w) => w.roomIndex === i1)));
    void rect;
    check("Façade en retrait réellement exposée — fenêtre de Chambre 1 après réduction 3,50 → 3,20 (mur bas fixe)", "exterieur", candidate, i1, win1.wall, spanOf(win1), "retrait de 0,30 m ouvert vers le recul avant");
    check("Façade en retrait — mur entier (extrémités contre l'épaisseur des chambres voisines)", "obstruee", candidate, i1, win1.wall, undefined, "la preuve porte sur la portion d'ouverture, pas sur tout le mur");

    const c2 = L.rooms.findIndex((r) => r.label === "Chambre" && r.number === 2);
    const c3 = L.rooms.findIndex((r) => r.label === "Chambre" && r.number === 3);
    const Lshape = g.parkRoom(L, c3);
    check("Bâtiment en L (Chambre 3 retirée) — portion centrale du mur droit de Chambre 2", "exterieur", Lshape, c2, "right", centralHalf(Lshape.rooms[c2], "right"), "angle rentrant ouvert vers l'extérieur");

    const NEEDS_C = [
      { type: "chambre", label: "Chambre", count: 2, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
      { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
      { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
      { type: "sanitaire", label: "Sanitaire", count: 1, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
      { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
    ];
    const withCourt = g.generateVariants({
      orientation: "N", setbacks: { front: 3, back: 2, left: 2, right: 2 }, entryMode: "courtyard", courtyardDepth: 3, centralSalon: false,
      roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", terrainWidth: 15, terrainDepth: 25, accessSide: "front", needs: NEEDS_C,
    }).variants[0];
    const ch1c = withCourt.rooms.findIndex((r) => r.label === "Chambre" && r.number === 1);
    check("Cour identifiée — mur haut de Chambre 1, au contact de la cour", "cour", withCourt, ch1c, "top", undefined, "la règle actuelle ne distingue pas cour et extérieur");

    // Vide intérieur fermé : anneau de 4 pièces autour d'un vide de 3 × 2,9 m.
    const ring = manual([
      ["Nord", 5, 5, 8, 3],
      ["Sud", 5, 11.1, 8, 3],
      ["Ouest", 5, 8.1, 3, 2.9],
      ["Est", 11, 8.1, 2, 2.9],
    ]);
    check("Vide intérieur fermé — mur droit de « Ouest » face au vide enclos", "vide_interieur", ring, 2, "right", centralHalf(ring.rooms[2], "right"), "aucun chemin libre jusqu'à la limite du terrain");
    const ringOpen = manual([
      ["Nord", 5, 5, 8, 3],
      ["Sud", 5, 11.1, 8, 3],
      ["Ouest", 5, 8.1, 3, 2.9],
    ]);
    check("Même vide ouvert d'un côté (pièce « Est » absente) — mur droit de « Ouest »", "exterieur", ringOpen, 2, "right", centralHalf(ringOpen.rooms[2], "right"), "le vide communique avec l'extérieur sur 2,9 m");

    // Fenêtre obstruée par une pièce ou une circulation.
    check("Mur mitoyen d'une autre pièce — mur droit de Chambre 1", "separation", L, i1, "right", undefined, "interstice de cloison WALL_INT");
    check("Mur mitoyen de la circulation — mur bas de Chambre 1", "separation", L, i1, "bottom", undefined, "porte vers la circulation");
    const near = manual([
      ["A", 5, 5, 3, 3],
      ["B", 8.5, 5, 3, 3],
    ]);
    check("Pièce voisine à 0,50 m (au-delà d'une cloison) — mur droit de A", "obstruee", near, 0, "right", undefined, "dégagement de 0,50 m < épaisseur + dégagement minimal");

    // Petits interstices de représentation des murs.
    for (const gap of [0.1, 0.3, 0.38]) {
      const pair = manual([
        ["A", 5, 5, 3, 3],
        ["B", 8 + gap, 5, 3, 3],
      ]);
      const expected = gap <= 0.32 ? "separation" : "obstruee";
      check(`Interstice de ${gap.toFixed(2)} m entre deux pièces — mur droit de A`, expected, pair, 0, "right", undefined, "un interstice de mur n'est jamais un extérieur");
    }

    // Incertitude explicite : dégagement au-delà de la limite du terrain.
    const atEdge = manual([["Bord", 0.1, 5, 3, 3]], { x: 0, y: 0, w: 20, d: 20 });
    check("Pièce contre la limite du terrain (recul nul) — mur gauche", "non_classe", atEdge, 0, "left", undefined, "ce qui est au-delà du terrain n'est pas représenté");

    // ---- 3. Non-régression : toutes les fenêtres générées aujourd'hui restent
    // démontrées extérieures (64 configurations).
    const NEEDS = fx.generationInput.needs;
    let total = 0;
    const disagreements = [];
    for (const side of ["front", "back", "left", "right"]) {
      for (const [W, D] of [[15, 20], [20, 14], [12, 25], [18, 18]]) {
        for (const entryMode of ["direct", "courtyard"]) {
          for (const centralSalon of [false, true]) {
            const res = g.generateVariants({ ...fx.generationInput, accessSide: side, terrainWidth: W, terrainDepth: D, entryMode, centralSalon, needs: NEEDS });
            for (const V of res.variants) {
              const grid = x.buildExposureGrid(V);
              for (const w of V.windows) {
                total++;
                const k = x.classifyWallExposure(V, w.roomIndex, w.wall, spanOf(w), grid);
                if (k.kind !== "exterieur" && k.kind !== "cour") disagreements.push(`${side} ${W}×${D} ${entryMode} ${V.rooms[w.roomIndex].label} ${w.wall}: ${k.kind}`);
              }
            }
          }
        }
      }
    }
    record(
      "3. Non-régression : chaque fenêtre générée (64 configurations) reste démontrée extérieure ou sur cour",
      total > 0 && disagreements.length === 0,
      `${total} fenêtres${disagreements.length ? " — " + disagreements.slice(0, 3).join(" ; ") : ""}`
    );

    console.log("\nTableau des cas (attendu | obtenu | règle actuelle | raison) :");
    for (const t of table) console.log(`- ${t.name} | ${t.expected} | ${t.got} | ${t.current} | ${t.reason}`);
    console.log(`\n${results.filter(Boolean).length}/${results.length} tests réussis.`);
    if (!results.every(Boolean)) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
