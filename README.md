# MarketLens v0.3 — all-NSE scanner + paper trading

Upgrade of the v0.2 prototype. Same hosting (GitHub Pages + Cloudflare Worker + D1), same ₹5,000 virtual account, existing paper trades untouched.

## What's new
- **All-NSE universe** loaded from NSE's official `EQUITY_L.csv` (server download, or upload the file in the app).
- **Batch scanning**: 20 stocks per batch, sequential batches, adaptive delay (doubles up to 20 s when the provider throttles), per-symbol retries with exponential backoff, extra retry passes, **pause / resume**, and a saved job so an interrupted scan can continue after a reload.
- **Price filters**: minimum / maximum price and quick chips. Optional "skip stocks recently seen far outside my range" makes repeat scans much faster.
- **Signal filters**: Bullish / Bearish / Neutral, sort options, minimum average volume, search, hide-stale.
- **Entry / target / stop-loss** per stock (ATR-based, fixed 1:2 risk-reward).
- **Live-valued portfolio**: invested, available cash, market value, realised and unrealised P&L, total P&L.
- **Paper buy/sell from scan results** (whole shares), filled at a fresh quote taken when you confirm.
- **Auto-refresh** with last-updated timestamps; every quote shows its age (Fresh / Delayed / Stale / Last close / Unavailable).
- **Fixed indicators**: see "Signals" below.

## Upgrade steps (no Terminal, no Node.js)
Do them in this order.

### 1. Database (Cloudflare dashboard)
Workers & Pages → **D1** → `marketlens-db` → **Console**. Paste the whole of `backend/migration-v0.3.sql` and run it. It only *adds* tables and is safe to run twice. Your trades, cash and watchlist are not touched.

### 2. Worker (Cloudflare dashboard)
Workers & Pages → your Worker (`marketlens`) → **Edit code**. Select all, paste the whole of `backend/src/index.js`, then **Deploy**. Under Settings → Bindings, confirm the D1 binding is still called `DB`, and under Variables that `ALLOWED_ORIGIN` is your Pages origin (`https://sree043.github.io`).

### 3. Website (GitHub, in the browser)
In your repository, replace these files (open each file → pencil icon → paste → Commit), or use **Add file → Upload files** from a computer:
- `frontend/index.html`, `frontend/app.js`, `frontend/styles.css`
- `backend/src/index.js`, `backend/wrangler.toml`, `backend/package.json`, `backend/schema.sql`, `README.md`
- new file: `backend/migration-v0.3.sql`

`frontend/app.js` already contains your Worker URL. Pages redeploys by itself after the commit (Actions tab shows progress).

### 4. First run
Open the site → **Scanner** → **Update from NSE**. If NSE blocks the server download, download `EQUITY_L.csv` from NSE's market-data page in your browser and use **Upload NSE CSV**. Then **Start scan**.

## Limits to know about
- **Fresh quotes for every stock are not possible.** Yahoo Finance's chart endpoint is unofficial; it can be delayed, throttled or blocked, and illiquid shares may not have traded for hours. The app shows quote age and marks stale or missing data instead of pretending it is live. Delayed/stale thresholds: during market hours ≤3 min Fresh, ≤20 min Delayed, older Stale; after close, quotes up to 5 days old show as "Last close". There is no holiday calendar.
- A full scan of ~2,000–3,000 stocks takes several minutes (about 20 stocks per 3–4 s when the provider is happy, slower if it throttles). Keep the tab open; you can pause and resume.
- The 50-requests-per-invocation limit of Cloudflare's free plan shaped the batch size (20 symbols, retry budget capped per request). A paid plan is not required.
- The NSE list includes more than ordinary shares (series BE, SM, etc.). The app scans EQ by default; BE is optional. Not every NSE symbol exists on Yahoo; those are reported as unavailable.
- **No authentication.** Your data is separated by a browser-generated key only, and the universe endpoints are public to anyone who knows the Worker URL. Fine for a personal prototype; do not treat it as production.
- Paper trades ignore brokerage, taxes, slippage and liquidity. Stops/targets are suggestions, not automatic orders. Whole shares only for new orders (older fractional trades are kept and still valued).

## Signals (educational, not advice)
- Daily candles, 1 year (so the 200-day average works). SMA20, SMA50, **Wilder RSI(14)**, ATR(14), 20-day average volume.
- Trend score: SMA20 vs SMA50, price vs SMA20, price vs SMA50 (±1 each); RSI above 75 subtracts 1, below 30 adds 1. Score ≥ +2 Bullish, ≤ −2 Bearish, otherwise Neutral. Fewer than ~50 candles → Neutral, flagged "short history".
- Ranking adds a small bonus for RSI between 45 and 65 and for average volume ≥ 100K.
- Levels: risk = 1.5 × ATR (clamped to 1%–10% of price); stop = entry − risk, target = entry + 2 × risk (mirrored for Bearish, shown as a short-side reference only). The 1:2 ratio is a plan, not a forecast.

### What changed in the indicator maths
v0.2 turned missing Yahoo candles (`null`) into `0`, which could distort SMAs and RSI, and its RSI used a plain 14-day average instead of Wilder's smoothing, so its values differed from charting platforms. v0.3 skips missing candles and uses Wilder's method.

## Trading styles
The **Trading style** menu in Scanner → Scan results switches every card, count and ranking between four views of the same data (no extra scan needed):
- **Short term** (days to 2 weeks): the default rules above.
- **Intraday** (same day): needs average volume of at least 300K and daily movement of at least 1.2%, plus a rise of at least 0.5% today and price above its 20-day average. Tight levels, sell before 3:15 PM. It uses daily data, not live minute charts, so treat it as a rough shortlist. The simulator does not square off for you.
- **Swing** (2 to 6 weeks): uptrend with the price within about 2% below to 4% above its 20-day average and RSI 40 to 62 (a dip-buy). Wider stop, 1:2.5 target.
- **Long term** (6 months or more): price above its 200-day average, 50-day above 200-day, and within 30% of the 52-week high. Stop at about 5% under the 200-day average (never more than 20% below price), target +40%. It looks at price trend only; check the business and results yourself.

## API routes
`GET /api/health` · `GET /api/quote?symbol=` · watchlist `GET/POST/DELETE /api/watchlist` · `GET /api/universe/status` · `POST /api/universe/refresh` · `POST /api/universe/import` · `POST /api/scan/start` · `POST /api/scan/batch` (`mode`: next | retry | symbols) · `POST /api/scan/pause` · `POST /api/scan/resume` · `GET /api/scan/latest` · `GET /api/scan/results` · `GET /api/portfolio?owner=&live=1` · `GET/POST /api/trades` · `POST /api/ai/analyze` (optional, needs your own key) · legacy `POST /api/scan` (max 20 symbols).

## Troubleshooting
- "Database upgrade missing": run step 1.
- "Backend disconnected" / CORS: `ALLOWED_ORIGIN` must exactly match your Pages origin.
- Many "Provider HTTP 429": the provider is throttling. Pause, wait, resume; the app already slows itself down.
- Update from NSE fails: use Upload NSE CSV.
- `backend/wrangler.toml` now says `name = "marketlens"` to match your live Worker URL. Only matters if you ever deploy from the command line.
