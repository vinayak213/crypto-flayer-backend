import express from "express";
import cors from "cors";

const app = express();

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const CG_PRO_KEY = process.env.COINGECKO_API_KEY || "";

// Node 18+ has global fetch

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

/* ------------------------ tiny in-memory cache ------------------------ */
const cache = global.__kcache || (global.__kcache = {});
const CACHE_TTL_MS = 60 * 1000; // 60s
const setCache = (k, v, ttl = CACHE_TTL_MS) => (cache[k] = { v, ts: Date.now(), ttl });
const getCache = (k) => {
  const e = cache[k];
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) return null;
  return e.v;
};
// convenience: last non-empty cache
const getNonEmptyCache = (k) => {
  const e = cache[k];
  if (!e) return null;
  const v = e.v;
  if (!v) return null;
  if (Array.isArray(v?.prices) && v.prices.length > 0) return v;
  return null;
};

/* ------------------------------- routes ------------------------------ */

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
    const cacheKey = `price:${ids}:${vs}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json({ ok: true, data: hit, cached: true });

    const base = CG_PRO_KEY ? "https://pro-api.coingecko.com/api/v3"
                            : "https://api.coingecko.com/api/v3";

    const url = `${base}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`;

    const headers = { accept: "application/json" };
    if (CG_PRO_KEY) headers["x-cg-pro-api-key"] = CG_PRO_KEY;

    const r = await fetch(url, { headers });
    const data = await r.json();

    if (data?.status?.error_code === 429) {
      return res.status(429).json({ ok: false, error: "CoinGecko rate limit exceeded. Try again shortly." });
    }

    setCache(cacheKey, data);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "proxy_failed" });
  }
});

// /api/compare?symbols=bitcoin,ethereum&days=30&vs=inr
app.get("/api/compare", async (req, res) => {
  try {
    const symbols = (req.query.symbols || "bitcoin,ethereum").toLowerCase();
    const days = String(req.query.days || "30");
    const vs = (req.query.vs || "inr").toLowerCase();
    const cacheKey = `cmp:${symbols}:${days}:${vs}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json({ ok: true, ...hit, cached: true });

    const base = CG_PRO_KEY ? "https://pro-api.coingecko.com/api/v3"
                            : "https://api.coingecko.com/api/v3";

    const headers = { accept: "application/json" };
    if (CG_PRO_KEY) headers["x-cg-pro-api-key"] = CG_PRO_KEY;

    const items = await Promise.all(
      symbols.split(",").map(async (id) => {
        const url = `${base}/coins/${id}/market_chart?vs_currency=${vs}&days=${days}`;
        const r = await fetch(url, { headers });
        const j = await r.json();
        if (j?.status?.error_code === 429) throw new Error("CoinGecko rate limit exceeded");
        return { id, prices: j.prices };
      })
    );

    const out = { items, vs, days };
    setCache(cacheKey, out);
    res.json({ ok: true, ...out });
  } catch (e) {
    if (String(e.message).includes("rate limit")) {
      return res.status(429).json({ ok: false, error: e.message });
    }
    res.status(500).json({ ok: false, error: e?.message || "compare_failed" });
  }
});

/* -------------------- KRYPTO: TA-based prediction -------------------- */

// math helpers
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stdev = (a) => {
  const m = mean(a);
  const v = mean(a.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
};
const SMA = (arr, n) => (arr.length >= n ? mean(arr.slice(-n)) : NaN);
const RSI = (arr, period = 14) => {
  if (arr.length <= period) return NaN;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
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

// safer fetch: if CG returns empty or 429, try last non-empty cache
async function fetchPricesSeries(symbol = "bitcoin", vs = "inr", days = 60) {
  const key = `mc:${symbol}:${vs}:${days}`;
  const cached = getNonEmptyCache(key);
  // prepare request
  const base = CG_PRO_KEY ? "https://pro-api.coingecko.com/api/v3"
                          : "https://api.coingecko.com/api/v3";
  const headers = { accept: "application/json" };
  if (CG_PRO_KEY) headers["x-cg-pro-api-key"] = CG_PRO_KEY;
  const url = `${base}/coins/${symbol}/market_chart?vs_currency=${vs}&days=${days}`;

  try {
    const r = await fetch(url, { headers });
    const j = await r.json();
    if (j?.status?.error_code === 429) {
      // rate-limited: fall back to previous non-empty cache if available
      if (cached) return cached;
      throw new Error("rate_limited");
    }
    // if empty prices, return cached non-empty if any
    if (!Array.isArray(j?.prices) || j.prices.length === 0) {
      if (cached) return cached;
      return j;
    }
    setCache(key, j);
    return j;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function analyzeArray(prices, symbol = "bitcoin", vs = "inr") {
  const P = prices.map((row) => Array.isArray(row) ? row[1] : row)
                  .map(Number).filter((x) => Number.isFinite(x));
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
  let confidence = Math.max(0.1, Math.min(0.95, 0.5 - (vol7 || 0) * 2 + Math.abs(normScore) * 0.5));

  const expMove = Math.max(0.004, Math.min(0.05, (vol7 || 0.01) * 1.2));
  const drift = normScore * 0.012;
  const lowPct = drift - expMove;
  const highPct = drift + expMove;

  const result = {
    ok: true,
    symbol, vs,
    latest_price: last,
    indicators: { sma20, sma50, rsi14, macd, macdSignal: signal, macdHist: hist, trendSlope: slope, vol7 },
    signal: signalText,
    confidence,
    prediction: { horizon_hours: 24, band_abs: [last * (1 + lowPct), last * (1 + highPct)], band_pct: [lowPct, highPct] },
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
            { role: "user", content: `Indicators: ${JSON.stringify({ last, sma20, sma50, rsi14, macd, signal, hist, slope, vol7, signalText, confidence })}` }
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

async function analyzeSymbol(symbol = "bitcoin", vs = "inr", days = 60) {
  const mc = await fetchPricesSeries(symbol, vs, days);
  const prices = (mc?.prices || []);
  if (!prices.length) throw new Error("no price data");
  return analyzeArray(prices, symbol, vs);
}

// GET (server fetch) /api/krypto/analyze?symbol=bitcoin&vs=inr
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

// POST (frontend provides raw series) /api/krypto/analyze/raw
// body: { symbol: "bitcoin", vs: "inr", prices: [[ts, price], ...] }
app.post("/api/krypto/analyze/raw", async (req, res) => {
  try {
    const { symbol = "bitcoin", vs = "inr", prices } = req.body || {};
    if (!Array.isArray(prices) || prices.length < 40) {
      return res.status(400).json({ ok: false, error: "prices array required (>=40 points)" });
    }
    const result = await analyzeArray(prices, symbol.toLowerCase(), vs.toLowerCase());
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "analyze_raw_failed" });
  }
});

/* ------------------------------- start ------------------------------- */
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
