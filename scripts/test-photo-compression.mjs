// B025 — logique pure de compression des photos (src/lib/media/photoCompression.ts).
// Vérifie : jamais d'agrandissement, proportions conservées, original gardé
// s'il est déjà léger ou plus léger que le résultat, cible respectée
// (AC064/NFR003), refus expliqué si la cible est inatteignable ou si
// l'appareil ne peut pas préparer une photo trop lourde (EC026), vidéos
// jamais touchées.
//
// Usage : node scripts/test-photo-compression.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const tmpDir = mkdtempSync(join(tmpdir(), "photo-compression-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "src/lib/media/photoCompression.ts" --module commonjs --target es2020 --outDir "${tmpDir}" --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
  const p = await import(pathToFileURL(join(tmpDir, "photoCompression.js")).href);
  const C = p.PHOTO_COMPRESSION_DEFAULTS;

  // Configuration
  record("Cible par défaut = 1,5 Mo (NFR003 : <= 1,5 Mo)", C.targetBytes === 1_500_000 && C.targetBytes <= 1_500_000);
  record("Qualités décroissantes, plancher >= 0,6", C.qualities.every((q, i, a) => i === 0 || q < a[i - 1]) && Math.min(...C.qualities) >= 0.6);

  // Décision de compresser
  record("Vidéo : jamais touchée", p.planPhoto({ mimeType: "video/mp4", sizeBytes: 50_000_000 }, null).reason === "not_a_photo");
  record("Photo sous la cible et de taille raisonnable : envoyée telle quelle", p.planPhoto({ mimeType: "image/jpeg", sizeBytes: 800_000 }, { width: 2000, height: 1500 }).action === "keep");
  record("Photo au-dessus de la cible : compressée (AC064)", p.planPhoto({ mimeType: "image/jpeg", sizeBytes: 4_000_000 }, { width: 4000, height: 3000 }).reason === "above_target");
  record("Photo légère mais très grande en pixels : compressée", p.planPhoto({ mimeType: "image/png", sizeBytes: 900_000 }, { width: 6000, height: 4000 }).reason === "too_large_dimensions");
  record("PNG et WebP pris en charge", ["image/png", "image/webp"].every((t) => p.planPhoto({ mimeType: t, sizeBytes: 3_000_000 }, null).action === "compress"));

  // Dimensions
  const d1 = p.targetDimensions(4000, 3000, 2560);
  record("Réduction : côté long ramené à 2 560 px, proportions 4:3 conservées", d1.width === 2560 && d1.height === 1920, `${d1.width}×${d1.height}`);
  const d2 = p.targetDimensions(3000, 4000, 2560);
  record("Portrait : même règle sur la hauteur", d2.width === 1920 && d2.height === 2560, `${d2.width}×${d2.height}`);
  const d3 = p.targetDimensions(800, 600, 2560);
  record("Jamais d'agrandissement d'une petite image", d3.width === 800 && d3.height === 600);
  const d4 = p.targetDimensions(800, 600, 2560, 1.5);
  record("Jamais d'agrandissement même avec un facteur > 1", d4.width === 800 && d4.height === 600);
  const d5 = p.targetDimensions(4000, 3000, 2560, 0.8);
  record("Réduction supplémentaire appliquée en plus de la limite", d5.width === 2048 && d5.height === 1536, `${d5.width}×${d5.height}`);
  const d6 = p.targetDimensions(10000, 1, 2560);
  record("Jamais une dimension nulle", d6.width === 2560 && d6.height === 1);
  let threw = false;
  try { p.targetDimensions(0, 100, 2560); } catch { threw = true; }
  record("Dimensions invalides refusées", threw);

  // Ordre des essais
  const seq = p.attemptSequence();
  record("Essais : pleine taille d'abord, qualités décroissantes, puis réductions", seq[0].scale === 1 && seq[0].quality === 0.85 && seq[3].quality === 0.6 && seq[4].scale === 0.8 && seq.length === 12);

  // Choix du résultat
  const a = (scale, quality) => ({ scale, quality });
  const ok1 = p.chooseOutcome(4_000_000, [{ attempt: a(1, 0.85), sizeBytes: 1_200_000 }]);
  record("Premier essai sous la cible retenu (meilleure qualité)", ok1.kind === "compressed" && ok1.sizeBytes === 1_200_000 && ok1.attempt.quality === 0.85);
  const ok2 = p.chooseOutcome(4_000_000, [{ attempt: a(1, 0.85), sizeBytes: 1_900_000 }, { attempt: a(1, 0.75), sizeBytes: 1_400_000 }]);
  record("Qualité abaissée seulement si nécessaire", ok2.kind === "compressed" && ok2.attempt.quality === 0.75);
  const keep = p.chooseOutcome(1_000_000, [{ attempt: a(1, 0.85), sizeBytes: 1_100_000 }]);
  record("Résultat plus lourd que l'original : original gardé", keep.kind === "original" && keep.reason === "original_smaller");
  const refused = p.chooseOutcome(30_000_000, [{ attempt: a(0.64, 0.6), sizeBytes: 2_000_000 }]);
  record("Cible inatteignable : refus expliqué, jamais un envoi au-dessus de la cible (EC026)", refused.kind === "refused" && refused.reason === "target_unreachable" && /ne peut pas être ramenée sous 1,5 Mo/.test(refused.message) && /autres envois ne sont pas concernés/.test(refused.message));
  const smallNoFit = p.chooseOutcome(1_200_000, [{ attempt: a(1, 0.85), sizeBytes: 1_600_000 }]);
  record("Photo déjà sous la cible sans meilleur résultat : original gardé", smallNoFit.kind === "original");

  // Appareil incompatible
  const u1 = p.outcomeWhenUnsupported(900_000);
  record("Appareil incompatible, photo sous la cible : envoyée telle quelle", u1.kind === "original" && u1.reason === "unsupported_within_target");
  const u2 = p.outcomeWhenUnsupported(5_000_000);
  record("Appareil incompatible, photo trop lourde : refus expliqué (EC026)", u2.kind === "refused" && u2.reason === "unsupported_above_target" && /autre navigateur/.test(u2.message));

  // Nom du fichier préparé
  record("Nom : extension remplacée par .jpg", p.preparedFileName("IMG_1234.PNG") === "IMG_1234.jpg" && p.preparedFileName("chantier.photo.webp") === "chantier.photo.jpg" && p.preparedFileName("sans-extension") === "sans-extension.jpg");
  record("Taille affichée en Mo, en français", p.formatMegabytes(1_250_000) === "1,3 Mo" || p.formatMegabytes(1_250_000) === "1,2 Mo", p.formatMegabytes(1_250_000));
} catch (err) {
  console.error("ERREUR:", err.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
