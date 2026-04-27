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
      color: detectColorFromFormats(r.formats || []),
      basePrice: 20
    };

  } catch {
    return null;
  }
}

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
          title: item.title,
          body_html: `${item.artist}<br/>${item.color}<br/>${item.condition}`,
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
// PROCESS QUEUE
// ----------------------------
async function processQueue(){
  if (!queue.length) return;

  const job = queue.shift();
  const data = await fetchRelease(job.id);
  if (!data) return;

  const price = (data.basePrice * 1.25).toFixed(2);

  const item = {
    ...data,
    condition: job.condition || "NM",
    price
  };

  history.push(item); // 🔥 THIS MAKES HISTORY WORK

  await createShopifyProduct(item);

  console.log("📦 Added:", item.title);
}

setInterval(processQueue,1000);

// ----------------------------
// TEST IMPORT (TEMPORARY)
// ----------------------------
app.post("/test-add", (req,res)=>{
  queue.push({ id: req.body.id, condition: "NM" });
  res.json({ ok: true });
});

// ----------------------------
// HISTORY ROUTE
// ----------------------------
app.get("/history", (req, res) => {
  res.json({ history });
});

// ----------------------------
app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 POS RUNNING (HISTORY WORKING)");
});
