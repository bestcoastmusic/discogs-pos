const express = require("express");

const app = express();
app.use(express.json());

// Node 24 built-in fetch
const fetch = global.fetch;

// =========================
// ENV CHECK
// =========================
console.log("🔥 POS SYSTEM STARTING");
console.log("PORT:", process.env.PORT);
console.log("SHOPIFY_STORE:", process.env.SHOPIFY_STORE ? "SET" : "MISSING");
console.log("SHOPIFY_TOKEN:", process.env.SHOPIFY_TOKEN ? "SET" : "MISSING");
console.log("DISCOGS_TOKEN:", process.env.DISCOGS_TOKEN ? "SET" : "MISSING");

// =========================
// HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.send("Best Coast Music POS is LIVE");
});

// =========================
// DISCOGS LOOKUP
// =========================
async function searchDiscogsByBarcode(barcode, retries = 2) {
  const url = `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`;

  try {
    const res = await fetch(url);

    if (res.status === 429 && retries > 0) {
      console.log("⚠️ Discogs rate limit, retrying...");
      await new Promise(r => setTimeout(r, 1500));
      return searchDiscogsByBarcode(barcode, retries - 1);
    }

    const data = await res.json();
    return data.results?.[0] || null;

  } catch (err) {
    console.log("Discogs error:", err.message);
    return null;
  }
}

// =========================
// SHOPIFY CREATE PRODUCT
// =========================
async function createShopifyProduct(item) {
  console.log("👉 SHOPIFY CALLED");

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) {
    console.log("❌ Missing Shopify credentials");
    return;
  }

  const url = `https://${store}/admin/api/2024-01/products.json`;

  // SAFE VENDOR NORMALIZATION
  let vendor = item.label;

  if (Array.isArray(vendor)) {
    vendor = vendor[0];
  }

  if (!vendor || typeof vendor !== "string") {
    vendor = "Discogs Import";
  }

  const payload = {
    product: {
      title: item.title || "Unknown Record",
      vendor: vendor,
      variants: [{ price: "20.00" }]
    }
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      console.log("❌ SHOPIFY ERROR:", data);
    } else {
      console.log("✅ SHOPIFY SUCCESS:", data.product?.id);
    }

  } catch (err) {
    console.log("❌ SHOPIFY EXCEPTION:", err.message);
  }
}

// =========================
// BULK IMPORT ROUTE
// =========================
app.post("/bulk-import", async (req, res) => {
  const items = req.body.items || [];

  console.log("📦 BULK REQUEST RECEIVED:", items.length);

  const results = [];

  for (const item of items) {
    const barcode = item.barcode;

    console.log("📦 BULK:", barcode);

    const discogs = await searchDiscogsByBarcode(barcode);

    if (!discogs) {
      results.push({
        barcode,
        status: "NOT_FOUND"
      });
      continue;
    }

    await createShopifyProduct(discogs);

    results.push({
      barcode,
      status: "IMPORTED"
    });
  }

  res.json({
    success: true,
    results
  });
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🔥 POS SYSTEM RUNNING");
  console.log("🚀 Port:", PORT);
});
