// L06 — file d'opérations hors ligne (B037 ; SYNC_PROTOCOL « queue » ;
// BR074 à BR076 ; O2, O3, O4, O7, O13 ; D202).
// - UUID d'opération créé AVANT toute écriture locale (BR076) et conservé.
// - FIFO par chantier et par entité ; une seule opération ACTIVE par entité ;
//   au plus 2 entités en parallèle ; une opération dépendante attend que son
//   parent soit DONE (BLOCKED_DEPENDENCY sinon).
// - Une opération refusée (accès retiré, licence en lecture seule…) reste
//   dans la file, expliquée, jusqu'à ce que la personne la retire : rien
//   n'est perdu ni appliqué en silence. L'envoi lui-même arrive avec B038.

import type { Backend, LocalStore } from "./store";

export type OpStatus = "PENDING" | "ACTIVE" | "DONE" | "FAILED" | "REFUSED";
export type DraftKind = "JOURNAL" | "INCIDENT";

export interface QueueOp {
  operationUuid: string;
  seq: number;
  projectId: string;
  entityType: DraftKind;
  entityId: string;
  action: "CREATE_DRAFT" | "UPDATE_DRAFT";
  dependsOn: string | null;
  status: OpStatus;
  refusal: string | null;
  attempts: number;
  clientCreatedAt: string;
}

export const entityKey = (op: Pick<QueueOp, "entityType" | "entityId">) => `${op.entityType}:${op.entityId}`;

export function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

// Choix pur des opérations à lancer : la plus ancienne non terminée de chaque
// entité, si aucune opération de cette entité n'est déjà ACTIVE, si elle
// n'est ni en échec ni refusée, et si son parent est DONE ; au plus
// `maxParallel` entités, dans l'ordre d'arrivée.
export function selectRunnable(ops: QueueOp[], maxParallel = 2): { runnable: QueueOp[]; blocked: QueueOp[] } {
  const byUuid = new Map(ops.map((o) => [o.operationUuid, o]));
  const sorted = [...ops].sort((a, b) => a.seq - b.seq);
  const activeEntities = new Set(sorted.filter((o) => o.status === "ACTIVE").map(entityKey));
  const seen = new Set<string>();
  const runnable: QueueOp[] = [];
  const blocked: QueueOp[] = [];
  let slots = Math.max(0, maxParallel - activeEntities.size);
  for (const op of sorted) {
    const key = entityKey(op);
    if (op.status === "DONE" || seen.has(key)) continue;
    seen.add(key);
    if (activeEntities.has(key) || op.status !== "PENDING") continue;
    const parent = op.dependsOn ? byUuid.get(op.dependsOn) : undefined;
    if (op.dependsOn && (!parent || parent.status !== "DONE")) {
      blocked.push(op);
      continue;
    }
    if (slots > 0) {
      runnable.push(op);
      slots -= 1;
    }
  }
  return { runnable, blocked };
}

export class QueueError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function listOps(db: LocalStore): Promise<QueueOp[]> {
  return (await db.all<QueueOp>("queue")).map(([, v]) => v).sort((a, b) => a.seq - b.seq);
}

export async function enqueue(
  db: LocalStore,
  op: Omit<QueueOp, "operationUuid" | "seq" | "status" | "refusal" | "attempts" | "clientCreatedAt"> & { operationUuid?: string },
): Promise<QueueOp> {
  const ops = await listOps(db);
  const full: QueueOp = {
    operationUuid: op.operationUuid ?? newUuid(),
    seq: (ops.at(-1)?.seq ?? 0) + 1,
    projectId: op.projectId,
    entityType: op.entityType,
    entityId: op.entityId,
    action: op.action,
    dependsOn: op.dependsOn,
    status: "PENDING",
    refusal: null,
    attempts: 0,
    clientCreatedAt: new Date().toISOString(),
  };
  await db.put("queue", full.operationUuid, full);
  return full;
}

// Passage en ACTIVE : refusé si une autre opération de la même entité l'est
// déjà, ou si l'opération n'est pas sélectionnable (ordre, dépendance).
export async function activate(db: LocalStore, operationUuid: string, maxParallel = 2): Promise<QueueOp> {
  const ops = await listOps(db);
  const op = ops.find((o) => o.operationUuid === operationUuid);
  if (!op) throw new QueueError("operation_not_found");
  if (ops.some((o) => o.status === "ACTIVE" && entityKey(o) === entityKey(op))) throw new QueueError("entity_already_active");
  if (!selectRunnable(ops, maxParallel).runnable.some((o) => o.operationUuid === operationUuid)) throw new QueueError("not_runnable");
  const next = { ...op, status: "ACTIVE" as const, attempts: op.attempts + 1 };
  await db.put("queue", operationUuid, next);
  return next;
}

// Activation sous verrou (entre onglets) : deux demandes simultanées pour la
// même entité ne peuvent jamais aboutir toutes les deux.
export async function activateExclusive(backend: Backend, db: LocalStore, operationUuid: string, maxParallel = 2): Promise<QueueOp> {
  return backend.withLock("chantierlive-queue", () => activate(db, operationUuid, maxParallel));
}

export async function settle(db: LocalStore, operationUuid: string, status: "DONE" | "PENDING" | "FAILED"): Promise<void> {
  const op = await db.get<QueueOp>("queue", operationUuid);
  if (!op || op.status !== "ACTIVE") throw new QueueError("not_active");
  await db.put("queue", operationUuid, { ...op, status });
}

// Refus définitif expliqué (O7, O13) : l'opération et son brouillon restent.
export async function refuseProject(db: LocalStore, projectId: string, reason: string): Promise<number> {
  let n = 0;
  for (const op of await listOps(db)) {
    if (op.projectId === projectId && op.status !== "DONE" && op.status !== "REFUSED") {
      await db.put("queue", op.operationUuid, { ...op, status: "REFUSED", refusal: reason });
      n += 1;
    }
  }
  return n;
}

// Brouillons non envoyés (un brouillon quitte l'appareil seulement une fois
// confirmé par le serveur, B038).
export async function pendingCount(db: LocalStore): Promise<number> {
  return (await db.all("drafts")).length;
}
