import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// --- health check for Render ---
app.get("/health", (req, res) => res.status(200).send("ok"));

// --- example APIs (stub now; wire real logic later) ---
app.get("/api/sentiment", async (req, res) => {
  res.json({ summary: "Neutral", trend: "sideways", ts: Date.now() });
});

app.get("/api/compare", (req, res) => {
  const symbols = (req.query.symbols || "").split(",").filter(Boolean);
  res.json({ symbols, note: "stub—returning placeholder compare data" });
});

app.post("/api/alerts", (req, res) => {
  res.json({ ok: true, saved: req.body });
});

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
