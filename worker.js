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
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

    if (request.method === "GET") return reply(board);
    if (request.method !== "POST") return reply({ error: "GET or POST" }, 405);

    let body;
    try { body = await request.json(); } catch { return reply({ error: "Bad JSON" }, 400); }

    const n = cleanName(body && body.n);
    if (!n) return reply({ error: "No name" }, 400);

    const row = { n, b: num(body.b), k: num(body.k), r: num(body.r), t: Date.now() };
    const at = board.findIndex(e => e && String(e.n).toLowerCase() === n.toLowerCase());

    // A submission can raise somebody's score and never lower it, so a fresh
    // install posting zeroes cannot wipe out the run they did last week.
    if (at >= 0) {
      if ((board[at].b | 0) >= row.b) return reply({ ok: true, kept: true });
      board[at] = row;
    } else {
      board.push(row);
    }

    board.sort((a, b) => (b.b | 0) - (a.b | 0));
    board = board.slice(0, MAX_ROWS);
    await env.SCORES.put(BOARD_KEY, JSON.stringify(board));
    return reply({ ok: true, rank: board.findIndex(e => e.n === n) + 1 });
  },
};
