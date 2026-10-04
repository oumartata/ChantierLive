// Instantané des effets du vérificateur sur la génération, la régénération et
// le redimensionnement (lot « façades extérieures », 2026-10-04). Sert à
// comparer AVANT / APRÈS un changement de independentVerify : jamais une
// affirmation « inchangé » sans comparaison.
//
// Usage :
//   node scripts/snapshot-plans-verifier-effects.mjs <sortie.json>
//   node scripts/snapshot-plans-verifier-effects.mjs --compare <avant.json> <après.json>

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

if (process.argv[2] === "--compare") {
  const a = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const b = JSON.parse(readFileSync(process.argv[4], "utf8"));
  for (const section of ["generation", "regeneration", "resize"]) {
    const keys = new Set([...Object.keys(a[section]), ...Object.keys(b[section])]);
    const diffs = [...keys].filter((k) => JSON.stringify(a[section][k]) !== JSON.stringify(b[section][k]));
    console.log(`${section} : ${keys.size} entrées, ${diffs.length} différence(s)`);
    for (const k of diffs) console.log(`  - ${k}\n      avant : ${JSON.stringify(a[section][k]).slice(0, 300)}\n      après : ${JSON.stringify(b[section][k]).slice(0, 300)}`);
  }
  process.exit(0);
}

const out = process.argv[2];
const tmpDir = mkdtempSync(join(tmpdir(), "plans-snapshot-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "${join("src", "app", "prototype-plans", "geometry.ts")}" --module commonjs --target es2020 --outDir "${tmpDir}" --esModuleInterop --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
  const g = await import(pathToFileURL(join(tmpDir, "geometry.js")).href);

  const NEEDS = [
    { type: "chambre", label: "Chambre", count: 3, minWidth: 3, minDepth: 3, targetWidth: 3.5, targetDepth: 3.5 },
    { type: "salon", label: "Salon", count: 1, minWidth: 4, minDepth: 4, targetWidth: 5, targetDepth: 4.5 },
    { type: "cuisine", label: "Cuisine", count: 1, minWidth: 2.5, minDepth: 2.5, targetWidth: 3, targetDepth: 3 },
    { type: "sanitaire", label: "Sanitaire", count: 2, minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2 },
    { type: "garage", label: "Garage", count: 0, minWidth: 3, minDepth: 5, targetWidth: 3.5, targetDepth: 5.5 },
  ];
  const BASE = { orientation: "N", setbacks: { front: 3, back: 2, left: 2, right: 2 }, entryMode: "direct", courtyardDepth: 3, centralSalon: false, roomsConnectVia: "corridor", sanitaireConnectVia: "corridor", needs: NEEDS };
  const r2 = (v) => Math.round(v * 100) / 100;
  const shape = (L) => L.rooms.map((r) => `${r.label}${r.number}@${r2(r.x)},${r2(r.y)},${r2(r.w)},${r2(r.d)}${r.locked ? "L" : ""}`).join(";");
  const issues = (L) => g.independentVerify(L).map((i) => i.message).sort();
  const snap = { generation: {}, regeneration: {}, resize: {} };

  const terrains = [[15, 20], [20, 14], [12, 25], [18, 18], [20, 20], [16, 18], [22, 18], [17, 24], [12, 30], [15, 25]];
  const firstVariants = [];
  for (const side of ["front", "back", "left", "right"]) {
    for (const [W, D] of terrains) {
      for (const entryMode of ["direct", "courtyard"]) {
        const key = `${side} ${W}x${D} ${entryMode}`;
        const res = g.generateVariants({ ...BASE, accessSide: side, terrainWidth: W, terrainDepth: D, entryMode });
        snap.generation[key] = {
          variants: res.variants.map((v) => ({ label: v.variantLabel, rejected: v.rejected, reasons: v.rejectionReasons, shape: shape(v), issues: issues(v) })),
          rejected: (res.rejectedVariants ?? []).map((v) => ({ label: v.variantLabel, reasons: v.rejectionReasons, shape: shape(v) })),
          failures: (res.attemptFailureReasons ?? []).length,
        };
        if (res.variants[0] && W === 15 && (D === 20 || D === 25)) firstVariants.push([key, res.variants[0]]);
      }
    }
  }
  for (const [key, L] of firstVariants) {
    L.rooms.forEach((r, i) => {
      const locked = g.lockRoom(L, i);
      const reg = g.regenerateUnlocked(locked);
      snap.regeneration[`${key} verrou ${r.label}${r.number}`] = {
        variants: reg.variants.map((v) => shape(v)),
        notes: reg.preferenceNotes,
        failures: reg.failureReasons.length,
      };
    });
  }
  for (const side of ["front", "back", "left", "right"]) {
    const L = g.generateVariants({ ...BASE, accessSide: side, terrainWidth: 15, terrainDepth: 20 }).variants[0];
    L.rooms.forEach((room, i) => {
      for (const field of ["w", "d"]) {
        for (const delta of [-0.3, 0.3, 0.6]) {
          const a = g.resizeRoomDimension(L, i, field, (field === "w" ? room.w : room.d) + delta);
          snap.resize[`${side} ${room.label}${room.number} ${field}${delta > 0 ? "+" : ""}${delta}`] =
            a.kind === "applied" ? { kind: a.kind, message: a.message, shape: shape(a.layout) } : a.kind === "refused" ? { kind: a.kind, reason: a.reason } : { kind: a.kind };
        }
      }
    });
  }
  writeFileSync(out, JSON.stringify(snap, null, 1));
  console.log(`générations ${Object.keys(snap.generation).length}, régénérations ${Object.keys(snap.regeneration).length}, redimensionnements ${Object.keys(snap.resize).length} → ${out}`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
