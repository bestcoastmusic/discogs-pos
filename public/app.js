document.getElementById("scanBtn").addEventListener("click", scan);
document.getElementById("bulkBtn").addEventListener("click", bulk);

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
    div.textContent = r.title;

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
  box.innerHTML = "";

  data.results.forEach(r => {
    const div = document.createElement("div");
    div.className = "card";
    div.textContent = r.title;
    box.appendChild(div);
  });
}
