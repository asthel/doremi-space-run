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
const KEY = 'e2e-' + require('crypto').randomBytes(12).toString('hex');
const ADMIN = 'http://localhost:' + API_PORT + '/admin';
const PINS = { phone: ['IDZUMI', '771203'], desktop: ['DEX', '482915'] };
const TYPES = { '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };

const stat = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || p.includes(path.sep + 'server' + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});

let n = 0; const ok = (m) => console.log('  ok', ++n, m);

async function play(page, frames) {
  await page.waitForFunction(() => window.__dsr && __dsr.mode === 'title');
  // over() can be absorbed by a shield power-up, so repeat it until the game is really over
  await page.evaluate((f) => { __dsr.start(); __dsr.auto(true); __dsr.skip(f); __dsr.auto(false); for (let i = 0; i < 5 && __dsr.mode !== 'over'; i++) { __dsr.over(); __dsr.skip(200); } }, frames);
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
  const name = label === 'phone' ? 'DOREMI' : 'BAKKU';
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

  // 2b) filter message + reserved-name PIN flow in the game
  ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript((api) => { window.DSR_API = api; }, API);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ORIGIN + '/');
  await play(page, 900);
  await page.waitForFunction(() => __dsr.api.ok === true);
  await page.fill('#nm', 'P3ND3J0');
  await page.click('#save');
  await page.waitForSelector('#msg:not(.hidden)');
  assert.strictEqual(await page.locator('#msg').innerText(), 'Ese nombre no está permitido. Usa otro.');
  assert.ok(await page.locator('#nm').isVisible()); ok('offensive leetspeak name -> neutral message, form stays open');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, label + '-filter.png') });
  const [rn, rpin] = PINS[label];
  await page.fill('#nm', rn);
  assert.ok(await page.locator('#msg').isHidden()); ok('editing the name clears the message');
  await page.click('#save');
  await page.waitForSelector('#pin:not(.hidden)');
  assert.ok((await page.locator('#msg').innerText()).includes('reservado')); ok(rn + ' is reserved -> PIN field appears');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, label + '-pin.png') });
  await page.fill('#pin', '000000');
  await page.click('#save');
  await page.waitForFunction(() => /PIN incorrecto/.test(document.getElementById('msg').textContent));
  assert.ok(await page.locator('#nameForm').isVisible()); ok('wrong PIN -> "PIN incorrecto", can retry');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, label + '-pin-wrong.png') });
  await page.fill('#pin', rpin);
  await page.press('#pin', 'Enter');
  await page.waitForSelector('#boardL li.me');
  assert.ok((await page.locator('#boardL li.me').innerText()).includes(rn)); ok('right PIN -> ' + rn + ' saved and highlighted');
  await ctx.close();

  // 2c) admin page
  ctx = await browser.newContext(ctxOpts);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(ADMIN);
  await page.fill('#key', 'not-the-key-123456');
  await page.click('#loginF button');
  await page.waitForFunction(() => /Clave incorrecta/.test(document.getElementById('status').textContent));
  assert.ok(await page.locator('#app').isHidden()); ok('admin: wrong key -> "Clave incorrecta", stays locked');
  await page.fill('#key', KEY);
  await page.click('#loginF button');
  await page.waitForSelector('#app:not(.hidden)');
  const store = await page.evaluate(() => ({ s: sessionStorage.getItem('dsr_admin_key'), l: JSON.stringify(localStorage), u: location.href }));
  assert.strictEqual(store.s, KEY); assert.ok(!store.l.includes(KEY)); assert.ok(!store.u.includes(KEY)); ok('admin: logged in; key in sessionStorage only (not localStorage, not URL)');
  const rowBox = await page.locator('#scores li.item button').first().boundingBox();
  assert.ok(rowBox.height >= 44); ok('admin: touch targets >= 44px (' + Math.round(rowBox.height) + 'px)');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, label + '-admin.png'), fullPage: true });
  const victim = name;
  const item = page.locator('#scores li.item', { hasText: victim });
  if (label === 'phone') {
    await item.getByRole('button', { name: 'Borrar', exact: true }).click();
  } else {
    await item.getByRole('button', { name: 'Borrar + bloquear' }).click();
    await page.waitForSelector('#blocked li.item:has-text("' + victim + '")');
    ok('admin: "Borrar + bloquear" adds ' + victim + ' to the blocklist');
  }
  await page.waitForFunction((v) => /Borrado/.test(document.getElementById('status').textContent) && ![...document.querySelectorAll('#scores .nm')].some((e) => e.firstChild.textContent === v), victim);
  const pubAfter = await (await fetch(API)).json();
  assert.ok(!pubAfter.top.some((e) => e.name === victim)); ok('admin: deleted ' + victim + ' from the page (confirm accepted) -> gone from public list');
  await page.reload();
  await page.waitForSelector('#app:not(.hidden)'); ok('admin: reload keeps the session (sessionStorage)');
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
    env: Object.assign({}, process.env, { PORT: String(API_PORT), ALLOWED_ORIGIN: ORIGIN, DATA_FILE: path.join(dir, 's.json'), POST_LIMIT: '100', ADMIN_KEY: KEY }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => api.stdout.once('data', r));
  for (const [nm, pin] of Object.values(PINS)) {
    const r = await fetch('http://localhost:' + API_PORT + '/api/admin/reserve', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm, pin }) });
    assert.strictEqual(r.status, 200);
  }
  assert.ok(!fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').toLowerCase().includes('admin')); console.log('  ok - game has no link to /admin');
  await new Promise((r) => stat.listen(GAME_PORT, r));
  const browser = await chromium.launch();
  try {
    const iphone = devices['iPhone 13'] ? Object.assign({}, devices['iPhone 13'], { viewport: { width: 390, height: 844 } }) : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
    await run('phone', iphone, browser);
    await run('desktop', { viewport: { width: 1280, height: 800 } }, browser);
    console.log('all ' + n + ' e2e checks passed');
  } catch (e) { console.error('FAIL', e.stack); process.exitCode = 1; }
  await browser.close(); stat.close(); api.kill();
  fs.rmSync(dir, { recursive: true, force: true });
})();
