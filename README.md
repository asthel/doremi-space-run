# Doremi Space Run

Arcade space shooter (Galaga-style) starring Doremi's ship, for **BakkuVerso** (BakkuFest brand).

- Single-file HTML5 canvas game: `index.html` (no build step).
- Controls: drag on touch / arrows or WASD / mouse. The ship auto-fires.
- Public ranking via a tiny Node.js API in `server/` (top 20). If the API is unreachable, the game falls back to the local ranking (this device only) and shows the "ranking de prueba" note.

## Run locally

    python3 -m http.server 8765
    # open http://localhost:8765

## Public leaderboard (`server/`)

One entry file, `server/server.js`, built with Node.js built-ins only (no `npm install`, no dependencies). Requires Node 18 or newer. Two side files sit next to it: `admin.html` (the admin page) and `blocklist.json` (the word list).

| Endpoint | What it does |
|---|---|
| `GET /api/scores` | Top 20 as JSON: `{"top":[{"rank":1,"name":"DEX","score":25000}, ...]}` |
| `POST /api/scores` | Body `{"name":"DEX","score":25000,"duration":30000}` (duration = play time in ms). Returns `{ok, improved, best, rank, top}`. |
| `GET /api/health` | `{"ok":true}` |

For a reserved name, `POST /api/scores` also needs `"pin":"123456"`. Without it the answer is `403 {"reserved":true}`, and with a wrong PIN it is `403 {"reserved":true,"badPin":true}`. A name caught by the filter gets `400 {"notAllowed":true,"message":"Ese nombre no está permitido"}`. The response never says which word matched.

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
| `PORT` | `8787` | Most hosts set this for you. A non-numeric value is used as a socket path. If the port is taken, the app stops with a clear message. |
| `ADMIN_KEY` | (empty: admin off) | Admin password, **at least 16 characters**. If it is unset or shorter, `/api/admin/*` returns 503. See "Moderation" below. |
| `ALLOWED_ORIGIN` | (empty: POST disabled) | Comma-separated, e.g. `https://[game domain]`. Must match exactly, including `https://` and with no trailing slash. |
| `BLOCKLIST_FILE` | `server/blocklist.json` | Word list for the name filter. |
| `DATA_DIR` | `server/data` | Folder for `scores.json` (scores, blocks, PIN hashes). Created if missing. Put it outside the public web folder and back it up. If it cannot be written, the app stops at startup with a clear message. |
| `DATA_FILE` | (unset) | Older option: full path to the data file. If set, it wins over `DATA_DIR`. |
| `TRUST_PROXY` | off | `1`/`true`/`yes`/`on` = take the player IP from `X-Forwarded-For` (the first valid address; IPv4 or IPv6, with or without port). If the header is missing or malformed, the connection IP is used. Off = exactly the old behavior. Turn it on only behind a proxy that sets this header. If the proxy appends to a header the player sent, the first address can be faked. [Not verified for SiteGround.] |
| `MAX_PPS`, `SCORE_GRACE` | `1500`, `5000` | Anti-cheat cap. Raise them if the game's scoring changes. |
| `POST_LIMIT`, `GET_LIMIT`, `RATE_WINDOW_MS` | `6`, `60`, `60000` | Rate limit. |

### Connecting the game

`index.html` reads the API URL from `<meta name="dsr-api" content="/api/scores">`.
- If the game and the API share a domain and `/api/scores` reaches the Node app, leave it as is.
- If the API lives elsewhere, put the full URL there, e.g. `https://[api host]/api/scores`, and add the game's origin to `ALLOWED_ORIGIN`.
- Empty `content` = local ranking only.

### Deploying on SiteGround "Node.js Projects" (nothing has been deployed)

**Step-by-step guide in Spanish: [`DESPLIEGUE-SITEGROUND.md`](DESPLIEGUE-SITEGROUND.md).**

On startup the app prints one line: `[dsr] started: PORT=… DATA_DIR=… TRUST_PROXY=on|off ALLOWED_ORIGIN=… ADMIN=enabled|disabled`. It never prints the key.

Entry file: `server/server.js` (or use `npm start`). The port comes from `PORT`. Steps as far as they are known; everything in [brackets] is unverified and must be checked in Site Tools:
1. Upload the `server/` folder [to which path SiteGround expects].
2. Create the Node.js project, with Node version [>= 18 available?], startup file `server.js`.
3. Set the environment variables `ADMIN_KEY`, `ALLOWED_ORIGIN`, `DATA_DIR` and `TRUST_PROXY` [where SiteGround lets you set them].
4. Check that the file in `DATA_DIR` survives restarts and redeploys [unverified]. The app itself refuses to start if it cannot write there.
5. Check whether SiteGround sits behind a proxy and sets `X-Forwarded-For`, then decide on `TRUST_PROXY` [unverified].
6. [Limits on RAM, CPU, uptime and whether the app sleeps when idle: unverified.]

If SiteGround does not fit, the same file runs unchanged on any host that runs `node server.js`.

## Moderation (admins: Idzumi and Dex)

The admin page is at `https://[api host]/admin`, served by the same Node app. The game does not link to it. It is built for a phone first: large buttons, and every delete asks for confirmation. From the page you can:
- see every score, including names that are **hidden** because they match a blocked word (hidden names stay out of the public top);
- **Borrar** a score, or **Borrar + bloquear**, which deletes the score and blocks that exact name;
- block a **word**, which hits any name containing it, leetspeak included, or an **exact name**, and remove blocks later;
- **reserve a name** with a PIN of 6-12 digits, change the PIN, or remove the reservation.

### Setting `ADMIN_KEY`

1. Make a long random key on any computer that has Node:

       node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

   Or use a password manager to generate one with 16+ characters. Keep it in a password manager and share it with Dex privately, not over a public channel.
2. Set it as an **environment variable** named `ADMIN_KEY` where the Node.js app is configured. On SiteGround "Node.js Projects": [where Site Tools lets you set environment variables for a Node.js project is not verified. If there is no such option, ask SiteGround support how to pass env vars to the app. Do not write the key into `server.js` or any file in git.]
3. Restart the app. The startup log line says `admin: enabled`. It never prints the key.
4. Open `/admin` and log in. The key stays in that browser tab only (`sessionStorage`) and is cleared when the tab closes. It travels only in the `Authorization` header, never in a URL.

To change the key, set a new value and restart. Anyone who has the old key loses access.

How the key is protected:
- Only a SHA-256 digest of the key is kept in memory, and it is compared in constant time.
- After **5 failed attempts in 10 minutes** from one IP, admin access is blocked for that IP until the window passes, even with the right key.
- Admin calls are same-origin only: CORS never allows the `Authorization` header.
- The page is sent with `noindex`, a strict Content-Security-Policy, and no framing.

### Reserved names (IDZUMI, DEX)

On `/admin`, under "Nombres reservados", enter the name and a 6-12 digit PIN. The server stores only a salted `scrypt` hash, never the PIN, so a forgotten PIN cannot be recovered. Set a new one instead.

When someone saves a score under a reserved name, the game asks for the PIN. A wrong PIN shows "PIN incorrecto". After 5 wrong PINs in 10 minutes, that IP has to wait.

Look-alikes are covered too: reserving `DEX` also protects `D3X`, `DEXX`, `DÉX`. Other names, such as `DEXTER`, are not affected.

### Name filter

`server/blocklist.json` holds the base list, with Spanish (Latin American) and English slurs, sexual terms and insults. It has two lists:
- `contains`: blocked anywhere inside a name. Use it only for words that do not appear inside normal words.
- `exact`: blocked only when the whole name is that word. Use it for short words. For example, `culo` in `contains` would block CALCULO, and `puta` would block COMPUTADORA.

Before comparing, the server lowercases the name and strips accents. It converts leetspeak (`0→o 1→i/l 3→e 4→a 5→s 7→t @→a $→s`) and also checks a version with repeated letters collapsed (`FUUUCK`). Words that admins add on `/admin` work on top of this file.

To edit the file, change it and restart the app.

**No filter catches everything.** People invent new spellings, and some normal names will be blocked by mistake. For example, `NIGER` (the country) is blocked, and `AÑO` matches `ano`. The admin page is the real safety net: check it from time to time, and delete or block what gets through.

### Privacy

IP addresses are used only for rate limiting and are kept **in memory only**. They are never written to disk and are gone when the app restarts. The data file holds names, scores, timestamps, blocks, and PIN hashes.

### Honest limits of the anti-cheat

**Scores sent by the browser can never be fully trusted.** The game runs on the player's device, so anyone who opens the developer tools can send a made-up score, a made-up duration, and any name, including "IDZUMI" or "DEX". The server only blocks the obvious cases: bad formats, impossible points per second, and floods from a single IP. There are no player accounts. Reserved names with a PIN protect IDZUMI and DEX, but any other name can be used by anyone. The data file is easy to edit by hand if a fake score has to be removed.
Possible next steps, if needed: a server-issued run token at game start (the server then measures the play time itself), a moderation list, or a secret PIN per name.

### Tests

    node server/test/api.test.js          # API: validation, CORS, rate limit, atomic file, persistence, admin auth, delete/block/reserve, filter
    node server/test/deploy.test.js       # Deployment config: PORT, DATA_DIR (incl. unwritable), TRUST_PROXY / X-Forwarded-For, startup line
    node tests/leaderboard.e2e.js         # Playwright (Chromium): phone 390x844 + desktop. Submit, list, offline fallback, bad input, admin page, PIN flow, filter message

## Credits

- Sprites and sound effects: Kenney "Space Shooter Redux" (CC0). See `LICENSE-kenney-space-shooter-redux.txt`.
- Fonts: Unbounded and JetBrains Mono (SIL OFL, via Fontsource).
- Music: original 8-bit chiptune generated in code (WebAudio).
- Logo: Doremi Space Run, BakkuVerso.
