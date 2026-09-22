# Shout Runner

A browser game. No install, no account — open the link and play.

**▶ Play: https://manosvarto.github.io/shoot-runners/**

Lead a crew up a town street, shoot the gates to grow it, and get to the keep
at the end of the road. Works on a phone or a desktop browser.

The whole game is one file, `index.html` — code and art together, nothing to
build and nothing to download. Progress is saved in your own browser, so each
device keeps its own chips and upgrades.

All art generated with Google Gemini.

## The leaderboard endpoint

`worker.js` and `wrangler.toml` deploy a Cloudflare Worker that keeps the
shared board. Two things have to be filled in before a build can succeed:

1. **A KV namespace.** Cloudflare dashboard → Storage & Databases → KV →
   Create a namespace called `SCORES`, then paste its Namespace ID into the
   `id = ` line in `wrangler.toml`.
2. **The Worker name.** If you already created a Worker, put its name in the
   `name = ` line, or this deploys a second Worker beside it.

Once it deploys, copy the worker's address and set `BOARD_URL` in
`index.html` to it. That is what makes the board shared — until then the
game reads the static `scores.json` and never submits.
