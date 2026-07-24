/**
 * lib/logTimestamp.js
 *
 * Prefixes every console.log/info/warn/error call with a timestamp.
 * Previously log lines like "[cron] turns-valclass refresh complete [...]"
 * carried no timestamp at all — daemon/normantonnexus.out.log and .err.log
 * are just raw captured stdout/stderr (WinSW doesn't add its own per-line
 * timestamps the way SapServer's Serilog does), so there was no way to
 * tell from the log alone when a cron run actually happened, or how far
 * apart two lines were in time.
 *
 * MUST be the first import in server.js (before every route module) — ESM
 * import statements execute top-to-bottom, module by module, so patching
 * console here before anything else is imported guarantees every
 * subsequent console call anywhere in the app — cron callbacks, route
 * handlers, module-load-time logging — goes through this prefix. Importing
 * it later would miss anything a module logs at load time.
 *
 * Format: "YYYY-MM-DD HH:mm:ss.SSS +HH:MM" in local server time —
 * deliberately matches SapServer's Serilog timestamp format (see
 * SapServer/appsettings.json's Serilog config) so log lines from both
 * processes can be lined up by eye without a timezone conversion.
 */

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function formatOffset(date) {
  // getTimezoneOffset() returns minutes WEST of UTC (e.g. +60 for UTC-1),
  // which is the opposite sign convention from the "+01:00" style suffix
  // we want, so it's negated here.
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function formatTimestamp(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ` +
    formatOffset(date)
  );
}

for (const method of ['log', 'info', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    original(`[${formatTimestamp(new Date())}]`, ...args);
  };
}
