console.log("APP JS LOADED");

window.onload = function(){

  console.log("WINDOW LOADED");

  document.getElementById("scanBtn").onclick = scan;
  document.getElementById("bulkBtn").onclick = bulk;
  document.getElementById("cameraBtn").onclick = startCamera;

};

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
      "<img src='" + (r.thumb || "") + "' width='60'/>" +
      "<b>" + r.title + "</b><br/>" +
      (r.year || "") + " • " + (r.country || "") + "<br/>" +
      "<small>" + (r.label || "") + "</small><br/>" +
      "<small>" + (r.format || "") + "</small>";

    div.onclick = () => importItem(r.id);

    box.appendChild(div);
  });
}

// ----------------------------
// IMPORT (WITH DUPLICATE ALERT)
// ----------------------------
async function importItem(id){
  const condition = document.getElementById("condition").value;

  const res = await fetch("/import", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      items:[{ id, condition }]
    })
  });

  const data = await res.json();

  if (data.duplicates && data.duplicates.length > 0) {
    alert("⚠️ Duplicate already added!");
  }
}

// ----------------------------
// BULK PREVIEW (MULTI OPTION)
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
  box.innerHTML = "<h4>Bulk Preview (Choose Pressing)</h4>";

  data.results.forEach((item,i) => {

    const div = document.createElement("div");
    div.className = "card";

    const img = document.createElement("img");
    img.src = item.options[0]?.thumb || "";
    img.width = 60;

    const selectRelease = document.createElement("select");
    selectRelease.id = "release-" + i;

    item.options.forEach(opt => {
      const o = document.createElement("option");
      o.value = opt.id;
      o.textContent =
        opt.title + " (" +
        (opt.year || "") + " • " +
        (opt.country || "") + ")";
      selectRelease.appendChild(o);
    });

    selectRelease.onchange = function(){
      const selected = item.options.find(o => o.id == selectRelease.value);
      img.src = selected?.thumb || "";
    };

    const selectCondition = document.createElement("select");
    selectCondition.id = "cond-" + i;

    ["M","NM","VG+","VG","G"].forEach(c => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      selectCondition.appendChild(o);
    });

    const btn = document.createElement("button");
    btn.textContent = "Add to Queue";

    btn.onclick = async () => {

      const id = selectRelease.value;
      const condition = selectCondition.value;

      const res = await fetch("/import", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          items:[{ id, condition }]
        })
      });

      const data = await res.json();

      if (data.duplicates && data.duplicates.length > 0) {
        alert("⚠️ Duplicate skipped!");
      }
    };

    div.appendChild(img);
    div.appendChild(selectRelease);
    div.appendChild(selectCondition);
    div.appendChild(btn);

    box.appendChild(div);
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
