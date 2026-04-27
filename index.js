processQueue
const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public"));

// ----------------------------
// COLOR DETECTION (FROM FORMATS)
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
// FETCH FULL RELEASE
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
      color: detectColorFromFormats(r.formats || []),
      basePrice: stats?.median_price || 20
    };

  } catch (err) {
    console.log("release error:", err.message);
    return null;
  }
}

// ----------------------------
// SEARCH (ACCURATE PREVIEW)
// ----------------------------
app.post("/search", async (req, res) => {
  const { barcode } = req.body;

  try {
    const data = await fetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json());

    const top = (data.results || []).slice(0, 5);

    const results = await Promise.all(
      top.map(async (r) => {
        const full = await fetchRelease(r.id);
        if (!full) return null;

        return {
          id: full.id,
          title: full.title,
          year: full.year,
          country: full.country,
          label: full.label,
          thumb: full.image,
          color: full.color
        };
      })
    );

    res.json({ results: results.filter(Boolean) });

  } catch (err) {
    console.log("search error:", err.message);
    res.json({ results: [] });
  }
});

// ----------------------------
// BULK PREVIEW (ACCURATE + MULTI OPTION)
// ----------------------------
app.post("/bulk-preview", async (req, res) => {
  const { items } = req.body;

  try {
    const results = await Promise.all(items.map(async (barcode) => {

      const data = await fetch(
        `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
      ).then(r => r.json());

      const top = (data.results || []).slice(0, 5);

      const options = await Promise.all(
        top.map(async (r) => {
          const full = await fetchRelease(r.id);
          if (!full) return null;

          return {
            id: full.id,
            title: full.title,
            year: full.year,
            country: full.country,
            thumb: full.image,
            color: full.color
          };
        })
      );

      return {
        barcode,
        options: options.filter(Boolean)
      };
    }));

    res.json({ results });

  } catch (err) {
    console.log("bulk error:", err.message);
    res.json({ results: [] });
  }
});

// ----------------------------
// IMPORT (WITH DUPLICATES)
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
// PROCESS QUEUE
// ----------------------------
async function createShopifyProduct(item) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) {
    console.log("❌ Missing Shopify credentials");
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
            Color: ${item.color}<br/>
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
async function processQueue() 
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

  
console.log("📦 Added:", item.title, "|", item.color, "|", item.condition);
console.log("📦 Added:", item.title, "|", item.color, "|", item.condition);

history.push(item);

// 🔥 THIS IS THE MISSING LINE
await createShopifyProduct(item);

console.log("📦 Added:", item.title, "|", item.color, "|", item.condition);}

setInterval(processQueue, 1000);

// ----------------------------
// HISTORY
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

// ----------------------------
app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 POS RUNNING (FULL SYSTEM)");
});
