// MarketLens v0.3 frontend. Your Worker URL (unchanged from v0.2):
const API_BASE_URL = "https://marketlens.sreekeshsree100.workers.dev";

const ownerKey = (() => {
  let key = localStorage.getItem("marketlens_owner");
  if (!key) { key = "ml_" + crypto.randomUUID().replaceAll("-", ""); localStorage.setItem("marketlens_owner", key); }
  return key;
})();
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(n) || 0);
const signed = (n) => (n >= 0 ? "+" : "−") + money(Math.abs(n));
const pct = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "%");
const fmt = (v) => (v ? new Date(v).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST" : "—");
const fmtTime = (v) => (v ? new Date(v).toLocaleTimeString("en-IN", { timeStyle: "medium", timeZone: "Asia/Kolkata" }) + " IST" : "—");
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const configured = () => API_BASE_URL.startsWith("https://") && !API_BASE_URL.includes("REPLACE-WITH");
const compact = (n) => (n === null || n === undefined ? "n/a" : n >= 1e7 ? (n / 1e7).toFixed(1) + "Cr" : n >= 1e5 ? (n / 1e5).toFixed(1) + "L" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(n));

async function api(path, options = {}) {
  if (!configured()) throw new Error("Backend URL not configured. Set API_BASE_URL in frontend/app.js.");
  const init = { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) }, cache: "no-store" };
  if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
  const res = await fetch(API_BASE_URL + path, init);
  const data = await res.json().catch(() => ({ error: "Invalid server response" }));
  if (!res.ok) { const e = new Error(data.message || data.error || `HTTP ${res.status}`); e.data = data; e.status = res.status; throw e; }
  return data;
}

/* ---------- market clock / freshness (mirrors the Worker; no holiday calendar) ---------- */
function marketOpen(ms = Date.now()) {
  const d = new Date(ms + 19800000), mins = d.getUTCHours() * 60 + d.getUTCMinutes(), day = d.getUTCDay();
  return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
}
function freshOf(quoteIso) {
  if (!quoteIso) return "UNAVAILABLE";
  const ageMin = (Date.now() - Date.parse(quoteIso)) / 60000;
  if (marketOpen()) return ageMin <= 3 ? "FRESH" : ageMin <= 20 ? "DELAYED" : "STALE";
  return ageMin <= 7200 ? "CLOSED" : "STALE";
}
const FRESH_LABEL = { FRESH: "Fresh", DELAYED: "Delayed", STALE: "Stale", CLOSED: "Last close", UNAVAILABLE: "Unavailable" };
function ageText(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
const freshBadge = (iso) => { const f = freshOf(iso); return `<span class="fresh ${f}" title="${escapeHtml(fmt(iso))}">${FRESH_LABEL[f]} · ${ageText(iso)}</span>`; };

/* ---------- state ---------- */
const S = {
  rows: new Map(), failures: [], job: null, running: false, stop: false, shown: 50,
  signal: "ALL", portfolio: null, held: {}, watch: new Set(), lastScanAt: null, lastPortfolioAt: null, lastShortlistAt: 0, busyRefresh: false
};

function setConnection(ok, msg) { $("connection-dot").className = "dot " + (ok ? "ok" : "bad"); $("connection-text").textContent = msg; }
function activateTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === name));
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => activateTab(b.dataset.tab)));
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => activateTab(b.dataset.goto)));

/* ---------- universe ---------- */
const STARTER = ["RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN","BHARTIARTL","KOTAKBANK","LT","AXISBANK","ASIANPAINT","MARUTI","SUNPHARMA","TITAN","ULTRACEMCO","BAJFINANCE","NESTLEIND","WIPRO","HCLTECH","ONGC","NTPC","POWERGRID","TATASTEEL","COALINDIA","ADANIPORTS","JSWSTEEL","M&M","TECHM","INDUSINDBK","HINDALCO","GRASIM","CIPLA","DRREDDY","EICHERMOT","BPCL","IOC","VEDL","SAIL","NHPC","YESBANK","IDEA","PNB","BANKBARODA","IRFC","SUZLON","IDFCFIRSTB","TATAPOWER","GAIL","RECLTD","PFC"];
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
    const c = parseCsvLine(l), symbol = String(c[iSym] || "").toUpperCase();
    if (!/^[A-Z0-9&_-]{1,24}$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol); rows.push({ symbol, name: c[iName] || symbol, series: (c[iSer] || "EQ").toUpperCase(), isin: c[iIsin] || "" });
  }
  return rows;
}
async function loadUniverse() {
  try {
    const u = await api("/api/universe/status");
    $("uni-tag").textContent = u.count ? `${u.count.toLocaleString("en-IN")} stocks` : "Empty";
    const mix = (u.bySeries || []).slice(0, 4).map((s) => `${s.series} ${s.n}`).join(" · ");
    $("uni-text").textContent = u.count ? `${u.count.toLocaleString("en-IN")} active symbols (${mix}). Updated ${fmt(u.updatedAt)}.` : "No stocks loaded yet. Tap “Update from NSE”, upload the NSE CSV, or try the starter list.";
  } catch (e) { $("uni-text").textContent = e.message.includes("no such table") ? "Database upgrade missing: run migration-v0.3.sql in the D1 console (see README)." : e.message; }
}
async function importRows(rows, finalize) {
  const runId = new Date().toISOString();
  const parts = []; for (let i = 0; i < rows.length; i += 500) parts.push(rows.slice(i, i + 500));
  for (let i = 0; i < parts.length; i++) {
    $("uni-status").textContent = `Importing ${Math.min((i + 1) * 500, rows.length)} of ${rows.length}…`;
    await api("/api/universe/import", { method: "POST", body: { runId, rows: parts[i], finalize: finalize && i === parts.length - 1 } });
  }
}
$("uni-refresh").addEventListener("click", async () => {
  $("uni-refresh").disabled = true; $("uni-status").textContent = "Asking the server to download NSE's equity list…";
  try { const d = await api("/api/universe/refresh", { method: "POST" }); $("uni-status").textContent = `Loaded ${d.imported} symbols from NSE.`; }
  catch (e) { $("uni-status").textContent = (e.data?.error || e.message) + (e.data?.hint ? " " + e.data.hint : ""); }
  finally { $("uni-refresh").disabled = false; loadUniverse(); }
});
$("uni-upload").addEventListener("click", () => $("uni-file").click());
$("uni-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const rows = parseEquityCsv(await f.text());
    if (rows.length < 500) throw new Error(`That file has only ${rows.length} valid symbols. Use NSE's full EQUITY_L.csv.`);
    await importRows(rows, true); $("uni-status").textContent = `Imported ${rows.length} symbols from ${f.name}.`;
  } catch (e) { $("uni-status").textContent = e.message; }
  ev.target.value = ""; loadUniverse();
});
$("uni-starter").addEventListener("click", async () => {
  try { await importRows(STARTER.map((s) => ({ symbol: s, name: s, series: "EQ", isin: "" })), false); $("uni-status").textContent = "Starter list added. Load the full NSE list for all-market coverage."; }
  catch (e) { $("uni-status").textContent = e.message; }
  loadUniverse();
});

/* ---------- scanning ---------- */
const priceBounds = () => {
  const mn = $("min-price").value === "" ? null : Number($("min-price").value), mx = $("max-price").value === "" ? null : Number($("max-price").value);
  return { min: Number.isFinite(mn) ? mn : null, max: Number.isFinite(mx) ? mx : null };
};
document.querySelectorAll("#price-chips .chip").forEach((c) => c.addEventListener("click", () => { $("max-price").value = c.dataset.max; $("min-price").value = ""; scheduleRender(); }));
$("scope").addEventListener("change", () => { $("custom-wrap").hidden = $("scope").value !== "custom"; });
["min-price", "max-price", "f-sort", "f-vol", "f-q", "f-hide-stale"].forEach((id) => $(id).addEventListener("input", () => { S.shown = 50; scheduleRender(); }));
document.querySelectorAll("#signal-chips .chip").forEach((c) => c.addEventListener("click", () => {
  S.signal = c.dataset.signal; S.shown = 50;
  document.querySelectorAll("#signal-chips .chip").forEach((x) => x.classList.toggle("active", x === c)); scheduleRender();
}));
$("show-more").addEventListener("click", () => { S.shown += 50; renderResults(); });

function mergeRows(rows) { for (const r of rows) S.rows.set(r.symbol, r); S.lastScanAt = new Date().toISOString(); scheduleRender(); }
let renderTimer = null;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderAll, 120); }

function updateProgress(job, note) {
  S.job = job;
  const done = job.processed, total = job.total || 1;
  $("progress-bar").style.width = Math.min(100, (done / total) * 100) + "%";
  const state = job.status === "done" ? "Finished" : job.status === "paused" ? "Paused" : S.running ? "Scanning" : "Stopped";
  $("scan-progress").textContent = `${state}: examined ${done.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} · quotes received ${job.ok.toLocaleString("en-IN")} · unavailable ${job.failed.toLocaleString("en-IN")} · skipped by price ${job.skipped.toLocaleString("en-IN")}` + (note ? ` · ${note}` : "");
  const canResume = job.status !== "done" && !S.running;
  $("scan-pause").textContent = S.running ? "Pause" : "Resume"; $("scan-pause").disabled = !S.running && !canResume;
  $("scan-start").disabled = S.running;
}

async function driveJob(job) {
  S.running = true; S.stop = false; updateProgress(job);
  let delay = 1200, netErrors = 0;
  try {
    while (!S.stop && job.status !== "done") {
      try {
        const d = await api("/api/scan/batch", { method: "POST", body: { owner: ownerKey, jobId: job.id, mode: "next" } });
        netErrors = 0; job = d.job; mergeRows(d.rows);
        const bad = d.fetched ? d.failures.length / d.fetched : 0;
        if (d.throttled > 0 || bad > 0.5) delay = Math.min(delay * 2, 20000); else delay = Math.max(1200, Math.round(delay * 0.8));
        updateProgress(job, d.fetched ? `next batch in ${(delay / 1000).toFixed(1)}s` : "");
        await sleep(d.fetched ? delay : 150);
      } catch (e) {
        if (e.status === 409 || e.status === 404) { $("scan-status").textContent = e.message; S.stop = true; break; }
        netErrors++; $("scan-status").textContent = `Network/server problem (${e.message}). Retrying (${netErrors}/6)…`;
        if (netErrors >= 6) { S.stop = true; break; }
        await sleep(2500 * netErrors);
      }
    }
    if (job.status === "done") await retryFailures(job);
  } finally {
    S.running = false; updateProgress(S.job);
    if (S.job.status === "done") { $("scan-status").textContent = "Scan complete. Symbols without a usable quote are listed under the results."; }
    await loadFailuresAndCounts();
  }
}
async function retryFailures(job, maxRounds = 3) {
  for (let round = 0; round < maxRounds && !S.stop; round++) {
    let left = 1, guard = 0;
    while (left > 0 && !S.stop && guard++ < 60) {
      try {
        const d = await api("/api/scan/batch", { method: "POST", body: { owner: ownerKey, jobId: job.id, mode: "retry" } });
        job = d.job; mergeRows(d.rows); left = d.retryAvailable; S.job = job;
        updateProgress(job, left ? `retrying ${left} unavailable…` : "");
        if (!d.fetched) break;
        await sleep(d.throttled ? 6000 : 2000);
      } catch (e) { return; }
    }
    if (!left) return;
    await sleep(4000);
  }
}
async function loadFailuresAndCounts() {
  if (!S.job) return;
  try {
    const d = await api(`/api/scan/results?owner=${encodeURIComponent(ownerKey)}&jobId=${encodeURIComponent(S.job.id)}`);
    S.failures = d.failures || []; S.job = d.job; for (const r of d.rows) if (!S.rows.has(r.symbol)) S.rows.set(r.symbol, r);
    updateProgress(S.job); $("scan-retry").disabled = !S.failures.some((f) => f.attempts < 4) || S.running; renderAll();
  } catch { /* non-fatal */ }
}
async function startScan() {
  const scope = $("scope").value, { min, max } = priceBounds();
  const options = { minPrice: min, maxPrice: max, series: $("opt-be").checked ? ["EQ", "BE"] : ["EQ"], smartSkip: $("opt-skip").checked };
  const body = { owner: ownerKey, scope: scope === "all" ? "all" : "custom", options };
  try {
    if (scope === "watchlist") { const w = await api(`/api/watchlist?owner=${encodeURIComponent(ownerKey)}`); if (!w.items.length) throw new Error("Your watchlist is empty."); body.symbols = w.items.map((x) => x.symbol); }
    if (scope === "custom") body.symbols = $("symbols").value.split(",").map((s) => s.trim()).filter(Boolean);
    $("scan-status").textContent = "Starting scan…";
    const d = await api("/api/scan/start", { method: "POST", body });
    S.rows.clear(); S.failures = []; S.shown = 50; renderAll();
    $("scan-status").textContent = "Scanning in batches of 20. You can leave this tab open and pause any time.";
    driveJob(d.job);
  } catch (e) { $("scan-status").textContent = e.message; }
}
$("scan-start").addEventListener("click", startScan);
$("scan-pause").addEventListener("click", async () => {
  if (S.running) { S.stop = true; try { await api("/api/scan/pause", { method: "POST", body: { owner: ownerKey, jobId: S.job.id } }); S.job.status = "paused"; } catch {} $("scan-status").textContent = "Pausing after the current batch…"; }
  else if (S.job && S.job.status !== "done") { try { const d = await api("/api/scan/resume", { method: "POST", body: { owner: ownerKey, jobId: S.job.id } }); driveJob(d.job); } catch (e) { $("scan-status").textContent = e.message; } }
});
$("scan-retry").addEventListener("click", async () => {
  if (!S.job || S.running) return; S.running = true; S.stop = false; $("scan-retry").disabled = true; updateProgress(S.job);
  try { await retryFailures(S.job, 1); } finally { S.running = false; await loadFailuresAndCounts(); }
});

/* ---------- results rendering ---------- */
const SORTS = {
  "rank": (a, b) => b.rank - a.rank || a.symbol.localeCompare(b.symbol), "rank-asc": (a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol),
  "price-asc": (a, b) => a.price - b.price, "price-desc": (a, b) => b.price - a.price,
  "rsi-asc": (a, b) => (a.rsi ?? 999) - (b.rsi ?? 999), "rsi-desc": (a, b) => (b.rsi ?? -1) - (a.rsi ?? -1),
  "chg-desc": (a, b) => (b.changePct ?? -999) - (a.changePct ?? -999), "vol-desc": (a, b) => (b.avgVol20 ?? 0) - (a.avgVol20 ?? 0)
};
function filteredRows(ignoreSignal) {
  const { min, max } = priceBounds(), minVol = Number($("f-vol").value) || 0, q = $("f-q").value.trim().toUpperCase(), hide = $("f-hide-stale").checked;
  return [...S.rows.values()].filter((r) =>
    (min === null || r.price >= min) && (max === null || r.price <= max) && (minVol === 0 || (r.avgVol20 ?? 0) >= minVol) &&
    (!q || r.symbol.includes(q) || String(r.name).toUpperCase().includes(q)) && (!hide || freshOf(r.quoteTime) !== "STALE") &&
    (ignoreSignal || S.signal === "ALL" || r.signal === S.signal));
}
function resultCard(r) {
  const held = S.held[r.symbol], short = r.side === "SHORT_REF";
  const up = (r.changePct ?? 0) >= 0, tgtPct = ((r.target - r.entry) / r.entry) * 100, stopPct = ((r.stop - r.entry) / r.entry) * 100;
  return `<div class="result" data-symbol="${escapeHtml(r.symbol)}"><div>
    <b>${escapeHtml(r.symbol)}</b><span class="nm">${escapeHtml(r.name)}</span>
    <div class="px">${money(r.price)}<span class="chg ${up ? "up" : "down"}">${pct(r.changePct)}</span>${freshBadge(r.quoteTime)}</div>
    <small>RSI ${r.rsi === null ? "n/a" : r.rsi.toFixed(1)} · SMA20 ${r.sma20 ? money(r.sma20) : "n/a"} · SMA50 ${r.sma50 ? money(r.sma50) : "n/a"} · Avg vol ${compact(r.avgVol20)}${r.lowHistory ? " · short history" : ""}</small>
    <div class="levels"><div>${short ? "Short entry (ref.)" : "Entry"}<b>${money(r.entry)}</b></div><div class="t">Target ${tgtPct >= 0 ? "+" : "−"}${Math.abs(tgtPct).toFixed(1)}%<b>${money(r.target)}</b></div><div class="s">Stop ${stopPct >= 0 ? "+" : "−"}${Math.abs(stopPct).toFixed(1)}%<b>${money(r.stop)}</b></div></div>
    ${short ? '<small>Bearish: levels are a short-side reference only; the paper account is long-only.</small>' : ""}
  </div><div class="r-side"><span class="signal ${r.signal}">${r.signal}</span>
    <div class="btns">${short ? "" : '<button class="buy" data-act="buy">Buy</button>'}${held ? `<button class="sell" data-act="sell">Sell ${held}</button>` : ""}<button class="watch" data-act="watch">${S.watch.has(r.symbol) ? "✓" : "★"}</button></div></div></div>`;
}
function renderResults() {
  const all = filteredRows(true), list = filteredRows(false).sort(SORTS[$("f-sort").value] || SORTS.rank);
  for (const s of ["BULLISH", "BEARISH", "NEUTRAL"]) $("c-" + s).textContent = all.filter((r) => r.signal === s).length;
  $("c-ALL").textContent = all.length;
  const el = $("scan-results");
  if (!S.rows.size) el.innerHTML = '<div class="empty">No scan results yet.</div>';
  else if (!list.length) el.innerHTML = '<div class="empty">No stocks match these filters.</div>';
  else el.innerHTML = list.slice(0, S.shown).map(resultCard).join("");
  $("show-more").hidden = list.length <= S.shown; $("show-more").textContent = `Show more (${list.length - S.shown} left)`;
  $("scan-time").textContent = S.lastScanAt ? "Updated " + fmtTime(S.lastScanAt) : "";
  const fb = $("fail-box"); fb.hidden = !S.failures.length;
  $("fail-summary").textContent = `${S.failures.length} symbol(s) without a usable quote`;
  $("fail-list").innerHTML = S.failures.map((f) => `<b>${escapeHtml(f.symbol)}</b> — ${escapeHtml(f.error || "unavailable")}`).join("<br>");
}
function renderOverview() {
  const top = [...S.rows.values()].filter((r) => r.signal === "BULLISH" && freshOf(r.quoteTime) !== "STALE").sort(SORTS.rank).slice(0, 5);
  $("overview-results").innerHTML = top.length ? top.map((r) => `<div class="result"><div><b>${escapeHtml(r.symbol)}</b><span class="nm">${escapeHtml(r.name)}</span><div class="px">${money(r.price)} ${freshBadge(r.quoteTime)}</div><small>Entry ${money(r.entry)} · Target ${money(r.target)} · Stop ${money(r.stop)}</small></div><span class="signal BULLISH">BULLISH</span></div>`).join("") : '<div class="empty">Run a scan to see ranked setups here.</div>';
  $("overview-scan").textContent = S.job ? `Last scan: ${S.job.ok.toLocaleString("en-IN")} quotes from ${S.job.processed.toLocaleString("en-IN")} of ${S.job.total.toLocaleString("en-IN")} symbols examined.` : "";
}
function renderAll() { renderResults(); renderOverview(); }

/* ---------- portfolio ---------- */
function pnlClass(n) { return n > 0.005 ? "up" : n < -0.005 ? "down" : ""; }
function setPnl(id, n) { const el = $(id); el.textContent = signed(n); el.className = pnlClass(n); }
async function loadPortfolio() {
  try {
    const p = await api(`/api/portfolio?owner=${encodeURIComponent(ownerKey)}&live=1`);
    S.portfolio = p; S.held = {}; p.positions.forEach((x) => (S.held[x.symbol] = x.quantity)); S.lastPortfolioAt = p.summary.valuedAt;
    const m = p.summary;
    $("p-total").textContent = money(m.totalValue); $("ov-total").textContent = money(m.totalValue);
    $("p-total-sub").textContent = `Started with ${money(m.startingCash)}`; $("ov-total-sub").textContent = `Started with ${money(m.startingCash)}`;
    $("p-cash").textContent = money(m.availableCash); $("ov-cash").textContent = money(m.availableCash);
    $("p-invested").textContent = money(m.investedAmount); $("ov-invested").textContent = `Invested ${money(m.investedAmount)}`;
    $("p-count").textContent = `${p.positions.length} position${p.positions.length === 1 ? "" : "s"}`;
    setPnl("p-unreal", m.unrealizedPnL); setPnl("p-real", m.realizedPnL); setPnl("p-pnl", m.totalPnL); setPnl("ov-pnl", m.totalPnL);
    $("p-pnl-sub").textContent = pct(m.totalPnLPct); $("ov-pnl-sub").textContent = `${pct(m.totalPnLPct)} · realised + unrealised`;
    const warn = $("p-warn"); warn.hidden = m.valuationComplete;
    if (!m.valuationComplete) warn.textContent = `${m.unvalued} position(s) have no current quote and are carried at cost in the totals; their P&L is not counted.`;
    $("positions").innerHTML = p.positions.length ? p.positions.map((x) => {
      const live = x.valuation === "LIVE";
      return `<div class="row"><div><b>${escapeHtml(x.symbol)}</b><small class="hint">${x.quantity} shares · Avg ${money(x.averagePrice)} · Invested ${money(x.invested)}</small>
        <small class="hint">${live ? `Last ${money(x.lastPrice)} ${freshBadge(x.quoteTime)}` : `<span class="fresh UNAVAILABLE">Unavailable</span> ${escapeHtml(x.valuationError || "")}`}</small></div>
        <div class="pos-pnl"><b>${live ? money(x.marketValue) : "—"}</b>${live ? `<small class="${pnlClass(x.unrealizedPnL)}">${signed(x.unrealizedPnL)} (${pct(x.unrealizedPct)})</small>` : ""}<button class="secondary small" data-sell="${escapeHtml(x.symbol)}" style="margin-top:6px">Sell</button></div></div>`;
    }).join("") : '<div class="empty">No open positions.</div>';
    $("trades").innerHTML = p.trades.length ? p.trades.slice().reverse().slice(0, 15).map((t) => `<div class="row"><div><b>${t.side} ${escapeHtml(t.symbol)}</b><small class="hint">${t.quantity} shares @ ${money(t.price)} · ${fmt(t.executed_at.includes("T") ? t.executed_at : t.executed_at.replace(" ", "T") + "Z")}</small></div><div class="pos-pnl"><b>${money(t.price * t.quantity)}</b>${t.side === "SELL" ? `<small class="${pnlClass(t.realized)}">${signed(t.realized)} realised</small>` : ""}</div></div>`).join("") : '<div class="empty">No trades yet.</div>';
    $("p-updated").textContent = `Valued ${fmtTime(m.valuedAt)}. Prices are the latest the provider returned, not guaranteed real-time.`;
    renderResults();
  } catch (e) { $("positions").textContent = e.message; }
  updateRefreshText();
}
document.addEventListener("click", (ev) => { const b = ev.target.closest("[data-sell]"); if (b) openTrade("SELL", b.dataset.sell); });
$("p-refresh").addEventListener("click", loadPortfolio);

/* ---------- trade dialog ---------- */
const TD = { side: "BUY", symbol: "", price: null, acceptStale: false };
function maxQty() {
  if (TD.side === "SELL") return Math.floor(S.held[TD.symbol] || 0);
  const cash = S.portfolio?.cashBalance ?? 0; return TD.price ? Math.floor(cash / TD.price) : 0;
}
function updateEstimate() {
  const q = Number($("td-qty").value) || 0;
  $("td-est").textContent = TD.price ? `${q} × ${money(TD.price)} ≈ ${money(q * TD.price)} · max ${maxQty()}` : "Price is fetched when you confirm.";
}
function openTrade(side, symbol, row) {
  const r = row || S.rows.get(symbol);
  Object.assign(TD, { side, symbol, price: r?.price ?? null, acceptStale: false });
  $("td-title").textContent = `${side === "BUY" ? "Buy" : "Sell"} ${symbol} (paper)`;
  $("td-info").textContent = r ? `Scan price ${money(r.price)} (${FRESH_LABEL[freshOf(r.quoteTime)]}, ${ageText(r.quoteTime)}). The order fills at a fresh quote taken when you confirm, which may differ.` : "The order fills at the latest quote fetched when you confirm.";
  $("td-levels").textContent = r && side === "BUY" ? `Suggested: entry ${money(r.entry)} · target ${money(r.target)} · stop ${money(r.stop)}. Stops and targets are reminders; this simulator does not trigger them automatically.` : "";
  const mq = side === "SELL" ? maxQty() : Math.max(1, Math.min(maxQty(), 1));
  $("td-qty").value = Number($("trade-qty").value) > 0 && !row ? Math.floor(Number($("trade-qty").value)) || 1 : Math.max(1, mq || 1);
  $("td-msg").textContent = ""; $("td-confirm").textContent = "Confirm"; $("td-confirm").disabled = false; updateEstimate();
  $("trade-dialog").showModal();
}
$("td-qty").addEventListener("input", updateEstimate);
$("td-max").addEventListener("click", () => { $("td-qty").value = Math.max(1, maxQty()); updateEstimate(); });
$("td-cancel").addEventListener("click", () => $("trade-dialog").close());
$("td-confirm").addEventListener("click", async () => {
  const quantity = Number($("td-qty").value);
  if (!Number.isInteger(quantity) || quantity < 1) { $("td-msg").textContent = "Enter a whole number of shares."; return; }
  $("td-confirm").disabled = true; $("td-msg").textContent = "Fetching a fresh quote and placing the virtual order…";
  try {
    const d = await api("/api/trades", { method: "POST", body: { owner: ownerKey, symbol: TD.symbol, side: TD.side, quantity, acceptStale: TD.acceptStale } });
    $("trade-dialog").close();
    $("trade-status").textContent = `Paper ${TD.side} done: ${quantity} ${TD.symbol} at ${money(d.executed.price)} (${FRESH_LABEL[d.executed.freshness]}, quote ${fmt(d.executed.quoteTime)}). Total ${money(d.executed.total)}.`;
    await loadPortfolio(); scheduleRender();
  } catch (e) {
    if (e.status === 409 && e.data?.error === "STALE_QUOTE") {
      TD.acceptStale = true; TD.price = e.data.price;
      $("td-msg").textContent = `The latest quote is stale (${fmt(e.data.quoteTime)}, ${money(e.data.price)}). Confirm again only if you accept filling at that old price.`;
      $("td-confirm").textContent = "Fill at stale price"; updateEstimate();
    } else $("td-msg").textContent = e.message;
    $("td-confirm").disabled = false;
  }
});
$("buy-button").addEventListener("click", () => { const s = $("trade-symbol").value.trim().toUpperCase(); if (s) openTrade("BUY", s); else $("trade-status").textContent = "Enter a ticker first."; });
$("sell-button").addEventListener("click", () => { const s = $("trade-symbol").value.trim().toUpperCase(); if (s) openTrade("SELL", s); else $("trade-status").textContent = "Enter a ticker first."; });
$("scan-results").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]"); if (!btn) return;
  const sym = btn.closest(".result").dataset.symbol, row = S.rows.get(sym);
  if (btn.dataset.act === "buy") openTrade("BUY", sym, row);
  if (btn.dataset.act === "sell") openTrade("SELL", sym, row);
  if (btn.dataset.act === "watch") { try { await api("/api/watchlist", { method: "POST", body: { owner: ownerKey, symbol: sym } }); await loadWatchlist(); renderResults(); } catch (e) { $("scan-status").textContent = e.message; } }
});

/* ---------- watchlist ---------- */
async function loadWatchlist() {
  try {
    const d = await api(`/api/watchlist?owner=${encodeURIComponent(ownerKey)}`); S.watch = new Set(d.items.map((x) => x.symbol));
    $("watch-items").innerHTML = d.items.length ? d.items.map((x) => `<div class="row"><b>${escapeHtml(x.symbol)}</b><button class="secondary" data-remove="${escapeHtml(x.symbol)}">Remove</button></div>`).join("") : '<div class="empty">Your watchlist is empty. Add a ticker above or tap ★ on a scan result.</div>';
    document.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => { await api(`/api/watchlist?owner=${encodeURIComponent(ownerKey)}&symbol=${encodeURIComponent(b.dataset.remove)}`, { method: "DELETE" }); loadWatchlist(); renderResults(); }));
  } catch (e) { $("watch-items").textContent = e.message; }
}
$("add-watch").addEventListener("click", async () => {
  const symbol = $("watch-symbol").value.trim().toUpperCase(); if (!symbol) return;
  try { await api("/api/watchlist", { method: "POST", body: { owner: ownerKey, symbol } }); $("watch-symbol").value = ""; loadWatchlist(); } catch (e) { $("watch-items").textContent = e.message; }
});

/* ---------- auto refresh ---------- */
const prefs = { auto: localStorage.getItem("ml_auto") !== "0", every: localStorage.getItem("ml_every") || "60" };
$("auto-refresh").checked = prefs.auto; $("refresh-interval").value = prefs.every;
$("auto-refresh").addEventListener("change", () => { localStorage.setItem("ml_auto", $("auto-refresh").checked ? "1" : "0"); updateRefreshText(); });
$("refresh-interval").addEventListener("change", () => { localStorage.setItem("ml_every", $("refresh-interval").value); updateRefreshText(); });
function updateRefreshText() {
  const open = marketOpen();
  $("market-text").textContent = open ? "NSE session open (09:15–15:30 IST)" : "NSE session closed (09:15–15:30 IST, Mon–Fri)";
  $("refresh-text").textContent = (S.lastPortfolioAt ? `Portfolio updated ${fmtTime(S.lastPortfolioAt)}` : "Portfolio: —") + (S.lastScanAt ? ` · Scan data ${fmtTime(S.lastScanAt)}` : "") + (!$("auto-refresh").checked ? " · auto-refresh off" : open ? "" : " · slow refresh while market is closed");
}
async function refreshShortlist() {
  // re-quote the stocks currently at the top of the filtered list (one batch of 20), never during a full scan
  if (!S.job || S.running) return;
  const symbols = filteredRows(false).sort(SORTS[$("f-sort").value] || SORTS.rank).slice(0, 20).map((r) => r.symbol);
  if (!symbols.length) return;
  const d = await api("/api/scan/batch", { method: "POST", body: { owner: ownerKey, jobId: S.job.id, mode: "symbols", symbols } });
  mergeRows(d.rows); S.lastShortlistAt = Date.now();
}
setInterval(async () => {
  updateRefreshText(); scheduleRender();
  if (!$("auto-refresh").checked || document.hidden || S.busyRefresh) return;
  const every = (marketOpen() ? Number($("refresh-interval").value) : 600) * 1000;
  S.busyRefresh = true;
  try {
    if (!S.lastPortfolioAt || Date.now() - Date.parse(S.lastPortfolioAt) >= every) await loadPortfolio();
    if (marketOpen() && Date.now() - S.lastShortlistAt >= Math.max(every, 180000)) await refreshShortlist();
  } catch { /* shown by individual panels */ } finally { S.busyRefresh = false; }
}, 15000);

/* ---------- boot ---------- */
async function health() {
  if (!configured()) { setConnection(false, "Backend URL needed"); return; }
  try {
    const d = await api("/api/health");
    setConnection(true, d.database ? (d.universe === "schema-missing" ? "Backend connected — run the v0.3 database migration" : "Backend + D1 connected") : "Backend connected; D1 missing");
  } catch { setConnection(false, "Backend disconnected"); }
}
async function resumeLatest() {
  try {
    const d = await api(`/api/scan/latest?owner=${encodeURIComponent(ownerKey)}`);
    if (!d.job) return;
    S.job = d.job; const r = await api(`/api/scan/results?owner=${encodeURIComponent(ownerKey)}&jobId=${encodeURIComponent(d.job.id)}`);
    S.failures = r.failures || []; r.rows.forEach((x) => S.rows.set(x.symbol, x)); S.lastScanAt = d.job.updatedAt ? d.job.updatedAt.replace(" ", "T") + "Z" : null;
    updateProgress(d.job);
    $("scan-status").textContent = d.job.status === "done" ? "Showing your last completed scan. Start a new scan to refresh everything." : "A previous scan is unfinished. Press Resume to continue where it stopped.";
    $("scan-retry").disabled = !S.failures.some((f) => f.attempts < 4); renderAll();
  } catch { /* first run */ }
}
(async () => {
  updateRefreshText(); await health();
  await Promise.all([loadUniverse(), loadWatchlist()]);
  await resumeLatest(); await loadPortfolio();
})();
