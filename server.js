import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// =========================
// DISCOGS SEARCH
// =========================
async function searchDiscogsByBarcode(barcode) {
  if (!barcode) return null;

  const url = `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.results || data.results.length === 0) return null;

  return data.results[0]; // best match
}

// =========================
// SHOPIFY CREATE PRODUCT
// =========================
async function createShopifyProduct(product) {
  const url = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/products.json`;

  const body = {
    product: {
      title: product.title || "Unknown Record",
      body_html: product.title || "",
      vendor: product.label || "Discogs Import",
      variants: [
        {
          price: "20.00"
        }
      ]
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN
    },
    body: JSON.stringify(body)
  });

  return await res.json();
}

// =========================
// BULK IMPORT (FIXED - NO QUEUE)
// =========================
app.post("/bulk-import", async (req, res) => {
  const items = req.body.items;

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: "No items provided" });
  }

  const results = [];

  for (const item of items) {
    try {
      const barcode =
        item.barcode ||
        item.upc ||
        item.ean;

      const discogs = await searchDiscogsByBarcode(barcode);

      if (!discogs) {
        results.push({
          barcode,
          status: "NOT_FOUND"
        });
        continue;
      }

      const shopify = await createShopifyProduct(discogs);

      results.push({
        barcode,
        status: "IMPORTED",
        title: discogs.title
      });

    } catch (err) {
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
// HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.send("Best Coast Music Importer Running");
});

// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
