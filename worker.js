/* Shout Runner — the leaderboard endpoint.
 *
 * One file, one free Cloudflare Worker, no card and no server to run. It does
 * two things: GET returns the board as the game already expects to read it,
 * POST takes one player's score and keeps it if it beats what they had.
 *
 * Setting it up (about five minutes, all in the browser):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker. Name it
 *      whatever you like, Deploy, then Edit code and paste this file in.
 *   2. Storage & Databases → KV → Create a namespace called SCORES.
 *   3. Back in the Worker: Settings → Bindings → Add → KV namespace.
 *      Variable name SCORES, and pick the namespace you just made.
 *   4. Deploy. Copy the worker's address.
 *   5. In web/index.html set BOARD_URL to that address.
 *
 * What this does not do is tell whether a score is real. Nothing that runs on
 * the player's phone can: the game is a file they have a copy of, and anyone
 * willing to open the console can post whatever number they like. It rejects
 * nonsense and refuses to lower anybody's score, which is the honest limit
 * without accounts and something to check a score against.
 */

const BOARD_KEY = "board";
const MAX_ROWS  = 100;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key",
  "Access-Control-Max-Age": "86400",
};

// Same rule the game uses: printable, single-spaced, fourteen characters.
// Names are shown on other people's phones, so they are cleaned here as well
// as there -- a client-side check protects nobody from a hand-written POST.
function cleanName(v) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 14);
}

const num = v => Math.min(9_999_999, Math.max(0, v | 0));

// Who a row belongs to. The board used to be keyed by NAME, which got the
// identity question exactly backwards in both directions: one player who
// renamed themselves became two rows, and two players who picked the same
// name became one. A save mints this once and never changes it, so a rename
// moves a row instead of starting another.
//
// What it is not is proof. Nothing here can be -- the game is a file the
// player has a copy of, and an id is as forgeable as a name was. It is a
// handle that a player cannot change BY ACCIDENT, which is the bug being
// fixed; the file has never claimed more than that.
const cleanId = v => /^[a-z0-9]{8,32}$/.test(String(v || "")) ? String(v) : "";
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// One row per name, and the best score is the one that stays.
//
// Swept on every read and every write, so a duplicate does not need anybody
// to come back and post before it goes -- opening the board is enough.
//
// The loser is not simply dropped. Its kills and runs are the same player's
// too, so the survivor takes the best of them; deleting the row outright
// would quietly lower a number that was honestly earned.
//
// The cost, stated plainly: two DIFFERENT players who pick the same name now
// get one row between them, and the lower of the two disappears. Keying by
// id had given them a row each. This is the trade the owner asked for, and
// on a board where everyone knows everyone a repeated name is far more
// likely to be one person twice than two people once.
function dedupe(board) {
  const best = new Map();
  for (const r of board) {
    if (!r || !r.n) continue;
    const k = String(r.n).toLowerCase();
    const cur = best.get(k);
    if (!cur) { best.set(k, r); continue; }
    const keep = (r.b | 0) > (cur.b | 0) ? r : cur;
    const drop = keep === r ? cur : r;
    keep.k = Math.max(keep.k | 0, drop.k | 0);
    keep.r = Math.max(keep.r | 0, drop.r | 0);
    // An id is worth more than no id: it is what stops the row being
    // duplicated again next time its owner renames.
    if (!keep.id && drop.id) keep.id = drop.id;
    best.set(k, keep);
  }
  return [...best.values()];
}

export default {
  async fetch(request, env) {
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });

    // The game is served from this same Worker as static files, so only the
    // API path belongs to this code. Anything else is a page request and is
    // handed back to the asset server.
    // This Worker is the board and nothing else. Anyone who opens its address
    // in a browser wanted the game, so send them there rather than showing
    // them a 404 or a page of JSON.
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) {
      return Response.redirect("https://manosvarto.github.io/shoot-runners/", 302);
    }

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!env.SCORES) return reply({ error: "No KV binding named SCORES" }, 500);

    let board = [];
    try { board = JSON.parse(await env.SCORES.get(BOARD_KEY) || "[]"); } catch {}
    if (!Array.isArray(board)) board = [];

    // Tidying up, for the owner only.
    //
    // Keying rows by id stops a rename making a duplicate from here on, but
    // it cannot reach the ones already on the board: those were left by
    // renames that happened before any save had an id, so nothing now knows
    // whose they were. They have to be removed by hand, and this is the
    // handle for it.
    //
    // It is OFF unless a secret is set. With no ADMIN_KEY in the Worker's
    // variables this returns 404 like any other unknown route, so nothing is
    // exposed by shipping it. Set one in the dashboard (Settings ->
    // Variables, "Encrypt" it) to turn it on.
    if (request.method === "DELETE") {
      const key = env.ADMIN_KEY || "";
      const sent = request.headers.get("X-Admin-Key") || "";
      // No key configured: the route does not exist. Compared length-first so
      // a wrong key and a wrong-length key look the same from outside.
      if (!key || sent.length !== key.length || sent !== key)
        return reply({ error: "Not found" }, 404);
      // By id where the row has one, by name otherwise. Names are the handle
      // a person reads off the board, but they are not unique in the store
      // -- and deleting the wrong row because two of them share a spelling
      // is exactly the kind of mistake a delete button must not make.
      const q = new URL(request.url).searchParams;
      const byId = q.getAll("id").map(cleanId).filter(Boolean);
      const byName = q.getAll("n").map(cleanName).filter(Boolean);
      if (!byId.length && !byName.length)
        return reply({ error: "Nothing named to drop" }, 400);
      const before = board.length;
      board = board.filter(e => !(e && (byId.includes(e.id) ||
                                        byName.some(d => sameName(e.n, d)))));
      await env.SCORES.put(BOARD_KEY, JSON.stringify(board));
      return reply({ ok: true, dropped: before - board.length, left: board.length });
    }

    // Reading the board is enough to tidy it: sweep, and write back only if
    // the sweep actually changed something, so an ordinary GET is still a
    // read as far as KV is concerned.
    if (request.method === "GET") {
      const swept = dedupe(board);
      if (swept.length !== board.length) {
        swept.sort((a, b) => (b.b | 0) - (a.b | 0));
        await env.SCORES.put(BOARD_KEY, JSON.stringify(swept.slice(0, MAX_ROWS)));
      }
      return reply(swept.slice(0, MAX_ROWS));
    }
    if (request.method !== "POST") return reply({ error: "GET or POST" }, 405);


    let body;
    try { body = await request.json(); } catch { return reply({ error: "Bad JSON" }, 400); }

    const n = cleanName(body && body.n);
    if (!n) return reply({ error: "No name" }, 400);

    const id = cleanId(body && body.id);
    const row = { n, b: num(body.b), k: num(body.k), r: num(body.r),
                  t: Date.now(), ...(id ? { id } : {}) };

    // Rows this save used to be filed under, before it was renamed. Retired
    // here so a rename leaves one row behind instead of two -- but only ones
    // that are unclaimed or already this id's, so a post can never retire a
    // row that belongs to somebody else. What the old row is NOT allowed to
    // do is take its score to the grave: the best of it comes forward, so a
    // retired row is a moved score and never a lost one.
    if (id) {
      for (const was of (Array.isArray(body.was) ? body.was : []).slice(0, 6)) {
        const w = cleanName(was);
        if (!w || sameName(w, n)) continue;
        const i = board.findIndex(e => e && sameName(e.n, w) &&
                                       (!e.id || e.id === id));
        if (i < 0) continue;
        row.b = Math.max(row.b, board[i].b | 0);
        row.k = Math.max(row.k, board[i].k | 0);
        row.r = Math.max(row.r, board[i].r | 0);
        board.splice(i, 1);
      }
    }

    // The row this save already owns, wherever it is filed and whatever it
    // is called. Found by id FIRST -- that is the whole point, because after
    // a rename the name no longer finds it.
    let at = id ? board.findIndex(e => e && e.id === id) : -1;
    if (at < 0) {
      // No row owned by this id yet. Fall back to the name, which is how
      // every row written before ids existed is adopted: the first post
      // carrying an id claims the row spelled the same way. A row already
      // owned by a DIFFERENT id is not claimable -- two players sharing a
      // name now get a row each, where the old board silently gave them one
      // between them.
      at = board.findIndex(e => e && sameName(e.n, n) && (!e.id || e.id === id));
    }

    // A submission can raise somebody's score and never lower it, so a fresh
    // install posting zeroes cannot wipe out the run they did last week. A
    // RENAME is the exception that proves it: the score is unchanged, so the
    // row still has to be rewritten to carry the new spelling.
    if (at >= 0) {
      const cur = board[at];
      const renamed = !sameName(cur.n, n);
      if ((cur.b | 0) >= row.b) {
        if (!renamed && (cur.id || "") === (row.id || ""))
          return reply({ ok: true, kept: true });
        // Keep the better score, take the new name and the id.
        row.b = cur.b | 0;
        row.k = Math.max(row.k, cur.k | 0);
        row.r = Math.max(row.r, cur.r | 0);
      }
      board[at] = row;
    } else {
      board.push(row);
    }

    board = dedupe(board);
    board.sort((a, b) => (b.b | 0) - (a.b | 0));
    board = board.slice(0, MAX_ROWS);
    await env.SCORES.put(BOARD_KEY, JSON.stringify(board));
    return reply({ ok: true,
                   rank: board.findIndex(e => id ? e.id === id : e.n === n) + 1 });
  },
};
