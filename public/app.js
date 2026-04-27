console.log("PRO POS UI READY");

// ----------------------------
// INIT
// ----------------------------
window.onload = function(){
  document.getElementById("scanBtn").onclick = scan;
  document.getElementById("bulkBtn").onclick = startBulk;
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

  data.results.forEach(r=>{
    const div = document.createElement("div");
    div.className = "card";

    div.innerHTML =
      "<img src='"+(r.thumb || r.image || "")+"' width='60'/>" +
      "<b>"+(r.title || "")+"</b><br/>" +
      (r.year || "") + " • " + (r.country || "") + "<br/>" +
      "<span style='color:#00e676'>" + (r.color || "Black") + " Vinyl</span>";

    box.appendChild(div);
  });
}

// ----------------------------
// BULK START
// ----------------------------
async function startBulk(){

  console.log("START BULK CLICKED");

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
    <h3>Processing Bulk...</h3>
    <div style="background:#333;height:20px;border-radius:10px;margin-bottom:10px;">
      <div id="progressBar" style="height:20px;width:0%;background:#00e676;border-radius:10px;"></div>
    </div>
    <p id="progressText">0%</p>
    <div id="bulkResults"></div>
  `;

  pollBulk(jobId);
}

// ----------------------------
// POLL BULK STATUS
// ----------------------------
async function pollBulk(jobId){

  const res = await fetch("/bulk-status/" + jobId);
  const data = await res.json();

  // progress bar
  const bar = document.getElementById("progressBar");
  const text = document.getElementById("progressText");

  if (bar) bar.style.width = data.progress + "%";
  if (text) text.innerText = data.progress + "%";

  const container = document.getElementById("bulkResults");
  container.innerHTML = "";

  data.results.forEach((item)=>{

    const div = document.createElement("div");
    div.className = "card";

    const best = item.best;

    // IMAGE (fixed)
    const img = document.createElement("img");
    img.src = best?.image || item.options?.[0]?.image || "";
    img.width = 60;

    // INFO TEXT (NEW — THIS FIXES YOUR BLANK UI)
    const info = document.createElement("div");

    info.innerHTML =
      "<b>" + (best?.title || "Loading...") + "</b><br/>" +
      (best?.year || "") + " • " + (best?.country || "") + "<br/>" +
      "<span style='color:#00e676'>" + (best?.color || "Black") + " Vinyl</span>";

    // DROPDOWN
    const select = document.createElement("select");

    item.options.forEach(opt=>{
      const o = document.createElement("option");
      o.value = opt.id;

      o.textContent =
        (opt.title || "Unknown") + " (" +
        (opt.year || "?") + " • " +
        (opt.country || "?") + " • " +
        (opt.color || "Black") + ")";

      if (best && opt.id === best.id){
        o.textContent = "⭐ " + o.textContent;
      }

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
    btn.textContent = "Add";

    btn.onclick = async ()=>{
      await fetch("/import", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          items:[{ id: select.value, condition: cond.value }]
        })
      });
      alert("Added manually");
    };

    div.appendChild(img);
    div.appendChild(info);
    div.appendChild(select);
    div.appendChild(cond);
    div.appendChild(btn);

    container.appendChild(div);
  });

  if (data.progress < 100){
    setTimeout(()=>pollBulk(jobId), 1000);
  } else {
    document.getElementById("progressText").innerText = "✅ Done";
  }
}

// ----------------------------
// CAMERA (UNCHANGED)
// ----------------------------
let stream;

async function startCamera(){
  const video = document.getElementById("camera");

  video.style.display = "block";

  stream = await navigator.mediaDevices.getUserMedia({
    video:{ facingMode:"environment" }
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

    ctx.drawImage(video,0,0);

    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats:['ean_13','upc_a'] });

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
