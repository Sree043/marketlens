# MarketLens — full prototype (research + paper trading)

This is a fuller **deployable prototype**, not just a health-check page. It includes:
- Dashboard with connection status and portfolio summary
- Watchlist management
- Multi-symbol scanner with rule-based technical signals
- Paper BUY/SELL orders using virtual cash only
- D1 database schema for watchlists, paper accounts, trades and scan history
- Optional OpenAI-compatible analysis endpoint (requires your own API key stored as a Cloudflare secret)

## Important limits — read before using

1. **No broker integration and no real-money orders.** All trades are simulated.
2. The included Yahoo Finance chart endpoint is unofficial and may be delayed, rate-limited, blocked, incomplete, or change without notice. It is not an exchange-authorized real-time NSE feed and must not be treated as a guaranteed 10-second feed.
3. The scanner is a technical screening prototype, not a profitable strategy or investment advice. It scans only the symbols supplied in its request/watchlist. A complete NSE universe requires a maintained symbol master and a data provider whose coverage and licensing permit your intended use.
4. AI analysis is optional and requires a separately billed API key. ChatGPT subscription does not include OpenAI API usage. Never place API keys in frontend files or GitHub.
5. This prototype has basic owner separation using a browser-generated owner ID. It is **not production authentication**. Do not put sensitive financial or personal information in it or expose it as a public multi-user service.
6. Paper account starts with ₹5,000 virtual cash. The first version supports long-only BUY/SELL simulation; it does not model every real-world cost, tax, liquidity or slippage condition.

## Repository layout

- `frontend/` — static mobile-friendly web app for GitHub Pages
- `backend/src/index.js` — Cloudflare Worker API
- `backend/schema.sql` — D1 database schema
- `backend/wrangler.toml` — Worker + D1 configuration template
- `.github/workflows/pages.yml` — GitHub Pages deployment workflow

## Deployment (computer recommended)

### A. GitHub Pages frontend
1. Create a GitHub repository named `marketlens`.
2. Upload the contents of this ZIP, preserving folders.
3. In **Settings → Pages**, choose **GitHub Actions** as the source.
4. The included workflow publishes the `frontend/` folder.
5. Copy the Pages URL shown by GitHub.

### B. Cloudflare D1 database
1. Install Node.js LTS on your computer.
2. Open a terminal in `backend/` and run:
   ```bash
   npm install
   npx wrangler login
   npx wrangler d1 create marketlens-db
   ```
3. Wrangler prints a database ID. Paste it into `backend/wrangler.toml` in place of `REPLACE_WITH_D1_DATABASE_ID`.
4. Initialize the database:
   ```bash
   npx wrangler d1 execute marketlens-db --remote --file=./schema.sql
   ```
5. Set the allowed website origin in `wrangler.toml` to your actual GitHub Pages URL. For example:
   `https://YOUR-GITHUB-USERNAME.github.io`
6. Deploy:
   ```bash
   npx wrangler deploy
   ```
7. Copy the deployed Worker URL (ends in `.workers.dev`).

### C. Connect frontend and backend
1. Edit `frontend/app.js`.
2. Replace `API_BASE_URL` with your Worker URL.
3. Commit/push the change to GitHub. Pages redeploys automatically.
4. Open the Pages URL in Safari and reload.

### D. Optional AI analysis
If you want AI-generated explanations:
```bash
npx wrangler secret put OPENAI_API_KEY
```
Paste your API key into the secure terminal prompt (never into chat or GitHub).
Optionally set a model:
```bash
npx wrangler secret put OPENAI_MODEL
```
Use a model available to your API account. API usage is billed separately.
Without the secret, scanning still returns rule-based signals and the AI section says it is not configured.

## API routes
- `GET /api/health`
- `GET /api/watchlist?owner=...`
- `POST /api/watchlist` `{ "owner": "...", "symbol": "RELIANCE" }`
- `DELETE /api/watchlist?owner=...&symbol=...`
- `GET /api/portfolio?owner=...`
- `GET /api/trades?owner=...`
- `POST /api/trades` `{ "owner": "...", "symbol": "RELIANCE", "side": "BUY|SELL", "quantity": 1 }`
- `POST /api/scan` `{ "owner": "...", "symbols": ["RELIANCE","TCS"] }`
- `POST /api/ai/analyze` `{ "symbol": "RELIANCE", "signal": {...}, "quote": {...} }`

## Troubleshooting
- `Backend not configured`: set `API_BASE_URL` in `frontend/app.js`.
- CORS error: set `ALLOWED_ORIGIN` to the exact Pages origin in `wrangler.toml`, redeploy.
- D1 error: check that database ID is correct and schema.sql was executed remotely.
- Yahoo quote error: provider may be throttling or unavailable. Retry later; do not assume the quote is real-time.
- Empty scanner: add symbols to your watchlist or enter comma-separated NSE tickers.

## Scope of this release
The complete UI and core paper-trading/scanner workflows are included. Before treating the scanner as a dependable all-NSE tool, we still need to validate the market-data provider, add a complete permitted NSE symbol universe, configure production authentication, and test under rate limits. No deployment can be completed from this ZIP alone; it must be connected to your GitHub and Cloudflare accounts.
