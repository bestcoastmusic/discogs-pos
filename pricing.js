const axios = require("axios");

// ================= PRICE LOOKUP =================
async function getPriceByReleaseId(id) {
  try {
    const res = await axios.get(
      `https://api.discogs.com/marketplace/stats/${id}`,
      {
        headers: {
          "User-Agent": "BestCoastSystem/1.0",
        },
      }
    );

    return (
      res.data?.lowest_price?.value ||
      res.data?.median_price?.value ||
      null
    );
  } catch {
    return null;
  }
}

module.exports = {
  getPriceByReleaseId,
};
