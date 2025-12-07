const logger = require("../logger");

// Centralized Express error handler
// Should be registered after all routes: app.use(errorHandler)
function errorHandler(err, req, res, next) {
  // Fallbacks in case req is not defined for some reason
  const method = req?.method;
  const path = req?.path;
  const reqId = req?.id;

  logger.error("request:error", {
    reqId,
    method,
    path,
    error: err && err.message ? err.message : String(err),
    // Stack trace only in non-production environments
    stack: process.env.NODE_ENV === "production" ? undefined : err?.stack,
  });

  if (res.headersSent) {
    return next(err);
  }

  // Внешнему клиенту не светим детали, только общий ответ
  res.status(500).json({ error: "internal" });
}

module.exports = { errorHandler };
