// ==========================
// 🔧 КОНФИГ И ПЕРЕМЕННЫЕ
// ==========================
const PORT = process.env.PORT || 3000;

// Строка подключения к PostgreSQL, например:
// postgres://user:password@host:5432/dbname
const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING || "postgresql://postgres:YECEwWBLyNtNZfLKeRXzpAyPgHODuWhu@trolley.proxy.rlwy.net:44883/railway";

// USDA
const USDA_API_KEY = process.env.USDA_API_KEY || "HPvXo9CKZSxS4bcAldlVWmVl2geBSI8pnilD9v3a";
const USDA_BASE_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";

// OpenFoodFacts
const OFF_BASE_URL = "https://world.openfoodfacts.org/cgi/search.pl";

// Лимиты и таймауты
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 25;
const HTTP_TIMEOUT_MS = 3000;

// Приоритет источников для сортировки
const SOURCE_PRIORITY = {
  local: 1,
  usda: 2,
  off: 3,
};

// ==========================
// 📦 ИМПОРТЫ И ИНИЦИАЛИЗАЦИЯ
// ==========================
const express = require("express");
const { Pool } = require("pg");

// В Node 18+ fetch глобальный, в Railway обычно именно он
// Если что — можно будет подключить node-fetch.
const app = express();

// Простая CORS-прокладка для мини-аппа
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Чтобы парсить JSON на других эндпоинтах, если будут нужны
app.use(express.json());

// Пул подключения к БД (если строка не задана — просто не используем БД)
const pool = PG_CONNECTION_STRING
  ? new Pool({ connectionString: PG_CONNECTION_STRING })
  : null;

// ==========================
// ⚙️ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout")), ms)
    ),
  ]);
}

// Нормализация строки для примитивного сравнения
function normalizeString(str) {
  return (str || "").toLowerCase().trim();
}

// ==========================
// 🔍 ПОИСК В ЛОКАЛЬНОЙ БАЗЕ
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
// 🔍 ПОИСК В USDA
// ==========================
async function searchUSDA(query, limit) {
  if (!USDA_API_KEY) return [];

  const url = new URL(USDA_BASE_URL);
  url.searchParams.set("api_key", USDA_API_KEY);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", limit.toString());
  // Можно отфильтровать типы, но для начала берём всё по умолчанию

  try {
    const res = await withTimeout(fetch(url.toString()), HTTP_TIMEOUT_MS);
    if (!res.ok) {
      console.error("USDA error status:", res.status);
      return [];
    }
    const data = await res.json();
    if (!data.foods || !Array.isArray(data.foods)) return [];

    return data.foods.map((food) => {
      const nutrients = food.foodNutrients || [];

      const getNutrientById = (id) => {
        const n = nutrients.find((n) => n.nutrientId === id);
        return n ? Number(n.value) : 0;
      };

      // ID по FDC:
      // 1008 — Energy (kcal)
      // 1003 — Protein
      // 1004 — Fat
      // 1005 — Carbohydrates
      const kcal_100 = getNutrientById(1008);
      const protein_100 = getNutrientById(1003);
      const fat_100 = getNutrientById(1004);
      const carbs_100 = getNutrientById(1005);

      return {
        source: "usda",
        id: `usda_${food.fdcId}`,
        product: food.description || "",
        brand: food.brandOwner || null,
        kcal_100,
        protein_100,
        fat_100,
        carbs_100,
        meta: {
          fdcId: food.fdcId,
          dataType: food.dataType,
        },
      };
    });
  } catch (err) {
    console.error("USDA fetch error:", err.message);
    return [];
  }
}

// ==========================
// 🔍 ПОИСК В OpenFoodFacts
// ==========================
async function searchOFF(query, limit) {
  const url = new URL(OFF_BASE_URL);
  url.searchParams.set("search_terms", query);
  url.searchParams.set("search_simple", "1");
  url.searchParams.set("action", "process");
  url.searchParams.set("json", "1");
  url.searchParams.set("page_size", limit.toString());

  try {
    const res = await withTimeout(fetch(url.toString()), HTTP_TIMEOUT_MS);
    if (!res.ok) {
      console.error("OFF error status:", res.status);
      return [];
    }
    const data = await res.json();
    if (!data.products || !Array.isArray(data.products)) return [];

    return data.products.map((p) => {
      const n = p.nutriments || {};
      const kcal_100 = Number(n["energy-kcal_100g"] ?? 0);
      const protein_100 = Number(n["proteins_100g"] ?? 0);
      const fat_100 = Number(n["fat_100g"] ?? 0);
      const carbs_100 = Number(n["carbohydrates_100g"] ?? 0);

      return {
        source: "off",
        id: `off_${p.id || p._id || p.code || Math.random().toString(36)}`,
        product: p.product_name || "",
        brand: (p.brands || "").split(",")[0]?.trim() || null,
        kcal_100,
        protein_100,
        fat_100,
        carbs_100,
        meta: {
          code: p.code || null,
          url: p.url || null,
        },
      };
    });
  } catch (err) {
    console.error("OFF fetch error:", err.message);
    return [];
  }
}

// ==========================
// 🧠 ОБЪЕДИНЕНИЕ РЕЗУЛЬТАТОВ
// ==========================
function mergeResults(query, local, usda, off, limit) {
  const all = [...local, ...usda, ...off];

  // Удалим грубые дубликаты по (normalized product + brand)
  const seen = new Set();
  const unique = [];
  for (const item of all) {
    const key = `${normalizeString(item.product)}|${normalizeString(
      item.brand
    )}|${item.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const normQuery = normalizeString(query);

  // Простая сортировка: локальные выше, потом по "насколько название похоже"
  unique.sort((a, b) => {
    const prioDiff =
      (SOURCE_PRIORITY[a.source] || 99) - (SOURCE_PRIORITY[b.source] || 99);
    if (prioDiff !== 0) return prioDiff;

    const aName = normalizeString(a.product);
    const bName = normalizeString(b.product);

    const aStarts = aName.startsWith(normQuery) ? 0 : 1;
    const bStarts = bName.startsWith(normQuery) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;

    const aIncludes = aName.includes(normQuery) ? 0 : 1;
    const bIncludes = bName.includes(normQuery) ? 0 : 1;
    if (aIncludes !== bIncludes) return aIncludes - bIncludes;

    return aName.localeCompare(bName);
  });

  return unique.slice(0, limit);
}

// ==========================
// 🌡 HEALTHCHECK
// ==========================
app.get("/health", async (req, res) => {
  try {
    if (pool) {
      await pool.query("SELECT 1");
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================
// 🔑 ГЛАВНЫЙ ЭНДПОИНТ: /api/search
// ==========================
app.get("/api/search", async (req, res) => {
  const query = (req.query.query || "").trim();
  if (!query) {
    return res.status(400).json({ error: "Parameter 'query' is required" });
  }

  let limit = Number(req.query.limit || SEARCH_LIMIT_DEFAULT);
  if (!Number.isFinite(limit) || limit <= 0) limit = SEARCH_LIMIT_DEFAULT;
  if (limit > SEARCH_LIMIT_MAX) limit = SEARCH_LIMIT_MAX;

  try {
    const [local, usda, off] = await Promise.all([
      searchLocal(query, limit),
      searchUSDA(query, limit),
      searchOFF(query, limit),
    ]);

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
    console.error("Search error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==========================
// 🚀 СТАРТ СЕРВЕРА
// ==========================
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
