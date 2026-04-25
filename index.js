import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// =========================
// ENV DEBUG (CONFIRM LOADING)
// =========================
console.log("🔥 ENV CHECK START");
console.log("SHOPIFY_STORE =", process.env.SHOPIFY_STORE);
console.log("SHOPIFY_TOKEN EXISTS =", !!process.env.SHOPIFY_TOKEN);
console.log("DISCOGS_TOKEN EXISTS =", !!process.env.DISCOGS_TOKEN);

// =========================
// HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.send("Best Coast Music POS Running");
});

// =========================
// DISCOGS SEARCH (SAFE)
// =========================
async function searchDiscogsByBarcode(barcode, retries = 3) {
  if (!barcode) return null;

  const url = `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`;

  try {
    const res = await fetch(url);

    if (res.status === 429) {
      console.log("⚠️ Discogs 429 rate limit");
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 2000));
        return searchDiscogsByBarcode(barcode, retries - 1);
      }
      return null;
    }

    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;

    return data.results[0];

  } catch (err) {
    console.log("Discogs error:", err.message);
    return null;
  }
}

// =========================
// SHOPIFY CREATE PRODUCT (FULL DEBUG VERSION)
// =========================
async function createShopifyProduct(product) {
  console.log("👉 SHOPIFY FUNCTION CALLED");
  console.log("Product:", product?.title);

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  console.log("STORE:", store);
  console.log("TOKEN EXISTS:", !!token);

  if (!store || !token) {
    console.log("❌ MISSING SHOPIFY CREDENTIALS");
    return;
  }

  try {
    const url = `https://${store}/admin/api/2024-01/products.json`;

    console.log("👉 SHOPIFY URL:", url);

    const body = {
      product: {
        title: product.title || "Unknown Record",
        body_html: product.title || "",
        vendor: product.label || "Discogs Import",
        variants: [
          { price: "20.00" }
        ]
      }
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      console.log("❌ SHOPIFY ERROR RESPONSE:", data);
      return;
    }

    console.log("✅ SHOPIFY SUCCESS:", data.product?.id);

  } catch (err) {
    console.log("❌ SHOPIFY EXCEPTION:", err.message);
  }
}

// =========================
// BULK IMPORT
// =========================
app.post("/bulk-import", async (req, res) => {
  const items = req.body.items;

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: "No items provided" });
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const results = [];

  for (const item of items) {
    try {
      await sleep(900);

      const barcode = item.barcode || item.upc || item.ean;

      console.log("📦 BULK:", barcode);

      const discogs = await searchDiscogsByBarcode(barcode);

      if (!discogs) {
        results.push({ barcode, status: "NOT_FOUND" });
        continue;
      }

      await createShopifyProduct(discogs);

      results.push({
        barcode,
        status: "IMPORTED",
        title: discogs.title
      });

    } catch (err) {
      console.log("❌ IMPORT ERROR:", err.message);

      results.push({
        barcode: item.barcode,
        status: "ERROR",
        error: err.message
      });
    }
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
  console.log("🚀 Running on port", PORT);
});
