const express = require("express");
const app = express();
app.use(express.json());

const fetch = global.fetch;

// =========================
// QUEUE (KEEP YOUR WORKING SYSTEM)
// =========================
let queue = [];
let processing = false;

// =========================
// ROOT UI (FULL POS RESTORE)
// =========================
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Best Coast POS</title>
  <style>
    body {
      font-family: Arial;
      background: #111;
      color: #fff;
      text-align: center;
      padding: 20px;
    }

    input, textarea {
      padding: 10px;
      width: 280px;
      font-size: 16px;
      margin: 5px;
    }

    button {
      padding: 10px 15px;
      margin: 5px;
      cursor: pointer;
      background: #00c853;
      border: none;
      color: white;
      border-radius: 6px;
    }

    #log {
      margin-top: 20px;
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
      text-align: left;
    }

    .item {
      background: #222;
      margin: 5px;
      padding: 10px;
      border-radius: 6px;
    }

    video {
      width: 300px;
      margin-top: 10px;
      display: none;
    }
  </style>
</head>
<body>

<h1>🎧 Best Coast POS</h1>

<!-- SINGLE SCAN -->
<h3>Single Scan</h3>
<input id="barcode" placeholder="Scan barcode" />
<button onclick="scan()">Scan</button>

<!-- CAMERA -->
<h3>Camera Scan</h3>
<button onclick="startCamera()">📸 Open Camera</button>
<video id="video" autoplay></video>

<!-- BULK -->
<h3>Bulk Import</h3>
<textarea id="bulk" rows="5" placeholder="one barcode per line"></textarea><br/>
<button onclick="bulk()">Run Bulk</button>

<!-- LIVE LOG -->
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
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ items: [{ barcode }] })
  });

  const data = await res.json();
  log("📦 " + barcode + " → " + data.results[0].status);
}

// =========================
// BULK SCAN
// =========================
async function bulk(){
  const lines = document.getElementById("bulk").value.split("\\n").filter(Boolean);
  const items = lines.map(b => ({ barcode: b }));

  const res = await fetch("/bulk-import", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ items })
  });

  const data = await res.json();
  log("📦 BULK QUEUED: " + data.queued);
}

// =========================
// CAMERA (BASIC RESTORE)
// =========================
async function startCamera(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const video = document.getElementById("video");
    video.style.display = "block";
    video.srcObject = stream;
    log("📸 Camera started");
  } catch (e) {
    log("❌ Camera error: " + e.message);
  }
}

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
    return data.results?.[0] || null;
  } catch (e) {
    return null;
  }
}

// =========================
// SHOPIFY
// =========================
async function createShopifyProduct(item){
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) return;

  await fetch(`https://${store}/admin/api/2024-01/products.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({
      product: {
        title: item.title || "Unknown Record",
        variants: [{ price: "20.00" }]
      }
    })
  });
}

// =========================
// QUEUE WORKER (UNCHANGED CORE)
// =========================
async function processQueue(){
  if (processing) return;
  processing = true;

  while(queue.length > 0){
    const job = queue.shift();

    console.log("PROCESS:", job.barcode);

    const discogs = await fetchDiscogs(job.barcode);
    if (!discogs) continue;

    await createShopifyProduct(discogs);
  }

  processing = false;
}

setInterval(processQueue, 1000);

// =========================
// BULK IMPORT
// =========================
app.post("/bulk-import", (req, res) => {
  const items = req.body.items || [];

  for (const item of items) {
    queue.push(item);
  }

  res.json({
    success: true,
    queued: items.length,
    results: items.map(i => ({
      barcode: i.barcode,
      status: "QUEUED"
    }))
  });
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🔥 POS STARTING");
  console.log("🚀 PORT:", PORT);
});
