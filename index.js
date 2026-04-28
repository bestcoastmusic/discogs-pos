const express = require("express");
const XLSX = require("xlsx");

const app = express();

app.use(express.json());
app.use(express.static("public"));

// ----------------------------
// STATE
// ----------------------------
let queue = [];
let history = [];
let jobs = {};

let priceMap = {};
let stockMap = {};
let genreMap = {};

// ----------------------------
// SETTINGS
// ----------------------------
const MIN_PRICE = 14.99;

// ----------------------------
// HELPERS
// ----------------------------
function normalizeUPC(val){
  if (!val) return "";
  return String(val).replace(/\D/g,"").slice(-12);
}

function calculatePrice(cost){
  if (!cost) return MIN_PRICE;

  let price = cost * 1.25;
  price = Math.ceil(price);
  price = price - 0.01;

  if (price < MIN_PRICE) price = MIN_PRICE;

  return price.toFixed(2);
}

function simplifyGenre(val){
  if (!val) return "Other";
  return val.split(/[\/,]/)[0].trim();
}

// ----------------------------
// LOAD EXCEL
// ----------------------------
async function loadExcel(){
  try {
    const res = await fetch(process.env.CSV_URL);
    const buffer = await res.arrayBuffer();

    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    priceMap = {};
    stockMap = {};
    genreMap = {};

    rows.forEach(row => {
      const keys = Object.keys(row);

      const upcKey = keys.find(k => k.toLowerCase().includes("upc"));
      const priceKey = keys.find(k => k.toLowerCase().includes("price"));
      const stockKey = keys.find(k => k.toLowerCase().includes("qty"));
      const genreKey = keys.find(k => k.toLowerCase().includes("genre"));

      if (!upcKey) return;

      const upc = normalizeUPC(row[upcKey]);

      priceMap[upc] = parseFloat(row[priceKey]) || 0;
      stockMap[upc] = parseInt(row[stockKey]) || 0;

      if (genreKey){
        genreMap[upc] = simplifyGenre(row[genreKey]);
      }
    });

    console.log("✅ Excel Loaded");

  } catch (e){
    console.log("❌ Excel load failed:", e.message);
  }
}

loadExcel();
setInterval(loadExcel, 60000);

// ----------------------------
// SAFE FETCH
// ----------------------------
async function safeFetch(url){
  try {
    const res = await fetch(url);
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ----------------------------
// FETCH RELEASE
// ----------------------------
async function fetchRelease(id){

  const r = await safeFetch(`https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`);

  const artist = r.artists?.[0]?.name || "Unknown";
  const title = r.title || "Unknown";

  const barcodeRaw = r.identifiers?.find(i => i.type === "Barcode")?.value;
  const barcode = normalizeUPC(barcodeRaw);

  const image = r.images?.[0]?.uri || "";

  const cost = priceMap[barcode] || 0;
  const stock = stockMap[barcode] ?? 0;
  const genre = genreMap[barcode] || "Other";

  return {
    id,
    title: `${artist} - ${title}`,
    image,
    barcode,
    basePrice: calculatePrice(cost),
    stock,
    genre
  };
}

// ----------------------------
// SEARCH (FIXED)
// ----------------------------
app.post("/search", async (req, res) => {

  const { barcode } = req.body;

  const data = await safeFetch(
    `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
  );

  const results = (data.results || []).slice(0, 5);

  const formatted = [];

  for (const r of results) {
    const full = await fetchRelease(r.id);
    if (full) formatted.push(full);
  }

  res.json({ results: formatted });
});

// ----------------------------
// BULK (FIXED)
// ----------------------------
app.post("/bulk-start", (req,res)=>{
  const { items } = req.body;

  const jobId = Date.now().toString();
  jobs[jobId] = { total: items.length, done: 0, results: [] };

  processBulk(jobId, items);

  res.json({ jobId });
});

async function processBulk(jobId, items){

  for (let i=0;i<items.length;i++){

    const barcode = items[i];

    const data = await safeFetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    );

    const top = (data.results||[]).slice(0,5);

    let options = [];

    for (const r of top){
      const full = await fetchRelease(r.id);
      if (full) options.push(full);
    }

    jobs[jobId].results.push({
      barcode,
      options,
      best: options[0]
    });

    jobs[jobId].done++;

    await new Promise(r=>setTimeout(r,150));
  }
}

app.get("/bulk-status/:id", (req,res)=>{
  const job = jobs[req.params.id];
  if (!job) return res.json({});

  res.json({
    progress: Math.floor((job.done / job.total) * 100),
    results: job.results
  });
});

// ----------------------------
// FIND EXISTING PRODUCT
// ----------------------------
async function findProductByBarcode(barcode){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  const res = await fetch(
    `https://${store}/admin/api/2024-01/products.json?limit=250`,
    {
      headers: {
        "X-Shopify-Access-Token": token
      }
    }
  );

  const data = await res.json();

  return data.products.find(p =>
    p.variants?.some(v => v.barcode === barcode)
  );
}

// ----------------------------
// UPSERT PRODUCT
// ----------------------------
async function upsertProduct(item){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  const existing = await findProductByBarcode(item.barcode);

  if (existing){

    const variant = existing.variants[0];

    await fetch(`https://${store}/admin/api/2024-01/variants/${variant.id}.json`, {
      method:"PUT",
      headers:{
        "Content-Type":"application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        variant:{
          id: variant.id,
          price: item.basePrice,
          inventory_quantity: item.stock
        }
      })
    });

    console.log("🔄 Updated:", item.title);

  } else {

    await fetch(`https://${store}/admin/api/2024-01/products.json`, {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        product:{
          title: item.title,
          product_type: item.genre,
          tags: item.genre,
          variants:[{
            price: item.basePrice,
            inventory_quantity: item.stock,
            barcode: item.barcode,
            inventory_management:"shopify"
          }],
          images: item.image ? [{ src:item.image }] : []
        }
      })
    });

    console.log("📦 Created:", item.title);
  }
}

// ----------------------------
// IMPORT (BUTTON FIX)
// ----------------------------
app.post("/import",(req,res)=>{
  const items = req.body.items || [];
  items.forEach(i=> queue.push(i));
  res.json({ success:true });
});

// ----------------------------
// QUEUE
// ----------------------------
async function processQueue(){

  if (!queue.length) return;

  const job = queue.shift();
  const data = await fetchRelease(job.id);

  history.push(data);

  await upsertProduct(data);
}

setInterval(processQueue,1000);

// ----------------------------
app.get("/history",(req,res)=>{
  res.json({ history });
});

// ----------------------------
app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 FINAL STABLE BUILD");
});
