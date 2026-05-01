console.log("POS FINAL STABLE");

let bulkItems = [];
let bulkRenderedCount = 0;
let stream;
const GENRE_OPTIONS = [
  "Rock",
  "Jazz",
  "Other",
  "R&B",
  "Reggae",
  "Electronic",
  "Pop",
  "Hip Hop",
  "Country",
  "Classical",
  "Metal"
];
const SIDEBAR_VIEW_STORAGE_KEY = "bcm_sidebar_view";

window.onload = function(){
  document.getElementById("scanBtn").onclick = scan;
  document.getElementById("bulkBtn").onclick = startBulk;
  document.getElementById("cameraBtn").onclick = startCamera;
  document.getElementById("syncNowBtn").onclick = runInventorySync;
  setupSidebarView();
  document.getElementById("barcode").addEventListener("keydown", event => {
    if (event.key === "Enter") scan();
  });

  renderEmptyState(
    document.getElementById("results"),
    "No results yet",
    "Scan a barcode or start a bulk run to see product matches here."
  );

  loadHistory();
  loadSyncStatus();
  loadImportStatus();
  loadMissingMatches();
  loadMaintenanceStatus();
  setInterval(loadHistory, 2000);
  setInterval(loadSyncStatus, 5000);
  setInterval(loadImportStatus, 1500);
  setInterval(loadMissingMatches, 5000);
  setInterval(loadMaintenanceStatus, 5000);
};

function applySidebarView(view){
  const activeView = ["import", "review", "admin", "all"].includes(view) ? view : "import";
  const select = document.getElementById("sidebarView");
  if (select && select.value !== activeView){
    select.value = activeView;
  }

  document.querySelectorAll("[data-sidebar-group]").forEach(section => {
    const groups = String(section.getAttribute("data-sidebar-group") || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);

    const visible = activeView === "all" || groups.includes(activeView);
    section.classList.toggle("sidebar-hidden", !visible);
  });

  try {
    localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, activeView);
  } catch {}
}

function setupSidebarView(){
  const select = document.getElementById("sidebarView");
  if (!select) return;

  let savedView = "import";
  try {
    savedView = localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) || "import";
  } catch {}

  applySidebarView(savedView);
  select.onchange = () => applySidebarView(select.value);
}

function formatMoney(value){
  const amount = Number(value || 0);
  return amount.toFixed(2);
}

function titleCase(value){
  const text = String(value || "").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeBarcode(value){
  return String(value || "").replace(/\D/g, "");
}

function formatTimestamp(value){
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderEmptyState(container, title, copy){
  container.innerHTML = "";

  const card = document.createElement("div");
  card.className = "empty-state";

  const heading = document.createElement("h3");
  heading.textContent = title;

  const text = document.createElement("p");
  text.className = "section-copy";
  text.textContent = copy;

  card.appendChild(heading);
  card.appendChild(text);
  container.appendChild(card);
}

function buildOptionLabel(option, bestId){
  const parts = [option.year || "?", option.country || "?", titleCase(option.color || "black")];
  const prefix = option.id === bestId ? "Best Match" : "Option";
  return `${prefix}: ${option.title} (${parts.join(" • ")})`;
}

function renderBcmFactGrid(container, source, importState, reviewReasons){
  container.innerHTML = "";

  if (!source){
    const placeholder = document.createElement("p");
    placeholder.className = "muted-note";
    placeholder.textContent = "Pick a pressing, then generate a BCM description to review the release facts here.";
    container.appendChild(placeholder);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "bcm-facts-grid";

  const facts = [
    ["Artist", source.artistName || ""],
    ["Album", source.releaseName || source.title || ""],
    ["Label", source.label || "Unknown"],
    ["Year", source.year || "Unknown"],
    ["Country", source.country || "Unknown"],
    ["Format", source.format || "Vinyl"],
    ["Pressing", source.pressingDetails || "Pressing details: See notes / verify before listing"],
    ["Catalog", source.catalogNumber || "Unknown"],
    ["Barcode", source.barcode || "No barcode"],
    ["Identifier", source.identifierSummary || "Not provided"]
  ];

  facts.forEach(([labelText, valueText]) => {
    if (!valueText) return;

    const fact = document.createElement("div");
    fact.className = "bcm-fact";

    const label = document.createElement("div");
    label.className = "bcm-fact-label";
    label.textContent = labelText;

    const value = document.createElement("div");
    value.className = "bcm-fact-value";
    value.textContent = valueText;

    fact.appendChild(label);
    fact.appendChild(value);
    grid.appendChild(fact);
  });

  container.appendChild(grid);

  const badges = document.createElement("div");
  badges.className = "status-badges";
  badges.style.marginTop = "12px";

  const modePill = document.createElement("span");
  modePill.className = `status-pill ${
    importState.tone === "update"
      ? "good"
      : importState.tone === "create"
        ? "warn"
        : ""
  }`;
  modePill.textContent = importState.tone === "update"
    ? "Existing Shopify product"
    : importState.tone === "create"
      ? "New Shopify product"
      : "Shopify match will be checked on save";
  badges.appendChild(modePill);

  if (reviewReasons.length){
    const reviewPill = document.createElement("span");
    reviewPill.className = "status-pill warn";
    reviewPill.textContent = "Needs review";
    badges.appendChild(reviewPill);
  }

  container.appendChild(badges);
}

function buildBulkEntry(result, index){
  const firstOption = result.options?.[0] || null;

  return {
    key: `${index}:${result.barcode || firstOption?.barcode || "unknown"}`,
    requestedBarcode: result.barcode || "",
    requestedInput: result.requestedInput || result.barcode || "",
    requestedKind: result.requestedKind || "barcode",
    options: result.options || [],
    selectedId: firstOption?.id || "",
    condition: "M",
    removed: false,
    editorOpen: false,
    edits: {},
    selectionTouched: (result.options || []).length === 1,
    bcmOpen: false,
    bcmLoading: false,
    bcmHtml: "",
    bcmFacts: null,
    bcmError: "",
    error: result.error || null
  };
}

function getBulkCurrentOption(entry){
  return entry.options.find(option => String(option.id) === String(entry.selectedId)) || entry.options[0] || null;
}

function resolveBulkPrice(value, fallback){
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed.toFixed(2)
    : formatMoney(fallback);
}

function resolveBulkStock(value, fallback){
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : Number(fallback || 0);
}

function getBulkPreview(entry){
  const current = getBulkCurrentOption(entry);
  if (!current) return null;

  return {
    ...current,
    title: entry.edits.title !== undefined ? entry.edits.title : current.title,
    barcode: entry.edits.barcode !== undefined
      ? normalizeBarcode(entry.edits.barcode)
      : normalizeBarcode(current.barcode),
    basePrice: resolveBulkPrice(
      entry.edits.basePrice !== undefined ? entry.edits.basePrice : current.basePrice,
      current.basePrice
    ),
    stock: resolveBulkStock(
      entry.edits.stock !== undefined ? entry.edits.stock : current.stock,
      current.stock
    ),
    color: entry.edits.color !== undefined ? entry.edits.color : current.color,
    genre: entry.edits.genre !== undefined ? entry.edits.genre : current.genre,
    year: entry.edits.year !== undefined ? entry.edits.year : current.year,
    country: entry.edits.country !== undefined ? entry.edits.country : current.country,
    label: entry.edits.label !== undefined ? entry.edits.label : current.label,
    format: entry.edits.format !== undefined ? entry.edits.format : current.format,
    descriptionText: entry.edits.descriptionText !== undefined
      ? entry.edits.descriptionText
      : current.descriptionText
  };
}

function getBulkImportState(entry){
  const current = getBulkCurrentOption(entry);
  if (!current){
    return {
      label: "Will Check On Import",
      tone: "pending"
    };
  }

  const editedBarcode = entry.edits.barcode !== undefined
    ? normalizeBarcode(entry.edits.barcode)
    : "";
  const currentBarcode = normalizeBarcode(current.barcode);

  if (editedBarcode && editedBarcode !== currentBarcode){
    return {
      label: "Will Check On Import",
      tone: "pending"
    };
  }

  return current.importAction === "update"
    ? { label: "Will Update", tone: "update" }
    : current.importAction === "create"
      ? { label: "Will Create", tone: "create" }
      : { label: "Will Check On Import", tone: "pending" };
}

function getBulkReviewState(entry){
  const current = getBulkCurrentOption(entry);
  if (!current){
    return { needsReview: false, reasons: [] };
  }

  const reasons = [];
  const editedColor = String(entry.edits.color || "").trim();
  const editedBarcode = entry.edits.barcode !== undefined
    ? normalizeBarcode(entry.edits.barcode)
    : "";

  if (current.reviewFlags?.fallbackBlack && !editedColor){
    reasons.push("Color came back as black without a clear Discogs color callout.");
  }

  if (current.reviewFlags?.similarOptions){
    reasons.push("Several Discogs matches for this barcode look very similar.");
  }

  if (current.reviewFlags?.barcodeMismatch && !editedBarcode){
    reasons.push("Discogs returned a different barcode than the one you scanned.");
  }

  return {
    needsReview: reasons.length > 0,
    reasons
  };
}

function buildEditedOverrides(entry){
  const overrides = {};

  Object.entries(entry.edits || {}).forEach(([key, rawValue]) => {
    if (rawValue === undefined || rawValue === null){
      return;
    }

    if (key === "barcode"){
      const clean = normalizeBarcode(rawValue);
      if (clean) overrides.barcode = clean;
      return;
    }

    if (key === "basePrice"){
      const price = Number.parseFloat(rawValue);
      if (Number.isFinite(price) && price > 0){
        overrides.basePrice = price.toFixed(2);
      }
      return;
    }

    if (key === "stock"){
      const stock = Number.parseInt(rawValue, 10);
      if (Number.isFinite(stock) && stock >= 0){
        overrides.stock = stock;
      }
      return;
    }

    const text = String(rawValue || "").trim();
    if (text){
      overrides[key] = text;
    }
  });

  return overrides;
}

function buildBulkImportItem(entry){
  if (entry.removed) return null;

  const current = getBulkCurrentOption(entry);
  const preview = getBulkPreview(entry);
  if (!current || !preview) return null;

  const overrides = buildEditedOverrides(entry);

  return {
    id: current.id,
    condition: entry.condition || "M",
    barcode: preview.barcode || current.barcode,
    previewStock: preview.stock,
    overrides
  };
}

function renderSyncStatus(sync = {}){
  const box = document.getElementById("syncStatus");
  const button = document.getElementById("syncNowBtn");
  if (!box || !button) return;

  const summary = sync.summary || {};
  const stateLabel = sync.running
    ? "Running"
    : sync.queued
      ? "Queued"
      : sync.error
        ? "Needs Attention"
        : sync.lastRunAt
          ? "Ready"
          : "Waiting";

  const stateTone = sync.running
    ? "warn"
    : sync.error
      ? "bad"
      : "good";

  button.disabled = Boolean(sync.running);
  button.textContent = sync.running ? "Sync Running..." : "Sync Inventory Now";

  box.innerHTML = `
    <div class="status-card">
      <div class="status-badges">
        <span class="status-pill ${stateTone}">${stateLabel}</span>
        <span class="status-pill">Location ${summary.locationId || "Dropship"}</span>
      </div>
      <div class="status-stack" style="margin-top:14px;">
        <div class="status-row">
          <span class="status-label">Last Run</span>
          <span class="status-value">${formatTimestamp(sync.lastRunAt)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Reason</span>
          <span class="status-value">${sync.reason || "Spreadsheet refresh"}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Matched</span>
          <span class="status-value">${summary.matched ?? 0} of ${summary.variantsSeen ?? 0}</span>
        </div>
        <div class="status-badges">
          <span class="status-pill good">Updated ${summary.updated ?? 0}</span>
          <span class="status-pill">Unchanged ${summary.unchanged ?? 0}</span>
          <span class="status-pill ${summary.failed ? "bad" : ""}">Failed ${summary.failed ?? 0}</span>
        </div>
        ${sync.error ? `<p class="muted-note">Last error: ${sync.error}</p>` : ""}
      </div>
    </div>
  `;
}

function renderSpreadsheetStatus(spreadsheet = {}){
  const box = document.getElementById("spreadsheetStatus");
  if (!box) return;

  const newBarcodes = Array.isArray(spreadsheet.spreadsheetDelta?.newBarcodes)
    ? spreadsheet.spreadsheetDelta.newBarcodes.length
    : 0;
  const seeded = Boolean(spreadsheet.spreadsheetDelta?.seeded);
  const queued = Number(spreadsheet.autoImport?.queued || 0);
  const pending = Number(spreadsheet.pendingAutoImports ?? spreadsheet.autoImport?.pending ?? 0);
  const stateLabel = spreadsheet.error
    ? "Needs Attention"
    : spreadsheet.lastRunAt
      ? "Watching"
      : "Waiting";
  const stateTone = spreadsheet.error ? "bad" : "good";
  const sourceLabel = spreadsheet.source === "csv_url"
    ? "Live spreadsheet link"
    : spreadsheet.source === "local_file"
      ? "Deployed pricing.csv"
      : "Spreadsheet source";

  box.innerHTML = `
    <div class="status-card">
      <div class="status-badges">
        <span class="status-pill ${stateTone}">${stateLabel}</span>
        <span class="status-pill">${sourceLabel}</span>
      </div>
      <div class="status-stack" style="margin-top:14px;">
        <div class="status-row">
          <span class="status-label">Last Check</span>
          <span class="status-value">${formatTimestamp(spreadsheet.lastRunAt)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Known UPCs</span>
          <span class="status-value">${Number(spreadsheet.knownBarcodes || 0)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Rows Loaded</span>
          <span class="status-value">${Number(spreadsheet.rowsRead || 0)}</span>
        </div>
        <div class="status-badges">
          <span class="status-pill good">New found ${newBarcodes}</span>
          <span class="status-pill">Queued ${queued}</span>
          <span class="status-pill ${pending ? "warn" : ""}">Pending ${pending}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Baseline</span>
          <span class="status-value">${seeded ? "Saved this run" : formatTimestamp(spreadsheet.baselineAt)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Polling</span>
          <span class="status-value">${spreadsheet.pollingEnabled ? "On" : "Cron / manual only"}</span>
        </div>
        ${spreadsheet.error ? `<p class="muted-note">Last spreadsheet error: ${spreadsheet.error}</p>` : ""}
      </div>
    </div>
  `;
}

function renderDailyDigest(digest = {}){
  const box = document.getElementById("dailyDigest");
  if (!box) return;

  const imports = digest.imports || {};
  const spreadsheet = digest.spreadsheet || {};
  const review = digest.review || {};
  const inventory = digest.inventory || {};
  const maintenance = digest.maintenance || {};

  box.innerHTML = `
    <div class="status-card">
      <div class="status-badges">
        <span class="status-pill good">Imported ${Number(imports.total || 0)}</span>
        <span class="status-pill">Created ${Number(imports.created || 0)}</span>
        <span class="status-pill">Updated ${Number(imports.updated || 0)}</span>
      </div>
      <div class="status-stack" style="margin-top:14px;">
        <div class="status-row">
          <span class="status-label">Sheet Check</span>
          <span class="status-value">${formatTimestamp(spreadsheet.lastCheckedAt)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">New UPCs Found</span>
          <span class="status-value">${Number(spreadsheet.newBarcodesFound || 0)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Auto-Queued</span>
          <span class="status-value">${Number(spreadsheet.autoImportQueued || 0)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Pending Auto-Imports</span>
          <span class="status-value">${Number(spreadsheet.pendingAutoImports || 0)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Inventory Updated</span>
          <span class="status-value">${Number(inventory.updated || 0)} of ${Number(inventory.matched || 0)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Review Items</span>
          <span class="status-value">${Number(review.waiting || 0)} waiting</span>
        </div>
        <div class="status-row">
          <span class="status-label">Admin Jobs Today</span>
          <span class="status-value">${Number(maintenance.ranToday || 0)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderImportStatus(importState = {}){
  const box = document.getElementById("importStatus");
  if (!box) return;

  const total = Number(importState.total || 0);
  const completed = Number(importState.completed || 0);
  const failed = Number(importState.failed || 0);
  const processed = Number(importState.processed ?? (completed + failed));
  const remaining = Number(importState.remaining ?? Math.max(0, total - processed));
  const percent = Number(importState.percent ?? (total ? Math.round((processed / total) * 100) : 0));
  const stateLabel = importState.running
    ? "Importing"
    : total
      ? failed
        ? "Finished With Issues"
        : "Import Complete"
      : "Waiting";
  const stateTone = importState.running
    ? "warn"
    : failed
      ? "bad"
      : "good";

  box.innerHTML = `
    <div class="status-card">
      <div class="status-badges">
        <span class="status-pill ${stateTone}">${stateLabel}</span>
        <span class="status-pill">${completed} imported</span>
        <span class="status-pill">${remaining} left</span>
      </div>
      <div class="status-stack" style="margin-top:14px;">
        <div class="progress-shell">
          <div class="progress-bar" style="width:${Math.max(0, Math.min(100, percent))}%;"></div>
        </div>
        <div class="status-row">
          <span class="status-label">Progress</span>
          <span class="status-value">${processed} of ${total || 0}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Failed</span>
          <span class="status-value">${failed}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Current Item</span>
          <span class="status-value">${importState.currentTitle || importState.currentBarcode || (importState.running ? "Preparing next item" : "No active import")}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Started</span>
          <span class="status-value">${formatTimestamp(importState.startedAt)}</span>
        </div>
        ${importState.lastError ? `<p class="muted-note">Last import error: ${importState.lastError}</p>` : ""}
      </div>
    </div>
  `;
}

function renderMissingMatches(matches = []){
  const box = document.getElementById("missingMatches");
  if (!box) return;

  box.innerHTML = "";

  if (!matches.length){
    renderEmptyState(
      box,
      "No review items",
      "Anything missing from the spreadsheet will show up here so you can revisit it later."
    );
    return;
  }

  const summary = document.createElement("div");
  summary.className = "status-card";
  summary.innerHTML = `
    <div class="status-badges">
      <span class="status-pill warn">${matches.length} waiting</span>
      <span class="status-pill">Spreadsheet review queue</span>
    </div>
  `;

  const clearAllBtn = document.createElement("button");
  clearAllBtn.className = "ghost-btn";
  clearAllBtn.textContent = "Clear All";
  clearAllBtn.onclick = async () => {
    await clearMissingMatches();
  };

  const actions = document.createElement("div");
  actions.className = "result-actions-inline";
  actions.style.marginTop = "12px";
  actions.appendChild(clearAllBtn);
  summary.appendChild(actions);
  box.appendChild(summary);

  matches.slice(0, 8).forEach(item => {
    const card = document.createElement("article");
    card.className = "history-item";

    const heading = document.createElement("h3");
    heading.className = "history-title";
    heading.textContent = item.title || "Untitled release";

    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent = [
      item.barcode ? `UPC ${item.barcode}` : null,
      item.reason || "Spreadsheet match missing",
      item.lastSeenAt ? formatTimestamp(item.lastSeenAt) : null
    ].filter(Boolean).join(" • ");

    const chips = document.createElement("div");
    chips.className = "status-badges";
    chips.style.marginTop = "10px";

    const seenChip = document.createElement("span");
    seenChip.className = "status-pill";
    seenChip.textContent = `${item.seenCount || 1} lookups`;
    chips.appendChild(seenChip);

    if (item.manualOverrideSaved){
      const savedChip = document.createElement("span");
      savedChip.className = "status-pill good";
      savedChip.textContent = "Manual override saved";
      chips.appendChild(savedChip);
    }

    const clearBtn = document.createElement("button");
    clearBtn.className = "ghost-btn";
    clearBtn.textContent = "Clear";
    clearBtn.onclick = async () => {
      await clearMissingMatches(item.barcode);
    };

    const actionRow = document.createElement("div");
    actionRow.className = "result-actions-inline";
    actionRow.style.marginTop = "12px";
    actionRow.appendChild(clearBtn);

    card.appendChild(heading);
    card.appendChild(meta);
    card.appendChild(chips);
    card.appendChild(actionRow);
    box.appendChild(card);
  });
}

function renderMaintenanceStatus(maintenance = {}){
  const box = document.getElementById("maintenanceStatus");
  if (!box) return;

  const jobDefs = [
    {
      key: "titles",
      label: "Title Backfill",
      description: "Runs the next saved batch of title cleanup without needing a long all-at-once backfill."
    },
    {
      key: "descriptions",
      label: "Description Backfill",
      description: "Runs the next saved batch of BCM product description updates for existing Shopify items."
    },
    {
      key: "tags",
      label: "Collection Cleanup",
      description: "Runs the next saved batch of tag and product-type cleanup."
    },
    {
      key: "standards",
      label: "Cost + Weight Backfill",
      description: "Runs the next saved batch to push spreadsheet cost and the default 1 lb 9 oz weight onto older Shopify items."
    }
  ];

  box.innerHTML = "";

  jobDefs.forEach(def => {
    const job = maintenance[def.key] || {};
    const processed = Number(job.processed || 0);
    const total = Number(job.total || 0);
    const remaining = Number(job.remaining ?? Math.max(0, total - processed));
    const percent = Number(job.percent ?? (total ? Math.round((processed / total) * 100) : 0));
    const stateLabel = job.running
      ? "Running"
      : job.complete
        ? "Complete"
        : processed
          ? "Ready To Resume"
          : "Waiting";
    const stateTone = job.running
      ? "warn"
      : job.complete
        ? "good"
        : "pending";

    const card = document.createElement("div");
    card.className = "status-card";
    card.innerHTML = `
      <div class="status-badges">
        <span class="status-pill ${stateTone === "good" ? "good" : stateTone === "warn" ? "warn" : ""}">${stateLabel}</span>
        <span class="status-pill">${processed} done</span>
        <span class="status-pill">${remaining} left</span>
      </div>
      <div class="status-stack" style="margin-top:14px;">
        <div>
          <div class="status-label">${def.label}</div>
          <p class="section-copy" style="margin-top:6px;">${def.description}</p>
        </div>
        <div class="progress-shell">
          <div class="progress-bar" style="width:${Math.max(0, Math.min(100, percent))}%;"></div>
        </div>
        <div class="status-row">
          <span class="status-label">Progress</span>
          <span class="status-value">${processed} of ${total || 0}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Updated</span>
          <span class="status-value">${job.updated || 0}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Unchanged</span>
          <span class="status-value">${job.unchanged || 0}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Failed</span>
          <span class="status-value">${job.failed || 0}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Current Item</span>
          <span class="status-value">${job.currentTitle || job.currentBarcode || "Waiting on next batch"}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Last Run</span>
          <span class="status-value">${formatTimestamp(job.lastRunAt)}</span>
        </div>
        ${job.error ? `<p class="muted-note">Last error: ${job.error}</p>` : ""}
      </div>
    `;

    const failures = Array.isArray(job.recentFailures) ? job.recentFailures.slice(0, 5) : [];
    if (failures.length){
      const failureBox = document.createElement("div");
      failureBox.className = "status-card";
      failureBox.style.marginTop = "14px";

      const heading = document.createElement("div");
      heading.className = "status-label";
      heading.textContent = "Recent Failures";
      failureBox.appendChild(heading);

      const list = document.createElement("div");
      list.className = "status-stack";
      list.style.marginTop = "12px";

      failures.forEach(failure => {
        const row = document.createElement("div");
        row.className = "history-item";

        const title = document.createElement("h3");
        title.className = "history-title";
        title.textContent = failure.title || failure.barcode || `Product ${failure.productId || "Unknown"}`;

        const meta = document.createElement("p");
        meta.className = "history-meta";
        meta.textContent = [
          failure.barcode ? `UPC ${failure.barcode}` : null,
          failure.reason || "Unknown failure",
          formatTimestamp(failure.failedAt)
        ].filter(Boolean).join(" • ");

        row.appendChild(title);
        row.appendChild(meta);
        list.appendChild(row);
      });

      failureBox.appendChild(list);
      card.appendChild(failureBox);
    }

    const actions = document.createElement("div");
    actions.className = "result-actions-inline";
    actions.style.marginTop = "14px";

    const runBtn = document.createElement("button");
    runBtn.className = "secondary-btn";
    runBtn.textContent = job.running ? "Running..." : "Run Next Batch";
    runBtn.disabled = Boolean(job.running);
    runBtn.onclick = async () => {
      await runMaintenanceJob(def.key);
    };

    const resetBtn = document.createElement("button");
    resetBtn.className = "ghost-btn";
    resetBtn.textContent = "Reset Progress";
    resetBtn.disabled = Boolean(job.running);
    resetBtn.onclick = async () => {
      await resetMaintenanceJob(def.key);
    };

    actions.appendChild(runBtn);
    actions.appendChild(resetBtn);
    card.appendChild(actions);
    box.appendChild(card);
  });
}

async function clearMissingMatches(barcode){
  await fetch("/missing-matches/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barcode ? { barcode } : {})
  });

  await loadMissingMatches();
}

async function loadMissingMatches(){
  try {
    const res = await fetch("/missing-matches");
    const data = await res.json();
    renderMissingMatches(data.matches || []);
  } catch {
    renderMissingMatches([]);
  }
}

async function loadMaintenanceStatus(){
  try {
    const res = await fetch("/maintenance-status");
    const data = await res.json();
    renderMaintenanceStatus(data.maintenance || {});
  } catch {
    renderMaintenanceStatus({});
  }
}

async function runMaintenanceJob(jobKey){
  const res = await fetch(`/maintenance/${jobKey}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false){
    alert(data.error || "Could not start maintenance job");
    return;
  }
  await loadMaintenanceStatus();
}

async function resetMaintenanceJob(jobKey){
  const res = await fetch(`/maintenance/${jobKey}/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false){
    alert(data.error || "Could not reset maintenance job");
    return;
  }
  await loadMaintenanceStatus();
}

async function loadSyncStatus(){
  try {
    const res = await fetch("/sync-status");
    const data = await res.json();
    renderSyncStatus(data.sync || {});
    renderSpreadsheetStatus(data.spreadsheet || {});
    renderDailyDigest(data.digest || {});
  } catch {
    renderSyncStatus({
      error: "Could not load sync status"
    });
    renderSpreadsheetStatus({
      error: "Could not load spreadsheet status"
    });
    renderDailyDigest({});
  }
}

async function loadImportStatus(){
  try {
    const res = await fetch("/import-status");
    const data = await res.json();
    renderImportStatus(data.import || {});
  } catch {
    renderImportStatus({
      lastError: "Could not load import status"
    });
  }
}

async function runInventorySync(){
  const button = document.getElementById("syncNowBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "Starting Sync...";
  }

  try {
    const res = await fetch("/sync-inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await res.json();
    renderSyncStatus(data.sync || {});
    await loadSyncStatus();
  } catch {
    renderSyncStatus({
      error: "Could not start inventory sync"
    });
  }
}

async function scan(){
  const barcode = document.getElementById("barcode").value.trim();
  if (!barcode) return alert("Enter a barcode or Discogs release ID");

  const res = await fetch("/search", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ barcode })
  });

  const data = await res.json();
  const box = document.getElementById("results");
  box.innerHTML = "";

  if (!data.results?.length){
    renderEmptyState(
      box,
      "No Discogs results",
      "Try another barcode, a Discogs release ID, or confirm the item exists in Discogs."
    );
    return;
  }

  renderCard(data.results, box);
}

async function startBulk(){
  const lines = document.getElementById("bulk").value
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length){
    alert("Paste at least one barcode");
    return;
  }

  const res = await fetch("/bulk-start", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ items: lines })
  });

  const { jobId } = await res.json();
  const box = document.getElementById("results");
  bulkItems = [];
  bulkRenderedCount = 0;

  box.innerHTML = `
    <div class="empty-state">
      <h3>Processing bulk barcodes</h3>
      <p class="section-copy">Matches will appear below as Discogs finishes each barcode. Remove anything you do not want, or open Edit Details before sending to Shopify.</p>
      <div class="progress-shell">
        <div id="progressBar" class="progress-bar"></div>
      </div>
      <button id="addAllBtn" class="secondary-btn">Add All Kept Items</button>
    </div>
    <div id="bulkResults" class="results-list">
      <div class="empty-state">
        <h3>Waiting on bulk results</h3>
        <p class="section-copy">Your first matched release will appear here as soon as it is found.</p>
      </div>
    </div>
  `;

  document.getElementById("addAllBtn").onclick = addAllBulk;
  pollBulk(jobId);
}

async function pollBulk(jobId){
  const res = await fetch("/bulk-status/" + jobId);
  const data = await res.json();

  const bar = document.getElementById("progressBar");
  if (bar) bar.style.width = data.progress + "%";

  const container = document.getElementById("bulkResults");
  if (!container) return;

  const newResults = (data.results || []).slice(bulkRenderedCount);
  if (newResults.length && bulkRenderedCount === 0){
    container.innerHTML = "";
  }

  newResults.forEach((result, offset) => {
    const entry = buildBulkEntry(result, bulkRenderedCount + offset);
    bulkItems.push(entry);

    if (entry.options.length){
      renderBulkCard(entry, container);
    } else {
      renderBulkErrorCard(entry, container);
    }
  });

  bulkRenderedCount = data.results?.length || 0;

  if (data.progress < 100){
    setTimeout(() => pollBulk(jobId), 1000);
  } else if (!bulkItems.length){
    renderEmptyState(
      container,
      "No bulk matches found",
      "Discogs did not return any usable releases for this batch."
    );
  }
}

async function addAllBulk(){
  const items = bulkItems
    .map(buildBulkImportItem)
    .filter(item => item && Number(item.previewStock ?? 0) > 0)
    .map(({ previewStock, ...item }) => item);

  if (!items.length){
    alert("No kept items in stock");
    return;
  }

  await fetch("/import", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ items })
  });

  await loadImportStatus();
  alert(`Queued ${items.length} bulk item${items.length === 1 ? "" : "s"}`);
}

function renderCard(options, container){
  const entry = {
    options,
    selectedId: options[0]?.id || "",
    condition: "M",
    editorOpen: false,
    edits: {},
    selectionTouched: options.length === 1,
    bcmOpen: false,
    bcmLoading: false,
    bcmHtml: "",
    bcmFacts: null,
    bcmError: ""
  };
  const card = document.createElement("article");
  card.className = "result-card";

  const toolbar = document.createElement("div");
  toolbar.className = "bulk-toolbar";

  const sourceChip = document.createElement("span");
  sourceChip.className = "chip chip-barcode";
  sourceChip.textContent = "Single Scan";

  const toolbarActions = document.createElement("div");
  toolbarActions.className = "result-actions-inline";

  const editBtn = document.createElement("button");
  editBtn.className = "ghost-btn";

  toolbarActions.appendChild(editBtn);
  toolbar.appendChild(sourceChip);
  toolbar.appendChild(toolbarActions);

  const preview = document.createElement("div");
  preview.className = "result-preview";

  const coverFrame = document.createElement("div");
  coverFrame.className = "cover-frame";

  const coverImage = document.createElement("img");
  coverImage.className = "cover-image";
  coverImage.alt = "Release cover";

  const coverFallback = document.createElement("span");
  coverFallback.textContent = "No Art";

  coverFrame.appendChild(coverImage);
  coverFrame.appendChild(coverFallback);

  const body = document.createElement("div");

  const title = document.createElement("h3");
  title.className = "card-title";

  const meta = document.createElement("p");
  meta.className = "card-meta";

  const detailNote = document.createElement("p");
  detailNote.className = "muted-note";
  detailNote.style.margin = "8px 0 0";

  const chips = document.createElement("div");
  chips.className = "chip-row";

  const priceChip = document.createElement("span");
  priceChip.className = "chip chip-price";

  const stockChip = document.createElement("span");

  const barcodeChip = document.createElement("span");
  barcodeChip.className = "chip chip-barcode";

  const colorChip = document.createElement("span");
  colorChip.className = "chip";

  const actionChip = document.createElement("span");
  actionChip.className = "chip";

  const reviewChip = document.createElement("span");
  reviewChip.className = "chip chip-review";

  chips.appendChild(priceChip);
  chips.appendChild(stockChip);
  chips.appendChild(barcodeChip);
  chips.appendChild(colorChip);
  chips.appendChild(actionChip);
  chips.appendChild(reviewChip);

  const copy = document.createElement("p");
  copy.className = "card-copy";

  const notesPanel = document.createElement("details");
  notesPanel.className = "notes-panel";

  const notesSummary = document.createElement("summary");
  notesSummary.className = "notes-toggle";
  notesSummary.textContent = "Release Notes";

  notesPanel.appendChild(notesSummary);
  notesPanel.appendChild(copy);

  const importNote = document.createElement("div");
  importNote.className = "info-note";

  const reviewNote = document.createElement("div");
  reviewNote.className = "review-note";

  body.appendChild(title);
  body.appendChild(meta);
  body.appendChild(detailNote);
  body.appendChild(chips);
  body.appendChild(importNote);
  body.appendChild(reviewNote);

  preview.appendChild(coverFrame);
  preview.appendChild(body);

  const controls = document.createElement("div");
  controls.className = "result-controls";

  const variantField = document.createElement("div");
  variantField.className = "field-stack";

  const variantLabel = document.createElement("label");
  variantLabel.className = "field-label";
  variantLabel.textContent = "Release Option";

  const select = document.createElement("select");
  select.className = "control-input";

  options.forEach(option => {
    const item = document.createElement("option");
    item.value = option.id;
    item.textContent = buildOptionLabel(option, options[0].id);
    select.appendChild(item);
  });

  variantField.appendChild(variantLabel);
  variantField.appendChild(select);

  const conditionField = document.createElement("div");
  conditionField.className = "field-stack";

  const conditionLabel = document.createElement("label");
  conditionLabel.className = "field-label";
  conditionLabel.textContent = "Condition";

  const cond = document.createElement("select");
  cond.className = "control-input";

  ["M","NM","VG+","VG","G"].forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    cond.appendChild(option);
  });

  conditionField.appendChild(conditionLabel);
  conditionField.appendChild(cond);

  const addBtn = document.createElement("button");
  addBtn.className = "primary-btn";

  const bcmBtn = document.createElement("button");
  bcmBtn.className = "secondary-btn";

  controls.appendChild(variantField);
  controls.appendChild(conditionField);
  controls.appendChild(bcmBtn);
  controls.appendChild(addBtn);

  const editor = document.createElement("div");
  editor.className = "bulk-editor";
  editor.classList.add("details-editor");

  const editorNote = document.createElement("p");
  editorNote.className = "muted-note";
  editorNote.textContent = "Adjust any details below before adding this record to Shopify.";

  const editorGrid = document.createElement("div");
  editorGrid.className = "editor-grid";

  function createEditorField(labelText, key, { type = "text", rows = 3, wide = false, options = null } = {}){
    const field = document.createElement("div");
    field.className = `field-stack${wide ? " editor-wide" : ""}`;

    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = labelText;

    const input = type === "select"
      ? document.createElement("select")
      : type === "textarea"
      ? document.createElement("textarea")
      : document.createElement("input");

    input.className = "control-input";

    if (type === "select"){
      (options || []).forEach(optionValue => {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = optionValue;
        input.appendChild(option);
      });
    } else if (type === "textarea"){
      input.rows = rows;
    } else {
      input.type = type;
    }

    input.addEventListener("input", () => {
      entry.edits[key] = input.value;
      updateCard();
    });

    field.appendChild(label);
    field.appendChild(input);
    editorGrid.appendChild(field);
    return input;
  }

  const inputRefs = {
    title: createEditorField("Title", "title"),
    barcode: createEditorField("Barcode", "barcode"),
    basePrice: createEditorField("Price", "basePrice", { type: "number" }),
    stock: createEditorField("Stock", "stock", { type: "number" }),
    color: createEditorField("Color", "color"),
    genre: createEditorField("Genre", "genre", { type: "select", options: GENRE_OPTIONS }),
    year: createEditorField("Year", "year"),
    country: createEditorField("Country", "country"),
    label: createEditorField("Label", "label"),
    format: createEditorField("Format", "format"),
    descriptionText: createEditorField("Description", "descriptionText", { type: "textarea", rows: 5, wide: true })
  };

  const editorActions = document.createElement("div");
  editorActions.className = "result-actions-inline";

  const resetBtn = document.createElement("button");
  resetBtn.className = "ghost-btn";
  resetBtn.textContent = "Reset Edits";

  const editorAddBtn = document.createElement("button");
  editorAddBtn.className = "primary-btn";
  editorAddBtn.style.display = "none";

  editorActions.appendChild(resetBtn);
  editorActions.appendChild(editorAddBtn);
  editor.appendChild(editorNote);
  editor.appendChild(editorGrid);
  editor.appendChild(editorActions);

  card.appendChild(toolbar);
  card.appendChild(preview);
  card.appendChild(controls);
  card.appendChild(notesPanel);
  card.appendChild(editor);

  // BCM description feature start
  const bcmSection = document.createElement("div");
  bcmSection.className = "bulk-editor";
  bcmSection.classList.add("bcm-panel");

  const bcmIntro = document.createElement("p");
  bcmIntro.className = "muted-note";
  bcmIntro.classList.add("bcm-intro");
  bcmIntro.textContent = "Generate original Best Coast Music description copy from release facts, review it, then save only when you are ready.";

  const bcmStatus = document.createElement("div");
  bcmStatus.className = "review-note";
  bcmStatus.classList.add("bcm-status");

  const bcmFactsCard = document.createElement("div");
  bcmFactsCard.className = "status-card";
  bcmFactsCard.classList.add("bcm-facts-card");

  const bcmFactsStack = document.createElement("div");
  bcmFactsStack.className = "status-stack";
  bcmFactsCard.appendChild(bcmFactsStack);

  const bcmHtmlLabel = document.createElement("p");
  bcmHtmlLabel.className = "field-label";
  bcmHtmlLabel.classList.add("bcm-field-label");
  bcmHtmlLabel.textContent = "Editable Shopify Body HTML";

  const bcmHtmlField = document.createElement("textarea");
  bcmHtmlField.className = "control-input";
  bcmHtmlField.classList.add("bcm-html-field");
  bcmHtmlField.rows = 12;
  bcmHtmlField.placeholder = "Generated BCM HTML will appear here.";
  bcmHtmlField.addEventListener("input", () => {
    entry.bcmHtml = bcmHtmlField.value;
    bcmPreview.innerHTML = entry.bcmHtml || "<p class=\"muted-note\">Preview will appear here.</p>";
  });

  const bcmPreview = document.createElement("div");
  bcmPreview.className = "status-card";
  bcmPreview.classList.add("bcm-preview-card");
  bcmPreview.innerHTML = "<p class=\"muted-note\">Preview will appear here.</p>";

  const bcmPreviewLabel = document.createElement("p");
  bcmPreviewLabel.className = "field-label";
  bcmPreviewLabel.classList.add("bcm-preview-label");
  bcmPreviewLabel.textContent = "Live Preview";

  const bcmActions = document.createElement("div");
  bcmActions.className = "result-actions-inline";
  bcmActions.classList.add("bcm-actions");

  const bcmRegenerateBtn = document.createElement("button");
  bcmRegenerateBtn.className = "ghost-btn";
  bcmRegenerateBtn.textContent = "Regenerate";

  const bcmSaveBtn = document.createElement("button");
  bcmSaveBtn.className = "secondary-btn";

  const bcmCreateBtn = document.createElement("button");
  bcmCreateBtn.className = "primary-btn";

  bcmActions.appendChild(bcmRegenerateBtn);
  bcmActions.appendChild(bcmSaveBtn);
  bcmActions.appendChild(bcmCreateBtn);
  bcmSection.appendChild(bcmIntro);
  bcmSection.appendChild(bcmStatus);
  bcmSection.appendChild(bcmFactsCard);
  bcmSection.appendChild(bcmHtmlLabel);
  bcmSection.appendChild(bcmHtmlField);
  bcmSection.appendChild(bcmPreviewLabel);
  bcmSection.appendChild(bcmPreview);
  bcmSection.appendChild(bcmActions);
  card.appendChild(bcmSection);
  // BCM description feature end

  function syncEditorInputs(){
    const current = getBulkCurrentOption(entry);
    if (!current) return;

    inputRefs.title.value = entry.edits.title !== undefined ? entry.edits.title : (current.title || "");
    inputRefs.barcode.value = entry.edits.barcode !== undefined ? entry.edits.barcode : (current.barcode || "");
    inputRefs.basePrice.value = entry.edits.basePrice !== undefined ? entry.edits.basePrice : formatMoney(current.basePrice);
    inputRefs.stock.value = entry.edits.stock !== undefined ? entry.edits.stock : String(current.stock ?? 0);
    inputRefs.color.value = entry.edits.color !== undefined ? entry.edits.color : (current.color || "");
    inputRefs.genre.value = entry.edits.genre !== undefined ? entry.edits.genre : (current.genre || "");
    inputRefs.year.value = entry.edits.year !== undefined ? entry.edits.year : (current.year || "");
    inputRefs.country.value = entry.edits.country !== undefined ? entry.edits.country : (current.country || "");
    inputRefs.label.value = entry.edits.label !== undefined ? entry.edits.label : (current.label || "");
    inputRefs.format.value = entry.edits.format !== undefined ? entry.edits.format : (current.format || "");
    inputRefs.descriptionText.value = entry.edits.descriptionText !== undefined
      ? entry.edits.descriptionText
      : (current.descriptionText || "");
  }

  // BCM description feature start
  function renderBcmFacts(source, importState, reviewReasons){
    renderBcmFactGrid(bcmFactsStack, source, importState, reviewReasons);
  }
  // BCM description feature end

  function updateCard(){
    const current = getBulkPreview(entry);
    if (!current) return;
    const selectedOption = getBulkCurrentOption(entry);

    const stock = Number(current.stock || 0);
    const importState = getBulkImportState(entry);
    const reviewState = getBulkReviewState(entry);
    const requiresSelection = entry.options.length > 1 && !entry.selectionTouched;
    const reviewReasons = [...reviewState.reasons];

    if (requiresSelection){
      reviewReasons.unshift("Multiple Discogs matches were found. Choose the exact pressing before importing or saving BCM copy.");
    }

    const needsReview = reviewReasons.length > 0;

    title.textContent = current.title || "Untitled release";
    meta.textContent =
      [current.year, current.country, current.label, current.format]
        .filter(Boolean)
        .join(" • ") || "Discogs match";
    detailNote.textContent = [
      current.catalogNumber ? `Catalog ${current.catalogNumber}` : null,
      current.pressingDetails || null,
      current.identifierSummary || null
    ].filter(Boolean).join(" • ");
    detailNote.style.display = detailNote.textContent ? "block" : "none";

    priceChip.textContent = `$${formatMoney(current.basePrice)}`;
    barcodeChip.textContent = current.barcode ? `UPC ${current.barcode}` : "No barcode";
    colorChip.textContent = `${titleCase(current.color || "black")} vinyl`;
    actionChip.className = `chip chip-action-${importState.tone}`;
    actionChip.textContent = importState.label;
    stockChip.className = `chip chip-stock ${stock > 0 ? "in-stock" : "out-stock"}`;
    stockChip.textContent = stock > 0 ? `${stock} in stock` : "Out of stock";
    importNote.style.display = importState.tone === "update" ? "block" : "none";
    importNote.textContent = importState.tone === "update"
      ? "Already in Shopify. Adding this scan will update the existing product instead of creating a duplicate."
      : "";

    copy.textContent =
      current.descriptionText ||
      "No additional Discogs description was available for this release.";
    notesPanel.style.display = current.descriptionText ? "block" : "none";

    card.classList.toggle("needs-review", needsReview);
    reviewChip.style.display = needsReview ? "inline-flex" : "none";
    reviewChip.textContent = "Needs Review";
    reviewNote.style.display = needsReview ? "block" : "none";
    reviewNote.innerHTML = needsReview
      ? `<strong>Review before import:</strong> ${reviewReasons.join(" ")}`
      : "";

    if (current.image){
      coverImage.src = current.image;
      coverImage.style.display = "block";
      coverFallback.style.display = "none";
    } else {
      coverImage.removeAttribute("src");
      coverImage.style.display = "none";
      coverFallback.style.display = "inline";
    }

    editBtn.textContent = entry.editorOpen ? "Hide Edit Details" : "Edit Details";
    bcmBtn.textContent = requiresSelection
      ? "Choose Pressing Then Generate"
      : entry.bcmOpen && entry.bcmHtml
        ? "Hide BCM Description"
        : "Generate BCM Description";
    editor.classList.toggle("open", entry.editorOpen);
    bcmSection.classList.toggle("open", entry.bcmOpen);
    select.value = entry.selectedId;
    cond.value = entry.condition;
    addBtn.disabled = stock <= 0 || requiresSelection;
    addBtn.textContent = requiresSelection
      ? "Choose Pressing First"
      : stock <= 0
        ? "Out of Stock"
        : "Add to Shopify";
    addBtn.style.display = entry.editorOpen || entry.bcmOpen ? "none" : "inline-flex";
    editorAddBtn.disabled = stock <= 0 || requiresSelection;
    editorAddBtn.textContent = requiresSelection
      ? "Choose Pressing First"
      : stock <= 0
        ? "Out of Stock"
        : "Add to Shopify";
    editorAddBtn.style.display = entry.editorOpen && !entry.bcmOpen ? "inline-flex" : "none";
    bcmBtn.disabled = entry.bcmLoading || requiresSelection;
    bcmSaveBtn.style.display = importState.tone === "update" ? "inline-flex" : "none";
    bcmCreateBtn.style.display = importState.tone === "update" ? "none" : "inline-flex";
    bcmSaveBtn.textContent = entry.bcmLoading ? "Saving..." : "Update Shopify Description Only";
    bcmCreateBtn.textContent = entry.bcmLoading ? "Creating..." : "Create In Shopify With BCM Description";
    bcmSaveBtn.disabled = entry.bcmLoading || requiresSelection || !entry.bcmHtml.trim();
    bcmCreateBtn.disabled = entry.bcmLoading || requiresSelection || !entry.bcmHtml.trim();
    bcmRegenerateBtn.disabled = entry.bcmLoading || !selectedOption;
    bcmStatus.style.display = entry.bcmError || needsReview ? "block" : "none";
    bcmStatus.innerHTML = entry.bcmError
      ? `<strong>BCM description error:</strong> ${entry.bcmError}`
      : needsReview
        ? `<strong>Needs review:</strong> ${reviewReasons.join(" ")}`
        : "";
    renderBcmFacts(entry.bcmFacts || selectedOption, importState, reviewReasons);
  }

  select.onchange = () => {
    entry.selectedId = select.value;
    entry.selectionTouched = true;
    entry.edits = {};
    entry.bcmOpen = false;
    entry.bcmHtml = "";
    entry.bcmFacts = null;
    entry.bcmError = "";
    syncEditorInputs();
    updateCard();
  };

  cond.onchange = () => {
    entry.condition = cond.value;
  };

  editBtn.onclick = () => {
    entry.editorOpen = !entry.editorOpen;
    if (entry.editorOpen){
      syncEditorInputs();
    }
    updateCard();
  };

  async function generateBcmDescription(){
    const current = getBulkCurrentOption(entry);
    if (!current) return;

    if (entry.options.length > 1 && !entry.selectionTouched){
      alert("Pick the correct pressing from the Release Option menu before generating a BCM description.");
      return;
    }

    entry.bcmLoading = true;
    entry.bcmOpen = true;
    entry.bcmError = "";
    updateCard();

    try {
      const res = await fetch("/bcm-description/generate", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          releaseId: current.id,
          barcode: current.barcode || ""
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success){
        throw new Error(data.error || "Could not generate BCM description");
      }

      entry.bcmFacts = data.description;
      entry.bcmHtml = data.description?.descriptionHtml || "";
      bcmHtmlField.value = entry.bcmHtml;
      bcmPreview.innerHTML = entry.bcmHtml || "<p class=\"muted-note\">Preview will appear here.</p>";
    } catch (err){
      entry.bcmError = err.message;
    } finally {
      entry.bcmLoading = false;
      updateCard();
    }
  }

  async function saveBcmDescription(mode){
    const current = getBulkCurrentOption(entry);
    if (!current || !entry.bcmHtml.trim()) return;

    entry.bcmLoading = true;
    entry.bcmError = "";
    updateCard();

    try {
      const res = await fetch(
        mode === "update" ? "/bcm-description/save" : "/bcm-description/create",
        {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify({
            releaseId: current.id,
            barcode: current.barcode || "",
            bodyHtml: entry.bcmHtml,
            condition: entry.condition || "M"
          })
        }
      );

      const data = await res.json();
      if (!res.ok || !data.success){
        throw new Error(data.error || "Could not save BCM description");
      }

      await loadHistory();
      await loadImportStatus();
      alert(mode === "update" ? "Shopify description updated" : "Created in Shopify with BCM description");
    } catch (err){
      entry.bcmError = err.message;
    } finally {
      entry.bcmLoading = false;
      updateCard();
    }
  }

  bcmBtn.onclick = async () => {
    if (entry.bcmOpen && entry.bcmHtml){
      entry.bcmOpen = false;
      updateCard();
      return;
    }

    await generateBcmDescription();
  };

  bcmRegenerateBtn.onclick = generateBcmDescription;
  bcmSaveBtn.onclick = () => saveBcmDescription("update");
  bcmCreateBtn.onclick = () => saveBcmDescription("create");

  resetBtn.onclick = () => {
    entry.edits = {};
    syncEditorInputs();
    updateCard();
  };

  async function submitItem(){
    const item = buildBulkImportItem(entry);
    if (!item) return;

    await fetch("/import", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ items: [item] })
    });

    await loadImportStatus();
    alert("Added");
  }

  addBtn.onclick = submitItem;
  editorAddBtn.onclick = submitItem;

  syncEditorInputs();
  updateCard();
  container.appendChild(card);
}

function renderBulkErrorCard(entry, container){
  const card = document.createElement("article");
  card.className = "result-card";

  const head = document.createElement("div");
  head.className = "bulk-toolbar";

  const requested = document.createElement("span");
  requested.className = "chip chip-barcode";
  requested.textContent = entry.requestedInput
    ? entry.requestedKind === "release_id"
      ? `Requested Release ID ${entry.requestedInput.replace(/^.*?(\d+)$/, "$1")}`
      : `Requested UPC ${entry.requestedInput}`
    : "Requested lookup missing";

  const removeBtn = document.createElement("button");
  removeBtn.className = "ghost-btn";
  removeBtn.textContent = "Remove";
  removeBtn.onclick = () => {
    entry.removed = true;
    card.remove();
  };

  head.appendChild(requested);
  head.appendChild(removeBtn);

  const empty = document.createElement("div");
  empty.className = "empty-state";
  const title = entry.error && entry.error !== "No Discogs match found"
    ? "Could Not Prepare Match"
    : "No Discogs Match";
  empty.innerHTML = `
    <h3>${title}</h3>
    <p class="section-copy">${entry.error || "This barcode did not return a usable release."}</p>
  `;

  card.appendChild(head);
  card.appendChild(empty);
  container.appendChild(card);
}

function renderBulkCard(entry, container){
  const options = entry.options;
  const card = document.createElement("article");
  card.className = "result-card";

  const toolbar = document.createElement("div");
  toolbar.className = "bulk-toolbar";

  const requested = document.createElement("span");
  requested.className = "chip chip-barcode";

  const toolbarActions = document.createElement("div");
  toolbarActions.className = "result-actions-inline";

  const editBtn = document.createElement("button");
  editBtn.className = "ghost-btn";

  const removeBtn = document.createElement("button");
  removeBtn.className = "ghost-btn danger-btn";
  removeBtn.textContent = "Remove";

  toolbarActions.appendChild(editBtn);
  toolbarActions.appendChild(removeBtn);
  toolbar.appendChild(requested);
  toolbar.appendChild(toolbarActions);

  const preview = document.createElement("div");
  preview.className = "result-preview";

  const coverFrame = document.createElement("div");
  coverFrame.className = "cover-frame";

  const coverImage = document.createElement("img");
  coverImage.className = "cover-image";
  coverImage.alt = "Release cover";

  const coverFallback = document.createElement("span");
  coverFallback.textContent = "No Art";

  coverFrame.appendChild(coverImage);
  coverFrame.appendChild(coverFallback);

  const body = document.createElement("div");

  const title = document.createElement("h3");
  title.className = "card-title";

  const meta = document.createElement("p");
  meta.className = "card-meta";

  const detailNote = document.createElement("p");
  detailNote.className = "muted-note";
  detailNote.style.margin = "8px 0 0";

  const chips = document.createElement("div");
  chips.className = "chip-row";

  const priceChip = document.createElement("span");
  priceChip.className = "chip chip-price";

  const stockChip = document.createElement("span");

  const barcodeChip = document.createElement("span");
  barcodeChip.className = "chip chip-barcode";

  const colorChip = document.createElement("span");
  colorChip.className = "chip";

  const actionChip = document.createElement("span");
  actionChip.className = "chip";

  const reviewChip = document.createElement("span");
  reviewChip.className = "chip chip-review";

  chips.appendChild(priceChip);
  chips.appendChild(stockChip);
  chips.appendChild(barcodeChip);
  chips.appendChild(colorChip);
  chips.appendChild(actionChip);
  chips.appendChild(reviewChip);

  const copy = document.createElement("p");
  copy.className = "card-copy";

  const notesPanel = document.createElement("details");
  notesPanel.className = "notes-panel";

  const notesSummary = document.createElement("summary");
  notesSummary.className = "notes-toggle";
  notesSummary.textContent = "Release Notes";

  notesPanel.appendChild(notesSummary);
  notesPanel.appendChild(copy);

  const reviewNote = document.createElement("div");
  reviewNote.className = "review-note";

  body.appendChild(title);
  body.appendChild(meta);
  body.appendChild(detailNote);
  body.appendChild(chips);
  body.appendChild(reviewNote);

  preview.appendChild(coverFrame);
  preview.appendChild(body);

  const controls = document.createElement("div");
  controls.className = "result-controls";

  const variantField = document.createElement("div");
  variantField.className = "field-stack";

  const variantLabel = document.createElement("label");
  variantLabel.className = "field-label";
  variantLabel.textContent = "Release Option";

  const select = document.createElement("select");
  select.className = "control-input";

  options.forEach(option => {
    const item = document.createElement("option");
    item.value = option.id;
    item.textContent = buildOptionLabel(option, options[0].id);
    select.appendChild(item);
  });

  variantField.appendChild(variantLabel);
  variantField.appendChild(select);

  const conditionField = document.createElement("div");
  conditionField.className = "field-stack";

  const conditionLabel = document.createElement("label");
  conditionLabel.className = "field-label";
  conditionLabel.textContent = "Condition";

  const cond = document.createElement("select");
  cond.className = "control-input";

  ["M","NM","VG+","VG","G"].forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    cond.appendChild(option);
  });

  conditionField.appendChild(conditionLabel);
  conditionField.appendChild(cond);

  const addBtn = document.createElement("button");
  addBtn.className = "primary-btn";

  const bcmBtn = document.createElement("button");
  bcmBtn.className = "secondary-btn";

  controls.appendChild(variantField);
  controls.appendChild(conditionField);
  controls.appendChild(bcmBtn);
  controls.appendChild(addBtn);

  const editor = document.createElement("div");
  editor.className = "bulk-editor";
  editor.classList.add("details-editor");

  const editorNote = document.createElement("p");
  editorNote.className = "muted-note";
  editorNote.textContent = "Adjust any details below before adding this record to Shopify.";

  const editorGrid = document.createElement("div");
  editorGrid.className = "editor-grid";

  function createEditorField(labelText, key, { type = "text", rows = 3, wide = false, options = null } = {}){
    const field = document.createElement("div");
    field.className = `field-stack${wide ? " editor-wide" : ""}`;

    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = labelText;

    const input = type === "select"
      ? document.createElement("select")
      : type === "textarea"
      ? document.createElement("textarea")
      : document.createElement("input");

    input.className = "control-input";

    if (type === "select"){
      (options || []).forEach(optionValue => {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = optionValue;
        input.appendChild(option);
      });
    } else if (type === "textarea"){
      input.rows = rows;
    } else {
      input.type = type;
    }

    input.addEventListener("input", () => {
      entry.edits[key] = input.value;
      updateCard();
    });

    field.appendChild(label);
    field.appendChild(input);
    editorGrid.appendChild(field);
    return input;
  }

  const inputRefs = {
    title: createEditorField("Title", "title"),
    barcode: createEditorField("Barcode", "barcode"),
    basePrice: createEditorField("Price", "basePrice", { type: "number" }),
    stock: createEditorField("Stock", "stock", { type: "number" }),
    color: createEditorField("Color", "color"),
    genre: createEditorField("Genre", "genre", { type: "select", options: GENRE_OPTIONS }),
    year: createEditorField("Year", "year"),
    country: createEditorField("Country", "country"),
    label: createEditorField("Label", "label"),
    format: createEditorField("Format", "format"),
    descriptionText: createEditorField("Description", "descriptionText", { type: "textarea", rows: 5, wide: true })
  };

  const editorActions = document.createElement("div");
  editorActions.className = "result-actions-inline";

  const resetBtn = document.createElement("button");
  resetBtn.className = "ghost-btn";
  resetBtn.textContent = "Reset Edits";

  const editorRemoveBtn = document.createElement("button");
  editorRemoveBtn.className = "ghost-btn danger-btn";
  editorRemoveBtn.textContent = "Remove";
  editorRemoveBtn.style.display = "none";

  const editorAddBtn = document.createElement("button");
  editorAddBtn.className = "primary-btn";
  editorAddBtn.style.display = "none";

  editorActions.appendChild(resetBtn);
  editorActions.appendChild(editorRemoveBtn);
  editorActions.appendChild(editorAddBtn);
  editor.appendChild(editorNote);
  editor.appendChild(editorGrid);
  editor.appendChild(editorActions);

  card.appendChild(toolbar);
  card.appendChild(preview);
  card.appendChild(controls);
  card.appendChild(notesPanel);
  card.appendChild(editor);

  // BCM description feature start
  const bcmSection = document.createElement("div");
  bcmSection.className = "bulk-editor";
  bcmSection.classList.add("bcm-panel");

  const bcmIntro = document.createElement("p");
  bcmIntro.className = "muted-note";
  bcmIntro.classList.add("bcm-intro");
  bcmIntro.textContent = "Generate original Best Coast Music description copy from release facts, review it, then save only when you are ready.";

  const bcmStatus = document.createElement("div");
  bcmStatus.className = "review-note";
  bcmStatus.classList.add("bcm-status");

  const bcmFactsCard = document.createElement("div");
  bcmFactsCard.className = "status-card";
  bcmFactsCard.classList.add("bcm-facts-card");

  const bcmFactsStack = document.createElement("div");
  bcmFactsStack.className = "status-stack";
  bcmFactsCard.appendChild(bcmFactsStack);

  const bcmHtmlLabel = document.createElement("p");
  bcmHtmlLabel.className = "field-label";
  bcmHtmlLabel.classList.add("bcm-field-label");
  bcmHtmlLabel.textContent = "Editable Shopify Body HTML";

  const bcmHtmlField = document.createElement("textarea");
  bcmHtmlField.className = "control-input";
  bcmHtmlField.classList.add("bcm-html-field");
  bcmHtmlField.rows = 12;
  bcmHtmlField.placeholder = "Generated BCM HTML will appear here.";
  bcmHtmlField.addEventListener("input", () => {
    entry.bcmHtml = bcmHtmlField.value;
    bcmPreview.innerHTML = entry.bcmHtml || "<p class=\"muted-note\">Preview will appear here.</p>";
  });

  const bcmPreviewLabel = document.createElement("p");
  bcmPreviewLabel.className = "field-label";
  bcmPreviewLabel.classList.add("bcm-preview-label");
  bcmPreviewLabel.textContent = "Live Preview";

  const bcmPreview = document.createElement("div");
  bcmPreview.className = "status-card";
  bcmPreview.classList.add("bcm-preview-card");
  bcmPreview.innerHTML = "<p class=\"muted-note\">Preview will appear here.</p>";

  const bcmActions = document.createElement("div");
  bcmActions.className = "result-actions-inline";
  bcmActions.classList.add("bcm-actions");

  const bcmRegenerateBtn = document.createElement("button");
  bcmRegenerateBtn.className = "ghost-btn";
  bcmRegenerateBtn.textContent = "Regenerate";

  const bcmSaveBtn = document.createElement("button");
  bcmSaveBtn.className = "secondary-btn";

  const bcmCreateBtn = document.createElement("button");
  bcmCreateBtn.className = "primary-btn";

  bcmActions.appendChild(bcmRegenerateBtn);
  bcmActions.appendChild(bcmSaveBtn);
  bcmActions.appendChild(bcmCreateBtn);
  bcmSection.appendChild(bcmIntro);
  bcmSection.appendChild(bcmStatus);
  bcmSection.appendChild(bcmFactsCard);
  bcmSection.appendChild(bcmHtmlLabel);
  bcmSection.appendChild(bcmHtmlField);
  bcmSection.appendChild(bcmPreviewLabel);
  bcmSection.appendChild(bcmPreview);
  bcmSection.appendChild(bcmActions);
  card.appendChild(bcmSection);
  // BCM description feature end

  function syncEditorInputs(){
    const current = getBulkCurrentOption(entry);
    if (!current) return;

    inputRefs.title.value = entry.edits.title !== undefined ? entry.edits.title : (current.title || "");
    inputRefs.barcode.value = entry.edits.barcode !== undefined ? entry.edits.barcode : (current.barcode || "");
    inputRefs.basePrice.value = entry.edits.basePrice !== undefined ? entry.edits.basePrice : formatMoney(current.basePrice);
    inputRefs.stock.value = entry.edits.stock !== undefined ? entry.edits.stock : String(current.stock ?? 0);
    inputRefs.color.value = entry.edits.color !== undefined ? entry.edits.color : (current.color || "");
    inputRefs.genre.value = entry.edits.genre !== undefined ? entry.edits.genre : (current.genre || "");
    inputRefs.year.value = entry.edits.year !== undefined ? entry.edits.year : (current.year || "");
    inputRefs.country.value = entry.edits.country !== undefined ? entry.edits.country : (current.country || "");
    inputRefs.label.value = entry.edits.label !== undefined ? entry.edits.label : (current.label || "");
    inputRefs.format.value = entry.edits.format !== undefined ? entry.edits.format : (current.format || "");
    inputRefs.descriptionText.value = entry.edits.descriptionText !== undefined
      ? entry.edits.descriptionText
      : (current.descriptionText || "");
  }

  // BCM description feature start
  function renderBcmFacts(source, importState, reviewReasons){
    renderBcmFactGrid(bcmFactsStack, source, importState, reviewReasons);
  }
  // BCM description feature end

  function updateCard(){
    const current = getBulkPreview(entry);
    if (!current) return;
    const selectedOption = getBulkCurrentOption(entry);

    const stock = Number(current.stock || 0);
    const importState = getBulkImportState(entry);
    const reviewState = getBulkReviewState(entry);
    const requiresSelection = entry.options.length > 1 && !entry.selectionTouched;
    const reviewReasons = [...reviewState.reasons];

    if (requiresSelection){
      reviewReasons.unshift("Multiple Discogs matches were found. Choose the exact pressing before importing or saving BCM copy.");
    }

    const needsReview = reviewReasons.length > 0;
    requested.textContent = entry.requestedInput
      ? entry.requestedKind === "release_id"
        ? `Requested Release ID ${entry.requestedInput.replace(/^.*?(\d+)$/, "$1")}`
        : `Requested UPC ${entry.requestedInput}`
      : "Requested lookup missing";

    title.textContent = current.title || "Untitled release";
    meta.textContent =
      [current.year, current.country, current.label, current.format]
        .filter(Boolean)
        .join(" • ") || "Discogs match";
    detailNote.textContent = [
      current.catalogNumber ? `Catalog ${current.catalogNumber}` : null,
      current.pressingDetails || null,
      current.identifierSummary || null
    ].filter(Boolean).join(" • ");
    detailNote.style.display = detailNote.textContent ? "block" : "none";

    priceChip.textContent = `$${formatMoney(current.basePrice)}`;
    barcodeChip.textContent = current.barcode ? `UPC ${current.barcode}` : "No barcode";
    colorChip.textContent = `${titleCase(current.color || "black")} vinyl`;
    actionChip.className = `chip chip-action-${importState.tone}`;
    actionChip.textContent = importState.label;
    stockChip.className = `chip chip-stock ${stock > 0 ? "in-stock" : "out-stock"}`;
    stockChip.textContent = stock > 0 ? `${stock} in stock` : "Out of stock";

    copy.textContent =
      current.descriptionText ||
      "No additional Discogs description was available for this release.";
    notesPanel.style.display = current.descriptionText ? "block" : "none";

    card.classList.toggle("needs-review", needsReview);
    reviewChip.style.display = needsReview ? "inline-flex" : "none";
    reviewChip.textContent = "Needs Review";
    reviewNote.style.display = needsReview ? "block" : "none";
    reviewNote.innerHTML = needsReview
      ? `<strong>Review before import:</strong> ${reviewReasons.join(" ")}`
      : "";

    if (current.image){
      coverImage.src = current.image;
      coverImage.style.display = "block";
      coverFallback.style.display = "none";
    } else {
      coverImage.removeAttribute("src");
      coverImage.style.display = "none";
      coverFallback.style.display = "inline";
    }

    editBtn.textContent = entry.editorOpen ? "Hide Edit Details" : "Edit Details";
    bcmBtn.textContent = requiresSelection
      ? "Choose Pressing Then Generate"
      : entry.bcmOpen && entry.bcmHtml
        ? "Hide BCM Description"
        : "Generate BCM Description";
    editor.classList.toggle("open", entry.editorOpen);
    bcmSection.classList.toggle("open", entry.bcmOpen);
    select.value = entry.selectedId;
    cond.value = entry.condition;

    addBtn.disabled = stock <= 0 || requiresSelection;
    addBtn.textContent = requiresSelection
      ? "Choose Pressing First"
      : stock <= 0
        ? "Out of Stock"
        : "Add To Shopify";
    addBtn.style.display = entry.editorOpen || entry.bcmOpen ? "none" : "inline-flex";
    removeBtn.style.display = entry.editorOpen ? "none" : "inline-flex";
    editorAddBtn.disabled = stock <= 0 || requiresSelection;
    editorAddBtn.textContent = requiresSelection
      ? "Choose Pressing First"
      : stock <= 0
        ? "Out of Stock"
        : "Add To Shopify";
    editorAddBtn.style.display = entry.editorOpen && !entry.bcmOpen ? "inline-flex" : "none";
    editorRemoveBtn.style.display = entry.editorOpen ? "inline-flex" : "none";
    bcmBtn.disabled = entry.bcmLoading || requiresSelection;
    bcmSaveBtn.style.display = importState.tone === "update" ? "inline-flex" : "none";
    bcmCreateBtn.style.display = importState.tone === "update" ? "none" : "inline-flex";
    bcmSaveBtn.textContent = entry.bcmLoading ? "Saving..." : "Update Shopify Description Only";
    bcmCreateBtn.textContent = entry.bcmLoading ? "Creating..." : "Create In Shopify With BCM Description";
    bcmSaveBtn.disabled = entry.bcmLoading || requiresSelection || !entry.bcmHtml.trim();
    bcmCreateBtn.disabled = entry.bcmLoading || requiresSelection || !entry.bcmHtml.trim();
    bcmRegenerateBtn.disabled = entry.bcmLoading || !selectedOption;
    bcmStatus.style.display = entry.bcmError || needsReview ? "block" : "none";
    bcmStatus.innerHTML = entry.bcmError
      ? `<strong>BCM description error:</strong> ${entry.bcmError}`
      : needsReview
        ? `<strong>Needs review:</strong> ${reviewReasons.join(" ")}`
        : "";
    renderBcmFacts(entry.bcmFacts || selectedOption, importState, reviewReasons);
  }

  select.onchange = () => {
    entry.selectedId = select.value;
    entry.selectionTouched = true;
    entry.edits = {};
    entry.bcmOpen = false;
    entry.bcmHtml = "";
    entry.bcmFacts = null;
    entry.bcmError = "";
    syncEditorInputs();
    updateCard();
  };

  cond.onchange = () => {
    entry.condition = cond.value;
  };

  editBtn.onclick = () => {
    entry.editorOpen = !entry.editorOpen;
    if (entry.editorOpen){
      syncEditorInputs();
    }
    updateCard();
  };

  async function generateBcmDescription(){
    const current = getBulkCurrentOption(entry);
    if (!current) return;

    if (entry.options.length > 1 && !entry.selectionTouched){
      alert("Pick the correct pressing from the Release Option menu before generating a BCM description.");
      return;
    }

    entry.bcmLoading = true;
    entry.bcmOpen = true;
    entry.bcmError = "";
    updateCard();

    try {
      const res = await fetch("/bcm-description/generate", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          releaseId: current.id,
          barcode: current.barcode || ""
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success){
        throw new Error(data.error || "Could not generate BCM description");
      }

      entry.bcmFacts = data.description;
      entry.bcmHtml = data.description?.descriptionHtml || "";
      bcmHtmlField.value = entry.bcmHtml;
      bcmPreview.innerHTML = entry.bcmHtml || "<p class=\"muted-note\">Preview will appear here.</p>";
    } catch (err){
      entry.bcmError = err.message;
    } finally {
      entry.bcmLoading = false;
      updateCard();
    }
  }

  async function saveBcmDescription(mode){
    const current = getBulkCurrentOption(entry);
    if (!current || !entry.bcmHtml.trim()) return;

    entry.bcmLoading = true;
    entry.bcmError = "";
    updateCard();

    try {
      const res = await fetch(
        mode === "update" ? "/bcm-description/save" : "/bcm-description/create",
        {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify({
            releaseId: current.id,
            barcode: current.barcode || "",
            bodyHtml: entry.bcmHtml,
            condition: entry.condition || "M"
          })
        }
      );

      const data = await res.json();
      if (!res.ok || !data.success){
        throw new Error(data.error || "Could not save BCM description");
      }

      await loadHistory();
      await loadImportStatus();
      alert(mode === "update" ? "Shopify description updated" : "Created in Shopify with BCM description");
    } catch (err){
      entry.bcmError = err.message;
    } finally {
      entry.bcmLoading = false;
      updateCard();
    }
  }

  function removeCurrentCard(){
    entry.removed = true;
    card.remove();
  }

  removeBtn.onclick = removeCurrentCard;
  editorRemoveBtn.onclick = removeCurrentCard;
  bcmBtn.onclick = async () => {
    if (entry.bcmOpen && entry.bcmHtml){
      entry.bcmOpen = false;
      updateCard();
      return;
    }

    await generateBcmDescription();
  };

  bcmRegenerateBtn.onclick = generateBcmDescription;
  bcmSaveBtn.onclick = () => saveBcmDescription("update");
  bcmCreateBtn.onclick = () => saveBcmDescription("create");

  resetBtn.onclick = () => {
    entry.edits = {};
    syncEditorInputs();
    updateCard();
  };

  async function submitItem(){
    const item = buildBulkImportItem(entry);
    if (!item) return;

    await fetch("/import", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ items: [item] })
    });

    await loadImportStatus();
    alert("Added");
  }

  addBtn.onclick = submitItem;
  editorAddBtn.onclick = submitItem;

  syncEditorInputs();
  updateCard();
  container.appendChild(card);
}

async function startCamera(){
  const video = document.getElementById("camera");
  video.style.display = "block";

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:"environment" }
    });

    video.srcObject = stream;
    video.play();
    scanFrame();
  } catch {
    alert("Camera not supported");
  }
}

async function scanFrame(){
  const video = document.getElementById("camera");

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.drawImage(video, 0, 0);

    if ("BarcodeDetector" in window){
      const detector = new BarcodeDetector({ formats:["ean_13","upc_a"] });
      const codes = await detector.detect(canvas);

      if (codes.length){
        document.getElementById("barcode").value = codes[0].rawValue;
        stopCamera();
        scan();
        return;
      }
    }
  }

  requestAnimationFrame(scanFrame);
}

function stopCamera(){
  const video = document.getElementById("camera");
  video.style.display = "none";

  if (stream){
    stream.getTracks().forEach(track => track.stop());
  }
}

async function loadHistory(){
  const res = await fetch("/history");
  const data = await res.json();

  const box = document.getElementById("history");
  if (!box) return;

  box.innerHTML = "";

  const items = (data.history || []).slice(-12).reverse();
  if (!items.length){
    renderEmptyState(
      box,
      "Nothing added yet",
      "Your most recent Shopify imports will show up here."
    );
    return;
  }

  items.forEach(item => {
    const card = document.createElement("article");
    card.className = "history-item";

    const heading = document.createElement("h3");
    heading.className = "history-title";
    heading.textContent = item.title || "Untitled release";

    const meta = document.createElement("p");
    meta.className = "history-meta";

    const parts = [
      `$${formatMoney(item.basePrice || item.price)}`,
      item.syncAction ? titleCase(item.syncAction) : null,
      item.condition || "M",
      item.stock > 0 ? `${item.stock} synced` : "0 stock",
      item.barcode ? `UPC ${item.barcode}` : null,
      item.syncedAt ? formatTimestamp(item.syncedAt) : null
    ].filter(Boolean);

    meta.textContent = parts.join(" • ");

    card.appendChild(heading);
    card.appendChild(meta);
    box.appendChild(card);
  });
}
