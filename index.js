const express = require("express");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

let queue = [];
let history = [];
let jobs = {};
let dataMap = {};
let inventorySyncRunning = false;
let inventorySyncQueued = false;
let lastInventorySignature = "";
let lastInventorySync = {
  running: false,
  queued: false,
  lastRunAt: null,
  reason: null,
  summary: null,
  error: null
};

const MIN_PRICE = 14.99;
const DEFAULT_LOCATION_ID = 113713512818;
const LOCATION_ID = Number(process.env.SHOPIFY_LOCATION_ID || DEFAULT_LOCATION_ID);
const LOCAL_PRICING_FILE = path.join(__dirname, "pricing.csv");
const SHOPIFY_API_VERSION = "2024-01";
const SHOPIFY_REQUEST_DELAY_MS = 550;

// ----------------------------
function normalizeBarcode(val){
  return String(val || "").replace(/\D/g, "");
}

function getBarcodeCandidates(barcode){
  const clean = normalizeBarcode(barcode);
  const trimmed = clean.replace(/^0+/, "");
  return [...new Set([clean, trimmed].filter(Boolean))];
}

function findMatch(barcode, sourceMap = dataMap){
  const candidates = getBarcodeCandidates(barcode);
  if (!candidates.length) return null;

  for (const candidate of candidates){
    if (sourceMap[candidate]) return sourceMap[candidate];
  }

  for (const [key, value] of Object.entries(sourceMap)){
    const keyCandidates = getBarcodeCandidates(key);

    if (keyCandidates.some(keyCandidate =>
      candidates.some(candidate =>
        keyCandidate === candidate ||
        keyCandidate.includes(candidate) ||
        candidate.includes(keyCandidate) ||
        keyCandidate.endsWith(candidate) ||
        candidate.endsWith(keyCandidate)
      )
    )){
      return value;
    }
  }

  return null;
}

function buildInventorySignature(sourceMap = dataMap){
  return Object.entries(sourceMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([barcode, item]) => `${barcode}:${item.stock}`)
    .join("|");
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractExtras(str){
  const m = String(str || "").match(/\(.*?\)/g);
  return m ? m.join(" ") : "";
}

function simplifyGenre(val){
  return val ? val.split(/[\/,]/)[0].trim() : "Other";
}

function detectColor(text){
  const colors = ["red","blue","green","yellow","orange","purple","pink","white","clear","gold","silver"];
  const lower = String(text || "").toLowerCase();
  for (const c of colors){
    if (lower.includes(c)) return c;
  }
  return "black";
}

function calculatePrice(cost){
  if (!cost) return MIN_PRICE;
  let price = Math.ceil(cost * 1.25) - 0.01;
  if (price < MIN_PRICE) price = MIN_PRICE;
  return price.toFixed(2);
}

// ----------------------------
async function loadExcel(){
  console.log("🔄 Loading Excel...");
  try {
    let wb;

    if (process.env.CSV_URL){
      const res = await fetch(process.env.CSV_URL);
      if (!res.ok){
        console.log("❌ Excel fetch failed:", res.status);
        return;
      }

      const buffer = await res.arrayBuffer();
      wb = XLSX.read(buffer, { type: "buffer" });
      console.log("🌐 Loaded spreadsheet from CSV_URL");
    } else if (fs.existsSync(LOCAL_PRICING_FILE)) {
      wb = XLSX.readFile(LOCAL_PRICING_FILE);
      console.log("📄 Loaded local pricing.csv");
    } else {
      console.log("❌ CSV_URL missing and pricing.csv not found");
      return;
    }

    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    const nextDataMap = {};

    rows.forEach(row => {
      const barcode = normalizeBarcode(
        row["UPC"] || row["Barcode"] || row["EAN"]
      );
      if (!barcode) return;

      nextDataMap[barcode] = {
        cost: parseFloat(row["Price"]) || 0,
        stock: parseInt(row["QtyInStock"] || row["Qty"] || 0),
        extras: extractExtras(row["Description"]),
        genre: simplifyGenre(row["Genre"]),
        color: detectColor(row["Description"])
      };
    });

    dataMap = nextDataMap;

    console.log("✅ Excel Loaded:", Object.keys(dataMap).length);

    const nextSignature = buildInventorySignature(nextDataMap);
    if (nextSignature !== lastInventorySignature){
      lastInventorySignature = nextSignature;
      queueInventorySync("spreadsheet refresh");
    } else {
      console.log("⏭️ Inventory sync skipped: spreadsheet stock unchanged");
    }

  } catch (e){
    console.log("❌ Excel load failed:", e.message);
  }
}

loadExcel();
setInterval(loadExcel, 60000);

// ----------------------------
async function safeFetch(url){
  try {
    const res = await fetch(url);
    return await res.json();
  } catch {
    return {};
  }
}

async function shopifyRequest(pathOrUrl, options = {}){
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token){
    throw new Error("Shopify env missing");
  }

  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://${store}/admin/api/${SHOPIFY_API_VERSION}${pathOrUrl}`;

  const headers = {
    "X-Shopify-Access-Token": token,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };

  const res = await fetch(url, { ...options, headers });
  const text = await res.text();

  let data = {};
  if (text){
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

function getNextLink(linkHeader){
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function getVariantBarcode(variant){
  return normalizeBarcode(variant.barcode) || normalizeBarcode(variant.sku);
}

async function fetchAllShopifyVariants(){
  let nextUrl = `/variants.json?limit=250&fields=id,product_id,inventory_item_id,barcode,sku`;
  const variants = [];

  while (nextUrl){
    const res = await shopifyRequest(nextUrl);
    if (!res.ok){
      throw new Error(`Shopify variants fetch failed (${res.status})`);
    }

    variants.push(...(res.data.variants || []));
    nextUrl = getNextLink(res.headers.get("link"));
  }

  return variants;
}

async function fetchInventoryLevels(inventoryItemIds){
  const levels = new Map();

  for (let i = 0; i < inventoryItemIds.length; i += 50){
    const batch = inventoryItemIds.slice(i, i + 50);
    const params = new URLSearchParams({
      location_ids: String(LOCATION_ID),
      inventory_item_ids: batch.join(",")
    });

    const res = await shopifyRequest(`/inventory_levels.json?${params.toString()}`);
    if (!res.ok){
      throw new Error(`Shopify inventory levels fetch failed (${res.status})`);
    }

    for (const level of res.data.inventory_levels || []){
      levels.set(String(level.inventory_item_id), Number(level.available || 0));
    }
  }

  return levels;
}

async function setInventoryLevel(inventoryItemId, available){
  const res = await shopifyRequest("/inventory_levels/set.json", {
    method: "POST",
    body: JSON.stringify({
      location_id: LOCATION_ID,
      inventory_item_id: inventoryItemId,
      available,
      disconnect_if_necessary: true
    })
  });

  if (!res.ok){
    throw new Error(
      typeof res.data?.errors === "string"
        ? res.data.errors
        : `Shopify inventory set failed (${res.status})`
    );
  }

  return res.data.inventory_level || null;
}

function queueInventorySync(reason){
  if (!Object.keys(dataMap).length){
    console.log("⏭️ Inventory sync skipped: no spreadsheet data");
    return;
  }

  if (inventorySyncRunning){
    inventorySyncQueued = true;
    lastInventorySync.queued = true;
    console.log("⏳ Inventory sync queued:", reason);
    return;
  }

  void syncExistingInventory(reason);
}

async function syncExistingInventory(reason){
  inventorySyncRunning = true;
  inventorySyncQueued = false;
  lastInventorySync = {
    ...lastInventorySync,
    running: true,
    queued: false,
    lastRunAt: new Date().toISOString(),
    reason,
    summary: null,
    error: null
  };

  const syncMap = dataMap;

  try {
    console.log("🔁 Inventory sync started:", reason);

    const variants = await fetchAllShopifyVariants();
    const matched = variants
      .map(variant => {
        const barcode = getVariantBarcode(variant);
        if (!barcode) return null;

        const match = findMatch(barcode, syncMap);
        if (!match) return null;

        return {
          variantId: variant.id,
          inventoryItemId: variant.inventory_item_id,
          barcode,
          desiredStock: match.stock
        };
      })
      .filter(Boolean);

    const levels = await fetchInventoryLevels(
      matched.map(item => item.inventoryItemId)
    );

    let updated = 0;
    let unchanged = 0;
    let failed = 0;

    for (const item of matched){
      const currentStock = levels.has(String(item.inventoryItemId))
        ? levels.get(String(item.inventoryItemId))
        : null;

      if (currentStock === item.desiredStock){
        unchanged++;
        continue;
      }

      try {
        await setInventoryLevel(item.inventoryItemId, item.desiredStock);
        updated++;
        console.log(
          "✅ AUTO INVENTORY:",
          item.barcode,
          `${currentStock ?? "none"} -> ${item.desiredStock}`
        );
      } catch (err){
        failed++;
        console.log("❌ AUTO INVENTORY ERROR:", item.barcode, err.message);
      }

      await sleep(SHOPIFY_REQUEST_DELAY_MS);
    }

    const summary = {
      locationId: LOCATION_ID,
      variantsSeen: variants.length,
      matched: matched.length,
      updated,
      unchanged,
      failed
    };

    lastInventorySync = {
      ...lastInventorySync,
      running: false,
      summary
    };

    console.log("✅ Inventory sync complete:", JSON.stringify(summary));
  } catch (err){
    lastInventorySync = {
      ...lastInventorySync,
      running: false,
      error: err.message
    };

    console.log("❌ Inventory sync failed:", err.message);
  } finally {
    inventorySyncRunning = false;

    if (inventorySyncQueued){
      inventorySyncQueued = false;
      console.log("🔁 Running queued inventory sync");
      void syncExistingInventory("queued rerun");
    }
  }
}

// ----------------------------
async function fetchRelease(id, barcode){
  const r = await safeFetch(
    `https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`
  );

  const artist = r.artists?.[0]?.name || "";
  const title = r.title || "";
  const releaseBarcode = normalizeBarcode(
    r.identifiers?.find(i => String(i.type || "").toLowerCase().includes("barcode"))?.value
  );
  const resolvedBarcode = normalizeBarcode(barcode) || releaseBarcode;
  const match = findMatch(resolvedBarcode);

  if (!match){
    console.log("⚠️ NO EXCEL MATCH:", resolvedBarcode);
  }

  return {
    id,
    barcode: resolvedBarcode,
    title: `${artist} - ${title}`,
    description: match?.extras || "",
    image: r.images?.[0]?.uri || "",
    basePrice: calculatePrice(match?.cost),
    stock: match?.stock ?? 0,
    genre: match?.genre || "Other",
    color: match?.color || "black"
  };
}

// ----------------------------
app.post("/search", async (req,res)=>{
  const { barcode } = req.body;

  const data = await safeFetch(
    `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
  );

  const results = (data.results||[]).slice(0,5);

  const out = [];
  for (const r of results){
    out.push(await fetchRelease(r.id, barcode));
  }

  res.json({ results: out });
});

// ----------------------------
async function upsertProduct(item){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  console.log("📦 SENDING:", item.title, "BARCODE:", item.barcode, "STOCK:", item.stock, "LOCATION:", LOCATION_ID);

  const r = await fetch(
    `https://${store}/admin/api/2024-01/products.json`,
    {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        product:{
          title: item.title,
          body_html: item.description,
          product_type: item.genre,
          tags: `${item.genre}, ${item.color}`,
          images: item.image ? [{ src: item.image }] : [],
          variants:[{
	  	    price: item.basePrice,
	  	    barcode: item.barcode || undefined,
	  	    sku: item.barcode || undefined,
	  	    inventory_management: "shopify",
	  	    inventory_policy: "deny",
	  	    tracked: true
    }]
  }
})
  }
);

  const created = await r.json();

  if (!created.product){
    console.log("❌ SHOPIFY ERROR:", created);
    return;
  }

  const variant = created.product.variants[0];

  const connectRes = await fetch(
    `https://${store}/admin/api/2024-01/inventory_levels/connect.json`,
    {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        location_id: LOCATION_ID,
        inventory_item_id: variant.inventory_item_id
      })
    }
  );

  const connectData = await connectRes.json().catch(() => ({}));
  if (!connectRes.ok){
    console.log("❌ CONNECT ERROR:", connectData);
  }

  const setRes = await fetch(
    `https://${store}/admin/api/2024-01/inventory_levels/set.json`,
    {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        location_id: LOCATION_ID,
        inventory_item_id: variant.inventory_item_id,
        available: item.stock
      })
    }
  );

  const setData = await setRes.json().catch(() => ({}));
  if (!setRes.ok){
    console.log("❌ SET ERROR:", setData);
    return;
  }

  console.log("✅ INVENTORY SET:", setData.inventory_level || { inventory_item_id: variant.inventory_item_id, location_id: LOCATION_ID, available: item.stock });
}

// ----------------------------
app.post("/import",(req,res)=>{
  (req.body.items || []).forEach(i=>{
    queue.push({ id:i.id, barcode:i.barcode });
  });
  res.json({ success:true });
});

app.post("/sync-inventory",(req,res)=>{
  queueInventorySync("manual request");
  res.json({
    success: true,
    sync: {
      ...lastInventorySync,
      running: inventorySyncRunning,
      queued: inventorySyncQueued
    }
  });
});

// ----------------------------
async function processQueue(){
  if (!queue.length) return;

  const job = queue.shift();
  const data = await fetchRelease(job.id, job.barcode);

  history.push(data);
  await upsertProduct(data);
}

setInterval(processQueue,1000);

// ----------------------------
app.get("/history",(req,res)=>{
  res.json({ history });
});

app.get("/sync-status",(req,res)=>{
  res.json({
    sync: {
      ...lastInventorySync,
      running: inventorySyncRunning,
      queued: inventorySyncQueued
    }
  });
});

// ----------------------------
app.listen(process.env.PORT||10000,()=>{
  console.log("🚀 CLEAN STABLE BUILD");
  console.log("📍 Inventory location:", LOCATION_ID);
});
