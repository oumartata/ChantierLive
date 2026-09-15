// Test technique léger du service worker (public/sw.js), sans dépendance
// supplémentaire : simule les globals minimaux du contexte Service Worker
// (self, caches, Response, fetch) dans un contexte vm Node, capture le
// gestionnaire "fetch" qu'il enregistre, et vérifie son comportement.
//
// Usage : node scripts/sw.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const swSource = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");

function createSwSandbox() {
  const listeners = {};
  const memoryCache = new Map();

  class FakeResponse {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.ok = this.status >= 200 && this.status < 400;
    }
    static error() {
      const response = new FakeResponse(null, { status: 0 });
      response.isNetworkError = true;
      return response;
    }
    clone() {
      return this;
    }
  }

  const fakeCache = {
    async match(request) {
      const key = typeof request === "string" ? request : request.url;
      return memoryCache.get(key);
    },
    async put(request, response) {
      const key = typeof request === "string" ? request : request.url;
      memoryCache.set(key, response);
    },
  };

  const sandbox = {
    self: {
      location: { origin: "http://localhost:3200" },
      addEventListener(type, handler) {
        listeners[type] = handler;
      },
      skipWaiting() {},
      clients: { claim: async () => {} },
    },
    caches: {
      async open() {
        return fakeCache;
      },
      async keys() {
        return [];
      },
      async delete() {
        return true;
      },
    },
    Response: FakeResponse,
    URL,
    console,
    fetch: async () => {
      throw new Error("fetch non simulé pour ce test");
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(swSource, sandbox, { filename: "sw.js" });

  return { listeners, sandbox, memoryCache };
}

function makeRequest({ url, method = "GET", mode = "same-origin", headers = {} }) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    url,
    method,
    mode,
    headers: {
      has: (name) => headerMap.has(name.toLowerCase()),
      get: (name) => headerMap.get(name.toLowerCase()) ?? null,
    },
  };
}

function makeEvent(request) {
  let responded;
  const waited = [];
  return {
    request,
    respondWith(promise) {
      responded = promise;
    },
    waitUntil(promise) {
      waited.push(promise);
    },
    get responded() {
      return responded;
    },
    get waited() {
      return waited;
    },
  };
}

async function run() {
  // 1. Navigation hors ligne -> Response /offline
  {
    const { listeners, memoryCache, sandbox } = createSwSandbox();
    memoryCache.set("/offline", new sandbox.Response("hors ligne"));
    sandbox.fetch = async () => {
      throw new Error("réseau indisponible");
    };
    const request = makeRequest({ url: "http://localhost:3200/", mode: "navigate" });
    const event = makeEvent(request);
    listeners.fetch(event);
    assert.ok(event.responded, "respondWith doit être appelé pour une navigation");
    const response = await event.responded;
    assert.ok(response instanceof sandbox.Response, "doit résoudre vers une Response");
    assert.equal(response.body, "hors ligne");
    console.log("OK: navigation hors ligne -> Response /offline");
  }

  // 2. Requête /?_rsc=abc -> non interceptée
  {
    const { listeners } = createSwSandbox();
    const request = makeRequest({ url: "http://localhost:3200/?_rsc=abc", mode: "same-origin" });
    const event = makeEvent(request);
    listeners.fetch(event);
    assert.equal(event.responded, undefined, "ne doit pas appeler respondWith pour une requête RSC");
    console.log("OK: requête /?_rsc=abc non interceptée");
  }

  // 3. Requête non autorisée (API) -> non interceptée
  {
    const { listeners } = createSwSandbox();
    const request = makeRequest({ url: "http://localhost:3200/api/private", mode: "same-origin" });
    const event = makeEvent(request);
    listeners.fetch(event);
    assert.equal(event.responded, undefined, "ne doit pas appeler respondWith pour /api/*");
    console.log("OK: requête /api/* non interceptée");
  }

  // 4. Ressource publique autorisée -> Response valide
  {
    const { listeners, sandbox } = createSwSandbox();
    sandbox.fetch = async () => new sandbox.Response("icone");
    const request = makeRequest({
      url: "http://localhost:3200/icons/icon-192.png",
      mode: "same-origin",
    });
    const event = makeEvent(request);
    listeners.fetch(event);
    assert.ok(event.responded, "respondWith doit être appelé pour une ressource publique autorisée");
    const response = await event.responded;
    assert.ok(response instanceof sandbox.Response, "doit résoudre vers une Response");
    assert.equal(response.body, "icone");
    console.log("OK: ressource publique autorisée -> Response valide");
  }

  console.log("Tous les tests du service worker sont passés.");
}

run().catch((error) => {
  console.error("ÉCHEC du test service worker:", error);
  process.exitCode = 1;
});
