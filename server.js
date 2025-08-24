// server.js
import express from "express";
import cors from "cors";

const app = express();

/* ------------------------------- config ------------------------------- */
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const OPENAI_KEY = process.env.OPENAI_API_KEY || ""; // optional for krypto summary

// Node 18+ has global fetch
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

/* ------------------------------- cache -------------------------------- */
const cache = global.__kcache || (global.__kcache = {});
const setCache = (k, v, ttlMs = 60_000) =>
  (cache[k] = { v, ts: Date.now(), ttl: ttlMs });
const getCache = (k) => {
  const e = cache[k];
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) return null;
  return e.v;
};

/* ------------------------------- maps --------------------------------- */
/** Map a Coingecko-ish id to a tradeable pair on Binance (USDT).
 *  If a key contains hyphens, it MUST be quoted. */
const COINS = {
  bitcoin: { symbol: "BTC", binancePair: "BTCUSDT", coinbase: "BTC-USD" },
  ethereum: { symbol: "ETH", binancePair: "ETHUSDT", coinbase: "ETH-USD" },
  xrp: { symbol: "XRP", binancePair: "XRPUSDT", coinbase: "XRP-USD" },
  tether: { symbol: "USDT", binancePair: "USDTUSDT", coinbase: "USDT-USD" }, // price ≈ 1 USD
  bnb: { symbol: "BNB", binancePair: "BNBUSDT", coinbase: "BNB-USD" },
  solana: { symbol: "SOL", binancePair: "SOLUSDT", coinbase: "SOL-USD" },
  "usd-coin": { symbol: "USDC", binancePair: "USDCUSDT", coinbase: "USDC-USD" },
  dogecoin: { symbol: "DOGE", binancePair: "DOGEUSDT", coinbase: "DOGE-USD" },
  cardano: { symbol: "ADA", binancePair: "ADAUSDT", coinbase: "ADA-USD" },
  tron: { symbol: "TRX", binancePair: "TRXUSDT", coinbase: "TRX-USD" },
  polkadot: { symbol: "DOT", binancePair: "DOTUSDT", coinbase: "DOT-USD" },
  polygon: { symbol: "MATIC", binancePair: "MATICUSDT", coinbase: "MATIC-USD" },
  litecoin: { symbol: "LTC", binancePair: "LTCUSDT", coinbase: "LTC-USD" },
  chainlink: { symbol: "LINK", binancePair: "LINKUSDT", coinbase: "LINK-USD" },
  "bitcoin-cash": { symbol: "BCH", binancePair: "BCHUSDT", coinbase: "BCH-USD" },
  "wrapped-bitcoin": { symbol: "WBTC", binancePair: "WBTCUSDT", coinbase: "WBTC-USD" },
  "lido-staked-ether": { symbol: "STETH", binancePair: "ETHUSDT", coinbase: "ETH-USD" }, // proxy to ETH
  "leo-token": { symbol: "LEO", binancePair: null, coinbase: "LEO-USD" },
  "render-token": { symbol: "RNDR", binancePair: "RNDRUSDT", coinbase: "RNDR-USD" },
  "shiba-inu": { symbol: "SHIB", binancePair: "SHIBUSDT", coinbase: "SHIB-USD" },
  stellar: { symbol: "XLM", binancePair: "XLMUSDT", coinbase: "XLM-USD" },
  avax: { symbol: "AVAX", binancePair: "AVAXUSDT", coinbase: "AVAX-USD" },
  hedera: { symbol: "HBAR", binancePair: "HBARUSDT", coinbase: "HBAR-USD" },
  toncoin: { symbol: "TON", binancePair: "TONUSDT", coinbase: "TON-USD" },
  // add more as needed
};

/* ----------------------------- helpers -------------------------------- */
// Simple delay helper for fallback pacing
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// USD → INR (via Coinbase exchange-rates)
async function getUsdToInr() {
  const ck = "fx:usd:inr";
  const hit = getCache(ck);
  if (hit) return hit;

  const r = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD");
  const j = await r.json();
  const rate = Number(j?.data?.rates?.INR || 0);
  if (!rate) throw new Error("fx_failed");
  setCache(ck, rate, 5 * 60_000); // 5 min cache
  return rate;
}

// Get latest price (USD) for one id using Binance → fallback Coinbase
async function getSpotUsdForId(id) {
  const meta = COINS[id];
  if (!meta) throw new Error(`unknown_id:${id}`);

  // 1) Binance ticker (preferred)
  if (meta.binancePair) {
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${meta.binancePair}`;
      const r = await fetch(url);
      const j = await r.json();
      const price = Number(j?.price || 0);
      if (price > 0) return price; // USDT≈USD
    } catch {
      // fall through
    }
  }

  // 2) Coinbase spot fallback
  if (meta.coinbase) {
    await sleep(80); // be polite
    try {
      const url = `https://api.coinbase.com/v2/prices/${meta.coinbase}/spot`;
      const r = await fetch(url);
      const j = await r.json();
      const price = Number(j?.data?.amount || 0);
      if (price > 0) return price;
    } catch {
      // fall through
    }
  }

  throw new Error(`no_price:${id}`);
}

// Get OHLC/series (USD) via Binance klines; fallback Coinbase candles
// interval = 1h; days up to ~365 supported (Binance limit 1000 candles per call)
async function getUsdSeriesForId(id, days = 60) {
  const meta = COINS[id];
  if (!meta) throw new Error(`unknown_id:${id}`);

  const limit = Math.min(24 * Number(days || 60), 960); // cap for safety

  // 1) Binance klines (1h)
  if (meta.binancePair) {
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${meta.binancePair}&interval=1h&limit=${limit}`;
      const r = await fetch(url);
      const j = await r.json();
      if (Array.isArray(j) && j.length) {
        // klines: [ openTime, open, high, low, close, ... ]
        const prices = j.map((row) => [row[0], Number(row[4])]); // close
        return { prices };
      }
    } catch {
      // fall through
    }
  }

  // 2) Coinbase candles (1h)
  if (meta.coinbase) {
    await sleep(100);
    try {
      // Coinbase Advanced Trade public endpoint
      // We'll request 1h candles. It returns [time, low, high, open, close, volume]
      const granularity = 3600; // 1h
      const end = Math.floor(Date.now() / 1000);
      const start = end - limit * granularity;
      const product = meta.coinbase.replace("-USD", "-USD");
      const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularity}&start=${start}&end=${end}`;
      const r = await fetch(url, { headers: { "User-Agent": "cf-backend/1.0" } });
      const j = await r.json();
      if (Array.isArray(j) && j.length) {
        // times are seconds; convert to ms and shape like CoinGecko
        const prices = j
          .map((row) => [row[0] * 1000, Number(row[4])])
          .sort((a, b) => a[0] - b[0]);
        return { prices };
      }
    } catch {
      // fall through
    }
  }

  throw new Error(`no_series:${id}`);
}

// Convert USD number to vs currency
async function convertUsd(x, vs) {
  if (vs === "usd") return x;
  if (vs === "inr") {
    const usdInr = await getUsdToInr();
    return x * usdInr;
  }
  // default passthrough if unknown vs
  return x;
}

/* ------------------------------- routes ------------------------------- */
// Root
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ Crypto Flayer Backend (Binance/Coinbase) is running");
});

// Health
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// Sentiment (stub)
app.get("/api/sentiment", (_req, res) => {
  res.json({ summary: "Neutral", trend: "sideways", ts: Date.now() });
});

/* ------------------------------ /api/price ---------------------------- */
/** GET /api/price?ids=bitcoin,ethereum&vs=inr
 *  Returns { ok, data: { id: { [vs]: number, usd?: number, change_24h?: number }, ... } }
 *  (change_24h is omitted here to keep it simple without CG; can be added via klines calc) */
app.get("/api/price", async (req, res) => {
  try {
    const ids = (String(req.query.ids || "bitcoin,ethereum")).toLowerCase();
    const vs = (String(req.query.vs || "inr")).toLowerCase();
    const ck = `price:${ids}:${vs}`;
    const hit = getCache(ck);
    if (hit) return res.json({ ok: true, data: hit, cached: true });

    const out = {};
    const idArr = ids.split(",").map((s) => s.trim()).filter(Boolean);

    for (const id of idArr) {
      try {
        const usd = await getSpotUsdForId(id);
        const vv = await convertUsd(usd, vs);
        out[id] = { [vs]: Number(vv.toFixed(6)), usd: Number(usd.toFixed(6)) };
        await sleep(60);
      } catch {
        out[id] = { error: "no_price" };
      }
    }

    setCache(ck, out, 30_000); // 30s cache
    res.json({ ok: true, data: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "price_failed" });
  }
});

/* ----------------------------- /api/compare --------------------------- */
/** GET /api/compare?symbols=bitcoin,ethereum&days=30&vs=inr
 *  Returns shape similar to your UI needs: { ok, items:[{id, prices:[[ts, priceVS],...] }], vs, days } */
app.get("/api/compare", async (req, res) => {
  try {
    const symbols = (String(req.query.symbols || "bitcoin,ethereum")).toLowerCase();
    const days = String(req.query.days || "30");
    const vs = (String(req.query.vs || "inr")).toLowerCase();

    const ck = `cmp:${symbols}:${days}:${vs}`;
    const hit = getCache(ck);
    if (hit) return res.json({ ok: true, ...hit, cached: true });

    const outItems = [];
    for (const id of symbols.split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        const series = await getUsdSeriesForId(id, days);
        // convert each price point to vs
        let conv = 1;
        if (vs === "inr") conv = await getUsdToInr();

        const pricesVs = (series.prices || []).map(([t, p]) => [t, Number((p * conv).toFixed(6))]);
        outItems.push({ id, prices: pricesVs });
        await sleep(80);
      } catch {
        outItems.push({ id, prices: [] });
      }
    }

    const out = { items: outItems, vs, days };
    setCache(ck, out, 60_000);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "compare_failed" });
  }
});

/* -------------------- KRYPTO: TA-based prediction -------------------- */
// math helpers
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const stdev = (a) => {
  if (!a.length) return 0;
  const m = mean(a);
  const v = mean(a.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
};
const SMA = (arr, n) => (arr.length >= n ? mean(arr.slice(-n)) : NaN);
const RSI = (arr, period = 14) => {
  if (arr.length <= period) return NaN;
  let gains = 0, losses = 0;
  for (let i = arr.length - period + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const RS = gains / Math.max(1e-9, losses);
  return 100 - 100 / (1 + RS);
};
const MACD = (arr, fast = 12, slow = 26, signal = 9) => {
  if (arr.length < slow + signal) return { macd: NaN, signal: NaN, hist: NaN };
  const kF = 2 / (fast + 1), kS = 2 / (slow + 1);
  let emaF = mean(arr.slice(0, fast));
  let emaS = mean(arr.slice(0, slow));
  const emaFastSeries = [], emaSlowSeries = [];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    if (i >= fast - 1) { emaF = p * kF + emaF * (1 - kF); emaFastSeries.push(emaF); }
    if (i >= slow - 1) { emaS = p * kS + emaS * (1 - kS); emaSlowSeries.push(emaS); }
  }
  const start = Math.max(0, emaFastSeries.length - emaSlowSeries.length);
  const macdSeries = emaFastSeries.slice(start).map((x, i) => x - emaSlowSeries[i]);
  const kSig = 2 / (signal + 1);
  let sig = mean(macdSeries.slice(0, signal));
  for (let i = signal; i < macdSeries.length; i++) sig = macdSeries[i] * kSig + sig * (1 - kSig);
  const macd = macdSeries[macdSeries.length - 1];
  const hist = macd - sig;
  return { macd, signal: sig, hist };
};
const trendSlope = (arr, n = 30) => {
  const a = arr.slice(-n);
  const m = a.length;
  if (m < 2) return 0;
  const xs = Array.from({ length: m }, (_, i) => i / (m - 1));
  const xmean = mean(xs), ymean = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < m; i++) { num += (xs[i] - xmean) * (a[i] - ymean); den += (xs[i] - xmean) ** 2; }
  return den ? (num / den) / Math.max(1e-9, ymean) : 0;
};

// analyze from an array of prices (numbers)
async function analyzeArray(prices, symbol = "bitcoin", vs = "inr") {
  const P = prices.map((row) => Array.isArray(row) ? Number(row[1]) : Number(row))
                  .filter((x) => Number.isFinite(x));
  if (!P.length) throw new Error("no price data");

  const last = P[P.length - 1];
  const sma20 = SMA(P, 20), sma50 = SMA(P, 50);
  const rsi14 = RSI(P, 14);
  const { macd, signal, hist } = MACD(P);
  const slope = trendSlope(P, 30);

  const rets = [];
  for (let i = 1; i < P.length; i++) rets.push(Math.log(P[i] / P[i - 1]));
  const vol7 = stdev(rets.slice(-24 * 7));

  let score = 0;
  if (sma20 > sma50) score++; else score--;
  if (macd > signal) score++; else score--;
  if (rsi14 > 60) score++; else if (rsi14 < 40) score--;
  score += slope * 50;

  const normScore = Math.max(-3, Math.min(3, score)) / 3;
  const signalText = normScore > 0.25 ? "bullish" : normScore < -0.25 ? "bearish" : "neutral";

  const confidence = Math.max(0.1, Math.min(0.95, 0.5 - (vol7 || 0) * 2 + Math.abs(normScore) * 0.5));

  const expMove = Math.max(0.004, Math.min(0.05, (vol7 || 0.01) * 1.2));
  const drift = normScore * 0.012;
  const lowPct = drift - expMove;
  const highPct = drift + expMove;

  const result = {
    ok: true,
    symbol,
    vs,
    latest_price: last,
    indicators: { sma20, sma50, rsi14, macd, macdSignal: signal, macdHist: hist, trendSlope: slope, vol7 },
    signal: signalText,
    confidence,
    prediction: {
      horizon_hours: 24,
      band_abs: [last * (1 + lowPct), last * (1 + highPct)],
      band_pct: [lowPct, highPct],
    },
    summary: `Signal: ${signalText}, Confidence ${(confidence * 100).toFixed(0)}%`,
    disclaimer: "Educational use only. Markets are risky. This is NOT financial advice.",
  };

  if (OPENAI_KEY) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are Krypto the Kangaroo, a cautious crypto guide. Summarize the 24h outlook in 2–3 sentences based on indicators. End with: '⚠️ Not financial advice.'" },
            { role: "user", content: JSON.stringify(result) },
          ],
        }),
      });
      const j = await r.json();
      result.krypto_summary = j?.choices?.[0]?.message?.content || "Summary unavailable. ⚠️ Not financial advice.";
    } catch {
      result.krypto_summary = "AI summary failed. ⚠️ Not financial advice.";
    }
  }

  return result;
}

async function analyzeSymbol(id = "bitcoin", vs = "inr", days = 60) {
  const series = await getUsdSeriesForId(id, days); // USD series
  let conv = 1;
  if (vs === "inr") conv = await getUsdToInr();
  const pricesVs = (series.prices || []).map(([t, p]) => [t, p * conv]);
  return analyzeArray(pricesVs, id, vs);
}

// GET: /api/krypto/analyze?symbol=bitcoin&vs=inr
app.get("/api/krypto/analyze", async (req, res) => {
  try {
    const symbol = (String(req.query.symbol || "bitcoin")).toLowerCase();
    const vs = (String(req.query.vs || "inr")).toLowerCase();
    const result = await analyzeSymbol(symbol, vs, 60);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "analyze_failed" });
  }
});

// POST: /api/krypto/analyze/raw  body: { symbol, vs, prices:[[ts, price], ...] }
app.post("/api/krypto/analyze/raw", async (req, res) => {
  try {
    const { symbol = "bitcoin", vs = "inr", prices } = req.body || {};
    if (!Array.isArray(prices) || prices.length < 40) {
      return res.status(400).json({ ok: false, error: "prices array required (>=40 points)" });
    }
    const result = await analyzeArray(prices, String(symbol).toLowerCase(), String(vs).toLowerCase());
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "analyze_raw_failed" });
  }
});

/* -------------------------------- start ------------------------------- */
app.listen(PORT, () => {
  console.log(`PriceHub/Krypto API listening on :${PORT}`);
});
