const express = require("express");

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
let shopifyMap = {};

// ----------------------------
// CLEAN
// ----------------------------
function clean(val){
  return val?.replace(/"/g,"").trim();
}

// ----------------------------
// SAFE FETCH
// ----------------------------
async function safeFetch(url){
  try {
    const res = await fetch(url);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  } catch {
    return {};
  }
}

// ----------------------------
// LOAD CSV FROM URL (SMART)
// ----------------------------
async function loadCSV(){

  try {
    const res = await fetch(process.env.CSV_URL);
    const text = await res.text();

    const rows = text.split("\n").filter(r => r.trim());

    const headers = rows[0].split(",").map(h => clean(h));

    const upcIndex = headers.findIndex(h =>
      h.toLowerCase().includes("upc") ||
      h.toLowerCase().includes("barcode")
    );

    const priceIndex = headers.findIndex(h =>
      h.toLowerCase().includes("price")
    );

    const stockIndex = headers.findIndex(h =>
      h.toLowerCase().includes("qty") ||
      h.toLowerCase().includes("stock")
    );

    priceMap = {};
    stockMap = {};

    rows.slice(1).forEach(row => {

      const cols = row.split(",");

      const upc = clean(cols[upcIndex])?.replace(/\D/g,"");
      const price = parseFloat(clean(cols[priceIndex]));
      const stock = parseInt(clean(cols[stockIndex]));

      if (!upc) return;

      priceMap[upc] = price || 0;
      stockMap[upc] = stock || 0;
    });

    console.log("✅ CSV Loaded:", Object.keys(priceMap).length);

  } catch (e){
    console.log("❌ CSV load failed:", e.message);
  }
}

// initial + interval
loadCSV();
setInterval(loadCSV, 60000);

// ----------------------------
// FETCH RELEASE
// ----------------------------
async function fetchRelease(id){

  const r = await safeFetch(`https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`);

  const artist = r.artists?.[0]?.name || "Unknown";
  const title = r.title || "Unknown";

  const year = r.year || "";
  const country = r.country || "";
  const image = r.images?.[0]?.uri || "";

  const barcode = r.identifiers
    ?.find(i => i.type === "Barcode")
    ?.value?.replace(/\D/g, "");

  const formatText = JSON.stringify(r.formats || []).toLowerCase();

  const colors = ["red","blue","green","yellow","orange","purple","pink","white","clear","gold","silver","smoke","marble","splatter"];
  const found = colors.filter(c => formatText.includes(c));
  const color = found.length ? found.join(" / ") : "Black";

  let basePrice = priceMap[barcode] || 20;
  let stock = stockMap[barcode] ?? 0;

  return {
    id,
    title: `${artist} - ${title}`,
    year,
    country,
    image,
    barcode,
    color,
    basePrice,
    stock
  };
}

// ----------------------------
// SEARCH
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
// BULK
// ----------------------------
app.post("/bulk-start", async (req,res)=>{
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
// IMPORT
// ----------------------------
app.post("/import",(req,res)=>{
  const items = req.body.items || [];

  items.forEach(i=>{
    if (!inventorySet.has(i.id)){
      inventorySet.add(i.id);
      queue.push(i);
    }
  });

  res.json({ success:true });
});

// ----------------------------
// SHOPIFY
// ----------------------------
async function createShopifyProduct(item){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  const res = await fetch(`https://${store}/admin/api/2024-01/products.json`, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({
      product:{
        title: item.title,
        variants:[{
          price: item.price,
          inventory_quantity: item.stock,
          inventory_management: "shopify"
        }],
        images: item.image ? [{ src:item.image }] : []
      }
    })
  });

  const data = await res.json();

  if (data.product){
    shopifyMap[item.barcode] = data.product.variants[0].inventory_item_id;
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

  const price = data.basePrice;

  const item = {
    ...data,
    condition: job.condition || "NM",
    price
  };

  history.push(item);

  await createShopifyProduct(item);

  console.log("📦 Added:", item.title);
}

setInterval(processQueue,1000);

// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

// ----------------------------
app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 FULL APP + AUTO CSV");
});
