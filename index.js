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
let importStatus = createEmptyImportStatus();
let titleBackfillStatus = createEmptyTitleBackfillStatus();
let tagBackfillStatus = createEmptyTagBackfillStatus();
let manualOverrides = {};
let missingSpreadsheetMatches = [];
let maintenanceJobs = createDefaultMaintenanceJobs();
let spreadsheetState = createDefaultSpreadsheetState();
let barcodeAudit = createEmptyBarcodeAudit();
let lastInventorySync = {
  running: false,
  queued: false,
  lastRunAt: null,
  reason: null,
  summary: null,
  error: null
};
let lastSpreadsheetRefresh = {
  lastRunAt: null,
  source: null,
  rowsRead: 0,
  loadedCount: 0,
  changed: false,
  triggeredSync: false,
  forced: false,
  error: null,
  spreadsheetDelta: {
    seeded: false,
    newBarcodes: []
  },
  autoImport: {
    queued: 0,
    pending: 0
  }
};

const MIN_PRICE = 14.99;
const DEFAULT_LOCATION_ID = 113713512818;
const LOCATION_ID = Number(process.env.SHOPIFY_LOCATION_ID || DEFAULT_LOCATION_ID);
const LOCAL_PRICING_FILE = path.join(__dirname, "pricing.csv");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(DATA_DIR, "history.json");
const MANUAL_OVERRIDES_FILE = process.env.MANUAL_OVERRIDES_FILE || path.join(DATA_DIR, "manual-overrides.json");
const MISSING_MATCHES_FILE = process.env.MISSING_MATCHES_FILE || path.join(DATA_DIR, "missing-matches.json");
const MAINTENANCE_JOBS_FILE = process.env.MAINTENANCE_JOBS_FILE || path.join(DATA_DIR, "maintenance-jobs.json");
const SPREADSHEET_STATE_FILE = process.env.SPREADSHEET_STATE_FILE || path.join(DATA_DIR, "spreadsheet-state.json");
const HISTORY_LIMIT = 60;
const MISSING_MATCH_LIMIT = 120;
const EXCEL_REFRESH_INTERVAL_MS = Math.max(
  0,
  Number(process.env.EXCEL_REFRESH_INTERVAL_MS || 60000)
);
const MAINTENANCE_FAILURE_LIMIT = 25;
const SYNC_TRIGGER_SECRET = String(process.env.SYNC_TRIGGER_SECRET || "").trim();
const MAINTENANCE_CHUNK_SIZE = Math.max(
  5,
  Number(process.env.MAINTENANCE_CHUNK_SIZE || 100)
);
const AUTO_IMPORT_NEW_TITLES = String(process.env.AUTO_IMPORT_NEW_TITLES || "1").trim() !== "0";
const AUTO_IMPORT_MAX_PER_REFRESH = Math.max(
  1,
  Number(process.env.AUTO_IMPORT_MAX_PER_REFRESH || 20)
);
const DEFAULT_VARIANT_WEIGHT_OZ = 25;
const DEFAULT_VARIANT_WEIGHT_UNIT = "oz";
const COLLECTION_TAG_ALLOWLIST = new Set(
  String(process.env.SHOPIFY_COLLECTION_TAGS || "")
    .split(/[,\n]/)
    .map(tag => tag.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean)
);
const DEFAULT_COLLECTION_TAGS = new Map([
  ["rock", "Rock"],
  ["jazz", "Jazz"],
  ["other", "Other"],
  ["r&b", "R&B"],
  ["reggae", "Reggae"],
  ["electronic", "Electronic"],
  ["pop", "Pop"],
  ["hip hop", "Hip Hop"],
  ["country", "Country"],
  ["classical", "Classical"],
  ["metal", "Metal"]
]);
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

function isAuthorizedSyncRequest(req){
  if (!SYNC_TRIGGER_SECRET) return true;

  const authHeader = String(req.get("authorization") || "");
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const headerSecret = String(req.get("x-sync-secret") || "").trim();
  const querySecret = String(req.query?.token || "").trim();
  const bodySecret = String(req.body?.token || "").trim();

  return [
    bearer,
    headerSecret,
    querySecret,
    bodySecret
  ].some(value => value && value === SYNC_TRIGGER_SECRET);
}

function ensureDirForFile(filePath){
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createEmptyImportStatus(){
  return {
    running: false,
    queued: 0,
    inProgress: 0,
    total: 0,
    completed: 0,
    failed: 0,
    startedAt: null,
    lastFinishedAt: null,
    currentTitle: null,
    currentBarcode: null,
    lastError: null
  };
}

function hasActiveImportWork(){
  return queueProcessing || queue.length > 0 || importStatus.inProgress > 0 || importStatus.queued > 0;
}

function beginImportBatch(count){
  if (!count) return;

  if (!hasActiveImportWork()){
    importStatus = {
      ...createEmptyImportStatus(),
      running: true,
      queued: count,
      total: count,
      startedAt: new Date().toISOString()
    };
    return;
  }

  importStatus = {
    ...importStatus,
    running: true,
    queued: importStatus.queued + count,
    total: importStatus.total + count,
    startedAt: importStatus.startedAt || new Date().toISOString()
  };
}

function markImportStarted(job){
  importStatus = {
    ...importStatus,
    running: true,
    queued: Math.max(0, queue.length),
    inProgress: 1,
    currentTitle: null,
    currentBarcode: job?.barcode || null
  };
}

function markImportPrepared(item, job){
  importStatus = {
    ...importStatus,
    currentTitle: item?.title || null,
    currentBarcode: item?.barcode || job?.barcode || null
  };
}

function finalizeImportItem({ ok, error } = {}){
  importStatus = {
    ...importStatus,
    running: queue.length > 0,
    queued: Math.max(0, queue.length),
    inProgress: 0,
    completed: ok ? importStatus.completed + 1 : importStatus.completed,
    failed: ok ? importStatus.failed : importStatus.failed + 1,
    currentTitle: null,
    currentBarcode: null,
    lastError: error || importStatus.lastError
  };

  if (!hasActiveImportWork()){
    importStatus = {
      ...importStatus,
      running: false,
      lastFinishedAt: new Date().toISOString()
    };
  }
}

function getImportStatusSnapshot(){
  const processed = importStatus.completed + importStatus.failed;
  const remaining = Math.max(0, importStatus.total - processed);
  const percent = importStatus.total
    ? Math.round((processed / importStatus.total) * 100)
    : 0;

  return {
    ...importStatus,
    running: hasActiveImportWork(),
    processed,
    remaining,
    percent
  };
}

function createEmptyTitleBackfillStatus(){
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    total: 0,
    scanned: 0,
    matched: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    currentTitle: null,
    currentBarcode: null,
    error: null
  };
}

function createEmptyTagBackfillStatus(){
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    total: 0,
    scanned: 0,
    matched: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    currentTitle: null,
    currentBarcode: null,
    error: null
  };
}

function createEmptyMaintenanceJob(label){
  return {
    label,
    running: false,
    startedAt: null,
    lastRunAt: null,
    finishedAt: null,
    total: 0,
    processed: 0,
    matched: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    currentTitle: null,
    currentBarcode: null,
    lastProductId: null,
    complete: false,
    error: null,
    recentFailures: []
  };
}

function createDefaultMaintenanceJobs(){
  return {
    titles: createEmptyMaintenanceJob("Title Backfill"),
    descriptions: createEmptyMaintenanceJob("Description Backfill"),
    tags: createEmptyMaintenanceJob("Collection Cleanup"),
    standards: createEmptyMaintenanceJob("Cost + Weight Backfill")
  };
}

function createDefaultSpreadsheetState(){
  return {
    knownBarcodes: [],
    pendingAutoImports: [],
    seededAt: null,
    lastSeenAt: null
  };
}

// Barcode audit feature start
function createEmptyBarcodeAudit(){
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    lastRunAt: null,
    totalProducts: 0,
    withBarcode: 0,
    missingBarcode: 0,
    items: [],
    error: null
  };
}

function getBarcodeAuditSnapshot(){
  return {
    ...barcodeAudit,
    items: Array.isArray(barcodeAudit.items) ? barcodeAudit.items : []
  };
}
// Barcode audit feature end

function getTitleBackfillStatusSnapshot(){
  return {
    ...titleBackfillStatus,
    remaining: Math.max(0, titleBackfillStatus.total - titleBackfillStatus.scanned),
    percent: titleBackfillStatus.total
      ? Math.round((titleBackfillStatus.scanned / titleBackfillStatus.total) * 100)
      : 0
  };
}

function getTagBackfillStatusSnapshot(){
  return {
    ...tagBackfillStatus,
    remaining: Math.max(0, tagBackfillStatus.total - tagBackfillStatus.scanned),
    percent: tagBackfillStatus.total
      ? Math.round((tagBackfillStatus.scanned / tagBackfillStatus.total) * 100)
      : 0
  };
}

function getMaintenanceJobSnapshot(job){
  const processed = Number(job?.processed || 0);
  const total = Number(job?.total || 0);
  const remaining = Math.max(0, total - processed);

  return {
    ...job,
    processed,
    remaining,
    percent: total ? Math.round((processed / total) * 100) : 0
  };
}

function getMaintenanceStatusSnapshot(){
  return {
    titles: getMaintenanceJobSnapshot(maintenanceJobs.titles),
    descriptions: getMaintenanceJobSnapshot(maintenanceJobs.descriptions),
    tags: getMaintenanceJobSnapshot(maintenanceJobs.tags),
    standards: getMaintenanceJobSnapshot(maintenanceJobs.standards)
  };
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

function loadJsonFile(filePath, fallback){
  try {
    if (!fs.existsSync(filePath)){
      return fallback;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err){
    console.log("❌ JSON load failed:", path.basename(filePath), err.message);
    return fallback;
  }
}

function writeJsonFile(filePath, value){
  try {
    ensureDirForFile(filePath);
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  } catch (err){
    console.log("❌ JSON save failed:", path.basename(filePath), err.message);
  }
}

function loadManualOverridesFromDisk(){
  const parsed = loadJsonFile(MANUAL_OVERRIDES_FILE, {});
  manualOverrides = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : {};
}

function persistManualOverrides(){
  writeJsonFile(MANUAL_OVERRIDES_FILE, manualOverrides);
}

function loadMissingMatchesFromDisk(){
  const parsed = loadJsonFile(MISSING_MATCHES_FILE, []);
  missingSpreadsheetMatches = Array.isArray(parsed)
    ? parsed
        .filter(item => item && typeof item === "object")
        .slice(0, MISSING_MATCH_LIMIT)
    : [];
}

function persistMissingMatches(){
  writeJsonFile(MISSING_MATCHES_FILE, missingSpreadsheetMatches.slice(0, MISSING_MATCH_LIMIT));
}

function mergeMaintenanceJobState(source, fallback){
  return {
    ...fallback,
    ...(source && typeof source === "object" && !Array.isArray(source) ? source : {})
  };
}

function loadMaintenanceJobsFromDisk(){
  const defaults = createDefaultMaintenanceJobs();
  const parsed = loadJsonFile(MAINTENANCE_JOBS_FILE, {});

  maintenanceJobs = {
    titles: {
      ...mergeMaintenanceJobState(parsed?.titles, defaults.titles),
      running: false,
      currentTitle: null,
      currentBarcode: null
    },
    descriptions: {
      ...mergeMaintenanceJobState(parsed?.descriptions, defaults.descriptions),
      running: false,
      currentTitle: null,
      currentBarcode: null
    },
    tags: {
      ...mergeMaintenanceJobState(parsed?.tags, defaults.tags),
      running: false,
      currentTitle: null,
      currentBarcode: null
    },
    standards: {
      ...mergeMaintenanceJobState(parsed?.standards, defaults.standards),
      running: false,
      currentTitle: null,
      currentBarcode: null
    }
  };
}

function persistMaintenanceJobs(){
  writeJsonFile(MAINTENANCE_JOBS_FILE, maintenanceJobs);
}

function loadSpreadsheetStateFromDisk(){
  const defaults = createDefaultSpreadsheetState();
  const parsed = loadJsonFile(SPREADSHEET_STATE_FILE, defaults);

  spreadsheetState = {
    knownBarcodes: Array.isArray(parsed?.knownBarcodes)
      ? [...new Set(parsed.knownBarcodes.map(normalizeBarcode).filter(Boolean))]
      : defaults.knownBarcodes,
    pendingAutoImports: Array.isArray(parsed?.pendingAutoImports)
      ? [...new Set(parsed.pendingAutoImports.map(normalizeBarcode).filter(Boolean))]
      : defaults.pendingAutoImports,
    seededAt: parsed?.seededAt || null,
    lastSeenAt: parsed?.lastSeenAt || null
  };
}

function persistSpreadsheetState(){
  writeJsonFile(SPREADSHEET_STATE_FILE, spreadsheetState);
}

function getManualOverrideRecord(barcode){
  const candidates = getBarcodeCandidates(barcode);
  for (const candidate of candidates){
    if (manualOverrides[candidate]){
      return manualOverrides[candidate];
    }
  }

  return null;
}

function normalizeStoredOverride(overrides = {}){
  const next = {};

  if (typeof overrides.title === "string" && overrides.title.trim()){
    next.title = overrides.title.trim();
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

  if (typeof overrides.color === "string" && overrides.color.trim()){
    next.color = chooseColor(overrides.color, "");
  }

  ["year", "country", "label", "format"].forEach(field => {
    if (typeof overrides[field] === "string" && overrides[field].trim()){
      next[field] = overrides[field].trim();
    }
  });

  if (typeof overrides.genre === "string" && overrides.genre.trim()){
    next.genre = simplifyGenre(overrides.genre);
  }

  if (typeof overrides.descriptionText === "string" && normalizeTextBlock(overrides.descriptionText)){
    next.descriptionText = normalizeTextBlock(overrides.descriptionText);
  }

  return next;
}

function saveManualOverrides(barcodes, overrides = {}){
  const normalizedOverrides = normalizeStoredOverride(overrides);
  if (!Object.keys(normalizedOverrides).length){
    return null;
  }

  const now = new Date().toISOString();
  const candidates = [...new Set(
    (Array.isArray(barcodes) ? barcodes : [barcodes])
      .flatMap(value => getBarcodeCandidates(value))
      .filter(Boolean)
  )];

  if (!candidates.length){
    return null;
  }

  for (const candidate of candidates){
    const previous = manualOverrides[candidate];
    manualOverrides[candidate] = {
      barcode: candidate,
      fields: {
        ...(previous?.fields || {}),
        ...normalizedOverrides
      },
      savedAt: now
    };
  }

  persistManualOverrides();
  return normalizedOverrides;
}

function removeMissingSpreadsheetMatch(barcode){
  const candidates = new Set(getBarcodeCandidates(barcode));
  if (!candidates.size) return false;

  const next = missingSpreadsheetMatches.filter(item => !candidates.has(normalizeBarcode(item.barcode)));
  const changed = next.length !== missingSpreadsheetMatches.length;
  if (changed){
    missingSpreadsheetMatches = next;
    persistMissingMatches();
  }

  return changed;
}

function recordMissingSpreadsheetMatch(entry = {}){
  const barcode = normalizeBarcode(entry.barcode);
  if (!barcode) return;

  const now = new Date().toISOString();
  const index = missingSpreadsheetMatches.findIndex(item => normalizeBarcode(item.barcode) === barcode);
  const nextItem = {
    barcode,
    title: String(entry.title || "").trim() || "Untitled release",
    reason: String(entry.reason || "Spreadsheet match missing").trim(),
    seenCount: (index >= 0 ? Number(missingSpreadsheetMatches[index].seenCount || 0) : 0) + 1,
    firstSeenAt: index >= 0 ? missingSpreadsheetMatches[index].firstSeenAt || now : now,
    lastSeenAt: now,
    manualOverrideSaved: Boolean(entry.manualOverrideSaved)
  };

  if (index >= 0){
    missingSpreadsheetMatches[index] = {
      ...missingSpreadsheetMatches[index],
      ...nextItem
    };
  } else {
    missingSpreadsheetMatches.unshift(nextItem);
  }

  missingSpreadsheetMatches = missingSpreadsheetMatches
    .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))
    .slice(0, MISSING_MATCH_LIMIT);
  persistMissingMatches();
}

function hasQueuedImportForBarcode(barcode){
  const candidates = new Set(getBarcodeCandidates(barcode));
  if (!candidates.size) return false;

  return queue.some(job =>
    getBarcodeCandidates(job?.barcode).some(candidate => candidates.has(candidate))
  ) || candidates.has(normalizeBarcode(importStatus.currentBarcode));
}

function removePendingAutoImport(barcode){
  const candidates = new Set(getBarcodeCandidates(barcode));
  if (!candidates.size) return false;

  const nextPending = spreadsheetState.pendingAutoImports.filter(
    item => !candidates.has(normalizeBarcode(item))
  );
  const changed = nextPending.length !== spreadsheetState.pendingAutoImports.length;

  if (changed){
    spreadsheetState = {
      ...spreadsheetState,
      pendingAutoImports: nextPending
    };
    persistSpreadsheetState();
  }

  return changed;
}

function updateSpreadsheetState(nextDataMap){
  const currentBarcodes = Object.keys(nextDataMap);
  const now = new Date().toISOString();

  if (!spreadsheetState.seededAt){
    spreadsheetState = {
      ...spreadsheetState,
      knownBarcodes: currentBarcodes,
      pendingAutoImports: spreadsheetState.pendingAutoImports.filter(barcode =>
        currentBarcodes.includes(barcode)
      ),
      seededAt: now,
      lastSeenAt: now
    };
    persistSpreadsheetState();
    return {
      seeded: true,
      newBarcodes: []
    };
  }

  const knownSet = new Set(spreadsheetState.knownBarcodes);
  const newBarcodes = currentBarcodes.filter(barcode => !knownSet.has(barcode));
  const pending = [
    ...spreadsheetState.pendingAutoImports.filter(barcode => currentBarcodes.includes(barcode)),
    ...newBarcodes
  ];

  spreadsheetState = {
    ...spreadsheetState,
    knownBarcodes: currentBarcodes,
    pendingAutoImports: [...new Set(pending)],
    lastSeenAt: now
  };
  persistSpreadsheetState();

  return {
    seeded: false,
    newBarcodes
  };
}

function queuePendingSpreadsheetImports(sourceMap = dataMap){
  if (!AUTO_IMPORT_NEW_TITLES){
    return {
      queued: 0,
      pending: spreadsheetState.pendingAutoImports.length
    };
  }

  const jobsToQueue = [];

  for (const barcode of spreadsheetState.pendingAutoImports){
    if (jobsToQueue.length >= AUTO_IMPORT_MAX_PER_REFRESH){
      break;
    }

    const match = sourceMap[barcode];
    if (!match || Number(match.stock || 0) <= 0){
      continue;
    }

    if (hasQueuedImportForBarcode(barcode)){
      continue;
    }

    jobsToQueue.push({
      barcode,
      condition: "M",
      source: "spreadsheet-auto-import",
      overrides: null
    });
  }

  if (jobsToQueue.length){
    beginImportBatch(jobsToQueue.length);
    queue.push(...jobsToQueue);
    importStatus = {
      ...importStatus,
      queued: queue.length
    };
    console.log("🆕 AUTO-IMPORT QUEUED:", jobsToQueue.length, "new spreadsheet title(s)");
  }

  return {
    queued: jobsToQueue.length,
    pending: spreadsheetState.pendingAutoImports.length
  };
}

function getSpreadsheetRefreshSnapshot(){
  return {
    ...lastSpreadsheetRefresh,
    pollingEnabled: EXCEL_REFRESH_INTERVAL_MS > 0,
    pollingIntervalMs: EXCEL_REFRESH_INTERVAL_MS,
    knownBarcodes: spreadsheetState.knownBarcodes.length,
    pendingAutoImports: spreadsheetState.pendingAutoImports.length,
    baselineAt: spreadsheetState.seededAt,
    lastSheetSeenAt: spreadsheetState.lastSeenAt
  };
}

function startOfTodayIso(){
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString();
}

function isToday(value){
  if (!value) return false;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())){
    return false;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

function getDailyDigestSnapshot(){
  const todayHistory = history.filter(item => isToday(item.syncedAt));
  const createdToday = todayHistory.filter(item => item.syncAction === "created").length;
  const updatedToday = todayHistory.filter(item => item.syncAction === "updated").length;
  const missingToday = missingSpreadsheetMatches.filter(item => isToday(item.lastSeenAt)).length;
  const spreadsheet = getSpreadsheetRefreshSnapshot();
  const maintenance = getMaintenanceStatusSnapshot();
  const maintenanceRunCount = Object.values(maintenance).filter(job => isToday(job.lastRunAt)).length;

  return {
    todayStart: startOfTodayIso(),
    imports: {
      total: todayHistory.length,
      created: createdToday,
      updated: updatedToday
    },
    spreadsheet: {
      lastCheckedAt: spreadsheet.lastRunAt,
      loadedCount: spreadsheet.loadedCount || 0,
      newBarcodesFound: Array.isArray(spreadsheet.spreadsheetDelta?.newBarcodes)
        ? spreadsheet.spreadsheetDelta.newBarcodes.length
        : 0,
      autoImportQueued: Number(spreadsheet.autoImport?.queued || 0),
      pendingAutoImports: Number(spreadsheet.pendingAutoImports || 0)
    },
    review: {
      waiting: missingSpreadsheetMatches.length,
      seenToday: missingToday
    },
    inventory: {
      lastRunAt: lastInventorySync.lastRunAt,
      matched: Number(lastInventorySync.summary?.matched || 0),
      updated: Number(lastInventorySync.summary?.updated || 0),
      failed: Number(lastInventorySync.summary?.failed || 0)
    },
    maintenance: {
      ranToday: maintenanceRunCount,
      active: Object.values(maintenance).filter(job => job.running).length
    }
  };
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

// ----------------------------
// BCM description feature start
function buildCatalogNumber(release){
  return String(release?.labels?.[0]?.catno || "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildIdentifierSummary(release){
  const parts = (release?.identifiers || [])
    .map(identifier => {
      const type = String(identifier?.type || "").trim();
      const value = String(identifier?.value || "").replace(/\s+/g, " ").trim();
      if (!type || !value) return "";
      return `${type}: ${value}`;
    })
    .filter(Boolean);

  return parts[0] || "";
}

function extractDiscogsBarcode(release){
  const identifiers = Array.isArray(release?.identifiers) ? release.identifiers : [];
  const ranked = [];

  const pushCandidate = (rawValue, priority, sourceLabel) => {
    const clean = normalizeBarcode(rawValue);
    if (!clean) return;
    if (clean.length < 8 || clean.length > 14) return;
    ranked.push({
      clean,
      priority,
      sourceLabel
    });
  };

  if (release?.barcode){
    pushCandidate(release.barcode, 0, "release.barcode");
  }

  identifiers.forEach((identifier, index) => {
    const type = String(identifier?.type || "").trim();
    const description = String(identifier?.description || "").trim();
    const value = String(identifier?.value || "").trim();
    const tag = `${type} ${description}`.toLowerCase();

    if (!value) return;

    if (tag.includes("barcode") || tag.includes("upc") || tag.includes("ean")){
      pushCandidate(value, 0, `identifier:${index}`);
      return;
    }

    if (/(matrix|runout|sid|rights society|label code|other)/i.test(tag)){
      return;
    }

    pushCandidate(value, 2, `identifier:${index}`);
  });

  ranked.sort((a, b) => a.priority - b.priority);
  return ranked[0]?.clean || "";
}

function buildPressingDetails(release, color, catalogNumber){
  const pieces = [];
  const colorLabel = titleCaseWords(color || "");
  const formatDetails = (release?.formats || [])
    .flatMap(format => format?.descriptions || [])
    .map(value => String(value || "").trim())
    .filter(Boolean);

  if (colorLabel){
    pieces.push(`${colorLabel} vinyl`);
  }

  formatDetails.forEach(detail => {
    if (!pieces.some(existing => existing.toLowerCase() === detail.toLowerCase())){
      pieces.push(detail);
    }
  });

  if (catalogNumber){
    pieces.push(`Catalog #${catalogNumber}`);
  }

  if (!pieces.length){
    return "Pressing details: See notes / verify before listing";
  }

  return pieces.join(" • ");
}

function pickHighlightTracks(tracklist = []){
  const blacklist = /\b(intro|interlude|skit|outro|reprise|spoken word)\b/i;
  const picks = [];

  for (const track of tracklist){
    const title = String(track?.title || "").trim();
    if (!title || blacklist.test(title)) continue;
    if (!picks.includes(title)){
      picks.push(title);
    }
    if (picks.length >= 2){
      break;
    }
  }

  return picks;
}

function escapeHtmlAttribute(value){
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pickGenreLead(item){
  const values = [
    item?.genre,
    ...(item?.discogsGenres || []),
    ...(item?.discogsStyles || [])
  ]
    .map(value => String(value || "").trim())
    .filter(Boolean);

  return values[0] || "vinyl";
}

function chooseIndefiniteArticle(value){
  const text = String(value || "").trim();
  if (!text) return "a";

  if (/^(r&b|honest|heir|hour)/i.test(text)){
    return "an";
  }

  return /^[aeiou]/i.test(text) ? "an" : "a";
}

function buildEraPhrase(year){
  const numericYear = Number(year || 0);
  if (!numericYear) return "its era";

  const decade = Math.floor(numericYear / 10) * 10;
  if (!decade) return String(year || "");

  return `the ${decade}s`;
}

function buildCollectorPhrase(item){
  const pressing = String(item?.pressingDetails || "").toLowerCase();

  if (/(limited|numbered|colored|colour|vinyl|reissue|edition)/i.test(pressing)){
    return "the kind of pressing collectors like to grab before it disappears";
  }

  if (/2lp|gatefold|deluxe/i.test(pressing)){
    return "a strong shelf pick when you want something with a little extra collector appeal";
  }

  return "an easy one to keep in the front bin for the right listener";
}

function buildBcmBlurb(item){
  const genreLead = pickGenreLead(item);
  const eraPhrase = buildEraPhrase(item?.year);
  const collectorPhrase = buildCollectorPhrase(item);
  const article = chooseIndefiniteArticle(genreLead);

  return `${article} ${genreLead.toLowerCase()} record with all the pull of ${eraPhrase}, and it feels like ${collectorPhrase}`;
}

function buildTrackParagraph(highlights){
  if (!highlights.length){
    return "";
  }

  const rendered = highlights
    .slice(0, 2)
    .map(title => `<strong>&ldquo;${escapeHtml(title)}&rdquo;</strong>`);

  const joined = rendered.length === 2
    ? `${rendered[0]} and ${rendered[1]}`
    : rendered[0];

  return `<p>Standout tracks include ${joined}, making this a great pick for fans, collectors, and anyone who loves a front-to-back listen.</p>`;
}

function buildBcmDescriptionHtml(item){
  const pressingLine = item.pressingDetails || "Pressing details: See notes / verify before listing";
  const highlights = Array.isArray(item.trackHighlights) ? item.trackHighlights : [];

  return [
    `<p><strong>${escapeHtml(item.artistName)} – ${escapeHtml(item.releaseName)}</strong> is ${escapeHtml(buildBcmBlurb(item))}.</p>`,
    buildTrackParagraph(highlights),
    `<ul>
  <li><strong>Artist:</strong> ${escapeHtml(item.artistName)}</li>
  <li><strong>Album:</strong> ${escapeHtml(item.releaseName)}</li>
  <li><strong>Label:</strong> ${escapeHtml(item.label || "Unknown")}</li>
  <li><strong>Year:</strong> ${escapeHtml(item.year || "Unknown")}</li>
  <li><strong>Country:</strong> ${escapeHtml(item.country || "Unknown")}</li>
  <li><strong>Format:</strong> ${escapeHtml(item.format || "Vinyl")}</li>
  <li><strong>Pressing:</strong> ${escapeHtml(pressingLine)}</li>
  <li><strong>Condition:</strong> New / sealed unless otherwise noted</li>
</ul>`
  ]
    .filter(Boolean)
    .join("\n\n");
}
// BCM description feature end

function extractExtras(str){
  const m = String(str || "").match(/\(.*?\)/g);
  return m ? m.join(" ") : "";
}

function simplifyGenre(val){
  const primaryGenre = String(val || "")
    .split(/[\/,]/)[0]
    .trim();

  return resolveCollectionTag(primaryGenre) || "Other";
}

function normalizeCollectionTagKey(value){
  return String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function resolveCollectionTag(value){
  const key = normalizeCollectionTagKey(value);
  if (!key) return "";

  const canonical = DEFAULT_COLLECTION_TAGS.get(key);
  if (!canonical) return "";

  if (COLLECTION_TAG_ALLOWLIST.size && !COLLECTION_TAG_ALLOWLIST.has(normalizeCollectionTagKey(canonical))){
    return "";
  }

  return canonical;
}

function buildShopifyTags(item){
  return resolveCollectionTag(item?.genre) || "Other";
}

function cleanDiscogsArtistName(value){
  return String(value || "")
    .replace(/\s+\(\d+\)\s*$/u, "")
    .trim();
}

function titleCaseWords(value){
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function buildShopifyReleaseTitle(artist, releaseTitle, color){
  const baseTitle = [artist, releaseTitle]
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .join(" - ");
  const cleanColor = String(color || "").trim().toLowerCase();

  if (!cleanColor){
    return baseTitle;
  }

  const colorLabel = titleCaseWords(cleanColor);
  const lowerBase = baseTitle.toLowerCase();

  if (
    lowerBase.includes(`[${cleanColor}]`) ||
    lowerBase.includes(`(${cleanColor})`)
  ){
    return baseTitle;
  }

  return `${baseTitle} [${colorLabel}]`;
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
  const hasExplicitTitle = typeof overrides.title === "string" && overrides.title.trim();

  if (hasExplicitTitle){
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

  ["year", "country", "label", "format"].forEach(field => {
    if (typeof overrides[field] === "string"){
      next[field] = overrides[field].trim();
    }
  });

  if (typeof overrides.genre === "string"){
    next.genre = simplifyGenre(overrides.genre);
  }

  if (typeof overrides.color === "string"){
    next.color = chooseColor(overrides.color, next.color);
    if (!hasExplicitTitle && next.artistName && next.releaseName){
      next.title = buildShopifyReleaseTitle(next.artistName, next.releaseName, next.color);
    }
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

function calculateMarketPrice(lowestPrice){
  const marketFloor = Number.parseFloat(lowestPrice);
  if (!Number.isFinite(marketFloor) || marketFloor <= 0){
    return MIN_PRICE.toFixed(2);
  }

  let price = Math.ceil(marketFloor) - 0.01;
  if (price < MIN_PRICE){
    price = MIN_PRICE;
  }

  return price.toFixed(2);
}

// ----------------------------
async function loadExcel(options = {}){
  const {
    syncReason = "spreadsheet refresh",
    forceInventorySync = false,
    skipInventorySync = false
  } = options;

  console.log("🔄 Loading Excel...");
  try {
    let wb;
    let source = "unknown";

    if (process.env.CSV_URL){
      const res = await fetch(process.env.CSV_URL);
      if (!res.ok){
        console.log("❌ Excel fetch failed:", res.status);
        return {
          ok: false,
          source: "csv_url",
          error: `Spreadsheet fetch failed (${res.status})`
        };
      }

      const buffer = await res.arrayBuffer();
      wb = XLSX.read(buffer, { type: "buffer" });
      source = "csv_url";
      console.log("🌐 Loaded spreadsheet from CSV_URL");
    } else if (fs.existsSync(LOCAL_PRICING_FILE)) {
      wb = XLSX.readFile(LOCAL_PRICING_FILE);
      source = "local_file";
      console.log("📄 Loaded local pricing.csv");
    } else {
      console.log("❌ CSV_URL missing and pricing.csv not found");
      return {
        ok: false,
        source: "missing",
        error: "CSV_URL missing and pricing.csv not found"
      };
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

    const loadedCount = Object.keys(dataMap).length;
    console.log("✅ Excel Loaded:", loadedCount);
    const spreadsheetDelta = updateSpreadsheetState(nextDataMap);
    if (spreadsheetDelta.seeded){
      console.log("🧭 Spreadsheet baseline saved:", loadedCount, "known barcodes");
    } else if (spreadsheetDelta.newBarcodes.length){
      console.log("🆕 New spreadsheet barcodes detected:", spreadsheetDelta.newBarcodes.length);
    }
    const autoImport = queuePendingSpreadsheetImports(nextDataMap);

    const nextSignature = buildInventorySignature(nextDataMap);
    const changed = nextSignature !== lastInventorySignature;
    if (changed){
      lastInventorySignature = nextSignature;
    }

    let triggeredSync = false;
    if (!skipInventorySync && (forceInventorySync || changed)){
      queueInventorySync(syncReason);
      triggeredSync = true;
    } else if (skipInventorySync){
      console.log("⏭️ Inventory sync skipped: refresh requested without sync");
    } else {
      console.log("⏭️ Inventory sync skipped: spreadsheet stock unchanged");
    }

    lastSpreadsheetRefresh = {
      lastRunAt: new Date().toISOString(),
      source,
      rowsRead: rows.length,
      loadedCount,
      changed,
      triggeredSync,
      forced: forceInventorySync,
      error: null,
      spreadsheetDelta,
      autoImport
    };

    return {
      ok: true,
      source,
      rowsRead: rows.length,
      loadedCount,
      spreadsheetDelta,
      autoImport,
      changed,
      triggeredSync,
      forced: forceInventorySync
    };

  } catch (e){
    console.log("❌ Excel load failed:", e.message);
    lastSpreadsheetRefresh = {
      ...lastSpreadsheetRefresh,
      lastRunAt: new Date().toISOString(),
      error: e.message
    };
    return {
      ok: false,
      source: "error",
      error: e.message
    };
  }
}

void loadExcel();
if (EXCEL_REFRESH_INTERVAL_MS > 0){
  setInterval(() => {
    void loadExcel();
  }, EXCEL_REFRESH_INTERVAL_MS);
} else {
  console.log("⏸️ Spreadsheet polling disabled");
}
loadHistoryFromDisk();
loadManualOverridesFromDisk();
loadMissingMatchesFromDisk();
loadMaintenanceJobsFromDisk();
loadSpreadsheetStateFromDisk();

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

// Barcode repair feature start
function stripShopifyTitleSuffix(title){
  return String(title || "")
    .replace(/\s*\[[^\]]+\]\s*$/g, "")
    .trim();
}

function parseShopifyTitleForDiscogsSearch(title){
  const cleanTitle = stripShopifyTitleSuffix(title);
  const parts = cleanTitle.split(/\s+-\s+/).map(value => value.trim()).filter(Boolean);

  if (parts.length >= 2){
    return {
      artist: parts.shift() || "",
      releaseTitle: parts.join(" - "),
      query: cleanTitle
    };
  }

  return {
    artist: "",
    releaseTitle: cleanTitle,
    query: cleanTitle
  };
}

async function searchDiscogsByTitle(title){
  const parsed = parseShopifyTitleForDiscogsSearch(title);
  const params = new URLSearchParams({
    token: process.env.DISCOGS_TOKEN,
    type: "release",
    format: "Vinyl"
  });

  if (parsed.artist && parsed.releaseTitle){
    params.set("artist", parsed.artist);
    params.set("release_title", parsed.releaseTitle);
  } else if (parsed.query){
    params.set("q", parsed.query);
  } else {
    return [];
  }

  const data = await safeFetch(
    `https://api.discogs.com/database/search?${params.toString()}`
  );

  if (data.__failed){
    throw new Error(
      data.__status === 429
        ? "Discogs is rate-limiting repair lookups right now. Please retry in a moment."
        : `Discogs title search failed: ${data.message}`
    );
  }

  return (data.results || []).slice(0, 5);
}
// Barcode repair feature end

function parseDiscogsLookupInput(input){
  const raw = String(input || "").trim();
  if (!raw){
    return {
      kind: "unknown",
      value: ""
    };
  }

  const releaseUrlMatch = raw.match(/discogs\.com\/release\/(\d+)/i);
  if (releaseUrlMatch){
    return {
      kind: "release_id",
      value: releaseUrlMatch[1]
    };
  }

  const prefixedReleaseMatch = raw.match(/^(?:r|release[:#\s-]*)(\d+)$/i);
  if (prefixedReleaseMatch){
    return {
      kind: "release_id",
      value: prefixedReleaseMatch[1]
    };
  }

  const digits = raw.replace(/\D/g, "");
  if (!digits){
    return {
      kind: "unknown",
      value: raw
    };
  }

  return {
    kind: digits.length >= 11 ? "barcode" : "release_id",
    value: digits
  };
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
  const catalogNumber = buildCatalogNumber(r);
  const format = formatDiscogsFormat(r.formats);
  const releaseBarcode = extractDiscogsBarcode(r);
  const resolvedBarcode = normalizeBarcode(barcode) || releaseBarcode;
  const match = findMatch(resolvedBarcode);
  const manualOverride = !match ? getManualOverrideRecord(resolvedBarcode) : null;
  const marketPrice = calculateMarketPrice(r.lowest_price);
  const spreadsheetColor = String(match?.color || "").trim().toLowerCase();
  const discogsColor = detectColor(
    title,
    format,
    r.notes,
    (r.formats || []).flatMap(entry => entry.descriptions || []),
    (r.styles || []).join(" ")
  );
  const finalColor = chooseColor(spreadsheetColor, discogsColor);
  const pressingDetails = buildPressingDetails(r, finalColor, catalogNumber);
  const identifierSummary = buildIdentifierSummary(r);
  const trackHighlights = pickHighlightTracks(r.tracklist);
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

  const baseItem = {
    id,
    barcode: resolvedBarcode,
    artistName: artist,
    releaseName: title,
    title: buildShopifyReleaseTitle(artist, title, finalColor),
    description,
    descriptionText,
    image: r.images?.[0]?.uri || "",
    basePrice: match ? calculatePrice(match?.cost) : marketPrice,
    cost: Number.isFinite(Number(match?.cost)) && Number(match?.cost) > 0
      ? Number(match.cost).toFixed(2)
      : null,
    stock: match ? (match.stock ?? 0) : 1,
    year,
    country,
    label,
    catalogNumber,
    format,
    genre: match?.genre || "Other",
    color: finalColor,
    pressingDetails,
    identifierSummary,
    trackHighlights,
    discogsGenres: (r.genres || []).map(value => String(value || "").trim()).filter(Boolean),
    discogsStyles: (r.styles || []).map(value => String(value || "").trim()).filter(Boolean),
    reviewFlags: {
      fallbackBlack: finalColor === "black" && spreadsheetColor !== "black" && discogsColor !== "black",
      explicitBlack: finalColor === "black" && (spreadsheetColor === "black" || discogsColor === "black"),
      missingBarcode: !resolvedBarcode,
      barcodeMismatch: false,
      similarOptions: false
    },
    reviewReasons: [],
    sourceMeta: {
      spreadsheetMatched: Boolean(match),
      manualOverrideApplied: Boolean(manualOverride),
      manualOverrideSavedAt: manualOverride?.savedAt || null,
      priceSource: match ? "spreadsheet" : "discogs_market",
      marketLowestPrice: Number.parseFloat(r.lowest_price) || null,
      marketForSale: Number.parseInt(r.num_for_sale, 10) || 0,
      marketBlocked: Boolean(r.blocked_from_sale)
    }
  };

  if (match){
    removeMissingSpreadsheetMatch(resolvedBarcode);
  } else {
    console.log("⚠️ NO EXCEL MATCH:", resolvedBarcode);
  }

  const finalItem = manualOverride?.fields
    ? applyItemOverrides(baseItem, manualOverride.fields)
    : baseItem;

  if (!match){
    recordMissingSpreadsheetMatch({
      barcode: resolvedBarcode,
      title: finalItem.title,
      reason: "Missing spreadsheet data, using Discogs market pricing",
      manualOverrideSaved: Boolean(manualOverride?.fields)
    });
  }

  return finalItem;
}

async function findBestReleaseForBarcode(barcode, maxResults = 3){
  const rawResults = await searchDiscogsByBarcode(barcode);
  const prioritizedResults = sortResultsByCountryPreference(rawResults).slice(0, maxResults);

  for (const result of prioritizedResults){
    const full = await fetchRelease(result.id, barcode);
    if (full) return full;
  }

  return null;
}

async function decorateReleaseOptions(options, requestedBarcode = ""){
  const requestedCandidates = getBarcodeCandidates(requestedBarcode);
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

    if (option.reviewFlags?.missingBarcode){
      reviewReasons.push("Discogs did not expose a usable barcode for this release. Add one manually before importing.");
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

async function buildReleaseOptionsForReleaseId(releaseId){
  const numericId = String(releaseId || "").replace(/\D/g, "");
  if (!numericId){
    return [];
  }

  const full = await fetchRelease(numericId, "");
  if (!full){
    return [];
  }

  return await decorateReleaseOptions([full], "");
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

  return await decorateReleaseOptions(options, barcode);
}

async function fetchShopifyProductTitle(productId){
  const res = await shopifyRequest(`/products/${productId}.json?fields=id,title`);
  if (!res.ok || !res.data?.product){
    throw new Error(`Shopify product fetch failed (${res.status})`);
  }

  return res.data.product.title || "";
}

async function fetchShopifyProductMetadata(productId){
  const res = await shopifyRequest(`/products/${productId}.json?fields=id,title,tags,product_type`);
  if (!res.ok || !res.data?.product){
    throw new Error(`Shopify product fetch failed (${res.status})`);
  }

  return res.data.product;
}

async function fetchShopifyProductDescriptionMetadata(productId){
  const res = await shopifyRequest(`/products/${productId}.json?fields=id,title,body_html`);
  if (!res.ok || !res.data?.product){
    throw new Error(`Shopify product fetch failed (${res.status})`);
  }

  return res.data.product;
}

async function fetchShopifyVariantDetails(variantId){
  const res = await shopifyRequest(
    `/variants/${variantId}.json?fields=id,product_id,inventory_item_id,weight,weight_unit,requires_shipping`
  );
  if (!res.ok || !res.data?.variant){
    throw new Error(`Shopify variant fetch failed (${res.status})`);
  }

  return res.data.variant;
}

async function fetchShopifyInventoryItem(inventoryItemId){
  const res = await shopifyRequest(`/inventory_items/${inventoryItemId}.json?fields=id,cost`);
  if (!res.ok || !res.data?.inventory_item){
    throw new Error(`Shopify inventory item fetch failed (${res.status})`);
  }

  return res.data.inventory_item;
}

// Barcode audit feature start
async function fetchShopifyProductSummariesByIds(productIds){
  const ids = [...new Set((productIds || []).map(id => Number(id || 0)).filter(Boolean))];
  if (!ids.length) return [];

  const products = [];

  for (let i = 0; i < ids.length; i += 250){
    const batch = ids.slice(i, i + 250);
    const params = new URLSearchParams({
      ids: batch.join(","),
      limit: String(batch.length),
      fields: "id,title,handle"
    });
    const res = await shopifyRequest(`/products.json?${params.toString()}`);
    if (!res.ok){
      throw new Error(`Shopify product summaries fetch failed (${res.status})`);
    }

    products.push(...(res.data.products || []));

    if (i + 250 < ids.length){
      await sleep(SHOPIFY_REQUEST_DELAY_MS);
    }
  }

  return products;
}

function getShopifyAdminProductUrl(productId){
  const store = String(process.env.SHOPIFY_STORE || "").trim();
  const cleanProductId = Number(productId || 0);
  if (!store || !cleanProductId) return null;
  return `https://${store}/admin/products/${cleanProductId}`;
}

// Barcode repair feature start
function findBarcodeAuditItem(productId){
  const cleanProductId = Number(productId || 0);
  return (barcodeAudit.items || []).find(item => Number(item.productId || 0) === cleanProductId) || null;
}

async function buildBarcodeRepairOptions(productTitle){
  const rawResults = await searchDiscogsByTitle(productTitle);
  const prioritizedResults = sortResultsByCountryPreference(rawResults);
  const options = [];

  for (const result of prioritizedResults){
    const full = await fetchRelease(result.id, "");
    if (full?.barcode){
      options.push(full);
    }
  }

  return await decorateReleaseOptions(options, "");
}

async function updateShopifyVariantBarcode(variantId, barcode){
  const cleanBarcode = normalizeBarcode(barcode);
  if (!cleanBarcode){
    throw new Error("No usable barcode was provided");
  }

  const res = await shopifyRequest(`/variants/${variantId}.json`, {
    method: "PUT",
    body: JSON.stringify({
      variant: {
        id: variantId,
        barcode: cleanBarcode,
        sku: cleanBarcode
      }
    })
  });

  if (!res.ok || !res.data?.variant){
    throw new Error(`Shopify variant barcode update failed (${res.status})`);
  }

  upsertVariantInCache(res.data.variant);
  return res.data.variant;
}
// Barcode repair feature end

async function runBarcodeAudit(){
  if (barcodeAudit.running){
    return getBarcodeAuditSnapshot();
  }

  barcodeAudit = {
    ...createEmptyBarcodeAudit(),
    running: true,
    startedAt: new Date().toISOString(),
    lastRunAt: new Date().toISOString()
  };

  try {
    const variants = await getCachedShopifyVariants(true);
    const productsById = new Map();

    for (const variant of variants){
      const productId = Number(variant.product_id || 0);
      if (!productId) continue;

      const barcode = getVariantBarcode(variant);
      const sku = String(variant.sku || "").trim();
      const current = productsById.get(productId) || {
        productId,
        variantCount: 0,
        variantIds: [],
        hasBarcode: false,
        sampleBarcode: "",
        sampleSku: ""
      };

      current.variantCount += 1;
      current.variantIds.push(Number(variant.id || 0));

      if (barcode && !current.sampleBarcode){
        current.sampleBarcode = barcode;
      }
      if (sku && !current.sampleSku){
        current.sampleSku = sku;
      }
      if (barcode){
        current.hasBarcode = true;
      }

      productsById.set(productId, current);
    }

    const products = [...productsById.values()].sort((a, b) => a.productId - b.productId);
    const missingEntries = products.filter(item => !item.hasBarcode);
    const summaries = await fetchShopifyProductSummariesByIds(missingEntries.map(item => item.productId));
    const summaryMap = new Map(
      summaries.map(product => [Number(product.id || 0), product])
    );

    barcodeAudit = {
      ...barcodeAudit,
      running: false,
      finishedAt: new Date().toISOString(),
      totalProducts: products.length,
      withBarcode: products.length - missingEntries.length,
      missingBarcode: missingEntries.length,
      error: null,
      items: missingEntries.map(item => {
        const product = summaryMap.get(item.productId) || {};
        return {
          productId: item.productId,
          title: product.title || `Product ${item.productId}`,
          handle: product.handle || "",
          sampleSku: item.sampleSku || "",
          sampleBarcode: item.sampleBarcode || "",
          variantCount: item.variantCount,
          variantIds: item.variantIds,
          adminUrl: getShopifyAdminProductUrl(item.productId)
        };
      })
    };
  } catch (err){
    barcodeAudit = {
      ...barcodeAudit,
      running: false,
      finishedAt: new Date().toISOString(),
      error: err.message
    };
    console.log("❌ BARCODE AUDIT FAILED:", err.message);
  }

  return getBarcodeAuditSnapshot();
}
// Barcode audit feature end

async function updateShopifyProductTitle(productId, title){
  const res = await shopifyRequest(`/products/${productId}.json`, {
    method: "PUT",
    body: JSON.stringify({
      product: {
        id: productId,
        title
      }
    })
  });

  if (!res.ok || !res.data?.product){
    throw new Error(`Shopify product title update failed (${res.status})`);
  }

  return res.data.product;
}

async function updateShopifyProductTagsAndType(productId, { tags, productType }){
  const res = await shopifyRequest(`/products/${productId}.json`, {
    method: "PUT",
    body: JSON.stringify({
      product: {
        id: productId,
        tags,
        product_type: productType
      }
    })
  });

  if (!res.ok || !res.data?.product){
    throw new Error(`Shopify product tag update failed (${res.status})`);
  }

  return res.data.product;
}

// ----------------------------
// BCM description feature start
async function updateShopifyProductBodyHtml(productId, bodyHtml){
  const res = await shopifyRequest(`/products/${productId}.json`, {
    method: "PUT",
    body: JSON.stringify({
      product: {
        id: productId,
        body_html: bodyHtml
      }
    })
  });

  if (!res.ok || !res.data?.product){
    throw new Error(`Shopify body_html update failed (${res.status})`);
  }

  return res.data.product;
}

function normalizeBodyHtmlForCompare(value){
  return String(value || "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

function buildBcmDescriptionPayload(item){
  return {
    releaseId: item.id,
    barcode: item.barcode,
    title: item.title,
    artistName: item.artistName,
    releaseName: item.releaseName,
    label: item.label,
    year: item.year,
    country: item.country,
    format: item.format,
    genre: item.genre,
    color: item.color,
    catalogNumber: item.catalogNumber,
    pressingDetails: item.pressingDetails,
    identifierSummary: item.identifierSummary,
    image: item.image,
    reviewReasons: item.reviewReasons || [],
    needsReview: Boolean(item.needsReview),
    trackHighlights: item.trackHighlights || [],
    descriptionHtml: buildBcmDescriptionHtml(item)
  };
}
// BCM description feature end

function resetMaintenanceJob(jobKey){
  const labels = {
    titles: "Title Backfill",
    descriptions: "Description Backfill",
    tags: "Collection Cleanup",
    standards: "Cost + Weight Backfill"
  };
  maintenanceJobs[jobKey] = createEmptyMaintenanceJob(labels[jobKey] || "Maintenance");
  persistMaintenanceJobs();
  return getMaintenanceJobSnapshot(maintenanceJobs[jobKey]);
}

async function buildMaintenanceProductList(){
  const variants = await fetchAllShopifyVariants();
  const seenProductIds = new Set();
  const uniqueProducts = [];

  for (const variant of variants){
    const productId = Number(variant.product_id || 0);
    if (!productId || seenProductIds.has(productId)){
      continue;
    }

    seenProductIds.add(productId);
    uniqueProducts.push({
      productId,
      variantId: Number(variant.id || 0),
      inventoryItemId: Number(variant.inventory_item_id || 0),
      barcode: getVariantBarcode(variant)
    });
  }

  return uniqueProducts.sort((a, b) => a.productId - b.productId);
}

function updateMaintenanceJob(jobKey, changes){
  maintenanceJobs[jobKey] = {
    ...maintenanceJobs[jobKey],
    ...changes
  };
  persistMaintenanceJobs();
}

function recordMaintenanceFailure(jobKey, item, reason, titleOverride = null){
  const failure = {
    productId: Number(item?.productId || 0) || null,
    barcode: item?.barcode || null,
    title: titleOverride || maintenanceJobs[jobKey]?.currentTitle || null,
    reason: String(reason || "Unknown maintenance failure"),
    failedAt: new Date().toISOString()
  };

  updateMaintenanceJob(jobKey, {
    failed: maintenanceJobs[jobKey].failed + 1,
    error: failure.reason,
    recentFailures: [
      failure,
      ...((maintenanceJobs[jobKey].recentFailures || []).filter(existing =>
        !(existing?.productId && failure.productId && Number(existing.productId) === Number(failure.productId))
      ))
    ].slice(0, MAINTENANCE_FAILURE_LIMIT)
  });
}

async function processTitleMaintenanceItem(jobKey, item){
  const bestRelease = await findBestReleaseForBarcode(item.barcode);
  if (!bestRelease){
    recordMaintenanceFailure(jobKey, item, "No Discogs release found for this barcode");
    return;
  }

  updateMaintenanceJob(jobKey, {
    matched: maintenanceJobs[jobKey].matched + 1,
    currentTitle: bestRelease.title
  });

  const currentTitle = await fetchShopifyProductTitle(item.productId);
  if (String(currentTitle || "").trim() === String(bestRelease.title || "").trim()){
    updateMaintenanceJob(jobKey, {
      unchanged: maintenanceJobs[jobKey].unchanged + 1
    });
    return;
  }

  await updateShopifyProductTitle(item.productId, bestRelease.title);
  updateMaintenanceJob(jobKey, {
    updated: maintenanceJobs[jobKey].updated + 1
  });

  console.log("✅ TITLE MAINTENANCE:", item.barcode, "->", bestRelease.title);
}

async function processDescriptionMaintenanceItem(jobKey, item){
  const currentProduct = await fetchShopifyProductDescriptionMetadata(item.productId);
  updateMaintenanceJob(jobKey, {
    currentTitle: currentProduct.title || null
  });

  if (!item.barcode){
    recordMaintenanceFailure(jobKey, item, "Missing Shopify barcode", currentProduct.title || null);
    return;
  }

  const bestRelease = await findBestReleaseForBarcode(item.barcode);
  if (!bestRelease){
    recordMaintenanceFailure(jobKey, item, "No Discogs release found for this barcode", currentProduct.title || null);
    return;
  }

  updateMaintenanceJob(jobKey, {
    matched: maintenanceJobs[jobKey].matched + 1,
    currentTitle: bestRelease.title || currentProduct.title || null
  });

  const desiredBodyHtml = buildBcmDescriptionHtml(bestRelease);
  const currentBodyHtml = normalizeBodyHtmlForCompare(currentProduct.body_html);
  const nextBodyHtml = normalizeBodyHtmlForCompare(desiredBodyHtml);

  if (currentBodyHtml === nextBodyHtml){
    updateMaintenanceJob(jobKey, {
      unchanged: maintenanceJobs[jobKey].unchanged + 1
    });
    return;
  }

  await updateShopifyProductBodyHtml(item.productId, desiredBodyHtml);
  updateMaintenanceJob(jobKey, {
    updated: maintenanceJobs[jobKey].updated + 1
  });

  console.log("✅ DESCRIPTION MAINTENANCE:", item.barcode, "->", bestRelease.title);
}

async function processTagMaintenanceItem(jobKey, item){
  const currentProduct = await fetchShopifyProductMetadata(item.productId);
  updateMaintenanceJob(jobKey, {
    currentTitle: currentProduct.title || null
  });

  const spreadsheetMatch = item.barcode ? findMatch(item.barcode) : null;
  const desiredGenre = resolveCollectionTag(
    spreadsheetMatch?.genre || currentProduct.product_type || ""
  ) || "Other";
  const desiredTags = buildShopifyTags({ genre: desiredGenre });

  updateMaintenanceJob(jobKey, {
    matched: maintenanceJobs[jobKey].matched + 1
  });

  const currentTags = String(currentProduct.tags || "")
    .split(",")
    .map(tag => tag.trim())
    .filter(Boolean)
    .join(", ");
  const currentProductType = String(currentProduct.product_type || "").trim();

  if (currentTags === desiredTags && currentProductType === desiredGenre){
    updateMaintenanceJob(jobKey, {
      unchanged: maintenanceJobs[jobKey].unchanged + 1
    });
    return;
  }

  await updateShopifyProductTagsAndType(item.productId, {
    tags: desiredTags,
    productType: desiredGenre
  });

  updateMaintenanceJob(jobKey, {
    updated: maintenanceJobs[jobKey].updated + 1
  });

  console.log(
    "✅ TAG MAINTENANCE:",
    item.barcode || `product:${item.productId}`,
    "->",
    desiredTags
  );
}

async function processStandardsMaintenanceItem(jobKey, item){
  const currentProduct = await fetchShopifyProductMetadata(item.productId);
  updateMaintenanceJob(jobKey, {
    currentTitle: currentProduct.title || null
  });

  const currentVariant = await fetchShopifyVariantDetails(item.variantId);
  const spreadsheetMatch = item.barcode ? findMatch(item.barcode) : null;
  const desiredCost = Number.isFinite(Number(spreadsheetMatch?.cost)) && Number(spreadsheetMatch?.cost) > 0
    ? Number(spreadsheetMatch.cost).toFixed(2)
    : null;
  const currentWeight = Number.parseFloat(currentVariant.weight);
  const weightNeedsUpdate = !currentVariant.requires_shipping ||
    String(currentVariant.weight_unit || "").toLowerCase() !== DEFAULT_VARIANT_WEIGHT_UNIT ||
    currentWeight !== DEFAULT_VARIANT_WEIGHT_OZ;

  let costNeedsUpdate = false;
  if (desiredCost && currentVariant.inventory_item_id){
    const inventoryItem = await fetchShopifyInventoryItem(currentVariant.inventory_item_id);
    const currentCost = Number.isFinite(Number(inventoryItem.cost))
      ? Number(inventoryItem.cost).toFixed(2)
      : "";
    costNeedsUpdate = currentCost !== desiredCost;
  }

  if (spreadsheetMatch){
    updateMaintenanceJob(jobKey, {
      matched: maintenanceJobs[jobKey].matched + 1
    });
  }

  if (!weightNeedsUpdate && !costNeedsUpdate){
    updateMaintenanceJob(jobKey, {
      unchanged: maintenanceJobs[jobKey].unchanged + 1
    });
    return;
  }

  if (weightNeedsUpdate){
    const variantRes = await shopifyRequest(`/variants/${currentVariant.id}.json`, {
      method: "PUT",
      body: JSON.stringify({
        variant: {
          id: currentVariant.id,
          ...buildVariantWeightPayload()
        }
      })
    });

    if (!variantRes.ok || !variantRes.data?.variant){
      throw new Error(`Shopify variant standards update failed (${variantRes.status})`);
    }
  }

  if (costNeedsUpdate && currentVariant.inventory_item_id){
    await updateInventoryItemCost(currentVariant.inventory_item_id, desiredCost);
  }

  updateMaintenanceJob(jobKey, {
    updated: maintenanceJobs[jobKey].updated + 1
  });

  console.log(
    "✅ STANDARDS MAINTENANCE:",
    item.barcode || `product:${item.productId}`,
    "weight",
    `${DEFAULT_VARIANT_WEIGHT_OZ}${DEFAULT_VARIANT_WEIGHT_UNIT}`,
    desiredCost ? `cost ${desiredCost}` : "cost unchanged"
  );
}

async function runMaintenanceChunk(jobKey){
  const currentJob = maintenanceJobs[jobKey];
  if (!currentJob){
    throw new Error("Unknown maintenance job");
  }

  if (currentJob.running){
    return getMaintenanceJobSnapshot(currentJob);
  }

  updateMaintenanceJob(jobKey, {
    running: true,
    startedAt: currentJob.startedAt || new Date().toISOString(),
    lastRunAt: new Date().toISOString(),
    finishedAt: null,
    complete: false,
    currentTitle: null,
    currentBarcode: null,
    error: null
  });

  try {
    if (jobKey === "tags" || jobKey === "standards"){
      const refresh = await loadExcel({
        syncReason: jobKey === "tags"
          ? "maintenance tag refresh"
          : "maintenance standards refresh",
        forceInventorySync: false,
        skipInventorySync: true
      });

      if (!refresh?.ok){
        throw new Error(
          refresh?.error || (
            jobKey === "tags"
              ? "Spreadsheet refresh failed before collection cleanup"
              : "Spreadsheet refresh failed before cost and weight backfill"
          )
        );
      }
    }

    const products = await buildMaintenanceProductList();
    const lastProductId = Number(maintenanceJobs[jobKey].lastProductId || 0);
    const startIndex = lastProductId
      ? products.findIndex(item => item.productId > lastProductId)
      : 0;
    const normalizedStartIndex = startIndex === -1 ? products.length : startIndex;
    const chunk = products.slice(normalizedStartIndex, normalizedStartIndex + MAINTENANCE_CHUNK_SIZE);

    updateMaintenanceJob(jobKey, {
      total: products.length
    });

    if (!chunk.length){
      updateMaintenanceJob(jobKey, {
        running: false,
        complete: true,
        finishedAt: new Date().toISOString(),
        currentTitle: null,
        currentBarcode: null
      });
      return getMaintenanceJobSnapshot(maintenanceJobs[jobKey]);
    }

    for (const item of chunk){
      updateMaintenanceJob(jobKey, {
        currentBarcode: item.barcode || null,
        currentTitle: null
      });

      try {
        if (jobKey === "titles"){
          await processTitleMaintenanceItem(jobKey, item);
        } else if (jobKey === "descriptions"){
          await processDescriptionMaintenanceItem(jobKey, item);
        } else if (jobKey === "tags"){
          await processTagMaintenanceItem(jobKey, item);
        } else if (jobKey === "standards"){
          await processStandardsMaintenanceItem(jobKey, item);
        }
      } catch (err){
        recordMaintenanceFailure(jobKey, item, err.message, maintenanceJobs[jobKey].currentTitle);
        console.log(`❌ ${jobKey.toUpperCase()} MAINTENANCE ERROR:`, item.barcode || item.productId, err.message);
      }

      updateMaintenanceJob(jobKey, {
        processed: maintenanceJobs[jobKey].processed + 1,
        lastProductId: item.productId
      });

      await sleep(SHOPIFY_REQUEST_DELAY_MS);
    }

    const completed = maintenanceJobs[jobKey].processed >= products.length;
    updateMaintenanceJob(jobKey, {
      running: false,
      complete: completed,
      finishedAt: completed ? new Date().toISOString() : null,
      currentTitle: null,
      currentBarcode: null
    });
  } catch (err){
    updateMaintenanceJob(jobKey, {
      running: false,
      currentTitle: null,
      currentBarcode: null,
      error: err.message
    });
    console.log(`❌ ${jobKey.toUpperCase()} MAINTENANCE FAILED:`, err.message);
  }

  return getMaintenanceJobSnapshot(maintenanceJobs[jobKey]);
}

async function runTitleBackfill(){
  if (titleBackfillStatus.running){
    return getTitleBackfillStatusSnapshot();
  }

  titleBackfillStatus = {
    ...createEmptyTitleBackfillStatus(),
    running: true,
    startedAt: new Date().toISOString()
  };

  try {
    console.log("📝 Title backfill started");

    const variants = await fetchAllShopifyVariants();
    const uniqueProducts = [];
    const seenProductIds = new Set();

    for (const variant of variants){
      const barcode = getVariantBarcode(variant);
      if (!barcode || seenProductIds.has(String(variant.product_id))){
        continue;
      }

      seenProductIds.add(String(variant.product_id));
      uniqueProducts.push({
        productId: variant.product_id,
        barcode
      });
    }

    titleBackfillStatus = {
      ...titleBackfillStatus,
      total: uniqueProducts.length
    };

    for (const item of uniqueProducts){
      titleBackfillStatus = {
        ...titleBackfillStatus,
        scanned: titleBackfillStatus.scanned + 1,
        currentBarcode: item.barcode,
        currentTitle: null
      };

      try {
        const bestRelease = await findBestReleaseForBarcode(item.barcode);
        if (!bestRelease){
          titleBackfillStatus = {
            ...titleBackfillStatus,
            failed: titleBackfillStatus.failed + 1
          };
          continue;
        }

        titleBackfillStatus = {
          ...titleBackfillStatus,
          matched: titleBackfillStatus.matched + 1,
          currentTitle: bestRelease.title
        };

        const currentTitle = await fetchShopifyProductTitle(item.productId);
        if (String(currentTitle || "").trim() === String(bestRelease.title || "").trim()){
          titleBackfillStatus = {
            ...titleBackfillStatus,
            unchanged: titleBackfillStatus.unchanged + 1
          };
          continue;
        }

        await updateShopifyProductTitle(item.productId, bestRelease.title);
        titleBackfillStatus = {
          ...titleBackfillStatus,
          updated: titleBackfillStatus.updated + 1
        };

        console.log("✅ TITLE BACKFILL:", item.barcode, "->", bestRelease.title);
      } catch (err){
        titleBackfillStatus = {
          ...titleBackfillStatus,
          failed: titleBackfillStatus.failed + 1,
          error: err.message
        };
        console.log("❌ TITLE BACKFILL ERROR:", item.barcode, err.message);
      }

      await sleep(SHOPIFY_REQUEST_DELAY_MS);
    }
  } catch (err){
    titleBackfillStatus = {
      ...titleBackfillStatus,
      error: err.message
    };
    console.log("❌ TITLE BACKFILL FAILED:", err.message);
  } finally {
    titleBackfillStatus = {
      ...titleBackfillStatus,
      running: false,
      currentTitle: null,
      currentBarcode: null,
      finishedAt: new Date().toISOString()
    };
  }

  return getTitleBackfillStatusSnapshot();
}

async function runTagBackfill(){
  if (tagBackfillStatus.running){
    return getTagBackfillStatusSnapshot();
  }

  tagBackfillStatus = {
    ...createEmptyTagBackfillStatus(),
    running: true,
    startedAt: new Date().toISOString()
  };

  try {
    console.log("🏷️ Tag backfill started");

    const refresh = await loadExcel({
      syncReason: "tag backfill refresh",
      forceInventorySync: false
    });

    if (!refresh?.ok){
      throw new Error(refresh?.error || "Spreadsheet refresh failed before tag backfill");
    }

    const variants = await fetchAllShopifyVariants();
    const uniqueProducts = [];
    const seenProductIds = new Set();

    for (const variant of variants){
      if (seenProductIds.has(String(variant.product_id))){
        continue;
      }

      seenProductIds.add(String(variant.product_id));
      uniqueProducts.push({
        productId: variant.product_id,
        barcode: getVariantBarcode(variant)
      });
    }

    tagBackfillStatus = {
      ...tagBackfillStatus,
      total: uniqueProducts.length
    };

    for (const item of uniqueProducts){
      tagBackfillStatus = {
        ...tagBackfillStatus,
        scanned: tagBackfillStatus.scanned + 1,
        currentBarcode: item.barcode || null,
        currentTitle: null
      };

      try {
        const currentProduct = await fetchShopifyProductMetadata(item.productId);
        tagBackfillStatus = {
          ...tagBackfillStatus,
          currentTitle: currentProduct.title || null
        };

        const spreadsheetMatch = item.barcode ? findMatch(item.barcode) : null;
        const desiredGenre = resolveCollectionTag(
          spreadsheetMatch?.genre || currentProduct.product_type || ""
        ) || "Other";
        const desiredTags = buildShopifyTags({ genre: desiredGenre });

        if (!desiredTags){
          tagBackfillStatus = {
            ...tagBackfillStatus,
            failed: tagBackfillStatus.failed + 1
          };
          continue;
        }

        tagBackfillStatus = {
          ...tagBackfillStatus,
          matched: tagBackfillStatus.matched + 1
        };

        const currentTags = String(currentProduct.tags || "")
          .split(",")
          .map(tag => tag.trim())
          .filter(Boolean)
          .join(", ");
        const currentProductType = String(currentProduct.product_type || "").trim();

        if (currentTags === desiredTags && currentProductType === desiredGenre){
          tagBackfillStatus = {
            ...tagBackfillStatus,
            unchanged: tagBackfillStatus.unchanged + 1
          };
          continue;
        }

        await updateShopifyProductTagsAndType(item.productId, {
          tags: desiredTags,
          productType: desiredGenre
        });

        tagBackfillStatus = {
          ...tagBackfillStatus,
          updated: tagBackfillStatus.updated + 1
        };

        console.log(
          "✅ TAG BACKFILL:",
          item.barcode || `product:${item.productId}`,
          "->",
          desiredTags
        );
      } catch (err){
        tagBackfillStatus = {
          ...tagBackfillStatus,
          failed: tagBackfillStatus.failed + 1,
          error: err.message
        };
        console.log("❌ TAG BACKFILL ERROR:", item.barcode || item.productId, err.message);
      }

      await sleep(SHOPIFY_REQUEST_DELAY_MS);
    }
  } catch (err){
    tagBackfillStatus = {
      ...tagBackfillStatus,
      error: err.message
    };
    console.log("❌ TAG BACKFILL FAILED:", err.message);
  } finally {
    tagBackfillStatus = {
      ...tagBackfillStatus,
      running: false,
      currentTitle: null,
      currentBarcode: null,
      finishedAt: new Date().toISOString()
    };
  }

  return getTagBackfillStatusSnapshot();
}

// ----------------------------
app.post("/search", async (req,res)=>{
  const input = String(req.body?.barcode || req.body?.input || "").trim();
  const lookup = parseDiscogsLookupInput(input);
  try {
    const results = lookup.kind === "release_id"
      ? await buildReleaseOptionsForReleaseId(lookup.value)
      : await buildReleaseOptions(lookup.value, "single");
    res.json({ results });
  } catch (err){
    console.log("❌ SEARCH ERROR:", err.message);
    res.status(200).json({
      results: [],
      error: err.message
    });
  }
});

// ----------------------------
// BCM description feature start
app.post("/bcm-description/generate", async (req,res)=>{
  const releaseId = String(req.body?.releaseId || "").replace(/\D/g, "");
  const barcode = String(req.body?.barcode || "").trim();

  if (!releaseId){
    return res.status(400).json({
      success: false,
      error: "Release ID is required"
    });
  }

  try {
    const item = await fetchRelease(releaseId, barcode);
    if (!item){
      return res.status(404).json({
        success: false,
        error: "Could not load Discogs release details"
      });
    }

    return res.json({
      success: true,
      description: buildBcmDescriptionPayload(item)
    });
  } catch (err){
    console.log("❌ BCM GENERATE ERROR:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Could not generate BCM description"
    });
  }
});

app.post("/bcm-description/save", async (req,res)=>{
  const releaseId = String(req.body?.releaseId || "").replace(/\D/g, "");
  const barcode = String(req.body?.barcode || "").trim();
  const bodyHtml = String(req.body?.bodyHtml || "").trim();

  if (!releaseId || !bodyHtml){
    return res.status(400).json({
      success: false,
      error: "Release ID and body HTML are required"
    });
  }

  try {
    const item = await fetchRelease(releaseId, barcode);
    if (!item?.barcode){
      return res.status(400).json({
        success: false,
        error: "This release does not have a usable barcode for Shopify matching"
      });
    }

    const existingVariant = await findExistingVariantByBarcode(item.barcode);
    if (!existingVariant?.product_id){
      return res.status(404).json({
        success: false,
        error: "No Shopify product exists for this barcode yet. Use the create button instead."
      });
    }

    const product = await updateShopifyProductBodyHtml(existingVariant.product_id, bodyHtml);
    return res.json({
      success: true,
      mode: "updated_existing_body_html",
      productId: product.id,
      title: product.title
    });
  } catch (err){
    console.log("❌ BCM SAVE ERROR:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Could not update Shopify description"
    });
  }
});

app.post("/bcm-description/create", async (req,res)=>{
  const releaseId = String(req.body?.releaseId || "").replace(/\D/g, "");
  const barcode = String(req.body?.barcode || "").trim();
  const bodyHtml = String(req.body?.bodyHtml || "").trim();
  const condition = String(req.body?.condition || "M").trim() || "M";

  if (!releaseId || !bodyHtml){
    return res.status(400).json({
      success: false,
      error: "Release ID and body HTML are required"
    });
  }

  try {
    const item = await fetchRelease(releaseId, barcode);
    if (!item){
      return res.status(404).json({
        success: false,
        error: "Could not load Discogs release details"
      });
    }

    const existingVariant = item.barcode
      ? await findExistingVariantByBarcode(item.barcode)
      : null;
    if (existingVariant){
      return res.status(409).json({
        success: false,
        error: "This barcode already exists in Shopify. Use the description-only save button instead."
      });
    }

    item.description = bodyHtml;
    item.descriptionText = normalizeTextBlock(bodyHtml.replace(/<[^>]+>/g, " "));
    item.condition = condition;

    const variant = await upsertProduct(item);
    pushHistoryEntry(item);

    return res.json({
      success: true,
      mode: "created_new_product",
      productId: variant?.product_id || null,
      barcode: item.barcode
    });
  } catch (err){
    console.log("❌ BCM CREATE ERROR:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Could not create Shopify product"
    });
  }
});
// BCM description feature end

app.post("/bulk-start",(req,res)=>{
  const items = (req.body.items || [])
    .map(item => String(item || "").trim())
    .filter(Boolean)
    .map(item => {
      const lookup = parseDiscogsLookupInput(item);
      if (lookup.kind === "unknown") return null;

      return {
        raw: item,
        ...lookup
      };
    })
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

  for (const item of items){
    try {
      const options = item.kind === "release_id"
        ? await buildReleaseOptionsForReleaseId(item.value)
        : await buildReleaseOptions(item.value, "bulk");

      job.results.push({
        barcode: item.kind === "barcode" ? item.value : "",
        requestedInput: item.raw,
        requestedKind: item.kind,
        options,
        best: options[0] || null,
        error: options.length ? null : "No Discogs match found"
      });
    } catch (err){
      job.results.push({
        barcode: item.kind === "barcode" ? item.value : "",
        requestedInput: item.raw,
        requestedKind: item.kind,
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
function buildVariantWeightPayload(){
  return {
    requires_shipping: true,
    weight: DEFAULT_VARIANT_WEIGHT_OZ,
    weight_unit: DEFAULT_VARIANT_WEIGHT_UNIT
  };
}

async function updateInventoryItemCost(inventoryItemId, cost){
  const amount = Number.parseFloat(cost);
  if (!Number.isFinite(amount) || amount <= 0){
    return null;
  }

  const res = await shopifyRequest(`/inventory_items/${inventoryItemId}.json`, {
    method: "PUT",
    body: JSON.stringify({
      inventory_item: {
        id: inventoryItemId,
        cost: amount.toFixed(2)
      }
    })
  });

  if (!res.ok || !res.data?.inventory_item){
    console.log("❌ INVENTORY COST ERROR:", res.data);
    throw new Error(`Shopify inventory item cost update failed (${res.status})`);
  }

  return res.data.inventory_item;
}

async function createShopifyProduct(item){
  const tags = buildShopifyTags(item);
  const res = await shopifyRequest("/products.json", {
    method: "POST",
    body: JSON.stringify({
      product: {
        title: item.title,
        body_html: item.description,
        product_type: item.genre,
        tags,
        images: item.image ? [{ src: item.image }] : [],
        variants: [{
          price: item.basePrice,
          barcode: item.barcode || undefined,
          sku: item.barcode || undefined,
          inventory_management: "shopify",
          inventory_policy: "deny",
          tracked: true,
          ...buildVariantWeightPayload()
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
  const tags = buildShopifyTags(item);
  const productRes = await shopifyRequest(`/products/${variant.product_id}.json`, {
    method: "PUT",
    body: JSON.stringify({
      product: {
        id: variant.product_id,
        title: item.title,
        body_html: item.description,
        product_type: item.genre,
        tags
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
        sku: item.barcode || undefined,
        ...buildVariantWeightPayload()
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

  if (item.cost){
    try {
      const inventoryItem = await updateInventoryItemCost(variant.inventory_item_id, item.cost);
      console.log("💲 COST SET:", inventoryItem?.id || variant.inventory_item_id, inventoryItem?.cost || item.cost);
    } catch (err){
      console.log("⚠️ COST UPDATE SKIPPED:", item.barcode || variant.inventory_item_id, err.message);
    }
  }

  await syncInventoryForVariant(variant, item.stock);
  return variant;
}

// ----------------------------
app.post("/import",(req,res)=>{
  const items = req.body.items || [];
  beginImportBatch(items.length);

  items.forEach(i=>{
    queue.push({
      id: i.id,
      barcode: i.barcode,
      condition: i.condition || "M"
      ,
      overrides: i.overrides || null
    });
  });
  importStatus = {
    ...importStatus,
    queued: queue.length
  };

  res.json({
    success: true,
    import: getImportStatusSnapshot()
  });
});

app.post("/sync-inventory", async (req,res)=>{
  const refresh = await loadExcel({
    syncReason: "manual request",
    forceInventorySync: true
  });

  if (!refresh?.ok){
    return res.status(500).json({
      success: false,
      refresh,
      sync: {
        ...lastInventorySync,
        running: inventorySyncRunning,
        queued: inventorySyncQueued
      }
    });
  }

  res.json({
    success: true,
    refresh,
    sync: {
      ...lastInventorySync,
      running: inventorySyncRunning,
      queued: inventorySyncQueued
    }
  });
});

async function handleScheduledSync(req, res){
  if (!isAuthorizedSyncRequest(req)){
    return res.status(403).json({
      success: false,
      error: "Unauthorized scheduled sync request"
    });
  }

  const refresh = await loadExcel({
    syncReason: "scheduled sync",
    forceInventorySync: true
  });

  if (!refresh?.ok){
    return res.status(500).json({
      success: false,
      refresh,
      sync: {
        ...lastInventorySync,
        running: inventorySyncRunning,
        queued: inventorySyncQueued
      }
    });
  }

  res.json({
    success: true,
    refresh,
    sync: {
      ...lastInventorySync,
      running: inventorySyncRunning,
      queued: inventorySyncQueued
    }
  });
}

app.get("/scheduled-sync", handleScheduledSync);
app.post("/scheduled-sync", handleScheduledSync);

app.post("/backfill-titles", async (req,res)=>{
  const backfill = await runMaintenanceChunk("titles");
  res.json({
    success: true,
    backfill
  });
});

app.post("/backfill-tags", async (req,res)=>{
  const backfill = await runMaintenanceChunk("tags");
  res.json({
    success: true,
    backfill
  });
});

// ----------------------------
async function processQueue(){
  if (queueProcessing || !queue.length) return;

  queueProcessing = true;
  let job = null;

  try {
    job = queue.shift();
    markImportStarted(job);
    let data = null;

    if (job.preparedItem){
      data = job.preparedItem;
    } else if (job.id){
      data = await fetchRelease(job.id, job.barcode);
    } else if (job.barcode){
      data = await findBestReleaseForBarcode(job.barcode);
    }

    if (!data){
      finalizeImportItem({
        ok: false,
        error: "Release details could not be prepared"
      });
      return;
    }

    const finalItem = applyItemOverrides(data, job.overrides);
    const storedOverrideFields = !data.sourceMeta?.spreadsheetMatched
      ? normalizeStoredOverride(job.overrides || {})
      : {};
    finalItem.condition = job.condition || "M";
    markImportPrepared(finalItem, job);

    try {
      await upsertProduct(finalItem);
      if (job.source === "spreadsheet-auto-import"){
        removePendingAutoImport(finalItem.barcode || job.barcode);
      }
      if (Object.keys(storedOverrideFields).length){
        saveManualOverrides(
          [job.barcode, data.barcode, finalItem.barcode],
          storedOverrideFields
        );
        recordMissingSpreadsheetMatch({
          barcode: finalItem.barcode,
          title: finalItem.title,
          reason: "Missing spreadsheet data, using Discogs market pricing",
          manualOverrideSaved: true
        });
      }
      pushHistoryEntry(finalItem);
      finalizeImportItem({ ok: true });
    } catch (err){
      console.log("❌ IMPORT ERROR:", err.message);
      finalizeImportItem({
        ok: false,
        error: err.message
      });
    }
  } finally {
    queueProcessing = false;

    if (!hasActiveImportWork()){
      importStatus = {
        ...importStatus,
        running: false,
        lastFinishedAt: importStatus.lastFinishedAt || new Date().toISOString()
      };
    }
  }
}

setInterval(processQueue,1000);

// ----------------------------
app.get("/history",(req,res)=>{
  res.json({ history });
});

app.get("/missing-matches",(req,res)=>{
  res.json({
    matches: missingSpreadsheetMatches
  });
});

app.post("/missing-matches/clear",(req,res)=>{
  const barcode = normalizeBarcode(req.body?.barcode);

  if (barcode){
    removeMissingSpreadsheetMatch(barcode);
  } else {
    missingSpreadsheetMatches = [];
    persistMissingMatches();
  }

  res.json({
    success: true,
    matches: missingSpreadsheetMatches
  });
});

app.get("/sync-status",(req,res)=>{
  res.json({
    sync: {
      ...lastInventorySync,
      running: inventorySyncRunning,
      queued: inventorySyncQueued
    },
    spreadsheet: getSpreadsheetRefreshSnapshot(),
    digest: getDailyDigestSnapshot()
  });
});

app.get("/import-status",(req,res)=>{
  res.json({
    import: getImportStatusSnapshot()
  });
});

app.get("/maintenance-status",(req,res)=>{
  res.json({
    maintenance: getMaintenanceStatusSnapshot()
  });
});

// Barcode audit feature start
app.get("/barcode-audit",(req,res)=>{
  res.json({
    audit: getBarcodeAuditSnapshot()
  });
});

app.post("/barcode-audit/run", async (req,res)=>{
  const audit = await runBarcodeAudit();
  res.json({
    success: true,
    audit
  });
});

app.post("/barcode-audit/:productId/suggest", async (req,res)=>{
  const productId = Number(req.params.productId || 0);
  const auditItem = findBarcodeAuditItem(productId);
  if (!auditItem){
    return res.status(404).json({
      success: false,
      error: "Product is not in the current missing-barcode audit list"
    });
  }

  try {
    const options = await buildBarcodeRepairOptions(auditItem.title);
    res.json({
      success: true,
      options,
      product: {
        productId: auditItem.productId,
        title: auditItem.title,
        variantCount: auditItem.variantCount
      }
    });
  } catch (err){
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post("/barcode-audit/:productId/apply", async (req,res)=>{
  const productId = Number(req.params.productId || 0);
  const auditItem = findBarcodeAuditItem(productId);
  if (!auditItem){
    return res.status(404).json({
      success: false,
      error: "Product is not in the current missing-barcode audit list"
    });
  }

  if (Number(auditItem.variantCount || 0) !== 1 || !auditItem.variantIds?.[0]){
    return res.status(400).json({
      success: false,
      error: "This product has multiple variants. Open it in Shopify and set the correct barcode there."
    });
  }

  try {
    const rawInput = String(req.body?.input || req.body?.barcode || req.body?.releaseId || "").trim();
    let barcode = normalizeBarcode(rawInput);

    if (!barcode){
      const lookup = parseDiscogsLookupInput(rawInput);
      if (lookup.kind === "release_id"){
        const release = await fetchRelease(lookup.value, "");
        barcode = normalizeBarcode(release?.barcode);
      }
    }

    if (!barcode){
      return res.status(400).json({
        success: false,
        error: "Could not find a usable barcode from that input"
      });
    }

    const variant = await updateShopifyVariantBarcode(auditItem.variantIds[0], barcode);
    await runBarcodeAudit();

    res.json({
      success: true,
      barcode,
      variant: pickVariantCacheFields(variant),
      audit: getBarcodeAuditSnapshot()
    });
  } catch (err){
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
// Barcode audit feature end

app.post("/maintenance/:jobKey/run", async (req,res)=>{
  const jobKey = String(req.params.jobKey || "");
  if (!maintenanceJobs[jobKey]){
    return res.status(404).json({
      success: false,
      error: "Unknown maintenance job"
    });
  }

  const job = await runMaintenanceChunk(jobKey);
  res.json({
    success: true,
    job
  });
});

app.post("/maintenance/:jobKey/reset",(req,res)=>{
  const jobKey = String(req.params.jobKey || "");
  if (!maintenanceJobs[jobKey]){
    return res.status(404).json({
      success: false,
      error: "Unknown maintenance job"
    });
  }

  const job = resetMaintenanceJob(jobKey);
  res.json({
    success: true,
    job
  });
});

app.get("/backfill-status",(req,res)=>{
  res.json({
    backfill: getMaintenanceJobSnapshot(maintenanceJobs.titles)
  });
});

app.get("/backfill-tags-status",(req,res)=>{
  res.json({
    backfill: getMaintenanceJobSnapshot(maintenanceJobs.tags)
  });
});

// ----------------------------
app.listen(process.env.PORT||10000,()=>{
  console.log("🚀 CLEAN STABLE BUILD");
  console.log("📍 Inventory location:", LOCATION_ID);
});
