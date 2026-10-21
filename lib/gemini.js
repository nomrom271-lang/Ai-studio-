'use strict';
/**
 * Gemini (Google AI Studio, free tier) streaming client — no SDK, plain fetch.
 * - Tries several models in order (if one is busy / rate-limited, next one is used)
 * - Optional Google Search grounding (Live search)
 * - Streams text through onText()
 */

const DEFAULT_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite'
];

class UserError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.userMessage = message;
    Object.assign(this, extra);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getKey() {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}
function getModels() {
  const env = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || '').split(',').map(s => s.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_MODELS;
}
function baseUrl() {
  return (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
}

/** Convert our chat messages into Gemini "contents". */
function toContents(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const parts = [];
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
      if (a && typeof a.data === 'string' && a.mime) {
        parts.push({ inlineData: { mimeType: String(a.mime), data: a.data } });
      } else if (a && typeof a.text === 'string') {
        parts.push({ text: `[Attached file: ${String(a.name || 'file').slice(0, 120)}]\n${a.text}` });
      }
    }
    if (typeof m.text === 'string' && m.text.trim()) parts.push({ text: m.text });
    if (!parts.length) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts); // merge same-role neighbours
    else out.push({ role, parts });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function describeHttpError(status, bodyText) {
  const t = (bodyText || '').toLowerCase();
  if (status === 400 && (t.includes('api key not valid') || t.includes('api_key_invalid') || t.includes('api key expired'))) {
    return { fatal: true, msg: 'Gemini API key galat ya expire hai. Render → Environment me GEMINI_API_KEY dobara sahi se daalo.' };
  }
  if (status === 401 || status === 403) {
    return { fatal: true, msg: 'Gemini ne access mana kar diya (key permission / region problem). Nayi free key banakar GEMINI_API_KEY me daalo.' };
  }
  if (status === 429) return { retry: true, msg: 'Free limit ka abhi bhaari load hai. Thodi der (1 minute) baad dobara try karo.' };
  if (status === 503 || status === 500 || status === 502 || status === 504) return { retry: true, msg: 'Gemini server abhi busy hai. Thodi der baad try karo.' };
  if (status === 404) return { retry: true, msg: 'Model nahi mila.' };
  if (status === 400) return { retry: true, soft: true, msg: 'Request Gemini ko samajh nahi aayi.' };
  return { retry: true, msg: `Gemini error ${status}.` };
}

async function callModel({ model, key, body, signal, onText, onSources }) {
  const url = `${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const timeout = AbortSignal.timeout(270000);
  const sig = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: sig
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new UserError('Gemini se connection nahi ho paya. Internet/Server check karo.', { retry: true, emitted: false, status: 0 });
  }

  if (!res.ok) {
    let txt = '';
    try { txt = await res.text(); } catch { /* ignore */ }
    const d = describeHttpError(res.status, txt);
    throw new UserError(d.msg, { retry: !!d.retry, fatal: !!d.fatal, soft: !!d.soft, status: res.status, emitted: false, detail: txt.slice(0, 400) });
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let emitted = false;
  let finish = '';
  let blocked = '';
  const sources = new Map();

  const handleEvent = (raw) => {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) {
      throw new UserError(j.error.message || 'Gemini stream error', { retry: !emitted, status: j.error.code || 500, emitted });
    }
    if (j.promptFeedback && j.promptFeedback.blockReason) blocked = j.promptFeedback.blockReason;
    const c = j.candidates && j.candidates[0];
    if (!c) return;
    const parts = (c.content && c.content.parts) || [];
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text && !p.thought) {
        emitted = true;
        onText(p.text);
      }
    }
    if (c.finishReason) finish = c.finishReason;
    const chunks = c.groundingMetadata && c.groundingMetadata.groundingChunks;
    if (Array.isArray(chunks)) {
      for (const g of chunks) {
        if (g.web && g.web.uri) sources.set(g.web.uri, g.web.title || g.web.uri);
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i);
        buf = buf.slice(i + 2);
        handleEvent(ev);
      }
    }
    buf += dec.decode();
    if (buf.trim()) handleEvent(buf);
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof UserError) { e.emitted = emitted; throw e; }
    throw new UserError('Beech me connection toot gaya. Dobara bhejo.', { retry: !emitted, emitted, status: 0 });
  }

  if (!emitted) {
    if (blocked || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
      throw new UserError('Ye request Gemini ke safety filter ne roki. Thoda alag tareeke se likhkar try karo.', { retry: false, emitted: false, status: 200 });
    }
    throw new UserError('Gemini ne khaali jawab diya. Dobara try karo.', { retry: true, emitted: false, status: 200 });
  }
  if (finish === 'MAX_TOKENS') onText('\n\n> ⚠️ Jawab bahut lamba tha isliye beech me ruk gaya. "aage badhao" likho ya page kam karwao.');
  if (sources.size && onSources) onSources([...sources].slice(0, 8).map(([uri, title]) => ({ uri, title })));
  return { emitted };
}

async function streamChat({ messages, system, search, signal, onText, onModel, onSources }) {
  const key = getKey();
  if (!key) {
    throw new UserError('GEMINI_API_KEY set nahi hai. Render → Environment me apni free Gemini API key daalo (guide README me hai).', { fatal: true });
  }
  const contents = toContents(messages);
  if (!contents.length) throw new UserError('Kuch likho ya file attach karo.', { fatal: true });

  const models = getModels();
  let lastErr = null;

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const modes = search ? [true, false] : [false];
    for (const useSearch of modes) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 32768 },
        safetySettings: [
          'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
          'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'
        ].map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' }))
      };
      if (/^gemini-2\.5/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 1024 };
      if (useSearch) body.tools = [{ google_search: {} }];

      try {
        if (onModel) onModel(model + (useSearch ? ' + search' : ''));
        await callModel({ model, key, body, signal, onText, onSources });
        return;
      } catch (e) {
        lastErr = e;
        if (signal.aborted) throw e;
        if (e.emitted) throw e;          // text already streamed — cannot restart cleanly
        if (e.fatal) throw e;            // bad key etc.
        if (e.retry === false) throw e;  // e.g. safety block
        if (e.status === 429) await sleep(600);
        // try next mode / next model
      }
    }
  }
  throw lastErr || new UserError('Jawab nahi mil paya. Dobara try karo.');
}

module.exports = { streamChat, UserError, getKey, getModels };
