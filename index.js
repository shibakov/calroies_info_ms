// ==========================
// 📦 IMPORTS & CONFIG
// ==========================
const express = require("express");
const { Pool } = require("pg");
const config = require("./config");
const logger = require("./logger");
const { requestLogger } = require("./middlewares/logging");
const { errorHandler } = require("./middlewares/errorHandler");

const app = express();

const SOURCE_PRIORITY = {
  local: 1,
  usda: 2,
  off: 3,
};

// PostgreSQL
const pool = config.pg.connectionString
  ? new Pool({ connectionString: config.pg.connectionString })
  : null;

// 🚫 Disable caching
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
app.use(requestLogger);

// ==========================
// ⏱ TIMEOUT UTILS
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
// 🌐 TRANSLATION HELPERS (Google unofficial)
// ==========================

// RU → EN
async function translateRuToEn(text) {
  const original = text || "";
  if (!original.trim()) return original;

  const hasCyrillic = /[а-яА-ЯЁё]/.test(original);
  if (!hasCyrillic) return original;

  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=ru&tl=en&dt=t&q=" +
    encodeURIComponent(original);

  try {
    const res = await withTimeout(fetch(url), config.translate.timeoutMs);
    const raw = await res.text();

    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      logger.error("[translateRuToEn] Parse error", {
        body_sample: raw.slice(0, 150),
      });
      return original;
    }

    const translated = json?.[0]?.[0]?.[0];
    return translated?.toLowerCase() || original;
  } catch (err) {
    logger.error("[translateRuToEn] Network error", { error: err.message });
    return original;
  }
}

// EN → RU
async function translateEnToRu(text) {
  const original = text || "";
  if (!original.trim()) return original;

  const isAscii = /^[\x00-\x7F]+$/.test(original);
  if (!isAscii) return original; // уже русский — не переводим

  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=" +
    encodeURIComponent(original);

  try {
    const res = await withTimeout(fetch(url), config.translate.timeoutMs);
    const raw = await res.text();

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.error("[translateEnToRu] Parse error", {
        body_sample: raw.slice(0, 150),
      });
      return original;
    }

    const translated = json?.[0]?.[0]?.[0];
    return translated || original;
  } catch (err) {
    logger.error("[translateEnToRu] Network error", { error: err.message });
    return original;
  }
}

// ==========================
// 🧠 GPT HELPERS
// ==========================

async function getMacrosFromGPT(product) {
  if (!config.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const prompt = `Ты — помощник по нутриентам. Для продукта на русском языке верни примерную калорийность и БЖУ на 100 г. Ответь строго в JSON без комментариев и лишнего текста в формате:\n{ "kcal": number, "protein": number, "fat": number, "carbs": number }\n\nПродукт: "${product}"`;

  const body = {
    model: config.openai.model,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.2,
  };

  const res = await withTimeout(
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: JSON.stringify(body),
    }),
    config.openai.timeoutMs
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("[getMacrosFromGPT] Bad status", {
      status: res.status,
      body_sample: text.slice(0, 200),
    });
    throw new Error("GPT request failed");
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    logger.error("[getMacrosFromGPT] JSON parse error", {
      content_sample: content.slice(0, 200),
    });
    throw new Error("GPT returned non-JSON");
  }

  const kcal = Number(parsed.kcal);
  const protein = Number(parsed.protein);
  const fat = Number(parsed.fat);
  const carbs = Number(parsed.carbs);

  if ([kcal, protein, fat, carbs].some((v) => !Number.isFinite(v))) {
    throw new Error("GPT returned invalid macros");
  }

  return { kcal, protein, fat, carbs };
}

// ==========================
// 🔍 LOCAL SEARCH
// ==========================
async function searchLocal(query, limit) {
  if (!pool) return [];

  const sql = `
    SELECT
      id,
      product,
      COALESCE(kcal_100, 0)    AS kcal_100,
      COALESCE(protein_100, 0) AS protein_100,
      COALESCE(fat_100, 0)     AS fat_100,
      COALESCE(carbs_100, 0)   AS carbs_100
    FROM personal.food_dict
    WHERE lower(product) LIKE '%' || lower($1) || '%'
    ORDER BY
      (lower(product) LIKE lower($1) || '%') DESC,
      lower(product) ASC
    LIMIT $2;
  `;

  const params = [query, limit];
  const { rows } = await pool.query(sql, params);

  return rows.map((row) => ({
    source: "local",
    id: row.id,
    product: row.product,
    brand: null,
    product_type: null,
    freq_usage: 0,
    last_used_at: null,
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
  if (!config.usda.apiKey) return [];

  const url = new URL(config.usda.baseUrl);
  url.searchParams.set("api_key", config.usda.apiKey);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", limit.toString());

  try {
    const res = await withTimeout(fetch(url.toString()), config.usda.timeoutMs);
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
        product_type: null,
        freq_usage: 0,
        last_used_at: null,
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
// 🔍 OFF (disabled)
// ==========================
async function searchOFF() {
  return [];
}

// ==========================
// 📚 DICT HELPERS
// ==========================

async function insertOrGetFoodDictEntry({
  product,
  kcal_100,
  protein_100,
  fat_100,
  carbs_100,
  source,
}) {
  if (!pool) throw new Error("No DB connection");

  const client = await pool.connect();
  try {
    const sqlInsert = `
      INSERT INTO personal.food_dict (
        product, kcal_100, protein_100, fat_100, carbs_100, source
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (product) DO UPDATE
      SET kcal_100 = EXCLUDED.kcal_100,
          protein_100 = EXCLUDED.protein_100,
          fat_100 = EXCLUDED.fat_100,
          carbs_100 = EXCLUDED.carbs_100,
          updated_at = now()
      RETURNING *;
    `;

    const paramsInsert = [
      product,
      kcal_100,
      protein_100,
      fat_100,
      carbs_100,
      source || null,
    ];

    const insertResult = await client.query(sqlInsert, paramsInsert);
    return insertResult.rows[0];
  } finally {
    client.release();
  }
}

async function getOrCreateProductIdByName(product) {
  if (!pool) throw new Error("No DB connection");

  // Сначала пробуем найти в словаре
  const existing = await pool.query(
    `SELECT id FROM personal.food_dict WHERE lower(product) = lower($1) LIMIT 1;`,
    [product]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // Если нет — пробуем через GPT-флоу
  const macros = await getMacrosFromGPT(product);
  const row = await insertOrGetFoodDictEntry({
    product,
    kcal_100: macros.kcal,
    protein_100: macros.protein,
    fat_100: macros.fat,
    carbs_100: macros.carbs,
    source: "gpt",
  });

  return row.id;
}

// ==========================
// 🧮 STATS HELPER
// ==========================

async function getDailyStats(dateInput) {
  if (!pool) throw new Error("No DB connection");

  const targetDate = dateInput ? new Date(dateInput) : new Date();

  if (Number.isNaN(targetDate.getTime())) {
    throw new Error("Invalid date");
  }

  const dateStr = targetDate.toISOString().slice(0, 10); // YYYY-MM-DD

  const sql = `
    SELECT
      l.id,
      l.product,
      l.meal_type,
      l.quantity_g,
      l.created_at,
      d.kcal_100,
      d.protein_100,
      d.fat_100,
      d.carbs_100
    FROM personal.food_log l
    JOIN personal.food_dict d ON lower(d.product) = lower(l.product)
    WHERE l.created_at::date = $1::date
    ORDER BY l.created_at ASC, l.id ASC;
  `;

  const { rows } = await pool.query(sql, [dateStr]);

  const items = rows.map((row) => {
    const weight = Number(row.quantity_g) || 0;
    const kcal_100 = Number(row.kcal_100) || 0;
    const protein_100 = Number(row.protein_100) || 0;
    const fat_100 = Number(row.fat_100) || 0;
    const carbs_100 = Number(row.carbs_100) || 0;

    const factor = weight / 100;

    const kcal = factor * kcal_100;
    const protein = factor * protein_100;
    const fat = factor * fat_100;
    const carbs = factor * carbs_100;

    return {
      id: row.id,
      product: row.product,
      product_type: null,
      meal_type: row.meal_type,
      weight,
      kcal,
      protein,
      fat,
      carbs,
      time: row.created_at,
    };
  });

  const macros_total = items.reduce(
    (acc, item) => {
      acc.p += item.protein;
      acc.f += item.fat;
      acc.c += item.carbs;
      acc.kcal += item.kcal;
      return acc;
    },
    { p: 0, f: 0, c: 0, kcal: 0 }
  );

  let macros_left = { p: null, f: null, c: null, kcal: null };

  if (
    config.dailyTargets.kcal != null &&
    config.dailyTargets.protein != null &&
    config.dailyTargets.fat != null &&
    config.dailyTargets.carbs != null
  ) {
    macros_left = {
      p: Math.max(config.dailyTargets.protein - macros_total.p, 0),
      f: Math.max(config.dailyTargets.fat - macros_total.f, 0),
      c: Math.max(config.dailyTargets.carbs - macros_total.c, 0),
      kcal: Math.max(config.dailyTargets.kcal - macros_total.kcal, 0),
    };
  }

  return {
    date: dateStr,
    items,
    macros_total,
    macros_left,
  };
}

// ==========================
// 🧠 MERGE RESULTS (USED ONLY IF НУЖНО ОБЪЕДИНЯТЬ ИСТОЧНИКИ)
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
    const pr =
      (SOURCE_PRIORITY[a.source] || 99) - (SOURCE_PRIORITY[b.source] || 99);
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
  } catch (err) {
    logger.error("[/health] error", { error: err.message });
    res.status(500).json({ ok: false });
  }
});

// ==========================
// 🔎 /api/search (новый флоу)
// ==========================
app.get("/api/search", async (req, res) => {
  const query = (req.query.query || "").trim();
  if (!query) return res.status(400).json({ error: "Parameter 'query' required" });

  let limit = Number(req.query.limit || config.search.defaultLimit);
  if (limit <= 0) limit = config.search.defaultLimit;
  if (limit > config.search.maxLimit) limit = config.search.maxLimit;

  try {
    // 1) Сначала только локальный поиск
    const local = await searchLocal(query, limit);

    if (local.length > 0) {
      return res.json({
        query,
        limit,
        source: "local",
        counts: {
          local: local.length,
          usda: 0,
          off: 0,
          total: local.length,
        },
        results: local,
      });
    }

    // 2) Локальных нет — пробуем USDA
    const hasCyrillic = /[а-яА-ЯЁё]/.test(query);
    const usdaQuery = hasCyrillic ? await translateRuToEn(query) : query;

    const usda = await searchUSDA(usdaQuery, limit);
    const off = [];

    if (usda.length === 0) {
      return res.json({
        query,
        usdaQuery,
        limit,
        status: "not_found",
      });
    }

    // Если нужно объединять с другими источниками — можно использовать mergeResults.
    const results = mergeResults(query, [], usda, off, limit);

    // Если запрос был на русском → переводим product обратно для внешних источников
    if (hasCyrillic) {
      for (const item of results) {
        if (item.source !== "local") {
          item.product = await translateEnToRu(item.product);
        }
      }
    }

    res.json({
      query,
      usdaQuery,
      limit,
      source: "usda",
      counts: {
        local: 0,
        usda: usda.length,
        off: off.length,
        total: results.length,
      },
      results,
    });
  } catch (err) {
    logger.error("[/api/search] error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==========================
// 📌 AUTO-ADD (расширенный)
// ==========================
app.post("/api/auto-add", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "No DB connection" });

    const p = req.body || {};
    const {
      product,
      kcal_100,
      protein_100,
      fat_100,
      carbs_100,
      source = "manual",
    } = p;

    if (!product || typeof product !== "string") {
      return res.status(400).json({ error: "Field 'product' is required" });
    }

    if ([kcal_100, protein_100, fat_100, carbs_100].some((v) => v == null)) {
      return res.status(400).json({ error: "All macro fields are required" });
    }

    const row = await insertOrGetFoodDictEntry({
      product,
      kcal_100,
      protein_100,
      fat_100,
      carbs_100,
      source,
    });

    res.json({
      id: row.id,
      product: row.product,
      source: row.source,
      created_at: row.created_at,
      updated_at: row.updated_at,
      kcal_100: row.kcal_100,
      protein_100: row.protein_100,
      fat_100: row.fat_100,
      carbs_100: row.carbs_100,
    });
  } catch (err) {
    logger.error("[/api/auto-add] error", { error: err.message });
    res.status(500).json({ error: "internal" });
  }
});

// ==========================
// 🧠 /api/dict/create_via_gpt
// ==========================
app.post("/api/dict/create_via_gpt", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "No DB connection" });

    // Fallback: если GPT не сконфигурирован — считаем фичу не реализованной,
    // вместо того чтобы пытаться ходить во внешний API.
    if (!config.openai.apiKey) {
      return res.status(501).json({ error: "not_implemented" });
    }

    const { product } = req.body || {};
    if (!product || typeof product !== "string" || !product.trim()) {
      return res.status(400).json({ error: "Field 'product' is required" });
    }

    let macros;
    try {
      macros = await getMacrosFromGPT(product.trim());
    } catch (err) {
      logger.error("[/api/dict/create_via_gpt] GPT error", { error: err.message });
      return res.status(502).json({ error: "gpt_failed" });
    }

    let row;
    try {
      row = await insertOrGetFoodDictEntry({
        product: product.trim(),
        kcal_100: macros.kcal,
        protein_100: macros.protein,
        fat_100: macros.fat,
        carbs_100: macros.carbs,
        source: "gpt",
      });
    } catch (err) {
      logger.error("[/api/dict/create_via_gpt] DB error", { error: err.message });
      return res.status(500).json({ error: "db_error" });
    }

    res.json({
      id: row.id,
      product: row.product,
      kcal_100: Number(row.kcal_100),
      protein_100: Number(row.protein_100),
      fat_100: Number(row.fat_100),
      carbs_100: Number(row.carbs_100),
      source: row.source,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  } catch (err) {
    logger.error("[/api/dict/create_via_gpt] error", { error: err.message });
    res.status(500).json({ error: "internal" });
  }
});

// ==========================
// 🧾 /api/log/add_list
// ==========================
app.post("/api/log/add_list", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "No DB connection" });

    const list = Array.isArray(req.body) ? req.body : null;
    if (!list || list.length === 0) {
      return res.status(400).json({ error: "Request body must be a non-empty array" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const item of list) {
        if (!item || typeof item !== "object") continue;

        const weight = Number(item.weight ?? item.quantity_g);
        if (!Number.isFinite(weight) || weight <= 0) {
          throw new Error("Invalid weight in list item");
        }

        let productName = item.product;

        // Если пришёл только product_id — берём имя из словаря
        if (!productName && item.product_id) {
          const byId = await client.query(
            `SELECT product FROM personal.food_dict WHERE id = $1 LIMIT 1;`,
            [item.product_id]
          );
          if (byId.rows.length > 0) {
            productName = byId.rows[0].product;
          }
        }

        if (!productName) {
          throw new Error("Either product or product_id with existing product is required");
        }

        // Убеждаемся, что продукт есть в словаре (по имени, case-insensitive)
        const existing = await client.query(
          `SELECT id FROM personal.food_dict WHERE lower(product) = lower($1) LIMIT 1;`,
          [productName]
        );

        if (existing.rows.length === 0) {
          const macros = await getMacrosFromGPT(productName);
          await client.query(
            `
              INSERT INTO personal.food_dict (
                product, kcal_100, protein_100, fat_100, carbs_100, source
              )
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (product) DO UPDATE
              SET kcal_100 = EXCLUDED.kcal_100,
                  protein_100 = EXCLUDED.protein_100,
                  fat_100 = EXCLUDED.fat_100,
                  carbs_100 = EXCLUDED.carbs_100,
                  updated_at = now();
            `,
            [
              productName,
              macros.kcal,
              macros.protein,
              macros.fat,
              macros.carbs,
              "gpt",
            ]
          );
        }

        const mealType = item.meal_type || "unspecified";

        // Вставляем лог: здесь используем только имя продукта и вес
        await client.query(
          `
            INSERT INTO personal.food_log (meal_type, product, quantity_g)
            VALUES ($1, $2, $3);
          `,
          [mealType, productName, weight]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("[/api/log/add_list] TX error", { error: err.message });
      return res.status(500).json({ error: "internal" });
    } finally {
      client.release();
    }

    // После вставки считаем статистику по сегодняшнему дню
    let stats;
    try {
      stats = await getDailyStats(new Date());
    } catch (err) {
      logger.error("[/api/log/add_list] stats error", { error: err.message });
      return res.status(500).json({ error: "stats_error" });
    }

    res.json({
      total_kcal: stats.macros_total.kcal,
      total_protein: stats.macros_total.p,
      total_fat: stats.macros_total.f,
      total_carbs: stats.macros_total.c,
      left_kcal: stats.macros_left.kcal,
      left_macros: stats.macros_left,
    });
  } catch (err) {
    logger.error("[/api/log/add_list] error", { error: err.message });
    res.status(500).json({ error: "internal" });
  }
});

// ==========================
// 📝 /api/log/update_item
// ==========================
app.post("/api/log/update_item", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "No DB connection" });

    const { id, weight } = req.body || {};

    const logId = Number(id);
    const newWeight = Number(weight);

    if (!Number.isFinite(logId) || logId <= 0) {
      return res.status(400).json({ error: "Field 'id' must be a positive number" });
    }

    if (!Number.isFinite(newWeight) || newWeight <= 0) {
      return res.status(400).json({ error: "Field 'weight' must be a positive number" });
    }

    const client = await pool.connect();
    let eatenAt;
    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT created_at FROM personal.food_log WHERE id = $1;`,
        [logId]
      );
      if (existing.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "log_not_found" });
      }

      eatenAt = existing.rows[0].created_at;

      await client.query(
        `UPDATE personal.food_log SET quantity_g = $2 WHERE id = $1;`,
        [logId, newWeight]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("[/api/log/update_item] TX error", { error: err.message });
      return res.status(500).json({ error: "internal" });
    } finally {
      client.release();
    }

    // Пересчитываем статистику по дате этого лога
    let stats;
    try {
      stats = await getDailyStats(eatenAt || new Date());
    } catch (err) {
      logger.error("[/api/log/update_item] stats error", { error: err.message });
      return res.status(500).json({ error: "stats_error" });
    }

    res.json({
      total_kcal: stats.macros_total.kcal,
      total_protein: stats.macros_total.p,
      total_fat: stats.macros_total.f,
      total_carbs: stats.macros_total.c,
      left_kcal: stats.macros_left.kcal,
      left_macros: stats.macros_left,
    });
  } catch (err) {
    logger.error("[/api/log/update_item] error", { error: err.message });
    res.status(500).json({ error: "internal" });
  }
});

// ==========================
// 🛠 /api/dict/update
// ==========================
app.post("/api/dict/update", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "No DB connection" });

    const {
      product_id,
      kcal_100,
      protein_100,
      fat_100,
      carbs_100,
    } = req.body || {};

    const id = Number(product_id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Field 'product_id' must be a positive number" });
    }

    if ([kcal_100, protein_100, fat_100, carbs_100].some((v) => v == null)) {
      return res.status(400).json({ error: "All macro fields are required" });
    }

    const sql = `
      UPDATE personal.food_dict
      SET kcal_100 = $2,
          protein_100 = $3,
          fat_100 = $4,
          carbs_100 = $5,
          updated_at = now()
      WHERE id = $1
      RETURNING id, product, source, created_at, updated_at,
                kcal_100, protein_100, fat_100, carbs_100;
    `;

    const { rows } = await pool.query(sql, [
      id,
      kcal_100,
      protein_100,
      fat_100,
      carbs_100,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "product_not_found" });
    }

    const row = rows[0];

    res.json({
      id: row.id,
      product: row.product,
      source: row.source,
      created_at: row.created_at,
      updated_at: row.updated_at,
      kcal_100: Number(row.kcal_100),
      protein_100: Number(row.protein_100),
      fat_100: Number(row.fat_100),
      carbs_100: Number(row.carbs_100),
    });
  } catch (err) {
    logger.error("[/api/dict/update] error", { error: err.message });
    res.status(500).json({ error: "internal" });
  }
});

// ==========================
// 📊 /api/stats/daily
// ==========================
app.get("/api/stats/daily", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "No DB connection" });

    const dateParam = req.query.date || new Date().toISOString().slice(0, 10);

    let stats;
    try {
      stats = await getDailyStats(dateParam);
    } catch (err) {
      logger.error("[/api/stats/daily] stats error", { error: err.message });
      return res.status(400).json({ error: "invalid_date" });
    }

    res.json({
      date: stats.date,
      macros_total: stats.macros_total,
      macros_left: stats.macros_left,
      items: stats.items,
    });
  } catch (err) {
    logger.error("[/api/stats/daily] error", { error: err.message });
    res.status(500).json({ error: "internal" });
  }
});

// Register error handler as the last middleware
app.use(errorHandler);

// ==========================
// 🚀 START
// ==========================
app.listen(config.server.port, () => {
  logger.info("API server listening", { port: config.server.port });
});
