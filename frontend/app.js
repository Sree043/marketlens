// Paste your deployed Worker URL here after deployment. Keep the quotes.
const API_BASE_URL = "https://marketlens.sreekeshsree100.workers.dev";
const ownerKey = (() => {
  let key = localStorage.getItem("marketlens_owner");
  if (!key) { key = "ml_" + crypto.randomUUID().replaceAll("-",""); localStorage.setItem("marketlens_owner",key); }
  return key;
})();
const $ = (id) => document.getElementById(id);
const money = (n) => new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(n)||0);
const fmt = (v) => v ? new Date(v).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Kolkata"})+" IST" : "—";
const configured = () => API_BASE_URL.startsWith("https://") && !API_BASE_URL.includes("REPLACE-WITH");
async function api(path, options={}) {
  if (!configured()) throw new Error("Backend URL not configured. Set API_BASE_URL in frontend/app.js.");
  const res = await fetch(API_BASE_URL+path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})},cache:"no-store"});
  const data=await res.json().catch(()=>({error:"Invalid server response"}));
  if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`);
  return data;
}
function setConnection(ok,msg){$("connection-dot").className="dot "+(ok?"ok":"bad");$("connection-text").textContent=msg;}
function activateTab(name){document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===name));document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===name));}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>activateTab(b.dataset.tab)));
document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>activateTab(b.dataset.goto)));
function renderResults(results,target) {
  if(!results?.length){target.innerHTML='<div class="empty">No results returned.</div>';return;}
  target.innerHTML=results.map(r=>`<div class="result"><div><b>${r.symbol} · ${r.name||r.symbol}</b><small>${r.error?escapeHtml(r.error):`Price ${money(r.price)} · RSI ${Number(r.rsi).toFixed(1)} · SMA20 ${r.sma20?money(r.sma20):"n/a"} · SMA50 ${r.sma50?money(r.sma50):"n/a"}<br>Source: ${escapeHtml(r.source||"")} · ${fmt(r.timestamp)}`}</small></div><span class="signal ${r.signal||"UNAVAILABLE"}">${r.signal||"UNAVAILABLE"}</span></div>`).join("");
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function loadPortfolio(){
 try{const p=await api(`/api/portfolio?owner=${encodeURIComponent(ownerKey)}`);
  $("cash").textContent=money(p.cashBalance);$("paper-cash").textContent=money(p.cashBalance);
  $("positions-count").textContent=p.positions.length;$("paper-positions-count").textContent=p.positions.length;
  $("positions").innerHTML=p.positions.length?p.positions.map(x=>`<div class="row"><div><b>${x.symbol}</b><small class="hint">${x.quantity} shares · Avg ${money(x.averagePrice)}</small></div><b>${money(x.invested)}</b></div>`).join(""):'<div class="empty">No open positions.</div>';
  $("trades").innerHTML=p.trades.length?p.trades.slice().reverse().slice(0,12).map(t=>`<div class="row"><div><b>${t.side} ${t.symbol}</b><small class="hint">${t.quantity} shares · ${fmt(t.executed_at)}</small></div><b>${money(t.price*t.quantity)}</b></div>`).join(""):'<div class="empty">No trades yet.</div>';
 }catch(e){$("positions").textContent=e.message;$("trades").textContent=e.message;}
}
async function loadWatchlist(){
 try{const d=await api(`/api/watchlist?owner=${encodeURIComponent(ownerKey)}`);
  $("watch-items").innerHTML=d.items.length?d.items.map(x=>`<div class="row"><b>${x.symbol}</b><button class="secondary" data-remove="${x.symbol}">Remove</button></div>`).join(""):'<div class="empty">Your watchlist is empty. Add a ticker above.</div>';
  document.querySelectorAll("[data-remove]").forEach(b=>b.addEventListener("click",async()=>{await api(`/api/watchlist?owner=${encodeURIComponent(ownerKey)}&symbol=${encodeURIComponent(b.dataset.remove)}`,{method:"DELETE"});loadWatchlist();}));
 }catch(e){$("watch-items").textContent=e.message;}
}
async function health(){
 if(!configured()){setConnection(false,"Backend URL needed");return;}
 try{const d=await api("/api/health");setConnection(true,d.database?"Backend + D1 connected":"Backend connected; D1 missing");}
 catch(e){setConnection(false,"Backend disconnected");}
}
async function runScan(symbols){
 $("scan-button").disabled=true;$("scan-status").textContent="Scanning symbols. Provider limits may affect results…";
 try{const d=await api("/api/scan",{method:"POST",body:JSON.stringify({owner:ownerKey,symbols})});
  $("scan-count").textContent=d.count;$("scan-time").textContent="Scanned "+fmt(d.scannedAt);
  renderResults(d.results,$("scan-results"));renderResults(d.results.filter(x=>x.signal==="BULLISH"||x.signal==="BEARISH").slice(0,5),$("overview-results"));
  $("scan-status").textContent=`Completed ${d.count} symbol checks. Unavailable quotes are shown individually.`;
 }catch(e){$("scan-status").textContent=e.message;}
 finally{$("scan-button").disabled=false;}
}
$("scan-button").addEventListener("click",()=>runScan($("symbols").value.split(",").map(s=>s.trim()).filter(Boolean)));
$("scan-watchlist").addEventListener("click",async()=>{try{const d=await api(`/api/watchlist?owner=${encodeURIComponent(ownerKey)}`);if(!d.items.length)throw new Error("Watchlist is empty. Add symbols in the Watchlist tab.");$("symbols").value=d.items.map(x=>x.symbol).join(",");runScan(d.items.map(x=>x.symbol));}catch(e){$("scan-status").textContent=e.message;}});
$("add-watch").addEventListener("click",async()=>{const symbol=$("watch-symbol").value.trim().toUpperCase();if(!symbol)return;try{await api("/api/watchlist",{method:"POST",body:JSON.stringify({owner:ownerKey,symbol})});$("watch-symbol").value="";loadWatchlist();}catch(e){$("watch-items").textContent=e.message;}});
async function trade(side){
 const symbol=$("trade-symbol").value.trim().toUpperCase(),quantity=Number($("trade-qty").value);
 $("trade-status").textContent="Getting quote and submitting virtual order…";
 try{const d=await api("/api/trades",{method:"POST",body:JSON.stringify({owner:ownerKey,symbol,side,quantity})});
  $("trade-status").textContent=`Paper ${side} completed: ${quantity} ${symbol} at ${money(d.executed.price)}. Virtual total ${money(d.executed.total)}.`;
  loadPortfolio();
 }catch(e){$("trade-status").textContent=e.message;}
}
$("buy-button").addEventListener("click",()=>trade("BUY"));$("sell-button").addEventListener("click",()=>trade("SELL"));
(async()=>{await health();await Promise.all([loadPortfolio(),loadWatchlist()]);})();
