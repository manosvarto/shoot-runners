/* Shout Runner, offline.
 *
 * The game is one file with every sprite inside it and, since the two
 * typefaces were embedded, not a single request to anywhere. So "works
 * with the phone in aeroplane mode" comes down to one thing: having the
 * file already. That is what this is for -- the page is kept in a cache
 * and served FROM it, so after one visit the game opens with no network
 * at all, and opens instantly because nothing is downloaded.
 *
 * BUILD is the only thing that has to change between deploys. The browser
 * re-fetches this script on its own, sees different bytes, installs the
 * new worker, and the page reloads once into it -- which is the whole
 * update story for anyone who has installed the game. tools/stamp.py
 * copies the constant here from the page so the two cannot drift.
 */
const BUILD = "2026-10-11a";
const CACHE = "shoutrunner-" + BUILD;
// Everything the game needs to start. The page itself is the game; the
// rest is what the home-screen icon is made of.
const SHELL = ["./", "./index.html", "./manifest.webmanifest",
               "./icon-192.png", "./icon-512.png", "./icon-512-maskable.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  // One cache per build, and the old ones go. A phone that has had five
  // updates should not be carrying five copies of a 5 MB page.
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET") return;
  let url;
  try{ url = new URL(req.url); }catch{ return; }
  // The leaderboard is somebody else's origin and is left alone entirely:
  // it is the one thing here that is MEANT to need the network, and a
  // cached board is a wrong board.
  if(url.origin !== self.location.origin) return;
  // Two files that must always come from the server, or the update check
  // would be asking the cache whether the cache is out of date.
  if(/\/(version|scores)\.json$/.test(url.pathname)) return;
  // The page: from the cache first, so it opens offline and opens fast.
  if(req.mode === "navigate"){
    e.respondWith(caches.match("./index.html").then(r => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});
