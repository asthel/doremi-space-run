'use strict';
// API tests. Node built-ins only. Run: node server/test/api.test.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ORIGIN = 'http://localhost:8765';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-'));
const DATA = path.join(dir, 'scores.json');
let port = 18700 + Math.floor(Math.random() * 200);
const KEY = 'test-' + require('crypto').randomBytes(12).toString('hex');
let logs = '';

function start(extra) {
  const p = ++port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(p), ALLOWED_ORIGIN: ORIGIN, DATA_FILE: DATA, ADMIN_KEY: KEY }, extra || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { logs += d; });
  return new Promise((res) => child.stdout.once('data', (d) => { logs += d; child.stdout.on('data', (x) => { logs += x; }); res({ child, base: 'http://127.0.0.1:' + p }); }));
}
async function req(base, method, body, headers) {
  const h = Object.assign({ Origin: ORIGIN }, body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers || {});
  const r = await fetch(base + '/api/scores', { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j, h: r.headers };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function adm(base, method, p, body, key) {
  const h = {};
  if (key !== null) h.Authorization = 'Bearer ' + (key === undefined ? KEY : key);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(base + '/api/admin/' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
let n = 0;
function ok(name) { n++; console.log('  ok', n, name); }

(async () => {
  let s = await start({ POST_LIMIT: '1000' });
  let r = await req(s.base, 'GET');
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.j.top, []); ok('GET empty list');
  assert.strictEqual(r.h.get('access-control-allow-origin'), ORIGIN); ok('CORS header for allowed origin');
  r = await req(s.base, 'GET', undefined, { Origin: 'https://evil.example' });
  assert.strictEqual(r.h.get('access-control-allow-origin'), null); ok('no CORS header for other origin');

  r = await req(s.base, 'POST', { name: 'IDZUMI', score: 20000, duration: 30000 });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.j.rank, 1); ok('POST valid score');
  r = await req(s.base, 'POST', { name: 'DEX', score: 25000, duration: 30000 });
  assert.strictEqual(r.j.rank, 1); ok('higher score takes #1');
  r = await req(s.base, 'POST', { name: 'IDZUMI', score: 1000, duration: 30000 });
  assert.strictEqual(r.j.improved, false); assert.strictEqual(r.j.best, 20000); ok('lower score does not replace best per name');
  r = await req(s.base, 'POST', { name: 'IDZUMI', score: 30000, duration: 30000 });
  assert.strictEqual(r.j.improved, true); assert.strictEqual(r.j.rank, 1);
  assert.strictEqual(r.j.top.filter((e) => e.name === 'IDZUMI').length, 1); ok('better score replaces, one entry per name');

  const bad = [
    [{ name: 'idzumi', score: 100, duration: 30000 }, 'lowercase name'],
    [{ name: '', score: 100, duration: 30000 }, 'empty name'],
    [{ name: 'ABCDEFGHIJK', score: 100, duration: 30000 }, '11-char name'],
    [{ name: 'DÉX', score: 100, duration: 30000 }, 'accented name'],
    [{ name: '<script>', score: 100, duration: 30000 }, 'html name'],
    [{ name: 'A B', score: 100, duration: 30000 }, 'name with space'],
    [{ name: 'DEX', score: 0, duration: 30000 }, 'score 0'],
    [{ name: 'DEX', score: 12.5, duration: 30000 }, 'float score'],
    [{ name: 'DEX', score: '500', duration: 30000 }, 'string score'],
    [{ name: 'DEX', score: 10000000, duration: 21600000 }, 'score 10,000,000'],
    [{ name: 'DEX', score: 100 }, 'missing duration'],
    [{ name: 'DEX', score: 100, duration: 500 }, 'duration too short'],
    [{ name: 'DEX', score: 9000000, duration: 10000 }, 'score implausible for play time'],
    [[1, 2], 'array body'],
    ['{not json', 'invalid JSON'],
  ];
  for (const [b, label] of bad) { r = await req(s.base, 'POST', b); assert.strictEqual(r.status, 400, label + ' -> ' + r.status); }
  ok('rejected 400: ' + bad.map((b) => b[1]).join(', '));
  r = await req(s.base, 'POST', { name: 'DEX', score: 50000, duration: 30000 });
  assert.strictEqual(r.status, 200); ok('score right under cap (5000+1500*30=50000) accepted');

  r = await req(s.base, 'POST', { name: 'X', score: 1, duration: 30000 }, { Origin: 'https://evil.example' });
  assert.strictEqual(r.status, 403); ok('POST from other origin -> 403');
  r = await req(s.base, 'POST', JSON.stringify({ name: 'X', score: 1, duration: 30000 }), { 'Content-Type': 'text/plain' });
  assert.strictEqual(r.status, 415); ok('wrong content-type -> 415');
  r = await req(s.base, 'POST', JSON.stringify({ name: 'X', score: 1, duration: 30000, pad: 'x'.repeat(5000) }));
  assert.strictEqual(r.status, 413); ok('oversized body -> 413');
  const pre = await fetch(s.base + '/api/scores', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.strictEqual(pre.status, 204); ok('CORS preflight 204');

  for (let i = 0; i < 25; i++) await req(s.base, 'POST', { name: 'P' + i, score: 100 + i, duration: 30000 });
  r = await req(s.base, 'GET');
  assert.strictEqual(r.j.top.length, 20); assert.strictEqual(r.j.top[0].name, 'DEX');
  for (let i = 1; i < 20; i++) assert.ok(r.j.top[i - 1].score >= r.j.top[i].score); ok('GET returns top 20, sorted');

  await wait(200);
  const disk = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  assert.strictEqual(disk.entries.length, 27); assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))); ok('data file is valid JSON, no temp files left');
  s.child.kill(); await wait(100);

  s = await start({ POST_LIMIT: '3' });
  r = await req(s.base, 'GET'); assert.strictEqual(r.j.top[0].name, 'DEX'); ok('data persists across restart');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await req(s.base, 'POST', { name: 'RL' + i, score: 10, duration: 30000 })).status);
  assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]); ok('rate limit per IP -> 429 after 3 POSTs');
  s.child.kill(); await wait(100);

  // ---------- admin + moderation ----------
  s = await start({ POST_LIMIT: '1000', ADMIN_KEY: '' });
  r = await adm(s.base, 'GET', 'scores'); assert.strictEqual(r.status, 503); ok('ADMIN_KEY unset -> admin 503');
  s.child.kill(); await wait(100);
  s = await start({ POST_LIMIT: '1000', ADMIN_KEY: 'short' });
  r = await adm(s.base, 'GET', 'scores', undefined, 'short'); assert.strictEqual(r.status, 503); ok('ADMIN_KEY shorter than 16 chars -> admin stays off (503)');
  s.child.kill(); await wait(100);

  s = await start({ POST_LIMIT: '1000' });
  r = await adm(s.base, 'GET', 'scores'); assert.strictEqual(r.status, 200);
  assert.strictEqual(r.j.entries.length, 30, JSON.stringify(r.j.entries.map((e) => e.name))); assert.ok(r.j.entries.every((e) => typeof e.hidden === 'boolean')); ok('right key -> 200, all entries with hidden flag');
  r = await adm(s.base, 'GET', 'scores', undefined, 'wrong-key-wrong-key'); assert.strictEqual(r.status, 401); ok('wrong key -> 401');
  r = await adm(s.base, 'GET', 'scores', undefined, null); assert.strictEqual(r.status, 401); ok('no Authorization header -> 401');
  const q = await fetch(s.base + '/api/admin/scores?key=' + encodeURIComponent(KEY)); assert.strictEqual(q.status, 401); ok('key in URL is ignored -> 401');
  const pre2 = await fetch(s.base + '/api/admin/scores', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.ok(!/authorization/i.test(pre2.headers.get('access-control-allow-headers') || '')); ok('CORS never allows the Authorization header (admin is same-origin only)');
  const page = await fetch(s.base + '/admin'); const html = await page.text();
  assert.strictEqual(page.status, 200); assert.ok(html.includes('Moderación')); assert.ok(/frame-ancestors 'none'/.test(page.headers.get('content-security-policy'))); ok('GET /admin serves the page with CSP');

  // delete
  r = await adm(s.base, 'DELETE', 'scores/P0'); assert.strictEqual(r.status, 200); assert.ok(!r.j.entries.some((e) => e.name === 'P0'));
  r = await adm(s.base, 'DELETE', 'scores/P0'); assert.strictEqual(r.status, 404); ok('DELETE score -> gone (second time 404)');

  // profanity filter with leetspeak; neutral message that never names the word
  const blockedNames = ['PENDEJO', 'P3ND3J0', 'PENDEEEJO', 'FUUUCK', 'F4GG0T', 'SH1T', 'M13RD4', 'CHUCH4', 'PUT0', 'B1TCH', 'C4BR0N'];
  for (const nm of blockedNames) {
    r = await req(s.base, 'POST', { name: nm, score: 100, duration: 30000 });
    assert.strictEqual(r.status, 400, nm); assert.strictEqual(r.j.notAllowed, true, nm); assert.strictEqual(r.j.message, 'Ese nombre no está permitido');
    assert.ok(!JSON.stringify(r.j).toLowerCase().includes('pend') && !JSON.stringify(r.j).toLowerCase().includes('fuck'), 'message leaks word');
  }
  ok('filter blocks leetspeak/accents/repeats: ' + blockedNames.join(' ') + ' (neutral message)');
  const fine = ['P15', 'CALCULO', 'COMPUTADOR', 'AMERICA', 'GRAPE', 'BOB', 'ESCOGER', 'PEACOCK', 'CLASS', 'PENELOPE', 'TITAN'];
  for (const nm of fine) { r = await req(s.base, 'POST', { name: nm, score: 50, duration: 30000 }); assert.strictEqual(r.status, 200, nm); }
  ok('no false positives on: ' + fine.join(' '));

  // block word -> existing entry hidden from public, shown hidden in admin; new posts rejected; unblock restores
  await req(s.base, 'POST', { name: 'TOMATE', score: 99999, duration: 120000 });
  r = await adm(s.base, 'POST', 'block', { word: 'mate' }); assert.strictEqual(r.status, 200);
  assert.ok(r.j.entries.find((e) => e.name === 'TOMATE').hidden);
  r = await req(s.base, 'GET'); assert.ok(!r.j.top.some((e) => e.name === 'TOMATE')); ok('block word -> matching entry hidden from public list, flagged hidden for admin');
  r = await req(s.base, 'POST', { name: 'M4TE', score: 10, duration: 30000 }); assert.strictEqual(r.j.notAllowed, true); ok('blocked word also catches leetspeak (M4TE)');
  r = await adm(s.base, 'DELETE', 'block/MATE'); assert.strictEqual(r.status, 200);
  r = await req(s.base, 'GET'); assert.strictEqual(r.j.top[0].name, 'TOMATE'); ok('unblock word -> entry visible again');
  r = await adm(s.base, 'POST', 'block', { name: 'P1' }); assert.strictEqual(r.status, 200);
  r = await req(s.base, 'POST', { name: 'P1', score: 10, duration: 30000 }); assert.strictEqual(r.j.notAllowed, true);
  r = await req(s.base, 'POST', { name: 'P10', score: 10, duration: 30000 }); assert.strictEqual(r.status, 200); ok('block exact name -> only that name is blocked (P1 no, P10 yes)');
  r = await adm(s.base, 'POST', 'block', { word: 'a b<' }); assert.strictEqual(r.status, 400); ok('bad block item -> 400');

  // reserved names with PIN
  await req(s.base, 'POST', { name: 'DEX', score: 1, duration: 30000 }); // already has 50000 from earlier
  r = await adm(s.base, 'POST', 'reserve', { name: 'DEX', pin: '123' }); assert.strictEqual(r.status, 400); ok('reserve with short PIN -> 400');
  r = await adm(s.base, 'POST', 'reserve', { name: 'DEX', pin: '482915' }); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.j.reserved, ['DEX']);
  r = await adm(s.base, 'POST', 'reserve', { name: 'IDZUMI', pin: '771203' }); assert.strictEqual(r.status, 200);
  r = await adm(s.base, 'POST', 'reserve', { name: 'D3X', pin: '111111' }); assert.strictEqual(r.status, 409); ok('reserve DEX + IDZUMI; look-alike D3X refused (409)');
  r = await req(s.base, 'POST', { name: 'DEX', score: 60000, duration: 60000 }); assert.strictEqual(r.status, 403); assert.strictEqual(r.j.reserved, true); assert.ok(!r.j.badPin); ok('reserved name without PIN -> 403 {reserved:true}');
  r = await req(s.base, 'POST', { name: 'D3X', score: 60000, duration: 60000 }); assert.strictEqual(r.status, 403); ok('look-alike D3X also needs the DEX PIN');
  r = await req(s.base, 'POST', { name: 'DEX', score: 60000, duration: 60000, pin: '000000' }); assert.strictEqual(r.status, 403); assert.strictEqual(r.j.badPin, true); ok('wrong PIN -> 403 {reserved, badPin}');
  r = await req(s.base, 'POST', { name: 'DEX', score: 60000, duration: 60000, pin: '482915' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.j.best, 60000); ok('right PIN -> 200, score saved');
  r = await req(s.base, 'POST', { name: 'DEXTER', score: 10, duration: 30000 }); assert.strictEqual(r.status, 200); ok('normal names unaffected (DEXTER)');
  const disk1 = fs.readFileSync(DATA, 'utf8');
  assert.ok(!disk1.includes('482915') && !disk1.includes('771203')); assert.ok(/"salt":"[A-Za-z0-9+/=]{20,}","hash":"[A-Za-z0-9+/=]{40,}"/.test(disk1)); ok('only salted scrypt hash on disk, never the PIN');
  assert.ok(!/(\d{1,3}\.){3}\d{1,3}|::1|::ffff/.test(disk1)); ok('no IP addresses in the data file');

  // persistence across restart
  s.child.kill(); await wait(150);
  s = await start({ POST_LIMIT: '1000' });
  r = await adm(s.base, 'GET', 'scores');
  assert.deepStrictEqual(r.j.reserved, ['DEX', 'IDZUMI']); assert.ok(r.j.blocked.some((b) => b.type === 'name' && b.value === 'P1')); assert.ok(!r.j.entries.some((e) => e.name === 'P0'));
  r = await req(s.base, 'POST', { name: 'IDZUMI', score: 70000, duration: 60000, pin: '771203' }); assert.strictEqual(r.status, 200);
  r = await req(s.base, 'POST', { name: 'IDZUMI', score: 70000, duration: 60000 }); assert.strictEqual(r.status, 403);
  ok('blocklist, reserved names (PIN still works) and deletions survive restart');
  r = await adm(s.base, 'DELETE', 'reserve/IDZUMI'); assert.strictEqual(r.status, 200);
  r = await req(s.base, 'POST', { name: 'IDZUMI', score: 70001, duration: 60000 }); assert.strictEqual(r.status, 200); ok('unreserve -> name open again');

  // PIN brute force limit
  const pinCodes = [];
  for (let i = 0; i < 7; i++) pinCodes.push((await req(s.base, 'POST', { name: 'DEX', score: 10, duration: 30000, pin: String(100000 + i) })).status);
  assert.deepStrictEqual(pinCodes, [403, 403, 403, 403, 403, 429, 429]); ok('wrong PIN 5 times -> 429');

  // admin auth rate limit: 5 failures per 10 min, then even the right key waits
  const authCodes = [];
  for (let i = 0; i < 5; i++) authCodes.push((await adm(s.base, 'GET', 'scores', undefined, 'nope-' + i)).status);
  authCodes.push((await adm(s.base, 'GET', 'scores')).status);
  assert.deepStrictEqual(authCodes, [401, 401, 401, 401, 401, 429]);
  ok('failed admin logins limited: 5 x 401, then 429 even with the right key');
  s.child.kill(); await wait(100);

  // old data format (plain array) still loads
  fs.writeFileSync(DATA, JSON.stringify([{ name: 'OLD', score: 5, t: 1 }]));
  s = await start({});
  r = await req(s.base, 'GET'); assert.strictEqual(r.j.top[0].name, 'OLD'); ok('old array data file still loads');
  s.child.kill(); await wait(100);

  assert.ok(!logs.includes(KEY)); ok('admin key never appears in server logs');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('all ' + n + ' API checks passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
