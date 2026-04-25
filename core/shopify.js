const axios = require("axios");

async function createShopifyProduct({ title, price, barcode, image }) {
  try {
    const res = await axios.post(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/products.json`,
      {
        product: {
          title,
          vendor: "Discogs Import",
          status: "active",
          variants: [
            {
              price: price || "10.00",
              sku: barcode,
              inventory_management: "shopify",
              inventory_quantity: 1,
            },
          ],
          images: image ? [{ src: image }] : [],
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    return res.data;
  } catch (err) {
    console.log("SHOPIFY ERROR:", err.response?.data || err.message);
    return null;
  }
}

// IMPORTANT: explicit export (no ambiguity)
module.exports = {
  createShopifyProduct: createShopifyProduct
};
