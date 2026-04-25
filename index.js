const express = require("express");

const app = express();
app.use(express.json());

// Node 18+ / 24 built-in fetch
const fetch = global.fetch;

// =========================
// ENV CHECK (DEBUG)
// =========================
console.log("🔥 POS SYSTEM STARTING");
console.log("PORT:", process.env.PORT || 10000);
console.log("SHOPIFY_STORE:", process.env.SHOPIFY_STORE ? "SET" : "MISSING");
console.log("SHOPIFY_TOKEN:", process.env.SHOPIFY_TOKEN ? "SET" : "MISSING");
console.log("DISCOGS_TOKEN:", process.env.DISCOGS_TOKEN ? "SET" : "MISSING");

// =========================
// HOME PAGE (POS UI)
// =========================
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Best Coast Music POS</title>
  <style>
    body {
      font-family: Arial;
      background: #111;
      color: white;
      text-align: center;
      padding: 40px;
    }

    input {
      padding: 15px;
      width: 320px;
      font-size: 18px;
      border-radius: 8px;
      border: none;
      margin-top: 20px;
    }

    button {
      padding: 15px 20px;
      font-size: 16px;
      margin-left: 10px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      background: #00c853;
      color: white;
    }

    .box {
      margin-top: 30px;
      padding: 20px;
      background: #222;
      border-radius: 10px;
      display: inline-block;
      min-width: 420px;
      text-align: left;
    }

    .item {
      margin-top: 10px;
      padding: 10px;
      background: #333;
      border-radius: 6px;
    }
  </style>
</head>
<body>

  <h1>🎧 Best Coast Music POS</h1>

  <input id="barcode" placeholder="Scan or enter barcode" />
  <button onclick="send()">Import</button>

  <div class="box">
    <h3>Results</h3>
    <div id="results"></div>
  </div>

<script>
async function send() {
  const barcode = document.getElementById('barcode').value;
  if (!barcode) return alert("Enter barcode");

  const res = await fetch('/bulk-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ barcode }]
    })
  });

  const data = await res.json();

  const results = document.getElementById('results');

  data.results.forEach(item => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = "📦 " + item.barcode + " → " + item.status;
    results.appendChild(div);
  });
}
</script>

</body>
</html>
  `);
});

// =========================
// DISCOGS LOOKUP
// =========================
async function searchDiscogsByBarcode(barcode, retries = 2) {
  try {
    const url = `https://api.discogs.com/database/search?barcode=${barcode}&token=${process.env.DISCOGS_TOKEN}`;
    const res = await fetch(url);

    if (res.status === 429 && retries > 0) {
      await new Promise(r => setTimeout(r, 1500));
      return searchDiscogsByBarcode(barcode, retries - 1);
    }

    const data = await res.json();
    return data.results?.[0] || null;

  } catch (err) {
    console.log("Discogs error:", err.message);
    return null;
  }
}

// =========================
// SHOPIFY CREATE PRODUCT
// =========================
async function createShopifyProduct(item) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) {
    console.log("❌ Missing Shopify credentials");
    return;
  }

  let vendor = item.label;

  if (Array.isArray(vendor)) vendor = vendor[0];
  if (!vendor || typeof vendor !== "string") vendor = "Discogs Import";

  const url = `https://${store}/admin/api/2024-01/products.json`;

  const payload = {
    product: {
      title: item.title || "Unknown Record",
      vendor: vendor,
      variants: [{ price: "20.00" }]
    }
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      console.log("❌ SHOPIFY ERROR:", data);
    } else {
      console.log("✅ SHOPIFY SUCCESS:", data.product?.id);
    }

  } catch (err) {
    console.log("❌ SHOPIFY EXCEPTION:", err.message);
  }
}

// =========================
// BULK IMPORT ROUTE
// =========================
app.post("/bulk-import", async (req, res) => {
  const items = req.body.items || [];

  console.log("📦 BULK REQUEST RECEIVED:", items.length);

  const results = [];

  for (const item of items) {
    const barcode = item.barcode;

    console.log("📦 BULK:", barcode);

    const discogs = await searchDiscogsByBarcode(barcode);

    if (!discogs) {
      results.push({
        barcode,
        status: "NOT_FOUND"
      });
      continue;
    }

    await createShopifyProduct(discogs);

    results.push({
      barcode,
      status: "IMPORTED"
    });
  }

  res.json({
    success: true,
    results
  });
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🔥 POS SYSTEM RUNNING");
  console.log("🚀 Running on port", PORT);
});
