const express = require("express");
require("dotenv").config();

const {
  searchDiscogs,
  pickBestRelease,
} = require("./core/discogs");

const { getPriceByReleaseId } = require("./core/pricing");
const { createShopifyProduct } = require("./core/shopify");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

console.log("🔥 POS SYSTEM RUNNING");

// ================= STATE =================
let queue = [];
let history = [];
let processing = false;

// ================= UI =================
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>POS Scanner</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js"></script>

  <style>
    body { margin:0; font-family:Arial; background:#111; color:#fff; }
    .wrap { display:flex; height:100vh; }

    .left {
      width:40%;
      padding:20px;
      border-right:1px solid #333;
    }

    .right {
      width:60%;
      padding:20px;
      overflow:auto;
    }

    input, textarea {
      width:100%;
      padding:12px;
      margin-bottom:10px;
      font-size:16px;
    }

    button {
      width:100%;
      padding:12px;
      margin-top:5px;
      background:#00c853;
      border:none;
      color:white;
      cursor:pointer;
    }

    .card {
      background:#222;
      padding:10px;
      margin-bottom:10px;
      border-radius:6px;
    }

    #camera {
      margin-top:10px;
      border:2px solid #333;
      min-height:200px;
    }
  </style>
</head>

<body>
<div class="wrap">

<!-- LEFT -->
<div class="left">
  <h2>📦 POS Scanner</h2>

  <input id="barcode" placeholder="scan or type barcode"/>

  <button onclick="scanManual()">Scan</button>
  <button onclick="startCamera()">📷 Camera Scan</button>

  <div id="camera"></div>

  <hr/>

  <h3>Bulk Import</h3>
  <textarea id="bulkList" placeholder="one barcode per line"></textarea>
  <button onclick="runBulk()">Run Bulk Import</button>

  <h3>Queue: <span id="queueCount">0</span></h3>
</div>

<!-- RIGHT -->
<div class="right">
  <h2>🔥 Live Feed</h2>
  <div id="feed"></div>
</div>

</div>

<script>

// ================= MANUAL SCAN =================
async function scanManual() {
  const barcode = document.getElementById("barcode").value;

  const res = await fetch("/api/scan", {
    method:"POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body:"barcode=" + encodeURIComponent(barcode)
  });

  const data = await res.json();
  addFeed(data);
}

// ================= FEED =================
function addFeed(item){
  const div = document.createElement("div");
  div.className = "card";
  div.innerHTML = "<b>" + item.title + "</b><br><small>" + item.status + "</small>";
  document.getElementById("feed").prepend(div);
}

// ================= CAMERA =================
function startCamera(){
  if(!window.Quagga){
    alert("Camera not loaded");
    return;
  }

  Quagga.init({
    inputStream: {
      name: "Live",
      type: "LiveStream",
      target: document.querySelector("#camera"),
      constraints: {
        facingMode: "environment"
      }
    },
    decoder: {
      readers: ["ean_reader", "upc_reader"]
    }
  }, function(err){
    if(err){
      console.log(err);
      return;
    }
    Quagga.start();
  });

  Quagga.onDetected(async function(data){
    const code = data.codeResult.code;

    Quagga.stop();

    const res = await fetch("/api/scan", {
      method:"POST",
      headers: {"Content-Type":"application/x-www-form-urlencoded"},
      body:"barcode=" + encodeURIComponent(code)
    });

    const item = await res.json();
    addFeed(item);
  });
}

// ================= BULK =================
async function runBulk(){
  const list = document.getElementById("bulkList").value;

  const res = await fetch("/api/bulk", {
    method:"POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body:"list=" + encodeURIComponent(list)
  });

  const data = await res.json();

  alert("Queued: " + data.queued);
}

</script>

</body>
</html>
  `);
});

// ================= SCAN =================
app.post("/api/scan", async (req, res) => {
  const barcode = req.body.barcode;

  console.log("SCAN:", barcode);

  const results = await searchDiscogs(barcode);

  if (!results.length) {
    return res.json({ title: barcode, status: "not found" });
  }

  const best = pickBestRelease(results, barcode);

  let price = null;
  if (best?.id) {
    price = await getPriceByReleaseId(best.id);
  }

  const item = {
    title: best.title,
    price,
    status: "success"
  };

  history.unshift(item);

  processQueue();

  res.json(item);
});

// ================= BULK =================
app.post("/api/bulk", async (req, res) => {
  const list = req.body.list?.split("\n") || [];

  queue.push(...list);

  processQueue();

  res.json({ queued: list.length });
});

// ================= QUEUE =================
async function processQueue(){
  if(processing) return;
  processing = true;

  while(queue.length){
    const barcode = queue.shift();

    console.log("BULK:", barcode);

    const results = await searchDiscogs(barcode);

    if(results.length){
      const best = pickBestRelease(results, barcode);

      let price = await getPriceByReleaseId(best.id);

      await createShopifyProduct({
        title: best.title,
        price,
        barcode,
        image: best.cover_image
      });

      history.unshift({
        title: best.title,
        status: "bulk added"
      });
    }
  }

  processing = false;
}

// ================= START =================
app.listen(PORT, () => {
  console.log("🚀 Running on port", PORT);
});
