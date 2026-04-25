const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// =========================
// ENV CHECK
// =========================
console.log("🔥 SYSTEM STARTING");
console.log("SHOPIFY_STORE =", process.env.SHOPIFY_STORE);
console.log("SHOPIFY_TOKEN =", !!process.env.SHOPIFY_TOKEN);
console.log("DISCOGS_TOKEN =", !!process.env.DISCOGS_TOKEN);

// =========================
// HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.send("Best Coast Music POS Running");
});

// =========================
// DISCOGS LOOKUP
// =========================
async function searchDiscogsByBarcode(barcode, retries = 3) {
  if (!barcode) return null;

  const url = `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`;

  try {
    const res = await fetch(url);

    if (res.status === 429) {
      console.log("⚠️ Discogs rate limit");
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 2000));
        return searchDiscogsByBarcode(barcode, retries - 1);
      }
      return null;
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
async function createShopifyProduct(product) {
  console.log("👉 SHOPIFY CALLED");

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  console.log("STORE:", store);
  console.log("TOKEN EXISTS:", !!token);

  if (!store || !token) {
    console.log("❌ Missing Shopify credentials");
    return;
  }

  const url = `https://${store}/admin/api/2024-01/products.json`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        product: {
          title: product.title || "Unknown Record",
          vendor: product.label || "Discogs Import",
          variants: [{ price: "20.00" }]
        }
      })
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
// BULK IMPORT
// =========================
app.post("/bulk-import", async (req, res) => {
  const items = req.body.items || [];

  const results = [];

  for (const item of items) {
    const barcode = item.barcode;

    console.log("📦 BULK:", barcode);

    const discogs = await searchDiscogsByBarcode(barcode);

    if (!discogs) {
      results.push({ barcode, status: "NOT_FOUND" });
      continue;
    }

    await createShopifyProduct(discogs);

    results.push({ barcode, status: "IMPORTED" });
  }

  res.json({ success: true, results });
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🔥 POS SYSTEM RUNNING");
  console.log("🚀 Port", PORT);
});
