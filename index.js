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

const MIN_PRICE = 14.99;
const DEFAULT_LOCATION_ID = 113713512818;
const LOCATION_ID = Number(process.env.SHOPIFY_LOCATION_ID || DEFAULT_LOCATION_ID);
const LOCAL_PRICING_FILE = path.join(__dirname, "pricing.csv");

// ----------------------------
function normalizeBarcode(val){
  return String(val || "").replace(/\D/g, "");
}

function getBarcodeCandidates(barcode){
  const clean = normalizeBarcode(barcode);
  const trimmed = clean.replace(/^0+/, "");
  return [...new Set([clean, trimmed].filter(Boolean))];
}

function findMatch(barcode){
  const candidates = getBarcodeCandidates(barcode);
  if (!candidates.length) return null;

  for (const candidate of candidates){
    if (dataMap[candidate]) return dataMap[candidate];
  }

  for (const [key, value] of Object.entries(dataMap)){
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

    dataMap = {};

    rows.forEach(row => {
      const barcode = normalizeBarcode(
        row["UPC"] || row["Barcode"] || row["EAN"]
      );
      if (!barcode) return;

      dataMap[barcode] = {
        cost: parseFloat(row["Price"]) || 0,
        stock: parseInt(row["QtyInStock"] || row["Qty"] || 0),
        extras: extractExtras(row["Description"]),
        genre: simplifyGenre(row["Genre"]),
        color: detectColor(row["Description"])
      };
    });

    console.log("✅ Excel Loaded:", Object.keys(dataMap).length);

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

// ----------------------------
app.listen(process.env.PORT||10000,()=>{
  console.log("🚀 CLEAN STABLE BUILD");
  console.log("📍 Inventory location:", LOCATION_ID);
});
