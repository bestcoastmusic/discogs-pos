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
let stockMap = {};
let shopifyMap = {}; // UPC → Shopify inventory_item_id

// ----------------------------
// LOAD CSV FUNCTION
// ----------------------------
function loadCSV() {
  priceMap = {};
  stockMap = {};

  fs.createReadStream("pricing.csv")
    .pipe(csv())
    .on("data", (row) => {
      const upc = row.UPC?.toString().replace(/\D/g, "");
      if (!upc) return;

      if (row.Price) {
        priceMap[upc] = parseFloat(row.Price);
      }

      if (row.QtyInStock !== undefined) {
        stockMap[upc] = parseInt(row.QtyInStock) || 0;
      }
    })
    .on("end", () => {
      console.log("🔄 CSV Reloaded:", Object.keys(stockMap).length);
    });
}

// initial load
loadCSV();

// 🔥 reload every 60 seconds
setInterval(loadCSV, 60000);

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

    let basePrice = 20;
    if (barcode && priceMap[barcode]) basePrice = priceMap[barcode];

    let stock = 0;
    if (barcode && stockMap[barcode] !== undefined) stock = stockMap[barcode];

    return {
      id,
      artist,
      title: artist + " - " + title,
      image: r.images?.[0]?.uri,
      barcode,
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
// IMPORT (BLOCK IF 0 STOCK)
// ----------------------------
app.post("/import",(req,res)=>{
  const items = req.body.items || [];

  let blocked = [];

  items.forEach(i=>{
    const stock = stockMap[i.barcode] || 0;

    if (stock <= 0) {
      blocked.push(i.id);
      return;
    }

    if (!inventorySet.has(i.id)) {
      inventorySet.add(i.id);
      queue.push(i);
    }
  });

  res.json({ success:true, blocked });
});

// ----------------------------
// SHOPIFY CREATE
// ----------------------------
async function createShopifyProduct(item) {

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  const res = await fetch(`https://${store}/admin/api/2024-01/products.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({
      product: {
        title: item.title,
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

  if (data.product) {
    const variant = data.product.variants[0];
    shopifyMap[item.barcode] = variant.inventory_item_id;
  }
}

// ----------------------------
// SYNC INVENTORY TO SHOPIFY
// ----------------------------
async function syncInventory(){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  for (const upc in shopifyMap){

    const inventory_item_id = shopifyMap[upc];
    const qty = stockMap[upc] || 0;

    await fetch(`https://${store}/admin/api/2024-01/inventory_levels/set.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        location_id: process.env.SHOPIFY_LOCATION_ID,
        inventory_item_id,
        available: qty
      })
    });

    await sleep(100);
  }

  console.log("🔄 Shopify inventory synced");
}

// 🔥 sync every 60 seconds
setInterval(syncInventory, 60000);

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

  console.log("📦 Added:", item.title, "| Stock:", item.stock);
}

setInterval(processQueue,1000);

// ----------------------------
// HISTORY
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

// ----------------------------
// ----------------------------
// ----------------------------
// GET SHOPIFY LOCATIONS
// ----------------------------
app.get("/locations", async (req, res) => {

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  try {
    const response = await fetch(`https://${store}/admin/api/2024-01/locations.json`, {
      headers: {
        "X-Shopify-Access-Token": token
      }
    });

    const data = await response.json();

    res.json(data);

  } catch (err) {
    res.json({ error: err.message });
  }
});

// ----------------------------
app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 POS RUNNING (LIVE INVENTORY)");
});
