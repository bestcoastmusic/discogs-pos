const express = require("express");
const XLSX = require("xlsx");

const app = express();
app.use(express.json());
app.use(express.static("public"));

let queue = [];
let history = [];
let jobs = {};
let dataMap = {};

const MIN_PRICE = 14.99;
const LOCATION_ID = 113713512818;

// ----------------------------
// HELPERS
// ----------------------------
function normalizeBarcode(val){
  return String(val || "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
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
      const barcode = normalizeBarcode(
        row["UPC"] || row["Barcode"] || row["EAN"] || row["Code"]
      );

      if (!barcode) return;

      dataMap[barcode] = {
        cost: parseFloat(row["Price"]) || 0,
        stock: parseInt(row["QtyInStock"]) || 0,
        extras: extractExtras(row["Description"]),
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
function findMatch(barcode){
  return dataMap[normalizeBarcode(barcode)] || null;
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

  const r = await safeFetch(
    `https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`
  );

  const artist = r.artists?.[0]?.name || "";
  const title = r.title || "";

  const fullTitle = `${artist} - ${title}`;

  const barcodeRaw =
    r.identifiers?.find(i => i.type === "Barcode")?.value || "";

  const barcode = normalizeBarcode(barcodeRaw);

  const match = findMatch(barcode) || {};

  return {
    id,
    title: fullTitle,
    description: match.extras || "",
    image: r.images?.[0]?.uri || "",
    basePrice: calculatePrice(match.cost),
    stock: match.stock || 0,
    genre: match.genre || "Other"
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
    out.push(await fetchRelease(r.id));
  }

  res.json({ results: out });
});

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
// SHOPIFY (FINAL FIX)
// ----------------------------
async function upsertProduct(item){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  const res = await fetch(
    `https://${store}/admin/api/2024-01/products.json?limit=250`,
    { headers:{ "X-Shopify-Access-Token": token } }
  );

  const data = await res.json();

  let variant;

  const existing = data.products.find(p => p.title === item.title);

  if (existing){
    variant = existing.variants[0];
  } else {

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
            variants:[{
              price: item.basePrice,
              inventory_management: "shopify",
              inventory_policy: "deny",
              tracked: true
            }],
            images: item.image ? [{ src:item.image }] : []
          }
        })
      }
    );

    const created = await r.json();
    variant = created.product.variants[0];
  }

  // CONNECT INVENTORY
  await fetch(
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

  // ADJUST INVENTORY (KEY FIX)
  await fetch(
    `https://${store}/admin/api/2024-01/inventory_levels/adjust.json`,
    {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        location_id: LOCATION_ID,
        inventory_item_id: variant.inventory_item_id,
        available_adjustment: item.stock
      })
    }
  );
}

// ----------------------------
app.post("/import",(req,res)=>{
  (req.body.items||[]).forEach(i=>queue.push(i));
  res.json({ success:true });
});

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
app.listen(process.env.PORT||10000,()=>{
  console.log("🚀 FINAL FIX: BARCODE + SHOPIFY INVENTORY");
});
