const fs = require("fs");
require("dotenv").config();

const {
  searchDiscogs,
  pickBestRelease,
} = require("./core/discogs");

const { getPriceByReleaseId } = require("./core/pricing");
const { createShopifyProduct } = require("./core/shopify");

console.log("🔥 BULK POS MODE ACTIVE");

async function processBarcode(barcode) {
  console.log("\n======================");
  console.log("Scanning:", barcode);

  const results = await searchDiscogs(barcode);

  if (!results.length) {
    console.log("No results");
    return;
  }

  const best = pickBestRelease(results, barcode);

  const price = best?.id
    ? await getPriceByReleaseId(best.id)
    : null;

  console.log("Best match:", best.title);
  console.log("Price:", price || "none");

  await createShopifyProduct({
    title: best.title,
    price,
    barcode,
    image: best.cover_image,
  });

  console.log("✅ Added to Shopify");
}

async function run() {
  const file = process.argv[2];

  if (!file) {
    console.log("Usage: node bulk-import.js barcodes.txt");
    return;
  }

  const barcodes = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  console.log("Total barcodes:", barcodes.length);

  for (const barcode of barcodes) {
    await processBarcode(barcode);
  }

  console.log("\n🔥 BULK COMPLETE");
}

run();
