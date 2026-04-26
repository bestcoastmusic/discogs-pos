const express = require("express");
const app = express();
app.use(express.json());

const fetch = global.fetch;

// ----------------------------
// STATE
// ----------------------------
let queue = [];
let processing = false;
let history = [];
let inventory = new Map();

// ----------------------------
// PRICING
// ----------------------------
const conditionMultiplier = {
  "M": 1.5,
  "NM": 1.25,
  "VG+": 1.0,
  "VG": 0.8,
  "G": 0.5
};

// ----------------------------
// UI
// ----------------------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Retail POS</title>
<style>
body{margin:0;font-family:Arial;background:#0b0b0f;color:#fff}
.top{padding:10px;background:#111;display:flex;justify-content:space-between}
.container{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px}
.panel{background:#15151c;padding:10px;border-radius:10px;height:80vh;overflow:auto}

input,textarea,select{
  width:100%;
  padding:10px;
  margin-top:6px;
  background:#222;
  border:none;
  color:#fff;
  border-radius:6px;
}

button{
  width:100%;
  padding:10px;
  margin-top:8px;
  background:#00e676;
  border:none;
  border-radius:6px;
  font-weight:bold;
}

.item{
  display:flex;
  gap:10px;
  background:#222;
  margin:6px 0;
  padding:10px;
  border-radius:6px;
}

.item img{width:60px;border-radius:4px}
.release{
  background:#222;
  padding:10px;
  margin:6px 0;
  cursor:pointer;
  border-radius:6px;
}
</style>
</head>
<body>

<div class="top">
  <div>🎧 MULTI-RELEASE POS</div>
  <div>LIVE</div>
</div>

<div class="container">

<div class="panel">

<h3>Scan Barcode</h3>
<input id="barcode"/>

<select id="condition">
  <option>M</option>
  <option>NM</option>
  <option>VG+</option>
  <option>VG</option>
  <option>G</option>
</select>

<button onclick="scan()">SEARCH RELEASES</button>

<div id="results"></div>

<h3>Bulk Import</h3>
<textarea id="bulk"></textarea>
<button onclick="bulk()">IMPORT BULK</button>

</div>

<div class="panel">
<h3>Live Feed</h3>
<div id="log"></div>
</div>

</div>

<script>

let selectedBarcode = null;

// ----------------------------
// SEARCH RELEASES
// ----------------------------
async function scan(){
  const barcode = document.getElementById("barcode").value;
  selectedBarcode = barcode;

  const res = await fetch("/search-releases",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ barcode })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "<h4>Select Release</h4>";

  data.results.forEach(r => {
    const div = document.createElement("div");
    div.className = "release";

    div.innerHTML = `
      <b>${r.title}</b><br/>
      ${r.year || "Unknown"} • ${r.country || "?"}<br/>
      ${r.format || ""}<br/>
    `;

    div.onclick = () => importRelease(r.id);

    box.appendChild(div);
  });
}

// ----------------------------
// IMPORT SELECTED RELEASE
// ----------------------------
async function importRelease(id){
  const condition = document.getElementById("condition").value;

  await fetch("/bulk-import",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      items:[{ barcode:id, condition }]
    })
  });
}

// ----------------------------
// BULK
// ----------------------------
async function bulk(){
  const condition = document.getElementById("condition").value;

  const items = document.getElementById("bulk")
    .value.split("\\n")
    .filter(Boolean)
    .map(b => ({ barcode:b, condition }));

  await fetch("/bulk-import",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items })
  });
}

// ----------------------------
// LIVE FEED
// ----------------------------
async function load(){
  const res = await fetch("/history");
  const data = await res.json();

  const log = document.getElementById("log");
  log.innerHTML = "";

  (data.history || []).slice().reverse().forEach(i => {
    const div = document.createElement("div");
    div.className = "item";

    div.innerHTML =
      "<img src='"+i.image+"'/>" +
      "<div>" +
      "<b>"+i.artist+"</b><br/>" +
      i.title+"<br/>" +
      "$"+i.price+" • "+i.condition +
      "</div>";

    log.appendChild(div);
  });
}

setInterval(load,2000);
load();

</script>

</body>
</html>
  `);
});

// ----------------------------
// MULTI RELEASE SEARCH
// ----------------------------
app.post("/search-releases", async (req, res) => {
  const { barcode } = req.body;

  try {
    const search = await fetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json());

    const results = (search.results || []).slice(0, 6).map(r => ({
      id: r.id,
      title: r.title,
      year: r.year,
      country: r.country,
      format: Array.isArray(r.format) ? r.format.join(", ") : r.format,
      thumb: r.thumb
    }));

    res.json({ results });

  } catch {
    res.json({ results: [] });
  }
});

// ----------------------------
// DISC PROCESSOR
// ----------------------------
async function fetchDiscogs(id){
  try {
    const release = await fetch(
      `https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json());

    const stats = await fetch(
      `https://api.discogs.com/marketplace/stats/${id}?token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json()).catch(() => null);

    const median = stats?.median_price || 20;

    return {
      artist: release.artists?.[0]?.name || "Unknown Artist",
      title: release.title || "Unknown Title",
      image: release.images?.[0]?.uri || "",
      basePrice: median
    };

  } catch {
    return null;
  }
}

// ----------------------------
// SHOPIFY
// ----------------------------
async function createShopifyProduct(item){
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) return;

  await fetch(`https://${store}/admin/api/2024-01/products.json`, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Access-Token":token
    },
    body: JSON.stringify({
      product:{
        title:item.title,
        body_html:`<p>${item.artist}</p>`,
        images:item.image ? [{ src:item.image }] : [],
        variants:[{ price:item.price }]
      }
    })
  });
}

// ----------------------------
// QUEUE
// ----------------------------
async function processQueue(){
  if (processing) return;
  processing = true;

  while(queue.length){
    const job = queue.shift();

    const data = await fetchDiscogs(job.barcode);
    if (!data) continue;

    const multiplier = conditionMultiplier[job.condition || "VG+"] || 1;

    let price = data.basePrice * multiplier;
    if (price < 8) price = 8;

    const item = {
      ...data,
      condition: job.condition || "VG+",
      price: price.toFixed(2)
    };

    inventory.set(job.barcode, item);
    await createShopifyProduct(item);

    history.push(item);
  }

  processing = false;
}

setInterval(processQueue,1000);

// ----------------------------
// API
// ----------------------------
app.post("/bulk-import",(req,res)=>{
  const items = req.body.items || [];
  items.forEach(i => queue.push(i));
  res.json({ success:true, queued:items.length });
});

app.get("/history",(req,res)=>{
  res.json({ history });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("MULTI RELEASE POS RUNNING");
});
