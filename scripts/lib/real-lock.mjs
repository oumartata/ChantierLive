// Verrous RÉELS pour les tests d'attente (boucle 33 ; même correctif que
// test-project-plans-revue en boucle 29, D190). Aucun délai fixe :
// - le verrou est tenu par une connexion psql séparée JUSQU'À ce que le test
//   le relâche (« locked » se résout quand psql l'a réellement obtenu) ;
// - l'attente de l'appel testé est CONSTATÉE en base (pg_blocking_pids),
//   jamais supposée après un délai ;
// - les durées minimales déjà exigées par les tests sont conservées : le
//   verrou est tenu au moins ce temps après le départ de l'appel.
//
// Sabotage volontaire (preuve que les contrôles peuvent échouer, R15) :
// REAL_LOCK_SABOTAGE=1 relâche le verrou (ou la porte) AVANT l'appel testé,
// sans attendre : l'appel ne peut plus être bloqué.

import { spawn } from "node:child_process";

export const LOCK_TIMEOUT_MS = 60000;
const SABOTAGE = process.env.REAL_LOCK_SABOTAGE === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PSQL = ["exec", "-i", "supabase_db_ChantierLive", "psql", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"];

export function openLock(lockSql) {
  const proc = spawn("docker", PSQL, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let resolveLocked;
  let rejectLocked;
  const locked = new Promise((res, rej) => { resolveLocked = res; rejectLocked = rej; });
  const timer = setTimeout(() => rejectLocked(new Error(`verrou non obtenu en ${LOCK_TIMEOUT_MS} ms : ${stderr}`)), LOCK_TIMEOUT_MS);
  proc.stdout.on("data", (d) => {
    stdout += d.toString();
    const m = stdout.match(/VERROU_PRIS (\d+)/);
    if (m) { clearTimeout(timer); resolveLocked(Number(m[1])); }
  });
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const closed = new Promise((res, rej) => proc.on("close", (code) => (code === 0 ? res() : rej(new Error(`verrou : psql exit ${code}: ${stderr}`)))));
  closed.catch((e) => { clearTimeout(timer); rejectLocked(e); });
  proc.stdin.write(`begin;\n${lockSql};\nselect 'VERROU_PRIS ' || pg_backend_pid();\n`);
  let released = false;
  return {
    locked,
    release: async () => {
      if (released) return closed;
      released = true;
      proc.stdin.write("commit;\n");
      proc.stdin.end();
      await closed;
    },
  };
}

function psqlValue(sql) {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", [...PSQL, "-c", sql], { stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    let e = "";
    proc.stdout.on("data", (d) => (o += d.toString()));
    proc.stderr.on("data", (d) => (e += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolve(o.trim()) : reject(new Error(`psql exit ${code}: ${e}`))));
  });
}

// Pids des connexions bloquées par « blockerPid », interrogées jusqu'à en
// observer au moins « count » (ou jusqu'au délai maximal).
export async function waitForBlockedBy(blockerPid, count = 1, timeoutMs = LOCK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await psqlValue(`select coalesce(string_agg(pid::text, ','), '') from pg_stat_activity where ${Number(blockerPid)} = any(pg_blocking_pids(pid))`);
    const pids = out ? out.split(",").map(Number) : [];
    if (pids.length >= count) return pids;
  }
  return [];
}

// Appel lancé pendant qu'un verrou réel est tenu : verrou obtenu, appel
// envoyé, attente constatée, mutation pendant l'attente, durée minimale
// conservée, puis relâche.
export async function callWhileLocked({ lockSql, call, beforeCall, duringWait, minElapsedMs = 0 }) {
  const lock = openLock(lockSql);
  try {
    const blockerPid = await lock.locked;
    if (SABOTAGE) await lock.release();
    if (beforeCall) await beforeCall();
    const start = Date.now();
    // Les appels supabase-js sont paresseux : .then() force l'envoi immédiat.
    const pending = Promise.resolve(call()).then((r) => r);
    const waited = SABOTAGE ? false : (await waitForBlockedBy(blockerPid, 1)).length >= 1;
    if (duringWait) await duringWait();
    while (!SABOTAGE && Date.now() - start < minElapsedMs) await sleep(50);
    await lock.release();
    const res = await pending;
    return { res, elapsed: Date.now() - start, waited };
  } finally {
    await lock.release().catch(() => {});
  }
}

// Porte : verrou consultatif que le test tient ; un déclencheur de test y
// arrête une transaction « rivale » jusqu'à la relâche (remplace pg_sleep).
export const gateKeyOf = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) + 1000;
};
export function openGate(gateKey) {
  const gate = openLock(`select pg_advisory_xact_lock(${Number(gateKey)})`);
  return {
    locked: gate.locked,
    release: gate.release,
    sabotage: SABOTAGE,
  };
}
