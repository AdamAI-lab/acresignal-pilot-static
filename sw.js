const ACRESIGNAL_CACHE_PREFIX = "acresignal-shell-";
const ACRESIGNAL_BUILD_STAMP = "fe093ff41c92-f437db9334eb195f48c7ad24";
const ACRESIGNAL_SHELL_CACHE = `${ACRESIGNAL_CACHE_PREFIX}${ACRESIGNAL_BUILD_STAMP}`;
const ACRESIGNAL_RETAINED_CACHE_GENERATIONS = 2;
const ACRESIGNAL_MAX_RUNTIME_ENTRIES = 96;
const ACRESIGNAL_MAX_BUILD_ASSETS = 256;
const ACRESIGNAL_MAX_PREPARED_CLIENTS = 128;
const ACRESIGNAL_CLIENT_PREPARE_TIMEOUT_MS = 20_000;
const ACRESIGNAL_UPDATE_PROTOCOL_VERSION = 1;
const ACRESIGNAL_ACTIVATE_UPDATE = "ACRESIGNAL_ACTIVATE_UPDATE";
const ACRESIGNAL_CANCEL_UPDATE = "ACRESIGNAL_CANCEL_UPDATE";
const ACRESIGNAL_PREPARE_UPDATE = "ACRESIGNAL_PREPARE_UPDATE";
const ACRESIGNAL_PREPARE_UPDATE_RESULT = "ACRESIGNAL_PREPARE_UPDATE_RESULT";
const ACRESIGNAL_RELEASE_UPDATE = "ACRESIGNAL_RELEASE_UPDATE";
const ACRESIGNAL_COMMIT_UPDATE = "ACRESIGNAL_COMMIT_UPDATE";
const ACRESIGNAL_ACTIVATE_UPDATE_RESULT = "ACRESIGNAL_ACTIVATE_UPDATE_RESULT";
const ACRESIGNAL_QUERY_BUILD_IDENTITY = "ACRESIGNAL_QUERY_BUILD_IDENTITY";
const ACRESIGNAL_BUILD_IDENTITY_RESULT = "ACRESIGNAL_BUILD_IDENTITY_RESULT";
const ACRESIGNAL_PREPARED_CLIENT_RECEIPT_PATH =
  "/.acresignal-internal/prepared-update-clients.json";
const ACRESIGNAL_INSTALL_CONTEXT_PATH =
  "/.acresignal-internal/install-context.json";
const ACRESIGNAL_PREPARED_CLIENT_RECEIPT_MAX_AGE_MS = 2 * 60_000;
const ACRESIGNAL_APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];
const STATIC_DESTINATIONS = new Set([
  "font",
  "image",
  "manifest",
  "script",
  "style",
]);
const PRIVATE_OR_API_PATH =
  /^\/(?:api|auth|oauth|login|logout|callback|functions|graphql|realtime|rest|rpc|storage|supabase)(?:\/|$)/i;
const TILE_OR_MAP_PATH = /^\/(?:basemap|imagery|maps?|tiles?)(?:\/|$)/i;
const BUILD_ASSET_REFERENCE =
  /(?:\/assets\/|assets\/|\.\/)[A-Za-z0-9_./@%+~-]+\.(?:css|gif|jpe?g|js|png|svg|webp|woff2?)(?:\?[A-Za-z0-9_.,~%+&=-]*)?/g;

let activationAttempt;
const cancelledActivationRequests = new Set();

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function absoluteUrl(path) {
  return new URL(path, self.location.origin).href;
}

function isPrivateOrApiRequest(request, url) {
  return (
    PRIVATE_OR_API_PATH.test(url.pathname) ||
    TILE_OR_MAP_PATH.test(url.pathname) ||
    request.headers.has("authorization") ||
    request.headers.has("range")
  );
}

function isCacheableStaticRequest(request, url) {
  return (
    request.method === "GET" &&
    isSameOrigin(url) &&
    !isPrivateOrApiRequest(request, url) &&
    STATIC_DESTINATIONS.has(request.destination)
  );
}

function isCacheableStaticResponse(response) {
  if (!response || !response.ok || response.type !== "basic") return false;
  const cacheControl = response.headers.get("cache-control") ?? "";
  return (
    !/(?:no-store|private)/i.test(cacheControl) &&
    !response.headers.has("set-cookie")
  );
}

function isContentHashedAsset(url) {
  return (
    url.search === "" &&
    /^\/assets\/.*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(url.pathname)
  );
}

function isProtectedCacheRequest(request) {
  const url = new URL(request.url);
  return (
    (url.search === "" && ACRESIGNAL_APP_SHELL.includes(url.pathname)) ||
    (url.search === "" &&
      url.pathname === ACRESIGNAL_PREPARED_CLIENT_RECEIPT_PATH) ||
    (url.search === "" && url.pathname === ACRESIGNAL_INSTALL_CONTEXT_PATH) ||
    isContentHashedAsset(url)
  );
}

async function pruneRuntimeEntries(cache, aggressive = false) {
  const requests = await cache.keys();
  const runtimeRequests = requests.filter(
    (request) => !isProtectedCacheRequest(request),
  );
  const target = aggressive
    ? Math.floor(ACRESIGNAL_MAX_RUNTIME_ENTRIES / 2)
    : ACRESIGNAL_MAX_RUNTIME_ENTRIES;
  const excess = runtimeRequests.length - target;
  if (excess <= 0) return;
  await Promise.all(
    runtimeRequests.slice(0, excess).map((request) => cache.delete(request)),
  );
}

async function bestEffortRuntimeCachePut(cache, request, response) {
  try {
    await cache.put(request, response.clone());
    await pruneRuntimeEntries(cache);
    return;
  } catch {
    // Cache pressure must never turn a valid online response into a failed
    // navigation or chunk load. Reclaim disposable runtime entries once, then
    // leave the network response untouched if storage is still unavailable.
  }
  try {
    await pruneRuntimeEntries(cache, true);
    await cache.put(request, response.clone());
    await pruneRuntimeEntries(cache);
  } catch {
    // The installed build graph remains protected. Runtime caching is optional.
  }
}

function buildAssetUrls(source, baseUrl) {
  const urls = new Set();
  for (const reference of source.match(BUILD_ASSET_REFERENCE) ?? []) {
    const candidate = reference.startsWith("assets/")
      ? new URL(`/${reference}`, self.location.origin)
      : new URL(reference, baseUrl);
    if (isSameOrigin(candidate) && isContentHashedAsset(candidate))
      urls.add(candidate.href);
  }
  return [...urls];
}

async function fetchRequiredShellResource(path) {
  const request = new Request(absoluteUrl(path), {
    cache: "reload",
    credentials: "same-origin",
  });
  const response = await fetch(request);
  if (!response?.ok || response.type !== "basic") {
    throw new Error(
      `AcreSignal shell resource ${path} was unavailable during install.`,
    );
  }
  return { request, response };
}

async function precacheBuildGraph(cache) {
  let indexSource = "";
  for (const path of ACRESIGNAL_APP_SHELL) {
    const { request, response } = await fetchRequiredShellResource(path);
    await cache.put(request, response.clone());
    if (path === "/index.html") indexSource = await response.text();
  }

  const pending = buildAssetUrls(indexSource, absoluteUrl("/index.html"));
  const discovered = new Set(pending);
  if (pending.length === 0) {
    throw new Error(
      "AcreSignal did not discover a build asset graph during install.",
    );
  }

  while (pending.length > 0) {
    if (discovered.size > ACRESIGNAL_MAX_BUILD_ASSETS) {
      throw new Error(
        "AcreSignal build asset graph exceeded its bounded install limit.",
      );
    }
    const assetUrl = pending.shift();
    const { request, response } = await fetchRequiredShellResource(assetUrl);
    await cache.put(request, response.clone());
    if (!/\.(?:css|js)$/i.test(new URL(assetUrl).pathname)) continue;
    const source = await response.text();
    for (const dependencyUrl of buildAssetUrls(source, assetUrl)) {
      if (discovered.has(dependencyUrl)) continue;
      discovered.add(dependencyUrl);
      pending.push(dependencyUrl);
    }
  }
}

function boundedBlockers(blockers, fallback) {
  if (!Array.isArray(blockers)) return [fallback];
  const messages = blockers
    .filter((message) => typeof message === "string")
    .map((message) => message.trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 12);
  return messages.length > 0 ? messages : [fallback];
}

function validRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,160}$/.test(value);
}

function clientIds(clients) {
  return clients.map((client) => client.id).sort();
}

function sameClientSet(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function postPortResult(port, result) {
  try {
    port.postMessage(result);
  } finally {
    port.close?.();
  }
}

async function releaseClients(clients, requestId) {
  await Promise.all(
    clients.map(async (client) => {
      try {
        client.postMessage({
          type: ACRESIGNAL_RELEASE_UPDATE,
          protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
          requestId,
          buildStamp: ACRESIGNAL_BUILD_STAMP,
        });
      } catch {
        // The tab may already be closing. RELEASE is idempotent in every client.
      }
    }),
  );
}

async function deletePreparedClientReceipt() {
  const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
  await cache.delete(absoluteUrl(ACRESIGNAL_PREPARED_CLIENT_RECEIPT_PATH));
}

async function persistInstallContext(hadActiveWorker) {
  const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
  await cache.put(
    absoluteUrl(ACRESIGNAL_INSTALL_CONTEXT_PATH),
    new Response(
      JSON.stringify({
        protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
        buildStamp: ACRESIGNAL_BUILD_STAMP,
        hadActiveWorker,
      }),
      {
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    ),
  );
}

async function readInstallContext() {
  try {
    const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
    const response = await cache.match(
      absoluteUrl(ACRESIGNAL_INSTALL_CONTEXT_PATH),
    );
    if (!response) return undefined;
    const context = JSON.parse(await response.text());
    if (
      context?.protocolVersion !== ACRESIGNAL_UPDATE_PROTOCOL_VERSION ||
      context.buildStamp !== ACRESIGNAL_BUILD_STAMP ||
      typeof context.hadActiveWorker !== "boolean"
    )
      return undefined;
    return context;
  } catch {
    return undefined;
  }
}

async function deleteInstallContext() {
  const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
  await cache.delete(absoluteUrl(ACRESIGNAL_INSTALL_CONTEXT_PATH));
}

async function persistPreparedClientReceipt(requestId, preparedClientIds) {
  const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
  const receipt = {
    protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
    requestId,
    buildStamp: ACRESIGNAL_BUILD_STAMP,
    preparedAt: Date.now(),
    preparedClientIds,
  };
  await cache.put(
    absoluteUrl(ACRESIGNAL_PREPARED_CLIENT_RECEIPT_PATH),
    new Response(JSON.stringify(receipt), {
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

async function readPreparedClientReceipt() {
  try {
    const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
    const response = await cache.match(
      absoluteUrl(ACRESIGNAL_PREPARED_CLIENT_RECEIPT_PATH),
    );
    if (!response) return undefined;
    const receipt = JSON.parse(await response.text());
    if (
      receipt?.protocolVersion !== ACRESIGNAL_UPDATE_PROTOCOL_VERSION ||
      !validRequestId(receipt.requestId) ||
      receipt.buildStamp !== ACRESIGNAL_BUILD_STAMP ||
      !Number.isSafeInteger(receipt.preparedAt) ||
      receipt.preparedAt <
        Date.now() - ACRESIGNAL_PREPARED_CLIENT_RECEIPT_MAX_AGE_MS ||
      receipt.preparedAt > Date.now() + 10_000 ||
      !Array.isArray(receipt.preparedClientIds) ||
      receipt.preparedClientIds.length < 1 ||
      receipt.preparedClientIds.length > ACRESIGNAL_MAX_PREPARED_CLIENTS ||
      receipt.preparedClientIds.some(
        (clientId) => typeof clientId !== "string" || !clientId,
      )
    ) {
      return undefined;
    }
    const preparedClientIds = [...new Set(receipt.preparedClientIds)].sort();
    if (preparedClientIds.length !== receipt.preparedClientIds.length)
      return undefined;
    return { requestId: receipt.requestId, preparedClientIds };
  } catch {
    return undefined;
  }
}

async function currentBuildAssetPaths() {
  const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
  const response = await cache.match(absoluteUrl("/index.html"));
  if (!response) return [];
  return buildAssetUrls(await response.text(), absoluteUrl("/index.html"))
    .map((assetUrl) => new URL(assetUrl).pathname)
    .sort();
}

async function commitPreparedClients(clients, receipt) {
  const preparedIds = new Set(receipt.preparedClientIds);
  await Promise.all(
    clients
      .filter((client) => preparedIds.has(client.id))
      .map(async (client) => {
        try {
          client.postMessage({
            type: ACRESIGNAL_COMMIT_UPDATE,
            protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
            requestId: receipt.requestId,
            buildStamp: ACRESIGNAL_BUILD_STAMP,
          });
        } catch {
          // A prepared client may have closed after activation became irreversible.
        }
      }),
  );
}

function prepareClient(client, requestId) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.port1.onmessage = null;
      channel.port1.close?.();
      resolve(result);
    };
    const timeout = setTimeout(
      () =>
        finish({
          safe: false,
          blockers: [
            "An open AcreSignal tab did not confirm that its field work was safe to reload.",
          ],
        }),
      ACRESIGNAL_CLIENT_PREPARE_TIMEOUT_MS,
    );
    channel.port1.onmessage = (messageEvent) => {
      const result = messageEvent.data;
      if (
        result?.type !== ACRESIGNAL_PREPARE_UPDATE_RESULT ||
        result.protocolVersion !== ACRESIGNAL_UPDATE_PROTOCOL_VERSION ||
        result.requestId !== requestId
      )
        return;
      if (result.safe === true) {
        finish({ safe: true, blockers: [] });
        return;
      }
      finish({
        safe: false,
        blockers: boundedBlockers(
          result?.blockers,
          "An open AcreSignal tab could not lock its field work for this update.",
        ),
      });
    };
    channel.port1.start?.();
    try {
      client.postMessage(
        {
          type: ACRESIGNAL_PREPARE_UPDATE,
          protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
          requestId,
          buildStamp: ACRESIGNAL_BUILD_STAMP,
        },
        [channel.port2],
      );
    } catch {
      finish({
        safe: false,
        blockers: [
          "An open AcreSignal tab could not be reached for update safety verification.",
        ],
      });
    }
  });
}

async function prepareExactClientSetAndActivate(
  requestId,
  sourceClientId,
  sealActivation,
) {
  let clients = [];
  let activated = false;
  try {
    clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    const initialIds = clientIds(clients);
    if (initialIds.length === 0 || !initialIds.includes(sourceClientId)) {
      return {
        type: ACRESIGNAL_ACTIVATE_UPDATE_RESULT,
        protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
        requestId,
        activated: false,
        blockers: [
          "AcreSignal could not bind this update to the complete set of open app tabs.",
        ],
      };
    }
    if (initialIds.length > ACRESIGNAL_MAX_PREPARED_CLIENTS) {
      return {
        type: ACRESIGNAL_ACTIVATE_UPDATE_RESULT,
        protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
        requestId,
        activated: false,
        blockers: [
          "Too many AcreSignal tabs are open for one bounded safety update. Close unused tabs and retry.",
        ],
      };
    }

    const results = await Promise.all(
      clients.map((client) => prepareClient(client, requestId)),
    );
    const blockers = results.flatMap((result) =>
      result.safe ? [] : result.blockers,
    );
    if (cancelledActivationRequests.has(requestId)) {
      blockers.push(
        "The AcreSignal update request was cancelled before activation.",
      );
    }
    if (blockers.length > 0) {
      return {
        type: ACRESIGNAL_ACTIVATE_UPDATE_RESULT,
        protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
        requestId,
        activated: false,
        blockers: boundedBlockers(
          blockers,
          "One or more AcreSignal tabs are not safe to reload.",
        ),
      };
    }

    await persistPreparedClientReceipt(requestId, initialIds);
    const finalClients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    if (!sameClientSet(initialIds, clientIds(finalClients))) {
      return {
        type: ACRESIGNAL_ACTIVATE_UPDATE_RESULT,
        protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
        requestId,
        activated: false,
        blockers: [
          "The set of open AcreSignal tabs changed during update preparation. Retry after tabs settle.",
        ],
      };
    }
    if (cancelledActivationRequests.has(requestId)) {
      return {
        type: ACRESIGNAL_ACTIVATE_UPDATE_RESULT,
        protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
        requestId,
        activated: false,
        blockers: [
          "The AcreSignal update request was cancelled before activation.",
        ],
      };
    }

    // No asynchronous work may be inserted between the final exact-client-set
    // comparison and this call. Every prepared tab continues holding its local
    // mutation lease until controllerchange/page teardown.
    sealActivation();
    const skipWaiting = self.skipWaiting();
    await skipWaiting;
    activated = true;
    return {
      type: ACRESIGNAL_ACTIVATE_UPDATE_RESULT,
      protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
      requestId,
      activated: true,
      blockers: [],
    };
  } catch {
    return {
      type: ACRESIGNAL_ACTIVATE_UPDATE_RESULT,
      protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
      requestId,
      activated: false,
      blockers: [
        "AcreSignal could not complete the all-tab update safety protocol.",
      ],
    };
  } finally {
    if (!activated) {
      await deletePreparedClientReceipt().catch(() => undefined);
      await releaseClients(clients, requestId);
    }
    cancelledActivationRequests.delete(requestId);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
      try {
        await precacheBuildGraph(cache);
        await persistInstallContext(Boolean(self.registration?.active));
      } catch (error) {
        await caches.delete(ACRESIGNAL_SHELL_CACHE);
        throw error;
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      const generations = cacheNames.filter((cacheName) =>
        cacheName.startsWith(ACRESIGNAL_CACHE_PREFIX),
      );
      const previousGenerations = generations
        .filter((cacheName) => cacheName !== ACRESIGNAL_SHELL_CACHE)
        .slice(-(ACRESIGNAL_RETAINED_CACHE_GENERATIONS - 1));
      const retained = new Set([
        ACRESIGNAL_SHELL_CACHE,
        ...previousGenerations,
      ]);
      await Promise.all(
        generations
          .filter((cacheName) => !retained.has(cacheName))
          .map((cacheName) => caches.delete(cacheName).catch(() => false)),
      );
      const receipt = await readPreparedClientReceipt();
      if (receipt) {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        await commitPreparedClients(clients, receipt);
        await Promise.all([
          deletePreparedClientReceipt().catch(() => undefined),
          deleteInstallContext().catch(() => undefined),
        ]);
        return;
      }
      const installContext = await readInstallContext();
      await Promise.all([
        deletePreparedClientReceipt().catch(() => undefined),
        deleteInstallContext().catch(() => undefined),
      ]);
      // Claiming is useful on first install because the open document already
      // runs this exact build. During an update, an absent/invalid receipt is
      // fail-safe: never claim an unprepared late client into a new controller.
      if (installContext?.hadActiveWorker === false) await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type === ACRESIGNAL_QUERY_BUILD_IDENTITY) {
    const port = event.ports?.[0];
    const requestId = data.requestId;
    if (!port) return;
    event.waitUntil(
      (async () => {
        if (
          data.protocolVersion !== ACRESIGNAL_UPDATE_PROTOCOL_VERSION ||
          !validRequestId(requestId) ||
          !Array.isArray(data.executingEntryAssets) ||
          data.executingEntryAssets.length < 1 ||
          data.executingEntryAssets.length > 8 ||
          data.executingEntryAssets.some(
            (assetPath) =>
              typeof assetPath !== "string" ||
              assetPath.length > 300 ||
              !isContentHashedAsset(new URL(assetPath, self.location.origin)),
          )
        ) {
          postPortResult(port, {
            type: ACRESIGNAL_BUILD_IDENTITY_RESULT,
            protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
            requestId: validRequestId(requestId)
              ? requestId
              : "invalid-request",
            verified: false,
            matches: false,
          });
          return;
        }
        try {
          const currentAssets = new Set(await currentBuildAssetPaths());
          postPortResult(port, {
            type: ACRESIGNAL_BUILD_IDENTITY_RESULT,
            protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
            requestId,
            buildStamp: ACRESIGNAL_BUILD_STAMP,
            verified: currentAssets.size > 0,
            matches:
              currentAssets.size > 0 &&
              data.executingEntryAssets.every((assetPath) =>
                currentAssets.has(assetPath),
              ),
          });
        } catch {
          postPortResult(port, {
            type: ACRESIGNAL_BUILD_IDENTITY_RESULT,
            protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
            requestId,
            verified: false,
            matches: false,
          });
        }
      })(),
    );
    return;
  }
  if (
    data?.type === ACRESIGNAL_CANCEL_UPDATE &&
    data.protocolVersion === ACRESIGNAL_UPDATE_PROTOCOL_VERSION &&
    validRequestId(data.requestId)
  ) {
    if (
      activationAttempt?.requestId !== data.requestId ||
      activationAttempt.phase === "sealed" ||
      activationAttempt.phase === "activated"
    )
      return;
    cancelledActivationRequests.add(data.requestId);
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        await releaseClients(clients, data.requestId);
      })(),
    );
    return;
  }
  if (data?.type !== ACRESIGNAL_ACTIVATE_UPDATE) return;

  const port = event.ports?.[0];
  const requestId = data.requestId;
  const sourceClientId = event.source?.id;
  if (!port) return;
  event.waitUntil(
    (async () => {
      if (
        data.protocolVersion !== ACRESIGNAL_UPDATE_PROTOCOL_VERSION ||
        !validRequestId(requestId) ||
        typeof sourceClientId !== "string"
      ) {
        postPortResult(port, {
          type: ACRESIGNAL_ACTIVATE_UPDATE_RESULT,
          protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
          requestId: validRequestId(requestId) ? requestId : "invalid-request",
          activated: false,
          blockers: ["AcreSignal received an invalid update-safety request."],
        });
        return;
      }

      if (activationAttempt && activationAttempt.requestId !== requestId) {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        await releaseClients(clients, requestId);
        postPortResult(port, {
          type: ACRESIGNAL_ACTIVATE_UPDATE_RESULT,
          protocolVersion: ACRESIGNAL_UPDATE_PROTOCOL_VERSION,
          requestId,
          activated: false,
          blockers: [
            "Another AcreSignal update-safety request is already in progress.",
          ],
        });
        return;
      }

      if (!activationAttempt) {
        const attempt = { requestId, phase: "preparing", promise: undefined };
        const promise = prepareExactClientSetAndActivate(
          requestId,
          sourceClientId,
          () => {
            attempt.phase = "sealed";
          },
        );
        attempt.promise = promise;
        activationAttempt = attempt;
        void promise.then((result) => {
          if (result.activated && activationAttempt === attempt)
            attempt.phase = "activated";
          if (!result.activated && activationAttempt === attempt)
            activationAttempt = undefined;
        });
      }
      postPortResult(port, await activationAttempt.promise);
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    !isSameOrigin(url) ||
    isPrivateOrApiRequest(request, url)
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          // A build-stamped cache is immutable. An older controller must never
          // overwrite its shell with a newer deployment's index document.
          return await fetch(request);
        } catch {
          const currentCache = await caches.open(ACRESIGNAL_SHELL_CACHE);
          return (
            (await currentCache.match(absoluteUrl("/index.html"))) ??
            (await currentCache.match(absoluteUrl("/"))) ??
            (await caches.match(absoluteUrl("/index.html"))) ??
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  if (!isCacheableStaticRequest(request, url)) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached && isContentHashedAsset(url)) return cached;

      try {
        const response = await fetch(request);
        if (isCacheableStaticResponse(response)) {
          try {
            const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
            await bestEffortRuntimeCachePut(cache, request, response);
          } catch {
            // Opening optional runtime storage is also best-effort. A valid
            // network response always wins over cache pressure or cache failure.
          }
        }
        return response;
      } catch {
        return cached ?? Response.error();
      }
    })(),
  );
});
