// Service worker for Rock Paper Scissors.
//
// BUMP VERSION ON EVERY CHANGE TO THIS SITE. Not only when this file
// changes: any edit under main-site/ is a new build, and the browser only
// sees an update when this file differs byte for byte.
//
// What happens to each request:
//
//   navigation              the shell this worker owns, network if absent
//   /api/                   not intercepted: the leaderboard needs the network
//   same origin assets      cache first
//   Google Fonts            cache first, in a cache that outlives versions
//   other cross origin      not intercepted (analytics, ads, and PeerJS and
//                           its broker, which STUN-p2p-spec.md says to leave
//                           to the network)
//   anything but GET        not intercepted
//
// Rules that are easy to break here:
//
// 1. skipWaiting and clients.claim happen only when a person presses Reload
//    on the update bar, which posts 'skip-waiting'. Neither appears in
//    install or activate. scripts/check-sw.mjs fails if that stops being true.
//
// 2. Navigations are answered from this worker's own shell, not the network.
//    The shell's modules are cache first, so a network page would pair a new
//    index.html with the previous build's JavaScript. New versions arrive
//    through the update bar, all at once.
//
// 3. Precache entries are fetched one at a time with cache: 'reload'. addAll
//    fails the whole install on one bad path, and without 'reload' a bumped
//    worker can fill its new cache from the HTTP cache's old files.
//
// 4. Nothing under /api/ is ever cached. A cached leaderboard, start ticket
//    or throw is a wrong answer, not a stale one.

const VERSION = "rpsgame-v3";

const SHELL = `rpsgame-shell-${VERSION}`;

// Not versioned: a font file does not change with the app.
const FONTS = "rpsgame-fonts-v1";

// Everything else is deleted on activate, including the template's old
// "rpsgame-v1" cache.
const KEEP = new Set([SHELL, FONTS]);

const FONT_CSS = "https://fonts.googleapis.com/css2?family=Jua&display=swap";

// Addresses the browser asks for. "/index.html" is absent because cleanUrls
// redirects it to "/", and a redirected response cannot answer a
// navigation. 404.html is absent: offline, an unknown path gets the shell.
const PRECACHE = [
  "/",

  "/css/theme.css",
  "/css/style.css",

  "/js/app.js",
  "/js/api.js",
  "/js/game.js",
  "/js/icons.js",
  "/js/leaderboard.js",
  "/js/multiplayer.js",
  "/js/net.js",
  "/js/qr.js",
  "/js/replay.js",
  "/js/rules.js",
  "/js/settings.js",
  "/js/theme.js",
  "/js/ui.js",
  "/js/update-bar.js",

  "/manifest.json",
  "/favicon.ico",
  "/XRP-192.png",
  "/XRP-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([fillShell(), warmFonts()]));
  // No skipWaiting. The new worker waits until somebody accepts the update.
});

async function fillShell() {
  const cache = await caches.open(SHELL);
  const failed = [];

  await Promise.all(
    PRECACHE.map(async (path) => {
      try {
        const response = await fetch(new Request(path, { cache: "reload" }));
        if (!response.ok) throw new Error(`${response.status}`);
        if (response.redirected) throw new Error("redirected");
        await cache.put(path, response);
      } catch (cause) {
        failed.push(`${path} (${cause?.message ?? cause})`);
      }
    })
  );

  if (failed.length) {
    console.warn(
      `[rpsgame] ${failed.length} of ${PRECACHE.length} precache entries failed. ` +
        `Offline is degraded, not off:\n  ${failed.join("\n  ")}`
    );
  }
}

// The Jua stylesheet and its Latin file, so a first visit followed straight
// by going offline still gets the right font. Best effort: a failure here
// costs the font, never the install.
async function warmFonts() {
  try {
    const cache = await caches.open(FONTS);
    if (await cache.match(FONT_CSS)) return;

    const css = await fetch(FONT_CSS, { mode: "cors" });
    if (!css.ok) return;
    const text = await css.clone().text();
    await cache.put(FONT_CSS, css);

    const latin = text.match(/\/\* latin \*\/[^}]*?url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
    if (latin) {
      const file = await fetch(latin[1], { mode: "cors" });
      if (file.ok) await cache.put(latin[1], file);
    }
  } catch {
    // Offline during install, or fonts blocked. The fallback font is fine.
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !KEEP.has(key)).map((key) => caches.delete(key)));
    })()
  );
  // No clients.claim, for the same reason there is no skipWaiting above.
});

self.addEventListener("message", (event) => {
  const data = event.data;
  const type = typeof data === "string" ? data : data?.type;

  if (type === "version") {
    event.source?.postMessage({ type: "version", version: VERSION });
    return;
  }

  // The only way either of these is ever called. js/update-bar.js posts it
  // when the reader presses Reload, and reloads on controllerchange.
  if (type === "skip-waiting") {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(font(request));
    return;
  }

  // Analytics, ads and PeerJS go straight to the network, and simply fail
  // offline.
  if (url.origin !== self.location.origin) return;

  // The leaderboard API: network only, and the page says so offline.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(request.mode === "navigate" ? navigation(request, url) : staticAsset(request, url));
});

async function navigation(request, url) {
  const shell = await caches.open(SHELL);

  // Join and replay links are the game page with a query; they get the
  // shell too, which is what lets a shared replay open offline.
  const own = await shell.match(url.pathname);
  if (own) return own;

  try {
    return await fetch(request);
  } catch {
    // Offline and not a page this worker holds: the game is the only page.
    return (await shell.match("/")) ?? Response.error();
  }
}

async function staticAsset(request, url) {
  const shell = await caches.open(SHELL);

  const cached = await shell.match(url.pathname);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (isCacheable(response)) await shell.put(url.pathname, response.clone());
    return response;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

async function font(request) {
  const cache = await caches.open(FONTS);

  const cached = await cache.match(request.url);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // The stylesheet comes back opaque when the page asks for it without
    // CORS, and says `private`, which isCacheable would refuse. It is the
    // same public file for everyone on this browser, so it is kept anyway.
    if (response.ok || response.type === "opaque") await cache.put(request.url, response.clone());
    return response;
  } catch {
    return new Response("", { status: 503 });
  }
}

// Whether a same origin response may be stored. Every shell write after
// install goes through here.
function isCacheable(response) {
  if (!response || response.status !== 200) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  if (response.redirected) return false;

  const control = (response.headers.get("Cache-Control") ?? "").toLowerCase();
  if (control.includes("no-store") || control.includes("private")) return false;

  return true;
}
