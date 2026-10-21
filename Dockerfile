# Playwright image = Chromium already installed (PDF engine). Version must match package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-core fonts-noto-color-emoji fonts-lohit-deva \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PDF_PARALLEL=1
EXPOSE 10000
CMD ["node", "server.js"]
