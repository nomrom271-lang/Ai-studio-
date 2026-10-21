# ◈ PDF AI Studio

**Create · Edit · Chat — Ultra Premium PDF Studio in a single web app.**

PDF AI Studio is a luxury, dark-glassmorphism static web app that lets you:

- ✦ **Create PDFs** — 7 premium templates (Invoice, Resume, Report, Certificate, Letter, Poster, E-book Cover) with a live WYSIWYG editor, font/accent/theme controls, one-click PDF generation, preview modal, and "Send to Chat".
- ✎ **Edit PDFs** — upload any PDF, render pages with PDF.js, annotate with **text boxes** (draggable), **highlights**, and **freehand drawing**, then export a merged PDF.
- 🤖 **AI Chat** — a built-in offline smart assistant that:
  - answers general Q&A (English + Hindi),
  - **detects your mood** (happy / sad / angry / tired / love / confused — Hindi + English) and replies empathetically in a matching tone,
  - **generates code** (HTML, Python, JS…) with a **▶ Run button** that renders HTML live in a sandboxed iframe inside the chat,
  - **creates PDFs from chat** ("make me an invoice pdf" / "certificate banao") with inline preview, **Download PDF** and **Open Viewer** buttons.
- 🔑 **Gemini AI integration** — paste your free Gemini API key in **⚙️ AI Settings** and the chat becomes super-smart: any topic, any question, and **ANY kind of document** (question papers with MCQs, stories, reports, shayari books…) generated as ultra-premium HTML → one click to **▶ Run** or **📄 Make PDF**. Falls back to offline AI automatically on any error.
- 🎨 **Chat themes** — Normal 🌤️, Hacker 💻 (green-on-black terminal, monospace, scanlines, typewriter replies — the AI talks like a friendly elite hacker), Golden ✨ (luxury concierge style). Theme changes the chat look AND the AI's talking style.
- 🧠 **Conversation memory** — Gemini remembers the last ~20 messages. Toggle **"🧠 Yaad rakho"** ON/OFF, **🧹 Clear** to wipe, history persists in the browser across reloads.
- ⌨️ **Typewriter effect** — AI replies type out stylishly (toggleable, click to skip).

Zero backend. Zero build step. No errors by design — every feature is wrapped in defensive `try/catch` with friendly messages.

## 🚀 How to run

No installation needed. Just open the file:

```bash
# Option 1 — double-click index.html, or:
open index.html

# Option 2 — serve locally (recommended, avoids some browser file:// limits)
npx serve .
# or
python3 -m http.server 8000
```

> The app loads libraries from CDN (html2pdf.js, pdf.js, Google Fonts), so the first load needs internet. After that, everything runs in your browser.

## 📁 Folder structure

```
pdf-ai-studio/
├── index.html   # App shell: tabs, editor, viewer, chat, preview modal
├── styles.css   # Ultra-HD luxury theme (glassmorphism, gradients, responsive)
├── app.js       # All logic: creator, editor, AI chat (defensive, no uncaught errors)
├── README.md    # This file
├── LICENSE      # MIT
└── .gitignore   # Standard web ignores
```

## 🛠 Tech stack

| Piece | Library |
|---|---|
| PDF generation | [html2pdf.js](https://github.com/eKoopmans/html2pdf.js) (html2canvas + jsPDF bundle) via CDN |
| PDF rendering | [PDF.js](https://mozilla.github.io/pdf.js/) via CDN |
| Annotation export | Canvas 2D compositing + jsPDF |
| Styling | Pure CSS — glassmorphism, animated ambient orbs, Playfair Display + Inter |
| AI | 100% local rule-based engine: knowledge base, mood detection (Hindi+English), codegen + sandboxed runner |
| AI (optional) | [Gemini](https://aistudio.google.com/) via API key — multi-turn memory, themes, any-document generation (auto model fallback chain, so retired model IDs never break the app) |

## 🔑 Gemini AI Setup (free, 2 minutes)

The built-in offline AI handles everyday tasks. For **super-smart** answers on any topic — e.g. *"8th class science chapter 1 ka question paper banao: 15 long, 60 MCQ, 15 short, golden-blue premium design"* — connect Gemini:

1. Go to **[Google AI Studio → Get API Key](https://aistudio.google.com/app/apikey)** (free, needs a Google account) and copy your key.
2. In the app, open the **AI Chat** tab → click **⚙️ AI Settings**.
3. Paste the key → **💾 Save Key**. The badge turns to **✨ Gemini ON**.
4. Done! Now ask anything. **🗑 Remove Key** anytime to go back to offline AI.

> 🔒 Your key is stored **only in your browser's localStorage** — it never leaves your device except in direct calls to Google's API. Never share your key publicly.

**What changes with Gemini ON:**
- 🧠 Remembers your last ~20 messages (toggle **🧠 Yaad rakho**, **🧹 Clear** to wipe)
- 🎨 Chat themes change the AI's personality: **💻 Hacker** (terminal vibes, elite-hacker talk) · **✨ Golden** (luxury concierge) · **🌤️ Normal**
- 📄 **Any document, any design**: question papers, stories, reports, certificates, shayari books — Gemini outputs a complete ultra-premium HTML document in your exact colors, then **▶ Run** previews it and **📄 Make PDF** converts it, all inside chat
- ⌨️ Replies type out with a stylish typewriter effect (toggleable)
- On any API error (bad key, no internet, quota over), it tells you in Hindi and **automatically falls back** to the offline AI — nothing ever crashes.

## ⬆ Push to GitHub

```bash
cd pdf-ai-studio
git init
git add .
git commit -m "Initial commit: PDF AI Studio"
git branch -M main
git remote add origin https://github.com/<your-username>/pdf-ai-studio.git
git push -u origin main
```

Then enable **GitHub Pages**: repo Settings → Pages → Deploy from branch → `main` / root. Your app will be live at `https://<your-username>.github.io/pdf-ai-studio/`.

## 🧪 Tested

- `node --check app.js` — syntax OK
- All files present, zip verified with `unzip -l`
- Every user-facing action wrapped in try/catch; CDN failures show friendly messages instead of crashing

## 📜 License

MIT — see [LICENSE](LICENSE). Free for personal and commercial use.

---

### 🇮🇳 हिंदी में संक्षेप

**PDF AI Studio** ek premium web app hai — bina kisi server ke, seedha browser mein chalti hai:

- **PDF banao** — 7 shandaar templates, live editing, ek click mein download
- **PDF edit karo** — text, highlight aur drawing add karke dobara export karo
- **AI Chat** — sawaal poochho, apna mood batao (AI samjhegi!), code likhwao aur **▶ Run** dabakar turant result dekho, ya chat se hi PDF banwao
- **🔑 Gemini AI** — ⚙️ AI Settings me free key lagao: phir kisi bhi topic par question paper (MCQ/long/short), kahani, report — kuch bhi, ultra-premium design me!
- **🎨 Themes** — Hacker 💻 terminal look, Golden ✨ luxury style — AI bhi usi andaaz me baat karegi!
- **🧠 Memory** — AI pichhli baatein yaad rakhegi; ⌨️ typewriter effect ke saath stylish jawab

Koi error nahi — sab kuch carefully test kiya gaya hai. GitHub par daalo, Pages on karo, duniya ke saath share karo! ✨
