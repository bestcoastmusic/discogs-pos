const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");

const app = express();

app.use(express.json());
app.use(express.static("public"));

// ----------------------------
// STATE
// ----------------------------
let queue = [];
let history = [];
let inventorySet = new Set();
let jobs = {};

let priceMap = {};
let stockMap = {}; // 🔥 NEW

// ----------------------------
// LOAD CSV
// ----------------------------
fs.createReadStream("pricing.csv")
  .pipe(csv())
  .on("data", (row) => {

    const upc = row.UPC?.toString().replace(/\D/g, "");

    if (!upc) return;

    // PRICE
    if (row.Price) {
      priceMap[upc] = parseFloat(row.Price);
    }

    // STOCK
    if (row.QtyInStock !== undefined) {
      stockMap[upc] = parseInt(row.QtyInStock) || 0;
    }

  })
  .on("end", () => {
    console.log("✅ CSV Loaded:",
      "Prices:", Object.keys(priceMap).length,
      "Stock:", Object.keys(stockMap).length
    );
  });

// ----------------------------
// PRICING MULTIPLIER
// ----------------------------
const conditionMultiplier = {
  M: 1.5,
  NM: 1.25,
  "VG+": 1.0,
  VG: 0.8,
  G: 0.5
};

// ----------------------------
// UTILS
// ----------------------------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ----------------------------
// FETCH RELEASE
// ----------------------------
async function fetchRelease(id){
  try {
    const r = await fetch(`https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`).then(r=>r.json());

    await sleep(120);

    const artist = r.artists?.[0]?.name || "Unknown";
    const title = r.title || "Unknown Title";

    const barcode = r.identifiers?.find(i => i.type === "Barcode")?.value?.replace(/\D/g, "");

    // PRICE
    let basePrice = 20;

    if (barcode && priceMap[barcode]) {
      basePrice = priceMap[barcode];
    } else {
      try {
        const stats = await fetch(`https://api.discogs.com/marketplace/stats/${id}?token=${process.env.DISCOGS_TOKEN}`).then(r=>r.json());
        basePrice = stats.median_price || stats.lowest_price || 20;
      } catch {}
    }

    // STOCK
    let stock = 0;
    if (barcode && stockMap[barcode] !== undefined) {
      stock = stockMap[barcode];
    }

    return {
      id,
      artist,
      title: artist + " - " + title,
      year: r.year,
      country: r.country,
      image: r.images?.[0]?.uri,
      color: "Black",
      basePrice,
      stock
    };

  } catch {
    return null;
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

    const results = (data.results || []).slice(0, 5);

    const formatted = [];

    for (const r of results) {
      const full = await fetchRelease(r.id);
      if (full) formatted.push(full);
    }

    res.json({ results: formatted });

  } catch {
    res.json({ results: [] });
  }
});

// ----------------------------
// IMPORT
// ----------------------------
app.post("/import",(req,res)=>{
  const items = req.body.items || [];

  items.forEach(i=>{
    if (!inventorySet.has(i.id)) {
      inventorySet.add(i.id);
      queue.push(i);
    }
  });

  res.json({ success:true });
});

// ----------------------------
// SHOPIFY CREATE
// ----------------------------
async function createShopifyProduct(item) {

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

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
          body_html: `${item.artist}<br/>${item.color}`,
          variants: [{
            price: item.price,
            inventory_quantity: item.stock,
            inventory_management: "shopify"
          }],
          images: item.image ? [{ src: item.image }] : []
        }
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.log("❌ Shopify error:", data);
    } else {
      console.log("✅ Shopify created:", data.product.id);
    }

  } catch (e) {
    console.log("Shopify crash:", e.message);
  }
}

// ----------------------------
// PROCESS QUEUE
// ----------------------------
async function processQueue(){
  if (!queue.length) return;

  const job = queue.shift();
  const data = await fetchRelease(job.id);
  if (!data) return;

  const multiplier = conditionMultiplier[job.condition] || 1;
  const price = (data.basePrice * multiplier).toFixed(2);

  const item = {
    ...data,
    condition: job.condition || "NM",
    price
  };

  history.push(item);

  await createShopifyProduct(item);

  console.log("📦 Added:", item.title, "|", price, "| Stock:", item.stock);
}

setInterval(processQueue,1000);

// ----------------------------
// HISTORY
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

// ----------------------------
app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 POS RUNNING (CSV PRICE + INVENTORY)");
