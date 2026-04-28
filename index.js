const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");

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
let priceMap = {}; // 🔥 CSV PRICE MAP

// ----------------------------
// LOAD CSV (ON START)
// ----------------------------
fs.createReadStream("pricing.csv")
  .pipe(csv())
  .on("data", (row) => {
    if (row.UPC && row.Price) {
      const upc = row.UPC.toString().trim();
      const price = parseFloat(row.Price);
      if (upc && price) {
        priceMap[upc] = price;
      }
    }
  })
  .on("end", () => {
    console.log("✅ CSV Pricing Loaded:", Object.keys(priceMap).length);
  });

// ----------------------------
// PRICING MULTIPLIER
// ----------------------------
const conditionMultiplier = {
  M: 1.5,
  NM: 1.25,
  "VG+": 1.0,
  VG: 0.8,
  G: 0.5
};

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

    // 🔥 GET UPC FROM DISCOGS
    const barcode = r.identifiers?.find(i => i.type === "Barcode")?.value?.replace(/\D/g, "");

    // 🔥 PRICE FROM CSV
    let basePrice = 20;

    if (barcode && priceMap[barcode]) {
      basePrice = priceMap[barcode];
    } else {
      // fallback to Discogs
      try {
        const stats = await fetch(`https://api.discogs.com/marketplace/stats/${id}?token=${process.env.DISCOGS_TOKEN}`).then(r=>r.json());
        basePrice = stats.median_price || stats.lowest_price || 20;
      } catch {}
    }

    return {
      id,
      artist,
      title: cleanTitle(artist, rawTitle),
      year: r.year,
      country: r.country,
      image: r.images?.[0]?.uri,
      color: detectColorFromFormats(r.formats || []),
      basePrice
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
// PROCESS QUEUE
// ----------------------------
async function processQueue(){
  if (!queue.length) return;

  const job = queue.shift();
  const data = await fetchRelease(job.id);
  if (!data) return;

  const multiplier = conditionMultiplier[job.condition] || 1;
  const price = (data.basePrice * multiplier).toFixed(2);

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
  console.log("🚀 POS RUNNING (CSV PRICING)");
});
