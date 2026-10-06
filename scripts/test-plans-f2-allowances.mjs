// F2 — autorisations d'adaptation des dimensions côté plan et fichier de
// projet (2026-10-06) : adaptation.ts, projectFile.ts (v5).
// Garanties vérifiées : aucune autorisation par défaut ; référence stable
// après le choix d'un résultat adapté ; autorisation à reconfirmer après
// modification manuelle, mise de côté ou pièce changée ; pièce verrouillée
// exclue ; révocation ; aucun héritage par un nouveau plan ; fichier v4
// inchangé sans autorisation (compatibilité catalogue) ; v5 seulement avec
// autorisations ; validation stricte à la lecture (autorisations invalides
// écartées avec avis, plan importé) ; aucune réduction cumulative.
//
// Bornes de la fixture F2 : décision explicite pour CE test uniquement.
//
// Usage : node scripts/test-plans-f2-allowances.mjs

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

const tmpDir = mkdtempSync(join(tmpdir(), "plans-f2-allowances-"));
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
    const L = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-f2-cuisine-verrouillee.json"), "utf8")).layout;
    const idx = (l, label, n) => l.rooms.findIndex((r) => r.label === label && r.number === n);
    const [c1, c2, s1, s2, cu] = [idx(L, "Chambre", 1), idx(L, "Chambre", 2), idx(L, "Sanitaire", 1), idx(L, "Sanitaire", 2), idx(L, "Cuisine", 1)];
    const inputs = [
      { roomIndex: c1, minW: 3.0, minD: null },
      { roomIndex: c2, minW: 3.0, minD: null },
      { roomIndex: s1, minW: 1.5, minD: null },
      { roomIndex: s2, minW: 1.5, minD: null },
    ];
    const roundTrip = (layout) => pf.validateProjectFile(JSON.parse(JSON.stringify(pf.serializeProject(layout, "N"))));
    const kinds = (layout) => a.allowanceStates(layout).map((s) => s.status.kind).join(",");

    // 1) Aucune autorisation par défaut ; nouveau plan sans héritage ; format v4 inchangé.
    const fresh = g.generateVariants(JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-b3-regeneration-reproduction.json"), "utf8")).generationInput).variants[0];
    record("Plan fraîchement généré : aucune autorisation (aucun héritage)", fresh.dimensionAllowances === undefined && a.engineAllowances(fresh).length === 0);
    const freshFile = pf.serializeProject(fresh, "N");
    record("Plan sans autorisation écrit en version 4, sans champ nouveau (catalogue et versions antérieures inchangés)", freshFile.version === 4 && !("dimensionAllowances" in freshFile.layout));
    record("Fixture F2 : aucune autorisation tant que rien n'est confirmé", a.allowanceStates(L).length === 0 && a.engineAllowances(L).length === 0);
    const oldFile = JSON.parse(readFileSync(join(__dirname, "fixtures", "plans-c2-resolu.projet.json"), "utf8"));
    const oldRead = pf.validateProjectFile(oldFile);
    record("Ancien fichier (v4) importable, sans autorisation ni avis", oldRead.ok && oldRead.value.layout.dimensionAllowances === undefined && oldRead.notices.length === 0, `version lue ${oldFile.version}`);

    // 2) Confirmation explicite ; refus des autorisations invalides (jamais corrigées).
    const conf = a.confirmAllowances(L, inputs, "2026-10-06T00:00:00.000Z");
    record("Confirmation explicite : 4 autorisations valides, référence = dimensions actuelles", conf.ok && kinds(conf.layout) === "valide,valide,valide,valide" && conf.layout.dimensionAllowances.every((e) => e.referenceW === L.rooms[e.roomIndex].w && e.referenceD === L.rooms[e.roomIndex].d));
    record("Confirmation : plan d'entrée jamais modifié", L.dimensionAllowances === undefined);
    const badInputs = [
      ["borne supérieure à la référence", [{ roomIndex: c1, minW: 3.2, minD: null }], /seules les réductions/],
      ["borne sous le minimum du moteur", [{ roomIndex: c1, minW: 2.9, minD: null }], /minimum du moteur/],
      ["pièce verrouillée", [{ roomIndex: cu, minW: 2.6, minD: null }], /verrouillée/],
      ["aucune borne", [{ roomIndex: c1, minW: null, minD: null }], /Aucune borne/],
    ];
    for (const [name, inp, re] of badInputs) {
      const r = a.confirmAllowances(L, inp, "t");
      record(`Confirmation refusée — ${name}`, !r.ok && re.test(r.reason), r.ok ? "acceptée à tort" : r.reason);
    }

    // 3) Sauvegarde : v5 avec autorisations, validation stricte à la lecture.
    const A = conf.layout;
    const file5 = pf.serializeProject(A, "N");
    const back = roundTrip(A);
    record("Plan avec autorisations écrit en version 5 ; relu à l'identique (brouillon comme fichier)", file5.version === 5 && back.ok && back.notices.length === 0 && JSON.stringify(back.value.layout.dimensionAllowances) === JSON.stringify(A.dimensionAllowances));
    const tamper = (mutate) => {
      const f = JSON.parse(JSON.stringify(file5));
      mutate(f);
      return pf.validateProjectFile(f);
    };
    const invalidFiles = [
      ["borne supérieure à la référence", (f) => { f.layout.dimensionAllowances[0].minW = 9; }],
      ["borne sous le minimum du moteur", (f) => { f.layout.dimensionAllowances[0].minW = 1; }],
      ["identité de pièce différente", (f) => { f.layout.dimensionAllowances[0].roomKey = "chambre|Chambre|9"; }],
      ["pièce inexistante", (f) => { f.layout.dimensionAllowances[0].roomIndex = 99; }],
      ["pièce autorisée deux fois", (f) => { f.layout.dimensionAllowances[1] = { ...f.layout.dimensionAllowances[0] }; }],
      ["pièce verrouillée", (f) => { f.layout.rooms[c1].locked = true; }],
      ["valeur non numérique", (f) => { f.layout.dimensionAllowances[0].referenceW = "3"; }],
      ["aucune borne", (f) => { f.layout.dimensionAllowances[0].minW = null; f.layout.dimensionAllowances[0].minD = null; }],
      ["autorisations dans un fichier v4", (f) => { f.version = 4; }],
    ];
    for (const [name, mutate] of invalidFiles) {
      const r = tamper(mutate);
      record(`Fichier avec autorisations invalides (${name}) : plan importé, autorisations écartées, avis explicite`, r.ok && r.value.layout.dimensionAllowances === undefined && r.notices.length === 1 && a.engineAllowances(r.value.layout).length === 0, r.ok ? r.notices[0] : r.error);
    }

    // 4) Recherche depuis la référence ; choix d'un résultat adapté : référence conservée.
    const res = g.regenerateWithAllowances(A, { allowances: a.engineAllowances(A) });
    record("Recherche adaptée à partir des autorisations enregistrées", res.ok && res.proposals.length >= 1, res.ok ? `${res.proposals.length} proposition(s)` : res.reason);
    if (res.ok && res.proposals.length) {
      const chosen = a.applyAdaptedProposal(A, res.proposals[0].layout);
      const refsKept = chosen.dimensionAllowances.every((e, i) => e.referenceW === A.dimensionAllowances[i].referenceW && e.referenceD === A.dimensionAllowances[i].referenceD && e.minW === A.dimensionAllowances[i].minW);
      record("Choix d'un résultat adapté : référence et bornes conservées, jamais remplacées par les dimensions réduites", refsKept && chosen.rooms[c1].w === 3.0 && chosen.dimensionAllowances.find((e) => e.roomIndex === c1).referenceW === L.rooms[c1].w);
      record("Après le choix : autorisations toujours valides (dimensions connues mises à jour)", kinds(chosen) === "valide,valide,valide,valide");
      const res2 = g.regenerateWithAllowances(chosen, { allowances: a.engineAllowances(chosen) });
      const noShrink = res2.ok && res2.proposals.every((p) => inputs.every((inp) => p.layout.rooms[inp.roomIndex].w >= inp.minW - 1e-9));
      record("Deuxième recherche avec la même référence : aucune réduction cumulative", noShrink, res2.ok ? `${res2.proposals.length} proposition(s)` : res2.reason);
      const reread = roundTrip(chosen);
      record("Résultat adapté choisi : sauvegarde et relecture fidèles (référence conservée)", reread.ok && JSON.stringify(reread.value.layout.dimensionAllowances) === JSON.stringify(chosen.dimensionAllowances));

      // 5) Modification manuelle, verrouillage, mise de côté → à reconfirmer / exclue.
      const resized = g.resizeRoomDimension(chosen, s1, "w", 1.55);
      const resizedLayout = resized.kind === "applied" ? resized.layout : null;
      const st = resizedLayout ? a.allowanceStates(resizedLayout).find((s) => s.entry.roomIndex === s1) : null;
      record("Modification manuelle des dimensions : autorisation « à reconfirmer », exclue de la recherche", !!st && st.status.kind === "a_reconfirmer" && !a.engineAllowances(resizedLayout).some((e) => e.roomIndex === s1), resized.kind === "applied" ? "" : resized.reason ?? resized.kind);
      if (resizedLayout) {
        const reconf = a.confirmAllowances(resizedLayout, inputs, "t2");
        const e = reconf.ok ? reconf.layout.dimensionAllowances.find((x) => x.roomIndex === s1) : null;
        record("Reconfirmation explicite : nouvelle référence = dimensions actuelles (visible, jamais silencieuse)", !!e && e.referenceW === 1.55);
      }
      const lockedL = g.lockRoom(chosen, c1);
      record("Pièce autorisée puis verrouillée : « exclue », jamais adaptée", a.allowanceStates(lockedL).find((s) => s.entry.roomIndex === c1).status.kind === "exclue" && !a.engineAllowances(lockedL).some((e) => e.roomIndex === c1));
      const parked = g.parkRoom(chosen, s2);
      record("Pièce mise de côté : « à reconfirmer »", !!parked && a.allowanceStates(parked).find((s) => s.entry.roomIndex === s2).status.kind === "a_reconfirmer");

      // 6) Révocation.
      const one = a.revokeAllowances(chosen, c2);
      const all = a.revokeAllowances(chosen);
      record("Révocation d'une pièce puis de toutes : plus aucune adaptation, fichier redevenu v4", !one.dimensionAllowances.some((e) => e.roomIndex === c2) && all.dimensionAllowances === undefined && pf.serializeProject(all, "N").version === 4);

      // 7) Proposition ordinaire choisie : autorisations conservées telles quelles.
      const ord = g.regenerateUnlocked(A).variants[0];
      record("Proposition sans réduction choisie : autorisations inchangées", JSON.stringify(a.applyOrdinaryProposal(A, ord).dimensionAllowances) === JSON.stringify(A.dimensionAllowances));
    }

    const total = results.length;
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${total} tests réussis.`);
    if (passed !== total) process.exitCode = 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
