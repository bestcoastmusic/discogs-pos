console.log("POS READY");

window.onload = function(){
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
      "<img src='"+(r.thumb||"")+"' width='60'/>" +
      "<b>"+r.title+"</b><br/>" +
      "<b style='color:#00e676'>"+(r.color||"Black")+" Vinyl</b><br/>" +
      (r.year||"")+" • "+(r.country||"")+"<br/>" +
      "<small>"+(r.label||"")+"</small>";

    div.onclick = () => importItem(r.id);

    box.appendChild(div);
  });
}

// ----------------------------
// IMPORT
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

  if (data.duplicates.length) {
    alert("Duplicate skipped");
  }
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

  box.innerHTML = "<h4>Bulk</h4>";

  data.results.forEach((item,i)=>{
    const div = document.createElement("div");
    div.className = "card";

    const select = document.createElement("select");
    select.id = "r-"+i;

    item.options.forEach(opt=>{
      const o = document.createElement("option");
      o.value = opt.id;
      o.textContent =
        opt.title+" ("+
        opt.year+" • "+
        opt.country+" • "+
        opt.color+")";
      select.appendChild(o);
    });

    const btn = document.createElement("button");
    btn.textContent = "Add";

    btn.onclick = async ()=>{
      const id = select.value;
      await importItem(id);
    };

    div.appendChild(select);
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

// ----------------------------
// LIVE FEED
// ----------------------------
async function load(){
  const res = await fetch("/history");
  const data = await res.json();

  const log = document.getElementById("log");
  log.innerHTML = "";

  data.history.slice().reverse().forEach(i=>{
    const div = document.createElement("div");
    div.className = "card";
    div.textContent =
      i.artist+" - "+i.title+" $"+i.price;
    log.appendChild(div);
  });
}

setInterval(load,2000);
load();
