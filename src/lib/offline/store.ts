// L06 — stockage local hors ligne (B036 ; O1, O12 ; D202). Interface
// abstraite : IndexedDB dans le navigateur (idb.ts), mémoire dans les tests
// (scripts/test-offline-local.mjs) — la même logique s'exécute sur les deux.
//
// Deux bases :
// - la base de l'APPAREIL (« chantierlive-appareil ») : identifiant
//   d'installation, sel, compte courant (clé hachée, jamais l'identifiant du
//   compte), comptes présents, avis d'effacement (nombre et date seulement) ;
// - une base par COMPTE (« chantierlive-compte-<clé> ») : file, brouillons,
//   référence minimale. Jamais partagée entre deux comptes.

export type StoreName = "queue" | "drafts" | "reference" | "meta" | "accounts" | "notices";

export interface LocalStore {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T>(store: StoreName, key: string, value: T): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  all<T>(store: StoreName): Promise<[string, T][]>;
}

export interface Backend {
  open(name: string): Promise<LocalStore>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
  // Exclusion mutuelle (entre onglets dans le navigateur).
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export const DEVICE_DB = "chantierlive-appareil";
export const ACCOUNT_DB_PREFIX = "chantierlive-compte-";
export const accountDbName = (accountKey: string) => `${ACCOUNT_DB_PREFIX}${accountKey}`;

// Mémoire : les « bases » survivent tant que l'objet Map partagé existe, ce
// qui permet de simuler fermeture et réouverture de l'application.
export class MemoryBackend implements Backend {
  private chains = new Map<string, Promise<unknown>>();
  constructor(public readonly data: Map<string, Map<string, unknown>> = new Map()) {}
  async open(name: string): Promise<LocalStore> {
    if (!this.data.has(name)) this.data.set(name, new Map());
    const db = this.data.get(name)!;
    const k = (s: StoreName, key: string) => `${s}\u0000${key}`;
    const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
    return {
      get: async <T>(s: StoreName, key: string) => clone(db.get(k(s, key)) as T | undefined),
      put: async <T>(s: StoreName, key: string, value: T) => {
        db.set(k(s, key), clone(value));
      },
      delete: async (s: StoreName, key: string) => {
        db.delete(k(s, key));
      },
      all: async <T>(s: StoreName) =>
        [...db.entries()].filter(([key]) => key.startsWith(`${s}\u0000`)).map(([key, v]) => [key.slice(s.length + 1), clone(v) as T] as [string, T]),
    };
  }
  async remove(name: string) {
    this.data.delete(name);
  }
  async list() {
    return [...this.data.keys()];
  }
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(name, run.catch(() => undefined));
    return run;
  }
}

// Clé de compte : empreinte SHA-256 (sel de l'appareil + identifiant du
// compte), jamais l'identifiant lui-même ; illisible pour un autre compte.
export async function accountKeyOf(salt: string, profileId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${profileId}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
