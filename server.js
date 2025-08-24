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

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
