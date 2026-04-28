const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public"));

// ----------------------------
// STATE
// ----------------------------
let queue = [];
let history = [];
let inventory = new Set();
let jobs = {};

// ----------------------------
// PRICING (RESTORED)
// ----------------------------
const conditionMultiplier = {
  M: 1.5,
  NM: 1.25,
  "VG+": 1.0,
  VG: 0.8,
  G: 0.5
};

const BASE_PRICE = 20;

// ----------------------------
// UTILS
// ----------------------------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ----------------------------
// CLEAN TITLE
// ----------------------------
function cleanTitle(artist, rawTitle){
  if (!rawTitle) return artist;

  let title = rawTitle.replace(artist + " - ", "");
  const parts = title.split(" - ");

  if (parts.length > 1) {
    return artist + " - " + parts[0] + ": " + parts.slice(1).join(" - ");
  }

  return artist + " - " + title;
}

// ----------------------------
// COLOR DETECTION
// ----------------------------
function detectColorFromFormats(formats = []) {
  const text = JSON.stringify(formats).toLowerCase();
  const colors = ["red","blue","green","yellow","orange","purple","pink","white","clear","gold","silver","smoke","marble","splatter"];

  const found = colors.filter(c => text.includes(c));
  if (found.length) return found.map(c => c[0].toUpperCase()+c.slice(1)).join(" / ");

  return "Black";
}

// ----------------------------
// FETCH RELEASE
// ----------------------------
async function fetchRelease(id){
  try {
    const r = await fetch(`https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`).then(r=>r.json());

    await sleep(150);

    const artist = r.artists?.[0]?.name || "Unknown";
    const rawTitle = r.title || "Unknown Title";

    return {
      id,
      artist,
      title: cleanTitle(artist, rawTitle),
      year: r.year,
      country: r.country,
      image: r.images?.[0]?.uri,
      color: detectColorFromFormats(r.formats || [])
    };

  } catch {
    return null;
  }
}

// ----------------------------
// SEARCH
// ----------------------------
app.post("/search", async (req, res) => {

  const { barcode } = req.body;

  try {
    const data = await fetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    ).then(r => r.json());

    const results = (data.results || []).slice(0, 5);

    const formatted = [];

    for (const r of results) {
      const full = await fetchRelease(r.id);
      if (full) formatted.push(full);
    }

    res.json({ results: formatted });

  } catch {
    res.json({ results: [] });
  }
});

// ----------------------------
// BULK (PREVIEW ONLY)
// ----------------------------
app.post("/bulk-start", async (req,res)=>{
  const { items } = req.body;

  const jobId = Date.now().toString();
  jobs[jobId] = { total: items.length, done: 0, results: [] };

  processBulk(jobId, items);

  res.json({ jobId });
});

async function processBulk(jobId, items){
  for (let i=0;i<items.length;i++){
    const barcode = items[i];

    const data = await fetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`
    ).then(r=>r.json());

    const top = (data.results||[]).slice(0,5);

    let options = [];

    for (const r of top){
      const full = await fetchRelease(r.id);
      if (full) options.push(full);
    }

    jobs[jobId].results.push({
      barcode,
      options,
      best: options[0]
    });

    jobs[jobId].done++;

    await sleep(250);
  }
}

// ----------------------------
// STATUS
// ----------------------------
app.get("/bulk-status/:id", (req,res)=>{
  const job = jobs[req.params.id];
  if (!job) return res.json({});

  res.json({
    progress: Math.floor((job.done / job.total) * 100),
    results: job.results
  });
});

// ----------------------------
// IMPORT
// ----------------------------
app.post("/import",(req,res)=>{
  const items = req.body.items || [];

  let duplicates=[],added=[];

  items.forEach(i=>{
    if (inventory.has(i.id)) duplicates.push(i.id);
    else {
      inventory.add(i.id);
      queue.push(i);
      added.push(i.id);
    }
  });

  res.json({ success:true,duplicates,added });
});

// ----------------------------
// PROCESS QUEUE (PRICING FIX)
// ----------------------------
async function processQueue(){
  if (!queue.length) return;

  const job = queue.shift();
  const data = await fetchRelease(job.id);
  if (!data) return;

  const multiplier = conditionMultiplier[job.condition] || 1;
  const price = (BASE_PRICE * multiplier).toFixed(2);

  const item = {
    ...data,
    condition: job.condition || "NM",
    price
  };

  history.push(item);

  console.log("📦 Added:", item.title, "|", price);
}

setInterval(processQueue,1000);

// ----------------------------
// HISTORY
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

// ----------------------------
app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 POS RUNNING (PRICING RESTORED)");
});
