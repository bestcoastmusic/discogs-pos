const express = require("express");
const XLSX = require("xlsx");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ----------------------------
let queue = [];
let history = [];
let jobs = {};
let dataMap = {};

const MIN_PRICE = 14.99;
const LOCATION_ID = 113713512818;

// ----------------------------
// HELPERS (ALL INCLUDED NOW)
// ----------------------------
function clean(str){
  if (!str) return "";

  return str
    .replace(/\(.*?\)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g,"")
    .replace(/\s+/g," ")
    .trim();
}

function extractExtras(str){
  const matches = String(str || "").match(/\(.*?\)/g);
  return matches ? matches.join(" ") : "";
}

function calculatePrice(cost){
  if (!cost) return MIN_PRICE;

  let price = Math.ceil(cost * 1.25) - 0.01;

  if (price < MIN_PRICE) price = MIN_PRICE;

  return price.toFixed(2);
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

    dataMap = {};

    rows.forEach(row => {

      const raw = row["Description"];
      const key = clean(raw);

      if (!key) return;

      dataMap[key] = {
        cost: parseFloat(row["Price"]) || 0,
        stock: parseInt(row["QtyInStock"]) || 0,
        extras: extractExtras(raw),
        genre: row["Genre"] || "Other"
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
// MATCH (STRICT)
// ----------------------------
function findMatch(title){
  return dataMap[clean(title)] || null;
}

// ----------------------------
async function safeFetch(url){
  try {
    const r = await fetch(url);
    const t = await r.text();
    return JSON.parse(t);
  } catch {
    return {};
  }
}

// ----------------------------
async function fetchRelease(id){

  const r = await safeFetch(
    `https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`
  );

  const artist = r.artists?.[0]?.name || "";
  const title = r.title || "";

  const full = `${artist} - ${title}`;
  const match = findMatch(full) || {};

  return {
    id,
    title: full,
    description: match.extras || "",
    image: r.images?.[0]?.uri || "",
    basePrice: calculatePrice(match.cost),
    stock: match.stock || 0,
    genre: match.genre || "Other"
  };
}

// ----------------------------
// SEARCH
// ----------------------------
app.post("/search", async (req,res)=>{

  const { barcode } = req.body;

  const data = await safeFetch(
    `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
  );

  const results = (data.results||[]).slice(0,5);

  const out = [];

  for (const r of results){
    out.push(await fetchRelease(r.id));
  }

  res.json({ results: out });
});

// ----------------------------
// BULK
// ----------------------------
app.post("/bulk-start",(req,res)=>{
  const { items } = req.body;

  const id = Date.now().toString();
  jobs[id] = { total: items.length, done: 0, results: [] };

  processBulk(id, items);

  res.json({ jobId: id });
});

async function processBulk(id, items){

  for (let i=0;i<items.length;i++){

    const barcode = items[i];

    const data = await safeFetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    );

    const top = (data.results||[]).slice(0,5);

    const opts = [];

    for (const r of top){
      opts.push(await fetchRelease(r.id));
    }

    jobs[id].results.push({
      barcode,
      options: opts,
      best: opts[0] || null
    });

    jobs[id].done = i + 1;

    await new Promise(r=>setTimeout(r,120));
  }
}

app.get("/bulk-status/:id",(req,res)=>{
  const job = jobs[req.params.id];
  if (!job) return res.json({ progress:0, results:[] });

  res.json({
    progress: Math.floor((job.done/job.total)*100),
    results: job.results
  });
});

// ----------------------------
// SHOPIFY
// ----------------------------
async function upsertProduct(item){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  const res = await fetch(
    `https://${store}/admin/api/2024-01/products.json?limit=250`,
    { headers:{ "X-Shopify-Access-Token": token } }
  );

  const data = await res.json();

  const existing = data.products.find(p => p.title === item.title);

  if (existing){

    const v = existing.variants[0];

    await fetch(
      `https
