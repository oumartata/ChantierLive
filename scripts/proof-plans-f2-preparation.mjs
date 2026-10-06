// F2 — préparation (2026-10-06, SUIVI_MOTEUR_PLANS_2D.md) : preuve de
// faisabilité d'une adaptation VOLONTAIRE et BORNÉE des dimensions en
// régénération. Rien n'est activé dans l'application ; aucun code du moteur
// n'est modifié. Distingue trois choses :
//  1) CONSTAT — la recherche actuelle ne trouve aucune disposition nouvelle
//     à dimensions constantes (fixture plans-f2-cuisine-verrouillee.json) ;
//  2) PREUVE (assertée) — une disposition adaptée VALIDE existe, dans des
//     bornes explicites (au plus 10 % de réduction par dimension, jamais sous
//     les minima du moteur — bornes de preuve, pas un accord d'utilisateur ni
//     une norme) : reconstruite ici pas à pas avec les seules fonctions de
//     l'éditeur, et figée dans plans-f2-exemple-adapte.json ;
//  3) CONSTAT — la recherche actuelle, même nourrie des dimensions adaptées,
//     ne la retrouve pas : limite de recherche, jamais une preuve
//     d'impossibilité.
// Les constats sont imprimés, pas assertés : ils décrivent une limite
// actuelle, pas un résultat souhaité.
//
// Usage : node scripts/proof-plans-f2-preparation.mjs   (npm run proof:plans:f2)

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

const tmpDir = mkdtempSync(join(tmpdir(), "plans-f2-proof-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "${join("src", "app", "prototype-plans", "geometry.ts")}" --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`, {
    shell: true,
    encoding: "utf8",
    cwd: repoRoot,
  });
  if (compile.status !== 0) {
    console.error(compile.stdout, compile.stderr);
    process.exitCode = 1;
  } else {
    const g = await import(pathToFileURL(join(tmpDir, "geometry.js")).href);
    const base = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-f2-cuisine-verrouillee.json"), "utf8")).layout;
    const frozen = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-f2-exemple-adapte.json"), "utf8")).layout;
    const idx = (L, label, number) => L.rooms.findIndex((r) => r.label === label && r.number === number);
    const f2 = (v) => v.toFixed(2).replace(".", ",");
    const MAX_REDUCTION = 0.1; // borne de PREUVE, pas un accord d'utilisateur
    const lower = (ref, min) => Math.max(min, ref * (1 - MAX_REDUCTION));
    const cu = idx(base, "Cuisine", 1);
    const openings = (L, i) => JSON.stringify({ r: L.rooms[i], d: L.doors.filter((d) => d.roomIndex === i), w: L.windows.filter((w) => w.roomIndex === i) });
    const center = (r) => [r.x + r.w / 2, r.y + r.d / 2];
    // Même disposition = chaque pièce non verrouillée reste à moins de 1 m
    // d'une pièce de même type de la disposition de départ (une simple
    // réduction sur place n'est pas une disposition nouvelle).
    const sameArrangement = (V) => {
      const used = new Set();
      return V.rooms.every((r) => {
        if (r.locked) return true;
        const [cx, cy] = center(r);
        const j = base.rooms.findIndex((o, k) => !used.has(k) && !o.locked && o.type === r.type && Math.hypot(center(o)[0] - cx, center(o)[1] - cy) < 1.0);
        if (j < 0) return false;
        used.add(j);
        return true;
      });
    };

    record("Disposition de départ admissible, Cuisine 1 verrouillée", g.independentVerify(base).length === 0 && base.rooms[cu].locked === true);

    // 1) Constat : dimensions constantes.
    const constant = g.regenerateUnlocked(base);
    const constantNew = constant.variants.filter((v) => v.variantLabel !== "Disposition actuelle (inchangée)");
    console.log(`\nCONSTAT 1 — dimensions constantes : ${constantNew.length} proposition(s) nouvelle(s). ${g.describeRegenerationDiagnostics(constant.diagnostics)}`);

    // 2) Preuve : reconstruction pas à pas avec les fonctions de l'éditeur.
    let L = base;
    const steps = [];
    const apply = (name, res) => {
      const next = !res ? null : "kind" in res ? (res.kind === "applied" ? res.layout : null) : "ok" in res ? (res.ok ? res.layout : null) : res;
      steps.push(`${next ? "ok" : "REFUS"} ${name}`);
      if (next) L = next;
      return !!next;
    };
    const C1 = idx(base, "Chambre", 1), C2 = idx(base, "Chambre", 2), C3 = idx(base, "Chambre", 3), S1 = idx(base, "Sanitaire", 1), S2 = idx(base, "Sanitaire", 2);
    let built =
      apply("mettre de côté Sanitaire 1", g.parkRoom(L, S1)) &&
      apply("mettre de côté Sanitaire 2", g.parkRoom(L, S2)) &&
      apply("mettre de côté Chambre 3", g.parkRoom(L, C3)) &&
      apply("Chambre 1 : largeur 3,00 m", g.resizeRoomDimension(L, C1, "w", 3.0)) &&
      apply("Chambre 2 : largeur 3,00 m", g.resizeRoomDimension(L, C2, "w", 3.0)) &&
      apply("Chambre 2 : déplacée à x 6,60", g.tryMoveRoom(L, C2, 6.6, L.rooms[C2].y)) &&
      apply("Chambre 3 : replacée à (9,47 ; 10,70)", g.placeParkedRoom(L, C3, 9.47, 10.7)) &&
      apply("Sanitaire 1 : replacé à (9,70 ; 4,70)", g.placeParkedRoom(L, S1, 9.7, 4.7)) &&
      apply("Sanitaire 1 : largeur 1,50 m", g.resizeRoomDimension(L, S1, "w", 1.5)) &&
      apply("Sanitaire 2 : replacé à (11,30 ; 4,70)", g.placeParkedRoom(L, S2, 11.3, 4.7)) &&
      apply("Sanitaire 2 : largeur 1,50 m", g.resizeRoomDimension(L, S2, "w", 1.5));
    for (const [i, wall] of [[S1, "bottom"], [S2, "bottom"], [C3, "top"]]) {
      if (!built) break;
      for (const d of g.doorsOf(L, i)) if (d.wall !== wall) L = g.removeDoor(L, i, d.wall);
      const r = L.rooms[i];
      built = apply(`porte de « ${r.label} ${r.number} » sur le mur ${wall}`, g.placeDoor(L, i, wall, r.x + r.w / 2));
    }
    for (const [i, wall] of [[S1, "top"], [S2, "top"], [C3, "bottom"]]) {
      if (!built) break;
      const r = L.rooms[i];
      const len = wall === "top" || wall === "bottom" ? r.w : r.d;
      const w = Math.min(1.2, len - 0.6);
      built = apply(`fenêtre de « ${r.label} ${r.number} » sur le mur ${wall}`, g.placeWindow(L, i, wall, (len - w) / 2, w));
    }
    console.log(`\nReconstruction :\n  ${steps.join("\n  ")}`);
    record("Exemple adapté reconstruit avec les seules fonctions de l'éditeur", built);

    const check = (name, V) => {
      const issues = g.independentVerify(V);
      record(`${name} : 0 anomalie (vérificateur indépendant)`, issues.length === 0, issues.map((i) => i.message).join(" ; "));
      record(`${name} : Cuisine 1 verrouillée strictement inchangée (position, dimensions, porte, fenêtre)`, openings(V, cu) === openings(base, cu));
      record(`${name} : programme inchangé (mêmes pièces, mêmes types)`, V.rooms.length === base.rooms.length && V.rooms.every((r, i) => r.type === base.rooms[i].type && r.label === base.rooms[i].label && r.number === base.rooms[i].number && !r.parked));
      const inBounds = V.rooms.every((r, i) => {
        const o = base.rooms[i];
        return r.w <= o.w + 1e-9 && r.d <= o.d + 1e-9 && r.w >= lower(o.w, o.minW) - 1e-9 && r.d >= lower(o.d, o.minD) - 1e-9;
      });
      record(`${name} : dimensions dans les bornes (au plus −10 %, jamais sous les minima, aucun agrandissement)`, inBounds);
      record(`${name} : disposition réellement nouvelle (pas une simple réduction sur place)`, !sameArrangement(V));
    };
    if (built) check("Exemple reconstruit", L);
    check("Exemple figé", frozen);

    // Ce que montrerait une proposition adaptée avant tout choix.
    console.log("\nAvant / après, pièce par pièce (exemple figé) :");
    frozen.rooms.forEach((r, i) => {
      const o = base.rooms[i];
      const moved = Math.abs(r.x - o.x) > 1e-6 || Math.abs(r.y - o.y) > 1e-6;
      const opened = JSON.stringify([base.doors.filter((d) => d.roomIndex === i), base.windows.filter((w) => w.roomIndex === i)]) !== JSON.stringify([frozen.doors.filter((d) => d.roomIndex === i), frozen.windows.filter((w) => w.roomIndex === i)]);
      console.log(
        `  ${r.label} ${r.number}${r.locked ? " (verrouillée)" : ""} : ${f2(o.w)} × ${f2(o.d)} m (${f2(o.w * o.d)} m²) → ${f2(r.w)} × ${f2(r.d)} m (${f2(r.w * r.d)} m²)${moved ? ", déplacée" : ""}${opened ? ", ouvertures modifiées" : ""}`
      );
    });
    const tot = (V) => V.surfaces.circulation + V.surfaces.cheminementExterieur;
    console.log(
      `  Circulation intérieure ${f2(base.surfaces.circulation)} → ${f2(frozen.surfaces.circulation)} m² ; cheminement extérieur ${f2(base.surfaces.cheminementExterieur)} → ${f2(frozen.surfaces.cheminementExterieur)} m² ; total ${f2(tot(base))} → ${f2(tot(frozen))} m² ; contour englobant ${f2(base.footprint.w)} × ${f2(base.footprint.d)} → ${f2(frozen.footprint.w)} × ${f2(frozen.footprint.d)} m`
    );

    // 3) Constat : la recherche actuelle, nourrie des MÊMES dimensions adaptées.
    const fed = JSON.parse(JSON.stringify(base));
    fed.rooms.forEach((r, i) => {
      if (r.locked) return;
      r.w = frozen.rooms[i].w;
      r.d = frozen.rooms[i].d;
    });
    const adapted = g.regenerateUnlocked(fed);
    const adaptedNew = adapted.variants.filter((v) => !sameArrangement(v) && g.independentVerify(v).length === 0);
    console.log(
      `\nCONSTAT 3 — recherche actuelle avec les dimensions adaptées de l'exemple : ${adaptedNew.length} disposition(s) réellement nouvelle(s) sur ${adapted.variants.length} résultat(s). ${adapted.diagnostics ? g.describeRegenerationDiagnostics(adapted.diagnostics) : ""}`
    );
    console.log(
      "  Lecture : l'exemple existe (preuve 2) mais la régénération ORDINAIRE ne le construit pas — causes confirmées par trace (2026-10-06) : jonction par TYPE entier et profondeur limitée à celle de la rangée verrouillée. Limite de recherche, jamais une impossibilité. Le mode adapté (regenerateWithAllowances, scripts/test-plans-f2-adapted.mjs) lève ces deux limites et retrouve automatiquement une disposition voisine."
    );

    const total = results.length;
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${total} tests réussis.`);
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
