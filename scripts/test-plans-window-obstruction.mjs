// Diagnostic — obstruction des fenêtres (2026-10-06, SUIVI_MOTEUR_PLANS_2D.md).
// Compare, pour une fenêtre donnée, trois contrôles EXISTANTS :
//  - le vérificateur indépendant (independentVerify : mur qui touche le
//    contour englobant, OU exposition prouvée de la baie) ;
//  - la sonde d'obstruction de l'outil Fenêtre et de la génération
//    (doorOutsideProbe, 0,32 m devant la baie, contre pièces, circulations
//    ET cheminements extérieurs — reproduite ici à l'identique, la fonction
//    n'étant pas exportée) ; le verdict complet de l'outil (placeWindow) est
//    aussi relevé ;
//  - la preuve d'exposition (classifyWallExposure, qui ne compte PAS les
//    cheminements extérieurs comme du bâti).
//
// Assertions : seulement des invariants voulus (plans de départ admissibles ;
// concordance des trois contrôles quand c'est du BÂTI qui se trouve devant la
// fenêtre ; concordance au-delà de la sonde ; aucune autre anomalie qui
// masquerait le résultat). Cas « cheminement extérieur » : la convention du
// prototype est CONSERVÉE par décision explicite (2026-10-06) — l'outil (et
// le choix automatique) refusent une fenêtre dont la sonde de dégagement est
// occupée par un tel passage, motif EXTERIOR_PATH_CLEARANCE_REASON, tandis que
// le vérificateur indépendant n'ajoute aucun refus. Ces deux points sont
// désormais assertés, y compris après export/réimport du fichier de projet.
//
// Usage : node scripts/test-plans-window-obstruction.mjs

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

const tmpDir = mkdtempSync(join(tmpdir(), "plans-window-obstruction-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const sources = ["geometry.ts", "exteriorExposure.ts", "projectFile.ts"].map((f) => `"${join("src", "app", "prototype-plans", f)}"`).join(" ");
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
    const pf = await import(pathToFileURL(join(tmpDir, "projectFile.js")).href);
    const roundTrip = (L) => {
      const back = pf.validateProjectFile(JSON.parse(JSON.stringify(pf.serializeProject(L, "N"))));
      if (!back.ok) throw new Error(back.error);
      return back.value.layout;
    };

    const base = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-b3-regeneration-reproduction.json"), "utf8")).layout;
    const pathFixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-window-obstruction-exterior-path.json"), "utf8")).layout;
    const idx = (L, label, number) => L.rooms.findIndex((r) => r.label === label && r.number === number);
    const msgs = (L) => g.independentVerify(L).map((i) => `${i.severity}:${i.message}`);

    // Même géométrie que doorOutsideProbe (geometry.ts) : profondeur
    // ADJACENCY_TOLERANCE = WALL_EXT + WALL_INT + 0,02 devant la baie.
    const TOL = g.WALL_EXT + g.WALL_INT + 0.02;
    const probeOf = (w) => {
      const h = w.width / 2;
      if (w.wall === "right") return { x: w.cx, y: w.cy - h, w: TOL, d: w.width };
      if (w.wall === "left") return { x: w.cx - TOL, y: w.cy - h, w: TOL, d: w.width };
      if (w.wall === "top") return { x: w.cx - h, y: w.cy - TOL, w: w.width, d: TOL };
      return { x: w.cx - h, y: w.cy, w: w.width, d: TOL };
    };
    const overlap = (a, b) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.d - 1e-9 && b.y < a.y + a.d - 1e-9;

    function verdicts(L, roomIndex, wall, offset, width) {
      const room = L.rooms[roomIndex];
      const name = `« ${room.label} ${room.number} »`;
      const f = g.windowWallFrame(room, wall);
      const c = f.start + offset + width / 2;
      const win = { roomIndex, wall, cx: f.vertical ? f.fixed : c, cy: f.vertical ? c : f.fixed, width };
      const withWin = JSON.parse(JSON.stringify(L));
      withWin.windows = [...withWin.windows.filter((w) => w.roomIndex !== roomIndex), win];
      const before = msgs(L);
      const after = msgs(withWin);
      const windowMsgs = after.filter((m) => m.includes(name) && /fenêtre|ouverture/.test(m));
      const others = after.filter((m) => !before.includes(m) && !windowMsgs.includes(m));
      const elements = [
        ...(L.corridor ? [["circulation intérieure (corridor)", L.corridor]] : []),
        ...L.corridorFillers.map((r) => ["circulation intérieure (raccord)", r]),
        ...(L.circulations ?? []).map((r) => ["circulation intérieure", r]),
        ...(L.exteriorPaths ?? []).map((r) => ["cheminement extérieur", r]),
        ...L.rooms.flatMap((r, i) => (i !== roomIndex && !r.parked ? [[`pièce « ${r.label} ${r.number} »`, { x: r.x, y: r.y, w: r.w, d: r.d }]] : [])),
      ];
      const hits = elements.filter(([, r]) => overlap(probeOf(win), r)).map(([n]) => n);
      const exposure = x.classifyWallExposure(L, roomIndex, wall, { alongMin: c - width / 2, alongMax: c + width / 2 });
      const touches = !!L.footprint && [L.footprint].some((fp) => {
        const E = g.WALL_EXT;
        if (wall === "left") return Math.abs(room.x - fp.x - E) < 1e-3;
        if (wall === "right") return Math.abs(fp.x + fp.w - (room.x + room.w) - E) < 1e-3;
        if (wall === "top") return Math.abs(room.y - fp.y - E) < 1e-3;
        return Math.abs(fp.y + fp.d - (room.y + room.d) - E) < 1e-3;
      });
      // Outil évalué sur une copie SANS la fenêtre de cette pièce (comme un
      // ajout) : sinon une saisie identique à l'existante répond seulement
      // « aucune modification ».
      const withoutWin = JSON.parse(JSON.stringify(L));
      withoutWin.windows = withoutWin.windows.filter((w) => w.roomIndex !== roomIndex);
      const tool = g.placeWindow(withoutWin, roomIndex, wall, offset, width);
      return {
        verifierAccepts: windowMsgs.length === 0,
        verifierWhy: windowMsgs.length ? windowMsgs.join(" | ") : touches ? "mur qui touche le contour englobant" : "exposition prouvée (mur hors contour)",
        others,
        allAfter: after,
        probeHits: hits,
        exposure: exposure.kind,
        exposureWhy: exposure.reason,
        tool: tool.ok ? "accepte" : `refuse — ${tool.reason}`,
      };
    }
    const show = (label, v) =>
      console.log(
        `\n  ${label}\n    vérificateur : ${v.verifierAccepts ? "ACCEPTE" : "REFUSE"} (${v.verifierWhy})\n    sonde d'obstruction (outil, génération) : ${v.probeHits.length ? "OBSTRUÉE par " + v.probeHits.join(", ") : "libre"}\n    preuve d'exposition : ${v.exposure} (${v.exposureWhy})\n    outil Fenêtre (placeWindow) : ${v.tool}\n    autres anomalies nouvelles : ${v.others.length ? v.others.join(" ; ") : "aucune"}`
      );

    record("Plan de départ (fixture B3) admissible", msgs(base).length === 0);
    record("Plan de départ « cheminement extérieur » (fixture figée) admissible", msgs(pathFixture).length === 0);

    // ---- Bâti devant la fenêtre : les trois contrôles doivent concorder.
    const bati = [];
    // 1) Pièce mitoyenne (géométrie réelle) : Chambre 1, mur droit, face à Chambre 2.
    bati.push(["Pièce devant la fenêtre (Chambre 1, mur droit, Chambre 2 à 0,10 m)", verdicts(base, idx(base, "Chambre", 1), "right", 1, 1)]);
    // 2) Circulation intérieure (géométrie réelle) : Chambre 1, mur bas, face au corridor (hors porte).
    bati.push(["Circulation intérieure devant la fenêtre (Chambre 1, mur bas, corridor à 0,10 m)", verdicts(base, idx(base, "Chambre", 1), "bottom", 0, 0.6)]);
    // 3) Pièce déplacée devant un mur RÉELLEMENT extérieur (Salon 1, mur bas) :
    //    Sanitaire 2 posé sous la fenêtre du salon, contour recalculé (tryMoveRoom).
    const s2 = idx(base, "Sanitaire", 2);
    const salon = idx(base, "Salon", 1);
    const sw = base.windows.find((w) => w.roomIndex === salon);
    const salonRoom = base.rooms[salon];
    const salonOffset = g.windowOffsetOnWall(salonRoom, sw);
    const moved = g.tryMoveRoom(base, s2, sw.cx - base.rooms[s2].w / 2, salonRoom.y + salonRoom.d + g.WALL_INT);
    if (moved) bati.push(["Pièce déplacée devant la fenêtre du salon (Sanitaire 2 à 0,10 m sous le mur bas)", verdicts(moved, salon, "bottom", salonOffset, sw.width)]);
    else record("Déplacement de Sanitaire 2 sous le salon possible (cas 3)", false);
    for (const [label, v] of bati) {
      show(label, v);
      record(
        `Bâti — ${label} : vérificateur, sonde et preuve d'exposition concordent (refus), outil refuse`,
        !v.verifierAccepts && v.probeHits.length > 0 && v.exposure !== "exterieur" && v.tool.startsWith("refuse")
      );
    }
    // 4) Témoin : la même pièce à 1,00 m (au-delà de la sonde de 0,32 m).
    const far = g.tryMoveRoom(base, s2, sw.cx - base.rooms[s2].w / 2, salonRoom.y + salonRoom.d + 1.0);
    if (far) {
      const v = verdicts(far, salon, "bottom", salonOffset, sw.width);
      show("Témoin : Sanitaire 2 à 1,00 m sous le mur bas du salon", v);
      record(
        "Témoin à 1,00 m : sonde libre ; vérificateur, preuve d'exposition et outil concordent",
        v.probeHits.length === 0 && v.verifierAccepts === (v.exposure === "exterieur") && v.verifierAccepts === v.tool.startsWith("accepte"),
        `vérificateur ${v.verifierAccepts ? "accepte" : "refuse"}, exposition ${v.exposure}, outil ${v.tool.startsWith("accepte") ? "accepte" : "refuse"}`
      );
    }
    // 5) Témoin : la même pièce à 2,00 m (au-delà de la profondeur de la preuve d'exposition).
    const farther = g.tryMoveRoom(base, s2, sw.cx - base.rooms[s2].w / 2, salonRoom.y + salonRoom.d + 2.0);
    if (farther) {
      const v = verdicts(farther, salon, "bottom", salonOffset, sw.width);
      show("Témoin : Sanitaire 2 à 2,00 m sous le mur bas du salon", v);
      record(
        "Témoin à 2,00 m : sonde libre ; vérificateur, preuve d'exposition et outil concordent",
        v.probeHits.length === 0 && v.verifierAccepts === (v.exposure === "exterieur") && v.verifierAccepts === v.tool.startsWith("accepte"),
        `vérificateur ${v.verifierAccepts ? "accepte" : "refuse"}, exposition ${v.exposure}, outil ${v.tool.startsWith("accepte") ? "accepte" : "refuse"}`
      );
    }

    // ---- Cheminement extérieur devant la fenêtre : convention du prototype
    // conservée (décision du 2026-10-06), désormais assertée.
    const c1 = verdicts(pathFixture, idx(pathFixture, "Chambre", 1), "left", 1, 1);
    show("Cheminement extérieur DANS le contour englobant (fixture figée : Chambre 1, mur gauche, passage à 0,10 m)", c1);
    const withPath = JSON.parse(JSON.stringify(base));
    const fp = withPath.footprint;
    withPath.exteriorPaths = [...(withPath.exteriorPaths ?? []), { x: sw.cx - 0.6, y: fp.y + fp.d, w: 1.2, d: 1.2 }];
    const c2 = verdicts(withPath, salon, "bottom", salonOffset, sw.width);
    show("Cheminement extérieur HORS du contour englobant (passage de 1,20 m posé contre le mur bas du salon)", c2);
    const pathCases = [
      ["dans le contour (fixture figée)", pathFixture, idx(pathFixture, "Chambre", 1), "left", 1, 1, c1],
      ["hors du contour", withPath, salon, "bottom", salonOffset, sw.width, c2],
    ];
    for (const [where, L, ri, wall, off, width, v] of pathCases) {
      record(
        `Cheminement extérieur ${where} : l'outil refuse pour le seul motif de la convention (« ${g.EXTERIOR_PATH_CLEARANCE_REASON} »)`,
        v.probeHits.length > 0 && v.probeHits.every((h) => h === "cheminement extérieur") && v.tool === `refuse — ${g.EXTERIOR_PATH_CLEARANCE_REASON}`,
        v.tool
      );
      record(
        `Cheminement extérieur ${where} : le vérificateur reste satisfait (aucune anomalie, aucun refus ajouté par la convention)`,
        v.verifierAccepts && v.allAfter.length === 0,
        v.allAfter.join(" ; ")
      );
      const imported = roundTrip(L);
      const vi = verdicts(imported, ri, wall, off, width);
      record(
        `Cheminement extérieur ${where} : même comportement après export/réimport du fichier de projet`,
        vi.tool === v.tool && vi.verifierAccepts && vi.allAfter.length === 0 && JSON.stringify(imported.exteriorPaths) === JSON.stringify(L.exteriorPaths),
        vi.tool
      );
    }

    const total = results.length;
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${total} tests réussis.`);
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
