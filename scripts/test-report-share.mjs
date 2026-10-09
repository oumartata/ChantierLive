// B047 — partage manuel du rapport (src/lib/report/share.ts ; BR072, AC123 ;
// D200). Fonctions pures compilées telles quelles, puis intégration LOCALE :
// - le contenu partagé ne porte AUCUN lien (ni champ « url ») et un texte
//   sans donnée du chantier ; contrôle capable d'échouer (R15) ;
// - repli (téléchargement) quand l'appareil ne sait pas partager un fichier ;
// - nom de fichier repris de B046 seulement s'il a la forme attendue ;
// - le fichier partagé est le PDF de B046 pour ce rôle ; aucun objet stocké,
//   aucun lien signé créé.
//
// Usage : node --env-file=.env.local scripts/test-report-share.mjs

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { makeScanner } from "./lib/private-scan.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const local = (() => { try { const { hostname } = new URL(SUPABASE_URL); return hostname === "127.0.0.1" || hostname === "localhost"; } catch { return false; } })();
if (!local) { console.error(`Destination NON locale refusée : ${SUPABASE_URL}.`); process.exit(1); }

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const results = [];
function record(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "OK " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const one = (d) => (Array.isArray(d) ? d[0] : d);
async function must(res, what) { const r = await res; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; }
const psqlValue = (sql) => new Promise((resolve, reject) => {
  const proc = spawn("docker", ["exec", "-i", "supabase_db_ChantierLive", "psql", "-At", "-U", "postgres", "-d", "postgres", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] });
  let o = "";
  proc.stdout.on("data", (d) => (o += d));
  proc.on("close", (c) => (c === 0 ? resolve(o.trim()) : reject(new Error("psql"))));
});

const cacheDir = join(repoRoot, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const tmpDir = mkdtempSync(join(cacheDir, "test-partage-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compile = spawnSync(`"${tscBin}" "src/lib/report/share.ts" "src/lib/report/report.ts" --module commonjs --target es2020 --outDir "${tmpDir}" --skipLibCheck --strict --esModuleInterop`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(`compilation : ${compile.stdout}${compile.stderr}`);
  const S = await import(pathToFileURL(join(tmpDir, "share.js")).href);
  const R = await import(pathToFileURL(join(tmpDir, "report.js")).href);

  // Chantier jetable au nom repérable.
  const email = `b047-proprietaire-${Date.now()}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data: u } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  const ctEmail = `b047-entreprise-${Date.now()}@example.test`;
  const { data: c } = await service.auth.admin.createUser({ email: ctEmail, password, email_confirm: true });
  const owner = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const contractor = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  await owner.auth.signInWithPassword({ email, password });
  await contractor.auth.signInWithPassword({ email: ctEmail, password });
  const name = `CHANTIER-PARTAGE-${String(Date.now()).slice(-6)} Éloïse`;
  const pid = one(await must(contractor.rpc("create_draft_project", { p_name: name, p_country: "ML", p_role: "CONTRACTOR" }), "projet")).project_id;
  await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.user.id, role: "OWNER", owner_profile: "PRIMARY" }), "adhésion");

  // 1. Contenu partagé : fichier seul, aucun lien, texte sans donnée.
  const scan = makeScanner([name, "CHANTIER-PARTAGE", pid, pid.slice(0, 8), email, u.user.id]);
  const checkPayload = (p) => {
    const keys = Object.keys(p).sort().join(",");
    const txt = JSON.stringify({ title: p.title, text: p.text });
    return keys === "files,text,title" && !("url" in p) && !/https?:|www\.|\/chantiers\/|\d/.test(txt) && scan(txt).length === 0 && p.files.length === 1;
  };
  const fakeFile = { name: `rapport-chantier-${pid.slice(0, 8)}-2026-09-09_2026-10-08.pdf`, type: "application/pdf", size: 1234 };
  const payload = S.buildSharePayload(fakeFile);
  record("Contenu partagé : titre, texte et le fichier seul ; aucun champ « url », aucun lien, aucun chiffre, aucune donnée du chantier",
    checkPayload(payload) && payload.files[0] === fakeFile, JSON.stringify({ title: payload.title, text: payload.text, keys: Object.keys(payload) }));
  const forged = [
    { ...payload, url: `http://localhost:3001/chantiers/${pid}/rapports` },
    { ...payload, text: `Rapport ${name}` },
    { ...payload, text: "Prix convenu 10 000 000 FCFA" },
    { ...payload, files: [] },
  ];
  record("Contrôle positif (R15) : le contrôle échoue sur un contenu altéré (lien, nom du chantier, montant, sans fichier)", forged.every((p) => !checkPayload(p)), forged.map((p) => checkPayload(p)).join(","));

  // 2. Partage natif ou repli.
  const navShare = { canShare: (d) => Array.isArray(d.files) && d.files.length === 1, share: async () => {} };
  record("Partage natif d'un fichier détecté quand l'appareil le permet", S.canShareFile(navShare, fakeFile) === true);
  const fallbacks = [undefined, {}, { share: async () => {} }, { canShare: () => true }, { canShare: () => false, share: async () => {} }, { canShare: () => { throw new Error("x"); }, share: async () => {} }];
  record("Repli (téléchargement) : pas de navigateur, pas de Web Share, pas de partage de fichier, ou erreur → partage natif considéré impossible", fallbacks.every((n) => S.canShareFile(n, fakeFile) === false));

  // 3. Nom de fichier : celui de B046, ou générique.
  const good = `attachment; filename="rapport-chantier-${pid.slice(0, 8)}-2026-09-09_2026-10-08.pdf"`;
  record("Nom de fichier repris de B046 seulement s'il a la forme attendue ; sinon « rapport-chantier.pdf »",
    S.fileNameFromDisposition(good) === `rapport-chantier-${pid.slice(0, 8)}-2026-09-09_2026-10-08.pdf`
      && S.fileNameFromDisposition(`attachment; filename="${name}.pdf"`) === "rapport-chantier.pdf"
      && S.fileNameFromDisposition(`attachment; filename="../../secret.pdf"`) === "rapport-chantier.pdf"
      && S.fileNameFromDisposition(null) === "rapport-chantier.pdf");

  // 4. Le fichier partagé est le PDF de B046 ; rien n'est stocké, aucun lien signé.
  const storageBefore = await psqlValue("select count(*) from storage.objects");
  const { from, to } = R.defaultPeriod(new Date());
  const g = await R.generateReport(owner, pid, from, to);
  const storageAfter = await psqlValue("select count(*) from storage.objects");
  record("Fichier partagé = PDF de B046 pour ce rôle (même générateur, même nom), en mémoire seulement",
    g.bytes.subarray(0, 5).toString() === "%PDF-" && g.fileName === S.fileNameFromDisposition(`attachment; filename="${g.fileName}"`) && g.data.party === "OWNER_PRIMARY", `${(g.bytes.length / 1024).toFixed(1)} Ko`);
  record("Aucun lien public ni objet stocké : stockage inchangé", storageAfter === storageBefore, `${storageBefore} → ${storageAfter}`);
  const traces = await must(owner.rpc("list_my_report_generations", { p_project_id: pid }), "traces");
  record("Seule la trace de génération de B046 est gardée (auteur seul)", traces.length === 1 && traces[0].report_id === g.data.reportId);
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
