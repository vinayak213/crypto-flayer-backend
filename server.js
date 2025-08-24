import express from "express";
import cors from "cors";

const app = express();

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Root
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ Crypto Flayer Backend is running");
});

// Health
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

// Sentiment (stub)
app.get("/api/sentiment", async (_req, res) => {
  res.json({ summary: "Neutral", trend: "sideways", ts: Date.now() });
});

// /api/price?ids=bitcoin,ethereum&vs=inr
app.get("/api/price", async (req, res) => {
  try {
    const ids = (req.query.ids || "bitcoin,ethereum").toLowerCase();
    const vs = (req.query.vs || "inr").toLowerCase();
    const url =
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}` +
      `&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const data = await r.json();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "proxy_failed" });
  }
});

// /api/compare?symbols=bitcoin,ethereum&days=30&vs=inr
app.get("/api/compare", async (req, res) => {
  try {
    const symbols = (req.query.symbols || "bitcoin,ethereum").toLowerCase();
    const days = req.query.days || "30";
    const vs = (req.query.vs || "inr").toLowerCase();
    const items = await Promise.all(
      symbols.split(",").map(async (id) => {
        const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=${vs}&days=${days}`;
        const r = await fetch(url);
        const j = await r.json();
        return { id, prices: j.prices };
      })
    );
    res.json({ ok: true, items, vs, days });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "compare_failed" });
  }
});
// ---------- KRYPTO: lightweight TA & prediction ----------

// 1) tiny in-memory cache (60s)
const cache = global.__kcache || (global.__kcache = {});
const CACHE_TTL = 60 * 1000;
const setCache = (k, v) => (cache[k] = { v, ts: Date.now() });
const getCache = (k) => (cache[k] && Date.now() - cache[k].ts < CACHE_TTL ? cache[k].v : null);

// 2) math helpers
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stdev = (a) => {
  const m = mean(a);
  const v = mean(a.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
};
const SMA = (arr, n) => (arr.length >= n ? mean(arr.slice(-n)) : NaN);
const EMA = (arr, n) => {
  if (arr.length < n) return NaN;
  const k = 2 / (n + 1);
  let ema = mean(arr.slice(0, n));
  for (let i = n; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
  return ema;
};
const RSI = (arr, period = 14) => {
  if (arr.length <= period) return NaN;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const RS = gains / Math.max(1e-9, losses);
  return 100 - 100 / (1 + RS);
};
const MACD = (arr, fast = 12, slow = 26, signal = 9) => {
  if (arr.length < slow + signal) return { macd: NaN, signal: NaN, hist: NaN };
  const emaFastSeries = [];
  const emaSlowSeries = [];
  let emaF = mean(arr.slice(0, fast));
  let emaS = mean(arr.slice(0, slow));
  const kF = 2 / (fast + 1), kS = 2 / (slow + 1);
  for (let i = 0; i < arr.length; i++) {
    const price = arr[i];
    if (i >= fast - 1) { emaF = price * kF + emaF * (1 - kF); emaFastSeries.push(emaF); }
    if (i >= slow - 1) { emaS = price * kS + emaS * (1 - kS); emaSlowSeries.push(emaS); }
  }
  const start = Math.max(0, emaFastSeries.length - emaSlowSeries.length);
  const macdSeries = emaFastSeries.slice(start).map((x, i) => x - emaSlowSeries[i]);
  let sig = mean(macdSeries.slice(0, signal));
  const kSig = 2 / (signal + 1);
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
  const xmean = mean(xs);
  const ymean = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < m; i++) { num += (xs[i] - xmean) * (a[i] - ymean); den += (xs[i] - xmean) ** 2; }
  return den ? (num / den) / Math.max(1e-9, ymean) : 0;
};

// 3) fetch market chart
async function fetchPricesSeries(symbol = "bitcoin", vs = "inr", days = 60) {
  const key = `mc:${symbol}:${vs}:${days}`;
  const hit = getCache(key);
  if (hit) return hit;
  const url = `https://api.coingecko.com/api/v3/coins/${symbol}/market_chart?vs_currency=${vs}&days=${days}`;
  const r = await fetch(url);
  const j = await r.json();
  setCache(key, j);
  return j;
}

// 4) core analyzer
async function analyzeSymbol(symbol = "bitcoin", vs = "inr", days = 60) {
  const mc = await fetchPricesSeries(symbol, vs, days);
  const P = (mc?.prices || []).map((row) => row[1]);
  if (!P.length) throw new Error("no price data");

  const last = P[P.length - 1];
  const sma20 = SMA(P, 20), sma50 = SMA(P, 50);
  const rsi14 = RSI(P, 14);
  const { macd, signal, hist } = MACD(P);
  const slope = trendSlope(P, 30);
  const returns = [];
  for (let i = 1; i < P.length; i++) returns.push(Math.log(P[i] / P[i - 1]));
  const vol7 = stdev(returns.slice(-24 * 7));

  let score = 0;
  if (sma20 > sma50) score++; else score--;
  if (macd > signal) score++; else score--;
  if (rsi14 > 60) score++; else if (rsi14 < 40) score--;
  score += slope * 50;
  const normScore = Math.max(-3, Math.min(3, score)) / 3;
  const signalText = normScore > 0.25 ? "bullish" : normScore < -0.25 ? "bearish" : "neutral";

  const confidence = Math.max(0.1, Math.min(0.95, 0.5 - vol7 * 2 + Math.abs(normScore) * 0.5));

  const expMove = Math.max(0.004, Math.min(0.05, (vol7 || 0.01) * 1.2));
  const drift = normScore * 0.012;
  const midPct = drift;
  const lowPct = midPct - expMove;
  const highPct = midPct + expMove;

  return {
    ok: true,
    symbol, vs,
    latest_price: last,
    signal: signalText,
    confidence,
    prediction: {
      horizon_hours: 24,
      band_abs: [last * (1 + lowPct), last * (1 + highPct)]
    },
    summary: `Signal: ${signalText}, Confidence ${(confidence*100).toFixed(0)}%`,
    disclaimer: "Educational use only. This is NOT financial advice."
  };
}

// 5) route
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

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
