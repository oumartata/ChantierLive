// L06 — implémentation IndexedDB de l'interface Backend (navigateur
// seulement). Aucune dépendance : API IndexedDB native, Web Locks API pour
// l'exclusion entre onglets (repli : file d'attente dans la page).

import type { Backend, LocalStore, StoreName } from "./store";

const STORES: StoreName[] = ["queue", "drafts", "reference", "meta", "accounts", "notices"];

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const open = new Map<string, IDBDatabase>();
const chains = new Map<string, Promise<unknown>>();

export const indexedDbBackend: Backend = {
  async open(name: string): Promise<LocalStore> {
    let db = open.get(name);
    if (!db) {
      db = await openDb(name);
      db.onversionchange = () => {
        db?.close();
        open.delete(name);
      };
      open.set(name, db);
    }
    const store = (s: StoreName, mode: IDBTransactionMode) => db!.transaction(s, mode).objectStore(s);
    return {
      get: <T>(s: StoreName, key: string) => req(store(s, "readonly").get(key)) as Promise<T | undefined>,
      put: async <T>(s: StoreName, key: string, value: T) => {
        await req(store(s, "readwrite").put(value, key));
      },
      delete: async (s: StoreName, key: string) => {
        await req(store(s, "readwrite").delete(key));
      },
      all: async <T>(s: StoreName) => {
        const os = store(s, "readonly");
        const [keys, values] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
        return keys.map((k, i) => [String(k), values[i] as T] as [string, T]);
      },
    };
  },
  async remove(name: string) {
    open.get(name)?.close();
    open.delete(name);
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
      r.onblocked = () => resolve();
    });
  },
  async list() {
    return ((await indexedDB.databases?.()) ?? []).map((d) => d.name ?? "").filter(Boolean);
  },
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(name, fn) as Promise<T>;
    const prev = chains.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(name, run.catch(() => undefined));
    return run;
  },
};

// Stockage persistant demandé (O9) ; estimation affichée.
export async function storageStatus(): Promise<{ persisted: boolean; usage: number | null; quota: number | null }> {
  const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!s) return { persisted: false, usage: null, quota: null };
  const persisted = (await s.persisted?.()) || (await s.persist?.()) || false;
  const est = await s.estimate?.();
  return { persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
}
