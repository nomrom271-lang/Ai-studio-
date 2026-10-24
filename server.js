'use strict';
/**
 * PDF Studio AI — server (zero framework, only Node built-ins + pdf-lib + playwright)
 *   GET  /healthz
 *   GET  /api/config
 *   POST /api/check          (password check)
 *   POST /api/chat           (SSE stream, Gemini)
 *   POST /api/pdf/render     (HTML -> PDF)
 *   POST /api/pdf/tool       (merge / split / rotate / watermark ...)
 *   POST /api/pdf/info
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

/* ---- tiny .env loader (local use; on Render use the Environment tab) ---- */
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* ignore */ }
})();

const { streamChat, getKey, getModels } = require('./lib/gemini');
const { buildSystemPrompt, buildTaskPrompt, publicLists } = require('./lib/prompt');
const pdf = require('./lib/pdf');
const images = require('./lib/images');
const runner = require('./lib/runner');

const PORT = parseInt(process.env.PORT || '3000', 10);
const APP_NAME = process.env.APP_NAME || 'PDF Studio AI';
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ----------------------------------------------------------- helpers */

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'ip';
}

function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (ip) => {
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(ip, h); }
    h.n++;
    return h.n <= max;
  };
}
const chatLimit = makeLimiter(parseInt(process.env.CHAT_PER_MIN || '40', 10), 60 * 1000);
const pdfLimit = makeLimiter(parseInt(process.env.PDF_PER_MIN || '40', 10), 60 * 1000);
const authFailLimit = makeLimiter(10, 5 * 60 * 1000);
const runLimit = makeLimiter(parseInt(process.env.RUN_PER_MIN || '15', 10), 60 * 1000);

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function isAuthed(req) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true;
  return crypto.timingSafeEqual(sha(req.headers['x-app-password'] || ''), sha(pw));
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('File/data bahut bada hai.'), { userMessage: 'File/data bahut bada hai (limit ' + Math.round(limit / 1048576) + ' MB).', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch {
    throw Object.assign(new Error('bad json'), { userMessage: 'Request ka format galat hai.', status: 400 });
  }
}

function b64ToBuf(s) {
  const clean = String(s || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(clean, 'base64');
}

/* ----------------------------------------------------------- static files */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.wasm': 'application/wasm'
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest', '.txt']);
const gzCache = new Map();

function findPackageDir(name) {
  let paths = [];
  try { paths = require.resolve.paths(name) || []; } catch { /* ignore */ }
  paths = [path.join(__dirname, 'node_modules'), ...paths];
  for (const p of paths) {
    const dir = path.join(p, name);
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

// URL -> real file (libraries are served straight from node_modules, nothing to copy)
const VENDOR_FILES = {
  '/vendor/marked.min.js': ['marked', ['marked.min.js', 'lib/marked.umd.js']],
  '/vendor/purify.min.js': ['dompurify', ['dist/purify.min.js']]
};
const VENDOR_DIRS = {
  '/vendor/pdfjs/': ['pdfjs-dist', 'build'],
  '/vendor/pdfjs-legacy/': ['pdfjs-dist', 'legacy/build']
};

function resolveStatic(pathname) {
  if (VENDOR_FILES[pathname]) {
    const [pkg, candidates] = VENDOR_FILES[pathname];
    const dir = findPackageDir(pkg);
    if (!dir) return null;
    for (const c of candidates) {
      const f = path.join(dir, c);
      if (fs.existsSync(f)) return { file: f, vendor: true };
    }
    return null;
  }
  for (const prefix of Object.keys(VENDOR_DIRS)) {
    if (pathname.startsWith(prefix)) {
      const [pkg, sub] = VENDOR_DIRS[prefix];
      const dir = findPackageDir(pkg);
      if (!dir) return null;
      const root = path.join(dir, sub);
      const f = path.join(root, pathname.slice(prefix.length));
      if (!f.startsWith(root + path.sep)) return null;
      return fs.existsSync(f) && fs.statSync(f).isFile() ? { file: f, vendor: true } : null;
    }
  }
  let rel = pathname === '/' ? '/index.html' : pathname;
  const f = path.join(PUBLIC_DIR, decodeURIComponent(rel));
  if (!f.startsWith(PUBLIC_DIR + path.sep)) return null;
  return fs.existsSync(f) && fs.statSync(f).isFile() ? { file: f, vendor: false } : null;
}

function serveStatic(req, res, pathname) {
  let r;
  try { r = resolveStatic(pathname); } catch { r = null; }
  if (!r) {
    // SPA-ish fallback for navigations; real 404 for assets
    if (!path.extname(pathname)) { r = resolveStatic('/'); }
    if (!r) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not found'); }
  }
  const ext = path.extname(r.file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(r.file);
  const headers = {
    'Content-Type': type,
    'Cache-Control': r.vendor ? 'public, max-age=86400' : 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  };
  const wantsGz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && COMPRESSIBLE.has(ext) && stat.size > 1024;
  if (wantsGz) {
    const key = r.file + ':' + stat.mtimeMs;
    let gz = gzCache.get(key);
    if (!gz) { gz = zlib.gzipSync(fs.readFileSync(r.file), { level: 6 }); gzCache.set(key, gz); }
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    headers['Content-Length'] = gz.length;
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : gz);
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(r.file).pipe(res);
}

/* ----------------------------------------------------------- API handlers */

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw.slice(-24)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const msg = { role: m.role, text: typeof m.text === 'string' ? m.text.slice(0, 400000) : '' };
    if (Array.isArray(m.attachments)) {
      msg.attachments = m.attachments.slice(0, 6).map(a => {
        if (a && typeof a.data === 'string' && typeof a.mime === 'string') return { mime: a.mime.slice(0, 80), data: a.data };
        if (a && typeof a.text === 'string') return { name: String(a.name || 'file').slice(0, 120), text: a.text.slice(0, 400000) };
        return null;
      }).filter(Boolean);
    }
    out.push(msg);
  }
  return out;
}

async function handleChat(req, res) {
  if (!chatLimit(clientIp(req))) return sendJson(res, 429, { error: 'Bahut zyada requests. 1 minute ruk kar try karo.' });
  const body = await readJson(req, 45 * 1048576);
  const messages = cleanMessages(body.messages);
  if (!messages.length) return sendJson(res, 400, { error: 'Kuch likho ya file attach karo.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (o) => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 12000);

  try {
    const task = ['outline', 'book1', 'bookN'].includes(body.task) ? body.task : '';
    const system = task
      ? buildTaskPrompt(task, { style: body.style, lang: typeof body.lang === 'string' ? body.lang.slice(0, 40) : '', per: Math.min(12, Math.max(4, parseInt(body.per, 10) || 8)) })
      : buildSystemPrompt({ mood: body.mood, style: body.style, search: !!body.search, appName: APP_NAME });
    await streamChat({
      messages, system, search: task ? false : !!body.search, signal: ac.signal,
      onText: (t) => send({ t }),
      onModel: (m) => send({ model: m }),
      onSources: (s) => send({ sources: s })
    });
  } catch (e) {
    if (!ac.signal.aborted) {
      console.error('[chat]', e.status || '', e.message, e.detail || '');
      send({ err: e.userMessage || 'Kuch gadbad ho gayi. Dobara try karo.' });
    }
  } finally {
    clearInterval(hb);
    send({ done: true });
    res.end();
  }
}

async function handleRender(req, res) {
  if (!pdfLimit(clientIp(req))) return sendJson(res, 429, { error: 'Bahut zyada PDF requests. Thodi der ruko.' });
  const body = await readJson(req, 45 * 1048576);
  const html = typeof body.html === 'string' ? body.html : '';
  if (!html.trim()) return sendJson(res, 400, { error: 'HTML khaali hai.' });
  const buf = await pdf.renderHtml(html, { format: body.format, landscape: !!body.landscape });
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

async function handleTool(req, res) {
  if (!pdfLimit(clientIp(req))) return sendJson(res, 429, { error: 'Bahut zyada PDF requests. Thodi der ruko.' });
  const body = await readJson(req, 60 * 1048576);
  const files = (Array.isArray(body.files) ? body.files : []).slice(0, 30).map(f => b64ToBuf(f && f.data)).filter(b => b.length);
  if (!files.length) return sendJson(res, 400, { error: 'Pehle PDF / photo chuno.' });
  const buf = await pdf.runTool(String(body.op || ''), files, body.params || {});
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

async function handleResolve(req, res) {
  if (!pdfLimit(clientIp(req))) return sendJson(res, 429, { error: 'Bahut zyada requests. Thodi der ruko.' });
  const body = await readJson(req, 45 * 1048576);
  const html = typeof body.html === 'string' ? body.html : '';
  if (!html.trim()) return sendJson(res, 400, { error: 'HTML khaali hai.' });
  const known = body.known && typeof body.known === 'object' ? Object.assign({}, body.known) : {};
  const skip = Array.isArray(body.skip) ? body.skip.slice(0, 50) : [];
  const dummy = 'data:image/png;base64,' + 'A'.repeat(16);
  for (const p of skip) if (typeof p === 'string') known[p] = dummy;
  const r = await images.resolveImages(html, known);
  const out = {};
  for (const [p, u] of Object.entries(r.images)) if (!skip.includes(p)) out[p] = u;
  sendJson(res, 200, { images: out });
}

async function handleRun(req, res) {
  if (!runLimit(clientIp(req))) return sendJson(res, 429, { error: 'Bahut zyada run requests. 1 minute ruko.' });
  const body = await readJson(req, 2 * 1048576);
  try {
    const r = await runner.runCode(body.language, body.code, body.stdin);
    sendJson(res, 200, r);
  } catch (e) {
    sendJson(res, e.status || 502, { error: e.userMessage || 'Run nahi ho paya.' });
  }
}

async function handleInfo(req, res) {
  const body = await readJson(req, 60 * 1048576);
  const buf = b64ToBuf(body.file && body.file.data);
  if (!buf.length) return sendJson(res, 400, { error: 'PDF nahi mili.' });
  sendJson(res, 200, await pdf.info(buf));
}

/* ----------------------------------------------------------- router */

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

    if (p === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        appName: APP_NAME,
        needsPassword: !!process.env.APP_PASSWORD,
        hasKey: !!getKey(),
        runLangs: Object.keys(runner.LANGS),
        models: getModels(),
        ...publicLists()
      });
    }

    if (p.startsWith('/api/')) {
      if (!isAuthed(req)) {
        authFailLimit(clientIp(req));
        return sendJson(res, 401, { error: 'Password galat hai ya nahi diya.' });
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST use karo.' });
      if (p === '/api/check') return sendJson(res, 200, { ok: true });
      if (p === '/api/chat') return await handleChat(req, res);
      if (p === '/api/pdf/render') return await handleRender(req, res);
      if (p === '/api/pdf/tool') return await handleTool(req, res);
      if (p === '/api/pdf/info') return await handleInfo(req, res);
      if (p === '/api/pdf/resolve') return await handleResolve(req, res);
      if (p === '/api/run') return await handleRun(req, res);
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[server]', e);
    if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
    sendJson(res, status, { error: e.userMessage || 'Server me gadbad hui. Dobara try karo.' });
  }
});

server.requestTimeout = 0;           // long streaming responses are normal here
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
const shutdown = async () => { try { await pdf.closeBrowser(); } catch { /* ignore */ } process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ ${APP_NAME} chal raha hai → http://localhost:${PORT}`);
  pdf.warmup().then(() => console.log('⚡ PDF engine garam (ready).'));
  console.log(getKey() ? '🔑 Gemini API key mili.' : '⚠️  GEMINI_API_KEY set nahi hai (chat kaam nahi karegi).');
});
