const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public"));

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

  // remove duplicated artist if present
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

  const colors = [
    "red","blue","green","yellow","orange","purple",
    "pink","white","clear","gold","silver",
    "smoke","marble","splatter"
  ];

  const found = colors.filter(c => text.includes(c));

  if (found.length) {
    return found.map(c => c[0].toUpperCase() + c.slice(1)).join(" / ");
  }

  return "Black";
}

// ----------------------------
// SMART PICK
// ----------------------------
function pickBest(options){
  if (!options.length) return null;

  return options.sort((a,b)=>{
    let scoreA = 0;
    let scoreB = 0;

    if (a.country === "US") scoreA += 2;
    if (b.country === "US") scoreB += 2;

    if (a.color !== "Black") scoreA += 3;
    if (b.color !== "Black") scoreB += 3;

    return scoreB - scoreA;
  })[0];
}

// ----------------------------
// STATE
// ----------------------------
let queue = [];
let history = [];
let inventory = new Set();
let jobs = {};

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
// SHOPIFY
// ----------------------------
async function createShopifyProduct(item) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  try {
    const res = await fetch(`https://${store}/admin/api/2024-01/products.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        product: {
          title: item.title, // CLEAN TITLE USED HERE
          body_html: `
            <strong>${item.artist}</strong><br/>
            ${item.year || ""} ${item.country || ""}<br/>
            Color: ${item.color}<br/>
            Condition: ${item.condition}
          `,
          images: item.image ? [{ src: item.image }] : [],
          variants: [{ price: item.price }]
        }
      })
    });

    const data = await res.json();

    if (!res.ok) console.log("❌ Shopify:", data);
    else console.log("✅ Shopify:", data.product?.id);

  } catch (e) {
    console.log("Shopify crash:", e.message);
  }
}

// ----------------------------
// FETCH RELEASE
// ----------------------------
async function fetchRelease(id){
  try {
    const r = await fetch(
      `https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`
    ).then(r=>r.json());

    await sleep(150);

    const artist = r.artists?.[0]?.name || "Unknown";
    const rawTitle = r.title || "Unknown Title";

    return {
      id,
      artist,
      title: cleanTitle(artist, rawTitle), // 🔥 CLEANED HERE
      year: r.year,
      country: r.country,
      image: r.images?.[0]?.uri,
      color: detectColorFromFormats(r.formats || []),
      basePrice: 20
    };

  } catch {
    return null;
  }
}

// ----------------------------
// BULK START
// ----------------------------
app.post("/bulk-start", async (req,res)=>{
  const { items } = req.body;

  const jobId = Date.now().toString();
  jobs[jobId] = { total: items.length, done: 0, results: [] };

  processBulk(jobId, items);

  res.json({ jobId });
});

// ----------------------------
// BULK PROCESS
// ----------------------------
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

    const best = pickBest(options);

    if (best){
      queue.push({ id: best.id, condition: "NM" });
    }

    jobs[jobId].results.push({
      barcode,
      options,
      best
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
// PROCESS QUEUE
// ----------------------------
async function processQueue(){
  if (!queue.length) return;

  const job = queue.shift();
  const data = await fetchRelease(job.id);
  if (!data) return;

  const price = (data.basePrice * (conditionMultiplier[job.condition]||1)).toFixed(2);

  const item = {...data,condition:job.condition,price};

  history.push(item);
  await createShopifyProduct(item);

  console.log("📦 Added:", item.title);
}

setInterval(processQueue,1000);

// ----------------------------
// HISTORY (RESTORE THIS)
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

// ----------------------------
// ----------------------------
// HISTORY
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 POS RUNNING (CLEAN TITLES)");
});
