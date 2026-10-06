// Catalogue — option A (2026-10-06) : toCatalogueProjectFile (projectFile.ts).
// Un plan issu de F2 devient un modèle v4 SANS autorisations de réduction,
// géométrie strictement identique ; fichier source jamais modifié ; v1–v4
// inchangés ; fichier invalide refusé avant conversion (même enchaînement que
// l'action serveur : validateProjectFile puis toCatalogueProjectFile).
//
// Usage : node scripts/test-plans-catalogue-f2.mjs

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

const tmpDir = mkdtempSync(join(tmpdir(), "plans-catalogue-f2-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const sources = ["geometry.ts", "adaptation.ts", "projectFile.ts"].map((f) => `"${join("src", "app", "prototype-plans", f)}"`).join(" ");
  const compile = spawnSync(`"${tscBin}" ${sources} --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) {
    console.error(compile.stdout, compile.stderr);
    process.exitCode = 1;
  } else {
    const g = await import(pathToFileURL(join(tmpDir, "geometry.js")).href);
    const a = await import(pathToFileURL(join(tmpDir, "adaptation.js")).href);
    const pf = await import(pathToFileURL(join(tmpDir, "projectFile.js")).href);
    const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
    const same = (x, y) => JSON.stringify(canon(x)) === JSON.stringify(canon(y));
    // Même enchaînement que l'action serveur.
    const pipeline = (raw) => {
      const v = pf.validateProjectFile(JSON.parse(JSON.stringify(raw)));
      if (!v.ok) return { stage: "validation", ...v };
      return { stage: "conversion", ...pf.toCatalogueProjectFile(v.value) };
    };

    // Plan F2 réel : fixture F2, autorisations confirmées, adaptation choisie.
    const L = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-f2-cuisine-verrouillee.json"), "utf8")).layout;
    const idx = (l, label, n) => l.rooms.findIndex((r) => r.label === label && r.number === n);
    const conf = a.confirmAllowances(L, [
      { roomIndex: idx(L, "Chambre", 1), minW: 3.0, minD: null },
      { roomIndex: idx(L, "Chambre", 2), minW: 3.0, minD: null },
      { roomIndex: idx(L, "Sanitaire", 1), minW: 1.5, minD: null },
      { roomIndex: idx(L, "Sanitaire", 2), minW: 1.5, minD: null },
    ], "2026-10-06T00:00:00.000Z");
    const res = g.regenerateWithAllowances(conf.layout, { allowances: a.engineAllowances(conf.layout) });
    const f2Layout = a.applyAdaptedProposal(conf.layout, res.proposals[0].layout);
    const f2File = JSON.parse(JSON.stringify(pf.serializeProject(f2Layout, "N")));
    const sourceSnapshot = JSON.stringify(f2File);
    record("Fichier F2 de départ : v5 avec 4 autorisations, dimensions réduites", f2File.version === 5 && f2File.layout.dimensionAllowances.length === 4 && f2File.layout.rooms[idx(L, "Chambre", 1)].w === 3.0);

    const out = pipeline(f2File);
    record("Projet F2 valide → modèle accepté", out.stage === "conversion" && out.ok, out.ok ? "" : out.error);
    if (out.ok) {
      record("Modèle en version 4, sans autorisations (4 retirées)", out.file.version === 4 && !("dimensionAllowances" in out.file.layout) && out.removedAllowances === 4);
      const src = { ...f2File.layout };
      delete src.dimensionAllowances;
      record("Géométrie strictement identique (pièces, dimensions, positions, verrous, portes, fenêtres, circulations, surfaces, contour)", same(src, out.file.layout) && out.file.orientation === f2File.orientation);
      record("Fichier source inchangé (copie de travail)", JSON.stringify(f2File) === sourceSnapshot && f2File.layout.dimensionAllowances.length === 4);
      const reread = pf.validateProjectFile(JSON.parse(JSON.stringify(out.file)));
      record("Relecture du modèle : valide, v4, sans avis, géométrie identique (réimport fidèle)", reread.ok && reread.value.version === 4 && reread.notices.length === 0 && same(reread.value.layout, out.file.layout));
      record("Modèle relu : aucune adaptation possible (aucune autorisation)", a.engineAllowances(reread.value.layout).length === 0 && a.allowanceStates(reread.value.layout).length === 0);
    }

    // Fichiers v1–v4 existants : inchangés (géométrie) et toujours acceptés.
    for (const name of ["plans-c2-resolu.projet.json", "plans-c8-resolu.projet.json", "plans-scenario1-post-regen.projet.json"]) {
      const raw = JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
      const v = pf.validateProjectFile(JSON.parse(JSON.stringify(raw)));
      const o = pipeline(raw);
      record(`Fichier existant ${name} (v${raw.version}) : accepté, v4, géométrie identique, aucune autorisation retirée`, o.ok && o.file.version === 4 && o.removedAllowances === 0 && v.ok && same(v.value.layout, o.file.layout));
    }

    // Fichier structurellement invalide : refusé AVANT conversion.
    const bad = JSON.parse(JSON.stringify(f2File));
    bad.layout.doors[0].roomIndex = 999;
    const ob = pipeline(bad);
    record("Fichier structurellement invalide refusé par la validation complète, jamais converti", ob.stage === "validation" && !ob.ok, ob.error);
    // Autorisations invalides : écartées à la lecture (avis), modèle v4 sans autorisations.
    const badAllow = JSON.parse(JSON.stringify(f2File));
    badAllow.layout.dimensionAllowances[0].minW = 9;
    const oa = pipeline(badAllow);
    record("Autorisations invalides : écartées à la validation, modèle v4 sans autorisations", oa.ok && oa.file.version === 4 && !("dimensionAllowances" in oa.file.layout));

    const total = results.length;
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${total} tests réussis.`);
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
