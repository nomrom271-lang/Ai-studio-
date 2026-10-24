'use strict';
const fs = require('fs');
const path = require('path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf8');

// id, emoji, name (UI), prompt text
const MOODS = [
  { id: 'auto', emoji: '✨', name: 'Auto', desc: 'Aapke mood ke hisaab se khud badlega',
    text: "Read the user's mood from their message (happy, sad, excited, angry, bored, serious, romantic, stressed…) and match it naturally. Default to a warm, smart, friendly tone." },
  { id: 'friendly', emoji: '😊', name: 'Dost', desc: 'Pyaara, apna-sa dost',
    text: 'Be a warm, caring best friend. Casual, positive, a little playful, uses simple words and light emoji. Make the user feel comfortable.' },
  { id: 'funny', emoji: '😂', name: 'Mazaakiya', desc: 'Hansi-mazaak aur memes',
    text: 'Be genuinely funny: witty one-liners, desi humor, light sarcasm, harmless roasting, funny comparisons. Still give correct, useful answers inside the jokes.' },
  { id: 'teacher', emoji: '📚', name: 'Teacher', desc: 'Dheere-dheere samjhane wala',
    text: 'Be a patient, brilliant teacher. Explain step by step in very simple words with everyday examples, analogies and small memory tricks. End with a quick check question when teaching a concept.' },
  { id: 'motivator', emoji: '🔥', name: 'Motivator', desc: 'Josh se bhar dene wala',
    text: 'Be a high-energy coach. Powerful, positive, practical motivation: short punchy lines, concrete next steps, no empty cliches. Push the user to act today.' },
  { id: 'calm', emoji: '🧘', name: 'Shaant', desc: 'Sukoon aur calm baatein',
    text: 'Be calm, gentle and grounding. Slow, soothing tone, short sentences, helpful perspective, no pressure.' },
  { id: 'swag', emoji: '😎', name: 'Swag', desc: 'Cool, confident, bindaas',
    text: 'Be cool, confident and stylish — modern Hinglish slang, bold confident lines, tasteful hype. Still clear and helpful.' },
  { id: 'emotional', emoji: '🥺', name: 'Emotional', desc: 'Samajhne aur sunne wala',
    text: 'Be deeply empathetic and gentle. Listen first, validate feelings, speak softly, offer comfort and small helpful steps. Never dismiss feelings.' },
  { id: 'shayar', emoji: '🌹', name: 'Shayari', desc: 'Shayari aur kavita ke andaaz me',
    text: 'Speak with a poetic, romantic, shayari flavour — Hindi/Urdu words, beautiful imagery, and an original couplet (sher) or two where it fits. Keep facts correct when answering real questions.' },
  { id: 'gussa', emoji: '😤', name: 'Gussa (mazaak)', desc: 'Naqli gussa, pyaar bhari daant',
    text: 'Play a dramatic, playful "angry" friend: mock-scolding, dramatic sighs, "arre yaar!" energy, but always loving and still fully helpful. Never genuinely insulting or hurtful.' },
  { id: 'pro', emoji: '💼', name: 'Professional', desc: 'Seedha, formal, to-the-point',
    text: 'Be professional, precise and concise. Formal but friendly, structured answers, no slang, no filler.' }
];

const STYLES = [
  { id: 'auto', emoji: '🪄', name: 'Auto', colors: ['#7c5cff', '#00d4ff'],
    text: 'Pick the best premium style for the content and audience (kids → playful pastel; business → clean corporate; luxury → black & gold; exams → clear exam-paper style). Make it striking.' },
  { id: 'gold', emoji: '👑', name: 'Black & Gold Luxury', colors: ['#0b0b10', '#d4af37'],
    text: 'Luxury black & gold: near-black pages (#0b0b10) with metallic gold accents (#d4af37 → #f6e27a gradients), thin gold borders/ornaments, elegant serif headings (Playfair Display or Cinzel), refined sans body (Inter/Poppins), generous spacing, subtle pattern, gold dividers.' },
  { id: 'neon', emoji: '🌌', name: 'Neon Futuristic', colors: ['#0f0c29', '#00f5d4'],
    text: 'Futuristic dark UI: deep navy/purple gradient background, neon cyan/magenta/lime accents, glow effects via box-shadow, glassy cards with thin borders, tech fonts (Space Grotesk / Orbitron-like via Space Grotesk), grid lines and hex/circuit decorations in SVG.' },
  { id: 'minimal', emoji: '⚪', name: 'Minimal Swiss', colors: ['#ffffff', '#111111'],
    text: 'Minimal Swiss style: white paper, black text, ONE bold accent color, strict grid, huge confident headings, tiny uppercase labels, lots of whitespace, hairline rules. Font: Inter or Helvetica-like.' },
  { id: 'corporate', emoji: '🏢', name: 'Corporate Blue', colors: ['#0a2540', '#2563eb'],
    text: 'Professional corporate: navy (#0a2540) + vivid blue (#2563eb) + light gray, clean header band, structured tables, KPI cards, charts in inline SVG, crisp footer with page numbers. Fonts: Poppins/Inter.' },
  { id: 'pastel', emoji: '🌈', name: 'Pastel Fun (kids)', colors: ['#ffd6e8', '#a5d8ff'],
    text: 'Friendly colorful design for students/kids: soft pastel palette, rounded cards, playful shapes, emoji icons, sticker-like badges, big readable text, colorful section headers. Fonts: Nunito / Baloo 2.' },
  { id: 'newspaper', emoji: '📰', name: 'Editorial / Newspaper', colors: ['#f5f0e6', '#222222'],
    text: 'Editorial newspaper look: warm paper tone (#f5f0e6), serif headlines (Playfair Display / DM Serif Display), multi-column body text (CSS columns), thin rules, drop caps, pull quotes, small-caps kickers. Fonts: Merriweather/Lora body.' },
  { id: 'notebook', emoji: '📓', name: 'Handwritten Notebook', colors: ['#fffdf5', '#3b82f6'],
    text: 'Study-notebook look: cream paper with ruled blue lines (repeating-linear-gradient), red margin line, handwritten headings (Caveat / Patrick Hand), highlighter-style marks, washi-tape and sticky-note callouts, hand-drawn style underlines in SVG.' },
  { id: 'glass', emoji: '🔮', name: 'Glassmorphism Gradient', colors: ['#667eea', '#f093fb'],
    text: 'Vibrant mesh-gradient backgrounds (purple/pink/blue) with frosted-glass cards (semi-transparent white, thin white borders, soft shadows), white text on gradients, rounded 20px corners, modern Poppins/Inter.' },
  { id: 'royal', emoji: '🏵️', name: 'Royal Indian', colors: ['#5b0f1a', '#e8c872'],
    text: 'Royal Indian aesthetic: deep maroon (#5b0f1a) + ivory + gold (#e8c872), ornamental mandala/paisley borders drawn as inline SVG, decorative corner flourishes, Cinzel / Tiro Devanagari Hindi headings, ceremonial elegance (great for invitations, certificates, Hindi documents).' },
  { id: 'exam', emoji: '📝', name: 'Exam Paper (clean B/W)', colors: ['#ffffff', '#000000'],
    text: 'Classic exam-paper look: pure black on white, serif or neutral font, bordered header box (school name, class, subject, time, marks), sections with ruled lines, clear numbering, marks in the right margin, dotted answer lines. Print-friendly, no heavy colors.' }
];

function byId(list, id) { return list.find(x => x.id === id) || list[0]; }

function todayIST() {
  try {
    return new Date().toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  } catch { return new Date().toDateString(); }
}

function buildSystemPrompt({ mood, style, search, appName } = {}) {
  const m = byId(MOODS, mood);
  const s = byId(STYLES, style);
  const searchText = search
    ? 'Live Google Search is ON for this message: use it for news, prices, scores, dates and anything that may have changed recently, and be explicit about what is current.'
    : 'You have no live internet in this chat unless the user turns on "Live search". For recent news/prices/scores say you may be out of date and suggest turning Live search on.';
  return TEMPLATE
    .replaceAll('{{APP_NAME}}', appName || 'PDF Studio AI')
    .replaceAll('{{DATE}}', todayIST())
    .replaceAll('{{MOOD_NAME}}', `${m.emoji} ${m.name}`)
    .replaceAll('{{MOOD_TEXT}}', m.text)
    .replaceAll('{{STYLE_NAME}}', `${s.emoji} ${s.name}`)
    .replaceAll('{{STYLE_TEXT}}', s.text)
    .replaceAll('{{SEARCH_TEXT}}', searchText);
}

/* ---------- long document ("book") mode: planner + chunk writers ---------- */
const SAFE_CSS = `PDF-SAFE RULES: A4 pages as <section class="page"> (width:210mm;height:297mm;position:relative;overflow:hidden;break-after:page;page-break-after:always; .page:last-child{break-after:auto;page-break-after:auto}), inner padding 14-16mm, @page{size:A4;margin:0}, *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}. NO JavaScript, NO background-clip:text, NO backdrop-filter, NO position:fixed, NO vh/vw, NO animations. Text stays in normal flow. Hindi: put 'Noto Sans Devanagari' first in font stack, line-height>=1.6, no letter-spacing on Devanagari. Fonts via Google Fonts <link> only (Inter, Poppins, Playfair Display, Merriweather, Nunito, Noto Sans Devanagari...). Content must NEVER overflow a page: an A4 page holds only ~30-38 lines of 10.5pt text (fewer with headings/boxes), so be conservative and fill each page about 80-90%. Use break-inside:avoid on cards/rows. Write compact CSS: define classes once, no repeated inline styles.`;

function buildTaskPrompt(task, { style, lang } = {}) {
  const s = byId(STYLES, style);
  const L = lang || 'the language the user asked for';
  const styleLine = `DESIGN STYLE: ${s.name}. ${s.text}`;
  if (task === 'outline') {
    return `TASK:OUTLINE
You plan long, well-structured documents/books. Output ONLY one valid JSON object, no markdown fences, no commentary:
{"title":"...","parts":[{"title":"...","pages":6,"brief":"1-2 lines: exactly what this part covers"}]}
Rules: parts are consecutive sections/chapters in a sensible learning/reading order; every part has 4-6 pages; the sum of all "pages" must equal the TOTAL pages requested (page 1 of part 1 is the cover page); titles and briefs in ${L}; no overlap between parts; the last part may be a summary/revision/answer-key if it fits the topic.`;
  }
  if (task === 'book1') {
    return `TASK:BOOK1
You are a world-class document designer and writer. Write PART 1 of a long document. Language: ${L}.
Output EXACTLY ONE fenced \`\`\`html block with a COMPLETE standalone HTML document (<!doctype html>, <head> with charset, Google Fonts <link>, ONE <style>, <body>), and nothing else outside the block.
Page 1 is a stunning COVER page; the remaining pages of this part continue with real content. The <style> you write is the design system for the WHOLE book — later parts reuse it — so define a rich, reusable set of classes: .page, .cover, headings (h1,h2,h3), p, .card, .callout, .tip, .badge, .num, table styles, lists, .two-col, .quote, .box-title, .footer-line etc. ${styleLine}
${SAFE_CSS}
Write exactly the requested number of pages (count your <section class="page"> elements). Content must be accurate, rich and genuinely useful, not filler.`;
  }
  return `TASK:BOOKN
You continue a long document. Language: ${L}. A CSS design system already exists (given in the user message). Write ONLY the requested pages of this part.
Output EXACTLY ONE fenced \`\`\`html block that contains ONLY a sequence of <section class="page">…</section> elements — NO <html>, <head>, <body>, <style>, <script>, no cover page, no title page. Use ONLY the classes and CSS variables defined in the given CSS (tiny inline style="" tweaks are ok). Same visual look as page 1.
${SAFE_CSS}
Write exactly the requested number of pages (count your sections). Continue naturally from the previous parts, do not repeat earlier content, content must be accurate, rich and useful.`;
}

module.exports = {
  MOODS, STYLES, buildSystemPrompt, buildTaskPrompt,
  publicLists() {
    return {
      moods: MOODS.map(({ id, emoji, name, desc }) => ({ id, emoji, name, desc })),
      styles: STYLES.map(({ id, emoji, name, colors }) => ({ id, emoji, name, colors }))
    };
  }
};
