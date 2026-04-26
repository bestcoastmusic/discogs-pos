const express = require("express");
const app = express();
app.use(express.json());

const fetch = global.fetch;

// ----------------------------
// STATE (PRODUCTION SAFE)
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
// DUPLICATE PROTECTION (SKU BASED)
// ----------------------------
function getSKU(id, condition) {
  return `${id}-${condition}`;
}

function alreadyExists(id, condition) {
  return inventory.has(getSKU(id, condition));
}

function saveItem(id, condition, item) {
  inventory.set(getSKU(id, condition), item);
}

// ----------------------------
// SHOPIFY (PRODUCTION SAFE)
// ----------------------------
async function createShopifyProduct(item, sku) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) {
    console.log("❌ Shopify missing env vars");
    return;
  }

  try {
    const res = await fetch(`https://${store}/admin/api/2024-01/products.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        product: {
          title: item.title,
          body_html: `<strong>${item.artist}</strong><br/>Condition: ${item.condition}`,
          images: item.image ? [{ src: item.image }] : [],
          variants: [
            {
              price: item.price,
              sku: sku
            }
          ]
        }
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.log("❌ Shopify error:", data);
      return false;
    }

    console.log("✅ Shopify created:", data.product?.id);
    return true;

  } catch (err) {
    console.log("❌ Shopify crash:", err.message);
    return false;
  }
}

// ----------------------------
// FRONTEND
// ----------------------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>PRO POS</title>
<style>
body{margin:0;font-family:Arial;background:#0b0b0f;color:#fff}
.container{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px}
.panel{background:#15151c;padding:10px;border-radius:10px;height:90vh;overflow:auto}
input,textarea,select,button{width:100%;padding:10px;margin-top:6px}
button{background:#00e676;border:none;font-weight:bold;border-radius:6px}
.card{background:#222;padding:10px;margin:6px 0;border-radius:6px;cursor:pointer}
.badge{font-size:11px;color:#00e676}
</style>
</head>
<body>

<div class="container">

<div class="panel">
<h3>Scan</h3>
<input id="barcode"/>
<select id="condition">
<option>M</option><option>NM</option><option>VG+</option><option>VG</option><option>G</option>
</select>
<button onclick="scan()">Search</button>
<div id="results"></div>

<h3>Bulk</h3>
<textarea id="bulk"></textarea>
<button onclick="bulk()">Preview Bulk</button>
</div>

<div class="panel">
<h3>Live Sync</h3>
<div id="log"></div>
</div>

</div>

<script>

// ----------------------------
// SCAN
// ----------------------------
async function scan(){
  const barcode = document.getElementById("barcode").value;

  const res = await fetch("/search",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ barcode })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "<h4>Select Release</h4>";

  data.results.forEach(r => {
    const div = document.createElement("div");
    div.className = "card";

    div.innerHTML =
      "<b>" + r.title + "</b><br/>" +
      (r.year || "") + " • " +
      (r.country || "") + "<br/>" +
      "<span class='badge'>" + (r.format || "") + "</span>";

    div.onclick = () => importItem(r.id);

    box.appendChild(div);
  });
}

// ----------------------------
// IMPORT SINGLE
// ----------------------------
async function importItem(id){
  const condition = document.getElementById("condition").value;

  await fetch("/import",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      items:[{ id, condition }]
    })
  });
}

// ----------------------------
// BULK PREVIEW
// ----------------------------
async function bulk(){
  const lines = document.getElementById("bulk").value.split("\\n").filter(Boolean);

  const res = await fetch("/bulk-preview",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items: lines })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "<h4>Bulk Preview</h4>";

  data.results.forEach((r,i) => {

    const div = document.createElement("div");
    div.className = "card";

    div.innerHTML =
      "<b>" + (r.title || "Unknown") + "</b><br/>" +
      (r.year || "") + " • " +
      (r.country || "") + "<br/>" +
      "<select id='c"+i+"'>" +
        "<option>VG+</option><option>VG</option><option>NM</option><option>M</option>" +
      "</select>" +
      "<button onclick=\"confirmBulk('" + r.id + "'," + i + ")\">Queue</button>";

    box.appendChild(div);
  });
}

// ----------------------------
// CONFIRM BULK
// ----------------------------
async function confirmBulk(id,i){
  const condition = document.getElementById("c"+i).value;

  await fetch("/import",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      items:[{ id, condition }]
    })
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
    div.className = "card";

    div.innerHTML =
      "<b>" + i.artist + "</b><br/>" +
      i.title + "<br/>" +
      "$" + i.price + " • " + i.condition;

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
// SEARCH
// ----------------------------
app.post("/search", async (req, res) => {
  const { barcode } = req.body;

  try {
    const data = await fetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json());

    const results = (data.results || []).slice(0, 10).map(r => ({
      id: r.id,
      title: r.title,
      year: r.year,
      country: r.country,
      format: Array.isArray(r.format) ? r.format.join(", ") : r.format
    }));

    res.json({ results });

  } catch {
    res.json({ results: [] });
  }
});

// ----------------------------
// BULK PREVIEW
// ----------------------------
app.post("/bulk-preview", async (req, res) => {
  const { items } = req.body;

  try {
    const results = await Promise.all(items.map(async (barcode) => {
      const data = await fetch(
        `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
      ).then(r => r.json());

      const r = (data.results || [])[0];

      return {
        id: r?.id,
        title: r?.title,
        year: r?.year,
        country: r?.country
      };
    }));

    res.json({ results });

  } catch {
    res.json({ results: [] });
  }
});

// ----------------------------
// RELEASE FETCH
// ----------------------------
async function fetchRelease(id){
  const r = await fetch(
    `https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`
  ).then(x => x.json());

  const stats = await fetch(
    `https://api.discogs.com/marketplace/stats/${id}?token=${process.env.DISCOGS_TOKEN}`
  ).then(x => x.json()).catch(() => null);

  return {
    artist: r.artists?.[0]?.name || "Unknown Artist",
    title: r.title || "Unknown Title",
    image: r.images?.[0]?.uri || "",
    basePrice: stats?.median_price || 20
  };
}

// ----------------------------
// IMPORT PIPELINE (PRODUCTION SAFE)
// ----------------------------
app.post("/import", async (req, res) => {
  const items = req.body.items || [];

  for (let job of items) {
    queue.push(job);
  }

  res.json({ success: true, queued: items.length });
});

// ----------------------------
// QUEUE PROCESSOR
// ----------------------------
async function processQueue(){
  if (processing) return;
  processing = true;

  while(queue.length){
    const job = queue.shift();

    if (alreadyExists(job.id, job.condition)) continue;

    const data = await fetchRelease(job.id);
    if (!data) continue;

    const price = (data.basePrice * (conditionMultiplier[job.condition] || 1)).toFixed(2);

    const item = {
      ...data,
      condition: job.condition,
      price
    };

    const sku = getSKU(job.id, job.condition);

    saveItem(job.id, job.condition, item);

    history.push(item);

    await createShopifyProduct(item, sku);
  }

  processing = false;
}

setInterval(processQueue,1000);

// ----------------------------
// API
// ----------------------------
app.get("/history",(req,res)=>{
  res.json({ history });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("PRODUCTION POS RUNNING");
});
