// MarketLens API v0.3.0 — Cloudflare Worker + D1
// Single file on purpose: it can be pasted straight into the Cloudflare dashboard editor.
const VERSION = "0.3.0";
const BATCH_SIZE = 20;       // symbols fetched per scan batch
const FETCH_BUDGET = 36;     // max provider fetches per Worker request (keeps total subrequests under the 50 free-plan cap)
const MAX_RETRIES = 2;       // per-symbol retries with exponential backoff (inside one request)
const MAX_RETRY_ROUNDS = 4;  // total attempts per symbol across retry passes
const CONCURRENCY = 4;
const SCAN_WINDOW = 200;     // universe rows examined per batch (price-skipped rows cost almost nothing)
const TICK = 0.05;

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  "Vary": "Origin"
});
const json = (data, status = 200, origin = "*") => new Response(JSON.stringify(data), {
  status, headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8" }
});
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => (x === null || x === undefined || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const round2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
const tick = (x) => Number((Math.round(x / TICK) * TICK).toFixed(2));
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

function symbolOf(value) {
  const s = String(value || "").trim().toUpperCase().replace(/\.NS$/, "");
  return /^[A-Z0-9&_-]{1,24}$/.test(s) ? s : null;
}
function ownerOf(value) {
  const s = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(s) ? s : null;
}
async function ensureOwner(db, owner) {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO owners(owner) VALUES (?)").bind(owner),
    db.prepare("INSERT OR IGNORE INTO paper_accounts(owner) VALUES (?)").bind(owner)
  ]);
}

/* ---------- market clock & freshness (no holiday calendar) ---------- */
function istParts(ms) {
  const d = new Date(ms + 19800000); // UTC+5:30
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function marketOpen(ms = Date.now()) {
  const { day, minutes } = istParts(ms);
  return day >= 1 && day <= 5 && minutes >= 555 && minutes <= 930; // 09:15–15:30 IST
}
function freshness(quoteMs, nowMs = Date.now()) {
  const ageMin = (nowMs - quoteMs) / 60000;
  if (marketOpen(nowMs)) return ageMin <= 3 ? "FRESH" : ageMin <= 20 ? "DELAYED" : "STALE";
  return ageMin <= 120 * 60 ? "CLOSED" : "STALE"; // market closed: last close is fine for ~5 days
}

/* ---------- provider access with throttling, retries, exponential backoff ---------- */
const YH_HEADERS = { "Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible; MarketLens/0.3)" };
async function yahooChart(symbol, range, ctx) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + ".NS")}?range=${range}&interval=1d`;
  let lastErr = new Error("Provider unavailable");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (ctx.budget <= 0) throw new Error("Request budget used up; will retry in a later pass");
    ctx.budget--;
    try {
      const r = await fetch(url, { headers: YH_HEADERS, cf: { cacheTtl: 15 } });
      if (r.status === 404) throw Object.assign(new Error("Symbol not found at data provider"), { final: true });
      if (r.status === 429 || r.status >= 500) {
        if (r.status === 429) ctx.throttled++;
        lastErr = new Error(`Provider HTTP ${r.status}`);
      } else if (!r.ok) {
        throw Object.assign(new Error(`Provider HTTP ${r.status}`), { final: true });
      } else {
        return await r.json();
      }
    } catch (e) {
      if (e.final) throw e;
      lastErr = e;
    }
    if (attempt < MAX_RETRIES) await sleep(400 * 2 ** attempt + Math.random() * 250);
  }
  throw lastErr;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/* ---------- parsing & indicators ---------- */
function parseChart(body) {
  const item = body?.chart?.result?.[0];
  if (!item) throw new Error(body?.chart?.error?.description || "No data returned");
  const q = item.indicators?.quote?.[0] || {};
  const ts = item.timestamp || [];
  const bars = [];
  // IMPORTANT: Yahoo returns null for missing candles. Number(null) === 0, so nulls must be skipped, never coerced.
  for (let i = 0; i < ts.length; i++) {
    const c = num(q.close?.[i]);
    if (c === null) continue;
    bars.push({ t: ts[i], c, h: num(q.high?.[i]) ?? c, l: num(q.low?.[i]) ?? c, v: num(q.volume?.[i]) ?? 0 });
  }
  const price = num(item.meta?.regularMarketPrice) ?? bars.at(-1)?.c ?? null;
  const qt = num(item.meta?.regularMarketTime) ?? bars.at(-1)?.t ?? null;
  if (price === null || qt === null || price <= 0) throw new Error("Quote missing price or timestamp");
  const prev = num(item.meta?.chartPreviousClose) ?? num(item.meta?.previousClose);
  return { bars, price, quoteTime: qt, previous: prev, name: item.meta?.longName || item.meta?.shortName || null, currency: item.meta?.currency || "INR" };
}
const sma = (c, n) => (c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : null);
// Wilder's RSI (the standard used by charting platforms): seed with a simple average, then smooth.
function rsiWilder(c, p = 14) {
  if (c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}
function atrWilder(bars, p = 14) {
  if (bars.length < p + 1) return null;
  const tr = (i) => Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  let a = 0;
  for (let i = 1; i <= p; i++) a += tr(i);
  a /= p;
  for (let i = p + 1; i < bars.length; i++) a = (a * (p - 1) + tr(i)) / p;
  return a;
}
function analyze(symbol, nameHint, parsed) {
  const { bars, price, quoteTime, previous } = parsed;
  // make the last candle reflect the live price (same IST day) or append it
  const dayOf = (s) => Math.floor((s + 19800) / 86400);
  const series = bars.map((b) => ({ ...b }));
  if (series.length && dayOf(series.at(-1).t) === dayOf(quoteTime)) {
    const last = series.at(-1); last.c = price; last.h = Math.max(last.h, price); last.l = Math.min(last.l, price);
  } else series.push({ t: quoteTime, c: price, h: price, l: price, v: 0 });
  const closes = series.map((b) => b.c);
  const s20 = sma(closes, 20), s50 = sma(closes, 50), rsi = rsiWilder(closes), atr = atrWilder(series);
  const vols = series.slice(-21, -1).map((b) => b.v).filter((v) => v > 0);
  const avgVol20 = vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null;
  const lowHistory = s50 === null || rsi === null;

  let trend = 0;
  if (s20 !== null && s50 !== null) trend += s20 > s50 ? 1 : -1;
  if (s20 !== null) trend += price > s20 ? 1 : -1;
  if (s50 !== null) trend += price > s50 ? 1 : -1;
  const rsiAdj = rsi === null ? 0 : rsi > 75 ? -1 : rsi < 30 ? 1 : 0;
  const score = trend + rsiAdj;                       // -4 … +4
  const signal = lowHistory ? "NEUTRAL" : score >= 2 ? "BULLISH" : score <= -2 ? "BEARISH" : "NEUTRAL";

  // ATR-based levels. Risk:reward is fixed at 1:2 by construction — it is a plan, not a forecast.
  const base = atr ?? price * 0.02;
  const risk = Math.min(Math.max(1.5 * base, price * 0.01), price * 0.1);
  const short = signal === "BEARISH";
  const entry = tick(price);
  const stop = tick(short ? price + risk : Math.max(price - risk, TICK));
  const target = tick(short ? Math.max(price - 2 * risk, TICK) : price + 2 * risk);

  let rank = score * 10;
  if (rsi !== null && rsi >= 45 && rsi <= 65) rank += 5;
  if (avgVol20 !== null && avgVol20 >= 100000) rank += 3;
  if (lowHistory) rank -= 5;

  const changePct = previous ? ((price - previous) / previous) * 100 : null;
  return {
    symbol, name: parsed.name || nameHint || symbol, price: round2(price), changePct: round2(changePct),
    signal, score, rank, rsi: round2(rsi), sma20: round2(s20), sma50: round2(s50), atr: round2(atr), avgVol20,
    entry, target, stop, side: short ? "SHORT_REF" : "LONG", riskPct: round2((risk / price) * 100), lowHistory,
    quoteTime: new Date(quoteTime * 1000).toISOString(), source: "Yahoo Finance (unofficial)"
  };
}
async function fetchAnalysis(symbol, nameHint, ctx) {
  return analyze(symbol, nameHint, parseChart(await yahooChart(symbol, "6mo", ctx)));
}
async function fetchLastPrice(symbol, ctx) {
  const p = parseChart(await yahooChart(symbol, "5d", ctx));
  return { price: p.price, quoteTime: new Date(p.quoteTime * 1000).toISOString() };
}

/* ---------- NSE universe ---------- */
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out.map((s) => s.trim());
}
function parseEquityCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = parseCsvLine(lines[0]).map((h) => h.toUpperCase());
  const iSym = head.indexOf("SYMBOL"), iName = head.findIndex((h) => h.startsWith("NAME")), iSer = head.indexOf("SERIES"), iIsin = head.findIndex((h) => h.includes("ISIN"));
  if (iSym < 0 || iSer < 0) return [];
  const seen = new Set(), rows = [];
  for (const l of lines.slice(1)) {
    const c = parseCsvLine(l), symbol = symbolOf(c[iSym]);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    rows.push({ symbol, name: (c[iName] || symbol).slice(0, 120), series: (c[iSer] || "EQ").toUpperCase().slice(0, 4), isin: (c[iIsin] || "").slice(0, 16) });
  }
  return rows;
}
async function fetchNseCsv() {
  const urls = ["https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv", "https://archives.nseindia.com/content/equities/EQUITY_L.csv"];
  let err = "NSE did not return the securities list";
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept": "text/csv,*/*", "Referer": "https://www.nseindia.com/" } });
      if (!r.ok) { err = `NSE returned HTTP ${r.status}`; continue; }
      const text = await r.text();
      if (/SYMBOL/i.test(text.slice(0, 400))) return text;
      err = "NSE response was not the securities CSV";
    } catch (e) { err = e.message; }
  }
  throw new Error(err);
}
async function upsertUniverse(db, rows, stamp) {
  const stmts = chunks(rows, 19).map((part) => db.prepare(
    `INSERT INTO universe(symbol,name,series,isin,active,updated_at) VALUES ${part.map(() => "(?,?,?,?,1,?)").join(",")}
     ON CONFLICT(symbol) DO UPDATE SET name=excluded.name,series=excluded.series,isin=excluded.isin,active=1,updated_at=excluded.updated_at`
  ).bind(...part.flatMap((r) => [r.symbol, r.name, r.series, r.isin, stamp])));
  for (const g of chunks(stmts, 30)) await db.batch(g);
}
async function universeStatus(db) {
  const t = await db.prepare("SELECT COUNT(*) n, MAX(updated_at) u FROM universe WHERE active=1").first();
  const s = await db.prepare("SELECT series, COUNT(*) n FROM universe WHERE active=1 GROUP BY series ORDER BY n DESC").all();
  return { count: t?.n || 0, updatedAt: t?.u || null, bySeries: s.results || [] };
}

/* ---------- scan jobs (resumable) ---------- */
const jobOut = (j) => ({
  id: j.id, scope: j.scope, status: j.status, total: j.total, processed: j.processed, ok: j.ok_count, failed: j.failed_count,
  skipped: j.skipped_count, options: JSON.parse(j.options || "{}"), createdAt: j.created_at, updatedAt: j.updated_at
});
async function loadJob(db, owner, id) {
  return db.prepare("SELECT * FROM scan_jobs WHERE id=? AND owner=?").bind(String(id || ""), owner).first();
}
function cleanOptions(o = {}) {
  const n = (x) => { const v = num(x); return v !== null && v >= 0 ? v : null; };
  const series = (Array.isArray(o.series) && o.series.length ? o.series : ["EQ"]).map((s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4)).filter(Boolean).slice(0, 6);
  return { minPrice: n(o.minPrice), maxPrice: n(o.maxPrice), series: series.length ? series : ["EQ"], smartSkip: o.smartSkip !== false };
}
function shouldSkip(c, opt) {
  if (!opt.smartSkip || c.last_price === null || !c.last_price_at) return false;
  const ageH = (Date.now() - Date.parse(c.last_price_at)) / 3600000;
  if (!(ageH < 72)) return false;
  if (opt.maxPrice !== null && c.last_price > opt.maxPrice * 1.25) return true;
  if (opt.minPrice !== null && c.last_price < opt.minPrice * 0.8) return true;
  return false;
}
async function startJob(db, owner, d) {
  const scope = d.scope === "custom" ? "custom" : "all";
  const options = cleanOptions(d.options);
  let symbols = null, total = 0;
  if (scope === "custom") {
    symbols = [...new Set((Array.isArray(d.symbols) ? d.symbols : []).map(symbolOf).filter(Boolean))].slice(0, 500);
    if (!symbols.length) throw Object.assign(new Error("Provide at least one valid NSE ticker"), { status: 400 });
    total = symbols.length;
  } else {
    const ph = options.series.map(() => "?").join(",");
    total = (await db.prepare(`SELECT COUNT(*) n FROM universe WHERE active=1 AND series IN (${ph})`).bind(...options.series).first())?.n || 0;
    if (!total) throw Object.assign(new Error("The NSE stock universe is empty. Load it first (Scanner → Stock universe)."), { status: 400 });
  }
  await db.batch([
    db.prepare("UPDATE scan_jobs SET status='superseded' WHERE owner=? AND status IN ('running','paused')").bind(owner),
    db.prepare("DELETE FROM scan_results WHERE job_id IN (SELECT id FROM scan_jobs WHERE owner=? AND created_at < datetime('now','-3 day'))").bind(owner),
    db.prepare("DELETE FROM scan_jobs WHERE owner=? AND created_at < datetime('now','-3 day')").bind(owner)
  ]);
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO scan_jobs(id,owner,scope,status,total,options,symbols_json) VALUES(?,?,?,?,?,?,?)")
    .bind(id, owner, scope, "running", total, JSON.stringify(options), symbols ? JSON.stringify(symbols) : null).run();
  return jobOut(await loadJob(db, owner, id));
}
function saveResults(db, jobId, entries) {
  // entries: {symbol,status,attempts,error,data} — multi-row INSERT keeps D1 query count low
  return chunks(entries, 16).map((part) => db.prepare(
    `INSERT OR REPLACE INTO scan_results(job_id,symbol,status,attempts,error,data,updated_at) VALUES ${part.map(() => "(?,?,?,?,?,?,datetime('now'))").join(",")}`
  ).bind(...part.flatMap((e) => [jobId, e.symbol, e.status, e.attempts, e.error, e.data])));
}
async function runBatch(db, owner, d) {
  const job = await loadJob(db, owner, d.jobId);
  if (!job) throw Object.assign(new Error("Scan job not found"), { status: 404 });
  const mode = ["next", "retry", "symbols"].includes(d.mode) ? d.mode : "next";
  const opt = JSON.parse(job.options || "{}");
  let toFetch = [], examined = 0, skipped = 0, cursorSymbol = job.cursor_symbol, cursorIndex = job.cursor_index, reachedEnd = false;
  const prevAttempts = {};

  if (mode === "next") {
    if (job.status === "done") return { job: jobOut(job), rows: [], failures: [], fetched: 0, throttled: 0, retryAvailable: 0 };
    if (job.status === "superseded") throw Object.assign(new Error("This scan was replaced by a newer one"), { status: 409 });
    if (job.scope === "custom") {
      const all = JSON.parse(job.symbols_json || "[]");
      toFetch = all.slice(cursorIndex, cursorIndex + BATCH_SIZE).map((symbol) => ({ symbol, name: symbol }));
      examined = toFetch.length; cursorIndex += examined; reachedEnd = cursorIndex >= all.length;
    } else {
      const ph = opt.series.map(() => "?").join(",");
      const rs = await db.prepare(`SELECT symbol,name,last_price,last_price_at FROM universe WHERE active=1 AND series IN (${ph}) AND symbol>? ORDER BY symbol LIMIT ${SCAN_WINDOW}`)
        .bind(...opt.series, cursorSymbol || "").all();
      const cands = rs.results || [];
      for (const c of cands) {
        examined++; cursorSymbol = c.symbol;
        if (shouldSkip(c, opt)) { skipped++; continue; }
        toFetch.push(c);
        if (toFetch.length >= BATCH_SIZE) break;
      }
      reachedEnd = examined === cands.length && cands.length < SCAN_WINDOW;
    }
  } else if (mode === "retry") {
    const rs = await db.prepare("SELECT symbol,attempts FROM scan_results WHERE job_id=? AND status='FAILED' AND attempts<? ORDER BY symbol LIMIT ?")
      .bind(job.id, MAX_RETRY_ROUNDS, BATCH_SIZE).all();
    toFetch = (rs.results || []).map((r) => { prevAttempts[r.symbol] = r.attempts; return { symbol: r.symbol, name: r.symbol }; });
  } else {
    const list = [...new Set((Array.isArray(d.symbols) ? d.symbols : []).map(symbolOf).filter(Boolean))].slice(0, BATCH_SIZE);
    toFetch = list.map((symbol) => ({ symbol, name: symbol }));
  }

  const ctx = { budget: FETCH_BUDGET, throttled: 0 };
  const outcomes = await pool(toFetch, CONCURRENCY, async (c) => {
    try { return { c, row: await fetchAnalysis(c.symbol, c.name, ctx) }; }
    catch (e) { return { c, error: String(e.message || e).slice(0, 160) }; }
  });

  const entries = [], rows = [], failures = [], priceUpdates = [];
  let okNew = 0, failedNew = 0, recovered = 0;
  for (const o of outcomes) {
    if (o.row) {
      rows.push(o.row);
      entries.push({ symbol: o.c.symbol, status: "OK", attempts: (prevAttempts[o.c.symbol] || 0) + 1, error: null, data: JSON.stringify(o.row) });
      priceUpdates.push([o.c.symbol, o.row.price, o.row.quoteTime]);
      if (mode === "next") okNew++; else if (mode === "retry") recovered++;
    } else {
      failures.push({ symbol: o.c.symbol, error: o.error });
      if (mode === "next") { failedNew++; entries.push({ symbol: o.c.symbol, status: "FAILED", attempts: 1, error: o.error, data: null }); }
      else if (mode === "retry") entries.push({ symbol: o.c.symbol, status: "FAILED", attempts: (prevAttempts[o.c.symbol] || 0) + 1, error: o.error, data: null });
      // refresh mode: keep the previous good row; the client shows it ageing / stale
    }
  }

  const upd = { processed: job.processed, ok: job.ok_count, failed: job.failed_count, skipped: job.skipped_count };
  if (mode === "next") { upd.processed += examined; upd.skipped += skipped; upd.ok += okNew; upd.failed += failedNew; }
  if (mode === "retry") { upd.ok += recovered; upd.failed -= recovered; }
  const status = mode === "next" && reachedEnd ? "done" : job.status;

  const stmts = [];
  if (entries.length) stmts.push(...saveResults(db, job.id, entries));
  for (const part of chunks(priceUpdates, 20)) {
    stmts.push(db.prepare(`UPDATE universe SET last_price=CASE symbol ${part.map(() => "WHEN ? THEN ?").join(" ")} END, last_price_at=CASE symbol ${part.map(() => "WHEN ? THEN ?").join(" ")} END WHERE symbol IN (${part.map(() => "?").join(",")})`)
      .bind(...part.flatMap((p) => [p[0], p[1]]), ...part.flatMap((p) => [p[0], p[2]]), ...part.map((p) => p[0])));
  }
  stmts.push(db.prepare("UPDATE scan_jobs SET processed=?,ok_count=?,failed_count=?,skipped_count=?,cursor_symbol=?,cursor_index=?,status=?,updated_at=datetime('now') WHERE id=?")
    .bind(upd.processed, upd.ok, upd.failed, upd.skipped, cursorSymbol, cursorIndex, status, job.id));
  await db.batch(stmts);

  const retryAvailable = (await db.prepare("SELECT COUNT(*) n FROM scan_results WHERE job_id=? AND status='FAILED' AND attempts<?").bind(job.id, MAX_RETRY_ROUNDS).first())?.n || 0;
  const fresh = await loadJob(db, owner, job.id);
  return { job: jobOut(fresh), rows, failures, fetched: toFetch.length, throttled: ctx.throttled, retryAvailable };
}
async function jobResults(db, owner, jobId, origin) {
  const job = await loadJob(db, owner, jobId);
  if (!job) return json({ error: "Scan job not found" }, 404, origin);
  const ok = await db.prepare("SELECT data FROM scan_results WHERE job_id=? AND status='OK' LIMIT 5000").bind(job.id).all();
  const bad = await db.prepare("SELECT symbol,error,attempts FROM scan_results WHERE job_id=? AND status='FAILED' ORDER BY symbol LIMIT 300").bind(job.id).all();
  // data is already JSON text: stitch it together without re-parsing thousands of rows
  const body = `{"job":${JSON.stringify(jobOut(job))},"rows":[${(ok.results || []).map((r) => r.data).join(",")}],"failures":${JSON.stringify(bad.results || [])}}`;
  return new Response(body, { status: 200, headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8" } });
}

/* ---------- paper portfolio ---------- */
async function getPortfolio(db, owner, live = false) {
  const account = await db.prepare("SELECT starting_cash,cash_balance FROM paper_accounts WHERE owner=?").bind(owner).first();
  const rows = await db.prepare("SELECT id,symbol,side,quantity,price,executed_at FROM paper_trades WHERE owner=? ORDER BY id ASC").bind(owner).all();
  const positions = {}; let realized = 0;
  const trades = (rows.results || []).map((t) => {
    const p = (positions[t.symbol] ||= { quantity: 0, invested: 0 });
    const out = { ...t };
    if (t.side === "BUY") { p.quantity += t.quantity; p.invested += t.quantity * t.price; }
    else {
      const avg = p.quantity > 0 ? p.invested / p.quantity : 0;
      out.realized = (t.price - avg) * t.quantity; realized += out.realized;
      p.quantity -= t.quantity; p.invested = Math.max(0, p.invested - t.quantity * avg);
    }
    return out;
  });
  const open = Object.entries(positions).filter(([, p]) => p.quantity > 0.000001)
    .map(([symbol, p]) => ({ symbol, quantity: p.quantity, averagePrice: p.invested / p.quantity, invested: p.invested }));
  const startingCash = account?.starting_cash ?? 5000, cashBalance = account?.cash_balance ?? 5000;
  const invested = open.reduce((a, p) => a + p.invested, 0);
  const summary = { startingCash, availableCash: cashBalance, investedAmount: invested, realizedPnL: realized };

  if (live) {
    const ctx = { budget: FETCH_BUDGET, throttled: 0 };
    await pool(open.slice(0, 25), CONCURRENCY, async (p) => {
      try {
        const q = await fetchLastPrice(p.symbol, ctx);
        p.lastPrice = q.price; p.quoteTime = q.quoteTime; p.freshness = freshness(Date.parse(q.quoteTime));
        p.marketValue = q.price * p.quantity; p.unrealizedPnL = p.marketValue - p.invested;
        p.unrealizedPct = p.invested ? (p.unrealizedPnL / p.invested) * 100 : null; p.valuation = "LIVE";
      } catch (e) { p.valuation = "UNAVAILABLE"; p.valuationError = String(e.message || e).slice(0, 120); }
    });
    for (const p of open) if (!p.valuation) p.valuation = "UNAVAILABLE";
    const valued = open.filter((p) => p.valuation === "LIVE");
    const mv = open.reduce((a, p) => a + (p.valuation === "LIVE" ? p.marketValue : p.invested), 0); // unavailable quotes are carried at cost and flagged
    const unreal = valued.reduce((a, p) => a + p.unrealizedPnL, 0);
    Object.assign(summary, {
      marketValue: mv, totalValue: cashBalance + mv, unrealizedPnL: unreal, totalPnL: realized + unreal,
      totalPnLPct: startingCash ? ((realized + unreal) / startingCash) * 100 : null,
      valuationComplete: valued.length === open.length, unvalued: open.length - valued.length, valuedAt: now()
    });
  }
  return { startingCash, cashBalance, positions: open, trades, summary };
}

/* ---------- router ---------- */
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const ro = allowed === "*" || origin === allowed ? origin : allowed;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(ro) });
    const u = new URL(request.url), path = u.pathname, m = request.method;
    const ownerQ = () => ownerOf(u.searchParams.get("owner"));
    try {
      if (path === "/api/health" && m === "GET") {
        let universe = null;
        try { universe = env.DB ? (await universeStatus(env.DB)).count : null; } catch { universe = "schema-missing"; }
        return json({ ok: true, service: "MarketLens API", time: now(), database: !!env.DB, version: VERSION, universe, marketOpen: marketOpen() }, 200, ro);
      }
      if (path === "/api/quote" && m === "GET") {
        const s = symbolOf(u.searchParams.get("symbol") || "RELIANCE"); if (!s) return json({ error: "Invalid NSE ticker" }, 400, ro);
        return json(await fetchAnalysis(s, s, { budget: FETCH_BUDGET, throttled: 0 }), 200, ro);
      }
      if (path === "/api/watchlist" && m === "GET") {
        const owner = ownerQ(); if (!owner) return json({ error: "Invalid owner" }, 400, ro);
        await ensureOwner(env.DB, owner);
        const rows = await env.DB.prepare("SELECT symbol,created_at FROM watchlists WHERE owner=? ORDER BY symbol").bind(owner).all();
        return json({ items: rows.results || [] }, 200, ro);
      }
      if (path === "/api/watchlist" && (m === "POST" || m === "DELETE")) {
        const data = m === "POST" ? await request.json() : Object.fromEntries(u.searchParams);
        const owner = ownerOf(data.owner), symbol = symbolOf(data.symbol);
        if (!owner || !symbol) return json({ error: "Valid owner and symbol are required" }, 400, ro);
        await ensureOwner(env.DB, owner);
        if (m === "POST") await env.DB.prepare("INSERT OR IGNORE INTO watchlists(owner,symbol) VALUES(?,?)").bind(owner, symbol).run();
        else await env.DB.prepare("DELETE FROM watchlists WHERE owner=? AND symbol=?").bind(owner, symbol).run();
        return json({ ok: true }, 200, ro);
      }

      /* universe */
      if (path === "/api/universe/status" && m === "GET") return json(await universeStatus(env.DB), 200, ro);
      if (path === "/api/universe/refresh" && m === "POST") {
        let rows;
        try { rows = parseEquityCsv(await fetchNseCsv()); }
        catch (e) { return json({ ok: false, error: `Could not download the NSE list from the server: ${e.message}`, hint: "Download EQUITY_L.csv from NSE in your browser and use 'Upload NSE CSV'." }, 502, ro); }
        if (rows.length < 500) return json({ ok: false, error: "NSE list looked incomplete; nothing was changed." }, 502, ro);
        const stamp = now(); await upsertUniverse(env.DB, rows, stamp);
        await env.DB.prepare("UPDATE universe SET active=0 WHERE updated_at<>?").bind(stamp).run();
        return json({ ok: true, imported: rows.length, ...(await universeStatus(env.DB)) }, 200, ro);
      }
      if (path === "/api/universe/import" && m === "POST") {
        const d = await request.json();
        const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 1000).map((r) => ({
          symbol: symbolOf(r.symbol), name: String(r.name || r.symbol || "").slice(0, 120), series: String(r.series || "EQ").toUpperCase().slice(0, 4), isin: String(r.isin || "").slice(0, 16)
        })).filter((r) => r.symbol);
        const stamp = String(d.runId || "");
        if (!/^[0-9T:.\-Z]{10,30}$/.test(stamp)) return json({ error: "Invalid runId" }, 400, ro);
        if (rows.length) await upsertUniverse(env.DB, rows, stamp);
        if (d.finalize) {
          const n = (await env.DB.prepare("SELECT COUNT(*) n FROM universe WHERE updated_at=?").bind(stamp).first())?.n || 0;
          if (n >= 500) await env.DB.prepare("UPDATE universe SET active=0 WHERE updated_at<>?").bind(stamp).run();
          else return json({ error: `Only ${n} symbols were imported; refusing to deactivate the rest.` }, 400, ro);
        }
        return json({ ok: true, imported: rows.length, ...(await universeStatus(env.DB)) }, 200, ro);
      }

      /* scanning */
      if (path === "/api/scan/start" && m === "POST") {
        const d = await request.json(), owner = ownerOf(d.owner); if (!owner) return json({ error: "Valid owner is required" }, 400, ro);
        await ensureOwner(env.DB, owner);
        return json({ job: await startJob(env.DB, owner, d) }, 200, ro);
      }
      if (path === "/api/scan/batch" && m === "POST") {
        const d = await request.json(), owner = ownerOf(d.owner); if (!owner) return json({ error: "Valid owner is required" }, 400, ro);
        return json(await runBatch(env.DB, owner, d), 200, ro);
      }
      if (path === "/api/scan/pause" && m === "POST") {
        const d = await request.json(), owner = ownerOf(d.owner); if (!owner) return json({ error: "Valid owner is required" }, 400, ro);
        await env.DB.prepare("UPDATE scan_jobs SET status='paused',updated_at=datetime('now') WHERE id=? AND owner=? AND status='running'").bind(String(d.jobId || ""), owner).run();
        return json({ ok: true }, 200, ro);
      }
      if (path === "/api/scan/resume" && m === "POST") {
        const d = await request.json(), owner = ownerOf(d.owner); if (!owner) return json({ error: "Valid owner is required" }, 400, ro);
        await env.DB.prepare("UPDATE scan_jobs SET status='running',updated_at=datetime('now') WHERE id=? AND owner=? AND status='paused'").bind(String(d.jobId || ""), owner).run();
        const job = await loadJob(env.DB, owner, d.jobId); if (!job) return json({ error: "Scan job not found" }, 404, ro);
        return json({ job: jobOut(job) }, 200, ro);
      }
      if (path === "/api/scan/latest" && m === "GET") {
        const owner = ownerQ(); if (!owner) return json({ error: "Invalid owner" }, 400, ro);
        const j = await env.DB.prepare("SELECT * FROM scan_jobs WHERE owner=? AND status<>'superseded' ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(owner).first();
        return json({ job: j ? jobOut(j) : null }, 200, ro);
      }
      if (path === "/api/scan/results" && m === "GET") {
        const owner = ownerQ(); if (!owner) return json({ error: "Invalid owner" }, 400, ro);
        return jobResults(env.DB, owner, u.searchParams.get("jobId"), ro);
      }
      // legacy v0.2 endpoint (kept so an old frontend keeps working): max 20 symbols
      if (path === "/api/scan" && m === "POST") {
        const d = await request.json(), owner = ownerOf(d.owner); if (!owner) return json({ error: "Valid owner is required" }, 400, ro);
        const symbols = [...new Set((Array.isArray(d.symbols) ? d.symbols : []).map(symbolOf).filter(Boolean))].slice(0, BATCH_SIZE);
        if (!symbols.length) return json({ error: "Add at least one ticker (max 20 on this endpoint; use the new scanner for more)." }, 400, ro);
        const ctx = { budget: FETCH_BUDGET, throttled: 0 };
        const results = await pool(symbols, CONCURRENCY, async (s) => { try { return await fetchAnalysis(s, s, ctx); } catch (e) { return { symbol: s, error: e.message, signal: "UNAVAILABLE" }; } });
        return json({ scannedAt: now(), count: results.length, results }, 200, ro);
      }

      /* portfolio & paper trades */
      if (path === "/api/portfolio" && m === "GET") {
        const owner = ownerQ(); if (!owner) return json({ error: "Invalid owner" }, 400, ro);
        await ensureOwner(env.DB, owner);
        return json(await getPortfolio(env.DB, owner, u.searchParams.get("live") === "1"), 200, ro);
      }
      if (path === "/api/trades" && m === "GET") {
        const owner = ownerQ(); if (!owner) return json({ error: "Invalid owner" }, 400, ro);
        await ensureOwner(env.DB, owner);
        const rows = await env.DB.prepare("SELECT id,symbol,side,quantity,price,executed_at FROM paper_trades WHERE owner=? ORDER BY id DESC LIMIT 100").bind(owner).all();
        return json({ trades: rows.results || [] }, 200, ro);
      }
      if (path === "/api/trades" && m === "POST") {
        const d = await request.json(), owner = ownerOf(d.owner), symbol = symbolOf(d.symbol), side = String(d.side || "").toUpperCase(), qty = Number(d.quantity);
        if (!owner || !symbol || !["BUY", "SELL"].includes(side) || !Number.isInteger(qty) || qty <= 0 || qty > 100000)
          return json({ error: "Provide a valid symbol, BUY/SELL and a whole-number quantity" }, 400, ro);
        await ensureOwner(env.DB, owner);
        let q;
        try { q = await fetchLastPrice(symbol, { budget: FETCH_BUDGET, throttled: 0 }); }
        catch (e) { return json({ error: `No quote available for ${symbol} (${e.message}). Order not placed.` }, 502, ro); }
        const fr = freshness(Date.parse(q.quoteTime));
        if (fr === "STALE" && !d.acceptStale)
          return json({ error: "STALE_QUOTE", message: `The latest quote for ${symbol} is old (${q.quoteTime}).`, price: q.price, quoteTime: q.quoteTime, freshness: fr }, 409, ro);
        const cost = q.price * qty;
        const account = await env.DB.prepare("SELECT cash_balance FROM paper_accounts WHERE owner=?").bind(owner).first();
        if (side === "BUY" && account.cash_balance < cost) return json({ error: `Insufficient virtual cash: need ₹${cost.toFixed(2)}, have ₹${account.cash_balance.toFixed(2)}` }, 400, ro);
        if (side === "SELL") {
          const pf = await getPortfolio(env.DB, owner);
          const holding = pf.positions.find((p) => p.symbol === symbol);
          if (!holding || holding.quantity < qty) return json({ error: "Not enough virtual shares to sell" }, 400, ro);
        }
        const delta = side === "BUY" ? -cost : cost;
        await env.DB.batch([
          env.DB.prepare("INSERT INTO paper_trades(owner,symbol,side,quantity,price) VALUES(?,?,?,?,?)").bind(owner, symbol, side, qty, q.price),
          env.DB.prepare("UPDATE paper_accounts SET cash_balance=cash_balance+? WHERE owner=?").bind(delta, owner)
        ]);
        return json({ ok: true, executed: { symbol, side, quantity: qty, price: q.price, total: cost, quoteTime: q.quoteTime, freshness: fr, timestamp: now() }, portfolio: await getPortfolio(env.DB, owner) }, 200, ro);
      }

      if (path === "/api/ai/analyze" && m === "POST") {
        if (!env.OPENAI_API_KEY) return json({ configured: false, message: "AI is not configured. Add OPENAI_API_KEY as a Cloudflare Worker secret." }, 200, ro);
        const d = await request.json();
        const prompt = `Explain this stock-screen result in plain language. Do not claim certainty or give personalized financial advice. State limitations. Data: ${JSON.stringify({ symbol: d.symbol, quote: d.quote, signal: d.signal })}`;
        const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-4.1-mini", input: prompt }) });
        const body = await r.json();
        if (!r.ok) return json({ configured: true, error: body.error?.message || "AI provider request failed" }, 502, ro);
        const textOut = (body.output || []).flatMap((x) => x.content || []).filter((x) => x.type === "output_text").map((x) => x.text).join("\n");
        return json({ configured: true, analysis: textOut || "No text returned by AI provider." }, 200, ro);
      }
      return json({ error: "Not found" }, 404, ro);
    } catch (e) {
      return json({ error: e.message || "Internal error" }, e.status || 500, ro);
    }
  }
};
