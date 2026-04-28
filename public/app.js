console.log("POS FINAL STABLE");

let bulkItems = [];
let bulkRenderedCount = 0;
let stream;

window.onload = function(){
  document.getElementById("scanBtn").onclick = scan;
  document.getElementById("bulkBtn").onclick = startBulk;
  document.getElementById("cameraBtn").onclick = startCamera;
  document.getElementById("syncNowBtn").onclick = runInventorySync;
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
  setInterval(loadHistory, 2000);
  setInterval(loadSyncStatus, 5000);
};

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

function buildBulkEntry(result, index){
  const firstOption = result.options?.[0] || null;

  return {
    key: `${index}:${result.barcode || firstOption?.barcode || "unknown"}`,
    requestedBarcode: result.barcode || "",
    options: result.options || [],
    selectedId: firstOption?.id || "",
    condition: "M",
    removed: false,
    editorOpen: false,
    edits: {},
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

function buildBulkImportItem(entry){
  if (entry.removed) return null;

  const current = getBulkCurrentOption(entry);
  const preview = getBulkPreview(entry);
  if (!current || !preview) return null;

  return {
    id: current.id,
    condition: entry.condition || "M",
    barcode: preview.barcode || current.barcode,
    overrides: {
      title: preview.title,
      barcode: preview.barcode || current.barcode,
      basePrice: preview.basePrice,
      stock: preview.stock,
      color: preview.color,
      genre: preview.genre,
      year: preview.year,
      country: preview.country,
      label: preview.label,
      format: preview.format,
      descriptionText: preview.descriptionText
    }
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

async function loadSyncStatus(){
  try {
    const res = await fetch("/sync-status");
    const data = await res.json();
    renderSyncStatus(data.sync || {});
  } catch {
    renderSyncStatus({
      error: "Could not load sync status"
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
  if (!barcode) return alert("Enter barcode");

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
      "Try another barcode or confirm the UPC is in Discogs."
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
    .filter(item => item && Number(item.overrides.stock ?? 0) > 0);

  if (!items.length){
    alert("No kept items in stock");
    return;
  }

  await fetch("/import", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ items })
  });

  alert(`Queued ${items.length} bulk item${items.length === 1 ? "" : "s"}`);
}

function renderCard(options, container){
  const card = document.createElement("article");
  card.className = "result-card";

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

  const chips = document.createElement("div");
  chips.className = "chip-row";

  const priceChip = document.createElement("span");
  priceChip.className = "chip chip-price";

  const stockChip = document.createElement("span");

  const barcodeChip = document.createElement("span");
  barcodeChip.className = "chip chip-barcode";

  const colorChip = document.createElement("span");
  colorChip.className = "chip";

  chips.appendChild(priceChip);
  chips.appendChild(stockChip);
  chips.appendChild(barcodeChip);
  chips.appendChild(colorChip);

  const copy = document.createElement("p");
  copy.className = "card-copy";

  body.appendChild(title);
  body.appendChild(meta);
  body.appendChild(chips);
  body.appendChild(copy);

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

  controls.appendChild(variantField);
  controls.appendChild(conditionField);
  controls.appendChild(addBtn);

  card.appendChild(preview);
  card.appendChild(controls);

  function getCurrentOption(){
    return options.find(option => String(option.id) === String(select.value)) || options[0];
  }

  function updateCard(){
    const current = getCurrentOption();
    const stock = Number(current.stock || 0);

    title.textContent = current.title || "Untitled release";
    meta.textContent =
      [current.year, current.country, current.label, current.format]
        .filter(Boolean)
        .join(" • ") || "Discogs match";

    priceChip.textContent = `$${formatMoney(current.basePrice)}`;
    barcodeChip.textContent = current.barcode ? `UPC ${current.barcode}` : "No barcode";
    colorChip.textContent = `${titleCase(current.color || "black")} vinyl`;
    stockChip.className = `chip chip-stock ${stock > 0 ? "in-stock" : "out-stock"}`;
    stockChip.textContent = stock > 0 ? `${stock} in stock` : "Out of stock";

    copy.textContent =
      current.descriptionText ||
      "No additional Discogs description was available for this release.";

    if (current.image){
      coverImage.src = current.image;
      coverImage.style.display = "block";
      coverFallback.style.display = "none";
    } else {
      coverImage.removeAttribute("src");
      coverImage.style.display = "none";
      coverFallback.style.display = "inline";
    }

    addBtn.disabled = stock <= 0;
    addBtn.textContent = stock <= 0 ? "Out of Stock" : "Add to Shopify";
  }

  select.onchange = updateCard;

  addBtn.onclick = async ()=>{
    const current = getCurrentOption();

    await fetch("/import", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        items:[{
          id: current.id,
          condition: cond.value,
          barcode: current.barcode
        }]
      })
    });

    alert("Added");
  };

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
  requested.textContent = entry.requestedBarcode ? `Requested UPC ${entry.requestedBarcode}` : "Requested UPC missing";

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
  empty.innerHTML = `
    <h3>No Discogs match</h3>
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

  const chips = document.createElement("div");
  chips.className = "chip-row";

  const priceChip = document.createElement("span");
  priceChip.className = "chip chip-price";

  const stockChip = document.createElement("span");

  const barcodeChip = document.createElement("span");
  barcodeChip.className = "chip chip-barcode";

  const colorChip = document.createElement("span");
  colorChip.className = "chip";

  chips.appendChild(priceChip);
  chips.appendChild(stockChip);
  chips.appendChild(barcodeChip);
  chips.appendChild(colorChip);

  const copy = document.createElement("p");
  copy.className = "card-copy";

  body.appendChild(title);
  body.appendChild(meta);
  body.appendChild(chips);
  body.appendChild(copy);

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

  controls.appendChild(variantField);
  controls.appendChild(conditionField);
  controls.appendChild(addBtn);

  const editor = document.createElement("div");
  editor.className = "bulk-editor";

  const editorNote = document.createElement("p");
  editorNote.className = "muted-note";
  editorNote.textContent = "Adjust any details below before adding this record to Shopify.";

  const editorGrid = document.createElement("div");
  editorGrid.className = "editor-grid";

  function createEditorField(labelText, key, { type = "text", rows = 3, wide = false } = {}){
    const field = document.createElement("div");
    field.className = `field-stack${wide ? " editor-wide" : ""}`;

    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = labelText;

    const input = type === "textarea"
      ? document.createElement("textarea")
      : document.createElement("input");

    input.className = "control-input";

    if (type === "textarea"){
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
    genre: createEditorField("Genre", "genre"),
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

  editorActions.appendChild(resetBtn);
  editor.appendChild(editorNote);
  editor.appendChild(editorGrid);
  editor.appendChild(editorActions);

  card.appendChild(toolbar);
  card.appendChild(preview);
  card.appendChild(controls);
  card.appendChild(editor);

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

  function updateCard(){
    const current = getBulkPreview(entry);
    if (!current) return;

    const stock = Number(current.stock || 0);
    requested.textContent = entry.requestedBarcode
      ? `Requested UPC ${entry.requestedBarcode}`
      : "Requested UPC missing";

    title.textContent = current.title || "Untitled release";
    meta.textContent =
      [current.year, current.country, current.label, current.format]
        .filter(Boolean)
        .join(" • ") || "Discogs match";

    priceChip.textContent = `$${formatMoney(current.basePrice)}`;
    barcodeChip.textContent = current.barcode ? `UPC ${current.barcode}` : "No barcode";
    colorChip.textContent = `${titleCase(current.color || "black")} vinyl`;
    stockChip.className = `chip chip-stock ${stock > 0 ? "in-stock" : "out-stock"}`;
    stockChip.textContent = stock > 0 ? `${stock} in stock` : "Out of stock";

    copy.textContent =
      current.descriptionText ||
      "No additional Discogs description was available for this release.";

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
    editor.classList.toggle("open", entry.editorOpen);
    select.value = entry.selectedId;
    cond.value = entry.condition;

    addBtn.disabled = stock <= 0;
    addBtn.textContent = stock <= 0 ? "Out of Stock" : "Add To Shopify";
  }

  select.onchange = () => {
    entry.selectedId = select.value;
    entry.edits = {};
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

  removeBtn.onclick = () => {
    entry.removed = true;
    card.remove();
  };

  resetBtn.onclick = () => {
    entry.edits = {};
    syncEditorInputs();
    updateCard();
  };

  addBtn.onclick = async ()=>{
    const item = buildBulkImportItem(entry);
    if (!item) return;

    await fetch("/import", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ items: [item] })
    });

    alert("Added");
  };

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
      item.condition || "NM",
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
