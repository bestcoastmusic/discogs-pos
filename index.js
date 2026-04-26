const express = require("express");
const app = express();
app.use(express.json());

const fetch = global.fetch;

// ----------------------------
// STATE
// ----------------------------
let queue = [];
let history = [];

// ----------------------------
// PRICING
// ----------------------------
const conditionMultiplier = {
  M: 1.5,
  NM: 1.25,
  "VG+": 1.0,
  VG: 0.8,
  G: 0.5
};

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
button{background:#00e676;border:none;font-weight:bold;border-radius:6px}
.card{background:#222;padding:10px;margin:6px 0;border-radius:6px;cursor:pointer}
</style>
</head>
<body>

<div class="container">

<div class="panel">
<h3>Scan</h3>

<input id="barcode" placeholder="scan barcode"/>

<select id="condition">
<option>M</option>
<option>NM</option>
<option>VG+</option>
<option>VG</option>
<option>G</option>
</select>

<button id="scanBtn">Search</button>

<div id="results"></div>

<h3>Bulk Import</h3>
<textarea id="bulk"></textarea>
<button id="bulkBtn">Preview Bulk</button>

</div>

<div class="panel">
<h3>Live Feed</h3>
<div id="log"></div>
</div>

</div>

<script>

// ----------------------------
// SEARCH
// ----------------------------
document.getElementById("scanBtn").addEventListener("click", scan);

async function scan(){
  const barcode = document.getElementById("barcode").value;

  const res = await fetch("/search",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ barcode })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "";

  data.results.forEach(r => {
    const div = document.createElement("div");
    div.className = "card";

    div.textContent = r.title + " (" + (r.year || "") + ")";

    div.addEventListener("click", () => {
      importItem(r.id);
    });

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
// BULK
// ----------------------------
document.getElementById("bulkBtn").addEventListener("click", bulk);

async function bulk(){
  const lines = document.getElementById("bulk").value
    .split("\n")
    .filter(Boolean);

  const res = await fetch("/bulk-preview",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items: lines })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "";

  data.results.forEach((r,i) => {

    const div = document.createElement("div");
    div.className = "card";

    const title = document.createElement("div");
    title.textContent = r.title || "Unknown";

    const select = document.createElement("select");
    select.id = "c-" + i;

    ["M","NM","VG+","VG","G"].forEach(c => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      select.appendChild(opt);
    });

    const btn = document.createElement("button");
    btn.textContent = "Queue";

    btn.addEventListener("click", () => {
      confirmBulk(r.id, i);
    });

    div.appendChild(title);
    div.appendChild(select);
    div.appendChild(btn);

    box.appendChild(div);
  });
}

// ----------------------------
// BULK CONFIRM
// ----------------------------
async function confirmBulk(id,i){
  const condition = document.getElementById("c-" + i).value;

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

    div.textContent =
      i.title + " - $" + i.price + " (" + i.condition + ")";

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
// SEARCH (DISCOGS)
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
      year: r.year
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
        year: r?.year
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
    title: r.title || "Unknown",
    artist: r.artists?.[0]?.name || "Unknown",
    basePrice: stats?.median_price || 20
  };
}

// ----------------------------
// QUEUE
// ----------------------------
app.post("/import", (req, res) => {
  const items = req.body.items || [];
  queue.push(...items);

  res.json({ success: true, queued: items.length });
});

async function processQueue(){
  if (queue.length === 0) return;

  const job = queue.shift();

  const data = await fetchRelease(job.id);

  const price = (data.basePrice * (conditionMultiplier[job.condition] || 1)).toFixed(2);

  const item = {
    ...data,
    condition: job.condition,
    price
  };

  history.push(item);
}

setInterval(processQueue, 1000);

// ----------------------------
// HISTORY
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("POS RUNNING CLEAN");
});
