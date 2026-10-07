// B027 — libellés d'origine et métadonnées (src/lib/media/mediaDisplay.ts).
// Vérifie les libellés EXACTS d'UX_COPY pour les deux origines (AC062), la
// mention TXT038, l'absence de tout libellé interdit (BR041) et le format
// des métadonnées affichées.
//
// Usage : node scripts/test-media-display.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const uxCopy = (id) => {
  const line = readFileSync(join(repoRoot, "UX_COPY.csv"), "utf8").split(/\r?\n/).find((l) => l.startsWith(`${id},`));
  return line ? line.split(",").slice(2, -1).join(",").replace(/^"|"$/g, "") : null;
};

const tmpDir = mkdtempSync(join(tmpdir(), "media-display-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "src/lib/media/mediaDisplay.ts" --module commonjs --target es2020 --outDir "${tmpDir}" --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
  const m = await import(pathToFileURL(join(tmpDir, "mediaDisplay.js")).href);

  const captured = m.originLabel("CAPTURED");
  const imported = m.originLabel("IMPORTED");
  record("Capturée : libellé exact TXT036", captured.known && captured.label === uxCopy("TXT036"), captured.label);
  record("Importée : libellé exact TXT037", imported.known && imported.label === uxCopy("TXT037"), imported.label);
  record("Les deux origines sont distinctes (AC062)", captured.label !== imported.label);
  record("Mention d'origine : texte exact TXT038", m.ORIGIN_NOTICE === uxCopy("TXT038"), m.ORIGIN_NOTICE);
  for (const v of [null, undefined, "", "VERIFIED", "captured"]) {
    const r = m.originLabel(v);
    record(`Origine imprévue (${JSON.stringify(v)}) : non reconnue, jamais présentée comme garantie`, !r.known && r.label === "Origine non renseignée");
  }
  const all = [captured, imported, m.originLabel("X")].map((r) => r.label).join(" ") + " " + m.ORIGIN_NOTICE;
  record("Aucun libellé interdit (BR041 : Vérifiée, Incontestable)", !/vérifiée|incontestable/i.test(all.replace("ne garantit pas", "")));

  record("Type : JPEG", m.mediaKindLabel("image/jpeg") === "Photo JPEG");
  record("Type : MP4", m.mediaKindLabel("video/mp4") === "Vidéo MP4");
  record("Type : vidéo inconnue", m.mediaKindLabel("video/quicktime") === "Vidéo");
  record("Type absent", m.mediaKindLabel(null) === "Type inconnu");
  record("Taille : octets", m.formatFileSize(512) === "512 octets");
  record("Taille : Ko avec virgule", m.formatFileSize(1530) === "1,5 Ko", m.formatFileSize(1530));
  record("Taille : Mo avec virgule", m.formatFileSize(2_450_000) === "2,5 Mo", m.formatFileSize(2_450_000));
  record("Taille absente ou nulle", m.formatFileSize(0) === "—" && m.formatFileSize(null) === "—");
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
