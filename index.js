const express = require("express");
const app = express();
app.use(express.json());

const fetch = global.fetch;

let queue = [];
let processing = false;
let history = [];

// --------------------
// HISTORY
// --------------------
function addHistory(barcode, item) {
  history.push({
    barcode,
    artist: item?.artist || "Unknown Artist",
    title: item?.title || "Unknown Title",
    price: item?.price || "?",
    condition: item?.condition || "VG+",
    image: item?.image || ""
  });

  if (history.length > 100) history = history.slice(-100);
}

// --------------------
// UI
// --------------------
app.get("/", (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
<title>Best Coast POS</title>
<style>
body { margin:0; font-family:Arial; background:#0b0b0f; color:#fff; }
.top { padding:10px; background:#111; display:flex; justify-content:space-between; }
.container { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:10px; }
.panel { background:#15151c; padding:10px; border-radius:10px; height:80vh; overflow:auto; }

input, textarea { width:100%; padding:10px; margin-top:6px; background:#222; border:none; color:#fff; border-radius:6px; }
button { width:100%; padding:10px; margin-top:8px; background:#00e676; border:none; border-radius:6px; font-weight:bold; }

.item { display:flex; gap:10px; background:#222; margin:6px 0; padding:10px; border-radius:6px; }
.item img { width:60px; border-radius:4px; }

video { width:100%; display:none; margin-top:10px; border-radius:10px; }

.cond button { width:24%; margin:2px; padding:6px; font-size:12px; }

.ding { position:fixed; bottom:20px; right:20px; background:#00e676; color:#000; padding:10px; border-radius:20px; display:none; }
</style>
</head>
<body>

<div class="top">
  <div>🎧 BEST COAST POS</div>
  <div>LIVE</div>
</div>

<div class="container">

<div class="panel">
<h3>Scan</h3>
<input id="barcode" placeholder="barcode"/>

<div class="cond">
<button onclick="setCond('NM')">NM</button>
<button onclick="setCond('VG+')">VG+</button>
<button onclick="setCond('VG')">VG</button>
<button onclick="setCond('G')">G</button>
</div>

<button onclick="scan()">SCAN</button>

<h3>Bulk</h3>
<textarea id="bulk" rows="6"></textarea>
<button onclick="bulk()">BULK</button>

<h3>Camera</h3>
<button onclick="camera()">OPEN CAMERA</button>
<video id="video" autoplay></video>

</div>

<div class="panel">
<h3>Live Feed</h3>
<div id="log"></div>
</div>

</div>

<div class="ding" id="ding">✔ Added</div>

<script>

let condition = "VG+";

function setCond(c){
  condition = c;
}

function ding(){
  const d = document.getElementById("ding");
  d.style.display = "block";
  setTimeout(()=>d.style.display="none",800);
}

async function scan(){
  const barcode = document.getElementById("barcode").value;

  await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items:[{ barcode, condition }] })
  });

  ding();
}

async function bulk(){
  const items = document.getElementById("bulk")
    .value.split("\\n")
    .filter(Boolean)
    .map(b => ({ barcode:b, condition }));

  await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items })
  });

  ding();
}

async function camera(){
  const stream = await navigator.mediaDevices.getUserMedia({ video:true });
  const v = document.getElementById("video");
  v.style.display = "block";
  v.srcObject = stream;
}

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
      "<div><b>"+i.artist+"</b></div>" +
      "<div>"+i.title+"</div>" +
      "<div>$"+i.price+" • "+i.condition+"</div>" +
      "</div>";

    log.appendChild(div);
  });
}

setInterval(load,2000);
load();

</script>

</body>
</html>
  `;
  res.send(html);
});

// --------------------
// DISCOGS FULL DATA
// --------------------
async function fetchDiscogs(barcode){
  try {
    const search = await fetch(
      "https://api.discogs.com/database/search?barcode=" +
      barcode +
      "&token=" +
      process.env.DISCOGS_TOKEN
    ).then(r => r.json());

    const r = search.results?.[0];
    if (!r) return null;

    const release = await fetch(
      "https://api.discogs.com/releases/" +
      r.id +
      "?token=" +
      process.env.DISCOGS_TOKEN
    ).then(r => r.json());

    const market = await fetch(
      "https://api.discogs.com/marketplace/stats/" +
      r.id +
      "?token=" +
      process.env.DISCOGS_TOKEN
    ).then(r => r.json());

    const price = market?.median_price || 20;

    return {
      artist: release.artists?.[0]?.name || "Unknown Artist",
      title: release.title || "Unknown Title",
      image: release.images?.[0]?.uri || "",
      description: (release.notes || "").slice(0, 500),
      price: price.toFixed(2)
    };

  } catch (e) {
    return null;
  }
}

// --------------------
// SHOPIFY
// --------------------
async function createShopifyProduct(item){
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) return;

  await fetch("https://" + store + "/admin/api/2024-01/products.json", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Access-Token":token
    },
    body: JSON.stringify({
      product:{
        title: item.title,
        body_html: "<p>"+item.description+"</p><p>Condition: "+item.condition+"</p>",
        images: item.image ? [{ src: item.image }] : [],
        variants:[{ price:item.price }]
      }
    })
  });
}

// --------------------
// QUEUE
// --------------------
async function processQueue(){
  if (processing) return;
  processing = true;

  while(queue.length){
    const job = queue.shift();

    const data = await fetchDiscogs(job.barcode);
    if (!data) continue;

    data.condition = job.condition || "VG+";

    await createShopifyProduct(data);

    addHistory(job.barcode, data);
  }

  processing = false;
}

setInterval(processQueue,1000);

// --------------------
// API
// --------------------
app.post("/bulk-import",(req,res)=>{
  req.body.items.forEach(i=>queue.push(i));
  res.json({success:true});
});

app.get("/history",(req,res)=>{
  res.json({history});
});

// --------------------
app.listen(process.env.PORT||10000,()=>{
  console.log("POS RUNNING");
});
