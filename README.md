# ✦ PDF Studio AI

Ek AI chat app jo **kisi bhi style ka premium PDF** banata hai, PDF ko **edit** karne deta hai, **code / HTML likhkar chat me hi chalata hai**, aur har **mood** me baat karta hai. Class 1–12 ke notes, question paper, resume, certificate, poster, report — sab.

## Kya-kya hai
- 💬 Gemini (free API) chat, streaming jawab, Hindi / Hinglish / English
- 📄 AI se PDF: 11 design styles (Black&Gold, Neon, Minimal, Corporate, Pastel, Newspaper, Notebook, Glass, Royal Indian, Exam Paper…)
- 👁 PDF chat me hi preview + poora viewer (zoom, download, share)
- ✏️ Editor: text par tap karke likho, bold/color/size, table, photo, block delete → **Save & PDF**
- 🔁 "AI se badlo": bolkar badlav (page add, rang, translate…)
- ▶ Chat me code run: HTML (poori web app), JavaScript, Python (browser me), SVG
- 🧰 PDF Tools: Photos→PDF, Merge, Pages nikalo/hatao, Order badlo, Rotate, Page number, Watermark (Hindi bhi), Text stamp
- 📎 PDF / photo / text file attach karke sawal-jawab ya "isko editable banao"
- 🎤 Mic se bolkar likho, 🔊 jawab sunao (male Hindi voice pasand, Settings me badal sakte ho)
- 🌐 Live search (Google) ON/OFF, 😊 11 moods (Dost, Mazaakiya, Teacher, Motivator, Shayari…)
- 🔒 API key sirf server par; optional app password

---

## 🚀 Render par deploy — step by step (phone se)

### Step 1: Gemini free API key lo
1. Browser me `aistudio.google.com/apikey` kholo, Google se login karo.
2. **Create API key** dabao → key copy kar lo (`AIza...`). Ye kisi ko mat dikhana.

### Step 2: GitHub repository banao
1. `github.com` → login → upar **+** → **New repository**.
2. Name: `pdf-studio-ai` → **Public** ya **Private** (dono chalenge) → **Create repository**.

### Step 3: Files upload karo
ZIP ko pehle phone ki **Files app** me **Extract** kar lo.

**Aasan tareeka (computer ho to):** repo page par **Add file → Upload files** → extract kiya hua poora folder drag-drop karo → **Commit changes**.

**Phone se:** Android ka picker folder nahi uthata, isliye 2 hisse me:
1. **Add file → Upload files** → sirf *root ki files* chuno: `package.json`, `server.js`, `Dockerfile`, `render.yaml`, `README.md`, `.dockerignore`, `.gitignore`, `.env.example` → **Commit**.
2. Baaki 9 files ke liye **Add file → Create new file**. Naam wale box me poora path likho (jaise `lib/gemini.js` — `/` likhte hi folder ban jata hai), file ka poora content paste karo, **Commit**. Ye 9 files hain:
   `lib/gemini.js`, `lib/pdf.js`, `lib/prompt.js`, `lib/system-prompt.md`,
   `public/index.html`, `public/app.js`, `public/style.css`, `public/icon.svg`, `public/manifest.webmanifest`

   (Har file ko Files app me "text editor" se kholkar sab copy karo.)

> ⚠️ `.env` file kabhi GitHub par mat daalna. Key sirf Render me daalni hai.

### Step 4: Render par Web Service banao
1. `render.com` → **Sign up with GitHub** (free).
2. Dashboard → **New +** → **Web Service**.
3. **Connect a repository** → `pdf-studio-ai` chuno (pehli baar "Configure GitHub" dabakar repo ko access do).
4. Settings:
   - **Name:** `pdf-studio-ai` (isi se link banega)
   - **Region:** Singapore (India ke paas)
   - **Language/Runtime:** **Docker** (Dockerfile apne-aap mil jayegi)
   - **Instance Type:** **Free**
5. Neeche **Environment Variables** → **Add**:
   | Key | Value |
   |---|---|
   | `GEMINI_API_KEY` | Step 1 wali key |
   | `APP_PASSWORD` | koi password jo sirf tum jaano (recommended) |
6. **Deploy Web Service** dabao. Pehli build 5–10 minute leti hai. Logs me `✅ PDF Studio AI chal raha hai` dikhe to ready.
7. Upar link (`https://pdf-studio-ai.onrender.com`) kholo → password daalo → ho gaya! Chrome menu → **Add to Home screen** se app jaisa icon bana lo.

### Key lock kaise rehta hai
- Key sirf Render ke **Environment** me hai; app/phone/GitHub me kabhi nahi aati.
- Badalni ho to Render → service → **Environment** → `GEMINI_API_KEY` edit → **Save** (auto redeploy). Ye sirf tumhare Render account se ho sakta hai.
- `APP_PASSWORD` lagane se dusre log tumhare link se API use nahi kar paayenge.

### Free plan ki baatein
- 15 minute koi na use kare to app so jati hai; pehla khulna ~30–60 second lega, phir normal.
- Free RAM kam hai (512 MB), isliye ek baar me ek PDF banti hai (`PDF_PARALLEL=1`). Bahut lambe/bhari design me thoda time lag sakta hai.
- Gemini free API ki rozana limit hoti hai; "busy" aaye to 1 minute baad try karo. Ye app khud 4 models ke beech badal kar try karta hai.

---

## 📚 Use kaise karein (examples)
- "Class 8 Science chapter 3 ke premium notes PDF banao, hard words aur 10 MCQ ke saath"
- "Class 10 Maths ka 40 marks ka paper banao, Section A/B/C, answer key last page par"
- "Exact 25 questions banao is chapter se" + PDF attach (jitne bologe utne hi)
- "Is PDF ko editable banao" + purani PDF attach
- "Black gold style me resume banao" / "Pastel style me bachon ka worksheet"
- "Ek snake game HTML me banao" → **▶ Run** dabao
- Banne ke baad **✏️ Edit** ya "page 2 me table add karo" bolo

Upar **✨ mood** aur **🪄 style** se baat ka andaaz aur PDF ka design chuno.

## 💻 Computer par chalana (optional)
```bash
npm install
npx playwright install chromium
cp .env.example .env     # key daalo
npm start                # http://localhost:3000
```

## 🔧 Dikkat aaye to
| Dikkat | Hal |
|---|---|
| "API key galat" | Render → Environment me key dobara daalo, koi space na ho |
| "Free limit ka load" | 1 minute ruko, dobara bhejo |
| PDF nahi ban rahi | Render → Logs dekho; Docker runtime chuna hai ya nahi check karo |
| Hindi text toota dikhe | Dockerfile se deploy karo (fonts usme hain) |
| Build fail | Render → Manual Deploy → *Clear build cache & deploy* |

Made with ❤️ — MIT license.
