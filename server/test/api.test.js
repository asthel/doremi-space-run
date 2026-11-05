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

function start(extra) {
  const p = ++port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(p), ALLOWED_ORIGIN: ORIGIN, DATA_FILE: DATA }, extra || {}),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((res) => child.stdout.once('data', () => res({ child, base: 'http://127.0.0.1:' + p })));
}
async function req(base, method, body, headers) {
  const h = Object.assign({ Origin: ORIGIN }, body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers || {});
  const r = await fetch(base + '/api/scores', { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j, h: r.headers };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
  assert.strictEqual(disk.length, 27); assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))); ok('data file is valid JSON, no temp files left');
  s.child.kill(); await wait(100);

  s = await start({ POST_LIMIT: '3' });
  r = await req(s.base, 'GET'); assert.strictEqual(r.j.top[0].name, 'DEX'); ok('data persists across restart');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await req(s.base, 'POST', { name: 'RL' + i, score: 10, duration: 30000 })).status);
  assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]); ok('rate limit per IP -> 429 after 3 POSTs');
  s.child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('all ' + n + ' API checks passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
