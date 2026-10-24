'use strict';
/**
 * Images inside PDFs.
 * The AI writes   <img data-ai="english description" style="width:100%;height:60mm;object-fit:cover">
 * resolveImages() turns each one into a real picture (data URI):
 *   1) Gemini image model (your same API key)           — best quality, may not be free on every account
 *   2) Pollinations (free, no key)                      — best effort
 *   3) generated abstract SVG art                       — always works, never a broken box
 */
const crypto = require('crypto');

const MAX_IMAGES = 6;
const cache = new Map();            // key -> data URI (small LRU)
const CACHE_MAX = 40;

function cacheSet(k, v) { cache.set(k, v); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest();

function baseUrl() { return (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''); }
function getKey() { return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim(); }
function imageModels() {
  return (process.env.GEMINI_IMAGE_MODELS || 'gemini-3.1-flash-image,gemini-2.5-flash-image').split(',').map(s => s.trim()).filter(Boolean);
}

const RATIOS = { '16:9': [1024, 576], '4:3': [1024, 768], '1:1': [768, 768], '3:4': [768, 1024], '9:16': [576, 1024], '3:2': [1024, 683] };
function ratioOf(tag) {
  const m = /data-ratio\s*=\s*["']?(\d+:\d+)/i.exec(tag);
  return m && RATIOS[m[1]] ? m[1] : '4:3';
}

function timeoutSignal(ms, parent) {
  const t = AbortSignal.timeout(ms);
  return parent && typeof AbortSignal.any === 'function' ? AbortSignal.any([t, parent]) : t;
}

async function viaGemini(prompt, ratio, signal) {
  const key = getKey();
  if (!key || process.env.IMAGE_GEMINI === 'off') return null;
  for (const model of imageModels()) {
    try {
      const r = await fetch(`${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${prompt}. Aspect ratio ${ratio}. No text, no watermark, no captions inside the image.` }] }],
          generationConfig: { responseModalities: ['IMAGE'] }
        }),
        signal: timeoutSignal(45000, signal)
      });
      if (!r.ok) continue;
      const j = await r.json();
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      for (const p of parts) {
        const d = p.inlineData || p.inline_data;
        if (d && d.data && String(d.mimeType || d.mime_type || '').startsWith('image/')) {
          if (d.data.length > 6 * 1024 * 1024) continue;
          return `data:${d.mimeType || d.mime_type};base64,${d.data}`;
        }
      }
    } catch { /* try next model */ }
  }
  return null;
}

async function viaPollinations(prompt, ratio, signal) {
  if (process.env.IMAGE_POLLINATIONS === 'off') return null;
  const [w, h] = RATIOS[ratio] || RATIOS['4:3'];
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 400))}?width=${w}&height=${h}&nologo=true&model=flux&seed=${hash(prompt)[0] * 97 + hash(prompt)[1]}`;
    const r = await fetch(url, { signal: timeoutSignal(30000, signal) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000 || buf.length > 5 * 1024 * 1024) return null;
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

/** Always-available fallback: deterministic abstract art (hacker-ish grid + glow). */
function svgArt(prompt, ratio) {
  const [w, h] = RATIOS[ratio] || RATIOS['4:3'];
  const d = hash(prompt);
  const hue = (d[0] * 360 / 255) | 0;
  const hue2 = (hue + 40 + d[1] % 80) % 360;
  let shapes = '';
  for (let i = 0; i < 9; i++) {
    const x = (d[(i * 3) % 20] / 255) * w, y = (d[(i * 3 + 1) % 20] / 255) * h, r = 40 + (d[(i * 3 + 2) % 20] / 255) * (h / 3);
    shapes += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(0)}" fill="hsl(${(hue + i * 25) % 360},80%,60%)" opacity="${(0.10 + (i % 4) * 0.06).toFixed(2)}"/>`;
  }
  let lines = '';
  for (let i = 1; i < 12; i++) lines += `<path d="M0 ${(h / 12) * i}H${w}" stroke="#fff" stroke-opacity=".06"/>` + `<path d="M${(w / 12) * i} 0V${h}" stroke="#fff" stroke-opacity=".06"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,18%)"/><stop offset="1" stop-color="hsl(${hue2},75%,32%)"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${shapes}${lines}</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

async function makeImage(prompt, ratio, signal) {
  const key = ratio + '|' + prompt;
  if (cache.has(key)) return cache.get(key);
  const uri = (await viaGemini(prompt, ratio, signal)) || (await viaPollinations(prompt, ratio, signal));
  if (uri) { cacheSet(key, uri); return uri; }
  return null;
}

const IMG_RE = /<img\b[^>]*\bdata-ai\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi;

function listPrompts(html) {
  const out = [];
  for (const m of String(html).matchAll(IMG_RE)) out.push({ tag: m[0], prompt: m[2].replace(/\s+/g, ' ').trim().slice(0, 500), ratio: ratioOf(m[0]) });
  return out;
}

function withSrc(tag, uri) {
  let t = tag.replace(/\ssrc\s*=\s*(["'])[\s\S]*?\1/i, '');
  return t.replace(/<img\b/i, `<img src="${uri}"`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param html   document html
 * @param known  { prompt: dataUri } images the client already has (kept stable across edits)
 * @returns {html, images}  html keeps data-ai (so it can be regenerated) and gets src
 */
async function resolveImages(html, known = {}, opts = {}) {
  const items = listPrompts(html);
  if (!items.length) return { html, images: {} };
  const budgetMs = opts.budgetMs || 60000;
  const t0 = Date.now();
  const unique = [];
  for (const it of items) if (!unique.find(u => u.prompt === it.prompt)) unique.push(it);
  const images = {};
  const work = [];
  unique.forEach((u, idx) => {
    const k = known[u.prompt];
    if (typeof k === 'string' && k.startsWith('data:image/') && k.length < 8 * 1024 * 1024) { images[u.prompt] = k; return; }
    if (idx >= MAX_IMAGES) { images[u.prompt] = svgArt(u.prompt, u.ratio); return; }
    work.push(u);
  });
  // 3 at a time
  let i = 0;
  const worker = async () => {
    while (i < work.length) {
      const u = work[i++];
      const left = budgetMs - (Date.now() - t0);
      if (left < 3000) { images[u.prompt] = svgArt(u.prompt, u.ratio); continue; }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), left);
      try { images[u.prompt] = (await makeImage(u.prompt, u.ratio, ac.signal)) || svgArt(u.prompt, u.ratio); }
      catch { images[u.prompt] = svgArt(u.prompt, u.ratio); }
      finally { clearTimeout(timer); }
    }
  };
  await Promise.all([worker(), sleep(0).then(worker), sleep(0).then(worker)]);
  const out = String(html).replace(IMG_RE, (tag, q, p) => withSrc(tag, images[p.replace(/\s+/g, ' ').trim().slice(0, 500)] || svgArt(p, ratioOf(tag))));
  return { html: out, images };
}

/** For direct renders: any <img data-ai> still without a real src gets instant SVG art (no network, no broken boxes). */
function fillMissing(html) {
  return String(html).replace(IMG_RE, (tag, q, p) => {
    const m = /\ssrc\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag);
    if (m && m[2].startsWith('data:image/')) return tag;
    return withSrc(tag, svgArt(p, ratioOf(tag)));
  });
}

module.exports = { resolveImages, fillMissing, svgArt, listPrompts, MAX_IMAGES };
