// Centralized configuration for the calories info microservice
// All secrets (DB, external APIs) must be provided via environment variables.

function readNumber(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    if (def === undefined) return undefined;
    return def;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for ${name}: ${raw}`);
  }
  return n;
}

const config = {
  env: process.env.NODE_ENV || "development",

  server: {
    port: readNumber("PORT", 3000),
  },

  pg: {
    // On Railway this should be provided via environment
    connectionString: process.env.PG_CONNECTION_STRING || null,
  },

  usda: {
    apiKey: process.env.USDA_API_KEY || null,
    baseUrl:
      process.env.USDA_BASE_URL ||
      "https://api.nal.usda.gov/fdc/v1/foods/search",
    timeoutMs: readNumber("USDA_TIMEOUT_MS", 1500),
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || null,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    timeoutMs: readNumber("OPENAI_TIMEOUT_MS", 8000),
  },

  translate: {
    timeoutMs: readNumber("TRANSLATE_TIMEOUT_MS", 2000),
  },

  search: {
    defaultLimit: readNumber("SEARCH_LIMIT_DEFAULT", 10),
    maxLimit: readNumber("SEARCH_LIMIT_MAX", 25),
  },

  dailyTargets: {
    kcal:
      process.env.DAILY_KCAL_TARGET != null
        ? readNumber("DAILY_KCAL_TARGET")
        : null,
    protein:
      process.env.DAILY_PROTEIN_TARGET != null
        ? readNumber("DAILY_PROTEIN_TARGET")
        : null,
    fat:
      process.env.DAILY_FAT_TARGET != null
        ? readNumber("DAILY_FAT_TARGET")
        : null,
    carbs:
      process.env.DAILY_CARBS_TARGET != null
        ? readNumber("DAILY_CARBS_TARGET")
        : null,
  },
};

module.exports = config;
