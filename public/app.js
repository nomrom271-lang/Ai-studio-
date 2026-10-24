/* PDF Studio AI — frontend (no build step) */
(() => {
'use strict';

/* ============================================================ helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('psai.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('psai.' + k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem('psai.' + k); } catch { /* ignore */ } }
};
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const safeName = (s) => String(s || 'document').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';

let toastTimer = 0;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, bad ? 4200 : 2400);
}

/* ============================================================ state */
const S = {
  cfg: { appName: 'PDF Studio AI', moods: [], styles: [], needsPassword: false, hasKey: true },
  messages: [],            // {id, role, text, files:[{name,mime,data|text}]}
  mood: LS.get('mood', 'auto'),
  style: LS.get('style', 'auto'),
  search: LS.get('search', false),
  busy: false,
  atts: [],
  ac: null,
  pw: LS.get('pw', ''),
  edDoc: null, edSel: null, edDirty: false
};
const docs = new Map();
let docSeq = 0;

const FALLBACK_MOODS = [{ id: 'auto', emoji: '✨', name: 'Auto', desc: 'Aapke mood ke hisaab se' }];
const FALLBACK_STYLES = [{ id: 'auto', emoji: '🪄', name: 'Auto', colors: ['#7c5cff', '#00d4ff'] }];

/* ============================================================ overlays + back button */
const OV = [];
function openOv(id) {
  const node = $('#' + id);
  if (!node.classList.contains('open')) {
    node.classList.add('open');
    node.setAttribute('aria-hidden', 'false');
    OV.push(id);
    try { history.pushState({ ov: id }, ''); } catch { /* ignore */ }
  }
}
function closeOv(id, fromPop) {
  const i = OV.lastIndexOf(id);
  if (i < 0) return;
  OV.splice(i, 1);
  const node = $('#' + id);
  node.classList.remove('open');
  node.setAttribute('aria-hidden', 'true');
  if (id === 'viewer') viewerClosed();
  if (id === 'editor') { S.edDoc = null; S.edSel = null; $('#edFrame').srcdoc = ''; }
  if (id === 'runner') $('#rFrame').srcdoc = '';
  if (!fromPop && history.state && history.state.ov === id) { try { history.back(); } catch { /* ignore */ } }
}
window.addEventListener('popstate', () => {
  const top = OV[OV.length - 1];
  if (top && !(history.state && history.state.ov === top)) closeOv(top, true);
});

/* ============================================================ API */
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (S.pw) headers['x-app-password'] = S.pw;
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  if (r.status === 401) { showLock(S.pw ? 'Password galat hai.' : ''); throw new Error('Password chahiye. Daalkar dobara try karo.'); }
  return r;
}
async function errFrom(r) {
  let j = {};
  try { j = await r.json(); } catch { /* ignore */ }
  return new Error(j.error || ('Server error ' + r.status));
}

function showLock(msg) {
  $('#lockErr').textContent = msg || '';
  $('#lock').classList.add('open');
  setTimeout(() => $('#lockInput').focus(), 50);
}
$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#lockInput').value;
  try {
    const r = await fetch('/api/check', { method: 'POST', headers: { 'x-app-password': pw } });
    if (r.ok) {
      S.pw = pw; LS.set('pw', pw);
      $('#lock').classList.remove('open');
      $('#lockInput').value = '';
      toast('Unlock ho gaya ✅');
    } else $('#lockErr').textContent = 'Password galat hai.';
  } catch { $('#lockErr').textContent = 'Server se connect nahi ho paya.'; }
});

/* ============================================================ pdf.js */
let pdfjsP = null;
function loadPdfjs() {
  if (pdfjsP) return pdfjsP;
  pdfjsP = (async () => {
    for (const base of ['/vendor/pdfjs-legacy/', '/vendor/pdfjs/']) {
      try {
        const m = await import(base + 'pdf.min.mjs');
        m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
        return m;
      } catch (e) { console.warn('pdf.js load failed from', base, e); }
    }
    throw new Error('PDF viewer load nahi ho paya');
  })();
  pdfjsP.catch(() => { pdfjsP = null; });
  return pdfjsP;
}
async function getPdfDoc(d) {
  if (d.pdfDoc) return d.pdfDoc;
  const blob = await buildPdf(d);
  const pdfjs = await loadPdfjs();
  const buf = await blob.arrayBuffer();
  d.pdfDoc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return d.pdfDoc;
}
async function drawPage(pdfDoc, n, canvas, cssWidth, boost) {
  const page = await pdfDoc.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let scale = (cssWidth / vp1.width) * dpr * (boost || 1.5);
  const maxPx = 2600;
  if (vp1.width * scale > maxPx) scale = maxPx / vp1.width;
  const vp = page.getViewport({ scale });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
}

/* ============================================================ PDF build / download / share */

/* ---------- AI pictures inside PDFs ---------- */
const IMG_RE = /<img\b[^>]*\bdata-ai\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi;
const normPrompt = (p) => String(p).replace(/\s+/g, ' ').trim().slice(0, 500);
function applyImages(html, map) {
  return html.replace(IMG_RE, (tag, q, p) => {
    const u = map[normPrompt(p)];
    if (!u) return tag;
    return tag.replace(/\ssrc\s*=\s*(["'])[\s\S]*?\1/i, '').replace(/<img\b/i, '<img src="' + u + '"');
  });
}
function stripImageSrc(html) {
  return html.replace(IMG_RE, (tag) => tag.replace(/\ssrc\s*=\s*(["'])data:[\s\S]*?\1/i, ''));
}
async function resolveImagesClient(html, signal) {
  if (!/data-ai\s*=/.test(html)) return html;
  const prompts = [...new Set([...html.matchAll(IMG_RE)].map(m => normPrompt(m[2])))];
  const map = {};
  const need = [];
  for (const p of prompts) {
    const u = await dbGet('imgs', p);
    if (typeof u === 'string' && u.startsWith('data:image/')) map[p] = u; else need.push(p);
  }
  if (need.length) {
    const r = await api('/api/pdf/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ html, skip: prompts.filter(p => map[p]) }) });
    if (!r.ok) throw await errFrom(r);
    const j = await r.json();
    for (const [p, u] of Object.entries(j.images || {})) {
      map[p] = u;
      if (!u.startsWith('data:image/svg')) dbPut('imgs', u, p);   // keep real pictures so edits never change them
    }
  }
  return applyImages(html, map);
}

function buildPdf(d) {
  if (d.blob) return Promise.resolve(d.blob);
  if (d.building) return d.building;
  const p = (async () => {
    if (d.html) d.html = await resolveImagesClient(d.html);
    const r = await api('/api/pdf/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: d.html }) });
    if (!r.ok) throw await errFrom(r);
    d.blob = await r.blob();
    return d.blob;
  })();
  d.building = p;
  p.then(() => { d.building = null; }, () => { d.building = null; });
  return p;
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function sharePdf(d) {
  try {
    const blob = await buildPdf(d);
    const file = new File([blob], safeName(d.name) + '.pdf', { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: d.name });
    } else {
      downloadBlob(blob, file.name);
      toast('Share is browser me nahi hai — download ho gaya');
    }
  } catch (e) { if (e && e.name !== 'AbortError') toast(e.message || 'Share nahi ho paya', true); }
}

/* ============================================================ viewer */
let vToken = 0;
let vObserver = null;
let vZoom = 1;
let vDoc = null;
let vQueue = Promise.resolve();

function viewerClosed() {
  vToken++;
  if (vObserver) { vObserver.disconnect(); vObserver = null; }
  $('#vPages').innerHTML = '';
  vDoc = null;
}
async function openViewer(d) {
  vDoc = d;
  const token = ++vToken;
  vZoom = 1;
  $('#vTitle').textContent = d.name || 'PDF';
  $('#vZoomLabel').textContent = '100%';
  const pages = $('#vPages');
  pages.style.width = '100%';
  pages.innerHTML = '<div class="working" style="justify-content:center;padding:40px"><div class="spin"></div>PDF khul rahi hai…</div>';
  buildViewerFoot(d);
  openOv('viewer');
  try {
    const pdfDoc = await getPdfDoc(d);
    if (token !== vToken) return;
    pages.innerHTML = '';
    const wrappers = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const pg = await pdfDoc.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      const w = el('div', 'vpage', '<div class="ph">…</div>');
      w.style.aspectRatio = vp.width + ' / ' + vp.height;
      w.dataset.n = i;
      pages.appendChild(w);
      wrappers.push(w);
    }
    const render = (w) => {
      if (w.dataset.r === '1') return;
      w.dataset.r = '1';
      const n = +w.dataset.n;
      vQueue = vQueue.then(async () => {
        if (token !== vToken) return;
        const cv = document.createElement('canvas');
        try {
          await drawPage(pdfDoc, n, cv, $('#vPages').clientWidth - 24, 2);
          if (token !== vToken) return;
          w.innerHTML = '';
          w.appendChild(cv);
        } catch (e) { w.dataset.r = ''; console.warn(e); }
      });
    };
    vObserver = new IntersectionObserver((ents) => {
      ents.forEach(en => { if (en.isIntersecting) render(en.target); });
    }, { root: $('#vScroll'), rootMargin: '700px 0px' });
    wrappers.forEach(w => vObserver.observe(w));
    d._vWrappers = wrappers;
  } catch (e) {
    if (token !== vToken) return;
    pages.innerHTML = `<div class="err-box" style="margin:20px">⚠️ ${esc(e.message || 'PDF nahi khul paayi')}<br>Download karke dekh sakte ho.</div>`;
  }
}
function setZoom(z) {
  vZoom = Math.min(3, Math.max(0.5, z));
  $('#vPages').style.width = (vZoom * 100) + '%';
  $('#vZoomLabel').textContent = Math.round(vZoom * 100) + '%';
  if (vDoc && vDoc._vWrappers && vObserver) {
    setTimeout(() => {
      vDoc._vWrappers.forEach(w => { w.dataset.r = ''; });
      vObserver.disconnect();
      vDoc._vWrappers.forEach(w => vObserver.observe(w));
    }, 200);
  }
}
function buildViewerFoot(d) {
  const f = $('#vFoot');
  f.innerHTML = '';
  const add = (label, cls, fn) => { const b = el('button', cls, label); b.onclick = fn; f.appendChild(b); };
  if (d.html) {
    add('✏️ Edit karo', 'main', () => { closeOv('viewer'); setTimeout(() => openEditor(d), 160); });
    add('🔁 AI se badlo', '', () => { closeOv('viewer'); aiChange(d); });
  }
  add('📤 Share', '', () => sharePdf(d));
  add('⬇ Download', '', () => downloadBlob(d.blob, safeName(d.name) + '.pdf'));
}
$('#vClose').onclick = () => closeOv('viewer');
$('#vZoomIn').onclick = () => setZoom(vZoom + 0.25);
$('#vZoomOut').onclick = () => setZoom(vZoom - 0.25);
$('#vDownload').onclick = () => { if (vDoc && vDoc.blob) downloadBlob(vDoc.blob, safeName(vDoc.name) + '.pdf'); };

function aiChange(d) {
  S.activeDoc = d.id;
  const inp = $('#input');
  inp.value = `"${d.name}" PDF me ye badlav karo: `;
  autosize();
  inp.focus();
  toast('Likho kya badalna hai, phir bhejo ➤');
}

/* ============================================================ visual editor */
function openEditor(d) {
  if (!d.html) { toast('Is PDF ka source nahi hai — AI se editable banwao', true); return; }
  S.edDoc = d; S.edSel = null; S.edDirty = false;
  const f = $('#edFrame');
  f.style.width = '794px';
  f.style.height = '1123px';
  f.onload = () => setupEditor(f);
  let h = d.html;
  if (!/<!doctype/i.test(h.slice(0, 300))) h = '<!doctype html>\n' + h;
  f.srcdoc = h;
  openOv('editor');
}
function edDoc() { const f = $('#edFrame'); return f && f.contentDocument && f.contentDocument.documentElement ? f.contentDocument : null; }
function setupEditor(f) {
  const doc = f.contentDocument;
  if (!doc || !doc.head) return;
  const st = doc.createElement('style');
  st.id = '__ed';
  st.textContent = 'html{background:#fff}body{cursor:text}.__sel{outline:2px solid #7c5cff !important;outline-offset:2px}img{max-width:100%}';
  doc.head.appendChild(st);
  doc.designMode = 'on';
  doc.addEventListener('click', (e) => selectBlock(e.target));
  doc.addEventListener('input', () => { S.edDirty = true; fitEditor(); });
  setTimeout(fitEditor, 80);
  setTimeout(fitEditor, 600);
  setTimeout(fitEditor, 1800);
}
function fitEditor() {
  const f = $('#edFrame'); const doc = edDoc();
  if (!doc) return;
  const w = Math.max(794, doc.documentElement.scrollWidth);
  f.style.width = w + 'px';
  f.style.height = '10px';
  const h = Math.max(600, doc.documentElement.scrollHeight);
  f.style.height = h + 'px';
  const avail = $('#edWrap').clientWidth - 20;
  const k = Math.min(1, avail / w);
  f.style.transform = 'scale(' + k + ')';
  f.style.transformOrigin = '0 0';
  const sc = $('#edScaler');
  sc.style.width = (w * k) + 'px';
  sc.style.height = (h * k) + 'px';
}
window.addEventListener('resize', () => { if (S.edDoc) fitEditor(); });

const INLINE = new Set(['SPAN', 'B', 'I', 'U', 'STRONG', 'EM', 'A', 'FONT', 'SMALL', 'SUB', 'SUP', 'MARK', 'CODE', 'BR', 'S', 'LABEL']);
function selectBlock(t) {
  const doc = edDoc();
  if (!doc || !t || t.nodeType !== 1) return;
  let n = t;
  while (n && INLINE.has(n.tagName) && n.parentElement) n = n.parentElement;
  if (n && (n.tagName === 'TD' || n.tagName === 'TH') && n.parentElement) n = n.parentElement;
  if (!n || n === doc.body || n === doc.documentElement || (n.classList && n.classList.contains('page'))) n = null;
  if (S.edSel) S.edSel.classList.remove('__sel');
  S.edSel = n;
  if (n) n.classList.add('__sel');
}
function edExec(cmd, val) {
  const f = $('#edFrame'); const doc = edDoc();
  if (!doc) return;
  try { f.contentWindow.focus(); } catch { /* ignore */ }
  doc.execCommand(cmd, false, val);
  S.edDirty = true;
  setTimeout(fitEditor, 30);
}
function edInsertHtml(html) {
  const doc = edDoc();
  if (!doc) return;
  const sel = doc.getSelection();
  try { $('#edFrame').contentWindow.focus(); } catch { /* ignore */ }
  if (sel && sel.rangeCount && doc.body.contains(sel.anchorNode)) {
    doc.execCommand('insertHTML', false, html);
  } else {
    const holder = doc.querySelector('.page:last-of-type') || doc.body;
    const tmp = doc.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) holder.appendChild(tmp.firstChild);
  }
  S.edDirty = true;
  setTimeout(fitEditor, 30);
}
function edChangeFont(delta) {
  const doc = edDoc();
  if (!doc) return;
  const sel = doc.getSelection();
  let node = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : S.edSel;
  if (!node && S.edSel) node = S.edSel;
  if (!node) { toast('Pehle text par tap karo ya select karo'); return; }
  const cur = parseFloat(doc.defaultView.getComputedStyle(node).fontSize) || 16;
  const next = Math.max(6, Math.round(cur + delta));
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    let b = node;
    while (b && INLINE.has(b.tagName) && b.parentElement) b = b.parentElement;
    if (b && b !== doc.body) b.style.fontSize = next + 'px';
  } else {
    doc.execCommand('fontSize', false, '7');
    doc.querySelectorAll('font[size="7"]').forEach(ft => {
      const sp = doc.createElement('span');
      sp.style.fontSize = next + 'px';
      while (ft.firstChild) sp.appendChild(ft.firstChild);
      ft.replaceWith(sp);
    });
  }
  S.edDirty = true;
  setTimeout(fitEditor, 30);
}
function edDelete() {
  const doc = edDoc();
  const n = S.edSel;
  if (!doc || !n || !n.parentNode) { toast('Pehle jo hatana hai usme tap karo'); return; }
  try {
    const r = doc.createRange();
    r.selectNode(n);
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    if (!doc.execCommand('delete')) n.remove();
  } catch { n.remove(); }
  S.edSel = null;
  S.edDirty = true;
  setTimeout(fitEditor, 30);
}
async function edAddImage(file) {
  try {
    const b64 = await imageToJpegB64(file, 1400);
    edInsertHtml(`<img src="data:image/jpeg;base64,${b64}" style="max-width:100%;border-radius:6px">`);
  } catch (e) { toast(e.message, true); }
}
$('#edTools').addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
$('#edTools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.cmd) return edExec(b.dataset.cmd);
  switch (b.dataset.act) {
    case 'smaller': return edChangeFont(-2);
    case 'bigger': return edChangeFont(2);
    case 'h2': return edExec('formatBlock', 'h2');
    case 'para': return edExec('formatBlock', 'p');
    case 'hr': return edExec('insertHorizontalRule');
    case 'table': return edInsertHtml('<table style="width:100%;border-collapse:collapse;margin:8px 0"><tbody>' +
      '<tr><th style="border:1px solid #888;padding:6px">Heading</th><th style="border:1px solid #888;padding:6px">Heading</th><th style="border:1px solid #888;padding:6px">Heading</th></tr>' +
      '<tr><td style="border:1px solid #888;padding:6px">Text</td><td style="border:1px solid #888;padding:6px">Text</td><td style="border:1px solid #888;padding:6px">Text</td></tr>' +
      '<tr><td style="border:1px solid #888;padding:6px">Text</td><td style="border:1px solid #888;padding:6px">Text</td><td style="border:1px solid #888;padding:6px">Text</td></tr></tbody></table><p><br></p>');
    case 'image': return $('#edImgInput').click();
    case 'delete': return edDelete();
    default:
  }
});
$('#edColor').addEventListener('input', (e) => edExec('foreColor', e.target.value));
$('#edHilite').addEventListener('input', (e) => edExec('backColor', e.target.value));
$('#edImgInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) edAddImage(f); });
$('#eClose').onclick = () => {
  if (S.edDirty && !confirm('Badlav save nahi hue. Band kar do?')) return;
  closeOv('editor');
};
$('#eSave').onclick = () => {
  const d = S.edDoc; const doc = edDoc();
  if (!d || !doc) return;
  if (!S.edDirty) { toast('Koi badlav nahi kiya'); closeOv('editor'); return; }
  const clone = doc.documentElement.cloneNode(true);
  const st = clone.querySelector('#__ed'); if (st) st.remove();
  clone.querySelectorAll('.__sel').forEach(n => { n.classList.remove('__sel'); if (!n.getAttribute('class')) n.removeAttribute('class'); });
  const html = '<!--PDF: ' + d.name + '-->\n<!doctype html>\n' + clone.outerHTML;
  closeOv('editor');
  if (d.onSave) { d.onSave(html); return; }
  const slim = stripImageSrc(html);
  const text = 'Edit save ho gaya ✅ Ye raha tumhara updated PDF:\n\n```html\n' + slim + '\n```\n';
  addLocalAssistant(text, true);
};

/* ============================================================ markdown + code cards */
function configureMarked() {
  if (window.marked && window.marked.setOptions) window.marked.setOptions({ breaks: true, gfm: true });
}
function md2html(text) {
  let raw;
  try { raw = window.marked.parse ? window.marked.parse(text) : window.marked(text); } catch { raw = esc(text).replace(/\n/g, '<br>'); }
  return window.DOMPurify ? window.DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] }) : raw;
}
function prepStream(text) {
  const fences = (text.match(/^```/gm) || []).length;
  if (fences % 2 === 0) return text;
  const idx = (() => { const i = text.lastIndexOf('\n```'); return i >= 0 ? i + 1 : 0; })();
  const tail = text.slice(idx);
  const lang = ((/^```([\w+-]*)/.exec(tail) || [])[1] || '').toLowerCase();
  if ((lang === 'html' || lang === 'htm') && tail.length > 260) {
    return text.slice(0, idx) + '\n\n⏳ *Design ban raha hai… (' + Math.max(1, Math.round(tail.length / 1024)) + ' KB likha ja chuka)*\n';
  }
  return text;
}
function renderStreaming(md, text) {
  md.innerHTML = md2html(prepStream(text));
  $$('a', md).forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}
function renderFinal(md, text, auto) {
  md.innerHTML = md2html(text);
  $$('a', md).forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  decorate(md, auto);
}

const EXT = { html: 'html', htm: 'html', svg: 'svg', javascript: 'js', js: 'js', python: 'py', py: 'py', css: 'css', json: 'json', bash: 'sh', sh: 'sh', java: 'java', cpp: 'cpp', c: 'c', sql: 'sql', xml: 'xml', ts: 'ts', typescript: 'ts', md: 'md', markdown: 'md' };

function decorate(container, auto) {
  $$('pre', container).forEach(pre => {
    if (pre.closest('.code-card') || pre.closest('.doc-card')) return;
    const code = pre.querySelector('code');
    const text = (code || pre).textContent.replace(/\n$/, '');
    const cls = code ? code.className : '';
    const lang = ((/language-([\w+#-]+)/.exec(cls) || [])[1] || '').toLowerCase();
    if (lang === 'html' || lang === 'htm') {
      const m = /^\s*<!--\s*PDF\s*:\s*([\s\S]*?)\s*-->/i.exec(text);
      if (m) return pre.replaceWith(makeDocCard(text, (m[1] || 'Document').trim(), auto));
      if (/@page/i.test(text) && /<html/i.test(text) && /class=["'][^"']*\bpage\b/i.test(text)) {
        const t = /<title>([\s\S]*?)<\/title>/i.exec(text);
        return pre.replaceWith(makeDocCard(text, (t && t[1].trim()) || 'Document', auto));
      }
    }
    pre.replaceWith(makeCodeCard(text, lang));
  });
}

function makeCodeCard(text, lang) {
  const card = el('div', 'code-card');
  const head = el('div', 'cc-head');
  head.appendChild(el('span', 'cc-lang', esc(lang || 'code')));
  const acts = el('div', 'cc-actions');
  head.appendChild(acts);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = text;
  pre.appendChild(code);
  const out = el('div', 'cc-out');
  card.append(head, pre, out);

  const btn = (label, fn, cls) => { const b = el('button', cls || '', label); b.onclick = fn; acts.appendChild(b); return b; };
  const l = lang;
  const isHtml = l === 'html' || l === 'htm';
  const isSvg = l === 'svg';
  const isJs = l === 'javascript' || l === 'js';
  const isPy = l === 'python' || l === 'py';
  const isCss = l === 'css', isJson = l === 'json', isMd = l === 'markdown' || l === 'md', isSql = l === 'sql';
  const remoteLang = !isHtml && !isSvg && !isJs && !isPy && (S.cfg.runLangs || []).includes(l);
  if (isHtml || isSvg) btn('▶ Run', () => openRunner(isSvg ? 'SVG' : 'HTML', isSvg ? `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${text}</body>` : text), 'run');
  if (isJs) btn('▶ Run', () => runJs(text, out), 'run');
  if (isPy) btn('▶ Run', () => runPy(text, out), 'run');
  if (isCss) btn('▶ Preview', () => openRunner('CSS', '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><style>' + text.replace(/<\/style/gi, '<\\/style') + '</style><body><div class="container wrapper box card"><h1>Heading 1</h1><h2>Heading 2</h2><p>Paragraph with <a href="#">link</a>, <b>bold</b> and <i>italic</i>.</p><button class="btn button">Button</button> <input placeholder="input"><ul><li>List one</li><li>List two</li></ul></div></body>'), 'run');
  if (isMd) btn('▶ Preview', () => openRunner('Markdown', '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:760px;margin:0 auto;padding:16px;line-height:1.6">' + md2html(text) + '</body>'), 'run');
  if (isJson) btn('▶ Check', () => { out.innerHTML = ''; const d = document.createElement('div'); try { d.textContent = '✅ Sahi JSON\n' + JSON.stringify(JSON.parse(text), null, 2); } catch (e) { d.className = 'e'; d.textContent = '⚠️ ' + e.message; } out.appendChild(d); }, 'run');
  if (isSql) btn('▶ Run', () => runSql(text, out), 'run');
  if (remoteLang) btn('▶ Run', () => runRemote(l, text, out), 'run');
  btn('📋 Copy', async () => { try { await navigator.clipboard.writeText(text); toast('Copy ho gaya'); } catch { toast('Copy nahi hua', true); } });
  btn('⬇ Save', () => downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'code.' + (EXT[l] || 'txt')));
  if (text.split('\n').length > 12) {
    const b = btn('⛶', () => { card.classList.toggle('open'); b.textContent = card.classList.contains('open') ? '⤡' : '⛶'; });
  }
  return card;
}

/* ---------- PDF doc card ---------- */
function makeDocCard(html, name, auto) {
  const id = 'd' + (++docSeq);
  const d = { id, html, name, blob: null, pdfDoc: null };
  docs.set(id, d);
  const c = el('div', 'doc-card');
  c.dataset.id = id;
  c.innerHTML = `
    <div class="doc-head"><span>📄</span><b>${esc(name)}</b><span class="badge">PDF</span></div>
    <div class="doc-sub" data-sub>Neeche preview dikhega</div>
    <div class="doc-preview"><div class="pv loading" data-pv></div></div>
    <div class="doc-actions">
      <button class="main" data-a="view">⛶ Poori dekho</button>
      <button data-a="dl">⬇ Download</button>
      <button data-a="edit">✏️ Edit</button>
      <button data-a="ai">🔁 AI se badlo</button>
      <button data-a="share">📤 Share</button>
      <button data-a="web">▶ Web view</button>
    </div>
    <details class="doc-code"><summary>&lt;/&gt; HTML code dekho</summary></details>`;
  $('details', c).appendChild(makeCodeCard(html, 'html'));
  const pv = $('[data-pv]', c);
  pv.innerHTML = auto
    ? '<div class="lbl"><div class="spin"></div>PDF ban rahi hai…</div>'
    : '<div class="lbl">📄<button class="primary-sm" data-a="make">PDF dikhao</button></div>';
  c.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (a === 'make' || a === 'retry') return showPreview(d, c);
      if (a === 'web') return openRunner(name, html);
      if (a === 'edit') return openEditor(d);
      if (a === 'ai') return aiChange(d);
      if (a === 'share') return sharePdf(d);
      if (a === 'view' || a === 'dl') {
        b.disabled = true;
        try { await buildPdf(d); } finally { b.disabled = false; }
        if (a === 'dl') return downloadBlob(d.blob, safeName(name) + '.pdf');
        return openViewer(d);
      }
    } catch (err) { toast(err.message || 'Kuch gadbad hui', true); }
  });
  pv.addEventListener('click', (e) => { if (d.blob && !e.target.closest('[data-a]')) openViewer(d); });
  if (auto) setTimeout(() => showPreview(d, c), 0);
  return c;
}

async function showPreview(d, card) {
  const pv = $('[data-pv]', card);
  const sub = $('[data-sub]', card);
  pv.className = 'pv loading';
  pv.innerHTML = '<div class="lbl"><div class="spin"></div>PDF ban rahi hai… (10–20 second)</div>';
  try {
    const blob = await buildPdf(d);
    let pdfDoc;
    try { pdfDoc = await getPdfDoc(d); } catch (e) {
      pv.className = 'pv';
      pv.innerHTML = '<div class="lbl">✅ PDF ban gayi par preview yahan nahi dikh pa raha.<br>⬇ Download dabao.</div>';
      sub.textContent = fmtSize(blob.size);
      return;
    }
    pv.className = 'pv';
    pv.innerHTML = '';
    const cv = document.createElement('canvas');
    pv.appendChild(cv);
    await drawPage(pdfDoc, 1, cv, pv.clientWidth || 340, 1.7);
    sub.textContent = `${pdfDoc.numPages} page • ${fmtSize(blob.size)} • preview par tap karke poori dekho`;
    keepBottom();
  } catch (e) {
    pv.className = 'pv';
    pv.innerHTML = `<div class="lbl">⚠️ ${esc(e.message || 'PDF nahi ban payi')}<br><button class="primary-sm" data-a="retry">Dobara try</button></div>`;
    sub.textContent = 'Tip: Edit ya Web view se bhi dekh sakte ho';
  }
}

/* ============================================================ runner (html / js / python) */
let runnerState = null;
function openRunner(title, html) {
  runnerState = { title, html };
  $('#rTitle').textContent = '▶ ' + title;
  $('#rFrame').srcdoc = html;
  openOv('runner');
}
$('#rClose').onclick = () => closeOv('runner');
$('#rReload').onclick = () => { if (!runnerState) return; const f = $('#rFrame'); f.srcdoc = ''; setTimeout(() => { f.srcdoc = runnerState.html; }, 40); };
$('#rOpen').onclick = () => { if (runnerState) downloadBlob(new Blob([runnerState.html], { type: 'text/html;charset=utf-8' }), safeName(runnerState.title) + '.html'); };

function runJs(code, out) {
  out.innerHTML = '';
  const id = 'r' + uid();
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.style.display = 'none';
  let count = 0;
  const add = (txt, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = txt; out.appendChild(d); count++; };
  const done = () => { window.removeEventListener('message', onMsg); setTimeout(() => f.remove(), 100); };
  const onMsg = (e) => {
    if (e.source !== f.contentWindow) return;
    const m = e.data;
    if (!m || m.__run !== id) return;
    if (m.done) { if (!count) add('✅ Poora hua (koi output nahi).'); return; }
    add(m.m, m.t === 'error' ? 'e' : m.t === 'warn' ? 'w' : '');
  };
  window.addEventListener('message', onMsg);
  const safe = code.replace(/<\/script/gi, '<\\/script');
  f.srcdoc = `<!doctype html><html><body><script>
const __id=${JSON.stringify(id)};
const __post=(t,m)=>parent.postMessage({__run:__id,t,m},'*');
const __fmt=x=>{if(typeof x==='string')return x;if(x===undefined)return 'undefined';try{return JSON.stringify(x,null,2)}catch(e){return String(x)}};
['log','info','debug','warn','error'].forEach(k=>{console[k]=(...a)=>__post(k,a.map(__fmt).join(' '))});
window.onerror=(m,s,l)=>{__post('error',String(m)+(l?' (line '+l+')':''));return true};
window.addEventListener('unhandledrejection',e=>__post('error','Promise error: '+((e.reason&&e.reason.message)||e.reason)));
<\/script><script>
${safe}
<\/script><script>setTimeout(()=>parent.postMessage({__run:__id,done:1},'*'),60)<\/script></body></html>`;
  document.body.appendChild(f);
  out.textContent = '';
  setTimeout(done, 12000);
}


let sqlP = null;
function loadSql() {
  if (sqlP) return sqlP;
  const base = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';
  sqlP = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = base + 'sql-wasm.js';
    sc.onload = () => window.initSqlJs({ locateFile: (f) => base + f }).then(res, rej);
    sc.onerror = () => rej(new Error('SQL engine load nahi hua (internet check karo)'));
    document.head.appendChild(sc);
  });
  sqlP.catch(() => { sqlP = null; });
  return sqlP;
}
function outLine(out, txt, cls) { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = txt; out.appendChild(d); return d; }
async function runSql(code, out) {
  out.textContent = '⏳ SQL engine load ho raha hai…';
  try {
    const SQL = await loadSql();
    const db = new SQL.Database();
    const res = db.exec(code);
    out.textContent = '';
    if (!res.length) outLine(out, '✅ Poora hua (koi table output nahi).');
    res.forEach(r => {
      const lines = [r.columns.join(' | '), r.columns.map(() => '---').join('-+-'), ...r.values.map(v => v.map(x => (x === null ? 'NULL' : String(x))).join(' | '))];
      outLine(out, lines.join('\n')).style.marginBottom = '8px';
    });
    db.close();
  } catch (e) { out.textContent = ''; outLine(out, '⚠️ ' + (e.message || e), 'e'); }
}
async function runRemote(lang, code, out) {
  out.textContent = '⏳ Online runner par chal raha hai…';
  try {
    const r = await api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: lang, code }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Run nahi ho paya');
    out.textContent = '';
    outLine(out, j.output, j.exitCode ? 'w' : '');
  } catch (e) { out.textContent = ''; outLine(out, '⚠️ ' + (e.message || e), 'e'); }
}

let pyP = null;
function loadPyodideOnce() {
  if (pyP) return pyP;
  const base = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
  pyP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = base + 'pyodide.js';
    s.onload = async () => { try { res(await window.loadPyodide({ indexURL: base })); } catch (e) { rej(e); } };
    s.onerror = () => rej(new Error('Python engine load nahi hua (internet check karo)'));
    document.head.appendChild(s);
  });
  pyP.catch(() => { pyP = null; });
  return pyP;
}
async function runPy(code, out) {
  out.textContent = pyP ? '⏳ chal raha hai…' : '⏳ Python engine load ho raha hai (pehli baar 10–20 second)…';
  const add = (txt, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = txt; out.appendChild(d); };
  try {
    const py = await loadPyodideOnce();
    out.textContent = '';
    py.setStdout({ batched: (s) => add(s) });
    py.setStderr({ batched: (s) => add(s, 'e') });
    try { await py.loadPackagesFromImports(code); } catch { /* ignore */ }
    const r = await py.runPythonAsync(code);
    if (r !== undefined && r !== null) add(String(r));
    if (!out.childNodes.length) out.textContent = '✅ Poora hua (koi output nahi).';
  } catch (e) {
    add('⚠️ ' + String(e.message || e).split('\n').slice(-6).join('\n'), 'e');
  }
}

/* ============================================================ chat rendering */
const msgsEl = $('#msgs');
const chatEl = $('#chat');
function nearBottom() { return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 140; }
function scrollBottom(force) { if (force || nearBottom()) chatEl.scrollTop = chatEl.scrollHeight; }
function keepBottom() { scrollBottom(false); }

function addMsgEl(role) {
  const w = el('div', 'msg ' + role);
  w.innerHTML = `<div class="avatar">${role === 'user' ? '🙂' : '✦'}</div><div class="bubble"><div class="md"></div><div class="extra"></div><div class="meta"></div></div>`;
  msgsEl.appendChild(w);
  $('#welcome').style.display = 'none';
  return w;
}
function renderUser(m) {
  const w = addMsgEl('user');
  const b = $('.bubble', w);
  if (m.files && m.files.length) {
    const row = el('div', 'chips-att');
    m.files.forEach(f => row.appendChild(el('span', 'att-chip', '📎 ' + esc(f.name))));
    b.insertBefore(row, $('.md', w));
  }
  const md = $('.md', w);
  if (m.text) md.innerHTML = esc(m.text).replace(/(^|\s)(\/[a-zA-Z0-9]+)/g, (all, pre, tok) => CMD_MAP.has(tok.slice(1).toLowerCase()) ? pre + '<span class="cmd-tag">' + tok + '</span>' : all);
  else md.style.display = 'none';
  return w;
}
function addAssistantMeta(w, m) {
  const meta = $('.meta', w);
  meta.innerHTML = '';
  const add = (label, fn) => { const b = el('button', '', label); b.onclick = fn; meta.appendChild(b); };
  add('🔊 Sunao', () => speakToggle(m.text));
  add('📋 Copy', async () => { try { await navigator.clipboard.writeText(m.text); toast('Copy ho gaya'); } catch { toast('Copy nahi hua', true); } });
  add('🔄 Dobara', () => regenerate(m));
}
function renderAssistantFinal(m, auto) {
  const w = addMsgEl('assistant');
  w.dataset.id = m.id;
  renderFinal($('.md', w), m.text, auto);
  addAssistantMeta(w, m);
  return w;
}
function addLocalAssistant(text, auto) {
  const m = { id: uid(), role: 'assistant', text };
  S.messages.push(m);
  renderAssistantFinal(m, auto);
  saveChat();
  scrollBottom(true);
}

/* ============================================================ send / stream */
function compactHistory(list) {
  // keep full html only for the 2 most recent documents; shrink older ones to save time/tokens
  const idxs = [];
  list.forEach((m, i) => { if (m.role === 'assistant' && /```html\s*\n\s*<!--\s*PDF/i.test(m.text)) idxs.push(i); });
  const old = new Set(idxs.slice(0, Math.max(0, idxs.length - 2)));
  return list.map((m, i) => {
    if (!old.has(i)) return m;
    const t = m.text.replace(/```html\s*\n(\s*<!--\s*PDF[\s\S]*?-->)[\s\S]*?```/gi, (all, mk) => '```html\n' + mk.trim() + '\n(purana version — poora code hata diya, naya wala upar/neeche hai)\n```');
    return Object.assign({}, m, { text: t });
  });
}
function buildPayload() {
  const list = compactHistory(S.messages.filter(m => (m.text || m.prompt || (m.files && m.files.length)) && !m.book));
  const withFiles = list.map((m, i) => ({ m, i })).filter(x => x.m.role === 'user' && x.m.files && x.m.files.some(f => f.data || f.text)).slice(-2).map(x => x.i);
  return list.map((m, i) => {
    const o = { role: m.role, text: (m.prompt || m.text) || '' };
    if (m.role === 'user' && m.files && m.files.length) {
      const keep = withFiles.includes(i);
      o.attachments = m.files.filter(f => (f.data || f.text) && (keep || f.text)).map(f => f.data ? { mime: f.mime, data: f.data } : { name: f.name, text: f.text });
      if (!o.attachments.length) delete o.attachments;
    }
    return o;
  });
}

function setBusy(b) {
  S.busy = b;
  const s = $('#btnSend');
  s.textContent = b ? '■' : '➤';
  s.classList.toggle('stop', b);
  s.setAttribute('aria-label', b ? 'Roko' : 'Bhejo');
}

async function send() {
  if (S.busy) { if (S.ac) S.ac.abort(); if (bookRun) bookRun.ac.abort(); return; }
  const inp = $('#input');
  const text = inp.value.trim();
  if (!text && !S.atts.length) return;
  const total = S.atts.reduce((n, a) => n + (a.data ? a.data.length : 0), 0);
  if (total > 26 * 1048576) { toast('Files bahut badi hain (total 18 MB se kam rakho)', true); return; }
  const { base, used } = parseCommands(text);
  // /book N  -> Bada PDF mode
  const bookCmd = used.find(u => u.c.c === 'book');
  if (bookCmd) {
    inp.value = ''; autosize(); updateCmdBar();
    bookSheet({ topic: base, pages: bookCmd.n || 100 });
    return;
  }
  // very big page request typed in plain words -> offer Bada PDF mode
  if (!used.length) {
    const big = detectBigPages(text);
    if (big && confirm(`${big} page ka PDF ek hi baar me nahi ban sakta.\n\n"Bada PDF" mode me banau? (10-10 page ke hisse me likhta hai aur sab jodkar ek PDF deta hai)`)) {
      inp.value = ''; autosize(); updateCmdBar();
      bookSheet({ topic: text, pages: big });
      return;
    }
  }
  const m = { id: uid(), role: 'user', text, files: S.atts.slice() };
  if (used.length) m.prompt = composePrompt(base, used, S.atts.length > 0);
  S.messages.push(m);
  renderUser(m);
  inp.value = '';
  autosize();
  updateCmdBar();
  S.atts = [];
  renderAtts();
  scrollBottom(true);
  await generate();
}

async function generate() {
  setBusy(true);
  const am = { id: uid(), role: 'assistant', text: '' };
  const w = addMsgEl('assistant');
  w.dataset.id = am.id;
  const md = $('.md', w);
  md.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
  scrollBottom(true);

  const ac = new AbortController();
  S.ac = ac;
  let full = '';
  let errText = '';
  let sources = null;
  let raf = 0;
  const paint = () => { raf = 0; const stick = nearBottom(); renderStreaming(md, full); if (stick) scrollBottom(true); };

  try {
    const res = await api('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ messages: buildPayload(), mood: S.mood, style: S.style, search: S.search })
    });
    if (!res.ok) throw await errFrom(res);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of ev.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let o; try { o = JSON.parse(line.slice(5)); } catch { continue; }
          if (o.t) { full += o.t; if (!raf) raf = requestAnimationFrame(paint); }
          else if (o.err) errText = o.err;
          else if (o.sources) sources = o.sources;
          else if (o.model) $('#modelTag').textContent = o.model;
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') errText = errText || e.message || 'Connection toot gaya. Dobara try karo.';
  } finally {
    if (raf) cancelAnimationFrame(raf);
    S.ac = null;
  }

  const aborted = ac.signal.aborted;
  am.text = full;
  if (full) {
    S.messages.push(am);
    renderFinal(md, full, !aborted && !errText);
    if (sources && sources.length) {
      const s = el('div', 'sources', '🌐 Sources: ' + sources.map(x => `<a href="${esc(x.uri)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>`).join(' '));
      $('.extra', w).appendChild(s);
    }
    addAssistantMeta(w, am);
    if (/```(python|py)\b/i.test(full)) setTimeout(() => loadPyodideOnce().catch(() => {}), 400);
  } else {
    md.innerHTML = '';
  }
  if (errText) {
    $('.extra', w).appendChild(el('div', 'err-box', '⚠️ ' + esc(errText)));
  } else if (aborted && !full) {
    md.textContent = '⏹ Roka gaya.';
  }
  setBusy(false);
  saveChat();
  scrollBottom(true);
}

function regenerate(m) {
  if (S.busy) return;
  const i = S.messages.findIndex(x => x.id === m.id);
  if (i < 0) return;
  S.messages.splice(i);
  rerenderAll(false);
  generate();
}

/* ============================================================ persistence + history (IndexedDB) */
let dbP = null;
function idb() {
  if (dbP) return dbP;
  dbP = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('no idb'));
    const r = indexedDB.open('psai', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      ['chats', 'books'].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); });
      if (!d.objectStoreNames.contains('imgs')) d.createObjectStore('imgs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  dbP.catch(() => { dbP = null; });
  return dbP;
}
function dbReq(store, mode, fn) {
  return idb().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    let rq;
    try { rq = fn(t.objectStore(store)); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(rq ? rq.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const dbGet = (s, k) => dbReq(s, 'readonly', st => st.get(k)).catch(() => undefined);
const dbPut = (s, v, k) => dbReq(s, 'readwrite', st => (k === undefined ? st.put(v) : st.put(v, k))).catch(() => undefined);
const dbDel = (s, k) => dbReq(s, 'readwrite', st => st.delete(k)).catch(() => undefined);
const dbAll = (s) => dbReq(s, 'readonly', st => st.getAll()).then(r => r || []).catch(() => []);

let saveTimer = 0;
function cleanMsg(m) {
  const o = { id: m.id, role: m.role, text: m.text || '' };
  if (m.prompt) o.prompt = m.prompt;
  if (m.files && m.files.length) o.files = m.files.map(f => ({ name: f.name }));
  if (m.book) o.book = m.book;
  return o;
}
function autoTitle() {
  const m = S.messages.find(x => x.role === 'user' && x.text);
  if (!m) return 'Naya chat';
  const t = m.text.replace(/(^|\s)\/[a-z0-9]+/gi, ' ').replace(/\s+/g, ' ').trim() || m.text;
  return t.slice(0, 48);
}
function saveChat() { clearTimeout(saveTimer); saveTimer = setTimeout(flushChat, 350); }
async function flushChat() {
  clearTimeout(saveTimer);
  if (!S.messages.length) return;
  if (!S.title) S.title = autoTitle();
  if (!S.created) S.created = Date.now();
  const rec = { id: S.chatId, title: S.title, pinned: !!S.pinned, created: S.created, updated: Date.now(), messages: S.messages.map(cleanMsg) };
  const ok = await dbPut('chats', rec);
  if (ok === undefined) LS.set('chat_fallback', rec.messages.slice(-30));
  LS.set('lastChat', S.chatId);
}
window.addEventListener('pagehide', () => { flushChat(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushChat(); });

async function renderBookMsg(m, w) {
  const md = $('.md', w);
  md.textContent = '📚 ' + m.book.title + ' …';
  const rec = await dbGet('books', m.book.id);
  if (!rec) { md.textContent = '📚 ' + m.book.title + ' — PDF file is device se hat chuki hai (history sirf text bachati hai). Dobara banao.'; return; }
  const d = { id: 'd' + (++docSeq), name: rec.name, html: null, blob: rec.blob, pdfDoc: null, book: { id: rec.id, parts: rec.parts, cfg: rec.cfg } };
  docs.set(d.id, d);
  md.textContent = '';
  md.appendChild(makeBookCard(d));
}
function rerenderAll(auto) {
  msgsEl.innerHTML = '';
  $('#welcome').style.display = S.messages.length ? 'none' : '';
  for (const m of S.messages) {
    if (m.role === 'user') renderUser(m);
    else if (m.book) { const w = addMsgEl('assistant'); w.dataset.id = m.id; renderBookMsg(m, w); }
    else renderAssistantFinal(m, !!auto);
  }
}
function setChat(rec) {
  if (S.busy && S.ac) S.ac.abort();
  S.chatId = rec ? rec.id : uid();
  S.title = rec ? rec.title : '';
  S.pinned = rec ? !!rec.pinned : false;
  S.created = rec ? rec.created : 0;
  S.messages = rec ? rec.messages.map(m => Object.assign({}, m, { files: m.files || [] })) : [];
  S.atts = [];
  docs.clear();
  rerenderAll(false);
  renderAtts();
  if (S.messages.length) setTimeout(() => scrollBottom(true), 60);
  LS.set('lastChat', S.chatId);
}
async function loadChat() {
  const all = await dbAll('chats');
  if (!all.length) {
    const legacy = LS.get('chat', null) || LS.get('chat_fallback', null);
    if (legacy && legacy.length) {
      setChat({ id: uid(), title: '', pinned: false, created: Date.now(), messages: legacy.filter(m => m && (m.role === 'user' || m.role === 'assistant')).map(m => ({ id: uid(), role: m.role, text: m.text || '', files: m.files || [] })) });
      LS.del('chat');
      flushChat();
    } else setChat(null);
    return;
  }
  const last = LS.get('lastChat', '');
  const rec = all.find(c => c.id === last) || all.sort((a, b) => b.updated - a.updated)[0];
  setChat(rec);
}
async function newChat(silent) {
  await flushChat();
  setChat(null);
  closeSheet();
  if (!silent) toast('Naya chat shuru');
}
async function openChat(id) {
  await flushChat();
  const rec = await dbGet('chats', id);
  if (!rec) { toast('Ye chat nahi mili', true); return; }
  setChat(rec);
  closeSheet();
}

function historySheet() {
  flushChat().then(() => {
    openSheet('💬 Purani baatein', (b) => {
      const nb = el('button', 'primary-sm', '＋ Naya chat');
      nb.style.cssText = 'width:100%;margin-bottom:10px';
      nb.onclick = () => newChat();
      const q = el('input', 'search-in'); q.placeholder = '🔎 Chat me dhundo…';
      const list = el('div');
      b.append(nb, q, list);
      let all = [];
      const fmt = (t) => { try { return new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
      const draw = () => {
        const term = q.value.trim().toLowerCase();
        let arr = all.filter(c => !term || (c.title || '').toLowerCase().includes(term) || c.messages.some(m => (m.text || '').toLowerCase().includes(term)));
        arr.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
        list.innerHTML = '';
        if (!arr.length) { list.appendChild(el('div', 'note', term ? 'Kuch nahi mila.' : 'Abhi koi purani chat nahi. Baat shuru karo — apne-aap yahin save hogi.')); return; }
        let lastGrp = '';
        arr.forEach(c => {
          const grp = c.pinned ? '📌 Pinned' : 'Baaki chats';
          if (grp !== lastGrp) { list.appendChild(el('div', 'grp', grp)); lastGrp = grp; }
          const row = el('div', 'hist-item' + (c.id === S.chatId ? ' cur' : ''));
          const t = el('button', 't', `<b>${esc(c.title || 'Chat')}</b><small>${fmt(c.updated)} • ${c.messages.length} msg</small>`);
          t.onclick = () => openChat(c.id);
          const pin = el('button', 'mini' + (c.pinned ? ' on' : ''), '📌');
          pin.title = 'Pin / Unpin';
          pin.onclick = async (e) => { e.stopPropagation(); c.pinned = !c.pinned; await dbPut('chats', c); if (c.id === S.chatId) S.pinned = c.pinned; draw(); toast(c.pinned ? 'Pin ho gayi 📌' : 'Unpin ho gayi'); };
          const ren = el('button', 'mini', '✏️');
          ren.onclick = async (e) => { e.stopPropagation(); const n = prompt('Chat ka naya naam:', c.title || ''); if (n && n.trim()) { c.title = n.trim().slice(0, 80); await dbPut('chats', c); if (c.id === S.chatId) S.title = c.title; draw(); } };
          const del = el('button', 'mini', '🗑');
          del.onclick = async (e) => {
            e.stopPropagation();
            if (!confirm('Ye chat hamesha ke liye hata du?')) return;
            for (const m of c.messages) if (m.book) await dbDel('books', m.book.id);
            await dbDel('chats', c.id);
            all = all.filter(x => x.id !== c.id);
            if (c.id === S.chatId) { setChat(null); }
            draw();
          };
          row.append(t, pin, ren, del);
          list.appendChild(row);
        });
      };
      q.oninput = draw;
      dbAll('chats').then(a => { all = a; draw(); });
    });
  });
}

/* ============================================================ attachments */
function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new Error('File padhi nahi gayi'));
    r.readAsDataURL(file);
  });
}
async function imageToJpegB64(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Photo padhi nahi gayi: ' + (file.name || 'image')));
      i.src = url;
    });
    let w = img.naturalWidth, h = img.naturalHeight;
    const k = Math.min(1, max / Math.max(w, h));
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}
const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'html', 'htm', 'js', 'py', 'css', 'xml', 'log'];
async function readAttachment(f) {
  const name = f.name || 'file';
  const type = f.type || '';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (type.startsWith('image/')) return { name, mime: 'image/jpeg', data: await imageToJpegB64(f, 2000) };
  if (type === 'application/pdf' || ext === 'pdf') {
    if (f.size > 18 * 1048576) throw new Error('PDF 18 MB se chhoti honi chahiye');
    return { name, mime: 'application/pdf', data: await fileToB64(f) };
  }
  if (type.startsWith('text/') || TEXT_EXT.includes(ext)) {
    const text = await f.text();
    if (text.length > 400000) throw new Error('Text file bahut badi hai');
    return { name, text };
  }
  throw new Error('Ye file type support nahi hai: ' + name + ' (PDF, photo ya text file chalti hai)');
}
async function addFiles(list) {
  for (const f of list) {
    if (S.atts.length >= 6) { toast('Ek baar me max 6 files', true); break; }
    try { S.atts.push(await readAttachment(f)); } catch (e) { toast(e.message, true); }
  }
  renderAtts();
}
function renderAtts() {
  const row = $('#attachRow');
  row.innerHTML = '';
  S.atts.forEach((a, i) => {
    const c = el('div', 'att', `<span>${a.mime === 'application/pdf' ? '📕' : a.mime ? '🖼' : '📄'} ${esc(a.name)}</span>`);
    const x = el('button', '', '✕');
    x.onclick = () => { S.atts.splice(i, 1); renderAtts(); };
    c.appendChild(x);
    row.appendChild(c);
  });
}
$('#btnAttach').onclick = () => $('#fileInput').click();
$('#fileInput').addEventListener('change', (e) => { const l = [...e.target.files]; e.target.value = ''; addFiles(l); });

/* ============================================================ voice: mic + read aloud */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function toggleMic() {
  if (!SR) { toast('Is browser me mic support nahi hai. Chrome use karo.', true); return; }
  if (rec) { try { rec.stop(); } catch { /* ignore */ } return; }
  const inp = $('#input');
  const r = new SR();
  rec = r;
  r.lang = LS.get('micLang', 'hi-IN');
  r.interimResults = true;
  r.continuous = false;
  const base = inp.value;
  let fin = '';
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) fin += res[0].transcript; else interim += res[0].transcript;
    }
    inp.value = (base ? base + ' ' : '') + fin + interim;
    autosize();
  };
  r.onend = () => { rec = null; $('#btnMic').classList.remove('rec'); };
  r.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Mic error: ' + e.error, true); };
  try { r.start(); $('#btnMic').classList.add('rec'); } catch { rec = null; }
}
$('#btnMic').onclick = toggleMic;

let voices = [];
function loadVoices() { try { voices = speechSynthesis.getVoices() || []; } catch { voices = []; } }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function pickVoice() {
  const saved = LS.get('voice', '');
  if (saved) { const v = voices.find(x => x.name === saved); if (v) return v; }
  const hi = voices.filter(v => /^hi/i.test(v.lang));
  const pool = hi.length ? hi : voices.filter(v => /^en-IN/i.test(v.lang));
  const male = pool.find(v => /male|madhur|hemant|prabhat|ravi|kunal|rishi|aman|ankur/i.test(v.name) && !/female/i.test(v.name));
  return male || pool[0] || null;
}
let speaking = false;
function speakToggle(text) {
  if (!('speechSynthesis' in window)) { toast('Is browser me read-aloud nahi hai', true); return; }
  if (speaking) { speechSynthesis.cancel(); speaking = false; return; }
  const clean = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_>|~-]{1,}/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!clean) { toast('Sunane layak text nahi hai'); return; }
  const chunks = clean.match(/[^।.!?\n]{1,170}[।.!?]?/g) || [clean];
  const v = pickVoice();
  speaking = true;
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c.trim());
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'hi-IN';
    u.rate = LS.get('rate', 1);
    u.pitch = LS.get('pitch', 0.85);
    if (i === chunks.length - 1) u.onend = () => { speaking = false; };
    u.onerror = () => { speaking = false; };
    speechSynthesis.speak(u);
  });
}

/* ============================================================ composer + header */
const inputEl = $('#input');
function autosize() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(150, inputEl.scrollHeight) + 'px'; }
inputEl.addEventListener('input', autosize);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); send(); }
});
$('#btnSend').onclick = send;
$('#chkSearch').checked = !!S.search;
$('#chkSearch').addEventListener('change', (e) => { S.search = e.target.checked; LS.set('search', S.search); toast(S.search ? '🌐 Live search ON' : 'Live search OFF'); });

function updateChips() {
  const m = (S.cfg.moods.length ? S.cfg.moods : FALLBACK_MOODS).find(x => x.id === S.mood) || FALLBACK_MOODS[0];
  const s = (S.cfg.styles.length ? S.cfg.styles : FALLBACK_STYLES).find(x => x.id === S.style) || FALLBACK_STYLES[0];
  $('#btnMood').textContent = m.emoji + ' ' + m.name;
  $('#btnStyle').textContent = s.emoji + ' ' + s.name;
}

/* ---------- sheets ---------- */
function openSheet(title, build) {
  $('#sheetTitle').textContent = title;
  const b = $('#sheetBody');
  b.innerHTML = '';
  build(b);
  openOv('sheet');
}
function closeSheet() { closeOv('sheet'); }
$('#sheetClose').onclick = closeSheet;
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

function moodSheet() {
  openSheet('Mood chuno — AI isi andaaz me baat karega', (b) => {
    const g = el('div', 'grid2');
    (S.cfg.moods.length ? S.cfg.moods : FALLBACK_MOODS).forEach(m => {
      const o = el('button', 'opt' + (m.id === S.mood ? ' sel' : ''), `<b>${m.emoji} ${esc(m.name)}</b><small>${esc(m.desc || '')}</small>`);
      o.onclick = () => { S.mood = m.id; LS.set('mood', m.id); updateChips(); closeSheet(); toast('Mood: ' + m.name); };
      g.appendChild(o);
    });
    b.appendChild(g);
  });
}
function styleSheet() {
  openSheet('PDF design style', (b) => {
    b.appendChild(el('div', 'note', 'AI naye PDF isi style me banayega. Chaho to chat me khud bhi likh sakte ho (jaise "dark gold wala").'));
    const g = el('div', 'grid2');
    (S.cfg.styles.length ? S.cfg.styles : FALLBACK_STYLES).forEach(s => {
      const o = el('button', 'opt' + (s.id === S.style ? ' sel' : ''), `<b>${s.emoji} ${esc(s.name)}</b><div class="sw" style="background:linear-gradient(90deg,${s.colors[0]},${s.colors[1]})"></div>`);
      o.onclick = () => { S.style = s.id; LS.set('style', s.id); updateChips(); closeSheet(); toast('Style: ' + s.name); };
      g.appendChild(o);
    });
    b.appendChild(g);
  });
}
function menuSheet() {
  openSheet('Menu', (b) => {
    const item = (em, t, d, fn) => {
      const x = el('button', 'list-btn', `<span class="em">${em}</span><span><b>${t}</b><small>${d}</small></span>`);
      x.onclick = fn; b.appendChild(x);
    };
    item('📖', 'Guide aur 30+ Commands', 'Kaise bolna hai, /notes /mcq /subah /book …', guideSheet);
    item('📚', 'Bada PDF / Book (20–200 page)', '10-10 page ke hisse me, ek PDF me jod kar', () => bookSheet());
    item('🧰', 'PDF Tools', 'Merge, pages hatao, rotate, watermark, photo→PDF…', toolsSheet);
    item('📕', 'Purani PDF ko editable banao', 'PDF attach karo, AI use HTML me badal dega', () => {
      closeSheet(); $('#input').value = 'Is PDF ko bilkul same design me editable banao.'; autosize(); $('#fileInput').click();
    });
    item('⚙️', 'Settings', 'Awaaz, mic bhasha, password', settingsSheet);
    item('💬', 'Purani baatein (History)', 'Saari chats, pin, rename, delete', historySheet);
    item('➕', 'Naya chat', 'Purani chat history me save rehti hai', () => newChat());
  });
}
$('#btnMood').onclick = moodSheet;
$('#btnStyle').onclick = styleSheet;
$('#btnMenu').onclick = menuSheet;

function settingsSheet() {
  openSheet('Settings', (b) => {
    const th = el('div', 'field', '<label>🎛 Theme</label>');
    const ts = el('select');
    [['hacker', '💀 Hacker (Matrix) — default'], ['neon', '🟣 Neon Purple (purana)']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; if (document.documentElement.getAttribute('data-theme') === v) o.selected = true; ts.appendChild(o); });
    ts.onchange = () => { LS.set('theme', ts.value); applyTheme(ts.value); toast('Theme badal gayi'); };
    th.appendChild(ts); b.appendChild(th);

    const mic = el('div', 'field', '<label>🎤 Mic ki bhasha</label>');
    const sel = el('select');
    [['hi-IN', 'Hindi (hi-IN)'], ['en-IN', 'English India (en-IN)'], ['en-US', 'English US']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; if (LS.get('micLang', 'hi-IN') === v) o.selected = true; sel.appendChild(o); });
    sel.onchange = () => LS.set('micLang', sel.value);
    mic.appendChild(sel); b.appendChild(mic);

    loadVoices();
    const vf = el('div', 'field', '<label>🔊 Read-aloud awaaz (phone par jo voices hain wahi dikhengi)</label>');
    const vs = el('select');
    const auto = el('option', '', 'Auto (male / Hindi pasand)'); auto.value = ''; vs.appendChild(auto);
    voices.filter(v => /^(hi|en-IN)/i.test(v.lang)).forEach(v => { const o = el('option', '', `${v.name} (${v.lang})`); o.value = v.name; if (LS.get('voice', '') === v.name) o.selected = true; vs.appendChild(o); });
    vs.onchange = () => LS.set('voice', vs.value);
    vf.appendChild(vs); b.appendChild(vf);

    const rate = el('div', 'field', '<label>Speed</label>');
    const r1 = el('input'); r1.type = 'range'; r1.min = '0.6'; r1.max = '1.5'; r1.step = '0.05'; r1.value = LS.get('rate', 1);
    r1.oninput = () => LS.set('rate', +r1.value); rate.appendChild(r1); b.appendChild(rate);
    const pitch = el('div', 'field', '<label>Awaaz ki gehraai (kam = bhaari / male jaisi)</label>');
    const p1 = el('input'); p1.type = 'range'; p1.min = '0.5'; p1.max = '1.5'; p1.step = '0.05'; p1.value = LS.get('pitch', 0.85);
    p1.oninput = () => LS.set('pitch', +p1.value); pitch.appendChild(p1); b.appendChild(pitch);
    const test = el('button', 'primary-sm', '▶ Awaaz test karo');
    test.onclick = () => { if (speaking) { speechSynthesis.cancel(); speaking = false; } speakToggle('Namaste! Main aapka AI dost hoon. Bataiye, aaj kya banayein?'); };
    b.appendChild(test);

    if (S.cfg.needsPassword) {
      const pf = el('div', 'field', '<label>🔒 App password</label>');
      const pi = el('input'); pi.type = 'password'; pi.value = S.pw; pi.placeholder = 'Password';
      pi.onchange = () => { S.pw = pi.value; LS.set('pw', S.pw); toast('Password save'); };
      pf.appendChild(pi); b.appendChild(pf);
    }
    b.appendChild(el('div', 'note', 'Model: ' + esc((S.cfg.models || []).join(' → ') || '—') + '<br>API key sirf server par rehti hai, is phone me kabhi nahi aati.'));
  });
}

/* ============================================================ PDF tools */
const TOOLS = [
  { id: 'images', em: '📷', name: 'Photos → PDF', desc: 'Copy/notes ki photos se PDF banao', multi: true, accept: 'image/*', kind: 'image',
    fields: [{ k: 'fit', t: 'select', label: 'Page', opts: [['cover-page', 'A4 page me fit'], ['contain', 'Photo jitna hi bada page']] }] },
  { id: 'merge', em: '🧩', name: 'PDF jodo (Merge)', desc: 'Kai PDF ko ek me milao', multi: true, accept: 'application/pdf', fields: [] },
  { id: 'extract', em: '✂️', name: 'Pages nikalo', desc: 'Sirf chune hue pages ki nayi PDF', accept: 'application/pdf',
    fields: [{ k: 'range', t: 'text', label: 'Kaun se pages? (jaise 1-3,5,8-)', ph: '1-3,5' }] },
  { id: 'delete', em: '🗑', name: 'Pages hatao', desc: 'Faltu pages delete karo', accept: 'application/pdf',
    fields: [{ k: 'range', t: 'text', label: 'Kaun se pages hatane hain? (jaise 2,4-6)', ph: '2,4-6' }] },
  { id: 'reorder', em: '🔀', name: 'Pages ka order badlo', desc: 'Naya order likho', accept: 'application/pdf',
    fields: [{ k: 'range', t: 'text', label: 'Naya order (jaise 3,1,2)', ph: '3,1,2' }] },
  { id: 'rotate', em: '🔄', name: 'Rotate karo', desc: 'Tedhe pages seedhe karo', accept: 'application/pdf',
    fields: [{ k: 'range', t: 'text', label: 'Pages (khali = sab)', ph: 'sab' }, { k: 'angle', t: 'select', label: 'Kitna ghumana hai', opts: [['90', '90° seedha'], ['180', '180°'], ['270', '90° ulta']] }] },
  { id: 'pagenumbers', em: '🔢', name: 'Page number lagao', desc: 'Har page par number', accept: 'application/pdf',
    fields: [{ k: 'position', t: 'select', label: 'Kahan', opts: [['bottom-center', 'Neeche beech me'], ['bottom-right', 'Neeche right'], ['bottom-left', 'Neeche left'], ['top-center', 'Upar beech me'], ['top-right', 'Upar right']] },
      { k: 'format', t: 'text', label: 'Format ({n} = number, {total} = kul pages)', val: 'Page {n} of {total}' },
      { k: 'color', t: 'color', label: 'Rang', val: '#444444' }] },
  { id: 'watermark', em: '💧', name: 'Watermark lagao', desc: 'Hindi/English text, tedha ya poore page par', accept: 'application/pdf',
    fields: [{ k: 'text', t: 'text', label: 'Watermark text', ph: 'CONFIDENTIAL / गोपनीय' },
      { k: 'mode', t: 'select', label: 'Style', opts: [['center', 'Beech me bada'], ['tile', 'Poore page par bar-bar']] },
      { k: 'opacity', t: 'range', label: 'Halka ↔ Gehra', min: 0.05, max: 0.7, step: 0.01, val: 0.2 },
      { k: 'color', t: 'color', label: 'Rang', val: '#888888' }] },
  { id: 'stamp', em: '🖋', name: 'Text likho (Stamp)', desc: 'Naam, date, heading — kisi bhi jagah (Hindi bhi)', accept: 'application/pdf',
    fields: [{ k: 'text', t: 'text', label: 'Kya likhna hai', ph: 'Naam: ___   Roll No: ___' },
      { k: 'position', t: 'select', label: 'Kahan', opts: [['top-center', 'Upar beech me'], ['top-left', 'Upar left'], ['top-right', 'Upar right'], ['center', 'Beech me'], ['bottom-center', 'Neeche beech me'], ['bottom-left', 'Neeche left'], ['bottom-right', 'Neeche right']] },
      { k: 'size', t: 'number', label: 'Size', val: 14 },
      { k: 'color', t: 'color', label: 'Text rang', val: '#111111' },
      { k: 'range', t: 'text', label: 'Pages (khali = sab)', ph: 'sab' }] }
];

function toolsSheet() {
  openSheet('🧰 PDF Tools', (b) => {
    b.appendChild(el('div', 'note', 'Apni purani PDF par kaam karo. Result yahin chat ke viewer me khulega.'));
    TOOLS.forEach(t => {
      const x = el('button', 'list-btn', `<span class="em">${t.em}</span><span><b>${t.name}</b><small>${t.desc}</small></span>`);
      x.onclick = () => toolForm(t);
      b.appendChild(x);
    });
  });
}
function toolForm(t) {
  openSheet(t.em + ' ' + t.name, (b) => {
    let files = [];
    const box = el('div', 'filebox', t.multi ? '📂 File(s) chuno (tap karo)' : '📂 PDF chuno (tap karo)');
    const list = el('div', 'filelist');
    const inp = el('input'); inp.type = 'file'; inp.accept = t.accept; inp.multiple = !!t.multi; inp.hidden = true;
    box.onclick = () => inp.click();
    inp.onchange = () => { files = [...inp.files]; list.textContent = files.map(f => f.name + ' (' + fmtSize(f.size) + ')').join(', '); };
    b.append(box, inp, list);
    const getters = {};
    t.fields.forEach(f => {
      const wrap = el('div', 'field', `<label>${esc(f.label)}</label>`);
      let c;
      if (f.t === 'select') { c = el('select'); f.opts.forEach(([v, n]) => { const o = el('option', '', n); o.value = v; c.appendChild(o); }); }
      else { c = el('input'); c.type = f.t === 'color' ? 'color' : f.t === 'range' ? 'range' : f.t === 'number' ? 'number' : 'text'; if (f.ph) c.placeholder = f.ph; if (f.val != null) c.value = f.val; if (f.t === 'range') { c.min = f.min; c.max = f.max; c.step = f.step; } }
      wrap.appendChild(c); b.appendChild(wrap);
      getters[f.k] = () => c.value;
    });
    const go = el('button', 'primary', 'Banao ✨');
    go.style.cssText = 'width:100%;margin-top:12px';
    go.onclick = async () => {
      if (!files.length) { toast('Pehle file chuno', true); return; }
      if (t.multi === true && t.id === 'merge' && files.length < 2) { toast('Merge ke liye 2 ya zyada PDF chuno', true); return; }
      go.disabled = true; go.textContent = 'Ban raha hai…';
      try {
        const payloadFiles = [];
        for (const f of files) {
          payloadFiles.push({ name: f.name, data: t.kind === 'image' ? await imageToJpegB64(f, 2400) : await fileToB64(f) });
        }
        const params = {};
        Object.keys(getters).forEach(k => { params[k] = getters[k](); });
        const r = await api('/api/pdf/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: t.id, files: payloadFiles, params }) });
        if (!r.ok) throw await errFrom(r);
        const blob = await r.blob();
        const d = { id: 'd' + (++docSeq), name: t.name.replace(/[^\wऀ-ॿ ]+/g, '').trim() + ' result', html: null, blob, pdfDoc: null };
        docs.set(d.id, d);
        closeSheet();
        setTimeout(() => openViewer(d), 160);
      } catch (e) { toast(e.message || 'Nahi ho paya', true); }
      finally { go.disabled = false; go.textContent = 'Banao ✨'; }
    };
    b.appendChild(go);
    const back = el('button', 'list-btn', '<span class="em">←</span><span><b>Wapas</b></span>');
    back.style.marginTop = '10px';
    back.onclick = toolsSheet;
    b.appendChild(back);
  });
}


/* ============================================================ BOOK MODE (50-200 pages) */
async function streamText(payload, signal) {
  const res = await api('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(payload) });
  if (!res.ok) throw await errFrom(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '', err = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of ev.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let o; try { o = JSON.parse(line.slice(5)); } catch { continue; }
        if (o.t) full += o.t; else if (o.err) err = o.err;
      }
    }
  }
  if (!full.trim()) throw new Error(err || 'AI ne jawab nahi diya');
  const cut = full.indexOf('\n\n> ⚠️ Jawab bahut lamba');
  return cut >= 0 ? full.slice(0, cut) : full;
}
async function withRetry(fn, signal, tries) {
  let last;
  for (let i = 0; i < (tries || 3); i++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try { return await fn(i); } catch (e) {
      if (e.name === 'AbortError') throw e;
      last = e;
      if (i < (tries || 3) - 1) await sleepAbortable(12000 * (i + 1), signal);
    }
  }
  throw last;
}
function sleepAbortable(ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}
function extractHtml(txt) {
  const m = /```html\s*\n([\s\S]*?)(```|$)/i.exec(txt);
  return (m ? m[1] : txt).trim();
}
function splitDoc(html) {
  html = html.replace(/^\s*<!--\s*PDF\s*:[\s\S]*?-->\s*/i, '');
  const m = /^([\s\S]*?<body[^>]*>)([\s\S]*?)(<\/body>[\s\S]*)$/i.exec(html);
  if (m) return { head: m[1], body: m[2] };
  const st = (html.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n');
  const lk = (html.match(/<link[^>]*>/gi) || []).join('\n');
  return { head: `<!doctype html><html lang="hi"><head><meta charset="utf-8">${lk}${st}</head><body>`, body: html };
}
function sectionsOnly(txt) {
  const i = txt.search(/<section/i);
  const j = txt.toLowerCase().lastIndexOf('</section>');
  return i >= 0 && j > i ? txt.slice(i, j + 10) : '';
}
const countSections = (h) => (String(h).match(/<section\b/gi) || []).length;

function normalizeOutline(o, total, per) {
  per = per || 10;
  const lo = Math.min(3, per);
  if (!o || !Array.isArray(o.parts) || !o.parts.length) throw new Error('Khaka (outline) sahi nahi bana');
  let parts = o.parts.slice(0, 60).map((p, i) => ({
    title: String(p.title || ('Part ' + (i + 1))).slice(0, 120),
    brief: String(p.brief || '').slice(0, 400),
    pages: Math.min(per, Math.max(lo, Math.round(Number(p.pages) || per)))
  }));
  let sum = parts.reduce((n, p) => n + p.pages, 0);
  let guard = 0;
  while (sum !== total && guard++ < 5000) {
    const idx = guard % parts.length;
    if (sum < total && parts[idx].pages < per) { parts[idx].pages++; sum++; }
    else if (sum > total && parts[idx].pages > lo) { parts[idx].pages--; sum--; }
    else if (sum < total && parts.every(p => p.pages >= per)) { const n = Math.min(per, total - sum); parts.push({ title: 'Part ' + (parts.length + 1), brief: 'Aage ka vishay', pages: n }); sum += n; }
    else if (sum > total && parts.every(p => p.pages <= lo)) { sum -= parts.pop().pages; }
  }
  return { title: String(o.title || 'Document').slice(0, 100), parts };
}

function blobToB64(blob) { return fileToB64(blob); }
async function toolMerge(blobs, numbers) {
  const files = [];
  for (const b of blobs) files.push({ data: await blobToB64(b) });
  let blob = blobs[0];
  if (blobs.length > 1) {
    const r = await api('/api/pdf/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'merge', files }) });
    if (!r.ok) throw await errFrom(r);
    blob = await r.blob();
  }
  if (numbers) {
    const r2 = await api('/api/pdf/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'pagenumbers', files: [{ data: await blobToB64(blob) }], params: { format: '{n}', position: 'bottom-center', size: 9, color: '#777777', skipFirst: true } }) });
    if (r2.ok) blob = await r2.blob();
  }
  return blob;
}
async function renderHtmlBlob(html) {
  const r = await api('/api/pdf/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html }) });
  if (!r.ok) throw await errFrom(r);
  return r.blob();
}

let bookRun = null;
function bookSheet(preset) {
  preset = preset || {};
  openSheet('📚 Bada PDF / Book (20–200 page)', (b) => {
    b.appendChild(el('div', 'note', 'AI pehle poori book ka khaka banata hai, phir 10-10 page ke hisse ek-ek karke likhta hai (design sab me ek jaisa) aur ऐप sab jodkar ek PDF bana deta hai. <b>Bada kaam hai:</b> 100 page me kareeb 15–30 minute lag sakte hain. Is dauraan ye page khula rakho aur screen band mat karo.'));
    const f1 = el('div', 'field', '<label>Kis vishay par? Kya-kya chahiye? (jitna detail utna accha)</label>');
    const topic = el('textarea'); topic.rows = 4; topic.placeholder = 'Jaise: Class 8 Science ki poori book ke notes, har chapter me hard words, 10 MCQ aur answer key';
    if (preset.topic) topic.value = preset.topic;
    topic.style.cssText = 'width:100%;padding:11px 12px;border-radius:12px;background:var(--card);border:1px solid var(--line);outline:0;font-size:16px;resize:vertical';
    f1.appendChild(topic); b.appendChild(f1);
    const f2 = el('div', 'field', '<label>Kitne page?</label>');
    const pages = el('input'); pages.type = 'number'; pages.min = '20'; pages.max = '200'; pages.value = String(Math.min(200, Math.max(20, preset.pages || 100)));
    f2.appendChild(pages); b.appendChild(f2);
    const fp = el('div', 'field', '<label>Ek baar me kitne page likhe (hissa)?</label>');
    const per = el('select');
    [['10 page (best)', '10'], ['8 page', '8'], ['6 page (kam error)', '6']].forEach(([n, v]) => { const o = el('option', '', n); o.value = v; per.appendChild(o); });
    fp.appendChild(per); b.appendChild(fp);
    const f3 = el('div', 'field', '<label>Bhasha</label>');
    const lang = el('select');
    [['Hindi (Devanagari)', 'Hindi'], ['English', 'English'], ['Hinglish (Roman Hindi)', 'Hinglish']].forEach(([n, v]) => { const o = el('option', '', n); o.value = v; lang.appendChild(o); });
    f3.appendChild(lang); b.appendChild(f3);
    const f4 = el('label', 'tgl'); f4.style.margin = '6px 0 10px';
    const num = el('input'); num.type = 'checkbox'; num.checked = true;
    f4.append(num, el('span', '', ' Page number lagao'));
    b.appendChild(f4);
    const st = (S.cfg.styles.length ? S.cfg.styles : FALLBACK_STYLES).find(x => x.id === S.style) || FALLBACK_STYLES[0];
    b.appendChild(el('div', 'note', 'Design style: <b>' + esc(st.emoji + ' ' + st.name) + '</b> (upar 🪄 se badal sakte ho)'));
    const go = el('button', 'primary', 'Book banana shuru karo ✨');
    go.style.cssText = 'width:100%;margin-top:10px';
    go.onclick = () => {
      const t = topic.value.trim();
      const n = Math.round(Number(pages.value));
      if (t.length < 5) { toast('Vishay likho', true); return; }
      if (!(n >= 20 && n <= 200)) { toast('Page 20 se 200 ke beech rakho', true); return; }
      closeSheet();
      setTimeout(() => runBook({ topic: t, total: n, per: Number(per.value) || 10, lang: lang.value, numbers: num.checked }), 200);
    };
    b.appendChild(go);
  });
}

async function runBook(cfg) {
  if (S.busy || bookRun) { toast('Pehle chal raha kaam khatam hone do', true); return; }
  const um = { id: uid(), role: 'user', text: `📚 Bada PDF: ${cfg.total} page — ${cfg.topic}`, files: [] };
  S.messages.push(um); renderUser(um);
  const w = addMsgEl('assistant');
  const md = $('.md', w);
  const ac = new AbortController();
  const run = { ac, cancelled: false };
  bookRun = run;
  let wake = null;
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
  setBusy(true);
  const t0 = Date.now();
  const ui = (title, line, pct, extra) => {
    md.innerHTML = `<b>📚 ${esc(title)}</b><div class="note" style="margin:6px 0">${line}</div>
      <div style="height:8px;border-radius:6px;background:var(--card2);overflow:hidden"><div style="height:100%;width:${Math.max(2, pct)}%;background:var(--grad);transition:width .4s"></div></div>
      <div class="note">${Math.floor((Date.now() - t0) / 60000)} min ho gaye • screen khuli rakho</div>${extra || ''}`;
    scrollBottom(false);
  };
  const cancelBtn = '<div class="doc-actions" style="padding:8px 0 0"><button data-x="cancel">⏹ Roko</button></div>';
  md.addEventListener('click', (e) => { if (e.target.closest('[data-x=cancel]')) { run.cancelled = true; ac.abort(); } });

  const parts = [];
  let outline = null, headDoc = null, css = '';
  const renders = [];
  let title = 'Document';
  try {
    ui('Khaka bana raha hoon…', 'Poori book ke chapters tay ho rahe hain', 3, cancelBtn);
    const PER = cfg.per || 10;
    const K = Math.ceil(cfg.total / PER);
    const outTxt = await withRetry(async () => {
      const txt = await streamText({ task: 'outline', lang: cfg.lang, per: PER, messages: [{ role: 'user', text:
        `Vishay / instructions: ${cfg.topic}\nTOTAL pages: ${cfg.total}\nBhasha: ${cfg.lang}\nLagbhag ${K} parts banao (har part ${Math.max(3, PER - 2)}-${PER} page).` }] }, ac.signal);
      const a = txt.indexOf('{'), z = txt.lastIndexOf('}');
      return normalizeOutline(JSON.parse(txt.slice(a, z + 1)), cfg.total, PER);
    }, ac.signal);
    outline = outTxt;
    title = outline.title;
    const outlineText = outline.parts.map((p, i) => `${i + 1}. ${p.title} (${p.pages} page) — ${p.brief}`).join('\n');
    const prevTitles = [];

    for (let i = 0; i < outline.parts.length; i++) {
      const P = outline.parts[i];
      const donePages = outline.parts.slice(0, i).reduce((n, p) => n + p.pages, 0);
      const pct = 5 + Math.round(90 * donePages / cfg.total);
      ui(title, `Part ${i + 1}/${outline.parts.length}: <b>${esc(P.title)}</b> likh raha hai… (page ${donePages + 1}–${donePages + P.pages} / ${cfg.total})`, pct, cancelBtn);
      const common = `Poori book ka khaka:\n${outlineText}\n\n`;
      let html;
      if (i === 0) {
        const txt = await withRetry(async () => {
          const t = await streamText({ task: 'book1', style: S.style, lang: cfg.lang, per: PER, messages: [{ role: 'user', text:
            `Book ka vishay / instructions: ${cfg.topic}\nBook ka title: ${title}\n\n${common}Ab sirf PART 1 likho: "${P.title}" — ${P.brief}\nExactly ${P.pages} page (page 1 = cover). Bhasha: ${cfg.lang}.` }] }, ac.signal);
          const h = extractHtml(t);
          if (countSections(h) < Math.max(2, P.pages - 2)) throw new Error('Part 1 poora nahi aaya');
          return h;
        }, ac.signal);
        const sp = splitDoc(txt);
        headDoc = sp.head;
        css = (headDoc.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n').slice(0, 14000);
        html = headDoc + '\n' + sp.body + '\n</body></html>';
        P.sections = countSections(sp.body);
      } else {
        const frag = await withRetry(async () => {
          const t = await streamText({ task: 'bookN', lang: cfg.lang, per: PER, messages: [{ role: 'user', text:
            `Book ka vishay / instructions: ${cfg.topic}\nBook ka title: ${title}\n\n${common}Ab tak likhe hue parts: ${prevTitles.join(' | ')}\n\nCSS DESIGN SYSTEM (sirf yahi classes use karo):\n${css}\n\nAb sirf PART ${i + 1}/${outline.parts.length} likho: "${P.title}" — ${P.brief}\nExactly ${P.pages} <section class="page"> elements. Bhasha: ${cfg.lang}.` }] }, ac.signal);
          const s = sectionsOnly(extractHtml(t));
          if (countSections(s) < Math.max(2, P.pages - 2)) throw new Error('Part ' + (i + 1) + ' poora nahi aaya');
          return s;
        }, ac.signal);
        html = headDoc + '\n' + frag + '\n</body></html>';
        P.sections = countSections(frag);
      }
      prevTitles.push(P.title);
      const part = { title: P.title, html, blob: null, pages: P.sections };
      parts.push(part);
      renders.push(withRetry(async () => {
        try { part.html = await resolveImagesClient(part.html, ac.signal); } catch (e) { if (e.name === 'AbortError') throw e; }
        part.blob = await renderHtmlBlob(part.html);
      }, ac.signal, 2));
    }
    ui(title, 'Sab hisse likh liye. PDF jod raha hoon…', 96, cancelBtn);
    await Promise.all(renders);
    await finishBook(parts, title, cfg, w, md, t0, false);
  } catch (e) {
    if (e.name === 'AbortError' || run.cancelled) {
      await offerPartial(parts, renders, title, cfg, w, md, t0, 'Roka gaya.');
    } else {
      console.warn(e);
      await offerPartial(parts, renders, title, cfg, w, md, t0, 'Rukawat: ' + (e.message || 'error'));
    }
  } finally {
    try { if (wake) wake.release(); } catch { /* ignore */ }
    bookRun = null;
    setBusy(false);
  }
}

async function offerPartial(parts, renders, title, cfg, w, md, t0, why) {
  await Promise.allSettled(renders);
  const ok = parts.filter(p => p.blob);
  if (!ok.length) { md.innerHTML = `⚠️ ${esc(why)}<br>Koi hissa poora nahi bana. Thodi der baad dobara try karo.`; return; }
  const pg = ok.reduce((n, p) => n + p.pages, 0);
  md.innerHTML = `⚠️ ${esc(why)}<div class="note">${ok.length} hisse ready hain (~${pg} page). Inhe jodkar PDF bana du?</div>
    <div class="doc-actions" style="padding:8px 0 0"><button class="main" data-x="partial">✅ Ab tak ka PDF banao</button></div>`;
  md.querySelector('[data-x=partial]').onclick = async () => {
    md.querySelector('[data-x=partial]').disabled = true;
    try { await finishBook(ok, title, cfg, w, md, t0, true); } catch (e) { toast(e.message, true); }
  };
}

async function finishBook(parts, title, cfg, w, md, t0, partial) {
  const blob = await toolMerge(parts.map(p => p.blob), cfg.numbers);
  const bookId = uid();
  const d = { id: 'd' + (++docSeq), name: title, html: null, blob, pdfDoc: null, book: { id: bookId, parts, cfg } };
  docs.set(d.id, d);
  persistBook(d);
  md.innerHTML = '';
  const mins = Math.max(1, Math.round((Date.now() - t0) / 60000));
  const total = parts.reduce((n, p) => n + (p.pages || 0), 0);
  const note = el('div', '', `✅ ${partial ? 'Adhoora' : 'Poora'} PDF ban gaya (${parts.length} hisse, ~${total} page, ${mins} min). Asli page count viewer me dikhega.`);
  md.appendChild(note);
  md.appendChild(makeBookCard(d));
  const am = { id: uid(), role: 'assistant', text: `[Bada PDF "${title}" bana — ${total} page]`, book: { id: bookId, title, pages: total } };
  S.messages.push(am);
  saveChat();
  scrollBottom(true);
}

function persistBook(d) {
  const b = d.book;
  if (!b || !b.id) return;
  return dbPut('books', { id: b.id, name: d.name, blob: d.blob, cfg: b.cfg, parts: b.parts.map(p => ({ title: p.title, html: p.html, pages: p.pages, blob: p.blob })) });
}

function makeBookCard(d) {
  const c = el('div', 'doc-card');
  c.innerHTML = `
    <div class="doc-head"><span>📚</span><b>${esc(d.name)}</b><span class="badge">PDF</span></div>
    <div class="doc-sub" data-sub>Preview ban raha hai…</div>
    <div class="doc-preview"><div class="pv loading" data-pv></div></div>
    <div class="doc-actions">
      <button class="main" data-a="view">⛶ Poori dekho</button>
      <button data-a="dl">⬇ Download</button>
      <button data-a="share">📤 Share</button>
      <button data-a="pedit">✏️ Page edit</button>
    </div>`;
  c.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (a === 'make' || a === 'retry') return showPreview(d, c);
      if (a === 'share') return sharePdf(d);
      if (a === 'view') return openViewer(d);
      if (a === 'dl') return downloadBlob(d.blob, safeName(d.name) + '.pdf');
      if (a === 'pedit') return bookPartEdit(d, c);
    } catch (err) { toast(err.message || 'Kuch gadbad hui', true); }
  });
  $('[data-pv]', c).addEventListener('click', (e) => { if (d.blob && !e.target.closest('[data-a]')) openViewer(d); });
  setTimeout(() => showPreview(d, c), 0);
  return c;
}

function bookPartEdit(d, card) {
  const parts = d.book.parts;
  const total = parts.reduce((n, p) => n + (p.pages || 0), 0);
  const ans = prompt(`Kaun se page me badlav karna hai? (1 se ${total})\nWo page jis hisse me hai, wahi hissa (10 page tak) edit hoga.`);
  if (!ans) return;
  const n = Math.round(Number(ans));
  if (!(n >= 1 && n <= total)) { toast('Page number sahi likho', true); return; }
  let acc = 0, idx = 0;
  for (let i = 0; i < parts.length; i++) { if (n <= acc + (parts[i].pages || 0)) { idx = i; break; } acc += parts[i].pages || 0; idx = i; }
  const pd = { id: 'd' + (++docSeq), name: parts[idx].title, html: parts[idx].html, blob: null, pdfDoc: null };
  pd.onSave = async (html) => {
    const clean = html.replace(/^<!--PDF:[\s\S]*?-->\s*/, '');
    toast('Badlav save ho raha hai, PDF dobara ban rahi hai…');
    try {
      const blob = await renderHtmlBlob(clean);
      parts[idx].html = clean; parts[idx].blob = blob;
      d.blob = await toolMerge(parts.map(p => p.blob), d.book.cfg.numbers);
      d.pdfDoc = null;
      persistBook(d);
      await showPreview(d, card);
      toast('Update ho gaya ✅');
    } catch (e) { toast(e.message || 'Save nahi hua', true); }
  };
  openEditor(pd);
}

/* ============================================================ THEME (hacker) + matrix rain */
let mx = { on: false, raf: 0, resize: null };
function startMatrix() {
  const cv = $('#matrix');
  if (!cv || mx.on) return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  mx.on = true;
  const FS = 15;
  const chars = 'アイウエオカキクケコサシスセソタチツテト0123456789ABCDEF<>/{}[]=+*अआइईउऊएओकखगघचजटडतदनपबमयरलवशसह'.split('');
  let cols = 0, drops = [];
  mx.resize = () => {
    cv.width = window.innerWidth; cv.height = window.innerHeight;
    cols = Math.ceil(cv.width / FS);
    drops = Array.from({ length: cols }, () => Math.random() * cv.height / FS);
  };
  mx.resize();
  window.addEventListener('resize', mx.resize);
  let last = 0;
  const frame = (t) => {
    if (!mx.on) return;
    mx.raf = requestAnimationFrame(frame);
    if (document.hidden || t - last < 70) return;
    last = t;
    ctx.fillStyle = 'rgba(0,5,2,.14)';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.font = FS + 'px monospace';
    for (let i = 0; i < cols; i++) {
      const y = drops[i] * FS;
      ctx.fillStyle = Math.random() > 0.97 ? '#e6fff0' : '#00ff66';
      ctx.fillText(chars[(Math.random() * chars.length) | 0], i * FS, y);
      if (y > cv.height && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 1;
    }
  };
  mx.raf = requestAnimationFrame(frame);
}
function stopMatrix() {
  mx.on = false;
  cancelAnimationFrame(mx.raf);
  if (mx.resize) { window.removeEventListener('resize', mx.resize); mx.resize = null; }
  const cv = $('#matrix');
  if (cv && cv.getContext('2d')) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}
function applyTheme(t) {
  const th = t === 'neon' ? 'neon' : 'hacker';
  document.documentElement.setAttribute('data-theme', th);
  const mt = document.querySelector('meta[name=theme-color]');
  if (mt) mt.setAttribute('content', th === 'neon' ? '#0b0d17' : '#010502');
  if (th === 'hacker') startMatrix(); else stopMatrix();
}

/* ============================================================ SLASH COMMANDS + GUIDE */
const COMMANDS = [
  { c: 'notes', em: '📝', d: 'Chapter ke premium notes (PDF)', ex: 'Class 8 Science chapter 3 /notes',
    p: () => 'Make premium chapter-wise STUDY NOTES as a designed PDF (follow the PDF protocol): key points, definitions, formulas/laws in highlight boxes, simple diagrams (inline SVG), a hard-words table (word + simple meaning), "yaad rakho" boxes and a quick-revision box.' },
  { c: 'subah', alias: ['morning', 'revise'], em: '🌅', d: 'Subah ka quick revision: saare notes 1–2 page me', ex: 'Photosynthesis /subah',
    p: () => 'Create a "morning quick-revision" PDF: the WHOLE topic compressed into 1–2 clean pages — key points, formulas, definitions, dates/names, memory tricks and 5 self-test questions with answers. Optimised for a 10-minute read before the exam.' },
  { c: 'summary', em: '🧾', d: 'Chhota saaf summary (chat me)', ex: '<paste text> /summary',
    p: () => 'Give a short, clear SUMMARY in chat (max ~12 lines, bullets), in the same language as my text. No PDF unless I ask.' },
  { c: 'hardwords', em: '🔤', d: 'Mushkil shabd + arth + example', ex: 'chapter 5 /hardwords',
    p: () => 'List ALL hard / difficult words of the topic or text with a simple Hindi meaning, English meaning and a short example sentence, as a clean table (as a PDF when there are more than 15 words).' },
  { c: 'mcq', em: '✅', d: 'N MCQ + answer key (PDF)', ex: 'Light chapter /mcq 25', arg: 1, def: 10,
    p: (n) => `Create EXACTLY ${n} multiple-choice questions (options A–D) with an answer key and a one-line explanation for each answer, as an exam-style PDF. Number them 1…${n}.` },
  { c: 'paper', em: '📄', d: 'Question paper (marks ke saath)', ex: 'Class 10 Maths /paper 80', arg: 1, def: 40,
    p: (n) => `Create a complete QUESTION PAPER of ${n} marks as a PDF: school/test header box, class, subject, time, instructions, sections A/B/C/D with marks per question, and an answer key on the last page.` },
  { c: 'qna', em: '❓', d: 'Exactly N important sawal-jawab', ex: 'Chapter 3 /qna 20', arg: 1, def: 10,
    p: (n) => `Write EXACTLY ${n} important questions with model answers (numbered 1…${n}). PDF if more than 8.` },
  { c: 'short', em: '✍️', d: 'N short-answer (2 marks) sawal + jawab', ex: 'Chapter 2 /short 15', arg: 1, def: 10,
    p: (n) => `Write EXACTLY ${n} short-answer (2-mark) questions with crisp answers.` },
  { c: 'fill', em: '🕳️', d: 'Fill in the blanks + answers', ex: 'Chapter 4 /fill 20', arg: 1, def: 10,
    p: (n) => `Create EXACTLY ${n} fill-in-the-blank questions with the answer key.` },
  { c: 'match', em: '🔗', d: 'Match the following', ex: 'Chapter 6 /match 10', arg: 1, def: 8,
    p: (n) => `Create a "match the following" exercise with ${n} pairs (shuffled right column) and the answer key.` },
  { c: 'line2line', alias: ['linebyline'], em: '📖', d: 'Paath ka line-by-line Hindi arth', ex: '<paath paste karo> /line2line',
    p: () => 'Explain the given text LINE BY LINE: write each original line, then directly below it a simple Hindi explanation/meaning. Cover the ENTIRE text, skip nothing, keep the order. Use a PDF when the text is long.' },
  { c: 'explain', em: '💡', d: 'Aasaan bhasha me step-by-step samjhao', ex: 'Photosynthesis /explain',
    p: () => 'Explain it step by step in very simple language with everyday examples, one small analogy and a quick check-question at the end.' },
  { c: 'eli5', em: '🧒', d: '10 saal ke bachche ko jaise samjhao', ex: 'Black hole /eli5',
    p: () => 'Explain like I am 10 years old: tiny sentences, fun comparison, no jargon.' },
  { c: 'formula', em: '🧮', d: 'Formula / rules ki cheat sheet (PDF)', ex: 'Class 9 Maths /formula',
    p: () => 'Create a FORMULA / RULES cheat-sheet PDF: grouped by sub-topic, each formula in a highlighted box with a one-line meaning and a tiny example.' },
  { c: 'flash', em: '🗂️', d: 'N flashcards (PDF)', ex: 'Chapter 1 /flash 20', arg: 1, def: 15,
    p: (n) => `Create ${n} FLASHCARDS as a printable PDF (question on one side, answer below in a different colour, 2 columns per page).` },
  { c: 'mindmap', em: '🕸️', d: 'Mind map (PDF, SVG)', ex: 'Water cycle /mindmap',
    p: () => 'Create a beautiful MIND MAP as a one-page PDF using inline SVG: central topic, colourful branches, short labels.' },
  { c: 'timetable', em: '🗓️', d: 'Padhai ka timetable (PDF)', ex: 'Class 10 board exam 30 din /timetable',
    p: () => 'Create a realistic STUDY TIMETABLE PDF with day-wise slots, breaks, revision and test days.' },
  { c: 'plan', em: '🎯', d: 'Din / hafte ka plan (chat me)', ex: 'Kal ka plan /plan',
    p: () => 'Make a practical day/week PLAN with time slots and priorities, in chat (short).' },
  { c: 'letter', em: '✉️', d: 'Application / letter (PDF)', ex: 'School ko chhutti ki application /letter',
    p: () => 'Write a properly formatted formal LETTER / APPLICATION as a clean PDF (sender, date, subject, body, closing) with placeholders in ___ for missing details.' },
  { c: 'resume', alias: ['cv'], em: '🧑‍💼', d: 'Premium resume / CV (PDF)', ex: 'Rahul Sharma, web developer /resume',
    p: () => 'Design a premium modern RESUME / CV PDF (1–2 pages) with clear sections; use ___ placeholders for details I did not give.' },
  { c: 'certificate', em: '🏆', d: 'Certificate (PDF)', ex: 'Best Student Award /certificate',
    p: () => 'Design a stunning CERTIFICATE PDF (A4 landscape) with ornamental border, emblem (you may use a generated picture), name placeholder ___, date and signature lines.' },
  { c: 'poster', em: '🎨', d: 'Poster / flyer with picture (PDF)', ex: 'Annual Day 25 December /poster',
    p: () => 'Design an eye-catching POSTER / FLYER PDF with a striking AI-generated hero picture (use <img data-ai=...>), bold typography, and placeholders for date/venue.' },
  { c: 'report', em: '📊', d: 'Professional report + charts (PDF)', ex: 'Dukaan ki monthly sales /report',
    p: () => 'Create a professional REPORT PDF: cover, summary, tables, charts as inline SVG, findings and recommendations. Invent realistic sample data if I gave none and say so.' },
  { c: 'invoice', alias: ['bill'], em: '🧾', d: 'Invoice / bill (PDF)', ex: 'Sharma Traders ka bill /invoice',
    p: () => 'Create a clean INVOICE / BILL PDF with items table, quantity, rate, total, GST/tax lines, bank/UPI box and ___ placeholders.' },
  { c: 'slides', alias: ['ppt'], em: '🖼️', d: 'Slide-style PDF (landscape)', ex: 'Solar system /slides',
    p: () => 'Create a SLIDE-DECK style PDF in A4 LANDSCAPE: one idea per slide, big headings, pictures (use <img data-ai=...>) and speaker-friendly bullets, 8–12 slides.' },
  { c: 'book', em: '📚', d: 'Bahut bada PDF (N page) — 10-10 page me', ex: 'Class 8 Science poori book /book 120', arg: 1, def: 100,
    p: () => 'Handled by the Bada PDF mode.' },
  { c: 'code', em: '💻', d: 'Poora chalne wala code (▶ Run)', ex: 'Prime numbers /code',
    p: () => 'Write COMPLETE, correct, runnable code in properly tagged fenced blocks (so the ▶ Run button works), with short comments and a 2-line explanation.' },
  { c: 'app', em: '🧩', d: 'Ek hi file ka premium HTML app', ex: 'Todo list with dark UI /app',
    p: () => 'Build ONE complete single-file HTML app (inline CSS + JS, mobile friendly, beautiful modern UI, no external dependencies) in an ```html block that runs with ▶ Run.' },
  { c: 'debug', em: '🐞', d: 'Code ki galti dhundo aur theek karo', ex: '<code paste> /debug',
    p: () => 'Find every bug in the pasted code, explain each in one line, and give the fully corrected code.' },
  { c: 'translate', alias: ['hindi', 'english'], em: '🌐', d: 'Translate karo (Hindi ↔ English)', ex: '<text> /translate',
    p: () => 'Translate the text: if it is English translate to simple Hindi (Devanagari), if Hindi translate to English. Keep meaning and tone.' },
  { c: 'pdf', em: '📕', d: 'Pichla jawab / text ko PDF banao', ex: '/pdf',
    p: () => 'Turn my previous answer (or the text I pasted) into a beautifully designed PDF following the PDF protocol, without changing its content.' }
];
const CMD_MAP = new Map();
COMMANDS.forEach(c => { CMD_MAP.set(c.c, c); (c.alias || []).forEach(a => CMD_MAP.set(a, c)); });

function parseCommands(text) {
  const used = [];
  const tokens = String(text).split(/(\s+)/);
  const keep = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^\/([a-zA-Z0-9]+)$/.exec(tokens[i]);
    const c = m && CMD_MAP.get(m[1].toLowerCase());
    if (c) {
      let n = null;
      if (c.arg && tokens[i + 1] !== undefined && /^[ \t]+$/.test(tokens[i + 1]) && tokens[i + 2] && /^\d{1,3}$/.test(tokens[i + 2])) { n = parseInt(tokens[i + 2], 10); i += 2; }
      if (!used.find(u => u.c === c)) used.push({ c, n });
      continue;
    }
    keep.push(tokens[i]);
  }
  return { base: keep.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), used };
}
function composePrompt(base, used, hasFiles) {
  const lines = used.map(u => `• /${u.c.c}${u.n ? ' ' + u.n : ''}: ${u.c.p(u.n || u.c.def || 0)}`);
  const lead = base || (hasFiles ? 'Apply the commands below to the attached file(s).' : 'Apply the commands below to my previous message / the text above.');
  return lead + '\n\n[COMMANDS — follow every one exactly, in my language]\n' + lines.join('\n');
}
function detectBigPages(text) {
  const m = /(\d{2,3})\s*[- ]?\s*(?:page|pages|pej|पेज|पृष्ठ)/i.exec(text);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n >= 15 && n <= 200 ? n : 0;
}

/* palette above the keyboard */
const cmdBar = $('#cmdBar');
function updateCmdBar() {
  const v = inputEl.value;
  const m = /(?:^|\s)\/([a-zA-Z0-9]*)$/.exec(v);
  if (!m) { cmdBar.classList.remove('show'); cmdBar.innerHTML = ''; return; }
  const q = m[1].toLowerCase();
  const list = COMMANDS.filter(c => !q || c.c.startsWith(q) || (c.alias || []).some(a => a.startsWith(q))).slice(0, 14);
  cmdBar.innerHTML = '';
  if (!list.length) { cmdBar.classList.remove('show'); return; }
  list.forEach(c => {
    const b = el('button', '', `${c.em} <b>/${c.c}</b><small>${esc(c.d)}</small>`);
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => { inputEl.value = v.replace(/\/[a-zA-Z0-9]*$/, '/' + c.c + (c.arg ? ' ' : ' ')); autosize(); updateCmdBar(); inputEl.focus(); };
    cmdBar.appendChild(b);
  });
  cmdBar.classList.add('show');
}
inputEl.addEventListener('input', updateCmdBar);

function guideSheet() {
  openSheet('📖 Guide aur Commands', (b) => {
    const g = el('div', 'guide');
    g.innerHTML = `
      <p><b>Kaise bolna hai?</b> Seedha apni bhasha me likho — Hindi, Hinglish ya English. Jo chahiye wo + <code>/command</code> likh do.</p>
      <ul>
        <li><code>Class 8 Science chapter 3 /notes /hardwords /mcq 15</code> → premium notes PDF + mushkil shabd + 15 MCQ</li>
        <li><code>Light chapter /subah</code> → subah ke liye saare notes 1–2 page me</li>
        <li><code>Poori Science book /book 120</code> → 120 page ki book, 10-10 page karke</li>
        <li><code>Rahul Sharma web developer /resume</code> → premium resume PDF</li>
        <li><code>Annual Day poster /poster</code> → picture ke saath poster PDF</li>
        <li><code>snake game /app</code> → ek file ka game, ▶ Run dabao</li>
      </ul>
      <p><b>Dhyan rakho</b></p>
      <ul>
        <li>Jitne page / sawal bologe utne hi banenge. 15 se zyada page bologe to ऐप khud "Bada PDF" mode sujhata hai.</li>
        <li>Upar 🪄 se PDF ka style, ✨ se mood chuno. 📎 se PDF/photo attach karke bhi pooch sakte ho.</li>
        <li>PDF me picture chahiye to bolo "picture ke saath". PDF ke neeche ✏️ Edit se khud badlo ya "🔁 AI se badlo".</li>
        <li>Ek message me kai commands jod sakte ho. Commands kahin bhi likh sakte ho.</li>
        <li>Code ke neeche <b>▶ Run</b>: HTML, JS, Python, SQL, CSS, JSON, Markdown seedha chalte hain; C, C++, Java, Go, Rust, PHP… online runner se.</li>
      </ul>
      <p><b>Saare commands</b> (tap karo → likh jayega)</p>`;
    b.appendChild(g);
    COMMANDS.forEach(c => {
      const r = el('button', 'cmd-row', `<span class="c">${c.em} /${c.c}${c.arg ? ' N' : ''}</span><span><b style="font-weight:600">${esc(c.d)}</b><small>Jaise: ${esc(c.ex)}</small></span>`);
      r.onclick = () => { closeSheet(); inputEl.value = (inputEl.value ? inputEl.value.replace(/\s*$/, ' ') : '') + '/' + c.c + (c.arg ? ' ' + (c.def || '') : '') + ' '; autosize(); updateCmdBar(); setTimeout(() => inputEl.focus(), 250); };
      b.appendChild(r);
    });
  });
}
$('#btnCmd').onclick = guideSheet;
$('#btnHist').onclick = historySheet;

/* ============================================================ welcome quick start */
const QUICK = [
  { em: '📝', t: 'Class 8 Science Notes', d: 'Premium notes + hard words', p: 'Class 8 Science ke chapter "Synthetic Fibres and Plastics" ke premium notes ka PDF banao: important points, hard words ka table (Hindi meaning ke saath), simple diagrams, "yaad rakho" boxes, aur end me 10 MCQ + answer key. Hindi me likhna.' },
  { em: '📄', t: 'Question Paper', d: 'Class 6–12, marks ke saath', p: 'Class 10 Maths ka 40 marks ka question paper PDF banao: Section A (10 MCQ), Section B (5 short answer), Section C (3 long answer), proper exam-paper layout, aur last page par answer key.' },
  { em: '🧾', t: 'Premium Resume', d: 'Modern CV design', p: 'Mera ek premium modern resume PDF banao. Naam: Rahul Sharma, Fresher Web Developer. Skills: HTML, CSS, JavaScript, Python. Baaki details placeholder me rakh do, main edit kar lunga.' },
  { em: '🏆', t: 'Certificate', d: 'Royal design', p: 'Ek royal design ka "Certificate of Excellence" PDF banao (A4 landscape) jisme naam ki jagah ___ ho, ornamental border, gold seal aur signature lines hon.' },
  { em: '📊', t: 'Business Report', d: 'Charts aur tables', p: 'Ek chhoti dukaan ke monthly sales ki professional report PDF banao: summary page, bar chart, table, aur 3 sujhav. Sample data khud bhar do.' },
  { em: '🎨', t: 'Poster / Flyer', d: 'Dhamakedar design', p: 'Ek colorful "Annual Day Celebration" poster PDF banao (A4) jisme date, jagah, time aur chief guest ki jagah placeholder ho.' },
  { em: '📚', t: '100 page ki Book', d: 'Bada PDF mode', p: '', book: true },
  { em: '💻', t: 'HTML App banao', d: 'Chat me hi chalao ▶', p: 'Ek premium dark design ka calculator web app banao (HTML + CSS + JS, ek hi file) jisme history bhi ho.' },
  { em: '🐍', t: 'Python chalao', d: 'Code likho + Run', p: 'Python me 1 se 50 tak ke prime numbers print karne ka program likho.' },
  { em: '🇮🇳', t: 'Hindi me line-by-line', d: 'Paath ka arth', p: 'Mere diye hue paath ko ek-ek line karke Hindi me saral arth ke saath samjhao. (Paath neeche paste karunga / PDF attach karunga)', fill: true },
  { em: '😂', t: 'Mazaak karo', d: 'Mood badlo!', p: 'Mujhe ek mazedaar chutkula sunao aur phir ek mast shayari bhi!' }
];
function buildQuick() {
  const q = $('#quick');
  q.innerHTML = '';
  QUICK.forEach(it => {
    const b = el('button', '', `<span class="q-em">${it.em}</span><span class="q-t">${esc(it.t)}</span><span class="q-d">${esc(it.d)}</span>`);
    b.onclick = () => {
      if (it.book) { bookSheet(); return; }
      $('#input').value = it.p; autosize();
      if (it.fill) { $('#input').focus(); } else send();
    };
    q.appendChild(b);
  });
}

/* ============================================================ init */
async function init() {
  configureMarked();
  buildQuick();
  try {
    const r = await fetch('/api/config');
    S.cfg = Object.assign(S.cfg, await r.json());
  } catch { toast('Server se connect nahi ho paya', true); }
  $('#appName').textContent = S.cfg.appName || 'PDF Studio AI';
  document.title = S.cfg.appName || 'PDF Studio AI';
  updateChips();
  if (!S.cfg.hasKey) $('#modelTag').textContent = '⚠️ API key set nahi';
  else $('#modelTag').textContent = 'online';
  if (S.cfg.needsPassword) {
    try {
      const r = await fetch('/api/check', { method: 'POST', headers: { 'x-app-password': S.pw || '' } });
      if (!r.ok) showLock('');
    } catch { /* offline */ }
  }
  applyTheme(LS.get('theme', 'hacker'));
  await loadChat();
  autosize();
  window.__psai = { S, docs, openViewer, openEditor, send };   // handy for debugging
}
init();
})();
