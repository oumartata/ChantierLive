// Catalogue modifiable — copie d'un modèle vers un chantier (catalogueCopy.ts,
// premier sous-lot sans migration). Copie indépendante posée sur le terrain
// du chantier destinataire, sans autorisation F2 héritée, sans
// redimensionnement ni déplacement ; incompatibilités expliquées ; modèle
// jamais modifié ; paramètres du modèle distincts de ceux du chantier.
//
// Usage : node scripts/test-plans-catalogue-copy.mjs

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

const tmpDir = mkdtempSync(join(tmpdir(), "plans-catalogue-copy-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const sources = ["geometry.ts", "projectFile.ts", "catalogueCopy.ts"].map((f) => `"${join("src", "app", "prototype-plans", f)}"`).join(" ");
  const compile = spawnSync(`"${tscBin}" ${sources} --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
  const pf = await import(pathToFileURL(join(tmpDir, "projectFile.js")).href);
  const cc = await import(pathToFileURL(join(tmpDir, "catalogueCopy.js")).href);

  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const same = (x, y) => JSON.stringify(canon(x)) === JSON.stringify(canon(y));
  const load = (name) => {
    const v = pf.validateProjectFile(JSON.parse(readFileSync(join(repoRoot, "scripts", "fixtures", name), "utf8")));
    if (!v.ok) throw new Error(`${name}: ${v.error}`);
    return v.value;
  };
  const roomsGeom = (L) => L.rooms.map((r) => [r.type, r.number, r.x, r.y, r.w, r.d, !!r.locked, !!r.parked]);
  const need = (type, count, minWidth, minDepth) => ({ type, count, minWidth, minDepth });

  // Modèle C2 (v4) : terrain 20 × 14, reculs 3/2/2/2, accès avant.
  const c2 = load("plans-c2-resolu.projet.json");
  const c2Program = [need("salon", 1, 4, 4), need("chambre", 3, 3, 3), need("cuisine", 1, 2.5, 2.5), need("sanitaire", 2, 1.5, 1.8)];
  const destC2 = { terrainWidth: 20, terrainDepth: 14, setbacks: { front: 3, back: 2, left: 2, right: 2 }, accessSide: "front", orientation: "N", needs: c2Program };

  // -------------------------------------------------------------------------
  // 1. Paramètres saisis : lecture stricte
  // -------------------------------------------------------------------------
  const parsed = cc.parseDestinationParams(JSON.parse(JSON.stringify(destC2)));
  record("Paramètres valides acceptés", parsed.ok);
  const bad = [
    ["terrain nul", { ...destC2, terrainWidth: 0 }],
    ["reculs sans emprise", { ...destC2, setbacks: { front: 10, back: 5, left: 2, right: 2 } }],
    ["recul négatif", { ...destC2, setbacks: { ...destC2.setbacks, left: -1 } }],
    ["façade inconnue", { ...destC2, accessSide: "haut" }],
    ["type de pièce inconnu", { ...destC2, needs: [need("piscine", 1, 3, 3)] }],
    ["type en double", { ...destC2, needs: [need("chambre", 1, 3, 3), need("chambre", 2, 3, 3)] }],
    ["programme vide", { ...destC2, needs: [need("chambre", 0, 3, 3)] }],
    ["nombre non entier", { ...destC2, needs: [need("chambre", 1.5, 3, 3)] }],
  ];
  for (const [name, p] of bad) {
    const r = cc.parseDestinationParams(p);
    record(`Paramètres refusés — ${name}`, !r.ok, r.ok ? "accepté" : r.error);
  }

  // -------------------------------------------------------------------------
  // 2. Copie conforme : indépendante, sur le terrain du chantier
  // -------------------------------------------------------------------------
  const c2Before = JSON.stringify(c2);
  const ok = cc.prepareCatalogueCopy(c2, parsed.value, { modelLabel: "C2" });
  record("Copie sans écart : aucun blocage", ok.copy !== null && ok.report.blocking.length === 0, ok.report.blocking.join(" | "));
  record("Copie sans écart : rien à adapter", ok.report.toAdapt.length === 0, ok.report.toAdapt.join(" | "));
  record("Modèle strictement inchangé après la copie", JSON.stringify(c2) === c2Before);
  record("Copie indépendante (aucun objet partagé avec le modèle)", ok.copy.layout !== c2.layout && ok.copy.layout.rooms !== c2.layout.rooms && ok.copy.layout.rooms[0] !== c2.layout.rooms[0]);
  record("Pièces : positions et dimensions identiques (aucun redimensionnement ni déplacement)", same(roomsGeom(ok.copy.layout), roomsGeom(c2.layout)));
  record("Terrain et emprise = ceux du chantier", same(ok.copy.layout.terrain, { x: 0, y: 0, w: 20, d: 14 }) && same(ok.copy.layout.emprise, { x: 2, y: 3, w: 16, d: 9 }));
  const reread = pf.validateProjectFile(JSON.parse(JSON.stringify(ok.copy)));
  record("Copie relue : fichier v4 valide, sans avis ni autorisation", reread.ok && reread.value.version === 4 && reread.notices.length === 0 && !reread.value.layout.dimensionAllowances);
  record("Aucun verdict d'admissibilité dans le résultat", !("admissible" in ok.report) && !("valid" in ok.report) && !JSON.stringify(ok.report).match(/admissible|conforme|validé/i));

  // -------------------------------------------------------------------------
  // 3. Paramètres du modèle : référence distincte, jamais recopiée
  // -------------------------------------------------------------------------
  const ref = cc.modelReference(c2);
  record(
    "Référence du modèle déduite de SON fichier (terrain, reculs, accès, programme)",
    ref.terrainWidth === 20 && ref.terrainDepth === 14 && same(ref.setbacks, { front: 3, left: 2, right: 2, back: 2 }) && ref.accessSide === "front" &&
      ref.program.find((p) => p.type === "chambre")?.count === 3
  );
  const destOther = { ...destC2, terrainWidth: 22, terrainDepth: 16, setbacks: { front: 3, back: 3, left: 2, right: 2 }, orientation: "E" };
  const destOtherCopy = JSON.parse(JSON.stringify(destOther));
  const other = cc.prepareCatalogueCopy(c2, destOther, { modelLabel: "C2" });
  record("Paramètres du chantier jamais modifiés par la préparation", same(destOther, destOtherCopy));
  record(
    "Copie posée sur le terrain du chantier, pas sur celui du modèle",
    other.copy && other.copy.layout.terrain.w === 22 && other.copy.layout.terrain.d === 16 && other.copy.orientation === "E" && cc.modelReference(c2).terrainWidth === 20,
    other.report.blocking.join(" | ")
  );
  record("Changement d'orientation signalé", other.report.notes.some((n) => /Orientation du chantier \(E\)/.test(n)));

  // -------------------------------------------------------------------------
  // 4. Autorisations F2 : jamais héritées
  // -------------------------------------------------------------------------
  const f2 = load("plans-f2-v5-autorisations.projet.json");
  const f2Before = JSON.stringify(f2);
  const f2Dest = {
    terrainWidth: 15, terrainDepth: 20, setbacks: { front: 3, back: 2, left: 2, right: 2 }, accessSide: "front", orientation: "N",
    needs: [need("chambre", 3, 3, 3), need("salon", 1, 4, 4), need("cuisine", 1, 2.5, 2.5), need("sanitaire", 2, 1.5, 1.8)],
  };
  const f2Copy = cc.prepareCatalogueCopy(f2, f2Dest, { modelLabel: "F2" });
  record(
    "Modèle v5 : 4 autorisations retirées de la copie, signalées",
    f2Copy.copy && !f2Copy.copy.layout.dimensionAllowances && f2Copy.copy.version === 4 && f2Copy.report.removedAllowances === 4 && f2Copy.report.notes.some((n) => /jamais héritées/.test(n)),
    f2Copy.report.blocking.join(" | ")
  );
  record("Modèle v5 inchangé (ses 4 autorisations restent sur le modèle)", JSON.stringify(f2) === f2Before && f2.layout.dimensionAllowances.length === 4);
  record("Modèle v5 : dimensions conservées (aucun retour aux références)", same(roomsGeom(f2Copy.copy.layout), roomsGeom(f2.layout)));

  // -------------------------------------------------------------------------
  // 5. Incompatibilités expliquées
  // -------------------------------------------------------------------------
  const access = cc.prepareCatalogueCopy(c2, { ...destC2, accessSide: "left" }, { modelLabel: "C2" });
  record("Façade d'accès différente : bloquant, expliqué, aucune copie", access.copy === null && access.report.blocking.some((b) => /accès avant.*accès gauche.*jamais réorientée/.test(b)), access.report.blocking.join(" | "));

  const fewer = cc.prepareCatalogueCopy(c2, { ...destC2, needs: [need("salon", 1, 4, 4), need("chambre", 2, 3, 3), need("cuisine", 1, 2.5, 2.5), need("sanitaire", 2, 1.5, 1.8)] }, { modelLabel: "C2" });
  record("Programme différent (2 chambres demandées) : bloquant, expliqué", fewer.copy === null && fewer.report.blocking.some((b) => /« Chambre » — 3 dans le modèle, 2 demandée/.test(b)), fewer.report.blocking.join(" | "));
  const extra = cc.prepareCatalogueCopy(c2, { ...destC2, needs: [...c2Program, need("garage", 1, 3, 5)] }, { modelLabel: "C2" });
  record("Programme différent (garage demandé, absent du modèle) : bloquant", extra.copy === null && extra.report.blocking.some((b) => /« Garage » — 0 dans le modèle, 1 demandée/.test(b)));

  const c2Rooms = JSON.stringify(c2.layout.rooms);
  const bigger = cc.prepareCatalogueCopy(c2, { ...destC2, needs: [need("salon", 1, 4, 4), need("chambre", 3, 3.5, 3), need("cuisine", 1, 2.5, 2.5), need("sanitaire", 2, 1.5, 1.8)] }, { modelLabel: "C2" });
  record(
    "Minimum du chantier supérieur : bloquant, dimensions citées, aucun redimensionnement",
    bigger.copy === null && bigger.report.blocking.filter((b) => /Chambre \d » mesure 3,12 × 3,20 m, sous le minimum du chantier \(3,50 × 3,00 m\)\. Aucun redimensionnement automatique/.test(b)).length === 3 && JSON.stringify(c2.layout.rooms) === c2Rooms,
    bigger.report.blocking.join(" | ")
  );

  const shallow = cc.prepareCatalogueCopy(c2, { ...destC2, setbacks: { front: 3, back: 2.5, left: 2, right: 2 } }, { modelLabel: "C2" });
  record(
    "Terrain plus contraint (recul arrière 2,50 m) : copie créée, pièces hors emprise listées « à adapter »",
    shallow.copy !== null && shallow.report.blocking.length === 0 && shallow.report.toAdapt.filter((t) => /sort de l'emprise disponible/.test(t)).length === 6,
    [...shallow.report.blocking, ...shallow.report.toAdapt].join(" | ")
  );
  record("Terrain plus contraint : rien n'est déplacé ni réduit pour rentrer", same(roomsGeom(shallow.copy.layout), roomsGeom(c2.layout)));
  record("Terrain plus contraint : dépassement du bâti signalé", shallow.report.notes.some((n) => /ne tient pas entièrement dans l'emprise/.test(n)));

  const tight = cc.prepareCatalogueCopy(c2, { ...destC2, setbacks: { front: 4, back: 2, left: 2, right: 2 } }, { modelLabel: "C2" });
  record(
    "Circulation non déplaçable hors emprise (recul avant 4 m) : bloquant, expliqué",
    tight.copy === null && tight.report.blocking.some((b) => /Une circulation du modèle sort de l'emprise constructible du chantier : cet élément ne peut pas être déplacé/.test(b)),
    tight.report.blocking.join(" | ")
  );

  const parkedModel = JSON.parse(JSON.stringify(c2));
  parkedModel.layout.rooms[6].parked = true;
  const parked = cc.prepareCatalogueCopy(parkedModel, { ...destC2, needs: [need("salon", 1, 4, 4), need("chambre", 3, 3, 3), need("cuisine", 1, 2.5, 2.5), need("sanitaire", 1, 1.5, 1.8)] }, { modelLabel: "C2" });
  record("Pièce mise de côté dans le modèle : à replacer, signalée", parked.report.toAdapt.some((t) => /mises de côté : à replacer/.test(t)), [...parked.report.blocking, ...parked.report.toAdapt].join(" | "));

  const courtyardModel = JSON.parse(JSON.stringify(c2));
  courtyardModel.layout.courtyard = { x: 2, y: 0.5, w: 16, d: 2 };
  const court = cc.prepareCatalogueCopy(courtyardModel, destC2, { modelLabel: "C2" });
  record("Modèle avec cour d'entrée : refus explicite (limite de ce lot)", court.copy === null && court.report.blocking.some((b) => /cour d'entrée/.test(b)));

  const infeasible = JSON.parse(JSON.stringify(c2));
  infeasible.layout.feasible = false;
  const inf = cc.prepareCatalogueCopy(infeasible, destC2, { modelLabel: "C2" });
  record("Modèle sans disposition vérifiable : refus explicite", inf.copy === null && inf.report.blocking.some((b) => /disposition vérifiable/.test(b)));
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
