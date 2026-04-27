console.log("POS UI FULL");

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
// SCAN (FULL POS)
// ----------------------------
async function scan(){

  const barcode = document.getElementById("barcode").value;

  if (!barcode){
    alert("Enter barcode");
    return;
  }

  const res = await fetch("/search", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ barcode })
  });

  const data = await res.json();

  const box = document.getElementById("results");
  box.innerHTML = "";

  if (!data.results || data.results.length === 0){
    box.innerHTML = "<p>No results</p>";
    return;
  }

  const options = data.results;
  const best = options[0];

  const div = document.createElement("div");
  div.className = "card";

  div.innerHTML = `
    <img src="${best.image || ""}" width="60"/>
    <b>${best.title}</b><br/>
    ${best.year || ""} • ${best.country || ""}<br/>
    <span style="color:#00e676">${best.color || "Black"} Vinyl</span>
  `;

  // VARIANTS
  const select = document.createElement("select");

  options.forEach(opt=>{
    const o = document.createElement("option");
    o.value = opt.id;

    o.textContent =
      (opt.id === best.id ? "⭐ " : "") +
      `${opt.title} (${opt.year || "?"} • ${opt.country || "?"} • ${opt.color || "Black"})`;

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

  // ADD
  const btn = document.createElement("button");
  btn.textContent = "Add";

  btn.onclick = async ()=>{
    const res = await fetch("/import", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        items:[{ id: select.value, condition: cond.value }]
      })
    });

    const data = await res.json();

    if (data.duplicates && data.duplicates.length){
      alert("Duplicate");
    } else {
      alert("Added");
    }
  };

  div.appendChild(select);
  div.appendChild(cond);
  div.appendChild(btn);

  box.appendChild(div);
}

// ----------------------------
// BULK
// ----------------------------
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
    <div style="background:#333;height:20px;border-radius:10px;">
      <div id="progressBar" style="height:20px;width:0%;background:#00e676;border-radius:10px;"></div>
    </div>
    <p id="progressText">0%</p>
  `;

  pollBulk(jobId);
}

async function pollBulk(jobId){
  const res = await fetch("/bulk-status/" + jobId);
  const data = await res.json();

  document.getElementById("progressBar").style.width = data.progress + "%";
  document.getElementById("progressText").innerText = data.progress + "%";

  if (data.progress < 100){
    setTimeout(()=>pollBulk(jobId), 1000);
  }
}

// ----------------------------
// HISTORY
// ----------------------------
async function loadHistory(){
  try {
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
        $${item.price} • ${item.condition}<br/>
        <span style="color:#00e676">${item.color}</span>
      `;

      box.appendChild(div);
    });

  } catch {}
}

// ----------------------------
// CAMERA (FULL)
// ----------------------------
let stream;

async function startCamera(){

  const video = document.getElementById("camera");

  video.style.display = "block";

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
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

    if ("BarcodeDetector" in window) {

      const detector = new BarcodeDetector({
        formats: ["ean_13","upc_a"]
      });

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
    stream.getTracks().forEach(t => t.stop());
  }
}
