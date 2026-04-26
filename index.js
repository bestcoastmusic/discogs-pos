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
// INVENTORY
// ----------------------------
function isDuplicate(barcode) {
  return inventory.has(barcode);
}

function saveInventory(barcode, item) {
  inventory.set(barcode, item);
}

// ----------------------------
// FRONTEND
// ----------------------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>POS</title>
<style>
body{margin:0;font-family:Arial;background:#0b0b0f;color:#fff}
.container{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px}
.panel{background:#15151c;padding:10px;border-radius:10px;height:90vh;overflow:auto}
input,textarea,select,button{width:100%;padding:10px;margin-top:6px}
button{background:#00e676;border:none;font-weight:bold}
.item{background:#222;padding:10px;margin:6px 0;border-radius:6px}
.release{background:#222;padding:10px;margin:6px 0;cursor:pointer}
.small{font-size:12px;color:#aaa}
</style>
</head>
<body>

<div class="container">

<div class="panel">
<h3>Scan Barcode</h3>
<input id="barcode" />
<select id="condition">
  <option>M</option>
  <option>NM</option>
  <option>VG+</option>
  <option>VG</option>
  <option>G</option>
</select>

<button onclick="scan()">SEARCH</button>

<div id="results"></div>

<h3>Bulk</h3>
<textarea id="bulk"></textarea>
<button onclick="bulk()">IMPORT</button>
</div>

<div class="panel">
<h3>Live</h3>
<div id="log"></div>
</div>

</div>

<script>

async function scan(){
  const barcode = document.getElementById("barcode").value;

  const res = await fetch("/search", {
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

    div.innerHTML =
      "<b>" + r.title + "</b><br/>" +
      (r.year || "Unknown") + " • " +
      (r.country || "?") + "<br/>" +
      (r.format || "");

    div.onclick = () => importRelease(r.id);

    box.appendChild(div);
  });
}

async function importRelease(id){
  const condition = document.getElementById("condition").value;

  await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      items:[{ barcode:id, condition }]
    })
  });
}

async function bulk(){
  const lines = document.getElementById("bulk").value.split("\\n").filter(Boolean);

  const items = lines.map(l => {
    const p = l.split(" ");
    return {
      barcode: p[0],
      condition: p[1] || "VG+"
    };
  });

  await fetch("/bulk-import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items })
  });
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
// DISC SEARCH (MULTI RELEASE)
// ----------------------------
app.post("/search", async (req, res) => {
  const { barcode } = req.body;

  try {
    const data = await fetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json());

    const results = (data.results || []).slice(0, 6).map(r => ({
      id: r.id,
      title: r.title,
      year: r.year,
      country: r.country,
      format: Array.isArray(r.format) ? r.format.join(", ") : r.format
    }));

    res.json({ results });

  } catch (e) {
    res.json({ results: [] });
  }
});

// ----------------------------
// RELEASE FETCH
// ----------------------------
async function fetchRelease(id){
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
}

// ----------------------------
// QUEUE
// ----------------------------
async function processQueue(){
  if (processing) return;
  processing = true;

  while(queue.length){
    const job = queue.shift();

    if (isDuplicate(job.barcode)) {
      continue;
    }

    const data = await fetchRelease(job.barcode);
    if (!data) continue;

    const multiplier = conditionMultiplier[job.condition || "VG+"] || 1;

    let price = data.basePrice * multiplier;
    if (price < 8) price = 8;

    const item = {
      ...data,
      condition: job.condition || "VG+",
      price: price.toFixed(2)
    };

    saveInventory(job.barcode, item);
    history.push(item);
  }

  processing = false;
}

setInterval(processQueue, 1000);

// ----------------------------
// API
// ----------------------------
app.post("/bulk-import", (req, res) => {
  const items = req.body.items || [];
  items.forEach(i => queue.push(i));

  res.json({ success: true, queued: items.length });
});

app.get("/history", (req, res) => {
  res.json({ history });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("POS RUNNING CLEAN");
});
