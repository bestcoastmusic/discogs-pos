console.log("APP JS LOADED");

// SAFE LOAD
window.onload = function(){

  console.log("WINDOW LOADED");

  document.getElementById("scanBtn").onclick = scan;
  document.getElementById("bulkBtn").onclick = bulk;
  document.getElementById("cameraBtn").onclick = () => alert("camera clicked");

};

// ----------------------------
// SCAN
// ----------------------------
async function scan(){
  console.log("SCAN CLICKED");

  const barcode = document.getElementById("barcode").value;

  const res = await fetch("/search", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ barcode })
  });

  const data = await res.json();

  console.log("SEARCH RESULT:", data);

  const box = document.getElementById("results");
  box.innerHTML = JSON.stringify(data);
}

// ----------------------------
// BULK
// ----------------------------
async function bulk(){
  console.log("BULK CLICKED");

  const box = document.getElementById("results");
  box.innerHTML = "bulk button works";
}
