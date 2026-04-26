k// ----------------------------
// BUTTONS
// ----------------------------
document.getElementById("scanBtn").addEventListener("click", scan);
document.getElementById("bulkBtn").addEventListener("click", bulk);
document.getElementById("cameraBtn").addEventListener("click", startCamera);

// ----------------------------
// SCAN
// ----------------------------
async function scan(){
  const barcode = document.getElementById("barcode").value;

  const res = await fetch("/search", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ barcode })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "";

  data.results.forEach(r => {
    const div = document.createElement("div");
    div.className = "card";

    div.innerHTML =
      "<img src='" + (r.thumb || "") + "' width='50'/>" +
      "<b>" + r.title + "</b><br/>" +
      (r.year || "") + " • " + (r.country || "") + "<br/>" +
      "<small>" + (r.label || "") + "</small><br/>" +
      "<small>" + (r.format || "") + "</small>";

    div.onclick = () => importItem(r.id);

    box.appendChild(div);
  });
}

// ----------------------------
// IMPORT
// ----------------------------
async function importItem(id){
  const condition = document.getElementById("condition").value;

  await fetch("/import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      items:[{ id, condition }]
    })
  });
}

// ----------------------------
// BULK
// ----------------------------
async function bulk(){
  const lines = document.getElementById("bulk").value
    .split("\n")
    .filter(Boolean);

  const res = await fetch("/bulk-preview", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items: lines })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "<h4>Bulk Preview</h4>";

  data.results.forEach((r,i) => {

    const div = document.createElement("div");
    div.className = "card";

    const title = document.createElement("div");
    title.innerHTML =
      "<img src='" + (r.thumb || "") + "' width='50'/>" +
      "<b>" + (r.title || "Unknown") + "</b><br/>" +
      (r.year || "") + " • " + (r.country || "");

    const select = document.createElement("select");
    select.id = "c-" + i;

    ["M","NM","VG+","VG","G"].forEach(c => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      select.appendChild(opt);
    });

    const btn = document.createElement("button");
    btn.textContent = "Add to Queue";

    btn.addEventListener("click", () => {
      confirmBulk(r.id, i);
    });

    div.appendChild(title);
    div.appendChild(select);
    div.appendChild(btn);

    box.appendChild(div);
  });
}

// ----------------------------
// BULK CONFIRM
// ----------------------------
async function confirmBulk(id,i){
  const condition = document.getElementById("c-" + i).value;

  await fetch("/import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      items:[{ id, condition }]
    })
  });
}

// ----------------------------
// CAMERA
// ----------------------------
let stream;

async function startCamera(){
  const video = document.getElementById("camera");

  video.style.display = "block";

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" }
  });

  video.srcObject = stream;
  video.play();

  scanFrame();
}

async function scanFrame(){
  const video = document.getElementById("camera");

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.drawImage(video, 0, 0);

    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['ean_13','upc_a'] });

      try {
        const barcodes = await detector.detect(canvas);

        if (barcodes.length > 0) {
          const code = barcodes[0].rawValue;

          document.getElementById("barcode").value = code;

          stopCamera();

          scan();
          return;
        }
      } catch {}
    }
  }

  requestAnimationFrame(scanFrame);
}

function stopCamera(){
  const video = document.getElementById("camera");

  video.style.display = "none";

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
}

// ----------------------------
// LIVE FEED
// ----------------------------
async function load(){
  const res = await fetch("/history");
  const data = await res.json();

  const log = document.getElementById("log");
  log.innerHTML = "";

  (data.history || []).slice().reverse().forEach(i => {
    const div = document.createElement("div");
    div.className = "card";

    div.textContent =
      i.artist + " - " +
      i.title + " $" +
      i.price;

    log.appendChild(div);
  });
}

setInterval(load,2000);
load();
