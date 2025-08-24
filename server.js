// server.js — PriceHub (Binance + CoinCap + Paprika) + Krypto analyzer
// Node 18+ (global fetch). Keep your package.json "start": "node server.js"

import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const OPENAI_KEY = process.env.OPENAI_API_KEY || ""; // optional AI summary

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

/* ------------------------------- tiny cache ------------------------------- */
const cache = global.__pricehub_cache || (global.__pricehub_cache = {});
const setCache = (k, v, ttlMs) => (cache[k] = { v, ts: Date.now(), ttl: ttlMs });
const getCache = (k) => {
  const e = cache[k];
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) return null;
  return e.v;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------------------- coin id → symbol ---------------------------- */
/* Minimal seed for top caps. Add more over time (id -> { symbol, binancePair? }) */
const COINS = {
  bitcoin:  { symbol: "BTC", binancePair: "BTCUSDT" },
  ethereum: { symbol: "ETH", binancePair: "ETHUSDT" },
  tether:   { symbol: "USDT", binancePair: "USDTUSD" }, // rarely used; we’ll skip stable price
  bnb:      { symbol: "BNB", binancePair: "BNBUSDT" },
  solana:   { symbol: "SOL", binancePair: "SOLUSDT" },
  xrp:      { symbol: "XRP", binancePair: "XRPUSDT" },
  cardano:  { symbol: "ADA", binancePair: "ADAUSDT" },
  dogecoin: { symbol: "DOGE",binancePair: "DOGEUSDT" },
  tron:     { symbol: "TRX", binancePair: "TRXUSDT" },
  polkadot: { symbol: "DOT", binancePair: "DOTUSDT" },
  polygon:  { symbol: "MATIC",binancePair: "MATICUSDT" },
  litecoin: { symbol: "LTC", binancePair: "LTCUSDT" },
  chainlink:{ symbol: "LINK",binancePair: "LINKUSDT" },
  avalanche:{ symbol: "AVAX",binancePair: "AVAXUSDT" },
  stellar:  { symbol: "XLM", binancePair: "XLMUSDT" },
  vechain:  { symbol: "VET", binancePair: "VETUSDT" },
  cosmos:   { symbol: "ATOM",binancePair: "ATOMUSDT" },
  filecoin: { symbol: "FIL", binancePair: "FILUSDT" },
  aptos:    { symbol: "APT", binancePair: "APTUSDT" },
  arbitrum: { symbol: "ARB", binancePair: "ARBUSDT" },
  optimism: { symbol: "OP",  binancePair: "OPUSDT" },
  pepe:     { symbol: "PEPE",binancePair: "PEPEUSDT" },
  shiba-inu:{ symbol: "SHIB",binancePair: "SHIBUSDT" },
  render-token: { symbol: "RNDR", binancePair: "RNDRUSDT" },
  // add more here as needed…
};

/* ------------------------------ FX conversion ----------------------------- */
async function fxUSDTo(vs) {
  if (!vs || vs.toLowerCase() === "usd") return 1;
  const key = `fx:${vs}`;
  const hit = getCache(key);
  if (hit) return hit;
  const url = `https://api.exchangerate.host/latest?base=USD&symbols=${encodeURIComponent(vs.toUpperCase())}`;
  const r = await fetch(url);
  const j = await r.json();
  const rate = j?.rates?.[vs.toUpperCase()];
  if (!rate) throw new Error("fx_failed");
  setCache(key, rate, 5 * 60 * 1000); // 5m
  return rate;
}

/* -------------------------------- Binance --------------------------------- */
async function binancePriceUSDT(pair) {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
  if (!r.ok) throw new Error("binance_ticker_bad");
  const j = await r.json();
  const p = parseFloat(j?.price);
  if (!Number.isFinite(p)) throw new Error("binance_ticker_nan");
  return p; // USDT ≈ USD for majors
}
async function binanceKlines(pair, interval = "1h", limit = 1000) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error("binance_klines_bad");
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("binance_klines_not_array");
  return j.map(c => [c[0], parseFloat(c[4])]); // [openTime, close]
}

/* ---------------------------- CoinCap (fallback) --------------------------- */
async function coincapResolve(idOrSymbol) {
  // try direct id first
  let r = await fetch(`https://api.coincap.io/v2/assets/${idOrSymbol}`);
  if (r.ok) {
    const j = await r.json();
    if (j?.data?.id) return j.data.id;
  }
  // search
  r = await fetch(`https://api.coincap.io/v2/assets?search=${encodeURIComponent(idOrSymbol)}`);
  if (r.ok) {
    const j = await r.json();
    const first = j?.data?.[0]?.id;
    if (first) return first;
  }
  return null;
}
async function coincapPriceUSD(idOrSymbol) {
  const assetId = await coincapResolve(idOrSymbol);
  if (!assetId) throw new Error("coincap_resolve_failed");
  const r = await fetch(`https://api.coincap.io/v2/assets/${assetId}`);
  const j = await r.json();
  const p = parseFloat(j?.data?.priceUsd);
  if (!Number.isFinite(p)) throw new Error("coincap_price_nan");
  return p;
}
async function coincapHistoryUSD(idOrSymbol, days = 30) {
  const assetId = await coincapResolve(idOrSymbol);
  if (!assetId) throw new Error("coincap_resolve_failed");
  const interval = days <= 30 ? "h1" : "d1";
  const r = await fetch(`https://api.coincap.io/v2/assets/${assetId}/history?interval=${interval}`);
  const j = await r.json();
  const arr = j?.data || [];
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const out = arr
    .filter(p => p.time >= cutoff)
    .map(p => [p.time, parseFloat(p.priceUsd)])
    .filter(([_, v]) => Number.isFinite(v));
  if (!out.length) throw new Error("coincap_hist_empty");
  return out;
}

/* --------------------------- CoinPaprika (fallback) ------------------------ */
async function paprikaResolve(idOrSymbol) {
  const q = idOrSymbol.replace(/[^a-z0-9]+/gi, " ").trim();
  const r = await fetch(`https://api.coinpaprika.com/v1/search?q=${encodeURIComponent(q)}&c=currencies&limit=5`);
  const j = await r.json();
  const cur = j?.currencies?.[0]?.id;
  return cur || null;
}
async function paprikaPriceUSD(idOrSymbol) {
  const pid = await paprikaResolve(idOrSymbol);
  if (!pid) throw new Error("paprika_resolve_failed");
  const r = await fetch(`https://api.coinpaprika.com/v1/tickers/${pid}`);
  const j = await r.json();
  const p = parseFloat(j?.quotes?.USD?.price);
  if (!Number.isFinite(p)) throw new Error("paprika_price_nan");
  return p;
}

/* ----------------------- pair probing (Binance dynamic) -------------------- */
async function probeBinancePair(id) {
  const key = `pair:${id}`;
  const hit = getCache(key);
  if (hit !== null) return hit; // can be false
  // prefer explicit mapping
  const m = COINS[id];
  const guess = m?.binancePair || (m?.symbol ? `${m.symbol}USDT` : null);
  if (!guess) { setCache(key, false, 24*3600*1000); return false; }
  // try once
  try {
    await binancePriceUSDT(guess);
    setCache(key, guess, 24 * 3600 * 1000);
    return guess;
  } catch {
    setCache(key, false, 24 * 3600 * 1000);
    return false;
  }
}

/* ------------------------------ aggregators ------------------------------- */
async function getUSDPriceForId(id) {
  // 1) Binance
  const pair = await probeBinancePair(id);
  if (pair) { try { return await binancePriceUSDT(pair); } catch {} }
  // 2) CoinCap
  try { return await coincapPriceUSD(id); } catch {}
  // 3) Paprika
  try { return await paprikaPriceUSD(id); } catch {}
  throw new Error("all_price_sources_failed");
}

async function getUSDHistoryForId(id, days = 30) {
  // 1) Binance
  const pair = await probeBinancePair(id);
  if (pair) {
    try {
      const interval = days <= 7 ? "30m" : days <= 30 ? "1h" : "4h";
      const kl = await binanceKlines(pair, interval);
      const cutoff = Date.now() - days * 24 * 3600 * 1000;
      const sliced = kl.filter(([t]) => t >= cutoff);
      if (sliced.length) return sliced; // [[ts, closeUSD]]
    } catch {}
  }
  // 2) CoinCap
  try { return await coincapHistoryUSD(id, days); } catch {}
  throw new Error("all_history_sources_failed");
}

/* --------------------------------- routes --------------------------------- */
// Root & Health
app.get("/", (_req, res) => res.type("text/plain").send("✅ Crypto Flayer PriceHub running"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// /api/price?ids=bitcoin,ethereum&vs=inr
app.get("/api/price", async (req, res) => {
  try {
    const ids = (req.query.ids || "bitcoin,ethereum").toLowerCase().split(",").map(s => s.trim());
    const vs = (req.query.vs || "inr").toLowerCase();
    const key = `price:${ids.join(",")}:${vs}`;
    const hit = getCache(key);
    if (hit) return res.json({ ok: true, data: hit, cached: true });

    const rate = await fxUSDTo(vs);
    const out = {};
    for (const id of ids) {
      try {
        const usd = await getUSDPriceForId(id);
        out[id] = { [vs]: usd * rate, usd };
      } catch {
        out[id] = { error: "unavailable" };
      }
      await sleep(50); // be gentle
    }
    setCache(key, out, 60 * 1000); // 60s
    res.json({ ok: true, data: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "price_failed" });
  }
});

// /api/compare?symbols=bitcoin,ethereum&days=30&vs=inr
app.get("/api/compare", async (req, res) => {
  try {
    const symbols = (req.query.symbols || "bitcoin,ethereum").toLowerCase().split(",").map(s => s.trim());
    const days = parseInt(req.query.days || "30", 10);
    const vs = (req.query.vs || "inr").toLowerCase();
    const key = `cmp:${symbols.join(",")}:${days}:${vs}`;
    const hit = getCache(key);
    if (hit) return res.json({ ok: true, ...hit, cached: true });

    const rate = await fxUSDTo(vs);
    const items = [];
    for (const id of symbols) {
      try {
        const histUSD = await getUSDHistoryForId(id, days); // [[ts, closeUSD]]
        const prices = histUSD.map(([ts, close]) => [ts, close * rate]);
        items.push({ id, prices });
      } catch {
        items.push({ id, error: "history_unavailable", prices: [] });
      }
      await sleep(50);
    }
    const payload = { items, vs, days };
    setCache(key, payload, 5 * 60 * 1000); // 5m
    res.json({ ok: true, ...payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "compare_failed" });
  }
});

/* ----------------------------- Krypto analyzer ---------------------------- */
// math helpers
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const SMA = (arr, n) => (arr.length >= n ? mean(arr.slice(-n)) : NaN);
const RSI = (arr, period = 14) => {
  if (arr.length <= period) return NaN;
  let g = 0, l = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  const RS = g / Math.max(1e-9, l);
  return 100 - 100 / (1 + RS);
};
const MACD = (arr, fast = 12, slow = 26, signal = 9) => {
  if (arr.length < slow + signal) return { macd: NaN, signal: NaN, hist: NaN };
  const kF = 2 / (fast + 1), kS = 2 / (slow + 1);
  let emaF = mean(arr.slice(0, fast)), emaS = mean(arr.slice(0, slow));
  const fastS=[], slowS=[];
  for (let i=0;i<arr.length;i++){
    const p=arr[i];
    if (i>=fast-1){ emaF=p*kF+emaF*(1-kF); fastS.push(emaF); }
    if (i>=slow-1){ emaS=p*kS+emaS*(1-kS); slowS.push(emaS); }
  }
  const start = Math.max(0, fastS.length - slowS.length);
  const macdSeries = fastS.slice(start).map((x,i)=>x - slowS[i]);
  const kSig = 2 / (signal + 1);
  let sig = mean(macdSeries.slice(0, signal));
  for (let i=signal;i<macdSeries.length;i++) sig = macdSeries[i]*kSig + sig*(1-kSig);
  const macd = macdSeries[macdSeries.length-1];
  return { macd, signal: sig, hist: macd - sig };
};
const trendSlope = (arr, n=30) => {
  const a = arr.slice(-n); const m=a.length; if (m<2) return 0;
  const xs = Array.from({length:m},(_,i)=>i/(m-1));
  const xm = mean(xs), ym = mean(a);
  let num=0, den=0;
  for (let i=0;i<m;i++){ num += (xs[i]-xm)*(a[i]-ym); den += (xs[i]-xm)**2; }
  return den ? (num/den)/Math.max(1e-9, ym) : 0;
};

async function analyzeSymbol(symbol="bitcoin", vs="inr", days=60) {
  const rate = await fxUSDTo(vs);
  const histUSD = await getUSDHistoryForId(symbol, days);
  const prices = histUSD.map(([_, close]) => close * rate);
  if (!prices.length) throw new Error("no price data");
  const last = prices[prices.length-1];
  const sma20 = SMA(prices, 20), sma50 = SMA(prices, 50);
  const rsi14 = RSI(prices, 14);
  const { macd, signal, hist } = MACD(prices);
  const slope = trendSlope(prices, 30);

  const rets=[]; for (let i=1;i<prices.length;i++) rets.push(Math.log(prices[i]/prices[i-1]));
  const vol7 = stdev(rets.slice(-24*7));

  let score=0;
  score += sma20 > sma50 ? 1 : -1;
  score += macd > signal ? 1 : -1;
  if (rsi14 > 60) score++; else if (rsi14 < 40) score--;
  score += slope * 50;

  const norm = Math.max(-3, Math.min(3, score))/3;
  const sigText = norm > 0.25 ? "bullish" : norm < -0.25 ? "bearish" : "neutral";
  const confidence = Math.max(0.1, Math.min(0.95, 0.5 - (vol7||0)*2 + Math.abs(norm)*0.5));

  const expMove = Math.max(0.004, Math.min(0.05, (vol7||0.01)*1.2));
  const drift = norm * 0.012;
  const lowPct = drift - expMove, highPct = drift + expMove;

  const result = {
    ok: true, symbol, vs, latest_price: last,
    indicators: { sma20, sma50, rsi14, macd, macdSignal: signal, macdHist: hist, trendSlope: slope, vol7 },
    signal: sigText, confidence,
    prediction: { horizon_hours: 24, band_abs: [last*(1+lowPct), last*(1+highPct)], band_pct: [lowPct, highPct] },
    summary: `Signal: ${sigText}, Confidence ${(confidence*100).toFixed(0)}%`,
    disclaimer: "Educational use only. This is NOT financial advice."
  };

  if (OPENAI_KEY) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are Krypto the Kangaroo: concise, cautious, 2–3 sentences, end with: ⚠️ Not financial advice." },
            { role: "user", content: JSON.stringify({
                symbol, vs, last, indicators: result.indicators, signal: result.signal,
                band_pct: result.prediction.band_pct
              })
            }
          ]
        })
      });
      const j = await r.json();
      result.krypto_summary = j?.choices?.[0]?.message?.content || "Summary unavailable. ⚠️ Not financial advice.";
    } catch {
      result.krypto_summary = "AI summary failed. ⚠️ Not financial advice.";
    }
  }
  return result;
}

// GET /api/krypto/analyze?symbol=bitcoin&vs=inr
app.get("/api/krypto/analyze", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "bitcoin").toLowerCase();
    const vs = (req.query.vs || "inr").toLowerCase();
    const result = await analyzeSymbol(symbol, vs, 60);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "analyze_failed" });
  }
});

// POST /api/krypto/analyze/raw  { symbol, vs, prices:[[ts, price], ...] }
app.post("/api/krypto/analyze/raw", async (req, res) => {
  try {
    const { symbol="bitcoin", vs="inr", prices } = req.body || {};
    if (!Array.isArray(prices) || prices.length < 40) {
      return res.status(400).json({ ok: false, error: "prices array required (>=40 points)" });
    }
    const P = prices.map(row => Array.isArray(row)? row[1] : row).map(Number).filter(Number.isFinite);
    if (!P.length) return res.status(400).json({ ok: false, error: "invalid prices" });

    // Reuse indicator stack
    const last = P[P.length-1];
    const sma20 = SMA(P, 20), sma50 = SMA(P, 50);
    const rsi14 = RSI(P, 14);
    const { macd, signal, hist } = MACD(P);
    const slope = trendSlope(P, 30);
    const rets=[]; for (let i=1;i<P.length;i++) rets.push(Math.log(P[i]/P[i-1]));
    const vol7 = stdev(rets.slice(-24*7));
    let score=0; score += sma20 > sma50 ? 1 : -1; score += macd > signal ? 1 : -1;
    if (rsi14 > 60) score++; else if (rsi14 < 40) score--; score += slope * 50;
    const norm = Math.max(-3, Math.min(3, score))/3;
    const sigText = norm > 0.25 ? "bullish" : norm < -0.25 ? "bearish" : "neutral";
    const confidence = Math.max(0.1, Math.min(0.95, 0.5 - (vol7||0)*2 + Math.abs(norm)*0.5));
    const expMove = Math.max(0.004, Math.min(0.05, (vol7||0.01)*1.2));
    const drift = norm * 0.012;
    const lowPct = drift - expMove, highPct = drift + expMove;

    res.json({
      ok: true, symbol, vs, latest_price: last,
      indicators: { sma20, sma50, rsi14, macd, macdSignal: signal, macdHist: hist, trendSlope: slope, vol7 },
      signal: sigText, confidence,
      prediction: { horizon_hours: 24, band_abs: [last*(1+lowPct), last*(1+highPct)], band_pct: [lowPct, highPct] },
      summary: `Signal: ${sigText}, Confidence ${(confidence*100).toFixed(0)}%`,
      disclaimer: "Educational use only. This is NOT financial advice."
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "analyze_raw_failed" });
  }
});

/* --------------------------------- start ---------------------------------- */
app.listen(PORT, () => console.log(`PriceHub listening on :${PORT}`));
