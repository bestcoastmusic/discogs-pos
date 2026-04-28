const express = require("express");

const app = express();

app.use(express.json());
app.use(express.static("public"));

// ----------------------------
// STATE
// ----------------------------
let priceMap = {};
let stockMap = {};

// ----------------------------
// LOAD CSV FROM URL
// ----------------------------
async function loadCSV(){

  try {
    const res = await fetch(process.env.CSV_URL);
    const text = await res.text();

    priceMap = {};
    stockMap = {};

    const rows = text.split("\n").slice(1);

    rows.forEach(row=>{
      const [upc, price, stock] = row.split(",");

      if (!upc) return;

      const cleanUPC = upc.replace(/\D/g,"");

      priceMap[cleanUPC] = parseFloat(price) || 0;
      stockMap[cleanUPC] = parseInt(stock) || 0;
    });

    console.log("🔄 CSV Loaded:", Object.keys(priceMap).length);

  } catch (e){
    console.log("❌ CSV load failed:", e.message);
  }
}

// initial load
loadCSV();

// reload every 60 sec
setInterval(loadCSV, 60000);

// ----------------------------
// TEST ROUTE
// ----------------------------
app.get("/csv-test",(req,res)=>{
  res.json({
    prices: Object.keys(priceMap).length,
    stock: Object.keys(stockMap).length
  });
});

// ----------------------------
app.listen(process.env.PORT || 10000, ()=>{
  console.log("🚀 AUTO CSV SYNC LIVE");
});
