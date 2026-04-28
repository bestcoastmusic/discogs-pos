console.log("POS STOCK + BULK PRO");

// ----------------------------
// INIT
// ----------------------------
window.onload = function(){
  document.getElementById("scanBtn").onclick = scan;
  document.getElementById("bulkBtn").onclick = startBulk;
  document.getElementById("cameraBtn").onclick = startCamera;

  loadHistory();
  setInterval(loadHistory, 2000);
};

// ----------------------------
// SCAN
// ----------------------------
async function scan(){

  const barcode = document.getElementById("barcode").value;
  if (!barcode) return alert("Enter barcode");

  const res = await fetch("/search", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ barcode })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "";

  if (!data.results?.length){
    box.innerHTML = "<p>No results</p>";
    return;
  }

  renderCard(data.results, box);
}

// ----------------------------
// BULK
// ----------------------------
let bulkItems = [];

async function startBulk(){

  const lines = document.getElementById("bulk").value
    .split("\n")
    .filter(Boolean);

  const res = await fetch("/bulk-start", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items: lines })
  });

  const { jobId } = await res.json();

  const box = document.getElementById("results");

  box.innerHTML = `
    <h3>Processing...</h3>
    <div style="background:#333;height:20px;">
      <div id="progressBar" style="height:20px;width:0%;background:#00e676;"></div>
    </div>
    <button id="addAllBtn" style="margin-top:10px;">Add All Available</button>
    <div id="bulkResults"></div>
  `;

  document.getElementById("addAllBtn").onclick = addAllBulk;

  pollBulk(jobId);
}

async function pollBulk(jobId){

  const res = await fetch("/bulk-status/" + jobId);
  const data = await res.json();

  document.getElementById("progressBar").style.width = data.progress + "%";

  const container = document.getElementById("bulkResults");
  container.innerHTML = "";

  bulkItems = [];

  data.results.forEach(item=>{
    if (!item.options?.length) return;

    bulkItems.push(item.options[0]); // store best option
    renderCard(item.options, container);
  });

  if (data.progress < 100){
    setTimeout(()=>pollBulk(jobId), 1000);
  }
}

// ----------------------------
// ADD ALL BULK
// ----------------------------
async function addAllBulk(){

  const items = bulkItems
    .filter(i => (i.stock ?? 0) > 0)
    .map(i => ({
      id: i.id,
      condition: "NM",
      barcode: i.barcode
    }));

  if (!items.length){
    alert("No items in stock");
    return;
  }

  await fetch("/import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items })
  });

  alert("Added all in-stock items");
}

// ----------------------------
// CARD
// ----------------------------
function renderCard(options, container){

  const best = options[0];

  const card = document.createElement("div");
  card.className = "card";

  const stock = best.stock ?? 0;
  const price = best.basePrice ?? 0;

  const out = stock <= 0;

  // INFO
  const info = document.createElement("div");

  info.innerHTML = `
    <img src="${best.image || ""}" width="70"/>
    <div>
      <b>${best.title}</b><br/>
      ${best.year || ""} • ${best.country || ""}<br/>
      <span style="color:#00e676">${best.color || "Black"} Vinyl</span><br/>
      <b>$${price}</b> • 
      <span style="color:${out ? "red" : "#00e676"}">
        ${out ? "Out of Stock" : stock + " in stock"}
      </span>
    </div>
  `;

  // VARIANT SELECT
  const select = document.createElement("select");

  options.forEach(opt=>{
    const o = document.createElement("option");
    o.value = opt.id;
    o.dataset.barcode = opt.barcode || "";

    o.textContent =
      (opt.id === best.id ? "⭐ " : "") +
      `${opt.title}`;

    select.appendChild(o);
  });

  // CONDITION
  const cond = document.createElement("select");

  ["M","NM","VG+","VG","G"].forEach(c=>{
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    cond.appendChild(o);
  });

  // ADD BUTTON
  const btn = document.createElement("button");
  btn.textContent = out ? "Out of Stock" : "Add";
  btn.disabled = out;

  btn.onclick = async ()=>{
    await fetch("/import", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        items:[{
          id: select.value,
          condition: cond.value,
          barcode: select.options[select.selectedIndex].dataset.barcode
        }]
      })
    });

    alert("Added");
  };

  card.appendChild(info);
  card.appendChild(select);
  card.appendChild(cond);
  card.appendChild(btn);

  container.appendChild(card);
}

// ----------------------------
// CAMERA
// ----------------------------
let stream;

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

    ctx.drawImage(video,0,0);

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
    stream.getTracks().forEach(t=>t.stop());
  }
}

// ----------------------------
// HISTORY
// ----------------------------
async function loadHistory(){
  const res = await fetch("/history");
  const data = await res.json();

  const box = document.getElementById("history");
  if (!box) return;

  box.innerHTML = "<h3>Recent Adds</h3>";

  data.history.slice().reverse().forEach(item=>{
    const div = document.createElement("div");
    div.className = "card";

    div.innerHTML = `
      <b>${item.title}</b><br/>
      $${item.price} • ${item.condition}
    `;

    box.appendChild(div);
  });
}
