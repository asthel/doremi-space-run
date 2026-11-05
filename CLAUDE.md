# Doremi Space Run: project notes

Part of the BAKKUVERSO project (brand owner: Dex; project lead: Idzumi). Reply to Idzumi in Latin American Spanish (tuteo, Claude in masculine); switch to English if she writes English. One thing at a time; propose, wait for OK. Never invent data. Her final click on anything (publish, deploy) is hers.

## State
- Playable prototype: `index.html` (canvas, W=480, variable H, WebAudio chiptune, pause button, local ranking in localStorage keys `dsr_*`).
- Test hooks: `window.__dsr` (start, auto, skip, pause, playT, api, etc.). Playwright tests were run on phone 390x844 and desktop.
- DONE (code + tests, NOT deployed): public leaderboard in `server/` (branch `leaderboard`, PR #1, not merged yet). It includes validation, rate limiting, a score-vs-play-time cap and local fallback.
- DONE (code + tests, NOT deployed): moderation (branch `admin-moderation`, PR into `leaderboard`). It includes the `/admin` page with `ADMIN_KEY`, delete and block, name filter (`server/blocklist.json`), and reserved names with a PIN for IDZUMI and DEX.
- Not verified on a real iPhone yet (touch, audio unlock, performance).

## Pending
1. Merge PR #1, then the moderation PR (Idzumi's click).
2. Hosting: SiteGround Node.js limits, env vars (`ADMIN_KEY`, `ALLOWED_ORIGIN`, `DATA_FILE`), persistent disk and proxy/`X-Forwarded-For` are NOT verified. Nothing is deployed.
3. After deploy: set `ADMIN_KEY`, reserve IDZUMI and DEX with their PINs, and back up `DATA_FILE`.
4. Decide where the game is published (bakkufest.com / BakkuVerso hub).
5. Dex approval of the name "Doremi Space Run" is stated by Idzumi, not yet confirmed by him in writing.
6. Client-side scores can still be faked (best-effort cap only); the name filter will miss things. The admin page is the safety net.

## Rules
- Keep it free, simple, phone-friendly, low-maintenance.
- Credits: Kenney assets are CC0; keep the license file.
