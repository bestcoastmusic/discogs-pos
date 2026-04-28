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
function normalizeBarcode(val){
  return String(val || "").replace(/\D/g, "");
}

function findMatch(barcode){
  const clean = normalizeBarcode(barcode);

  for (const key in dataMap){
    if (key.endsWith(clean) || clean.endsWith(key)){
      return dataMap[key];
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
  try {
    const res = await fetch(process.env.CSV_URL);
    const buffer = await res.arrayBuffer();

    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    dataMap = {};

    rows.forEach(row => {
      const barcode = normalizeBarcode(row["UPC"]);
      if (!barcode) return;

      dataMap[barcode] = {
        cost: parseFloat(row["Price"]) || 0,
        stock: parseInt(row["QtyInStock"]) || 0,
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
// ✅ FIXED: THIS WAS COMPLETELY WRONG BEFORE
async function fetchRelease(id, barcode){

  const r = await safeFetch(
    `https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`
  );

  const artist = r.artists?.[0]?.name || "";
  const title = r.title || "";

  const match = findMatch(barcode) || {};

  return {
    id,
    title: `${artist} - ${title}`,
    description: match.extras || "",
    image: r.images?.[0]?.uri || "",
    basePrice: calculatePrice(match.cost),
    stock: match.stock || 0,
    genre: match.genre || "Other",
    color: match.color || "black"
  };
}

// ----------------------------
async function upsertProduct(item){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  // create product
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
          variants:[{
            price: item.basePrice,
            inventory_management: "shopify",
            inventory_policy: "deny"
          }],
          images: item.image ? [{ src:item.image }] : []
        }
      })
    }
  );

  const created = await r.json();
  const variant = created.product.variants[0];

  // connect inventory
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

  // set inventory
  await fetch(
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
}

// ----------------------------
app.post("/import",(req,res)=>{
  (req.body.items || []).forEach(i => {
    queue.push({
      id: i.id,
      barcode: i.barcode
    });
  });

  res.json({ success: true });
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
  console.log("🚀 FIXED BUILD LIVE");
});
