# Doremi Space Run: project notes

Part of the BAKKUVERSO project (brand owner: Dex; project lead: Idzumi). Reply to Idzumi in Latin American Spanish (tuteo, Claude in masculine); switch to English if she writes English. One thing at a time; propose, wait for OK. Never invent data. Her final click on anything (publish, deploy) is hers.

## State
- Playable prototype: `index.html` (canvas, W=480, variable H, WebAudio chiptune, pause button, local ranking in localStorage keys `dsr_*`).
- Test hooks: `window.__dsr` (start, auto, skip, pause, etc.). Playwright tests were run on phone 390x844 and desktop.
- Not verified on a real iPhone yet (touch, audio unlock, performance).

## Pending
1. Public leaderboard (top ranking, anyone can see; Idzumi vs Dex for #1). Needs a small server (SiteGround Node.js limits NOT verified) or a free alternative. Client-submitted scores can be faked: add basic validation / rate limiting.
2. Decide where the game is published (bakkufest.com / BakkuVerso hub).
3. Dex approval of the name "Doremi Space Run" is stated by Idzumi, not yet confirmed by him in writing.

## Rules
- Keep it free, simple, phone-friendly, low-maintenance.
- Credits: Kenney assets are CC0; keep the license file.
