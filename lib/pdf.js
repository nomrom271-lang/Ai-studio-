'use strict';
/**
 * PDF engine
 *  - renderHtml(): HTML/CSS  ->  PDF (headless Chromium via Playwright). Any design, fonts, Hindi, emoji.
 *  - runTool():    merge / extract / delete / rotate / reorder / page numbers / watermark / text stamp / images -> pdf
 */
const dns = require('dns').promises;
const net = require('net');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require('playwright-core')); } catch { chromium = null; }
}

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.userMessage = message; this.status = status; }
}

/* ------------------------------------------------------------------ browser */

let browserPromise = null;
let active = 0;
const waiters = [];
const MAX_PARALLEL = Math.max(1, parseInt(process.env.PDF_PARALLEL || '2', 10) || 2);

function acquire() {
  return new Promise(resolve => {
    if (active < MAX_PARALLEL) { active++; resolve(); } else waiters.push(resolve);
  });
}
function release() {
  const next = waiters.shift();
  if (next) next(); else active--;
}

async function getBrowser() {
  if (!chromium) throw new UserError('PDF engine (playwright) install nahi hai. Dockerfile se deploy karo.', 500);
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
    } catch { /* relaunch below */ }
    browserPromise = null;
  }
  browserPromise = chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--font-render-hinting=none', '--disable-extensions', '--no-first-run'
    ]
  });
  try {
    const b = await browserPromise;
    b.on('disconnected', () => { browserPromise = null; });
    return b;
  } catch (e) {
    browserPromise = null;
    throw new UserError('PDF engine start nahi hua: ' + String(e.message || e).split('\n')[0], 500);
  }
}

async function closeBrowser() {
  try { if (browserPromise) { const b = await browserPromise; await b.close(); } } catch { /* ignore */ }
  browserPromise = null;
}

/* --------------------------------------------------- network safety (SSRF) */

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true;
}

const hostCache = new Map();
async function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  const c = hostCache.get(h);
  if (c && c.t > Date.now()) return c.v;
  let v = false;
  try {
    const r = await dns.lookup(h, { all: true });
    v = r.some(x => isPrivateIp(x.address));
  } catch { v = false; /* cannot resolve -> request will fail by itself */ }
  hostCache.set(h, { v, t: Date.now() + 10 * 60 * 1000 });
  if (hostCache.size > 500) hostCache.clear();
  return v;
}

async function guardRoute(route) {
  const url = route.request().url();
  if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) return route.continue();
  let u;
  try { u = new URL(url); } catch { return route.abort(); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.abort();
  if (await isPrivateHost(u.hostname)) return route.abort();
  return route.continue();
}

/* -------------------------------------------------------------- page runner */

async function withPage(fn, timeoutMs = 75000) {
  await acquire();
  let ctx = null;
  let timer = null;
  try {
    const b = await getBrowser();
    ctx = await b.newContext({
      javaScriptEnabled: false,                 // documents are static HTML/CSS (safer + deterministic)
      viewport: { width: 794, height: 1123 },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: 'block'
    });
    await ctx.route('**/*', guardRoute);
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new UserError('PDF banne me bahut der lagi (timeout). Page kam karke dobara try karo.', 504)), timeoutMs);
    });
    return await Promise.race([fn(page), timeout]);
  } finally {
    clearTimeout(timer);
    try { if (ctx) await ctx.close(); } catch { /* ignore */ }
    release();
  }
}

/* ------------------------------------------------------------ HTML -> PDF */

function prepareHtml(input) {
  let h = String(input || '').replace(/^﻿/, '');
  if (!/<html[\s>]/i.test(h)) {
    h = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${h}</body></html>`;
  } else if (!/<!doctype/i.test(h)) {
    h = '<!doctype html>\n' + h;
  }
  if (!/<meta[^>]+charset/i.test(h)) {
    if (/<head[^>]*>/i.test(h)) h = h.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8">');
    else h = h.replace(/<html([^>]*)>/i, '<html$1><head><meta charset="utf-8"></head>');
  }
  return h;
}

async function renderHtml(html, opts = {}) {
  const { format = 'A4', landscape = false, transparent = false } = opts;
  const doc = prepareHtml(html);
  const hasPageRule = /@page/i.test(doc);
  const allowed = ['A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid'];
  return withPage(async (page) => {
    try {
      await page.setContent(doc, { waitUntil: 'networkidle', timeout: 20000 });
    } catch { /* slow font/image host: continue with what we have */ }
    await page.waitForTimeout(350);
    const pdfOpts = {
      printBackground: true,
      preferCSSPageSize: hasPageRule,
      omitBackground: !!transparent,
      margin: hasPageRule ? { top: '0', right: '0', bottom: '0', left: '0' } : { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' }
    };
    if (!hasPageRule) {
      pdfOpts.format = allowed.includes(format) ? format : 'A4';
      pdfOpts.landscape = !!landscape;
    }
    const buf = await page.pdf(pdfOpts);
    return Buffer.from(buf);
  });
}

/* ------------------------------------------------------------- helpers */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cleanColor(c, fallback) {
  return /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : fallback;
}
function num(v, d, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}
function hexToRgb01(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function parseRange(input, total, { ordered = false } = {}) {
  const s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s || s === 'all' || s === 'sab') return Array.from({ length: total }, (_, i) => i);
  const out = [];
  const seen = new Set();
  const add = (n) => {
    if (n < 1 || n > total) throw new UserError(`Page ${n} nahi hai. Is PDF me total ${total} page hain.`);
    if (ordered || !seen.has(n - 1)) { seen.add(n - 1); out.push(n - 1); }
  };
  for (const part of s.split(/[,\s;]+/)) {
    if (!part) continue;
    let m;
    if (part === 'last') add(total);
    else if ((m = /^(\d+)$/.exec(part))) add(+m[1]);
    else if ((m = /^(\d*)-(\d*)$/.exec(part)) && (m[1] || m[2])) {
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? +m[2] : total;
      if (a <= b) for (let i = a; i <= b; i++) add(i);
      else for (let i = a; i >= b; i--) add(i);
    } else throw new UserError(`Page range samajh nahi aayi: "${part}". Example: 1-3,5,8-`);
  }
  if (!out.length) throw new UserError('Koi page select nahi hua.');
  if (!ordered) out.sort((a, b) => a - b);
  return out;
}

async function load(buf) {
  try {
    return await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new UserError('Ye PDF khul nahi paayi (kharab ya password-protected ho sakti hai).');
  }
}

/* ------------------------------------------------------------- overlays */

async function renderOverlay(innerHtml, w, h) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:${w}pt ${h}pt;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Noto Sans Devanagari','Noto Sans','Segoe UI',Arial,sans-serif}
.ov{position:relative;width:${w}pt;height:${h}pt;overflow:hidden;page-break-after:avoid}
</style></head><body><div class="ov">${innerHtml}</div></body></html>`;
  return withPage(async (page) => {
    try { await page.setContent(html, { waitUntil: 'load', timeout: 15000 }); } catch { /* ignore */ }
    await page.waitForTimeout(150);
    const buf = await page.pdf({ printBackground: true, preferCSSPageSize: true, omitBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    return Buffer.from(buf);
  });
}

async function applyOverlay(buf, pageIdxs, makeInner) {
  const src = await load(buf);
  const pages = src.getPages();
  const cache = new Map();
  for (const i of pageIdxs) {
    const p = pages[i];
    const { width, height } = p.getSize();
    const mb = p.getMediaBox();
    const key = `${Math.round(width)}x${Math.round(height)}`;
    let emb = cache.get(key);
    if (!emb) {
      const ovBuf = await renderOverlay(makeInner(width, height), width, height);
      [emb] = await src.embedPdf(ovBuf, [0]);
      cache.set(key, emb);
    }
    p.drawPage(emb, { x: mb.x, y: mb.y, width, height });
  }
  return Buffer.from(await src.save());
}

/* ----------------------------------------------------------------- tools */

async function opMerge(files) {
  if (files.length < 2) throw new UserError('Merge ke liye kam se kam 2 PDF chahiye.');
  const out = await PDFDocument.create();
  for (const f of files) {
    const d = await load(f);
    const pages = await out.copyPages(d, d.getPageIndices());
    pages.forEach(p => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

async function opExtract(buf, range) {
  const d = await load(buf);
  const idx = parseRange(range, d.getPageCount());
  const out = await PDFDocument.create();
  const pages = await out.copyPages(d, idx);
  pages.forEach(p => out.addPage(p));
  return Buffer.from(await out.save());
}

async function opReorder(buf, range) {
  const d = await load(buf);
  const idx = parseRange(range, d.getPageCount(), { ordered: true });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(d, idx);
  pages.forEach(p => out.addPage(p));
  return Buffer.from(await out.save());
}

async function opDelete(buf, range) {
  const d = await load(buf);
  const total = d.getPageCount();
  const idx = parseRange(range, total);
  if (idx.length >= total) throw new UserError('Saare pages delete nahi kar sakte. Kam se kam 1 page bachna chahiye.');
  [...idx].sort((a, b) => b - a).forEach(i => d.removePage(i));
  return Buffer.from(await d.save());
}

async function opRotate(buf, range, angle) {
  const d = await load(buf);
  const idx = parseRange(range, d.getPageCount());
  const a = [90, 180, 270, -90].includes(Number(angle)) ? Number(angle) : 90;
  const pages = d.getPages();
  for (const i of idx) {
    const cur = pages[i].getRotation().angle || 0;
    pages[i].setRotation(degrees((((cur + a) % 360) + 360) % 360));
  }
  return Buffer.from(await d.save());
}

async function opPageNumbers(buf, p) {
  const fmt = String(p.format || 'Page {n} of {total}');
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-ÿ]/.test(fmt)) {
    throw new UserError('Page number format me sirf English/numbers use karo. Hindi text chahiye to "Text stamp" tool use karo.');
  }
  const d = await load(buf);
  const font = await d.embedFont(StandardFonts.Helvetica);
  const total = d.getPageCount();
  const size = num(p.size, 10, 6, 28);
  const start = Math.round(num(p.start, 1, 0, 100000));
  const color = hexToRgb01(cleanColor(p.color, '#444444'));
  const pos = ['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'].includes(p.position) ? p.position : 'bottom-center';
  const skipFirst = p.skipFirst === true || p.skipFirst === 'true';
  d.getPages().forEach((page, i) => {
    if (skipFirst && i === 0) return;
    const text = fmt.replaceAll('{n}', String(i + start - (skipFirst ? 1 : 0))).replaceAll('{total}', String(total));
    const { width, height } = page.getSize();
    const mb = page.getMediaBox();
    const tw = font.widthOfTextAtSize(text, size);
    const m = 28;
    let x = mb.x + (width - tw) / 2;
    if (pos.endsWith('right')) x = mb.x + width - tw - m;
    if (pos.endsWith('left')) x = mb.x + m;
    const y = pos.startsWith('top') ? mb.y + height - m - size * 0.2 : mb.y + m - size * 0.2;
    page.drawText(text, { x, y, size, font, color: rgb(color.r, color.g, color.b) });
  });
  return Buffer.from(await d.save());
}

async function opWatermark(buf, p) {
  const text = String(p.text || '').trim().slice(0, 80);
  if (!text) throw new UserError('Watermark ka text likho.');
  const d = await load(buf);
  const idx = parseRange(p.range, d.getPageCount());
  const color = cleanColor(p.color, '#888888');
  const opacity = num(p.opacity, 0.18, 0.03, 1);
  const tile = p.mode === 'tile';
  const angle = num(p.angle, -35, -90, 90);
  const sizeIn = num(p.size, 0, 0, 400);
  return applyOverlay(buf, idx, (w, h) => {
    if (tile) {
      const fs = sizeIn || Math.max(14, Math.round(w / 18));
      const cols = Math.ceil(w / (fs * Math.max(4, text.length * 0.6))) + 2;
      const rows = Math.ceil(h / (fs * 3.2)) + 2;
      const cells = Array.from({ length: cols * rows }, () => `<span>${esc(text)}</span>`).join('');
      return `<div style="position:absolute;left:-30%;top:-30%;width:160%;height:160%;transform:rotate(${angle}deg);
        display:grid;grid-template-columns:repeat(${cols},auto);grid-auto-rows:${Math.round(fs * 3.2)}pt;align-content:space-around;justify-content:space-around;
        font-size:${fs}pt;font-weight:700;color:${color};opacity:${opacity};white-space:nowrap">${cells}</div>`;
    }
    const fs = sizeIn || Math.max(24, Math.min(Math.round(w / Math.max(5, text.length * 0.62)), 140));
    return `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
      <div style="transform:rotate(${angle}deg);font-size:${fs}pt;font-weight:800;color:${color};opacity:${opacity};white-space:nowrap;letter-spacing:.04em">${esc(text)}</div></div>`;
  });
}

async function opStamp(buf, p) {
  const text = String(p.text || '').trim().slice(0, 300);
  if (!text) throw new UserError('Stamp ka text likho.');
  const d = await load(buf);
  const idx = parseRange(p.range, d.getPageCount());
  const color = cleanColor(p.color, '#111111');
  const bg = p.bg ? cleanColor(p.bg, '') : '';
  const size = num(p.size, 14, 6, 120);
  const pos = ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right'].includes(p.position) ? p.position : 'bottom-center';
  const bold = p.bold === true || p.bold === 'true';
  const justify = pos.endsWith('left') ? 'flex-start' : pos.endsWith('right') ? 'flex-end' : 'center';
  const align = pos.startsWith('top') ? 'flex-start' : pos.startsWith('bottom') ? 'flex-end' : 'center';
  return applyOverlay(buf, idx, () =>
    `<div style="position:absolute;inset:0;padding:26pt;display:flex;justify-content:${justify};align-items:${align}">
      <div style="font-size:${size}pt;color:${color};font-weight:${bold ? 700 : 400};line-height:1.35;white-space:pre-wrap;max-width:90%;
      ${bg ? `background:${bg};padding:4pt 9pt;border-radius:5pt;` : ''}text-align:${justify === 'center' ? 'center' : justify === 'flex-end' ? 'right' : 'left'}">${esc(text)}</div></div>`
  );
}

async function opImages(images, p) {
  if (!images.length) throw new UserError('Kam se kam 1 photo chahiye.');
  const out = await PDFDocument.create();
  const fit = p.fit === 'contain' ? 'contain' : 'cover-page';
  const A4 = [595.28, 841.89];
  for (const img of images) {
    let emb;
    const isPng = img.length > 8 && img[0] === 0x89 && img[1] === 0x50;
    try { emb = isPng ? await out.embedPng(img) : await out.embedJpg(img); } catch {
      throw new UserError('Ek image padhi nahi gayi. JPG ya PNG photo use karo.');
    }
    if (fit === 'contain') {
      const page = out.addPage([emb.width, emb.height]);
      page.drawImage(emb, { x: 0, y: 0, width: emb.width, height: emb.height });
    } else {
      const landscape = emb.width > emb.height * 1.15;
      const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
      const page = out.addPage([pw, ph]);
      const margin = 18;
      const scale = Math.min((pw - margin * 2) / emb.width, (ph - margin * 2) / emb.height);
      const w = emb.width * scale, h = emb.height * scale;
      page.drawImage(emb, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
  }
  return Buffer.from(await out.save());
}

async function info(buf) {
  const d = await load(buf);
  const first = d.getPage(0).getSize();
  return { pages: d.getPageCount(), width: Math.round(first.width), height: Math.round(first.height) };
}

async function runTool(op, files, params = {}) {
  const f0 = files[0];
  switch (op) {
    case 'merge': return opMerge(files);
    case 'extract': return opExtract(f0, params.range);
    case 'reorder': return opReorder(f0, params.range);
    case 'delete': return opDelete(f0, params.range);
    case 'rotate': return opRotate(f0, params.range, params.angle);
    case 'pagenumbers': return opPageNumbers(f0, params);
    case 'watermark': return opWatermark(f0, params);
    case 'stamp': return opStamp(f0, params);
    case 'images': return opImages(files, params);
    default: throw new UserError('Ye tool pata nahi: ' + String(op).slice(0, 30));
  }
}

module.exports = { renderHtml, runTool, info, closeBrowser, UserError, parseRange, prepareHtml };
