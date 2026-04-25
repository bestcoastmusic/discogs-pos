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

console.log("🔥 HANDHELD POS RUNNING");

// ================= STATE =================
let queue = [];
let history = [];
let processing = false;

// ================= HOME UI =================
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Best Coast POS</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js"></script>

  <style>
    body { font-family: Arial; background:#111; color:#fff; margin:0; }
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

    input {
      width:100%;
      padding:15px;
      font-size:18px;
      margin-bottom:10px;
    }

    button {
      width:100%;
      padding:15px;
      font-size:16px;
      margin-top:5px;
      background:#00c853;
      border:none;
      color:#fff;
      cursor:pointer;
    }

    .card {
      background:#222;
      padding:10px;
      margin-bottom:10px;
      border-radius:8px;
    }

    .status { color:#00e676; font-weight:bold; }

    #camera { margin-top:10px; border:2px solid #333; }
  </style>
</head>

<body>
<div class="wrap">

<!-- LEFT PANEL -->
<div class="left">
  <h2>📦 POS Scanner</h2>

  <input id="barcode" placeholder="scan or type barcode"/>

  <button onclick="scanManual()">Scan</button>
  <button onclick="startCamera()">📷 Camera Scan</button>

  <div id="camera"></div>

  <h3>Queue</h3>
  <div id="queue"></div>
</div>

<!-- RIGHT PANEL -->
<div class="right">
  <h2>🔥 Live Feed</h2>
  <div id="feed"></div>
</div>

</div>

<script>
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

function addFeed(item){
  const div = document.createElement("div");
  div.className = "card";
  div.innerHTML = "<b>" + item.title + "</b><br>" +
                  "<span class='status'>" + item.status + "</span>";
  document.getElementById("feed").prepend(div);
}

// ================= CAMERA SCAN =================
function startCamera(){
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
    if(err){ console.log(err); return; }
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

// ================= BULK QUEUE =================
app.post("/api/bulk", async (req, res) => {
  const list = req.body.list?.split("\n") || [];

  queue.push(...list);

  processQueue();

  res.json({ queued: list.length });
});

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
  console.log("🚀 POS running on port", PORT);
});
