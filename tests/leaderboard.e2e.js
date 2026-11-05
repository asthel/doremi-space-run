'use strict';
// End-to-end leaderboard test (phone 390x844 + desktop). Needs Playwright with Chromium.
// Run from the repo root: node tests/leaderboard.e2e.js
const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const GAME_PORT = 18765, API_PORT = 18787;
const ORIGIN = 'http://localhost:' + GAME_PORT;
const API = 'http://localhost:' + API_PORT + '/api/scores';
const DEAD_API = 'http://localhost:1/api/scores';
const SHOTS = process.env.SHOTS || '';
const TYPES = { '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };

const stat = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || p.includes(path.sep + 'server' + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});

let n = 0; const ok = (m) => console.log('  ok', ++n, m);

async function play(page, frames) {
  await page.waitForFunction(() => window.__dsr && __dsr.mode === 'title');
  await page.evaluate((f) => { __dsr.start(); __dsr.auto(true); __dsr.skip(f); __dsr.auto(false); __dsr.over(); __dsr.skip(200); }, frames);
  await page.waitForFunction(() => __dsr.mode === 'over');
}

async function run(label, ctxOpts, browser) {
  console.log('[' + label + ']');
  const errors = [];
  // 1) online: submit + list
  let ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript((api) => { window.DSR_API = api; }, API);
  let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ORIGIN + '/');
  await play(page, 1200);
  await page.waitForFunction(() => __dsr.api.ok === true);
  assert.ok(await page.locator('#note').isHidden()); ok('API reachable -> "ranking de prueba" note hidden');
  const score = await page.evaluate(() => __dsr.score);
  const playT = await page.evaluate(() => __dsr.playT);
  assert.ok(playT > 15 && playT < 30, 'playT ' + playT);
  const name = label === 'phone' ? 'IDZUMI' : 'DEX';
  await page.fill('#nm', 'd' + 'é-x!'); // typed junk gets cleaned live
  assert.strictEqual(await page.inputValue('#nm'), 'DEX'); ok('name input cleaned to A-Z0-9 ("dé-x!" -> "DEX")');
  await page.fill('#nm', name);
  await page.click('#nameForm button');
  await page.waitForSelector('#boardL li.me');
  const meTxt = await page.locator('#boardL li.me').innerText();
  assert.ok(meTxt.includes(name), meTxt); ok('submitted ' + name + ' ' + score + ' (play time ' + playT.toFixed(1) + 's), highlighted in public list');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, label + '-online.png') });
  const list = await (await fetch(API)).json();
  assert.ok(list.top.some((e) => e.name === name && e.score === score)); ok('GET /api/scores lists it');

  // 2) bad input / cheat attempts from the page are rejected
  const codes = await page.evaluate(async (api) => {
    const post = (b) => fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.status);
    return [await post({ name: 'HACKER', score: 9000000, duration: 5000 }), await post({ name: 'bad name', score: 10, duration: 30000 }), await post({ name: 'X', score: -5, duration: 30000 })];
  }, API);
  assert.deepStrictEqual(codes, [400, 400, 400]); ok('cheat/bad input rejected from browser: ' + codes.join(','));
  const after = await (await fetch(API)).json();
  assert.ok(!after.top.some((e) => e.name === 'HACKER')); ok('rejected score not in list');
  await ctx.close();

  // 3) offline fallback: API unreachable -> local ranking, note visible, nothing broken
  ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript((api) => { window.DSR_API = api; }, DEAD_API);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ORIGIN + '/');
  await play(page, 600);
  await page.waitForTimeout(500);
  assert.strictEqual(await page.evaluate(() => __dsr.api.ok), false);
  assert.ok(await page.locator('#note').isVisible()); ok('API down -> note stays visible');
  await page.fill('#nm', 'OFFLINE');
  await page.click('#nameForm button');
  await page.waitForSelector('#boardL li.me');
  assert.ok((await page.locator('#boardL li.me').innerText()).includes('OFFLINE'));
  const local = await page.evaluate(() => JSON.parse(localStorage.getItem('dsr_board')));
  assert.ok(local.some((b) => b.n === 'OFFLINE')); ok('score saved to local ranking (localStorage dsr_board) and shown');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, label + '-offline.png') });
  await page.click('#again');
  await page.waitForFunction(() => __dsr.mode === 'play'); ok('"jugar otra vez" still works offline');
  await ctx.close();

  assert.deepStrictEqual(errors, []); ok('no page errors');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-e2e-'));
  const api = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(API_PORT), ALLOWED_ORIGIN: ORIGIN, DATA_FILE: path.join(dir, 's.json'), POST_LIMIT: '100' }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => api.stdout.once('data', r));
  await new Promise((r) => stat.listen(GAME_PORT, r));
  const browser = await chromium.launch();
  try {
    const iphone = devices['iPhone 13'] ? Object.assign({}, devices['iPhone 13'], { viewport: { width: 390, height: 844 } }) : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
    await run('phone', iphone, browser);
    await run('desktop', { viewport: { width: 1280, height: 800 } }, browser);
    console.log('all ' + n + ' e2e checks passed');
  } catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
  await browser.close(); stat.close(); api.kill();
  fs.rmSync(dir, { recursive: true, force: true });
})();
