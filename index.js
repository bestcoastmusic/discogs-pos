const express = require("express");
const app = express();
app.use(express.json());

const fetch = global.fetch;

// =========================
// STATE
// =========================
let queue = [];
let processing = false;
let history = [];

// =========================
// HISTORY HELP
// =========================
function addHistory(barcode, item) {
  history.push({
    barcode,
    artist: item?.artist || "Unknown Artist",
    title: item?.title || "Unknown Title",
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
<title>POS</title>
<style>
body { font-family: Arial; background:#111; color:#fff; text-align:center; padding:20px; }
input, textarea { padding:10px; width:260px; margin:5px; }
button { padding:10px 14px; margin:5px; cursor:pointer; background:#00c853; border:none; color:#fff; }
#log { margin-top:20px; max-width:600px; margin:auto; text-align:left; }
.item { background:#222; padding:8px; margin:5px; border-radius:6px; }
video { width:300px; display:none; margin-top:10px; }
</style>
</head>
<body>

<h1>🎧 POS SYSTEM</h1>

<h3>Scan</h3>
<input id="barcode" placeholder="barcode"/>
<button onclick="scan()">Scan</button>

<h3>Bulk</h3>
<textarea id="bulk" rows="5" placeholder="one barcode per line"></textarea><br/>
<button onclick="bulk()">Bulk Import</button>

<h3>Camera</h3>
<button onclick="camera()">📸 Camera</button>
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

// SCAN
async function scan(){
  const barcode = document.getElementById("barcode").value;

  await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items:[{ barcode }] })
  });

  log("📦 " + barcode + " queued");
}

// BULK
async function bulk(){
  const lines = document.getElementById("bulk").value.split("\\n").filter(Boolean);
  const items = lines.map(b => ({ barcode: b }));

  await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items })
  });

  log("📦 bulk queued: " + items.length);
}

// CAMERA
async function camera(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video:true });
    const video = document.getElementById("video");
    video.style.display = "block";
    video.srcObject = stream;
    log("📸 camera started");
  } catch (e) {
    log("camera error: " + e.message);
  }
}

// LIVE HISTORY
async function loadHistory(){
  const res = await fetch("/history");
  const data = await res.json();

  const items = data.history || [];
  const logDiv = document.getElementById("log");

  logDiv.innerHTML = "";

  items.slice().reverse().forEach(item => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerText = `📦 ${item.artist} - ${item.title} (${item.barcode})`;
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
// DISCOGS (REAL FIXED LOOKUP)
// =========================
async function fetchDiscogs(barcode){
  try {
    const searchUrl = `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    const result = searchData.results?.[0];
    if (!result || !result.id) return null;

    const releaseUrl = `https://api.discogs.com/releases/${result.id}?token=${process.env.DISCOGS_TOKEN}`;
    const releaseRes = await fetch(releaseUrl);
    const release = await releaseRes.json();

    return {
      artist: release.artists?.map(a => a.name).join(", ") || "Unknown Artist",
      title: release.title || "Unknown Title"
    };

  } catch (e) {
    console.log("discogs error", e);
    return null;
  }
}

// =========================
// SHOPIFY (FIXED PRICE)
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
        variants:[{ price:"20.00" }]
      }
    })
  });
}

// =========================
// QUEUE
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

    addHistory(job.barcode, {
      artist: discogs.artist,
      title: discogs.title
    });
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
  res.json({ history });
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🔥 POS RUNNING");
});
