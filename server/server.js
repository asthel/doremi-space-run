'use strict';
/*
 * Doremi Space Run: public leaderboard API + admin moderation.
 * Single entry file, Node.js built-ins only (no npm install needed).
 * Side files: admin.html (admin page), blocklist.json (editable word list).
 *
 * Public:
 *   GET  /api/scores                 -> top 20 as JSON (hidden names left out)
 *   POST /api/scores                 <- {name, score, duration, pin?}   (duration = play time in ms)
 *   GET  /api/health                 -> {ok:true}
 * Admin (header "Authorization: Bearer <ADMIN_KEY>"; 503 if ADMIN_KEY is not set):
 *   GET    /admin                    -> admin page
 *   GET    /api/admin/scores         -> {entries:[{name,score,hidden}], blocked:[{type,value}], reserved:[names]}
 *   DELETE /api/admin/scores/:name
 *   POST   /api/admin/block          <- {name} (blocks that exact name) or {word} (blocks names containing it)
 *   DELETE /api/admin/block/:item
 *   POST   /api/admin/reserve        <- {name, pin}
 *   DELETE /api/admin/reserve/:name
 *
 * Config (environment variables):
 *   PORT              port to listen on (default 8787). A non-numeric value is used as a socket/pipe path.
 *   ALLOWED_ORIGIN    comma-separated origins allowed by CORS, e.g. https://bakkufest.com
 *   ADMIN_KEY         admin password, at least 16 characters. Never put it in code or in git.
 *   DATA_DIR          folder for the data file scores.json (scores, blocks, PIN hashes).
 *                     Default: ./data next to this file. Must be writable, or the app stops at startup.
 *   DATA_FILE         (older option) full path to the JSON store; if set, it wins over DATA_DIR
 *   BLOCKLIST_FILE    path to the word list (default ./blocklist.json next to this file)
 *   TRUST_PROXY       off by default. "1", "true", "yes" or "on" = read the player IP from X-Forwarded-For
 *                     (first valid IP address in it); if the header is missing or has no valid IP,
 *                     the connection's own IP is used. Turn on only behind a proxy you trust.
 *   MAX_PPS           max points per second of play time (default 1500)
 *   SCORE_GRACE       points allowed on top of MAX_PPS * seconds (default 5000)
 *   POST_LIMIT        max POSTs per IP per window (default 6)
 *   GET_LIMIT         max GETs per IP per window (default 60)
 *   RATE_WINDOW_MS    rate-limit window (default 60000)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

function portFrom(v) {
  if (v === undefined || String(v).trim() === '') return 8787;
  const t = String(v).trim();
  if (/^\d+$/.test(t)) return Number(t);
  return t; // some hosts hand the app a socket/pipe path instead of a number
}
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const DATA_DIR = path.resolve(env.DATA_FILE ? path.dirname(env.DATA_FILE) : (env.DATA_DIR && env.DATA_DIR.trim()) || path.join(__dirname, 'data'));

const CFG = {
  port: portFrom(env.PORT),
  origins: (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
  dataFile: env.DATA_FILE ? path.resolve(env.DATA_FILE) : path.join(DATA_DIR, 'scores.json'),
  blocklistFile: env.BLOCKLIST_FILE || path.join(__dirname, 'blocklist.json'),
  trustProxy: truthy(env.TRUST_PROXY),
  maxPps: num(env.MAX_PPS, 1500),
  grace: num(env.SCORE_GRACE, 5000),
  postLimit: num(env.POST_LIMIT, 6),
  getLimit: num(env.GET_LIMIT, 60),
  windowMs: num(env.RATE_WINDOW_MS, 60000),
};
// The key is kept only as a SHA-256 digest in memory and is never printed.
const ADMIN_KEY_MIN = 16;
const adminDigest = env.ADMIN_KEY && env.ADMIN_KEY.length >= ADMIN_KEY_MIN
  ? crypto.createHash('sha256').update(env.ADMIN_KEY, 'utf8').digest() : null;
const adminKeyTooShort = !!env.ADMIN_KEY && !adminDigest;

const TOP_N = 20;
const KEEP_N = 1000; // entries kept on disk (one per name)
const MAX_SCORE = 9999999;
const MIN_DURATION = 3000; // ms
const MAX_DURATION = 6 * 3600 * 1000; // ms
const NAME_RE = /^[A-Z0-9]{1,10}$/;
const ITEM_RE = /^[A-Z0-9]{1,20}$/;
const PIN_RE = /^[0-9]{6,12}$/;
const MAX_BODY = 1024; // bytes
const AUTH_FAIL_MAX = 5, AUTH_FAIL_WINDOW = 10 * 60 * 1000;
const PIN_FAIL_MAX = 5, PIN_FAIL_WINDOW = 10 * 60 * 1000;
const NOT_ALLOWED_MSG = 'Ese nombre no está permitido';

/* ---------- name normalization + filter ---------- */
const LEET = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
function baseNorm(s) {
  s = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return s.replace(/[034570@$]/g, (c) => LEET[c] || c);
}
const collapse = (s) => s.replace(/(.)\1+/g, '$1');
// All spellings a name can stand for: "1" may be an i or an l; with and without repeated letters; with and without leftover symbols/digits.
function variants(name) {
  const b = baseNorm(name);
  const out = new Set();
  for (const one of ['i', 'l']) {
    const v = b.replace(/1/g, one);
    const letters = v.replace(/[^a-z]/g, '');
    [v, letters, collapse(v), collapse(letters)].forEach((x) => x && out.add(x));
  }
  return [...out];
}
function wordForms(word) {
  const w = baseNorm(word).replace(/1/g, 'i').replace(/[^a-z]/g, '');
  const c = collapse(w);
  const forms = new Set([w]);
  if (c.length >= 3) forms.add(c); // "kkk" -> "k" would block everything with a K
  return [...forms].filter(Boolean);
}

let baseWords = { contains: [], exact: [] };
function loadBlocklist() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG.blocklistFile, 'utf8'));
    baseWords = {
      contains: (Array.isArray(raw.contains) ? raw.contains : []).filter((w) => typeof w === 'string'),
      exact: (Array.isArray(raw.exact) ? raw.exact : []).filter((w) => typeof w === 'string'),
    };
  } catch (e) {
    console.error('[dsr] could not read blocklist file, filter uses admin entries only:', e.message);
    baseWords = { contains: [], exact: [] };
  }
}
function matches(name, contains, exact) {
  const vs = variants(name);
  for (const w of contains) for (const f of wordForms(w)) if (vs.some((v) => v.includes(f))) return true;
  // exact words: compare with the word as written only (collapsing 'piss' to 'pis' would block P15)
  for (const w of exact) { const f = wordForms(w)[0]; if (f && vs.some((v) => v === f)) return true; }
  return false;
}
function notAllowed(name) {
  const contains = baseWords.contains.concat(store.blocked.filter((b) => b.type === 'word').map((b) => b.value));
  const exact = baseWords.exact.concat(store.blocked.filter((b) => b.type === 'name').map((b) => b.value));
  return matches(name, contains, exact);
}
// A reserved name also covers look-alikes: DEX protects D3X, DEXX, DÉX...
function reservedFor(name) {
  const k = new Set(variants(name));
  return Object.keys(store.reserved).find((r) => r === name || variants(r).some((v) => k.has(v))) || null;
}

/* ---------- storage (atomic writes) ---------- */
// store = {entries:[{name,score,t}], blocked:[{type:'name'|'word', value}], reserved:{NAME:{salt,hash}}}
let store = { entries: [], blocked: [], reserved: {} };

function load() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(CFG.dataFile, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[dsr] could not read data file, starting empty:', e.message);
  }
  if (Array.isArray(raw)) raw = { entries: raw }; // older format: just the entries
  raw = raw && typeof raw === 'object' ? raw : {};
  store.entries = (Array.isArray(raw.entries) ? raw.entries : []).filter((e) => e && NAME_RE.test(e.name) && Number.isInteger(e.score) && e.score >= 1 && e.score <= MAX_SCORE);
  store.blocked = (Array.isArray(raw.blocked) ? raw.blocked : []).filter((b) => b && (b.type === 'name' || b.type === 'word') && ITEM_RE.test(b.value));
  store.reserved = {};
  if (raw.reserved && typeof raw.reserved === 'object') {
    for (const [k, v] of Object.entries(raw.reserved)) if (NAME_RE.test(k) && v && typeof v.salt === 'string' && typeof v.hash === 'string') store.reserved[k] = { salt: v.salt, hash: v.hash };
  }
  sortEntries();
}

function sortEntries() {
  // Higher score first; on a tie, whoever got there first.
  store.entries.sort((a, b) => b.score - a.score || a.t - b.t);
  if (store.entries.length > KEEP_N) store.entries.length = KEEP_N;
}

let writing = false;
let pendingWrite = false;
let dirty = false; // true until the latest change is on disk
function save() {
  dirty = true;
  if (writing) { pendingWrite = true; return; }
  writing = true;
  const dir = path.dirname(CFG.dataFile);
  const tmp = CFG.dataFile + '.' + process.pid + '.tmp';
  const data = JSON.stringify(store);
  fs.mkdir(dir, { recursive: true }, (err) => {
    if (err) return done(err);
    fs.open(tmp, 'w', 0o600, (err, fd) => {
      if (err) return done(err);
      fs.write(fd, data, (err) => {
        if (err) return fs.close(fd, () => done(err));
        fs.fsync(fd, (err) => {
          fs.close(fd, (err2) => {
            if (err || err2) return done(err || err2);
            fs.rename(tmp, CFG.dataFile, done); // rename is atomic on the same filesystem
          });
        });
      });
    });
  });
  function done(err) {
    if (err) console.error('[dsr] write failed:', err.message);
    writing = false;
    if (pendingWrite) { pendingWrite = false; save(); } else if (!err) dirty = false;
  }
}
// On stop/restart (SIGTERM, Ctrl+C), write any unsaved change before exiting.
function flushSync() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(CFG.dataFile), { recursive: true });
    const tmp = CFG.dataFile + '.' + process.pid + '.exit.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, JSON.stringify(store)); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(tmp, CFG.dataFile);
    dirty = false;
  } catch (e) { console.error('[dsr] final write failed:', e.message); }
}
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => { flushSync(); process.exit(0); }));

function visible() { return store.entries.filter((e) => !notAllowed(e.name)); }
function top() {
  return visible().slice(0, TOP_N).map((e, i) => ({ rank: i + 1, name: e.name, score: e.score }));
}

/* ---------- PINs (scrypt, salted) ---------- */
function hashPin(pin, saltB64, cb) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  crypto.scrypt(pin, salt, 32, (err, key) => cb(err, { salt: salt.toString('base64'), hash: key ? key.toString('base64') : '' }));
}
function checkPin(pin, rec, cb) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) return cb(false);
  hashPin(pin, rec.salt, (err, h) => {
    if (err) return cb(false);
    const a = Buffer.from(h.hash, 'base64'), b = Buffer.from(rec.hash, 'base64');
    cb(a.length === b.length && crypto.timingSafeEqual(a, b));
  });
}

/* ---------- rate limiting (in memory only, never written to disk) ---------- */
const hits = new Map(); // key -> [timestamps]
function count(key, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  hits.set(key, arr);
  return arr;
}
function limited(key, max, windowMs) {
  const arr = count(key, windowMs || CFG.windowMs);
  if (arr.length >= max) return true;
  arr.push(Date.now());
  return false;
}
const tooManyFails = (key, max, windowMs) => count(key, windowMs).length >= max;
const addFail = (key, windowMs) => count(key, windowMs).push(Date.now());
const LONGEST = Math.max(CFG.windowMs, AUTH_FAIL_WINDOW, PIN_FAIL_WINDOW);
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.length || now - arr[arr.length - 1] >= LONGEST) hits.delete(k);
}, 60000).unref();

// One entry of X-Forwarded-For -> plain IP, or null. Accepts "1.2.3.4", "1.2.3.4:5678", "2001:db8::1", "[2001:db8::1]:443".
function ipFromEntry(raw) {
  let s = String(raw || '').trim().replace(/^"|"$/g, '');
  if (!s) return null;
  let m = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (m) s = m[1];
  else if ((m = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s))) s = m[1];
  return net.isIP(s) ? s.toLowerCase() : null;
}
function ipFromForwarded(header) {
  if (header === undefined || header === null) return null;
  const list = Array.isArray(header) ? header.join(',') : String(header);
  if (list.length > 2048) return null;
  for (const part of list.split(',')) { const ip = ipFromEntry(part); if (ip) return ip; }
  return null;
}
function clientIp(req) {
  const own = req.socket.remoteAddress || 'unknown';
  if (!CFG.trustProxy) return own; // same as before: the connection's IP
  return ipFromForwarded(req.headers['x-forwarded-for']) || own;
}

/* ---------- validation ---------- */
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const { name, score, duration } = body;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return 'name must be 1-10 characters A-Z 0-9';
  if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) return 'score must be an integer 1-9999999';
  if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) return 'duration must be an integer in ms (3000-21600000)';
  const cap = CFG.grace + CFG.maxPps * (duration / 1000);
  if (score > cap) return 'score not plausible for that play time';
  return null;
}

/* ---------- http helpers ---------- */
function cors(req, res) {
  const origin = req.headers.origin;
  const ok = !!origin && CFG.origins.includes(origin);
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); // no Authorization: admin calls are same-origin only
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return ok;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BODY) { aborted = true; cb(new Error('too large')); req.resume(); return; }
    chunks.push(c);
  });
  req.on('end', () => { if (!aborted) cb(null, Buffer.concat(chunks).toString('utf8')); });
  req.on('error', (e) => { if (!aborted) { aborted = true; cb(e); } });
}
function readJson(req, res, cb) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'content-type must be application/json' });
  readBody(req, (err, raw) => {
    if (err) return send(res, 413, { error: 'body too large' });
    let body;
    try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'body must be a JSON object' });
    cb(body);
  });
}
const cleanItem = (s) => (typeof s === 'string' ? s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim() : '');

/* ---------- admin ---------- */
let adminPage = null;
function getAdminPage() {
  if (adminPage === null) {
    try { adminPage = fs.readFileSync(path.join(__dirname, 'admin.html')); } catch (e) { adminPage = Buffer.from('admin.html missing'); }
  }
  return adminPage;
}

function adminAuth(req, res, ip) {
  if (!adminDigest) { send(res, 503, { error: 'admin disabled: ADMIN_KEY is not set on the server' }); return false; }
  const fkey = 'af:' + ip;
  if (tooManyFails(fkey, AUTH_FAIL_MAX, AUTH_FAIL_WINDOW)) { send(res, 429, { error: 'too many failed attempts, try again later' }); return false; }
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const given = crypto.createHash('sha256').update(m ? m[1] : '', 'utf8').digest();
  if (!crypto.timingSafeEqual(given, adminDigest)) { // equal-length digests: constant-time compare
    addFail(fkey, AUTH_FAIL_WINDOW);
    send(res, 401, { error: 'wrong key' });
    return false;
  }
  return true;
}

function adminState() {
  return {
    entries: store.entries.map((e) => ({ name: e.name, score: e.score, hidden: notAllowed(e.name) })),
    blocked: store.blocked.slice(),
    reserved: Object.keys(store.reserved).sort(),
    baseWords: baseWords.contains.length + baseWords.exact.length,
  };
}

function handleAdmin(req, res, url, ip) {
  if (!adminAuth(req, res, ip)) return;
  const parts = url.split('/').slice(3); // ['scores', ':name'] etc.
  let arg = null;
  if (parts[1] !== undefined) { try { arg = cleanItem(decodeURIComponent(parts[1])); } catch (e) { return send(res, 400, { error: 'bad name in URL' }); } }
  const what = parts[0];
  if (parts.length > 2) return send(res, 404, { error: 'not found' });

  if (what === 'scores' && req.method === 'GET' && arg === null) return send(res, 200, adminState());

  if (what === 'scores' && req.method === 'DELETE' && arg !== null) {
    const i = store.entries.findIndex((e) => e.name === arg);
    if (i < 0) return send(res, 404, { error: 'no score with that name' });
    store.entries.splice(i, 1); save();
    return send(res, 200, Object.assign({ ok: true }, adminState()));
  }

  if (what === 'block' && req.method === 'POST' && arg === null) {
    return readJson(req, res, (body) => {
      const type = typeof body.name === 'string' ? 'name' : typeof body.word === 'string' ? 'word' : null;
      const value = cleanItem(type === 'name' ? body.name : body.word);
      if (!type || !ITEM_RE.test(value)) return send(res, 400, { error: 'send {name} or {word}: 1-20 characters A-Z 0-9' });
      if (!store.blocked.some((b) => b.value === value && b.type === type)) { store.blocked.push({ type, value }); save(); }
      return send(res, 200, Object.assign({ ok: true }, adminState()));
    });
  }

  if (what === 'block' && req.method === 'DELETE' && arg !== null) {
    const before = store.blocked.length;
    store.blocked = store.blocked.filter((b) => b.value !== arg);
    if (store.blocked.length === before) return send(res, 404, { error: 'not in the blocklist' });
    save();
    return send(res, 200, Object.assign({ ok: true }, adminState()));
  }

  if (what === 'reserve' && req.method === 'POST' && arg === null) {
    return readJson(req, res, (body) => {
      const name = cleanItem(body.name);
      if (!NAME_RE.test(name)) return send(res, 400, { error: 'name must be 1-10 characters A-Z 0-9' });
      if (typeof body.pin !== 'string' || !PIN_RE.test(body.pin)) return send(res, 400, { error: 'pin must be 6-12 digits' });
      const other = reservedFor(name);
      if (other && other !== name) return send(res, 409, { error: 'too similar to reserved name ' + other });
      hashPin(body.pin, null, (err, h) => {
        if (err) return send(res, 500, { error: 'could not hash pin' });
        store.reserved[name] = h; save();
        return send(res, 200, Object.assign({ ok: true }, adminState()));
      });
    });
  }

  if (what === 'reserve' && req.method === 'DELETE' && arg !== null) {
    if (!store.reserved[arg]) return send(res, 404, { error: 'not reserved' });
    delete store.reserved[arg]; save();
    return send(res, 200, Object.assign({ ok: true }, adminState()));
  }

  return send(res, 404, { error: 'not found' });
}

/* ---------- public score submit ---------- */
function handleSubmit(req, res, ip) {
  readJson(req, res, (body) => {
    const problem = validate(body);
    if (problem) return send(res, 400, { error: problem });
    const { name, score } = body;
    if (notAllowed(name)) return send(res, 400, { error: 'name not allowed', notAllowed: true, message: NOT_ALLOWED_MSG });

    const owner = reservedFor(name);
    if (!owner) return accept();
    if (body.pin === undefined || body.pin === '') return send(res, 403, { error: 'reserved name: PIN required', reserved: true });
    const pkey = 'pf:' + ip;
    if (tooManyFails(pkey, PIN_FAIL_MAX, PIN_FAIL_WINDOW)) return send(res, 429, { error: 'too many wrong PINs, try again later', reserved: true });
    return checkPin(body.pin, store.reserved[owner], (good) => {
      if (!good) { addFail(pkey, PIN_FAIL_WINDOW); return send(res, 403, { error: 'wrong PIN', reserved: true, badPin: true }); }
      accept();
    });

    function accept() {
      const cur = store.entries.find((e) => e.name === name);
      let improved = false;
      if (!cur) { store.entries.push({ name, score, t: Date.now() }); improved = true; }
      else if (score > cur.score) { cur.score = score; cur.t = Date.now(); improved = true; }
      if (improved) { sortEntries(); save(); }
      const vis = visible();
      const idx = vis.findIndex((e) => e.name === name);
      const mine = store.entries.find((e) => e.name === name);
      send(res, 200, { ok: true, improved, best: mine ? mine.score : score, rank: idx >= 0 ? idx + 1 : null, top: top() });
    }
  });
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const originOk = cors(req, res);
  const ip = clientIp(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(originOk ? 204 : 403);
    return res.end();
  }

  if (url === '/admin' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    return res.end(getAdminPage());
  }

  if (url.startsWith('/api/admin/')) return handleAdmin(req, res, url, ip);

  if (url === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });

  if (url !== '/api/scores') return send(res, 404, { error: 'not found' });

  if (req.method === 'GET') {
    if (limited('g:' + ip, CFG.getLimit)) return send(res, 429, { error: 'too many requests' });
    return send(res, 200, { top: top() });
  }

  if (req.method === 'POST') {
    if (!originOk) return send(res, 403, { error: 'origin not allowed' });
    if (limited('p:' + ip, CFG.postLimit)) return send(res, 429, { error: 'too many requests' });
    return handleSubmit(req, res, ip);
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return send(res, 405, { error: 'method not allowed' });
});

// Stop right away, with a clear message, if the data folder cannot be written.
function checkDataDir() {
  const dir = path.dirname(CFG.dataFile);
  const probe = path.join(dir, '.write-test-' + process.pid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    console.error('[dsr] ERROR: cannot write to DATA_DIR "' + dir + '" (' + (e.code || e.message) + '). ' +
      'Create that folder, give the app permission to write there, or set DATA_DIR to a writable folder. Not starting.');
    process.exit(1);
  }
}

checkDataDir();
loadBlocklist();
load();
server.on('error', (e) => {
  console.error('[dsr] ERROR: cannot listen on PORT ' + CFG.port + ' (' + (e.code || e.message) + '). Not starting.');
  process.exit(1);
});
server.listen(CFG.port, () => {
  const a = server.address();
  const port = a && typeof a === 'object' ? a.port : a;
  console.log('[dsr] started: PORT=' + port + ' DATA_DIR=' + path.dirname(CFG.dataFile) + ' TRUST_PROXY=' + (CFG.trustProxy ? 'on' : 'off') +
    ' ALLOWED_ORIGIN=' + (CFG.origins.join(',') || '(none: POST disabled)') +
    ' ADMIN=' + (adminDigest ? 'enabled' : adminKeyTooShort ? 'DISABLED (ADMIN_KEY shorter than ' + ADMIN_KEY_MIN + ' characters)' : 'disabled (ADMIN_KEY not set)'));
});
