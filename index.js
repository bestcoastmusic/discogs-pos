const express = require("express");
const app = express();
app.use(express.json());

const fetch = global.fetch;

let queue = [];
let processing = false;
let history = [];

function addHistory(barcode, item) {
  history.push({
    barcode,
    artist: item?.artist || "Unknown Artist",
    title: item?.title || "Unknown Title"
  });

  if (history.length > 100) history = history.slice(-100);
}

app.get("/", (req, res) => {
  const html = "<!DOCTYPE html><html><head><title>POS</title><style>" +
  "body{margin:0;font-family:Arial;background:#0b0b0f;color:#fff}" +
  ".top{padding:12px;background:#111;border-bottom:1px solid #222;display:flex;justify-content:space-between}" +
  ".container{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px}" +
  ".panel{background:#15151c;border-radius:10px;padding:10px;height:80vh;overflow:auto}" +
  "input,textarea{width:100%;padding:10px;margin-top:6px;background:#222;border:none;color:#fff;border-radius:6px}" +
  "button{width:100%;padding:10px;margin-top:8px;background:#00e676;border:none;border-radius:6px;font-weight:bold}" +
  ".item{background:#222;margin:6px 0;padding:10px;border-radius:6px}" +
  "video{width:100%;display:none;margin-top:10px;border-radius:10px}" +
  ".ding{position:fixed;bottom:20px;right:20px;background:#00e676;color:#000;padding:10px;border-radius:20px;display:none}" +
  "</style></head><body>" +

  "<div class='top'><div>🎧 BEST COAST POS</div><div>LIVE</div></div>" +

  "<div class='container'>" +

  "<div class='panel'>" +
  "<h3>Scan</h3>" +
  "<input id='barcode' placeholder='barcode'/>" +
  "<button onclick='scan()'>SCAN</button>" +

  "<h3>Bulk</h3>" +
  "<textarea id='bulk' rows='6'></textarea>" +
  "<button onclick='bulk()'>BULK</button>" +

  "<h3>Camera</h3>" +
  "<button onclick='camera()'>OPEN CAMERA</button>" +
  "<video id='video' autoplay></video>" +
  "</div>" +

  "<div class='panel'>" +
  "<h3>Live Feed</h3>" +
  "<div id='log'></div>" +
  "</div>" +

  "</div>" +

  "<div class='ding' id='ding'>✔ Imported</div>" +

  "<script>" +

  "function ding(){let d=document.getElementById('ding');d.style.display='block';setTimeout(()=>d.style.display='none',800)}" +

  "async function scan(){" +
  "let b=document.getElementById('barcode').value;" +
  "await fetch('/bulk-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{barcode:b}]})});" +
  "ding();" +
  "}" +

  "async function bulk(){" +
  "let items=document.getElementById('bulk').value.split('\\n').filter(Boolean).map(b=>({barcode:b}));" +
  "await fetch('/bulk-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});" +
  "ding();" +
  "}" +

  "async function camera(){" +
  "const stream=await navigator.mediaDevices.getUserMedia({video:true});" +
  "let v=document.getElementById('video');v.style.display='block';v.srcObject=stream;" +
  "}" +

  "async function load(){" +
  "let res=await fetch('/history');" +
  "let data=await res.json();" +
  "let log=document.getElementById('log');log.innerHTML='';" +
  "(data.history||[]).slice().reverse().forEach(i=>{" +
  "let d=document.createElement('div');d.className='item';" +
  "d.innerText='📦 '+i.artist+' - '+i.title+' ('+i.barcode+')';" +
  "log.appendChild(d);" +
  "});" +
  "}" +

  "setInterval(load,2000);load();" +

  "</script></body></html>";

  res.send(html);
});

async function fetchDiscogs(barcode){
  try {
    const search = await fetch(
      "https://api.discogs.com/database/search?barcode=" +
      barcode +
      "&token=" +
      process.env.DISCOGS_TOKEN
    ).then(r => r.json());

    const r = search.results?.[0];
    if (!r) return null;

    const release = await fetch(
      "https://api.discogs.com/releases/" +
      r.id +
      "?token=" +
      process.env.DISCOGS_TOKEN
    ).then(r => r.json());

    return {
      artist: release.artists?.[0]?.name || "Unknown Artist",
      title: release.title || "Unknown Title"
    };

  } catch (e) {
    return null;
  }
}

async function createShopifyProduct(item){
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) return;

  await fetch("https://" + store + "/admin/api/2024-01/products.json", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Access-Token":token
    },
    body: JSON.stringify({
      product:{
        title:item.title,
        variants:[{ price:"20.00" }]
      }
    })
  });
}

async function processQueue(){
  if (processing) return;
  processing = true;

  while(queue.length){
    const job = queue.shift();

    const item = await fetchDiscogs(job.barcode);

    if (item) {
      await createShopifyProduct(item);
      history.push({ barcode: job.barcode, ...item });
    }
  }

  processing = false;
}

setInterval(processQueue,1000);

app.post("/bulk-import",(req,res)=>{
  req.body.items.forEach(i=>queue.push(i));
  res.json({success:true,queued:req.body.items.length});
});

app.get("/history",(req,res)=>{
  res.json({history});
});

app.listen(process.env.PORT||10000,()=>{
  console.log("POS RUNNING");
});
