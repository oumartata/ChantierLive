// F1 — édition de la fenêtre d'une pièce (2026-10-05) : placeWindow /
// removeWindow (geometry.ts). Vérifie, sur la fixture B3 (paramètres par
// défaut de l'écran) : modification valide appliquée telle quelle, refus
// motivés sans changement du plan (hors mur, trop large, trop étroite, mur
// non exposé, dégagement obstrué, porte recouverte, pièce verrouillée),
// retrait seulement s'il reste admissible, ajout dans le même modèle,
// aller-retour du vrai fichier de projet et trait de l'export SVG.
//
// Usage : node scripts/test-plans-windows.mjs

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

const tmpDir = mkdtempSync(join(tmpdir(), "plans-windows-test-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const sources = ["geometry.ts", "projectFile.ts", "render.ts"].map((f) => `"${join("src", "app", "prototype-plans", f)}"`).join(" ");
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
    const pf = await import(pathToFileURL(join(tmpDir, "projectFile.js")).href);
    const rd = await import(pathToFileURL(join(tmpDir, "render.js")).href);

    const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-b3-regeneration-reproduction.json"), "utf8"));
    const L = fx.layout;
    const idx = (layout, label, number) => layout.rooms.findIndex((r) => r.label === label && r.number === number);
    const snap = (layout) => JSON.stringify(layout);
    const except = (layout, field) => JSON.stringify({ ...layout, [field]: null });
    const issues = (layout) => g.independentVerify(layout).map((i) => i.message).sort();
    const c1 = idx(L, "Chambre", 1);
    const before = snap(L);

    // 1) Modification valide, appliquée exactement (aucun recalage).
    const ok = g.placeWindow(L, c1, "top", 0.4, 1.2);
    const w = ok.ok ? g.windowsOf(ok.layout, c1) : [];
    const room = L.rooms[c1];
    record(
      "Modification valide : Chambre 1, mur haut, à 0,40 m de l'angle gauche, 1,20 m — appliquée exactement",
      ok.ok && w.length === 1 && w[0].wall === "top" && Math.abs(w[0].cx - (room.x + 0.4 + 0.6)) < 1e-9 && w[0].cy === room.y && w[0].width === 1.2 &&
        Math.abs(g.windowOffsetOnWall(room, w[0]) - 0.4) < 1e-9,
      ok.ok ? JSON.stringify(w[0]) : ok.reason
    );
    record("Modification valide : seule la fenêtre change (pièces, portes, circulations, surfaces identiques)", ok.ok && except(ok.layout, "windows") === except(L, "windows"));
    record("Modification valide : une seule fenêtre pour la pièce, autres fenêtres inchangées", ok.ok && JSON.stringify(ok.layout.windows.filter((x) => x.roomIndex !== c1)) === JSON.stringify(L.windows.filter((x) => x.roomIndex !== c1)));
    record("Modification valide : aucune nouvelle anomalie sur le plan entier", ok.ok && JSON.stringify(issues(ok.layout)) === JSON.stringify(issues(L)), `${issues(L).length} anomalie(s) avant et après`);
    record("Disposition d'origine jamais modifiée (copie)", snap(L) === before);

    // 2) Refus motivés, plan inchangé.
    const refusals = [
      ["fenêtre trop large pour le mur (4,00 m sur 3,03 m)", g.placeWindow(L, c1, "top", 0, 4), /sortirait du mur/],
      ["hors du mur (position négative)", g.placeWindow(L, c1, "top", -0.1, 1), /sortirait du mur/],
      ["hors du mur (dépasse la fin)", g.placeWindow(L, c1, "top", 2.5, 1), /sortirait du mur/],
      ["plus étroite que le minimum du prototype (0,50 m)", g.placeWindow(L, c1, "top", 0.5, 0.5), /inférieure au minimum de 0,60 m.*hypothèse/],
      ["mur mitoyen (Chambre 1, mur droit)", g.placeWindow(L, c1, "right", 1, 1), /ne donne pas sur l'extérieur/],
      ["recouvre la porte de la pièce (Chambre 1, mur bas)", g.placeWindow(L, c1, "bottom", 1, 1), /recouvrirait une porte/],
      ["valeur non numérique", g.placeWindow(L, c1, "top", Number.NaN, 1), /non numérique/],
    ];
    for (const [name, res, re] of refusals) record(`Refus — ${name} : motif explicite, aucun changement`, !res.ok && re.test(res.reason) && !("layout" in res), res.ok ? "accepté à tort" : res.reason);
    const cur = g.windowsOf(L, c1)[0];
    const same = g.placeWindow(L, c1, cur.wall, g.windowOffsetOnWall(room, cur), cur.width);
    record("Saisie identique à la fenêtre actuelle : « aucune modification » (pas d'entrée d'historique)", !same.ok && /Aucune modification/.test(same.reason));

    // 3) Obstruction réelle : cheminement extérieur devant le mur (proposition Salon 1).
    const sal = g.regenerateUnlocked(g.lockRoom(L, idx(L, "Salon", 1))).variants.find((v) => v.variantLabel === "Régénération 1");
    const salFree = g.unlockRoom(sal, idx(sal, "Salon", 1));
    const obs = g.placeWindow(salFree, idx(salFree, "Chambre", 1), "left", 1, 1);
    record("Refus — dégagement obstrué (cheminement extérieur devant le mur gauche de Chambre 1)", !obs.ok && /obstrué par un cheminement extérieur/.test(obs.reason), obs.ok ? "accepté à tort" : obs.reason);

    // 4) Pièce verrouillée : jamais modifiée.
    const locked = g.lockRoom(L, c1);
    const lk = g.placeWindow(locked, c1, "top", 0.4, 1.2);
    const lkr = g.removeWindow(locked, c1);
    record("Pièce verrouillée : modification et retrait refusés", !lk.ok && /verrouillée/.test(lk.reason) && !lkr.ok && /verrouillée/.test(lkr.reason));

    // 5) Retrait : refusé pour une chambre ou un salon (règle existante), proposé pour un sanitaire.
    const rmCh = g.removeWindow(L, c1);
    record("Retrait refusé pour une chambre (règle du prototype, hypothèse et non norme)", !rmCh.ok && /chambre ou salon/.test(rmCh.reason) && /pas une norme/.test(rmCh.reason), rmCh.ok ? "" : rmCh.reason);
    const s1 = idx(L, "Sanitaire", 1);
    const rmS = g.removeWindow(L, s1);
    record(
      "Retrait admis pour un sanitaire : seule sa fenêtre disparaît, aucune nouvelle anomalie",
      rmS.ok && g.windowsOf(rmS.layout, s1).length === 0 && except(rmS.layout, "windows") === except(L, "windows") && JSON.stringify(issues(rmS.layout)) === JSON.stringify(issues(L)),
      rmS.ok ? "" : rmS.reason
    );
    // 6) Ajout dans le même modèle (pièce sans fenêtre).
    if (rmS.ok) {
      const sr = rmS.layout.rooms[s1];
      const add = g.placeWindow(rmS.layout, s1, "bottom", 0.2, 0.8);
      record(
        "Ajout d'une fenêtre à une pièce qui n'en a pas (même modèle, une fenêtre)",
        add.ok && g.windowsOf(add.layout, s1).length === 1 && g.windowsOf(add.layout, s1)[0].cy === sr.y + sr.d,
        add.ok ? JSON.stringify(g.windowsOf(add.layout, s1)[0]) : add.reason
      );
    }

    // 7) Vrai fichier de projet : export puis réimport.
    if (ok.ok) {
      const file = JSON.parse(JSON.stringify(pf.serializeProject(ok.layout, "N")));
      const back = pf.validateProjectFile(file);
      record(
        "Fichier de projet : la fenêtre modifiée survit à l'export et au réimport (mêmes valeurs)",
        back.ok && JSON.stringify(g.windowsOf(back.value.layout, c1)) === JSON.stringify(g.windowsOf(ok.layout, c1)) && JSON.stringify(back.value.layout.windows) === JSON.stringify(ok.layout.windows),
        back.ok ? "" : back.error
      );
      // 8) Export SVG : le trait de fenêtre suit exactement la nouvelle position.
      const svg = rd.renderSvg(ok.layout, "N");
      const scale = 26, margin = 70;
      const wx = margin + w[0].cx * scale, wy = margin + w[0].cy * scale, half = (w[0].width * scale) / 2;
      const line = `<line x1="${wx - half}" y1="${wy}" x2="${wx + half}" y2="${wy}" stroke="#0284c7" stroke-width="4" />`;
      const oldWx = margin + cur.cx * scale, oldHalf = (cur.width * scale) / 2;
      const oldLine = `<line x1="${oldWx - oldHalf}" y1="${margin + cur.cy * scale}" x2="${oldWx + oldHalf}"`;
      record("Export SVG : trait de la nouvelle fenêtre présent à sa position exacte, l'ancien absent", svg.includes(line) && !svg.includes(oldLine));
    }

    const total = results.length;
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${total} tests réussis.`);
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
