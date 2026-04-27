console.log("APP LOADED");

// ----------------------------
// INIT
// ----------------------------
window.onload = function(){

  const scanBtn = document.getElementById("scanBtn");

  if (scanBtn){
    scanBtn.addEventListener("click", scan);
  }

  const bulkBtn = document.getElementById("bulkBtn");

  if (bulkBtn){
    bulkBtn.addEventListener("click", startBulk);
  }

  loadHistory();
  setInterval(loadHistory, 2000);
};

// ----------------------------
// SCAN (FIXED)
// ----------------------------
async function scan(){

  console.log("SCAN CLICKED");

  const barcode = document.getElementById("barcode").value;

  if (!barcode){
    alert("Enter barcode");
    return;
  }

  try {

    const res = await fetch("/search", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ barcode })
    });

    const data = await res.json();

    console.log("RESULT:", data);

    const box = document.getElementById("results");
    box.innerHTML = "";

    if (!data.results || data.results.length === 0){
      box.innerHTML = "<p>No results</p>";
      return;
    }

    data.results.forEach(r=>{
      const div = document.createElement("div");
      div.className = "card";

      div.innerHTML = `
        <img src="${r.thumb || r.image || ""}" width="60"/>
        <b>${r.title}</b><br/>
        ${r.year || ""} • ${r.country || ""}<br/>
        <span style="color:#00e676">${r.color || "Black"}</span>
      `;

      box.appendChild(div);
    });

  } catch (err){
    console.log("SCAN ERROR:", err);
  }
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
    <div style="background:#333;height:20px;">
      <div id="progressBar" style="height:20px;width:0%;background:#00e676;"></div>
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
