app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Best Coast Music POS</title>
  <style>
    body {
      font-family: Arial;
      background: #111;
      color: white;
      text-align: center;
      padding: 40px;
    }

    input {
      padding: 15px;
      width: 300px;
      font-size: 18px;
      border-radius: 8px;
      border: none;
      margin-top: 20px;
    }

    button {
      padding: 15px 20px;
      font-size: 16px;
      margin-left: 10px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      background: #00c853;
      color: white;
    }

    .box {
      margin-top: 30px;
      padding: 20px;
      background: #222;
      border-radius: 10px;
      display: inline-block;
      min-width: 400px;
    }

    .item {
      margin-top: 10px;
      padding: 10px;
      background: #333;
      border-radius: 6px;
    }
  </style>
</head>
<body>

  <h1>🎧 Best Coast Music POS</h1>

  <input id="barcode" placeholder="Scan or enter barcode" />
  <button onclick="send()">Import</button>

  <div class="box" id="results">
    <h3>Results</h3>
  </div>

<script>
async function send() {
  const barcode = document.getElementById('barcode').value;

  if (!barcode) return alert("Enter barcode");

  const res = await fetch('/bulk-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ barcode }]
    })
  });

  const data = await res.json();

  const box = document.getElementById('results');

  data.results.forEach(item => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = "📦 " + item.barcode + " → " + item.status;
    box.appendChild(div);
  });
}
</script>

</body>
</html>
  `);
});
