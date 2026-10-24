'use strict';
/**
 * Online code runner for languages the browser cannot run itself (C, C++, Java, Go, Rust, PHP, ...).
 * Uses a Piston-compatible API. Default: public emkc.org instance (may need a key / may be limited).
 * Set PISTON_URL (and PISTON_KEY if needed) on Render to use your own / another Piston server.
 * The code runs on THAT service, never on this server.
 */
const LANGS = {
  c: 'c', cpp: 'c++', 'c++': 'c++', java: 'java', go: 'go', golang: 'go', rust: 'rust', rs: 'rust', php: 'php',
  ruby: 'ruby', rb: 'ruby', csharp: 'csharp', cs: 'csharp', 'c#': 'csharp', kotlin: 'kotlin', kt: 'kotlin', swift: 'swift',
  bash: 'bash', sh: 'bash', shell: 'bash', lua: 'lua', r: 'r', perl: 'perl', pl: 'perl', dart: 'dart',
  typescript: 'typescript', ts: 'typescript'
};

class RunError extends Error { constructor(m, status = 502) { super(m); this.userMessage = m; this.status = status; } }

async function runCode(language, code, stdin) {
  const lang = LANGS[String(language || '').toLowerCase()];
  if (!lang) throw new RunError('Ye language online runner me nahi hai: ' + String(language).slice(0, 20), 400);
  const src = String(code || '');
  if (!src.trim()) throw new RunError('Code khaali hai.', 400);
  if (src.length > 100000) throw new RunError('Code bahut bada hai (100 KB tak).', 413);
  const base = (process.env.PISTON_URL || 'https://emkc.org/api/v2/piston').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.PISTON_KEY) headers.Authorization = process.env.PISTON_KEY;
  let r;
  try {
    r = await fetch(base + '/execute', {
      method: 'POST', headers, signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        language: lang, version: '*', files: [{ content: src }], stdin: String(stdin || '').slice(0, 5000),
        compile_timeout: 10000, run_timeout: 5000
      })
    });
  } catch {
    throw new RunError('Online runner se connect nahi ho paya. Thodi der baad try karo.');
  }
  if (r.status === 401 || r.status === 403) throw new RunError('Public runner ab key maangta hai. Render me PISTON_URL (aur PISTON_KEY) set karo, ya apna Piston server lagao.');
  if (r.status === 429) throw new RunError('Runner par abhi bahut load hai. 1 minute baad try karo.');
  if (!r.ok) throw new RunError('Runner error ' + r.status);
  let j;
  try { j = await r.json(); } catch { throw new RunError('Runner ka jawab samajh nahi aaya.'); }
  const parts = [];
  if (j.compile && (j.compile.stdout || j.compile.stderr)) parts.push((j.compile.stdout || '') + (j.compile.stderr || ''));
  if (j.run) parts.push((j.run.stdout || '') + (j.run.stderr || ''));
  let output = parts.join('\n').trim();
  if (output.length > 20000) output = output.slice(0, 20000) + '\n… (output kaat diya)';
  const code2 = j.run && typeof j.run.code === 'number' ? j.run.code : 0;
  return { output: output || '✅ Poora hua (koi output nahi).', exitCode: code2 };
}

module.exports = { runCode, RunError, LANGS };
