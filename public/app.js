console.log("PRO POS UI READY");

// ----------------------------
// INIT
// ----------------------------
window.onload = function(){
  document.getElementById("scanBtn").onclick = scan;
  document.getElementById("bulkBtn").onclick = startBulk;

  setInterval(loadHistory, 2000); // 🔥 IMPORTANT
};

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
// HISTORY UI
// ----------------------------
async function loadHistory(){
  try {
    const res = await fetch("/history");
    const data = await res.json();

    const box = document.getElementById("history");

    if (!box) {
      console.log("NO HISTORY DIV FOUND");
      return;
    }

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
