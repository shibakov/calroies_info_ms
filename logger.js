// Simple JSON logger used across the service

function baseLog(level, msg, extra) {
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };

  // Unified, machine-readable log line
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

module.exports = {
  info(msg, extra) {
    baseLog("info", msg, extra);
  },
  warn(msg, extra) {
    baseLog("warn", msg, extra);
  },
  error(msg, extra) {
    baseLog("error", msg, extra);
  },
  debug(msg, extra) {
    baseLog("debug", msg, extra);
  },
};
