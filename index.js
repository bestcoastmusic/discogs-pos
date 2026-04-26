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
// LABEL WEIGHTING (CURATED STORE VALUE)
// ----------------------------
const labelWeight = {
  "XL Recordings": 20,
  "Sub Pop": 18,
  "Warp Records": 18,
  "4AD": 17,
  "Matador": 16,
  "Domino": 15,
  "Island Records": 10,
  "Sony Music": 5,
  "Universal": 5,
  "Warner": 5
};

// ----------------------------
// INTELLIGENCE SCORING ENGINE
// ----------------------------
function scoreRelease(r, full = false) {
  let score = 0;

  const text = `${r.title || ""} ${r.format || ""} ${r.label?.[0] || ""}`.toLowerCase();

  // ----------------------------
  // PRESSING QUALITY
  // ----------------------------
  if (text.includes("original")) score += 50;
  if (text.includes("first press")) score += 45;
  if (text.includes("reissue")) score -= 10;
  if (text.includes("remaster")) score -= 5;

  // ----------------------------
  // VINYL VARIANTS (RARITY BOOST)
  // ----------------------------
  if (text.includes("clear")) score += 15;
  if (text.includes("splatter")) score += 20;
  if (text.includes("marble")) score += 18;
  if (text.includes("color")) score += 10;
  if (text.includes("limited")) score += 25;
  if (text.includes("numbered")) score += 30;

  // ----------------------------
  // FORMAT QUALITY
  // ----------------------------
  if (text.includes("lp")) score += 10;
  if (text.includes("vinyl")) score += 10;
  if (text.includes("12\"")) score += 8;

  // ----------------------------
  // COUNTRY BOOST
  // ----------------------------
  if ((r.country || "").includes("US")) score += 5;
  if ((r.country || "").includes("UK")) score += 5;
  if ((r.country || "").includes("EU")) score += 3;

  // ----------------------------
  // LABEL BOOST
  // ----------------------------
  const label = r.label?.[0];
  if (label && labelWeight[label]) {
    score += labelWeight[label];
  }

  // ----------------------------
  // MARKET RARITY (Discogs proxy via format diversity)
  // ----------------------------
  if (r.format && r.format.length > 1) score += 5;

  // ----------------------------
  // FULL DETAIL MODE BOOST
  // ----------------------------
  if (full) score += 5;

  return score;
}

// ----------------------------
// FRONTEND
// ----------------------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>PRO RECORD POS</title>
<style>
body{margin:0;font-family:Arial;background:#0b0b0f;color:#fff}
.container{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px}
.panel{background:#15151c;padding:10px;border-radius:10px;height:90vh;overflow:auto}

input,textarea,select,button{
  width:100%;
  padding:10px;
  margin-top:6px;
}

button{background:#00e676;font-weight:bold;border:none;border-radius:6px}

.card{
  display:flex;
  gap:10px;
  background:#222;
  padding:10px;
  margin:6px 0;
  border-radius:8px;
  cursor:pointer;
}

.card img{
  width:60px;
  height:60px;
  object-fit:cover;
  border-radius:4px;
}

.best{
  border:2px solid #00e676;
}

.badge{
  font-size:11px;
  color:#00e676;
}
</style>
</head>
<body>

<div class="container">

<div class="panel">
<h3>Scan Barcode</h3>
<input id="barcode"/>

<select id="condition">
  <option>M</option>
  <option>NM</option>
  <option>VG+</option>
  <option>VG</option>
  <option>G</option>
</select>

<button onclick="scan()">SMART SEARCH</button>

<div id="results"></div>

<h3>Bulk</h3>
<textarea id="bulk"></textarea>
<button onclick="bulk()">IMPORT</button>
</div>

<div class="panel">
<h3>Live Feed</h3>
<div id="log"></div>
</div>

</div>

<script>

async function scan(){
  const barcode = document.getElementById("barcode").value;

  const res = await fetch("/search",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ barcode })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "<h4>Best Pressing Ranked</h4>";

  data.results.forEach(r => {

    const div = document.createElement("div");
    div.className = "card" + (r.best ? " best" : "");

    const img = r.thumb || "https://via.placeholder.com/60";

    div.innerHTML =
      "<img src='" + img + "'/>" +
      "<div>" +
      "<b>" + r.title + "</b> " +
      (r.best ? "<span class='badge'>BEST MATCH</span>" : "") +
      "<br/>" +
      (r.year || "") + " • " +
      (r.country || "") + "<br/>" +
      "<span class='badge'>" + (r.label || "") + "</span><br/>" +
      (r.format || "") +
      "</div>";

    div.onclick = () => importRelease(r.id);

    box.appendChild(div);
  });
}

async function importRelease(id){
  const condition = document.getElementById("condition").value;

  await fetch("/bulk-import",{
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

  await fetch("/bulk-import",{
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
    div.className = "card";

    div.innerHTML =
      "<div>" +
      "<b>" + i.artist + "</b><br/>" +
      i.title + "<br/>" +
      "$" + i.price + " • " + i.condition +
      "</div>";

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
// SEARCH ENGINE
// ----------------------------
app.post("/search", async (req, res) => {
  const { barcode } = req.body;

  try {
    const data = await fetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json());

    let results = (data.results || []).slice(0, 10).map(r => ({
      id: r.id,
      title: r.title,
      year: r.year,
      country: r.country,
      label: r.label?.[0],
      format: Array.isArray(r.format) ? r.format.join(", ") : r.format,
      thumb: r.thumb,
      score: scoreRelease(r)
    }));

    results.sort((a,b) => b.score - a.score);

    if (results.length) results[0].best = true;

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

  const median = stats?.median_price || 20;

  return {
    artist: r.artists?.[0]?.name || "Unknown Artist",
    title: r.title || "Unknown Title",
    image: r.images?.[0]?.uri || "",
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

    const data = await fetchRelease(job.barcode);
    if (!data) continue;

    const multiplier = conditionMultiplier[job.condition || "VG+"] || 1;

    let price = data.basePrice * multiplier;
    if (price < 8) price = 8;

    history.push({
      ...data,
      condition: job.condition,
      price: price.toFixed(2)
    });
  }

  processing = false;
}

setInterval(processQueue,1000);

// ----------------------------
// API
// ----------------------------
app.post("/bulk-import",(req,res)=>{
  const items = req.body.items || [];
  items.forEach(i => queue.push(i));
  res.json({ success:true, queued:items.length });
});

app.get("/history",(req,res)=>{
  res.json({ history });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("PRO INTELLIGENT POS RUNNING");
});
