const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public"));

const fetch = global.fetch;

// ----------------------------
// STATE
// ----------------------------
let queue = [];
let history = [];
let inventory = new Set(); // duplicate prevention

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

  if (!store || !token) {
    console.log("❌ Shopify env missing");
    return;
  }

  try {
    const res = await fetch(`https://${store}/admin/api/2024-01/products.json`, {
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
            Condition: ${item.condition}
          `,
          images: item.image ? [{ src: item.image }] : [],
          variants: [
            {
              price: item.price
            }
          ]
        }
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.log("❌ Shopify error:", data);
    } else {
      console.log("✅ Shopify created:", data.product?.id);
    }

  } catch (err) {
    console.log("❌ Shopify crash:", err.message);
  }
}

// ----------------------------
// SEARCH (MULTI RESULT)
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
      thumb: r.thumb
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
        year: r?.year,
        country: r?.country,
        format: Array.isArray(r?.format) ? r.format.join(", ") : r?.format,
        label: r?.label?.[0],
        thumb: r?.thumb
      };
    }));

    res.json({ results });

  } catch (err) {
    console.log("bulk preview error:", err.message);
    res.json({ results: [] });
  }
});

// ----------------------------
// IMPORT → QUEUE
// ----------------------------
app.post("/import", (req, res) => {
  const items = req.body.items || [];

  items.forEach(i => {
    if (!inventory.has(i.id)) {
      queue.push(i);
    } else {
      console.log("⚠️ Duplicate skipped:", i.id);
    }
  });

  res.json({ success: true, queued: items.length });
});

// ----------------------------
// FETCH FULL RELEASE DATA
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
      artist: r.artists?.[0]?.name || "Unknown Artist",
      title: r.title || "Unknown Title",
      year: r.year,
      country: r.country,
      label: r.labels?.[0]?.name,
      image: r.images?.[0]?.uri,
      basePrice: stats?.median_price || 20
    };

  } catch (err) {
    console.log("release fetch error:", err.message);
    return null;
  }
}

// ----------------------------
// QUEUE PROCESSOR
// ----------------------------
async function processQueue() {
  if (!queue.length) return;

  const job = queue.shift();

  if (inventory.has(job.id)) return;

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

  inventory.add(job.id);
  history.push(item);

  console.log("📦 Added:", item.title, "$" + item.price);

  await createShopifyProduct(item);
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
  console.log("🚀 FULL POS RUNNING");
});
