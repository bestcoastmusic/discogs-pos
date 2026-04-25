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

const PORT = 3000;

// ================= STATE =================
let queue = [];
let history = [];

let bulkStats = {
  total: 0,
  processed: 0,
  active: false
};

// ================= CORE ENGINE =================
async function processBarcode(barcode) {
  const results = await searchDiscogs(barcode);

  if (!results || !results.length) {
    return { ok: false };
  }

  const best = pickBestRelease(results, barcode);

  let price = null;
  if (best?.id) {
    price = await getPriceByReleaseId(best.id);
  }

  await createShopifyProduct({
    title: best.title,
    price,
    barcode,
    image: best.cover_image,
  });

  return {
    ok: true,
    title: best.title,
    price
  };
}

// ================= API: FEED =================
app.get("/api/feed", (req, res) => {
  res.json(history.slice(0, 30));
});

// ================= API: QUEUE =================
app.get("/api/queue", (req, res) => {
  res.json({
    pending: queue.length,
    processed: bulkStats.processed,
    total: bulkStats.total,
    active: bulkStats.active
  });
});

// ================= API: SCAN =================
app.post("/api/scan", async (req, res) => {
  const barcode = req.body.barcode;

  const result = await processBarcode(barcode);

  const item = result.ok
    ? { title: result.title, price: result.price, status: "success" }
    : { title: barcode, status: "fail" };

  history.unshift(item);
  if (history.length > 50) history.pop();

  res.json(item);
});

// ================= API: BULK =================
app.post("/api/bulk", (req, res) => {
  const items = req.body.barcodes
    .split("\n")
    .map(b => b.trim())
    .filter(Boolean);

  queue = queue.concat(items);

  bulkStats.total += items.length;
  bulkStats.active = true;

  res.json({ ok: true, added: items.length });

  process.nextTick(async () => {
    while (queue.length > 0) {
      const barcode = queue.shift();

      const result = await processBarcode(barcode).catch(() => null);

      const item = result?.ok
        ? { title: result.title, price: result.price, status: "success" }
        : { title: barcode, status: "fail" };

      history.unshift(item);
      if (history.length > 50) history.pop();

      bulkStats.processed++;
    }

    bulkStats.active = false;
  });
});

// ================= FRONTEND =================
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>POS Terminal</title>

<style>
body {
  margin:0;
  font-family:-apple-system, BlinkMacSystemFont, sans-serif;
  background:#0b0b0b;
  color:white;
}

.wrap {
  display:grid;
  grid-template-columns:1.2fr 1fr;
  height:100vh;
}

.left, .right {
  padding:20px;
}

input, textarea {
  width:100%;
  padding:16px;
  font-size:18px;
  border:none;
  border-radius:10px;
  outline:none;
}

.card {
  margin-top:20px;
  padding:16px;
  background:#151515;
  border-radius:12px;
}

.item {
  padding:10px;
  margin-bottom:8px;
  background:#1a1a1a;
  border-radius:8px;
}

.live {
  color:#00ff88;
  font-weight:bold;
}

.bar {
  height:10px;
  background:#222;
  border-radius:5px;
  overflow:hidden;
}

.bar > div {
  height:10px;
  background:#00ff88;
  width:0%;
}
</style>
</head>

<body>

<div class="wrap">

<!-- LEFT -->
<div class="left">

  <h1>POS Scanner <span class="live" id="liveDot">● LIVE</span></h1>

  <input id="barcode" placeholder="Scan barcode..." autofocus />

  <div class="card">
    <h3>Bulk Import</h3>
    <textarea id="bulkInput" rows="6"></textarea>
    <button onclick="startBulk()">Start Bulk</button>

    <div class="bar"><div id="progressBar"></div></div>
  </div>

  <div class="card">
    <h3>Bulk Status</h3>
    <div id="bulkStatus">Loading...</div>
  </div>

</div>

<!-- RIGHT -->
<div class="right">

  <h2>Live Feed</h2>

  <div id="feed"></div>

</div>

</div>

<script>

// ================= SOUND (simple browser beeps) =================
function beep(ok=true){
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.value = ok ? 800 : 200;
  o.connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.1);
}

// ================= SCAN =================
document.getElementById("barcode").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;

  const barcode = e.target.value;
  e.target.value = "";

  const res = await fetch("/api/scan", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: "barcode=" + encodeURIComponent(barcode)
  });

  const item = await res.json();

  beep(item.status === "success");

  renderItem(item);
});

// ================= BULK =================
async function startBulk() {
  const barcodes = document.getElementById("bulkInput").value;

  await fetch("/api/bulk", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: "barcodes=" + encodeURIComponent(barcodes)
  });
}

// ================= FEED =================
function renderItem(item) {
  const div = document.createElement("div");
  div.className = "item";
  div.innerHTML =
    "<b>" + item.title + "</b><br>" +
    (item.price ? "£" + item.price : "") + " " + item.status;

  document.getElementById("feed").prepend(div);
}

async function refreshFeed() {
  const res = await fetch("/api/feed");
  const data = await res.json();

  const feed = document.getElementById("feed");
  feed.innerHTML = "";

  data.forEach(renderItem);
}

// ================= QUEUE =================
async function updateQueue() {
  const res = await fetch("/api/queue");
  const d = await res.json();

  document.getElementById("bulkStatus").innerHTML =
    "Status: " + (d.active ? "Running" : "Idle") + "<br>" +
    "Pending: " + d.pending + "<br>" +
    "Processed: " + d.processed + "<br>" +
    "Total: " + d.total;

  const pct = d.total ? (d.processed / d.total) * 100 : 0;
  document.getElementById("progressBar").style.width = pct + "%";

  document.getElementById("liveDot").style.opacity =
    d.active ? "1" : "0.3";
}

// ================= LOOPS =================
setInterval(updateQueue, 1000);
setInterval(refreshFeed, 2000);

refreshFeed();
updateQueue();

</script>

</body>
</html>
  `);
});

// ================= START =================
app.listen(PORT, () => {
  console.log("Running on http://localhost:" + PORT);
});
