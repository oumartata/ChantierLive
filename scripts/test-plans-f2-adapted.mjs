// F2 — moteur expérimental (2026-10-06) : regenerateWithAllowances
// (geometry.ts). Aucune interface. Vérifie le contrat d'options et les
// garanties : aucune réduction sans autorisation, autorisations invalides
// refusées (jamais corrigées), pièce verrouillée intacte, dimensions dans
// les bornes confirmées, aucun rétrécissement cumulatif, contrôles
// géométriques actifs, recherche bornée (jeux, budget global) et
// régénération ordinaire inchangée sur la fixture.
//
// Bornes de la fixture : décision explicite du 2026-10-06 pour CE test
// uniquement (Chambres 1 et 2 : largeur ≥ 3,00 m ; Sanitaires 1 et 2 :
// largeur ≥ 1,50 m ; autres dimensions inchangées) — jamais des valeurs par
// défaut ni des valeurs codées dans le moteur.
//
// Usage : node scripts/test-plans-f2-adapted.mjs

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

const tmpDir = mkdtempSync(join(tmpdir(), "plans-f2-adapted-"));
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
    const L = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-f2-cuisine-verrouillee.json"), "utf8")).layout;
    const before = JSON.stringify(L);
    const idx = (l, label, n) => l.rooms.findIndex((r) => r.label === label && r.number === n);
    const cu = idx(L, "Cuisine", 1);
    const f2 = (v) => v.toFixed(2).replace(".", ",");
    const allowancesFor = (base) =>
      [["Chambre", 1, 3.0], ["Chambre", 2, 3.0], ["Sanitaire", 1, 1.5], ["Sanitaire", 2, 1.5]].map(([label, n, minW]) => {
        const i = idx(base, label, n);
        return { roomIndex: i, referenceW: base.rooms[i].w, referenceD: base.rooms[i].d, minW };
      });
    const allowances = allowancesFor(L);
    const openings = (l, i) => JSON.stringify({ r: [l.rooms[i].x, l.rooms[i].y, l.rooms[i].w, l.rooms[i].d, l.rooms[i].locked], d: l.doors.filter((d) => d.roomIndex === i), w: l.windows.filter((w) => w.roomIndex === i) });

    // Régénération ordinaire : comportement inchangé (aucune nouvelle proposition, comme avant ce lot).
    const ordinary = g.regenerateUnlocked(L);
    record(
      "Régénération ordinaire (sans option F2) sur la fixture : inchangée — seule la disposition actuelle",
      ordinary.variants.length === 1 && ordinary.variants[0].variantLabel === "Disposition actuelle (inchangée)"
    );

    // Recherche adaptée.
    const t0 = Date.now();
    const res = g.regenerateWithAllowances(L, { allowances });
    const ms = Date.now() - t0;
    record("Recherche adaptée acceptée (autorisations valides)", res.ok, res.ok ? "" : res.reason);
    if (res.ok) {
      const st = res.stats;
      record(
        "Au moins une disposition NOUVELLE, adaptée et admissible, retrouvée automatiquement",
        res.proposals.length >= 1,
        `${res.proposals.length} proposition(s) en ${ms} ms ; ${st.dimensionSetsTried}/${st.dimensionSetsPossible} jeu(x) de dimensions, budget ${st.budgetMillis} ms ${st.budgetReached ? "atteint" : "non atteint"}`
      );
      record("Recherche bornée : au plus 8 jeux de dimensions, plafond signalé", st.dimensionSetsTried <= 8 && st.dimensionSetsPlanned <= 8 && st.setsCapped === st.dimensionSetsPossible > 8);
      record("Brouillon d'entrée jamais modifié", JSON.stringify(L) === before);
      for (const p of res.proposals) {
        const V = p.layout;
        const name = p.layout.variantLabel;
        record(`${name} : 0 anomalie (vérificateur indépendant)`, g.independentVerify(V).length === 0);
        record(`${name} : Cuisine 1 verrouillée strictement inchangée (position, dimensions, porte, fenêtre)`, openings(V, cu) === openings(L, cu));
        const dimsOk = V.rooms.every((r, i) => {
          const a = allowances.find((x) => x.roomIndex === i);
          if (!a) return r.w === L.rooms[i].w && r.d === L.rooms[i].d;
          return r.w >= a.minW - 1e-9 && r.w <= a.referenceW + 1e-9 && r.d === a.referenceD;
        });
        record(`${name} : dimensions sans autorisation inchangées ; dimensions autorisées dans [borne ; référence] ; aucune profondeur réduite`, dimsOk);
        record(`${name} : programme inchangé`, V.rooms.length === L.rooms.length && V.rooms.every((r, i) => r.type === L.rooms[i].type && !r.parked));
        const rep = p.rooms;
        const moved = rep.filter((r) => r.moved).map((r) => r.name);
        record(
          `${name} : rapport complet (référence, actuel, proposé, bornes, déplacements, ouvertures, surfaces, contour)`,
          rep.length === L.rooms.length && rep.every((r) => r.withinBounds) && moved.length > 0 &&
            Math.abs(p.surfaces.after.total - (p.surfaces.after.circulation + p.surfaces.after.cheminementExterieur)) < 1e-9 && p.footprint.before && p.footprint.after,
          `déplacées : ${moved.join(", ")} ; circulation ${f2(p.surfaces.before.circulation)} → ${f2(p.surfaces.after.circulation)} m², cheminement extérieur ${f2(p.surfaces.before.cheminementExterieur)} → ${f2(p.surfaces.after.cheminementExterieur)} m², total ${f2(p.surfaces.before.total)} → ${f2(p.surfaces.after.total)} m² ; contour ${f2(p.footprint.before.area)} → ${f2(p.footprint.after.area)} m²`
        );
      }

      // Deux régénérations adaptées successives : même référence, aucun rétrécissement cumulatif.
      if (res.proposals.length > 0) {
        const first = res.proposals[0].layout;
        const again = g.regenerateWithAllowances(first, { allowances });
        const noShrink =
          again.ok &&
          again.proposals.every((p) => p.layout.rooms.every((r, i) => {
            const a = allowances.find((x) => x.roomIndex === i);
            return !a || (r.w >= a.minW - 1e-9 && r.w <= a.referenceW + 1e-9);
          }));
        record("Deuxième régénération adaptée depuis un résultat adapté, même référence : aucune dimension sous la borne", noShrink, again.ok ? `${again.proposals.length} proposition(s)` : again.reason);
        // Une « référence » reprise du résultat adapté ne peut pas descendre plus bas : bornes ≤ référence imposées.
        const shrunkRef = allowancesFor(first).map((a) => ({ ...a, minW: a.minW - 0.1 }));
        const bad = g.regenerateWithAllowances(first, { allowances: shrunkRef });
        record("Borne sous le minimum du moteur refusée (jamais corrigée)", !bad.ok && /sous le minimum du moteur/.test(bad.reason), bad.ok ? "acceptée à tort" : bad.reason);
      }
    }

    // Autorisations invalides : refusées avec motif, jamais corrigées.
    const cases = [
      ["aucune autorisation", { allowances: [] }, /Aucune autorisation/],
      ["pièce verrouillée", { allowances: [{ roomIndex: cu, referenceW: L.rooms[cu].w, referenceD: L.rooms[cu].d, minW: 2.5 }] }, /verrouillée/],
      ["pièce inconnue", { allowances: [{ roomIndex: 99, referenceW: 3, referenceD: 3, minW: 2.5 }] }, /introuvable/],
      ["pièce autorisée deux fois", { allowances: [allowances[0], allowances[0]] }, /deux fois/],
      ["borne supérieure à la référence (agrandissement)", { allowances: [{ ...allowances[0], minW: allowances[0].referenceW + 0.2 }] }, /seules les réductions/],
      ["aucune borne", { allowances: [{ roomIndex: allowances[0].roomIndex, referenceW: allowances[0].referenceW, referenceD: allowances[0].referenceD }] }, /aucune borne/],
      ["référence plus petite que la pièce (périmée)", { allowances: [{ ...allowances[0], referenceW: 2.9, minW: 2.9 }] }, /référence périmée/],
      ["nombre de jeux hors limite", { allowances, maxDimensionSets: 9 }, /jeux de dimensions invalide/],
      ["budget invalide", { allowances, budgetMillis: 0 }, /Budget/],
    ];
    for (const [name, opt, re] of cases) {
      const r = g.regenerateWithAllowances(L, opt);
      record(`Autorisation invalide refusée — ${name}`, !r.ok && re.test(r.reason), r.ok ? "acceptée à tort" : r.reason);
    }

    // Budget global : un budget minuscule arrête la recherche entre deux jeux et le signale.
    const tiny = g.regenerateWithAllowances(L, { allowances, budgetMillis: 1 });
    record(
      "Budget global vérifié avant chaque jeu : arrêt signalé, dépassement mesuré",
      tiny.ok && tiny.stats.budgetReached && tiny.stats.dimensionSetsTried < tiny.stats.dimensionSetsPlanned,
      tiny.ok ? `${tiny.stats.dimensionSetsTried} jeu(x) en ${tiny.stats.elapsedMillis} ms pour un budget de 1 ms` : tiny.reason
    );

    const total = results.length;
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${total} tests réussis.`);
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
