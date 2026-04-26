kconst express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public"));

// ----------------------------
// HELPER: COLOR FROM FORMATS
// ----------------------------
function detectColorFromFormats(formats = []) {
  const text = JSON.stringify(formats).toLowerCase();

  const colors = [
    "red","blue","green","yellow","orange","purple",
    "pink","white","clear","gold","silver",
    "smoke","smokey","marble","splatter","translucent"
  ];

  const found = colors.filter(c => text.includes(c));

  if (found.length > 1) {
    return found.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(" / ");
  }

  if (found.length === 1) {
    return found[0].charAt(0).toUpperCase() + found[0].slice(1);
  }

  return "Black";
}

// ----------------------------
// STATE
// ----------------------------
let queue = [];
let history = [];
let inventory = new Set();

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
// SEARCH (FAST, NO COLOR)
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
      year: r.year,
      country: r.country,
      format: Array.isArray(r.format) ? r.format.join(", ") : r.format,
      label: r.label?.[0],
      thumb: r.thumb,
      color: "Unknown" // correct: we resolve later
    }));

    res.json({ results });

  } catch {
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

      const options = (data.results || []).slice(0, 5).map(r => ({
        id: r.id,
        title: r.title,
        year: r.year,
        country: r.country,
        thumb: r.thumb,
        color: "Unknown"
      }));

      return { barcode, options };
    }));

    res.json({ results });

  } catch {
    res.json({ results: [] });
  }
});

// ----------------------------
// IMPORT (WITH DUPES)
// ----------------------------
app.post("/import", (req, res) => {
  const items = req.body.items || [];

  let duplicates = [];
  let added = [];

  items.forEach(i => {
    if (inventory.has(i.id)) {
      duplicates.push(i.id);
    } else {
      inventory.add(i.id);
      queue.push(i);
      added.push(i.id);
    }
  });

  res.json({ success: true, duplicates, added });
});

// ----------------------------
// FETCH RELEASE (REAL DATA)
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
      id,
      artist: r.artists?.[0]?.name || "Unknown",
      title: r.title,
      year: r.year,
      country: r.country,
      label: r.labels?.[0]?.name,
      image: r.images?.[0]?.uri,
      color: detectColorFromFormats(r.formats || []), // ✅ REAL COLOR
      basePrice: stats?.median_price || 20
    };

  } catch (err) {
    console.log("release error:", err.message);
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

  let price = data.basePrice * multiplier;
  if (price < 8) price = 8;

  const item = {
    ...data,
    condition: job.condition,
    price: price.toFixed(2)
  };

  history.push(item);

  console.log("📦 Added:", item.title, "| Color:", item.color);
}

setInterval(processQueue, 1000);

// ----------------------------
// HISTORY
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

// ----------------------------
app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 POS RUNNING WITH REAL COLOR DETECTION");
});
