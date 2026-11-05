'use strict';
/*
 * Doremi Space Run: public leaderboard API.
 * Single file, Node.js built-ins only (no npm install needed).
 *
 *   GET  /api/scores   -> top 20 as JSON
 *   POST /api/scores   <- {name, score, duration}   (duration = play time in ms)
 *   GET  /api/health   -> {ok:true}
 *
 * Config (environment variables):
 *   PORT              port to listen on (default 8787)
 *   ALLOWED_ORIGIN    comma-separated origins allowed by CORS, e.g. https://bakkufest.com
 *   DATA_FILE         path to the JSON store (default ./data/scores.json next to this file)
 *   TRUST_PROXY       "1" to read the client IP from X-Forwarded-For (only behind a proxy you trust)
 *   MAX_PPS           max points per second of play time (default 1500)
 *   SCORE_GRACE       points allowed on top of MAX_PPS * seconds (default 5000)
 *   POST_LIMIT        max POSTs per IP per window (default 6)
 *   GET_LIMIT         max GETs per IP per window (default 60)
 *   RATE_WINDOW_MS    rate-limit window (default 60000)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

const CFG = {
  port: num(env.PORT, 8787),
  origins: (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
  dataFile: env.DATA_FILE || path.join(__dirname, 'data', 'scores.json'),
  trustProxy: env.TRUST_PROXY === '1',
  maxPps: num(env.MAX_PPS, 1500),
  grace: num(env.SCORE_GRACE, 5000),
  postLimit: num(env.POST_LIMIT, 6),
  getLimit: num(env.GET_LIMIT, 60),
  windowMs: num(env.RATE_WINDOW_MS, 60000),
};

const TOP_N = 20;
const KEEP_N = 1000; // entries kept on disk (one per name)
const MAX_SCORE = 9999999;
const MIN_DURATION = 3000; // ms
const MAX_DURATION = 6 * 3600 * 1000; // ms
const NAME_RE = /^[A-Z0-9]{1,10}$/;
const MAX_BODY = 1024; // bytes

/* ---------- storage (atomic writes) ---------- */
let entries = []; // [{name, score, t}]

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG.dataFile, 'utf8'));
    if (Array.isArray(raw)) {
      entries = raw.filter((e) => e && NAME_RE.test(e.name) && Number.isInteger(e.score) && e.score >= 1 && e.score <= MAX_SCORE);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[dsr] could not read data file, starting empty:', e.message);
    entries = [];
  }
  sortEntries();
}

function sortEntries() {
  // Higher score first; on a tie, whoever got there first.
  entries.sort((a, b) => b.score - a.score || a.t - b.t);
  if (entries.length > KEEP_N) entries.length = KEEP_N;
}

let writing = false;
let pendingWrite = false;
function save() {
  if (writing) { pendingWrite = true; return; }
  writing = true;
  const dir = path.dirname(CFG.dataFile);
  const tmp = CFG.dataFile + '.' + process.pid + '.tmp';
  const data = JSON.stringify(entries);
  fs.mkdir(dir, { recursive: true }, (err) => {
    if (err) return done(err);
    fs.open(tmp, 'w', (err, fd) => {
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
    if (pendingWrite) { pendingWrite = false; save(); }
  }
}

function top() {
  return entries.slice(0, TOP_N).map((e, i) => ({ rank: i + 1, name: e.name, score: e.score }));
}

/* ---------- rate limiting (in memory, per IP) ---------- */
const hits = new Map(); // key -> [timestamps]
function limited(key, max) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < CFG.windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.length || now - arr[arr.length - 1] >= CFG.windowMs) hits.delete(k);
}, CFG.windowMs).unref();

function clientIp(req) {
  if (CFG.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
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

/* ---------- http ---------- */
function cors(req, res) {
  const origin = req.headers.origin;
  const ok = !!origin && CFG.origins.includes(origin);
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const originOk = cors(req, res);
  const ip = clientIp(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(originOk ? 204 : 403);
    return res.end();
  }

  if (url === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });

  if (url !== '/api/scores') return send(res, 404, { error: 'not found' });

  if (req.method === 'GET') {
    if (limited('g:' + ip, CFG.getLimit)) return send(res, 429, { error: 'too many requests' });
    return send(res, 200, { top: top() });
  }

  if (req.method === 'POST') {
    if (!originOk) return send(res, 403, { error: 'origin not allowed' });
    if (limited('p:' + ip, CFG.postLimit)) return send(res, 429, { error: 'too many requests' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'content-type must be application/json' });
    return readBody(req, (err, raw) => {
      if (err) return send(res, 413, { error: 'body too large' });
      let body;
      try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'invalid JSON' }); }
      const problem = validate(body);
      if (problem) return send(res, 400, { error: problem });

      const { name, score } = body;
      const cur = entries.find((e) => e.name === name);
      let improved = false;
      if (!cur) { entries.push({ name, score, t: Date.now() }); improved = true; }
      else if (score > cur.score) { cur.score = score; cur.t = Date.now(); improved = true; }
      if (improved) { sortEntries(); save(); }
      const idx = entries.findIndex((e) => e.name === name);
      return send(res, 200, {
        ok: true,
        improved,
        best: idx >= 0 ? entries[idx].score : score,
        rank: idx >= 0 ? idx + 1 : null,
        top: top(),
      });
    });
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return send(res, 405, { error: 'method not allowed' });
});

load();
server.listen(CFG.port, () => {
  console.log('[dsr] leaderboard listening on port ' + CFG.port + '; allowed origins: ' + (CFG.origins.join(', ') || '(none: POST disabled)'));
});
