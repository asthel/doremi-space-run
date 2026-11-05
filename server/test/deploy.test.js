'use strict';
// Deployment-config tests: env vars, startup line, player IP behind a proxy, unwritable DATA_DIR.
// Node built-ins only. Run: node server/test/deploy.test.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..', 'server.js');
const ORIGIN = 'http://localhost:8765';
const KEY = 'deploy-' + crypto.randomBytes(12).toString('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-deploy-'));
let port = 19000 + Math.floor(Math.random() * 300);
let n = 0;
const ok = (m) => console.log('  ok', ++n, m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Start the server with exactly these env vars (plus PATH). Resolves when it prints its first line or exits.
function run(vars, as) {
  const env = { PATH: process.env.PATH };
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
  const child = spawn(process.execPath, [SERVER], Object.assign({ env, stdio: ['ignore', 'pipe', 'pipe'] }, as || {}));
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((res) => {
    const t = setTimeout(() => res({ child, out, err, code: null }), 5000);
    child.stdout.once('data', () => setTimeout(() => { clearTimeout(t); res({ child, get out() { return out; }, get err() { return err; }, code: null }); }, 50));
    child.on('exit', (code) => { clearTimeout(t); res({ child, out, err, code }); });
  });
}
async function get(p, ip, headers) {
  const r = await fetch('http://127.0.0.1:' + p + '/api/scores', { headers: Object.assign({}, ip === undefined ? {} : { 'X-Forwarded-For': ip }, headers || {}) });
  return r.status;
}

(async () => {
  // --- defaults ---
  {
    const p = ++port;
    const s = await run({ PORT: String(p), ADMIN_KEY: KEY, DATA_DIR: path.join(root, 'd0') });
    assert.strictEqual(s.code, null, s.err);
    const line = s.out.trim();
    assert.strictEqual(line.split('\n').length, 1, 'one startup line');
    assert.ok(line.includes('PORT=' + p), line);
    assert.ok(line.includes('DATA_DIR=' + path.join(root, 'd0')), line);
    assert.ok(line.includes('TRUST_PROXY=off'), line);
    assert.ok(!line.includes(KEY) && !s.err.includes(KEY)); ok('one startup line with PORT, DATA_DIR, TRUST_PROXY=off; no ADMIN_KEY in it');
    s.child.kill(); await wait(100);
  }
  {
    const s = await run({ PORT: '' , DATA_DIR: path.join(root, 'd-def') });
    assert.ok(s.out.includes('PORT=8787'), s.out + s.err); ok('PORT unset -> default 8787');
    s.child.kill(); await wait(100);
  }
  {
    const s = await run({ PORT: String(++port) });
    assert.ok(s.out.includes('DATA_DIR=' + path.join(path.dirname(SERVER), 'data')), s.out); ok('DATA_DIR unset -> default server/data (same as before)');
    s.child.kill(); await wait(100);
  }

  // --- DATA_DIR is really used, and survives restart ---
  {
    const dir = path.join(root, 'nested', 'dsr-data');
    const p = ++port;
    let s = await run({ PORT: String(p), DATA_DIR: dir, ALLOWED_ORIGIN: ORIGIN });
    const r = await fetch('http://127.0.0.1:' + p + '/api/scores', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'DIRTEST', score: 100, duration: 30000 }) });
    assert.strictEqual(r.status, 200);
    await wait(200);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'scores.json'), 'utf8'));
    assert.strictEqual(disk.entries[0].name, 'DIRTEST');
    assert.deepStrictEqual(fs.readdirSync(dir), ['scores.json']); ok('DATA_DIR (created if missing) holds scores.json, no probe/temp files left');
    s.child.kill(); await wait(100);
    s = await run({ PORT: String(p), DATA_DIR: dir });
    const top = await (await fetch('http://127.0.0.1:' + p + '/api/scores')).json();
    assert.strictEqual(top.top[0].name, 'DIRTEST'); ok('data in DATA_DIR survives restart');
    s.child.kill(); await wait(100);
  }

  // --- unwritable DATA_DIR -> clear error, exit code 1 ---
  {
    const file = path.join(root, 'not-a-folder');
    fs.writeFileSync(file, 'x');
    const s = await run({ PORT: String(++port), DATA_DIR: path.join(file, 'data'), ADMIN_KEY: KEY });
    assert.strictEqual(s.code, 1);
    assert.ok(/cannot write to DATA_DIR/.test(s.err) && s.err.includes(path.join(file, 'data')), s.err);
    assert.ok(!s.err.includes(KEY) && !s.out.includes(KEY)); ok('DATA_DIR under a file -> exit 1 with clear message (' + s.err.trim().slice(0, 60) + '...)');
    const s2 = await run({ PORT: String(++port), DATA_DIR: file });
    assert.strictEqual(s2.code, 1); assert.ok(/cannot write to DATA_DIR/.test(s2.err)); ok('DATA_DIR pointing at a file -> exit 1');
    // read-only folder: root can write anywhere, so as root run the server as the unprivileged user "nobody" (uid 65534)
    const ro = path.join(root, 'readonly');
    fs.mkdirSync(ro); fs.chmodSync(ro, 0o555); fs.chmodSync(root, 0o755);
    const asRoot = process.getuid && process.getuid() === 0;
    const s3 = await run({ PORT: String(++port), DATA_DIR: ro }, asRoot ? { uid: 65534, gid: 65534 } : null);
    assert.strictEqual(s3.code, 1, s3.out + s3.err); assert.ok(/cannot write to DATA_DIR.*EACCES/.test(s3.err), s3.err);
    ok('read-only DATA_DIR -> exit 1 with EACCES' + (asRoot ? ' (run as user nobody)' : ''));
    fs.chmodSync(ro, 0o700);
  }

  // --- TRUST_PROXY off: behavior exactly as before (header ignored, socket IP used) ---
  {
    const p = ++port;
    const s = await run({ PORT: String(p), GET_LIMIT: '2', DATA_DIR: path.join(root, 'd1') });
    const codes = [await get(p, '203.0.113.1'), await get(p, '203.0.113.2'), await get(p, '203.0.113.3')];
    assert.deepStrictEqual(codes, [200, 200, 429]); ok('TRUST_PROXY off -> X-Forwarded-For ignored; all requests share the socket IP limit');
    s.child.kill(); await wait(100);
  }

  // --- TRUST_PROXY on: per-player IP from X-Forwarded-For ---
  for (const val of ['1', 'true', 'on', 'YES']) {
    const p = ++port;
    const s = await run({ PORT: String(p), GET_LIMIT: '2', TRUST_PROXY: val, DATA_DIR: path.join(root, 'd2') });
    assert.ok(s.out.includes('TRUST_PROXY=on'), s.out);
    s.child.kill(); await wait(80);
  }
  ok('TRUST_PROXY accepts 1 / true / on / YES and the startup line says on');
  {
    const s0 = await run({ PORT: String(++port), TRUST_PROXY: 'no', DATA_DIR: path.join(root, 'd2') });
    assert.ok(s0.out.includes('TRUST_PROXY=off')); s0.child.kill(); await wait(80); ok('TRUST_PROXY=no -> off');

    const p = ++port;
    const s = await run({ PORT: String(p), GET_LIMIT: '2', TRUST_PROXY: '1', DATA_DIR: path.join(root, 'd3') });
    let c = [await get(p, '203.0.113.10'), await get(p, '203.0.113.10'), await get(p, '203.0.113.10'), await get(p, '203.0.113.11')];
    assert.deepStrictEqual(c, [200, 200, 429, 200]); ok('TRUST_PROXY on -> each player IP has its own limit (A blocked, B still ok)');

    c = [await get(p, '203.0.113.20, 10.0.0.1'), await get(p, '203.0.113.20, 10.0.0.2'), await get(p, '203.0.113.20')];
    assert.deepStrictEqual(c, [200, 200, 429]); ok('first address in the list is the player IP ("player, proxy")');

    c = [await get(p, 'unknown, 203.0.113.30'), await get(p, 'garbage, 203.0.113.30'), await get(p, '203.0.113.30')];
    assert.deepStrictEqual(c, [200, 200, 429]); ok('invalid entries skipped: first VALID address is used');

    c = [await get(p, '203.0.113.40:5555'), await get(p, '203.0.113.40:6666'), await get(p, '203.0.113.40')];
    assert.deepStrictEqual(c, [200, 200, 429]); ok('IPv4 with :port is read as the same IP');

    c = [await get(p, '[2001:DB8::7]:443'), await get(p, '2001:db8::7'), await get(p, '2001:db8::7')];
    assert.deepStrictEqual(c, [200, 200, 429]); ok('IPv6 (with brackets/port, any case) is read as the same IP');

    s.child.kill(); await wait(100);
  }
  {
    // missing or malformed header -> socket IP (all these share one bucket)
    const p = ++port;
    const s = await run({ PORT: String(p), GET_LIMIT: '3', TRUST_PROXY: '1', DATA_DIR: path.join(root, 'd4') });
    const c = [await get(p), await get(p, 'not-an-ip'), await get(p, ''), await get(p, '999.1.1.1')];
    assert.deepStrictEqual(c, [200, 200, 200, 429]); ok('TRUST_PROXY on + header missing/empty/malformed -> falls back to the socket IP');
    const c2 = await get(p, '203.0.113.50'); assert.strictEqual(c2, 200); ok('a valid header still gets its own limit after that');
    s.child.kill(); await wait(100);
  }
  {
    // the PIN brute-force limit also follows the player IP when TRUST_PROXY is on
    const p = ++port;
    const dir = path.join(root, 'd5');
    const s = await run({ PORT: String(p), TRUST_PROXY: '1', ADMIN_KEY: KEY, ALLOWED_ORIGIN: ORIGIN, POST_LIMIT: '100', DATA_DIR: dir });
    const base = 'http://127.0.0.1:' + p;
    let r = await fetch(base + '/api/admin/reserve', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'DEX', pin: '482915' }) });
    assert.strictEqual(r.status, 200);
    const post = (ip, pin) => fetch(base + '/api/scores', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ name: 'DEX', score: 100, duration: 30000, pin }) }).then((x) => x.status);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(await post('198.51.100.1', '00000' + i));
    codes.push(await post('198.51.100.2', '482915'));
    assert.deepStrictEqual(codes, [403, 403, 403, 403, 403, 429, 200]); ok('wrong-PIN limit applies per player IP; another player is not locked out');
    const disk = fs.readFileSync(path.join(dir, 'scores.json'), 'utf8');
    assert.ok(!disk.includes('198.51.100')); ok('player IPs from the header are not written to disk');
    s.child.kill(); await wait(100);
  }

  // --- PORT as a non-number (socket path) ---
  {
    const sock = path.join(root, 'app.sock');
    const s = await run({ PORT: sock, DATA_DIR: path.join(root, 'd6') });
    assert.strictEqual(s.code, null, s.err);
    assert.ok(s.out.includes('PORT=' + sock), s.out);
    const status = await new Promise((res) => {
      require('http').get({ socketPath: sock, path: '/api/health' }, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0));
    });
    assert.strictEqual(status, 200); ok('non-numeric PORT is used as a socket path (works)');
    s.child.kill(); await wait(100);
  }

  // --- port already in use -> clear error ---
  {
    const p = ++port;
    const a = await run({ PORT: String(p), DATA_DIR: path.join(root, 'd7') });
    const b = await run({ PORT: String(p), DATA_DIR: path.join(root, 'd7') });
    assert.strictEqual(b.code, 1); assert.ok(/cannot listen on PORT/.test(b.err), b.err); ok('PORT already in use -> exit 1 with clear message');
    a.child.kill(); await wait(100);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('all ' + n + ' deploy checks passed');
})().catch((e) => { console.error('FAIL', e.stack || e.message); fs.rmSync(root, { recursive: true, force: true }); process.exit(1); });
