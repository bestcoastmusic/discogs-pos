const express = require("express");
const app = express();

app.use(express.json());

// ✅ THIS SERVES YOUR FRONTEND (VERY IMPORTANT)
app.use(express.static("public"));

const fetch = global.fetch;

// ----------------------------
// STATE
// ----------------------------
let queue = [];
let history = [];

// ----------------------------
// PRICING
// ----------------------------
const conditionMultiplier = {
  M: 1.5,
  NM: 1.25,
  "VG+": 1.0,
  VG: 0.8,
  G: 0.5
};

// ----------------------------
// SEARCH (Discogs)
// ----------------------------
app.post("/search", async (req, res) => {
  const { barcode } = req.body;

  try {
    const data = await fetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json());

    const results = (data.results || []).slice(0, 10).map(r => ({
      id: r.id,
      title: r.title,
      year: r.year
    }));

    res.json({ results });
  } catch (err) {
    console.log("search error:", err.message);
    res.json({ results: [] });
  }
});

// ----------------------------
// BULK PREVIEW
// ----------------------------
app.post("/bulk-preview", async (req, res) => {
  const { items } = req.body;

  try {
    const results = await Promise.all(items.map(async (barcode) => {
      const data = await fetch(
        `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
      ).then(r => r.json());

      const r = (data.results || [])[0];

      return {
        id: r?.id,
        title: r?.title,
        year: r?.year
      };
    }));

    res.json({ results });
  } catch (err) {
    console.log("bulk preview error:", err.message);
    res.json({ results: [] });
  }
});

// ----------------------------
// IMPORT (QUEUE)
// ----------------------------
app.post("/import", (req, res) => {
  const items = req.body.items || [];
  queue.push(...items);

  res.json({ success: true, queued: items.length });
});

// ----------------------------
// FETCH RELEASE DETAILS
// ----------------------------
async function fetchRelease(id) {
  try {
    const r = await fetch(
      `https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`
    ).then(x => x.json());

    const stats = await fetch(
      `https://api.discogs.com/marketplace/stats/${id}?token=${process.env.DISCOGS_TOKEN}`
    ).then(x => x.json()).catch(() => null);

    return {
      artist: r.artists?.[0]?.name || "Unknown Artist",
      title: r.title || "Unknown Title",
      basePrice: stats?.median_price || 20
    };
  } catch (err) {
    console.log("fetch release error:", err.message);
    return null;
  }
}

// ----------------------------
// QUEUE PROCESSOR
// ----------------------------
async function processQueue() {
  if (!queue.length) return;

  const job = queue.shift();

  const data = await fetchRelease(job.id);
  if (!data) return;

  const multiplier = conditionMultiplier[job.condition] || 1;

  const price = (data.basePrice * multiplier).toFixed(2);

  const item = {
    ...data,
    condition: job.condition,
    price
  };

  history.push(item);

  console.log("Processed:", item.title);
}

setInterval(processQueue, 1000);

// ----------------------------
// HISTORY
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

// ----------------------------
// START SERVER
// ----------------------------
app.listen(process.env.PORT || 10000, () => {
  console.log("POS RUNNING CLEAN");
});
