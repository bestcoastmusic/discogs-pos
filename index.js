const express = require("express");
const app = express();
app.use(express.json());

const fetch = global.fetch;

// =========================
// QUEUE + HISTORY
// =========================
let queue = [];
let processing = false;
let history = [];

// =========================
// HISTORY HELPER
// =========================
function addHistory(barcode, item) {
  history.push({
    barcode,
    title: item?.title || "Unknown Title",
    artist: item?.artist || "Unknown Artist",
    status: "IMPORTED",
    time: new Date().toISOString()
  });

  if (history.length > 100) {
    history = history.slice(-100);
  }
}

// =========================
// FRONTEND UI
// =========================
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Best Coast POS</title>
<style>
body { font-family: Arial; background:#111; color:#fff; text-align:center; padding:20px; }
input, textarea { padding:10px; width:260px; margin:5px; }
button { padding:10px 14px; margin:5px; cursor:pointer; background:#00c853; color:#fff; border:none; border-radius:6px; }
#log { margin-top:20px; text-align:left; max-width:600px; margin:auto; }
.item { background:#222; padding:8px; margin:5px; border-radius:6px; }
video { width:300px; display:none; margin-top:10px; }
</style>
</head>
<body>

<h1>🎧 Best Coast POS</h1>

<h3>Single Scan</h3>
<input id="barcode" placeholder="barcode"/>
<button onclick="scan()">Scan</button>

<h3>Bulk Scan</h3>
<textarea id="bulk" rows="5" placeholder="one barcode per line"></textarea><br/>
<button onclick="bulk()">Run Bulk</button>

<h3>Camera</h3>
<button onclick="camera()">📸 Open Camera</button>
<video id="video" autoplay></video>

<h3>Live Activity</h3>
<div id="log"></div>

<script>

function log(msg){
  const div = document.createElement("div");
  div.className = "item";
  div.innerText = msg;
  document.getElementById("log").prepend(div);
}

// =========================
// SINGLE SCAN
// =========================
async function scan(){
  const barcode = document.getElementById("barcode").value;

  const res = await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items:[{ barcode }] })
  });

  const data = await res.json();
  log("📦 " + barcode + " → QUEUED");
}

// =========================
// BULK
// =========================
async function bulk(){
  const lines = document.getElementById("bulk").value.split("\\n").filter(Boolean);

  const items = lines.map(b => ({ barcode: b }));

  const res = await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items })
  });

  const data = await res.json();
  log("📦 BULK QUEUED: " + data.queued);
}

// =========================
// CAMERA
// =========================
async function camera(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video:true });
    const video = document.getElementById("video");
    video.style.display = "block";
    video.srcObject = stream;
    log("📸 Camera started");
  } catch (e) {
    log("❌ Camera error: " + e.message);
  }
}

// =========================
// LIVE HISTORY
// =========================
async function loadHistory(){
  const res = await fetch("/history");
  const data = await res.json();

  const items = data.history || [];

  const logDiv = document.getElementById("log");
  logDiv.innerHTML = "";

  items.slice().reverse().forEach(item => {
    const div = document.createElement("div");
    div.className = "item";

    div.innerText =
      "📦 " +
      (item.artist || "Unknown Artist") +
      " - " +
      (item.title || "Unknown Title") +
      " (" + item.barcode + ")";

    logDiv.appendChild(div);
  });
}

setInterval(loadHistory, 2000);
loadHistory();

</script>

</body>
</html>
  `);
});

// =========================
// DISCOGS
// =========================
async function fetchDiscogs(barcode){
  try {
    const url = `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`;
    const res = await fetch(url);
    const data = await res.json();

    const result = data.results?.[0];

    if (!result) return null;

    return {
      title: result.title,
      artist: result.artist || "Unknown Artist"
    };

  } catch (e) {
    return null;
  }
}

// =========================
// SHOPIFY (FIXED PRICE = $20)
// =========================
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
        title: item.title || "Unknown Record",
        variants:[
          {
            price: "20.00",
            inventory_quantity: 1
          }
        ]
      }
    })
  });
}

// =========================
// QUEUE PROCESSOR
// =========================
async function processQueue(){
  if (processing) return;
  processing = true;

  while(queue.length > 0){
    const job = queue.shift();

    console.log("PROCESS:", job.barcode);

    const discogs = await fetchDiscogs(job.barcode);

    if (!discogs) {
      addHistory(job.barcode, null);
      continue;
    }

    await createShopifyProduct(discogs);

    addHistory(job.barcode, discogs);
  }

  processing = false;
}

setInterval(processQueue, 1000);

// =========================
// BULK IMPORT
// =========================
app.post("/bulk-import", (req, res) => {
  const items = req.body.items || [];

  items.forEach(i => queue.push(i));

  res.json({
    success:true,
    queued: items.length
  });
});

// =========================
// HISTORY API
// =========================
app.get("/history", (req, res) => {
  res.json({
    success:true,
    history
  });
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🔥 POS RUNNING");
  console.log("🚀 PORT:", PORT);
});
