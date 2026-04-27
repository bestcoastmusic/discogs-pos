console.log("POS UI LOADED");

// ----------------------------
// INIT
// ----------------------------
window.onload = function(){
  document.getElementById("scanBtn").onclick = scan;
  document.getElementById("bulkBtn").onclick = startBulk;

  loadHistory();
  setInterval(loadHistory, 2000);
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
      "<img src='"+(r.image||"")+"' width='60'/>" +
      "<b>"+r.title+"</b><br/>" +
      (r.year||"") + " • " + (r.country||"") + "<br/>" +
      "<span style='color:#00e676'>" + (r.color||"Black") + "</span>";

    box.appendChild(div);
  });
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

  } catch (err){
    console.log("history error", err);
  }
}
