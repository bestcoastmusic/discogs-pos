const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public"));

const fetch = global.fetch;

// ----------------------------
// HELPER: COLOR DETECTION
// ----------------------------
function detectColor(text = "") {
  const patterns = [
    "Red","Blue","Green","Yellow","Orange","Purple",
    "Pink","White","Clear","Gold","Silver",
    "Smoke","Smokey","Marble","Splatter","Translucent"
  ];

  const found = patterns.filter(c =>
    text.toLowerCase().includes(c.toLowerCase())
  );

  if (found.length > 1) return found.join(" / ");
  return found[0] || "Black";
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
// SHOPIFY
// ----------------------------
async function createShopifyProduct(item) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) return;

  try {
    await fetch(`https://${store}/admin/api/2024-01/products.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        product: {
          title: item.title,
          body_html: `
            <strong>${item.artist}</strong><br/>
            ${item.year || ""} ${item.country || ""}<br/>
            ${item.label || ""}<br/>
            Color: ${item.color}<br/>
            Condition: ${item.condition}
          `,
          images: item.image ? [{ src: item.image }] : [],
          variants: [{ price: item.price }]
        }
      })
    });
  } catch (err) {
    console.log("Shopify error:", err.message);
  }
}

// ----------------------------
// SEARCH
// ----------------------------
app.post("/search", async (req, res) => {
  const { barcode } = req.body;

  try {
    const data = await fetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json());

    const results = (data.results || []).slice(0, 10).map(r => {
      const text =
        (r.title || "") + " " +
        (Array.isArray(r.format) ? r.format.join(" ") : r.format || "");

      return {
        id: r.id,
        title: r.title,
        year: r.year,
        country: r.country,
        format: Array.isArray(r.format) ? r.format.join(", ") : r.format,
        label: r.label?.[0],
        thumb: r.thumb,
        color: detectColor(text)
      };
    });

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

      const options = (data.results || []).slice(0, 5).map(r => {
        const text =
          (r.title || "") + " " +
          (Array.isArray(r.format) ? r.format.join(" ") : r.format || "");

        return {
          id: r.id,
          title: r.title,
          year: r.year,
          country: r.country,
          thumb: r.thumb,
          color: detectColor(text)
        };
      });

      return { barcode, options };
    }));

    res.json({ results });

  } catch {
    res.json({ results: [] });
  }
});

// ----------------------------
// IMPORT
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
// FETCH RELEASE
// ----------------------------
async function fetchRelease(id) {
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
    color: detectColor((r.title || "") + " " + JSON.stringify(r.formats)),
    basePrice: stats?.median_price || 20
  };
}

// ----------------------------
// QUEUE PROCESSOR
// ----------------------------
async function processQueue() {
  if (!queue.length) return;

  const job = queue.shift();
  const data = await fetchRelease(job.id);

  const multiplier = conditionMultiplier[job.condition] || 1;
  let price = data.basePrice * multiplier;
  if (price < 8) price = 8;

  const item = {
    ...data,
    condition: job.condition,
    price: price.toFixed(2)
  };

  history.push(item);
  await createShopifyProduct(item);
}

setInterval(processQueue, 1000);

// ----------------------------
// HISTORY
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

app.listen(process.env.PORT || 10000);
