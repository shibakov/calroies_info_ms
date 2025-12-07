const { randomUUID } = require("crypto");
const logger = require("../logger");

function requestLogger(req, res, next) {
  const start = Date.now();

  const incomingId = req.headers["x-request-id"] || req.headers["x-requestid"];
  const reqId = incomingId || randomUUID();
  req.id = reqId;

  logger.info("request:start", {
    reqId,
    method: req.method,
    path: req.path,
    query: req.query,
  });

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    logger.info("request:end", {
      reqId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: durationMs,
    });
  });

  next();
}

module.exports = { requestLogger };
