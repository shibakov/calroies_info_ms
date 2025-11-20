// ==========================
// 🔧 CONFIG
// ==========================
const PORT = process.env.PORT || 3000;

const PG_CONNECTION_STRING =
  process.env.PG_CONNECTION_STRING ||
  "postgresql://postgres:YECEwWBLyNtNZfLKeRXzpAyPgHODuWhu@trolley.proxy.rlwy.net:44883/railway";

const USDA_API_KEY =
  process.env.USDA_API_KEY ||
  "HPvXo9CKZSxS4bcAldlVWmVl2geBSI8pnilD9v3a";

const USDA_BASE_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";
const OFF_BASE_URL = "https://world.openfoodfacts.org/cgi/search.pl";

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 25;
const HTTP_TIMEOUT_MS = 1500;

const SOURCE_PRIORITY = {
  local: 1,
  usda: 2,
  off: 3,
};

// ==========================
// 📦 IMPORTS
// ==========================
const express = require("express");
const { Pool } = require("pg");

const app = express();

// 🚫 Disable caching for API responses globally
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});



// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// PostgreSQL
const pool = PG_CONNECTION_STRING
  ? new Pool({ connectionString: PG_CONNECTION_STRING })
  : null;

// ==========================
// ⏱ TIMEOUT WRAPPER
// ==========================
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout")), ms)
    ),
  ]);
}

function normalizeString(str) {
  return (str || "").toLowerCase().trim();
}

// ==========================
// 🔍 LOCAL SEARCH
// ==========================
async function searchLocal(query, limit) {
  if (!pool) return [];

  const sql = `
    SELECT
      product,
      COALESCE(kcal_100, 0)    AS kcal_100,
      COALESCE(protein_100, 0) AS protein_100,
      COALESCE(fat_100, 0)     AS fat_100,
      COALESCE(carbs_100, 0)   AS carbs_100,
      NULL                     AS brand
    FROM personal.food_dict
    WHERE product ILIKE '%' || $1 || '%'
    ORDER BY product
    LIMIT $2;
  `;

  const params = [query, limit];
  const { rows } = await pool.query(sql, params);

  return rows.map((row, idx) => ({
    source: "local",
    id: `local_${idx}_${row.product}`,
    product: row.product,
    brand: null,
    kcal_100: Number(row.kcal_100),
    protein_100: Number(row.protein_100),
    fat_100: Number(row.fat_100),
    carbs_100: Number(row.carbs_100),
    meta: null,
  }));
}

// ==========================
// 🔍 USDA SEARCH
// ==========================
async function searchUSDA(query, limit) {
  if (!USDA_API_KEY) return [];

  const url = new URL(USDA_BASE_URL);
  url.searchParams.set("api_key", USDA_API_KEY);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", limit.toString());

  try {
    const res = await withTimeout(fetch(url.toString()), HTTP_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.foods) return [];

    return data.foods.map((food) => {
      const nutrients = food.foodNutrients || [];
      const get = (id) => {
        const n = nutrients.find((x) => x.nutrientId === id);
        return n ? Number(n.value) : 0;
      };

      return {
        source: "usda",
        id: `usda_${food.fdcId}`,
        product: food.description || "",
        brand: food.brandOwner || null,
        kcal_100: get(1008),
        protein_100: get(1003),
        fat_100: get(1004),
        carbs_100: get(1005),
        meta: { fdcId: food.fdcId, type: food.dataType },
      };
    });
  } catch {
    return [];
  }
}

// ==========================
// 🔍 OFF SEARCH (disabled)
// ==========================
async function searchOFF() {
  return []; // временно отключено
}

// ==========================
// 🧠 MERGE RESULTS
// ==========================
function mergeResults(query, local, usda, off, limit) {
  const all = [...local, ...usda, ...off];
  const seen = new Set();
  const unique = [];

  for (const item of all) {
    const key = `${normalizeString(item.product)}|${normalizeString(
      item.brand
    )}|${item.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  const q = normalizeString(query);

  unique.sort((a, b) => {
    const pr = (SOURCE_PRIORITY[a.source] || 99) - (SOURCE_PRIORITY[b.source] || 99);
    if (pr !== 0) return pr;

    const an = normalizeString(a.product);
    const bn = normalizeString(b.product);

    const as = an.startsWith(q) ? 0 : 1;
    const bs = bn.startsWith(q) ? 0 : 1;
    if (as !== bs) return as - bs;

    const ai = an.includes(q) ? 0 : 1;
    const bi = bn.includes(q) ? 0 : 1;
    if (ai !== bi) return ai - bi;

    return an.localeCompare(bn);
  });

  return unique.slice(0, limit);
}

// ==========================
// 🌡 HEALTHCHECK
// ==========================
app.get("/health", async (req, res) => {
  try {
    if (pool) await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// ==========================
// 🔎 /api/search
// ==========================
app.get("/api/search", async (req, res) => {
  const query = (req.query.query || "").trim();
  if (!query) return res.status(400).json({ error: "Parameter 'query' required" });

  let limit = Number(req.query.limit || SEARCH_LIMIT_DEFAULT);
  if (limit <= 0) limit = SEARCH_LIMIT_DEFAULT;
  if (limit > SEARCH_LIMIT_MAX) limit = SEARCH_LIMIT_MAX;

  try {
    const [local, usda] = await Promise.all([
      searchLocal(query, limit),
      searchUSDA(query, limit),
    ]);

    const off = [];

    const results = mergeResults(query, local, usda, off, limit);

    res.json({
      query,
      limit,
      counts: {
        local: local.length,
        usda: usda.length,
        off: off.length,
        total: results.length,
      },
      results,
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==========================
// 📌 AUTO-ADD
// ==========================
app.post("/api/auto-add", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "No DB connection" });

    const p = req.body;

    const sql = `
      INSERT INTO personal.food_dict (product, kcal_100, protein_100, fat_100, carbs_100)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (product) DO NOTHING
      RETURNING *;
    `;

    const params = [
      p.product,
      p.kcal_100,
      p.protein_100,
      p.fat_100,
      p.carbs_100,
    ];

    await pool.query(sql, params);

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "internal" });
  }
});

// ==========================
// 🚀 START
// ==========================
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
