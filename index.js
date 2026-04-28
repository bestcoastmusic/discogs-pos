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

// 🔥 GENRE FIX
function simplifyGenre(val){
  if (!val) return "Other";

  const first = val.split(/[\/,]/)[0].trim();

  return first;
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
// IMPORT
// ----------------------------
app.post("/import",(req,res)=>{
  const items = req.body.items || [];
  items.forEach(i=> queue.push(i));
  res.json({ success:true });
});

// ----------------------------
// SHOPIFY (GENRE ADDED)
// ----------------------------
async function createShopifyProduct(item){

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  await fetch(`https://${store}/admin/api/2024-01/products.json`, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({
      product:{
        title: item.title,
        product_type: item.genre, // 🔥 THIS MATCHES COLLECTIONS
        tags: item.genre,
        variants:[{
          price: item.basePrice,
          inventory_quantity: item.stock,
          inventory_management:"shopify"
        }],
        images: item.image ? [{ src:item.image }] : []
      }
    })
  });
}

// ----------------------------
// QUEUE
// ----------------------------
async function processQueue(){

  if (!queue.length) return;

  const job = queue.shift();
  const data = await fetchRelease(job.id);

  history.push(data);

  await createShopifyProduct(data);

  console.log("📦 Added:", data.title);
}

setInterval(processQueue,1000);

// ----------------------------
app.get("/history",(req,res)=>{
  res.json({ history });
});

// ----------------------------
app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 GENRE MATCH ACTIVE");
});
