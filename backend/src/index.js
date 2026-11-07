const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  "Vary": "Origin"
});
const json = (data, status=200, origin="*") => new Response(JSON.stringify(data), {
  status, headers: {...cors(origin), "Content-Type":"application/json; charset=utf-8"}
});
const now = () => new Date().toISOString();
function symbolOf(value) {
  const s = String(value || "").trim().toUpperCase().replace(/\.NS$/,"");
  return /^[A-Z0-9&_-]{1,24}$/.test(s) ? s : null;
}
function ownerOf(value) {
  const s = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(s) ? s : null;
}
async function ensureOwner(db, owner) {
  await db.prepare("INSERT OR IGNORE INTO owners(owner) VALUES (?)").bind(owner).run();
  await db.prepare("INSERT OR IGNORE INTO paper_accounts(owner) VALUES (?)").bind(owner).run();
}
async function quote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol+".NS")}?range=3mo&interval=1d`;
  const r = await fetch(url, {headers:{"Accept":"application/json","User-Agent":"Mozilla/5.0 MarketLens/0.2"}, cf:{cacheTtl:0}});
  if (!r.ok) throw new Error(`Quote provider HTTP ${r.status}`);
  const body = await r.json();
  const item = body?.chart?.result?.[0];
  if (!item) throw new Error(body?.chart?.error?.description || "No quote returned");
  const q = item.indicators?.quote?.[0] || {};
  const closes = (q.close || []).map(Number).filter(Number.isFinite);
  const price = Number(item.meta?.regularMarketPrice ?? closes.at(-1));
  const timestamp = Number(item.meta?.regularMarketTime || item.timestamp?.at(-1));
  if (!Number.isFinite(price) || !Number.isFinite(timestamp)) throw new Error("Quote missing price or timestamp");
  const previous = Number(item.meta?.chartPreviousClose ?? item.meta?.previousClose);
  const changePercent = Number.isFinite(previous) && previous ? (price-previous)/previous*100 : null;
  const sma = (n) => closes.length >= n ? closes.slice(-n).reduce((a,b)=>a+b,0)/n : null;
  const gains=[], losses=[];
  for (let i=Math.max(1,closes.length-15); i<closes.length; i++) {
    const d=closes[i]-closes[i-1]; if(d>=0) gains.push(d); else losses.push(-d);
  }
  const avgGain=gains.length?gains.reduce((a,b)=>a+b,0)/14:0;
  const avgLoss=losses.length?losses.reduce((a,b)=>a+b,0)/14:0;
  const rsi=avgLoss===0 ? (avgGain===0?50:100) : 100-(100/(1+avgGain/avgLoss));
  return {symbol, name:item.meta?.longName||item.meta?.shortName||symbol, price, currency:item.meta?.currency||"INR",
    changePercent, timestamp:new Date(timestamp*1000).toISOString(), source:"Yahoo Finance (unofficial)",
    sma20:sma(20), sma50:sma(50), rsi, closes:closes.slice(-60),
    note:"Unofficial prototype data; may be delayed, incomplete, throttled or unavailable. Not an exchange-authorized real-time feed."};
}
function classify(q) {
  let score=0;
  if(q.sma20!==null && q.sma50!==null) score += q.sma20>q.sma50?1:-1;
  if(q.sma20!==null) score += q.price>q.sma20?1:-1;
  if(q.rsi<35) score+=1;
  if(q.rsi>70) score-=1;
  const signal=score>=2?"BULLISH":score<=-2?"BEARISH":"NEUTRAL";
  const stop=q.price*0.97, target=q.price*1.06;
  return {signal, score, rsi:q.rsi, sma20:q.sma20, sma50:q.sma50,
    entry:q.price, suggestedTarget:target, suggestedStopLoss:stop,
    rationale:"Prototype rule-based screen using daily SMA20/SMA50 trend and RSI. Signals are educational, not validated predictions."};
}
async function getPortfolio(db, owner) {
  const account=await db.prepare("SELECT starting_cash,cash_balance FROM paper_accounts WHERE owner=?").bind(owner).first();
  const rows=await db.prepare("SELECT symbol,side,quantity,price,executed_at FROM paper_trades WHERE owner=? ORDER BY id ASC").bind(owner).all();
  const positions={};
  for(const t of rows.results||[]) {
    const p=positions[t.symbol] ||= {quantity:0, invested:0};
    if(t.side==="BUY"){p.quantity+=t.quantity;p.invested+=t.quantity*t.price;}
    else {const avg=p.quantity>0?p.invested/p.quantity:0; p.quantity-=t.quantity;p.invested=Math.max(0,p.invested-t.quantity*avg);}
  }
  return {startingCash:account?.starting_cash??5000,cashBalance:account?.cash_balance??5000,
    positions:Object.entries(positions).filter(([,p])=>p.quantity>0.000001).map(([symbol,p])=>({symbol,quantity:p.quantity,averagePrice:p.invested/p.quantity,invested:p.invested})),
    trades:rows.results||[]};
}
export default {
 async fetch(request, env) {
  const origin=request.headers.get("Origin")||"*";
  const allowed=env.ALLOWED_ORIGIN||"*";
  const responseOrigin=allowed==="*"||origin===allowed?origin:allowed;
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:cors(responseOrigin)});
  const u=new URL(request.url), path=u.pathname;
  try {
   if(path==="/api/health" && request.method==="GET") return json({ok:true,service:"MarketLens API",time:now(),database:!!env.DB,version:"0.2.0"},200,responseOrigin);
   if(path==="/api/quote" && request.method==="GET") {
    const s=symbolOf(u.searchParams.get("symbol")||"RELIANCE"); if(!s)return json({error:"Invalid NSE ticker"},400,responseOrigin);
    return json(await quote(s),200,responseOrigin);
   }
   if(path==="/api/watchlist" && request.method==="GET") {
    const owner=ownerOf(u.searchParams.get("owner")); if(!owner)return json({error:"Invalid owner"},400,responseOrigin);
    await ensureOwner(env.DB,owner);
    const rows=await env.DB.prepare("SELECT symbol,created_at FROM watchlists WHERE owner=? ORDER BY symbol").bind(owner).all();
    return json({items:rows.results||[]},200,responseOrigin);
   }
   if(path==="/api/watchlist" && (request.method==="POST"||request.method==="DELETE")) {
    const data=request.method==="POST"?await request.json():Object.fromEntries(u.searchParams);
    const owner=ownerOf(data.owner), symbol=symbolOf(data.symbol);
    if(!owner||!symbol)return json({error:"Valid owner and symbol are required"},400,responseOrigin);
    await ensureOwner(env.DB,owner);
    if(request.method==="POST") await env.DB.prepare("INSERT OR IGNORE INTO watchlists(owner,symbol) VALUES(?,?)").bind(owner,symbol).run();
    else await env.DB.prepare("DELETE FROM watchlists WHERE owner=? AND symbol=?").bind(owner,symbol).run();
    return json({ok:true},200,responseOrigin);
   }
   if(path==="/api/scan" && request.method==="POST") {
    const data=await request.json(), owner=ownerOf(data.owner);
    if(!owner)return json({error:"Valid owner is required"},400,responseOrigin);
    await ensureOwner(env.DB,owner);
    const raw=Array.isArray(data.symbols)?data.symbols:[];
    const symbols=[...new Set(raw.map(symbolOf).filter(Boolean))].slice(0,25);
    if(!symbols.length)return json({error:"Add at least one ticker; maximum 25 per scan in this prototype."},400,responseOrigin);
    const results=[];
    for(const symbol of symbols) {
      try {
       const q=await quote(symbol), signal=classify(q);
       await env.DB.prepare("INSERT INTO scan_runs(owner,symbol,price,signal,rsi,sma20,sma50) VALUES(?,?,?,?,?,?,?)")
        .bind(owner,symbol,q.price,signal.signal,signal.rsi,signal.sma20,signal.sma50).run();
       results.push({...q,...signal});
      } catch(e) {results.push({symbol,error:e.message,signal:"UNAVAILABLE"});}
    }
    return json({scannedAt:now(),count:results.length,results},200,responseOrigin);
   }
   if(path==="/api/portfolio" && request.method==="GET") {
    const owner=ownerOf(u.searchParams.get("owner")); if(!owner)return json({error:"Invalid owner"},400,responseOrigin);
    await ensureOwner(env.DB,owner); return json(await getPortfolio(env.DB,owner),200,responseOrigin);
   }
   if(path==="/api/trades" && request.method==="GET") {
    const owner=ownerOf(u.searchParams.get("owner")); if(!owner)return json({error:"Invalid owner"},400,responseOrigin);
    await ensureOwner(env.DB,owner);
    const rows=await env.DB.prepare("SELECT id,symbol,side,quantity,price,executed_at FROM paper_trades WHERE owner=? ORDER BY id DESC LIMIT 100").bind(owner).all();
    return json({trades:rows.results||[]},200,responseOrigin);
   }
   if(path==="/api/trades" && request.method==="POST") {
    const d=await request.json(), owner=ownerOf(d.owner), symbol=symbolOf(d.symbol), side=String(d.side||"").toUpperCase(), qty=Number(d.quantity);
    if(!owner||!symbol||!["BUY","SELL"].includes(side)||!Number.isFinite(qty)||qty<=0||qty>100000)
      return json({error:"Provide valid owner, symbol, BUY/SELL and positive quantity"},400,responseOrigin);
    await ensureOwner(env.DB,owner);
    const q=await quote(symbol), cost=q.price*qty;
    const account=await env.DB.prepare("SELECT cash_balance FROM paper_accounts WHERE owner=?").bind(owner).first();
    if(side==="BUY" && account.cash_balance<cost) return json({error:"Insufficient virtual cash"},400,responseOrigin);
    const pos=await getPortfolio(env.DB,owner);
    const holding=pos.positions.find(p=>p.symbol===symbol);
    if(side==="SELL" && (!holding||holding.quantity<qty)) return json({error:"Not enough virtual shares to sell"},400,responseOrigin);
    const delta=side==="BUY"?-cost:cost;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO paper_trades(owner,symbol,side,quantity,price) VALUES(?,?,?,?,?)").bind(owner,symbol,side,qty,q.price),
      env.DB.prepare("UPDATE paper_accounts SET cash_balance=cash_balance+? WHERE owner=?").bind(delta,owner)
    ]);
    return json({ok:true,executed:{symbol,side,quantity:qty,price:q.price,total:cost,timestamp:now()},portfolio:await getPortfolio(env.DB,owner)},200,responseOrigin);
   }
   if(path==="/api/ai/analyze" && request.method==="POST") {
    if(!env.OPENAI_API_KEY)return json({configured:false,message:"AI is not configured. Add OPENAI_API_KEY as a Cloudflare Worker secret."},200,responseOrigin);
    const d=await request.json();
    const prompt=`Explain this stock-screen result in plain language. Do not claim certainty or give personalized financial advice. State limitations. Data: ${JSON.stringify({symbol:d.symbol,quote:d.quote,signal:d.signal})}`;
    const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Authorization":`Bearer ${env.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:env.OPENAI_MODEL||"gpt-4.1-mini",input:prompt})});
    const body=await r.json();
    if(!r.ok)return json({configured:true,error:body.error?.message||"AI provider request failed"},502,responseOrigin);
    const textOut=(body.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==="output_text").map(x=>x.text).join("\n");
    return json({configured:true,analysis:textOut||"No text returned by AI provider."},200,responseOrigin);
   }
   return json({error:"Not found"},404,responseOrigin);
  } catch(e) { return json({error:e.message||"Internal error"},500,responseOrigin); }
 }
};
