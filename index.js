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
// CLEAN / MATCH HELPERS
// ----------------------------
function clean(str){
  return String(str || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9\s\-]/g,"")
    .replace(/\s+/g," ")
    .trim();
}

function extractExtras(str){
  const matches = String(str || "").match(/\(.*?\)/g);
  return matches ? matches.join(" ") : "";
}

function detectColor(text){
  const colors = ["red","blue","green","yellow","orange","purple","pink","white","clear","gold","silver","smoke","marble","splatter"];
  const lower = String(text || "").toLowerCase();
  const found = colors.filter(c => lower.includes(c));
  if (found.length) return found.join(" / ");
  if (lower.includes("colored")) return "Colored Vinyl";
  return "Black";
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

    dataMap = {};

    rows.forEach(row => {
      const rawTitle = row["Description"];
      const cleanTitle = clean(rawTitle);

      if (!cleanTitle) return;

      const extras = extractExtras(rawTitle);

      dataMap[cleanTitle] = {
        cost: parseFloat(row["Price"]) || 0,
        stock: parseInt(row["QtyInStock"]) || 0,
        genre: simplifyGenre(row["Genre"]),
        extras,
        color: detectColor(extras)
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
// MATCHING (FIXED)
// ----------------------------
function findMatch(title){

  const key = clean(title);

  if (dataMap[key]) return dataMap[key];

  const words = key.split(" ").filter(w => w.length > 2);

  let bestMatch = null;
  let bestScore = 0;

  for (const k in dataMap){

    let score = 0;

    for (const word of words){
      if (k.includes(word)) score++;
    }

    if (score > bestScore && score >= 2){
      bestScore = score;
      bestMatch = dataMap[k];
    }
  }

  return bestMatch;
}

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
async function fetchRelease(id){

  const r = await safeFetch(`https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`);

  const artist = r.artists?.[0]?.name || "";
  const title = r.title || "";

  const fullTitle = `${artist} - ${title}`;

  const match = findMatch(fullTitle) || {};

  const image = r.images?.[0]?.uri || "";

  const formatText = JSON.stringify(r.formats || "").toLowerCase();
  const discogsColor = detectColor(formatText);

  return {
    id,
    title: fullTitle,
    description: match.extras || "",
    image,
    basePrice: calculatePrice(match.cost),
    stock: match.stock || 0,
    genre: match.genre || "Other",
    color: match.color !== "Black" ? match.color : discogsColor
  };
}

// ----------------------------
// SEARCH (SCAN BUTTON)
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
// BULK (PROGRESS FIXED)
// ----------------------------
app.post("/bulk-start", (req,res)=>{
  const { items } = req.body;

  const jobId = Date.now().toString();
  jobs[jobId] = { total: items.length, done: 0, results: [] };

  processBulk(jobId, items);

  res.json({ jobId });
});

async function processBulk(jobId, items){

  for (let i = 0; i < items.length; i++){

    const barcode = items[i];

    const data = await safeFetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    );

    const top = (data.results || []).slice(0,5);

    let options = [];

    for (const r of top){
      const full = await fetchRelease(r.id);
      if (full) options.push(full);
    }

    jobs[jobId].results.push({
      barcode,
      options,
      best: options[0] || null
    });

    jobs[jobId].done = i + 1;

    await new Promise(r => setTimeout(r,120));
  }
}

app.get("/bulk-status/:id", (req,res)=>{
  const job = jobs[req.params.id];

  if (!job){
    return res.json({ progress: 0, results: [] });
  }

  const progress = job.total
    ? Math.floor((job.done / job.total) * 100)
    : 0;

  res.json({
    progress,
    results: job.results
  });
});

// ----------------------------
// SHOPIFY UPSERT
// ----------------------------
async function upsertProduct(item){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  const res = await fetch(
    `https://${store}/admin/api/2024-01/products.json?limit=250`,
    {
      headers: { "X-Shopify-Access-Token": token }
    }
  );

  const data = await res.json();

  const existing = data.products.find(p => p.title === item.title);

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
          price: item.basePrice
        }
      })
    });

    await fetch(`https://${store}/admin/api/2024-01/inventory_levels/set.json`, {
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
    });

  } else {

    const createRes = await fetch(`https://${store}/admin/api/2024-01/products.json`, {
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
          variants:[{
            price: item.basePrice,
            inventory_management:"shopify"
          }],
          images: item.image ? [{ src:item.image }] : []
        }
      })
    });

    const created = await createRes.json();
    const variant = created.product.variants[0];

    await fetch(`https://${store}/admin/api/2024-01/inventory_levels/set.json`, {
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
    });
  }
}

// ----------------------------
// IMPORT
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
// HISTORY (RESTORED)
// ----------------------------
app.get("/history",(req,res)=>{
  res.json({ history });
});

// ----------------------------
app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 FULL SYSTEM RESTORED CLEAN BUILD");
});
