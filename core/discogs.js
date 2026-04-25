const axios = require("axios");

// ================= DISCOGS SEARCH =================
async function searchDiscogs(barcode) {
  try {
    const res = await axios.get(
      "https://api.discogs.com/database/search",
      {
        params: {
          barcode,
          token: process.env.DISCOGS_TOKEN,
        },
        headers: {
          "User-Agent": "BestCoastSystem/1.0",
        },
      }
    );

    return res.data.results || [];
  } catch (err) {
    console.log("Discogs error:", err.message);
    return [];
  }
}

// ================= SMART PICK =================
function pickBestRelease(results, barcode) {
  if (!results || !results.length) return null;

  const scored = results.map(r => {
    let score = 0;

    const format = (r.format || []).join(" ").toLowerCase();

    if (r.barcode && r.barcode.includes(barcode)) score += 100;
    if (format.includes("vinyl")) score += 50;
    if (format.includes("cd")) score -= 10;
    if (r.cover_image) score += 10;
    if (r.year) score += 5;

    return { r, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored[0].r;
}

// ================= EXPORT =================
module.exports = {
  searchDiscogs,
  pickBestRelease,
};
