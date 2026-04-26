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
    status: "IMPORTED"
  });

  if (history.length > 100) history = history.slice(-100);
}

// --------------------
// UI (SAFE STRING - FIXED)
// --------------------
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");

  res.end(`
<!DOCTYPE html>
<html>
<head>
<title>POS</title>
<style>
body { font-family: Arial; background:#111; color:#fff; text-align:center; padding:20px; }
input, textarea { padding:10px; width:260px; margin:5px; }
button { padding:10px; margin:5px; }
#log { text-align:left; max-width:600px; margin:auto; }
.item { background:#222; margin:5px; padding:8px; }
video { width:300px; display:none; }
</style>
</head>
<body>

<h1>POS SYSTEM</h1>

<input id="barcode" placeholder="barcode"/>
<button onclick="scan()">Scan</button>

<textarea id="bulk" rows="4"></textarea>
<button onclick="bulk()">Bulk</button>

<button onclick="camera()">Camera</button>
<video id="video" autoplay></video>

<div id="log"></div>

<script>

async function scan(){
  const barcode = document.getElementById("barcode").value;

  await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items:[{ barcode }] })
  });
}

async function bulk(){
  const items = document.getElementById("bulk").value
    .split("\\n")
    .filter(Boolean)
    .map(b => ({ barcode: b }));

  await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items })
  });
}

async function camera(){
  const stream = await navigator.mediaDevices.getUserMedia({ video:true });
  document.getElementById("video").srcObject = stream;
  document.getElementById("video").style.display = "block";
}

async function load(){
  const res = await fetch("/history");
  const data = await res.json();

  const log = document.getElementById("log");
  log.innerHTML = "";

  data.history.forEach(i => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerText = i.artist + " - " + i.title + " (" + i.barcode + ")";
    log.appendChild(div);
  });
}

setInterval(load, 2000);
load();

</script>

</body>
</html>
  `);
});

// --------------------
// DISCOGS (SAFE)
// --------------------
async function fetchDiscogs(barcode){
  try {
    const res = await fetch(`https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`);
    const data = await res.json();

    const r = data.results?.[0];
    if (!r) return null;

    const release = await fetch(`https://api.discogs.com/releases/${r.id}?token=${process.env.DISCOGS_TOKEN}`)
      .then(r => r.json());

    return {
      artist: release.artists?.[0]?.name || "Unknown Artist",
      title: release.title || "Unknown Title"
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

  await fetch(`https://${store}/admin/api/2024-01/products.json`, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Access-Token":token
    },
    body: JSON.stringify({
      product:{
        title: item.title,
        variants:[{ price:"20.00" }]
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

    const item = await fetchDiscogs(job.barcode);

    if (item) {
      await createShopifyProduct(item);
      history.push({ barcode: job.barcode, ...item });
    }
  }

  processing = false;
}

setInterval(processQueue, 1000);

// --------------------
// API
// --------------------
app.post("/bulk-import", (req,res)=>{
  req.body.items.forEach(i => queue.push(i));
  res.json({ success:true, queued:req.body.items.length });
});

app.get("/history", (req,res)=>{
  res.json({ history });
});

// --------------------
// START
// --------------------
app.listen(process.env.PORT || 10000, () => {
  console.log("POS RUNNING");
});
