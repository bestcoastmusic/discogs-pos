require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// 🔑 ENV
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;

// -----------------------------
// 🟢 HEALTH CHECK
// -----------------------------
app.get('/', (req, res) => {
  res.send('✅ Discogs → Shopify app running');
});

// -----------------------------
// 🔍 SEARCH DISCOGS (text)
// -----------------------------
app.get('/search', async (req, res) => {
  try {
    const query = req.query.q;

    const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(query)}&type=release&token=${DISCOGS_TOKEN}`;

    const response = await fetch(url);
    const data = await response.json();

    const results = data.results.slice(0, 15).map(item => ({
      id: item.id,
      title: item.title,
      year: item.year,
      format: item.format,
      cover: item.cover_image,
    }));

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).send('Search failed');
  }
});

// -----------------------------
// 📷 BARCODE LOOKUP
// -----------------------------
app.get('/barcode/:code', async (req, res) => {
  try {
    const barcode = req.params.code;

    const url = `https://api.discogs.com/database/search?barcode=${barcode}&token=${DISCOGS_TOKEN}`;

    const response = await fetch(url);
    const data = await response.json();

    const results = data.results.map(item => ({
      id: item.id,
      title: item.title,
      year: item.year,
      format: item.format,
      cover: item.cover_image,
    }));

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).send('Barcode lookup failed');
  }
});

// -----------------------------
// 📦 ADD PRODUCT TO SHOPIFY
// -----------------------------
async function addToShopify(product) {
  const response = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(product),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

// -----------------------------
// ➕ SINGLE ADD
// -----------------------------
app.post('/add-product', async (req, res) => {
  try {
    const { title, artist, price, image, year, format } = req.body;

    const productData = {
      product: {
        title: `${artist} - ${title}`,
        body_html: `
          <strong>${artist}</strong><br/>
          ${title}<br/>
          ${year || ''} ${format || ''}
        `,
        images: image ? [{ src: image }] : [],
        variants: [
          {
            price: price || '19.99',
          },
        ],
      },
    };

    const data = await addToShopify(productData);

    console.log('✅ Added:', productData.product.title);
    res.json(data);
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).send('Add failed');
  }
});

// -----------------------------
// 📦 BULK IMPORT
// -----------------------------
app.post('/bulk-import', async (req, res) => {
  try {
    const items = req.body.items;

    if (!items || !Array.isArray(items)) {
      return res.status(400).send('Invalid items');
    }

    const results = [];

    for (const item of items) {
      try {
        const productData = {
          product: {
            title: item.title,
            body_html: item.description || '',
            images: item.image ? [{ src: item.image }] : [],
            variants: [
              {
                price: item.price || '19.99',
              },
            ],
          },
        };

        const created = await addToShopify(productData);

        console.log('📦 Added:', item.title);
        results.push({ success: true, title: item.title });
      } catch (err) {
        console.error('❌ Failed:', item.title);
        results.push({ success: false, title: item.title });
      }
    }

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).send('Bulk import failed');
  }
});

// -----------------------------
// 🚀 START SERVER
// -----------------------------
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Running on http://localhost:${PORT}`);
});
