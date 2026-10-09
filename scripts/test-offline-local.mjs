// L06 — première tranche (B036 base locale par compte, B037 file UUID ; O1 à
// O14 ; D202). La logique RÉELLE (src/lib/offline/*.ts) est compilée puis
// exécutée sur le stockage en mémoire (même interface qu'IndexedDB) :
// - B036 : brouillons persistants après « fermeture » (nouvelle instance) ;
// - B037 : UUID créé avant le stockage, FIFO, une seule opération active par
//   entité (même sous appels simultanés), dépendances, 2 entités au plus ;
// - O12 P1 : effacement immédiat si rien n'est en attente ; sinon
//   confirmation, « Annuler » ne touche à rien, « Effacer » efface et laisse
//   un avis sans contenu au premier compte ;
// - O6 : déconnexion (rien en attente → effacement ; sinon export ou
//   effacement explicite) ; D202 : retrait d'un membre ;
// - référence construite côté serveur pour chaque rôle (base LOCALE) et
//   scanner du stockage local, capable d'échouer (R15).
//
// Usage : node --env-file=.env.local scripts/test-offline-local.mjs

import { spawnSync } from "node:child_process";
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
async function user(label) {
  const email = `l06-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password });
  return { id: data.user.id, email, client, label };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const journal = (text, phaseId = null) => ({ logDate: "2026-10-09", worksDone: text, difficulties: "", team: "", nextActions: "", phaseId });
const incident = (text) => ({ incidentType: "AUTRE", severity: "URGENTE", occurredAt: "2026-10-09T08:00:00.000Z", description: text, phaseId: null });

const cacheDir = join(repoRoot, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const tmpDir = mkdtempSync(join(cacheDir, "test-hors-ligne-"));
try {
  const tscBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const files = ["store", "queue", "account", "reference"].map((f) => `"src/lib/offline/${f}.ts"`).join(" ");
  const compile = spawnSync(`"${tscBin}" ${files} --module commonjs --target es2022 --lib es2022,dom --outDir "${tmpDir}" --skipLibCheck --strict`, { shell: true, encoding: "utf8", cwd: repoRoot });
  if (compile.status !== 0) throw new Error(`compilation : ${compile.stdout}${compile.stderr}`);
  const S = await import(pathToFileURL(join(tmpDir, "store.js")).href);
  const Q = await import(pathToFileURL(join(tmpDir, "queue.js")).href);
  const A = await import(pathToFileURL(join(tmpDir, "account.js")).href);
  const REF = await import(pathToFileURL(join(tmpDir, "reference.js")).href);

  const P1 = "11111111-1111-4111-8111-111111111111";
  const P2 = "22222222-2222-4222-8222-222222222222";
  const ref = (projects) => ({ fetchedAt: new Date().toISOString(), projects });
  const proj = (projectId, party, name) => ({ projectId, name, party, kinds: REF.OFFLINE_KINDS[party], phases: [] });

  // ---- B036 : persistance après fermeture ----
  const backend1 = new S.MemoryBackend();
  const opened = await A.openForAccount(backend1, "profil-chef");
  const db1 = await A.currentAccountDb(backend1);
  await A.applyReference(db1, ref([proj(P1, "SITE_MANAGER", "Chantier un"), proj(P2, "OWNER_PRIMARY", "Chantier deux")]));
  const j = await A.saveDraft(db1, { projectId: P1, kind: "JOURNAL", fields: journal("Coulage de la dalle") });
  await A.saveDraft(db1, { projectId: P1, kind: "INCIDENT", fields: incident("Fuite d'eau") });
  const reopened = new S.MemoryBackend(backend1.data); // application fermée puis rouverte
  const again = await A.openForAccount(reopened, "profil-chef");
  const drafts = await A.listDrafts(await A.currentAccountDb(reopened));
  record("B036 : brouillons persistants après fermeture et réouverture (même compte, même base)", opened.kind === "ready" && again.kind === "ready" && again.accountKey === opened.accountKey && drafts.length === 2 && drafts[0].fields.worksDone === "Coulage de la dalle");
  const names = await reopened.list();
  record("Une base par compte, nommée par une clé hachée (jamais l'identifiant du compte)", names.some((n) => n === `chantierlive-compte-${opened.accountKey}`) && !names.some((n) => n.includes("profil-chef")) && /^[0-9a-f]{32}$/.test(opened.accountKey));
  const notAllowed = await A.saveDraft(db1, { projectId: P2, kind: "JOURNAL", fields: journal("x") }).then(() => "accepté", (e) => e.message);
  const unknown = await A.saveDraft(db1, { projectId: randomUUID(), kind: "INCIDENT", fields: incident("x") }).then(() => "accepté", (e) => e.message);
  record("O2 : journal refusé pour un propriétaire ; chantier hors référence refusé", notAllowed === "not_allowed_offline" && unknown === "not_allowed_offline", `${notAllowed} / ${unknown}`);

  // ---- B037 : file ----
  const ops0 = await Q.listOps(db1);
  record("B037 : UUID d'opération (v4) créé et conservé pour chaque brouillon", ops0.length === 2 && ops0.every((o) => UUID_RE.test(o.operationUuid) && o.status === "PENDING"));
  const upd = await A.saveDraft(db1, { entityId: j.draft.entityId, projectId: P1, kind: "JOURNAL", fields: journal("Coulage de la dalle, suite") });
  const qb = new S.MemoryBackend();
  const qdb = await qb.open("file-test");
  const e1a = await Q.enqueue(qdb, { projectId: P1, entityType: "JOURNAL", entityId: "e1", action: "CREATE_DRAFT", dependsOn: null });
  const e1b = await Q.enqueue(qdb, { projectId: P1, entityType: "JOURNAL", entityId: "e1", action: "UPDATE_DRAFT", dependsOn: e1a.operationUuid });
  const e2 = await Q.enqueue(qdb, { projectId: P1, entityType: "INCIDENT", entityId: "e2", action: "CREATE_DRAFT", dependsOn: null });
  const e3 = await Q.enqueue(qdb, { projectId: P1, entityType: "INCIDENT", entityId: "e3", action: "CREATE_DRAFT", dependsOn: null });
  const sel = Q.selectRunnable(await Q.listOps(qdb));
  record("B037 : FIFO par entité, 2 entités au plus en parallèle", sel.runnable.map((o) => o.operationUuid).join() === [e1a.operationUuid, e2.operationUuid].join(), sel.runnable.map((o) => o.entityId).join());
  const race = await Promise.allSettled([Q.activateExclusive(qb, qdb, e1a.operationUuid), Q.activateExclusive(qb, qdb, e1a.operationUuid)]);
  const second = await Q.activate(qdb, e1b.operationUuid).then(() => "activée", (e) => e.code);
  const actives = (await Q.listOps(qdb)).filter((o) => o.status === "ACTIVE" && o.entityId === "e1").length;
  record("B037 : une seule opération active par entité (deux activations simultanées → une seule réussit ; la suivante de l'entité refusée)",
    race.filter((r) => r.status === "fulfilled").length === 1 && second === "entity_already_active" && actives === 1, `${race.map((r) => r.status).join(",")} / ${second}`);
  const blockedBefore = Q.selectRunnable(await Q.listOps(qdb)).blocked.map((o) => o.operationUuid);
  await Q.settle(qdb, e1a.operationUuid, "DONE");
  const afterParent = Q.selectRunnable(await Q.listOps(qdb)).runnable.map((o) => o.operationUuid);
  record("B037 : dépendance — l'opération suivante attend son parent, puis devient sélectionnable", !blockedBefore.includes(e1b.operationUuid) && afterParent.includes(e1b.operationUuid) && afterParent.includes(e2.operationUuid) && !afterParent.includes(e3.operationUuid), afterParent.length + " sélectionnables");
  const dep = await Q.enqueue(qdb, { projectId: P1, entityType: "INCIDENT", entityId: "e4", action: "CREATE_DRAFT", dependsOn: e3.operationUuid });
  record("B037 : opération dépendante d'un parent non terminé → bloquée (BLOCKED_DEPENDENCY)", Q.selectRunnable(await Q.listOps(qdb), 5).blocked.some((o) => o.operationUuid === dep.operationUuid));
  record("Mise à jour hors ligne d'un brouillon : nouvelle opération dépendante de la précédente, même entité", upd.op.action === "UPDATE_DRAFT" && upd.op.dependsOn === ops0.find((o) => o.entityId === j.draft.entityId).operationUuid);

  // ---- O12 P1 ----
  const b2 = new S.MemoryBackend();
  await A.openForAccount(b2, "profil-A");
  const r1 = await A.openForAccount(b2, "profil-B");
  record("O12 : compte précédent sans rien en attente → effacé immédiatement, sans avertissement ni avis", r1.kind === "ready" && (await b2.list()).filter((n) => n.startsWith("chantierlive-compte-")).length === 1 && Object.keys((await A.dumpAll(b2))["chantierlive-appareil"].notices).length === 0);
  const b3 = new S.MemoryBackend();
  await A.openForAccount(b3, "profil-A");
  const dbA = await A.currentAccountDb(b3);
  await A.applyReference(dbA, ref([proj(P1, "CONTRACTOR", "Chantier un")]));
  await A.saveDraft(dbA, { projectId: P1, kind: "JOURNAL", fields: journal("Texte de A") });
  await A.saveDraft(dbA, { projectId: P1, kind: "INCIDENT", fields: incident("Incident de A") });
  const before = JSON.stringify(await A.dumpAll(b3));
  const r2 = await A.openForAccount(b3, "profil-B");
  const afterCancel = JSON.stringify(await A.dumpAll(b3));
  record("O12 : brouillons en attente → avertissement au nouveau compte (2 brouillons) ; « Annuler » ne touche à rien", r2.kind === "confirm" && r2.pendingTotal === 2 && afterCancel === before && !afterCancel.includes(r2.accountKey));
  const r3 = await A.confirmEraseOthers(b3, "profil-B");
  const dumpB = await A.dumpAll(b3);
  const noticeKeys = Object.entries(dumpB["chantierlive-appareil"].notices);
  record("O12 : « Effacer et continuer » efface la base de A et crée un avis sans contenu (nombre et date)",
    r3.kind === "ready" && !JSON.stringify(dumpB).includes("Texte de A") && noticeKeys.length === 1 && noticeKeys[0][1].erasedCount === 2 && Object.keys(noticeKeys[0][1]).sort().join() === "erasedAt,erasedCount");
  const r4 = await A.openForAccount(b3, "profil-A");
  const r5 = await A.openForAccount(new S.MemoryBackend(b3.data), "profil-A");
  record("O12 : le premier compte est informé à son retour (2 brouillons, date), une seule fois", r4.kind === "ready" && r4.notice?.erasedCount === 2 && !!r4.notice?.erasedAt && r5.kind === "ready" && r5.notice === null);

  // Référence d'une session qui ne correspond pas au compte de la base ouverte.
  const b6 = new S.MemoryBackend();
  await A.openForAccount(b6, "profil-E");
  const wrong = await A.applyReferenceForSession(b6, "profil-F", ref([proj(P1, "CONTRACTOR", "Chantier de F")]));
  const right = await A.applyReferenceForSession(b6, "profil-E", ref([proj(P2, "SITE_MANAGER", "Chantier de E")]));
  const dumpE = JSON.stringify(await A.dumpAll(b6));
  record("Référence d'une autre session jamais appliquée dans la base ouverte ; celle du bon compte appliquée", !wrong.applied && right.applied && !dumpE.includes("Chantier de F") && dumpE.includes("Chantier de E"));

  // ---- O6 : déconnexion ----
  const b4 = new S.MemoryBackend();
  await A.openForAccount(b4, "profil-C");
  record("Déconnexion sans brouillon en attente → rien à choisir", (await A.logoutCheck(b4)).pending === 0);
  await A.eraseCurrentAccount(b4);
  record("Déconnexion : base du compte effacée, compte courant oublié", (await b4.list()).every((n) => !n.startsWith("chantierlive-compte-")) && !(await A.currentAccountDb(b4)));
  await A.openForAccount(b4, "profil-C");
  const dbC = await A.currentAccountDb(b4);
  await A.applyReference(dbC, ref([proj(P1, "SITE_MANAGER", "Chantier un")]));
  await A.saveDraft(dbC, { projectId: P1, kind: "JOURNAL", fields: journal("Brouillon de C à exporter") });
  const check = await A.logoutCheck(b4);
  const exported = JSON.parse(await A.exportDrafts(dbC));
  await A.eraseCurrentAccount(b4);
  record("Déconnexion avec brouillon : choix requis ; export de ses propres brouillons, puis effacement", check.pending === 1 && exported.drafts.length === 1 && exported.drafts[0].fields.worksDone === "Brouillon de C à exporter" && !JSON.stringify(await A.dumpAll(b4)).includes("Brouillon de C"));

  // ---- D202 : retrait d'un membre ----
  const b5 = new S.MemoryBackend();
  await A.openForAccount(b5, "profil-D");
  const dbD = await A.currentAccountDb(b5);
  await A.applyReference(dbD, ref([proj(P1, "SITE_MANAGER", "Chantier retiré"), proj(P2, "SITE_MANAGER", "Chantier gardé")]));
  const kept = await A.saveDraft(dbD, { projectId: P1, kind: "JOURNAL", fields: journal("Mon brouillon sur le chantier retiré") });
  await A.saveDraft(dbD, { projectId: P2, kind: "INCIDENT", fields: incident("Sur le chantier gardé") });
  const res = await A.applyReference(dbD, ref([proj(P2, "SITE_MANAGER", "Chantier gardé")]));
  const opsD = await Q.listOps(dbD);
  const dumpD = JSON.stringify(await A.dumpAll(b5));
  record("Retrait d'un membre : données du chantier effacées dès la reconnexion (nom, rôle)", res.removedProjects.join() === P1 && !dumpD.includes("Chantier retiré"));
  record("Retrait : ses propres brouillons conservés, « refusés : accès retiré », jamais sélectionnés pour l'envoi",
    (await A.listDrafts(dbD)).some((d) => d.entityId === kept.draft.entityId) && opsD.filter((o) => o.projectId === P1).every((o) => o.status === "REFUSED" && o.refusal === "access_revoked")
      && !Q.selectRunnable(opsD, 5).runnable.some((o) => o.projectId === P1) && Q.selectRunnable(opsD, 5).runnable.some((o) => o.projectId === P2));
  await A.removeDraft(dbD, kept.draft.entityId);
  record("Retrait par la personne : brouillon et opérations supprimés", !(await A.listDrafts(dbD)).some((d) => d.entityId === kept.draft.entityId) && !(await Q.listOps(dbD)).some((o) => o.entityId === kept.draft.entityId));

  // ---- Référence réelle par rôle (base LOCALE) et scanner du stockage ----
  const tag = String(Date.now()).slice(-6);
  const M = { name: `CHANTIER-HL-${tag}`, supplier: `FOURNISSEUR-HL-${tag}`, expense: "373737373", budget: "484848484", doc: `DOC-ENTREPRISE-HL-${tag}`, journal: `JOURNAL-AUTRUI-HL-${tag}`, phaseDraft: `ETAPE-BROUILLON-HL-${tag}`, incident: `INCIDENT-AUTRUI-HL-${tag}` };
  const contractor = await user("entreprise");
  const owner = await user("proprietaire");
  const coOwner = await user("coproprietaire");
  const sm = await user("chef");
  const outsider = await user("hors-chantier");
  const pid = one(await must(contractor.client.rpc("create_draft_project", { p_name: M.name, p_country: "ML", p_role: "CONTRACTOR" }), "projet")).project_id;
  for (const [u, role, op] of [[owner, "OWNER", "PRIMARY"], [coOwner, "OWNER", "CO_OWNER"], [sm, "SITE_MANAGER", null]]) {
    await must(service.from("project_memberships").insert({ project_id: pid, profile_id: u.id, role, owner_profile: op }), `adhésion ${u.label}`);
  }
  await must(contractor.client.rpc("upsert_phase_plan_draft", { p_project_id: pid, p_phases: [{ position: 1, label: M.phaseDraft, weight: 50 }, { position: 2, label: `${M.phaseDraft}-2`, weight: 50 }], p_expected_revision: 0 }), "plan brouillon");
  const log = await must(contractor.client.rpc("create_daily_log_draft", { p_project_id: pid, p_log_date: "2026-10-08", p_works_done: M.journal, p_difficulties: null, p_team: null, p_next_actions: null }), "journal");
  await must(contractor.client.rpc("publish_daily_log_draft", { p_log_id: log.id, p_expected_revision: log.revision }), "publication");
  await must(contractor.client.rpc("create_incident", { p_project_id: pid, p_incident_type: "AUTRE", p_severity: "FAIBLE", p_occurred_at: new Date(Date.now() - 3600000).toISOString(), p_description: M.incident }), "incident");
  const exp = await must(sm.client.rpc("save_expense_draft", { p_project_id: pid, p_expense_id: null, p_expected_revision: null, p_amount_fcfa: M.expense, p_expense_date: "2026-10-08", p_category: "MATERIAUX", p_supplier: M.supplier, p_note: null, p_phase_id: null, p_no_receipt_reason: null }), "dépense");
  await must(sm.client.rpc("submit_expense", { p_expense_id: exp.id, p_expected_revision: exp.revision }), "soumission");
  await must(contractor.client.rpc("set_internal_budget", { p_project_id: pid, p_amount_fcfa: M.budget, p_reason: null, p_expected_revision: 0 }), "budget");

  const refs = {};
  for (const u of [contractor, owner, coOwner, sm, outsider]) refs[u.label] = await REF.buildOfflineReference(u.client, u.id);
  const mine = (r) => r.projects.find((p) => p.projectId === pid);
  record("Référence : chantier, partie et brouillons autorisés hors ligne pour chaque rôle ; rien pour le hors-chantier",
    mine(refs.entreprise)?.party === "CONTRACTOR" && mine(refs.entreprise).kinds.join() === "JOURNAL,INCIDENT" && mine(refs.chef)?.kinds.join() === "JOURNAL,INCIDENT"
      && mine(refs.proprietaire)?.kinds.join() === "INCIDENT" && mine(refs.coproprietaire)?.party === "CO_OWNER" && !mine(refs["hors-chantier"]),
    Object.entries(refs).map(([k, r]) => `${k}:${mine(r)?.kinds.join("+") ?? "∅"}`).join(" "));
  record("Référence : étapes d'un plan en brouillon jamais envoyées à l'appareil (même à l'entreprise)", Object.values(refs).every((r) => (mine(r)?.phases ?? []).length === 0));

  // Chaque rôle sur son « appareil » : référence + ses propres brouillons.
  const dumps = {};
  for (const u of [contractor, owner, coOwner, sm]) {
    const b = new S.MemoryBackend();
    await A.openForAccount(b, u.id);
    const db = await A.currentAccountDb(b);
    await A.applyReference(db, refs[u.label]);
    await A.saveDraft(db, { projectId: pid, kind: "INCIDENT", fields: incident(`Mon incident ${u.label}`) });
    if (mine(refs[u.label]).kinds.includes("JOURNAL")) await A.saveDraft(db, { projectId: pid, kind: "JOURNAL", fields: journal(`Mon journal ${u.label}`) });
    dumps[u.label] = JSON.stringify(await A.dumpAll(b));
  }
  const others = (self) => [contractor, owner, coOwner, sm, outsider].filter((u) => u.label !== self).flatMap((u) => [u.email, u.id]);
  const forbiddenCommon = [M.supplier, M.expense, M.budget, M.doc, M.journal, M.incident, M.phaseDraft];
  const leaks = [];
  for (const [label, dump] of Object.entries(dumps)) {
    const self = { entreprise: contractor, proprietaire: owner, coproprietaire: coOwner, chef: sm }[label];
    const scan = makeScanner([...forbiddenCommon, ...others(label), self.email, self.id]);
    for (const h of scan(dump)) leaks.push(`${label}:${h}`);
  }
  record("Scanner du stockage local (4 rôles) : ni données ni identité d'autrui, ni finance interne, ni document, ni brouillon d'autrui, ni l'identifiant du compte lui-même", leaks.length === 0, leaks.join(", ") || "rien");
  const scanAll = makeScanner([...forbiddenCommon, ...others("aucun")]);
  const legit = await Promise.all([
    sm.client.rpc("list_project_expenses", { p_project_id: pid }),
    owner.client.rpc("list_published_daily_logs", { p_project_id: pid }),
    contractor.client.rpc("get_project_phase_plan", { p_project_id: pid }).then(() => contractor.client.rpc("list_project_phase_details", { p_project_id: pid })),
  ]);
  const legitHits = new Set(legit.flatMap((r) => scanAll(r.data)));
  record("Contrôle positif (R15) : le scanner trouve la dépense, le journal publié d'autrui et les étapes du brouillon là où ils existent", [M.supplier, M.journal, M.phaseDraft].every((m) => legitHits.has(m)), [...legitHits].join(","));
  const forged = dumps.proprietaire.replace("Mon incident proprietaire", `Mon incident ${M.supplier} ${contractor.email}`);
  record("Contrôle positif (R15) : un stockage local altéré (dépense, e-mail d'autrui) est détecté", scanAll(forged).includes(M.supplier) && scanAll(forged).includes(contractor.email));
  record("Nom du chantier présent seulement comme référence de ses membres", dumps.proprietaire.includes(M.name) && !JSON.stringify(refs["hors-chantier"]).includes(M.name));

  // Retrait réel : la référence suivante ne contient plus le chantier.
  const { data: smMs } = await service.from("project_memberships").select("id").eq("project_id", pid).eq("profile_id", sm.id).single();
  await must(contractor.client.rpc("remove_participant", { p_membership_id: smMs.id, p_reason: "Fin de mission" }), "retrait");
  const refAfter = await REF.buildOfflineReference(sm.client, sm.id);
  const bSm = new S.MemoryBackend();
  await A.openForAccount(bSm, sm.id);
  const dbSm = await A.currentAccountDb(bSm);
  await A.applyReference(dbSm, refs.chef);
  await A.saveDraft(dbSm, { projectId: pid, kind: "JOURNAL", fields: journal("Journal du chef retiré") });
  const out = await A.applyReference(dbSm, refAfter);
  const dumpSm = JSON.stringify(await A.dumpAll(bSm));
  record("Retrait réel du chef : référence sans le chantier ; nom effacé de l'appareil ; son brouillon gardé, refusé (accès retiré)",
    !mine(refAfter) && out.removedProjects.includes(pid) && !dumpSm.includes(M.name) && dumpSm.includes("Journal du chef retiré") && (await Q.listOps(dbSm)).every((o) => o.status === "REFUSED"));
} catch (e) {
  console.error("ERREUR:", e.message);
  results.push(false);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} tests réussis.`);
if (passed !== results.length) process.exitCode = 1;
