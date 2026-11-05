# Doremi Space Run

Arcade space shooter (Galaga-style) starring Doremi's ship, for **BakkuVerso** (BakkuFest brand).

- Single-file HTML5 canvas game: `index.html` (no build step).
- Controls: drag on touch / arrows or WASD / mouse. The ship auto-fires.
- Public ranking via a tiny Node.js API in `server/` (top 20). If the API is unreachable, the game falls back to the local ranking (this device only) and shows the "ranking de prueba" note.

## Run locally

    python3 -m http.server 8765
    # open http://localhost:8765

## Public leaderboard (`server/`)

A single file, `server/server.js`, built with Node.js built-ins only (no `npm install`, no dependencies). Requires Node 18 or newer.

| Endpoint | What it does |
|---|---|
| `GET /api/scores` | Top 20 as JSON: `{"top":[{"rank":1,"name":"DEX","score":25000}, ...]}` |
| `POST /api/scores` | Body `{"name":"DEX","score":25000,"duration":30000}` (duration = play time in ms). Returns `{ok, improved, best, rank, top}`. |
| `GET /api/health` | `{"ok":true}` |

Rules enforced by the server:
- `name`: 1-10 characters, `A-Z` and `0-9` only. The game cleans what the player types (accents removed, so "Ñ" becomes "N").
- `score`: integer from 1 to 9,999,999. Only the best score per name is kept.
- `duration`: integer ms, 3 s to 6 h. Sanity cap: `score <= SCORE_GRACE + MAX_PPS x seconds` (defaults 5000 + 1500/s).
  The default was measured, not guessed: the built-in autoplay bot, which cannot die, made 340-720 points per second over 20 minutes of game time. 1500/s is about twice that.
- Rate limit per IP (in memory): 6 POSTs and 60 GETs per minute by default.
- CORS: only origins listed in `ALLOWED_ORIGIN` get CORS headers, and POSTs from any other origin get 403.
- Storage: one JSON file, written atomically (write a temp file, fsync, rename). The top 1000 names are kept.

### Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | Most hosts set this for you. |
| `ALLOWED_ORIGIN` | (empty: POST disabled) | Comma-separated, e.g. `https://[game domain]`. Must match exactly, including `https://` and with no trailing slash. |
| `DATA_FILE` | `server/data/scores.json` | Put it outside the public web folder. Back it up if you care about the ranking. |
| `TRUST_PROXY` | off | Set to `1` only if the app runs behind a proxy that sets `X-Forwarded-For`. Otherwise all players may share one IP for rate limiting, or anyone can fake their IP. [Not verified for SiteGround.] |
| `MAX_PPS`, `SCORE_GRACE` | `1500`, `5000` | Anti-cheat cap. Raise them if the game's scoring changes. |
| `POST_LIMIT`, `GET_LIMIT`, `RATE_WINDOW_MS` | `6`, `60`, `60000` | Rate limit. |

### Connecting the game

`index.html` reads the API URL from `<meta name="dsr-api" content="/api/scores">`.
- If the game and the API share a domain and `/api/scores` reaches the Node app, leave it as is.
- If the API lives elsewhere, put the full URL there, e.g. `https://[api host]/api/scores`, and add the game's origin to `ALLOWED_ORIGIN`.
- Empty `content` = local ranking only.

### Deploying on SiteGround "Node.js Projects" (nothing has been deployed)

Entry file: `server/server.js` (or use `npm start`). The port comes from `PORT`. Steps as far as they are known; everything in [brackets] is unverified and must be checked in Site Tools:
1. Upload the `server/` folder [to which path SiteGround expects].
2. Create the Node.js project, with Node version [>= 18 available?], startup file `server.js`.
3. Set the environment variables `ALLOWED_ORIGIN` and `DATA_FILE` [where SiteGround lets you set them].
4. Check that the app can write to the `DATA_FILE` folder and that the file survives restarts and redeploys [unverified].
5. Check whether SiteGround sits behind a proxy and sets `X-Forwarded-For`, then decide on `TRUST_PROXY` [unverified].
6. [Limits on RAM, CPU, uptime and whether the app sleeps when idle: unverified.]

If SiteGround does not fit, the same file runs unchanged on any host that runs `node server.js`.

### Honest limits of the anti-cheat

**Scores sent by the browser can never be fully trusted.** The game runs on the player's device, so anyone who opens the developer tools can send a made-up score, a made-up duration, and any name, including "IDZUMI" or "DEX". The server only blocks the obvious cases: bad formats, impossible points per second, and floods from a single IP. There are no accounts, so names are not protected. The data file is easy to edit by hand if a fake score has to be removed.
Possible next steps, if needed: a server-issued run token at game start (the server then measures the play time itself), a moderation list, or a secret PIN per name.

### Tests

    node server/test/api.test.js          # API: validation, CORS, rate limit, atomic file, persistence
    node tests/leaderboard.e2e.js         # Playwright (Chromium): phone 390x844 + desktop. Submit, list, offline fallback, bad input

## Credits

- Sprites and sound effects: Kenney "Space Shooter Redux" (CC0). See `LICENSE-kenney-space-shooter-redux.txt`.
- Fonts: Unbounded and JetBrains Mono (SIL OFL, via Fontsource).
- Music: original 8-bit chiptune generated in code (WebAudio).
- Logo: Doremi Space Run, BakkuVerso.
