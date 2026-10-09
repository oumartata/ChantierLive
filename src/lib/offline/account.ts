// L06 — base locale par compte et effacements (B036 ; O1, O6, O7, O8, O12 P1 ;
// D202). Logique pure sur l'interface Backend : identique dans le navigateur
// (IndexedDB) et dans les tests (mémoire).
//
// - Une base par compte, nommée par une clé hachée (jamais l'identifiant).
// - Connexion d'un autre compte (O12 P1) : la base du compte précédent est
//   effacée tout de suite s'il n'a rien en attente ; sinon, le nouveau compte
//   doit choisir « Effacer et continuer » ou « Annuler » ; un avis sans
//   contenu (nombre, date) est laissé au compte précédent.
// - Déconnexion (O6) : rien en attente → effacement ; sinon choix explicite
//   (exporter puis effacer, ou effacer).
// - Retrait d'un membre (D202) : dès la reconnexion, les données du chantier
//   sont effacées ; ses propres brouillons restent « refusés : accès
//   retiré », jamais envoyés, jusqu'à retrait ou export par la personne.
// - Contenu minimal (O1) : file, brouillons de l'auteur, référence (chantiers
//   du compte, rôle, étapes publiées). Jamais de document, de finance, de
//   contenu publié ni de brouillon d'autrui.

import { ACCOUNT_DB_PREFIX, DEVICE_DB, accountDbName, accountKeyOf, type Backend, type LocalStore } from "./store";
import { enqueue, listOps, newUuid, pendingCount, refuseProject, type DraftKind, type QueueOp } from "./queue";

export interface ReferenceProject {
  projectId: string;
  name: string;
  party: "CONTRACTOR" | "OWNER_PRIMARY" | "CO_OWNER" | "SITE_MANAGER";
  kinds: DraftKind[];
  phases: { id: string; label: string }[];
}
export interface Reference {
  fetchedAt: string;
  projects: ReferenceProject[];
}

export interface JournalFields {
  logDate: string;
  worksDone: string;
  difficulties: string;
  team: string;
  nextActions: string;
  phaseId: string | null;
}
export interface IncidentFields {
  incidentType: string;
  severity: string;
  occurredAt: string;
  description: string;
  phaseId: string | null;
}
export interface LocalDraft {
  entityId: string;
  projectId: string;
  kind: DraftKind;
  fields: JournalFields | IncidentFields;
  createdAtClient: string;
  updatedAtClient: string;
}

export interface Notice {
  erasedCount: number;
  erasedAt: string;
}

export type OpenResult =
  | { kind: "ready"; accountKey: string; notice: Notice | null }
  | { kind: "confirm"; accountKey: string; others: { accountKey: string; pending: number }[]; pendingTotal: number };

async function device(backend: Backend): Promise<LocalStore> {
  return backend.open(DEVICE_DB);
}

async function deviceSalt(dev: LocalStore): Promise<string> {
  let salt = await dev.get<string>("meta", "salt");
  if (!salt) {
    salt = newUuid();
    await dev.put("meta", "salt", salt);
    await dev.put("meta", "deviceId", newUuid());
  }
  return salt;
}

async function otherAccounts(backend: Backend, accountKey: string): Promise<string[]> {
  return (await backend.list()).filter((n) => n.startsWith(ACCOUNT_DB_PREFIX) && n !== accountDbName(accountKey)).map((n) => n.slice(ACCOUNT_DB_PREFIX.length));
}

async function eraseAccount(backend: Backend, dev: LocalStore, key: string, notice: Notice | null) {
  await backend.remove(accountDbName(key));
  await dev.delete("accounts", key);
  if (notice) await dev.put("notices", key, notice);
}

// Ouverture de session sur l'appareil pour ce compte.
export async function openForAccount(backend: Backend, profileId: string): Promise<OpenResult> {
  return backend.withLock("chantierlive-offline", async () => {
    const dev = await device(backend);
    const key = await accountKeyOf(await deviceSalt(dev), profileId);
    const others: { accountKey: string; pending: number }[] = [];
    for (const other of await otherAccounts(backend, key)) {
      const pending = await pendingCount(await backend.open(accountDbName(other)));
      if (pending === 0) await eraseAccount(backend, dev, other, null);
      else others.push({ accountKey: other, pending });
    }
    if (others.length > 0) return { kind: "confirm", accountKey: key, others, pendingTotal: others.reduce((s, o) => s + o.pending, 0) };
    return finishOpen(backend, dev, key);
  });
}

async function finishOpen(backend: Backend, dev: LocalStore, key: string): Promise<OpenResult> {
  await backend.open(accountDbName(key));
  await dev.put("meta", "currentAccount", key);
  await dev.put("accounts", key, { lastSeenAt: new Date().toISOString() });
  const notice = (await dev.get<Notice>("notices", key)) ?? null;
  if (notice) await dev.delete("notices", key);
  return { kind: "ready", accountKey: key, notice };
}

// « Effacer et continuer » : efface les bases des autres comptes, laisse à
// chacun un avis sans contenu.
export async function confirmEraseOthers(backend: Backend, profileId: string): Promise<OpenResult> {
  return backend.withLock("chantierlive-offline", async () => {
    const dev = await device(backend);
    const key = await accountKeyOf(await deviceSalt(dev), profileId);
    for (const other of await otherAccounts(backend, key)) {
      const pending = await pendingCount(await backend.open(accountDbName(other)));
      await eraseAccount(backend, dev, other, pending > 0 ? { erasedCount: pending, erasedAt: new Date().toISOString() } : null);
    }
    return finishOpen(backend, dev, key);
  });
}

// Base du compte courant (null si aucun compte ouvert sur cet appareil).
export async function currentAccountDb(backend: Backend): Promise<LocalStore | null> {
  const key = await (await device(backend)).get<string>("meta", "currentAccount");
  return key ? backend.open(accountDbName(key)) : null;
}

// Déconnexion (O6).
export async function logoutCheck(backend: Backend): Promise<{ pending: number }> {
  const db = await currentAccountDb(backend);
  return { pending: db ? await pendingCount(db) : 0 };
}
export async function eraseCurrentAccount(backend: Backend): Promise<void> {
  await backend.withLock("chantierlive-offline", async () => {
    const dev = await device(backend);
    const key = await dev.get<string>("meta", "currentAccount");
    if (key) await eraseAccount(backend, dev, key, null);
    await dev.delete("meta", "currentAccount");
  });
}

// Brouillons de l'auteur.
export async function saveDraft(db: LocalStore, input: { entityId?: string; projectId: string; kind: DraftKind; fields: JournalFields | IncidentFields }): Promise<{ draft: LocalDraft; op: QueueOp }> {
  const reference = await db.get<Reference>("reference", "current");
  const project = reference?.projects.find((p) => p.projectId === input.projectId);
  if (!project || !project.kinds.includes(input.kind)) throw new Error("not_allowed_offline");
  const existing = input.entityId ? await db.get<LocalDraft>("drafts", input.entityId) : undefined;
  const now = new Date().toISOString();
  const entityId = existing?.entityId ?? newUuid();
  const prior = (await listOps(db)).filter((o) => o.entityId === entityId && o.status !== "DONE");
  // UUID d'opération créé avant toute écriture locale (BR076).
  const operationUuid = newUuid();
  const draft: LocalDraft = { entityId, projectId: input.projectId, kind: input.kind, fields: input.fields, createdAtClient: existing?.createdAtClient ?? now, updatedAtClient: now };
  await db.put("drafts", entityId, draft);
  const op = await enqueue(db, {
    operationUuid,
    projectId: input.projectId,
    entityType: input.kind,
    entityId,
    action: existing ? "UPDATE_DRAFT" : "CREATE_DRAFT",
    dependsOn: prior.at(-1)?.operationUuid ?? null,
  });
  return { draft, op };
}

// Retrait par la personne : brouillon et opérations associés.
export async function removeDraft(db: LocalStore, entityId: string): Promise<void> {
  for (const op of await listOps(db)) if (op.entityId === entityId) await db.delete("queue", op.operationUuid);
  await db.delete("drafts", entityId);
}

export async function listDrafts(db: LocalStore): Promise<LocalDraft[]> {
  return (await db.all<LocalDraft>("drafts")).map(([, v]) => v).sort((a, b) => a.createdAtClient.localeCompare(b.createdAtClient));
}

// Référence reçue en ligne (O1) ; chantiers disparus = adhésion retirée
// (D202) : données du chantier effacées, brouillons propres refusés.
export async function applyReference(db: LocalStore, next: Reference): Promise<{ removedProjects: string[]; refusedOps: number }> {
  const previous = await db.get<Reference>("reference", "current");
  const kept = new Set(next.projects.map((p) => p.projectId));
  const removedProjects = (previous?.projects ?? []).map((p) => p.projectId).filter((id) => !kept.has(id));
  const draftProjects = new Set((await listDrafts(db)).map((d) => d.projectId));
  let refusedOps = 0;
  for (const id of new Set([...removedProjects, ...[...draftProjects].filter((id) => !kept.has(id))])) {
    refusedOps += await refuseProject(db, id, "access_revoked");
  }
  await db.put("reference", "current", next);
  return { removedProjects, refusedOps };
}

// Référence appliquée SEULEMENT si la session correspond au compte de la base
// ouverte sur l'appareil (jamais la référence d'un compte dans la base d'un
// autre).
export async function applyReferenceForSession(backend: Backend, profileId: string, next: Reference): Promise<{ applied: boolean; removedProjects: string[] }> {
  const dev = await device(backend);
  const current = await dev.get<string>("meta", "currentAccount");
  const key = await accountKeyOf(await deviceSalt(dev), profileId);
  if (!current || current !== key) return { applied: false, removedProjects: [] };
  const out = await applyReference(await backend.open(accountDbName(key)), next);
  return { applied: true, removedProjects: out.removedProjects };
}

// Export des brouillons de la personne (O6, O7) : son propre contenu.
export async function exportDrafts(db: LocalStore): Promise<string> {
  const drafts = await listDrafts(db);
  const ops = await listOps(db);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      note: "Brouillons hors ligne non envoyés, exportés depuis ChantierLive. Ils ne sont pas enregistrés sur le serveur.",
      drafts: drafts.map((d) => ({ ...d, refusal: ops.find((o) => o.entityId === d.entityId && o.refusal)?.refusal ?? null })),
    },
    null,
    2,
  );
}

// Vidage complet (tests et scanner du stockage local).
export async function dumpAll(backend: Backend): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of await backend.list()) {
    if (name !== DEVICE_DB && !name.startsWith(ACCOUNT_DB_PREFIX)) continue;
    const db = await backend.open(name);
    const stores = ["queue", "drafts", "reference", "meta", "accounts", "notices"] as const;
    out[name] = {};
    for (const s of stores) out[name][s] = Object.fromEntries(await db.all(s));
  }
  return out;
}
