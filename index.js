const express = require("express");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

let queue = [];
let history = [];
let jobs = {};
let dataMap = {};
let inventorySyncRunning = false;
let inventorySyncQueued = false;
let lastInventorySignature = "";
let lastInventorySync = {
  running: false,
  queued: false,
  lastRunAt: null,
  reason: null,
  summary: null,
  error: null
};

const MIN_PRICE = 14.99;
const DEFAULT_LOCATION_ID = 113713512818;
const LOCATION_ID = Number(process.env.SHOPIFY_LOCATION_ID || DEFAULT_LOCATION_ID);
const LOCAL_PRICING_FILE = path.join(__dirname, "pricing.csv");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(DATA_DIR, "history.json");
const HISTORY_LIMIT = 60;
const SHOPIFY_API_VERSION = "2024-01";
const SHOPIFY_REQUEST_DELAY_MS = 550;
const SHOPIFY_MAX_ATTEMPTS = 4;
const DISCOGS_REQUEST_DELAY_MS = 250;
const DISCOGS_FETCH_GAP_MS = 1200;
const DISCOGS_BULK_OPTION_LIMIT = 3;
const COUNTRY_PREFERENCE = [
  "US",
  "USA",
  "United States",
  "Canada",
  "UK",
  "United Kingdom",
  "Europe"
];
const VARIANT_CACHE_TTL_MS = 300000;
let shopifyVariantCache = {
  fetchedAt: 0,
  variants: []
};
let shopifyVariantFetchPromise = null;
let lastDiscogsRequestAt = 0;
let discogsRequestQueue = Promise.resolve();
let queueProcessing = false;

// ----------------------------
function normalizeBarcode(val){
  return String(val || "").replace(/\D/g, "");
}

function getBarcodeCandidates(barcode){
  const clean = normalizeBarcode(barcode);
  const trimmed = clean.replace(/^0+/, "");
  return [...new Set([clean, trimmed].filter(Boolean))];
}

function findMatch(barcode, sourceMap = dataMap){
  const candidates = getBarcodeCandidates(barcode);
  if (!candidates.length) return null;

  for (const candidate of candidates){
    if (sourceMap[candidate]) return sourceMap[candidate];
  }

  for (const [key, value] of Object.entries(sourceMap)){
    const keyCandidates = getBarcodeCandidates(key);

    if (keyCandidates.some(keyCandidate =>
      candidates.some(candidate =>
        keyCandidate === candidate ||
        keyCandidate.includes(candidate) ||
        candidate.includes(keyCandidate) ||
        keyCandidate.endsWith(candidate) ||
        candidate.endsWith(keyCandidate)
      )
    )){
      return value;
    }
  }

  return null;
}

function buildInventorySignature(sourceMap = dataMap){
  return Object.entries(sourceMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([barcode, item]) => `${barcode}:${item.stock}`)
    .join("|");
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDirForFile(filePath){
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function reserveDiscogsRequestSlot(){
  const previous = discogsRequestQueue;
  let releaseQueueSlot = () => {};

  discogsRequestQueue = new Promise(resolve => {
    releaseQueueSlot = resolve;
  });

  await previous;

  const waitMs = Math.max(0, (lastDiscogsRequestAt + DISCOGS_FETCH_GAP_MS) - Date.now());
  if (waitMs){
    await sleep(waitMs);
  }

  lastDiscogsRequestAt = Date.now();

  return releaseQueueSlot;
}

function loadHistoryFromDisk(){
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;

    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)){
      history = parsed.slice(-HISTORY_LIMIT);
      console.log("📝 History loaded:", history.length);
    }
  } catch (err){
    console.log("❌ History load failed:", err.message);
  }
}

function persistHistory(){
  try {
    ensureDirForFile(HISTORY_FILE);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-HISTORY_LIMIT), null, 2));
  } catch (err){
    console.log("❌ History save failed:", err.message);
  }
}

function pushHistoryEntry(item){
  history.push({
    ...item,
    syncedAt: new Date().toISOString()
  });
  history = history.slice(-HISTORY_LIMIT);
  persistHistory();
}

function escapeHtml(val){
  return String(val || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeTextBlock(val){
  return String(val || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");
}

function formatDiscogsFormat(formats){
  return (formats || [])
    .map(format =>
      [format.name, ...(format.descriptions || [])]
        .filter(Boolean)
        .join(" / ")
    )
    .filter(Boolean)
    .join(" • ");
}

function buildDiscogsDescription({ year, country, label, format, extras, notes }){
  const blocks = [];
  const meta = [year, country, label, format].filter(Boolean).join(" • ");
  const cleanExtras = normalizeTextBlock(extras);
  const cleanNotes = normalizeTextBlock(notes);

  if (meta) blocks.push(`<p>${escapeHtml(meta)}</p>`);
  if (cleanExtras) blocks.push(`<p>${escapeHtml(cleanExtras)}</p>`);

  cleanNotes
    .split("\n")
    .filter(Boolean)
    .slice(0, 6)
    .forEach(line => {
      blocks.push(`<p>${escapeHtml(line)}</p>`);
    });

  return blocks.join("");
}

function buildDescriptionText({ year, country, label, format, extras, notes }){
  const noteLine = normalizeTextBlock(notes).replace(/\n+/g, " ").trim();
  const extrasLine = normalizeTextBlock(extras).replace(/\n+/g, " ").trim();

  return noteLine ||
    extrasLine ||
    [year, country, label, format].filter(Boolean).join(" • ");
}

function extractExtras(str){
  const m = String(str || "").match(/\(.*?\)/g);
  return m ? m.join(" ") : "";
}

function simplifyGenre(val){
  return val ? val.split(/[\/,]/)[0].trim() : "Other";
}

function cleanDiscogsArtistName(value){
  return String(value || "")
    .replace(/\s+\(\d+\)\s*$/u, "")
    .trim();
}

function normalizeComparableTitle(value){
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(lp|vinyl|record|stereo|mono|reissue|edition|limited)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCountryPreferenceScore(country){
  const normalized = String(country || "").trim().toLowerCase();
  const index = COUNTRY_PREFERENCE.findIndex(entry => entry.toLowerCase() === normalized);
  return index === -1 ? COUNTRY_PREFERENCE.length : index;
}

function sortResultsByCountryPreference(results){
  return [...results].sort((a, b) => {
    const scoreA = getCountryPreferenceScore(a.country);
    const scoreB = getCountryPreferenceScore(b.country);

    if (scoreA !== scoreB){
      return scoreA - scoreB;
    }

    const yearA = Number(a.year || 0);
    const yearB = Number(b.year || 0);
    if (yearA !== yearB){
      return yearB - yearA;
    }

    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

const COLOR_PATTERNS = [
  { color: "cream", patterns: [/\bcream\b/, /\bivory\b/, /\boff[-\s]?white\b/, /\beggshell\b/, /\bbeige\b/, /\bbone\b/, /\btan\b/, /\bsand\b/, /\bkhaki\b/] },
  { color: "clear", patterns: [/\bclear\b/, /\btransparent\b/, /\btranslucent\b/] },
  { color: "white", patterns: [/\bwhite\b/, /\bmilky\b/, /\bopaque\b/] },
  { color: "silver", patterns: [/\bsilver\b/, /\bgray\b/, /\bgrey\b/, /\bsmoke\b/, /\bsmokey\b/] },
  { color: "gold", patterns: [/\bgold\b/] },
  { color: "pink", patterns: [/\bpink\b/, /\brose\b/] },
  { color: "purple", patterns: [/\bpurple\b/, /\bviolet\b/, /\blavender\b/] },
  { color: "blue", patterns: [/\bblue\b/, /\bcobalt\b/, /\bnavy\b/, /\bteal\b/, /\baqua\b/, /\bcyan\b/] },
  { color: "green", patterns: [/\bgreen\b/, /\bolive\b/, /\bemerald\b/, /\bmint\b/] },
  { color: "yellow", patterns: [/\byellow\b/] },
  { color: "orange", patterns: [/\borange\b/, /\bamber\b/, /\bpeach\b/] },
  { color: "red", patterns: [/\bred\b/, /\bmaroon\b/, /\bcrimson\b/, /\bburgundy\b/] },
  { color: "brown", patterns: [/\bbrown\b/, /\bchocolate\b/, /\bcocoa\b/, /\bcoffee\b/] },
  { color: "black", patterns: [/\bblack\b/, /\bblk\b/] }
];

function detectColor(...inputs){
  const lower = inputs
    .flat()
    .map(value => String(value || "").toLowerCase())
    .join(" ");

  for (const entry of COLOR_PATTERNS){
    if (entry.patterns.some(pattern => pattern.test(lower))){
      return entry.color;
    }
  }

  return "";
}

function chooseColor(primaryColor, fallbackColor){
  const primary = detectColor(primaryColor) || String(primaryColor || "").trim().toLowerCase();
  const fallback = detectColor(fallbackColor) || String(fallbackColor || "").trim().toLowerCase();

  if (primary && primary !== "black") return primary;
  if (fallback) return fallback;
  if (primary) return primary;
  return "black";
}

function buildHtmlDescriptionFromText(text){
  return normalizeTextBlock(text)
    .split("\n")
    .filter(Boolean)
    .map(line => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

function applyItemOverrides(item, overrides = {}){
  if (!overrides || typeof overrides !== "object"){
    return item;
  }

  const next = { ...item };

  if (typeof overrides.title === "string"){
    next.title = overrides.title.trim() || next.title;
  }

  if (typeof overrides.barcode === "string"){
    const clean = normalizeBarcode(overrides.barcode);
    if (clean) next.barcode = clean;
  }

  const price = Number.parseFloat(overrides.basePrice);
  if (Number.isFinite(price) && price > 0){
    next.basePrice = price.toFixed(2);
  }

  const stock = Number.parseInt(overrides.stock, 10);
  if (Number.isFinite(stock) && stock >= 0){
    next.stock = stock;
  }

  ["year", "country", "label", "format", "genre"].forEach(field => {
    if (typeof overrides[field] === "string"){
      next[field] = overrides[field].trim();
    }
  });

  if (typeof overrides.color === "string"){
    next.color = chooseColor(overrides.color, next.color);
  }

  if (typeof overrides.descriptionText === "string"){
    next.descriptionText = normalizeTextBlock(overrides.descriptionText);
    next.description = buildHtmlDescriptionFromText(next.descriptionText);
  } else if (!next.description && next.descriptionText){
    next.description = buildHtmlDescriptionFromText(next.descriptionText);
  }

  return next;
}

function calculatePrice(cost){
  if (!cost) return MIN_PRICE;
  let price = Math.ceil(cost * 1.25) - 0.01;
  if (price < MIN_PRICE) price = MIN_PRICE;
  return price.toFixed(2);
}

// ----------------------------
async function loadExcel(){
  console.log("🔄 Loading Excel...");
  try {
    let wb;

    if (process.env.CSV_URL){
      const res = await fetch(process.env.CSV_URL);
      if (!res.ok){
        console.log("❌ Excel fetch failed:", res.status);
        return;
      }

      const buffer = await res.arrayBuffer();
      wb = XLSX.read(buffer, { type: "buffer" });
      console.log("🌐 Loaded spreadsheet from CSV_URL");
    } else if (fs.existsSync(LOCAL_PRICING_FILE)) {
      wb = XLSX.readFile(LOCAL_PRICING_FILE);
      console.log("📄 Loaded local pricing.csv");
    } else {
      console.log("❌ CSV_URL missing and pricing.csv not found");
      return;
    }

    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    const nextDataMap = {};

    rows.forEach(row => {
      const barcode = normalizeBarcode(
        row["UPC"] || row["Barcode"] || row["EAN"]
      );
      if (!barcode) return;

      nextDataMap[barcode] = {
        cost: parseFloat(row["Price"]) || 0,
        stock: parseInt(row["QtyInStock"] || row["Qty"] || 0),
        extras: extractExtras(row["Description"]),
        genre: simplifyGenre(row["Genre"]),
        color: detectColor(row["Description"])
      };
    });

    dataMap = nextDataMap;

    console.log("✅ Excel Loaded:", Object.keys(dataMap).length);

    const nextSignature = buildInventorySignature(nextDataMap);
    if (nextSignature !== lastInventorySignature){
      lastInventorySignature = nextSignature;
      queueInventorySync("spreadsheet refresh");
    } else {
      console.log("⏭️ Inventory sync skipped: spreadsheet stock unchanged");
    }

  } catch (e){
    console.log("❌ Excel load failed:", e.message);
  }
}

loadExcel();
setInterval(loadExcel, 60000);
loadHistoryFromDisk();

// ----------------------------
async function safeFetch(url){
  const isDiscogs = String(url).includes("api.discogs.com");
  const maxAttempts = isDiscogs ? 3 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1){
    let releaseDiscogsSlot = null;
    try {
      if (isDiscogs){
        releaseDiscogsSlot = await reserveDiscogsRequestSlot();
      }

      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));

      if (releaseDiscogsSlot){
        releaseDiscogsSlot();
        releaseDiscogsSlot = null;
      }

      if (res.status === 429 && isDiscogs && attempt < maxAttempts){
        const retryAfterSeconds = Number(res.headers.get("retry-after") || 2);
        const retryWaitMs = Math.max(2500, retryAfterSeconds * 1000);
        console.log("⏳ Discogs rate limit hit, retrying in", retryWaitMs, "ms");
        await sleep(retryWaitMs);
        continue;
      }

      if (!res.ok){
        return {
          __failed: true,
          __status: res.status,
          message: data.message || data.error || `Request failed (${res.status})`
        };
      }

      return data;
    } catch (err){
      if (releaseDiscogsSlot){
        releaseDiscogsSlot();
        releaseDiscogsSlot = null;
      }

      if (attempt >= maxAttempts){
        return {
          __failed: true,
          message: err.message || "Request failed"
        };
      }

      await sleep(1000 * attempt);
    }
  }

  return {
    __failed: true,
    message: "Request failed"
  };
}

async function searchDiscogsByBarcode(barcode){
  const cleanBarcode = normalizeBarcode(barcode);
  if (!cleanBarcode) return [];

  const data = await safeFetch(
    `https://api.discogs.com/database/search?barcode=${cleanBarcode}&token=${process.env.DISCOGS_TOKEN}`
  );

  if (data.__failed){
    throw new Error(
      data.__status === 429
        ? "Discogs is rate-limiting bulk lookups right now. Please retry in a moment."
        : `Discogs search failed: ${data.message}`
    );
  }

  return (data.results || []).slice(0, 5);
}

async function shopifyRequest(pathOrUrl, options = {}){
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token){
    throw new Error("Shopify env missing");
  }

  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://${store}/admin/api/${SHOPIFY_API_VERSION}${pathOrUrl}`;

  const headers = {
    "X-Shopify-Access-Token": token,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };

  for (let attempt = 1; attempt <= SHOPIFY_MAX_ATTEMPTS; attempt += 1){
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();

    let data = {};
    if (text){
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (res.status === 429 && attempt < SHOPIFY_MAX_ATTEMPTS){
      const retryAfterHeader = Number(res.headers.get("retry-after") || 0);
      const retryWaitMs = retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.max(1500, SHOPIFY_REQUEST_DELAY_MS * (attempt + 1));
      console.log("⏳ Shopify rate limit hit, retrying in", retryWaitMs, "ms");
      await sleep(retryWaitMs);
      continue;
    }

    return { ok: res.ok, status: res.status, data, headers: res.headers };
  }

  return {
    ok: false,
    status: 429,
    data: { errors: "Shopify request failed after retries" },
    headers: new Headers()
  };
}

function getNextLink(linkHeader){
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function getVariantBarcode(variant){
  return normalizeBarcode(variant.barcode) || normalizeBarcode(variant.sku);
}

function invalidateVariantCache(){
  shopifyVariantCache = {
    fetchedAt: 0,
    variants: []
  };
  shopifyVariantFetchPromise = null;
}

function pickVariantCacheFields(variant){
  if (!variant) return null;
  return {
    id: variant.id,
    product_id: variant.product_id,
    inventory_item_id: variant.inventory_item_id,
    barcode: variant.barcode || "",
    sku: variant.sku || ""
  };
}

function upsertVariantInCache(variant){
  const nextVariant = pickVariantCacheFields(variant);
  if (!nextVariant) return;

  const variants = [...(shopifyVariantCache.variants || [])];
  const index = variants.findIndex(item => String(item.id) === String(nextVariant.id));

  if (index >= 0){
    variants[index] = {
      ...variants[index],
      ...nextVariant
    };
  } else {
    variants.push(nextVariant);
  }

  shopifyVariantCache = {
    fetchedAt: Date.now(),
    variants
  };
}

async function fetchAllShopifyVariants(){
  let nextUrl = `/variants.json?limit=250&fields=id,product_id,inventory_item_id,barcode,sku`;
  const variants = [];

  while (nextUrl){
    const res = await shopifyRequest(nextUrl);
    if (!res.ok){
      throw new Error(`Shopify variants fetch failed (${res.status})`);
    }

    variants.push(...(res.data.variants || []));
    nextUrl = getNextLink(res.headers.get("link"));
  }

  return variants;
}

async function getCachedShopifyVariants(force = false){
  const freshEnough = (Date.now() - shopifyVariantCache.fetchedAt) < VARIANT_CACHE_TTL_MS;
  if (!force && freshEnough){
    return shopifyVariantCache.variants;
  }

  if (!force && shopifyVariantFetchPromise){
    return await shopifyVariantFetchPromise;
  }

  shopifyVariantFetchPromise = fetchAllShopifyVariants();
  try {
    const variants = await shopifyVariantFetchPromise;
    shopifyVariantCache = {
      fetchedAt: Date.now(),
      variants
    };
    return variants;
  } finally {
    shopifyVariantFetchPromise = null;
  }
}

async function findExistingVariantByBarcode(barcode){
  const candidates = getBarcodeCandidates(barcode);
  if (!candidates.length) return null;

  const variants = await getCachedShopifyVariants();
  return variants.find(variant => {
    const variantBarcode = getVariantBarcode(variant);
    if (!variantBarcode) return false;

    const variantCandidates = getBarcodeCandidates(variantBarcode);
    return variantCandidates.some(candidate => candidates.includes(candidate));
  }) || null;
}

async function getImportStateForBarcode(barcode){
  const clean = normalizeBarcode(barcode);
  if (!clean){
    return {
      importAction: "check",
      importProductId: null
    };
  }

  try {
    const existingVariant = await findExistingVariantByBarcode(clean);
    return existingVariant
      ? {
          importAction: "update",
          importProductId: existingVariant.product_id || null
        }
      : {
          importAction: "create",
          importProductId: null
        };
  } catch (err){
    console.log("⚠️ IMPORT STATE LOOKUP FAILED:", clean, err.message);
    return {
      importAction: "check",
      importProductId: null
    };
  }
}

async function fetchInventoryLevels(inventoryItemIds){
  const levels = new Map();

  for (let i = 0; i < inventoryItemIds.length; i += 50){
    const batch = inventoryItemIds.slice(i, i + 50);
    const params = new URLSearchParams({
      location_ids: String(LOCATION_ID),
      inventory_item_ids: batch.join(",")
    });

    const res = await shopifyRequest(`/inventory_levels.json?${params.toString()}`);
    if (!res.ok){
      throw new Error(`Shopify inventory levels fetch failed (${res.status})`);
    }

    for (const level of res.data.inventory_levels || []){
      levels.set(String(level.inventory_item_id), Number(level.available || 0));
    }
  }

  return levels;
}

async function setInventoryLevel(inventoryItemId, available){
  const res = await shopifyRequest("/inventory_levels/set.json", {
    method: "POST",
    body: JSON.stringify({
      location_id: LOCATION_ID,
      inventory_item_id: inventoryItemId,
      available,
      disconnect_if_necessary: true
    })
  });

  if (!res.ok){
    throw new Error(
      typeof res.data?.errors === "string"
        ? res.data.errors
        : `Shopify inventory set failed (${res.status})`
    );
  }

  return res.data.inventory_level || null;
}

async function syncInventoryForVariant(variant, available){
  const connectRes = await shopifyRequest("/inventory_levels/connect.json", {
    method: "POST",
    body: JSON.stringify({
      location_id: LOCATION_ID,
      inventory_item_id: variant.inventory_item_id
    })
  });

  if (!connectRes.ok){
    console.log("❌ CONNECT ERROR:", connectRes.data);
  }

  const setRes = await shopifyRequest("/inventory_levels/set.json", {
    method: "POST",
    body: JSON.stringify({
      location_id: LOCATION_ID,
      inventory_item_id: variant.inventory_item_id,
      available
    })
  });

  if (!setRes.ok){
    console.log("❌ SET ERROR:", setRes.data);
    throw new Error(
      typeof setRes.data?.errors === "string"
        ? setRes.data.errors
        : `Shopify inventory set failed (${setRes.status})`
    );
  }

  console.log(
    "✅ INVENTORY SET:",
    setRes.data.inventory_level || {
      inventory_item_id: variant.inventory_item_id,
      location_id: LOCATION_ID,
      available
    }
  );

  return setRes.data.inventory_level || null;
}

function queueInventorySync(reason){
  if (!Object.keys(dataMap).length){
    console.log("⏭️ Inventory sync skipped: no spreadsheet data");
    return;
  }

  if (inventorySyncRunning){
    inventorySyncQueued = true;
    lastInventorySync.queued = true;
    console.log("⏳ Inventory sync queued:", reason);
    return;
  }

  void syncExistingInventory(reason);
}

async function syncExistingInventory(reason){
  inventorySyncRunning = true;
  inventorySyncQueued = false;
  lastInventorySync = {
    ...lastInventorySync,
    running: true,
    queued: false,
    lastRunAt: new Date().toISOString(),
    reason,
    summary: null,
    error: null
  };

  const syncMap = dataMap;

  try {
    console.log("🔁 Inventory sync started:", reason);

    const variants = await fetchAllShopifyVariants();
    const matched = variants
      .map(variant => {
        const barcode = getVariantBarcode(variant);
        if (!barcode) return null;

        const match = findMatch(barcode, syncMap);
        if (!match) return null;

        return {
          variantId: variant.id,
          inventoryItemId: variant.inventory_item_id,
          barcode,
          desiredStock: match.stock
        };
      })
      .filter(Boolean);

    const levels = await fetchInventoryLevels(
      matched.map(item => item.inventoryItemId)
    );

    let updated = 0;
    let unchanged = 0;
    let failed = 0;

    for (const item of matched){
      const currentStock = levels.has(String(item.inventoryItemId))
        ? levels.get(String(item.inventoryItemId))
        : null;

      if (currentStock === item.desiredStock){
        unchanged++;
        continue;
      }

      try {
        await setInventoryLevel(item.inventoryItemId, item.desiredStock);
        updated++;
        console.log(
          "✅ AUTO INVENTORY:",
          item.barcode,
          `${currentStock ?? "none"} -> ${item.desiredStock}`
        );
      } catch (err){
        failed++;
        console.log("❌ AUTO INVENTORY ERROR:", item.barcode, err.message);
      }

      await sleep(SHOPIFY_REQUEST_DELAY_MS);
    }

    const summary = {
      locationId: LOCATION_ID,
      variantsSeen: variants.length,
      matched: matched.length,
      updated,
      unchanged,
      failed
    };

    lastInventorySync = {
      ...lastInventorySync,
      running: false,
      summary
    };

    console.log("✅ Inventory sync complete:", JSON.stringify(summary));
  } catch (err){
    lastInventorySync = {
      ...lastInventorySync,
      running: false,
      error: err.message
    };

    console.log("❌ Inventory sync failed:", err.message);
  } finally {
    inventorySyncRunning = false;

    if (inventorySyncQueued){
      inventorySyncQueued = false;
      console.log("🔁 Running queued inventory sync");
      void syncExistingInventory("queued rerun");
    }
  }
}

// ----------------------------
async function fetchRelease(id, barcode){
  const r = await safeFetch(
    `https://api.discogs.com/releases/${id}?token=${process.env.DISCOGS_TOKEN}`
  );

  if (r.__failed){
    console.log("⚠️ DISCOGS RELEASE FETCH FAILED:", id, r.message);
    return null;
  }

  const artist = cleanDiscogsArtistName(r.artists?.[0]?.name || "");
  const title = r.title || "";
  const year = r.year || "";
  const country = r.country || "";
  const label = r.labels?.[0]?.name || "";
  const format = formatDiscogsFormat(r.formats);
  const releaseBarcode = normalizeBarcode(
    r.identifiers?.find(i => String(i.type || "").toLowerCase().includes("barcode"))?.value
  );
  const resolvedBarcode = normalizeBarcode(barcode) || releaseBarcode;
  const match = findMatch(resolvedBarcode);
  const spreadsheetColor = String(match?.color || "").trim().toLowerCase();
  const discogsColor = detectColor(
    title,
    format,
    r.notes,
    (r.formats || []).flatMap(entry => entry.descriptions || []),
    (r.styles || []).join(" ")
  );
  const finalColor = chooseColor(spreadsheetColor, discogsColor);
  const description = buildDiscogsDescription({
    year,
    country,
    label,
    format,
    extras: match?.extras,
    notes: r.notes
  });
  const descriptionText = buildDescriptionText({
    year,
    country,
    label,
    format,
    extras: match?.extras,
    notes: r.notes
  });

  if (!match){
    console.log("⚠️ NO EXCEL MATCH:", resolvedBarcode);
  }

  return {
    id,
    barcode: resolvedBarcode,
    title: `${artist} - ${title}`,
    description,
    descriptionText,
    image: r.images?.[0]?.uri || "",
    basePrice: calculatePrice(match?.cost),
    stock: match?.stock ?? 0,
    year,
    country,
    label,
    format,
    genre: match?.genre || "Other",
    color: finalColor,
    reviewFlags: {
      fallbackBlack: finalColor === "black" && spreadsheetColor !== "black" && discogsColor !== "black",
      explicitBlack: finalColor === "black" && (spreadsheetColor === "black" || discogsColor === "black"),
      barcodeMismatch: false,
      similarOptions: false
    },
    reviewReasons: []
  };
}

async function buildReleaseOptions(barcode, mode = "single"){
  const rawResults = await searchDiscogsByBarcode(barcode);
  const prioritizedResults = sortResultsByCountryPreference(rawResults);
  const results = mode === "bulk"
    ? prioritizedResults.slice(0, DISCOGS_BULK_OPTION_LIMIT)
    : prioritizedResults;
  const options = [];

  for (const result of results){
    const full = await fetchRelease(result.id, barcode);
    if (full) options.push(full);
  }

  const requestedCandidates = getBarcodeCandidates(barcode);
  const titleCounts = new Map();

  options.forEach(option => {
    const normalizedTitle = normalizeComparableTitle(option.title);
    titleCounts.set(normalizedTitle, (titleCounts.get(normalizedTitle) || 0) + 1);
  });

  for (const option of options){
    const importState = await getImportStateForBarcode(option.barcode);
    const optionCandidates = getBarcodeCandidates(option.barcode);
    const normalizedTitle = normalizeComparableTitle(option.title);
    const barcodeMismatch = Boolean(
      requestedCandidates.length &&
      optionCandidates.length &&
      !optionCandidates.some(candidate => requestedCandidates.includes(candidate))
    );
    const similarOptions = options.length > 1 && (titleCounts.get(normalizedTitle) || 0) > 1;
    const reviewReasons = [];

    if (option.reviewFlags?.fallbackBlack){
      reviewReasons.push("Color fell back to black, so the pressing color may need a quick manual check.");
    }

    if (similarOptions){
      reviewReasons.push("Multiple Discogs matches look very similar for this barcode.");
    }

    if (barcodeMismatch){
      reviewReasons.push("Discogs returned a different barcode than the one you scanned.");
    }

    option.reviewFlags = {
      ...(option.reviewFlags || {}),
      barcodeMismatch,
      similarOptions
    };
    option.reviewReasons = reviewReasons;
    option.needsReview = reviewReasons.length > 0;
    option.importAction = importState.importAction;
    option.importProductId = importState.importProductId;
  }

  return sortResultsByCountryPreference(options);
}

// ----------------------------
app.post("/search", async (req,res)=>{
  const { barcode } = req.body;
  try {
    const results = await buildReleaseOptions(barcode, "single");
    res.json({ results });
  } catch (err){
    console.log("❌ SEARCH ERROR:", err.message);
    res.status(200).json({
      results: [],
      error: err.message
    });
  }
});

app.post("/bulk-start",(req,res)=>{
  const items = (req.body.items || [])
    .map(item => normalizeBarcode(item))
    .filter(Boolean);

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  jobs[jobId] = {
    total: items.length,
    done: 0,
    progress: 0,
    results: [],
    startedAt: new Date().toISOString(),
    finishedAt: null
  };

  void processBulkJob(jobId, items);

  res.json({ jobId });
});

app.get("/bulk-status/:id",(req,res)=>{
  const job = jobs[req.params.id];
  if (!job){
    return res.status(404).json({
      error: "Bulk job not found",
      progress: 0,
      results: []
    });
  }

  res.json({
    progress: job.progress,
    total: job.total,
    done: job.done,
    results: job.results,
    finishedAt: job.finishedAt
  });
});

async function processBulkJob(jobId, items){
  const job = jobs[jobId];
  if (!job) return;

  for (const barcode of items){
    try {
      const options = await buildReleaseOptions(barcode, "bulk");

      job.results.push({
        barcode,
        options,
        best: options[0] || null,
        error: options.length ? null : "No Discogs match found"
      });
    } catch (err){
      job.results.push({
        barcode,
        options: [],
        best: null,
        error: err.message
      });
    }

    job.done += 1;
    job.progress = job.total
      ? Math.floor((job.done / job.total) * 100)
      : 100;

    await sleep(DISCOGS_REQUEST_DELAY_MS);
  }

  job.finishedAt = new Date().toISOString();
  job.progress = 100;
}

// ----------------------------
async function createShopifyProduct(item){
  const res = await shopifyRequest("/products.json", {
    method: "POST",
    body: JSON.stringify({
      product: {
        title: item.title,
        body_html: item.description,
        product_type: item.genre,
        tags: `${item.genre}, ${item.color}`,
        images: item.image ? [{ src: item.image }] : [],
        variants: [{
          price: item.basePrice,
          barcode: item.barcode || undefined,
          sku: item.barcode || undefined,
          inventory_management: "shopify",
          inventory_policy: "deny",
          tracked: true
        }]
      }
    })
  });

  if (!res.ok || !res.data?.product){
    console.log("❌ SHOPIFY ERROR:", res.data);
    throw new Error(`Shopify product create failed (${res.status})`);
  }

  return res.data.product;
}

async function updateShopifyProduct(variant, item){
  const productRes = await shopifyRequest(`/products/${variant.product_id}.json`, {
    method: "PUT",
    body: JSON.stringify({
      product: {
        id: variant.product_id,
        title: item.title,
        body_html: item.description,
        product_type: item.genre,
        tags: `${item.genre}, ${item.color}`
      }
    })
  });

  if (!productRes.ok){
    console.log("❌ PRODUCT UPDATE ERROR:", productRes.data);
    throw new Error(`Shopify product update failed (${productRes.status})`);
  }

  const variantRes = await shopifyRequest(`/variants/${variant.id}.json`, {
    method: "PUT",
    body: JSON.stringify({
      variant: {
        id: variant.id,
        price: item.basePrice,
        barcode: item.barcode || undefined,
        sku: item.barcode || undefined
      }
    })
  });

  if (!variantRes.ok || !variantRes.data?.variant){
    console.log("❌ VARIANT UPDATE ERROR:", variantRes.data);
    throw new Error(`Shopify variant update failed (${variantRes.status})`);
  }

  return {
    ...variant,
    ...variantRes.data.variant,
    product_id: variant.product_id,
    inventory_item_id: variant.inventory_item_id
  };
}

async function upsertProduct(item){
  console.log("📦 SENDING:", item.title, "BARCODE:", item.barcode, "STOCK:", item.stock, "LOCATION:", LOCATION_ID);

  const existingVariant = item.barcode
    ? await findExistingVariantByBarcode(item.barcode)
    : null;

  let variant;

  if (existingVariant){
    console.log("♻️ EXISTING PRODUCT FOUND:", existingVariant.id, item.barcode);
    variant = await updateShopifyProduct(existingVariant, item);
    item.syncAction = "updated";
    upsertVariantInCache(variant);
  } else {
    const createdProduct = await createShopifyProduct(item);
    variant = createdProduct.variants?.[0];
    item.syncAction = "created";
    upsertVariantInCache(variant);
  }

  if (!variant?.inventory_item_id){
    throw new Error("Missing Shopify inventory item id");
  }

  await syncInventoryForVariant(variant, item.stock);
  return variant;
}

// ----------------------------
app.post("/import",(req,res)=>{
  (req.body.items || []).forEach(i=>{
    queue.push({
      id: i.id,
      barcode: i.barcode,
      condition: i.condition || "NM"
      ,
      overrides: i.overrides || null
    });
  });
  res.json({ success:true });
});

app.post("/sync-inventory",(req,res)=>{
  queueInventorySync("manual request");
  res.json({
    success: true,
    sync: {
      ...lastInventorySync,
      running: inventorySyncRunning,
      queued: inventorySyncQueued
    }
  });
});

// ----------------------------
async function processQueue(){
  if (queueProcessing || !queue.length) return;

  queueProcessing = true;
  let job = null;

  try {
    job = queue.shift();
    const data = await fetchRelease(job.id, job.barcode);
    if (!data) return;

    const finalItem = applyItemOverrides(data, job.overrides);
    finalItem.condition = job.condition || "NM";

    try {
      await upsertProduct(finalItem);
      pushHistoryEntry(finalItem);
    } catch (err){
      console.log("❌ IMPORT ERROR:", err.message);
    }
  } finally {
    queueProcessing = false;
  }
}

setInterval(processQueue,1000);

// ----------------------------
app.get("/history",(req,res)=>{
  res.json({ history });
});

app.get("/sync-status",(req,res)=>{
  res.json({
    sync: {
      ...lastInventorySync,
      running: inventorySyncRunning,
      queued: inventorySyncQueued
    }
  });
});

// ----------------------------
app.listen(process.env.PORT||10000,()=>{
  console.log("🚀 CLEAN STABLE BUILD");
  console.log("📍 Inventory location:", LOCATION_ID);
});
