const config = JSON.parse(fs.readFileSync("./config.json"));
import fs from "fs";
import sql from "mssql";

export const sapServerSecret = process.env.SAP_SERVER_SECRET
    ?? (() => { throw new Error('SAP_SERVER_SECRET env var is not set'); })();

// ── Per-user SAP credential encryption key ──────────────────────────────────
// AES-256-GCM key (32 bytes) for encrypting each user's own SAP password at
// rest in PortalUsers.SapPasswordEncrypted — see lib/sapCredentials.js.
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Expected as a 64-character hex string.
//
// Deliberately NOT a hard throw-at-startup like sapServerSecret above: this
// key is being added to an app that's already running in production, and a
// missing env var here should only break the one feature that needs it (SAP
// credential save/use), not take down every other route on next restart.
// lib/sapCredentials.js throws when this is actually missing and someone
// tries to encrypt/decrypt — not before.
export const sapCredEncryptionKey = process.env.SAP_CRED_ENCRYPTION_KEY || null;

export const printersConfig = config.printers || [];

// Shared API key gating POST /api/query-csv (routes/sqlqueries.js) for
// external tools (Excel, etc.) that can't hold a portal session.
export const apiKey = config.apiKey;

export const resendAPI = process.env.RESEND_API_KEY
    ?? (() => { throw new Error('RESEND_API_KEY env var is not set'); })();

// ── Session idle timeout ──────────────────────────────────────────────────
// Default session cookie maxAge (server.js's session() config), and the
// shorter override for users with ShortIdleTimeout = 1 on PortalUsers
// (toggled per user in User Administration — see routes/useradmin.js and
// sql/migrate_short_idle_timeout.sql). Shared here so server.js's
// cookie-maxAge-refresh middleware and routes/auth.js's login handler
// always compute the exact same value from the exact same place.
export const IDLE_TIMEOUT_MS       = 0.5 * 1000 * 60 * 60; // 30 minutes — default
export const SHORT_IDLE_TIMEOUT_MS = 5   * 1000 * 60;      // 5 minutes — flagged users

export function idleTimeoutMsFor(sessionUser) {
  return sessionUser?.shortIdleTimeout ? SHORT_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
}

export const sapConfig = {
  system: config.sapConfig.system,
  systemNumber: config.sapConfig.systemNumber,
  client: config.sapConfig.client,
  user: config.sapConfig.user,
  password: config.sapConfig.password,
  lang: config.sapConfig.lang,
  url: config.sapConfig.url
};


// ── Nexus / NexusOperations / NexusArchive pools ──────────────────────────
// The pre-defined, independently-configurable pools every route/lib file
// uses to reach the SQL Server instance (see migrations/README.md for the
// Kongsberg/Production/Logistics -> Nexus/NexusOperations/NexusArchive
// restructure this replaced).
//
// Each pool's connection details come from config.json's optional
// `sqlPools.<name>` block; anything not overridden there falls back to the
// same server/user/password every other pool already uses
// (config.json's sqlConfig), with only the database name defaulting to the
// pool's own conventional name. This is the actual point of this whole
// refactor: moving ONE database to a new server is "add a sqlPools.<name>
// block naming the new server" — every other pool is untouched.
//
// e.g. to move just NexusOperations to a new server:
//   "sqlPools": { "nexusOperations": { "server": "NEW-SERVER", "user": "...", "password": "..." } }
// (database name still defaults to "NexusOperations" unless also overridden)
function resolvePoolConfig(databaseName, poolName) {
  const override = config.sqlPools?.[poolName];
  return {
    user:     override?.user     ?? config.sqlConfig.user,
    password: override?.password ?? config.sqlConfig.password,
    server:   override?.server   ?? config.sqlConfig.server,
    database: override?.database ?? databaseName,
    options:  { encrypt: false, trustServerCertificate: true },
  };
}

// Wraps a config-resolving function into a cached pool getter. The pool is
// only cached once .connect() actually succeeds — a failed first connect
// would otherwise permanently wedge the cache with a dead pool if the
// ConnectionPool instance were assigned before awaiting .connect(), since
// every later call would just return that same broken object forever, with
// no reconnect and no retry, until the whole process restarted.
// `pool.connected` is also rechecked on every call, so a pool that later
// drops (server restart, network blip) gets transparently reconnected
// instead of silently served from a dead connection.
function makePoolGetter(getConfig) {
  let pool = null;
  return async function getPool() {
    if (pool && pool.connected) return pool;
    const candidate = new sql.ConnectionPool(getConfig());
    await candidate.connect(); // only cache below on success
    pool = candidate;
    return pool;
  };
}

export const getNexusPool = makePoolGetter(() => resolvePoolConfig('Nexus', 'nexus'));
export const getNexusOperationsPool = makePoolGetter(() => resolvePoolConfig('NexusOperations', 'nexusOperations'));

// NexusArchive — the legacy pre-Production-Nexus per-process tables
// (Mixing/Extrusion/Convo/Ewald/Firewall/Batches/Coils/Waste/etc., plus the
// old dbo.ScrapReasons), kept for historical reference. Only a handful of
// read-only legacy lookup endpoints (routes/mixing.js, routes/production.js,
// routes/reports.js) still query these — see migrations/README.md. NOTE: as
// of this pool's introduction, no data has been copied from the old
// kongsberg-hosted copies of these tables into NexusArchive yet (schema
// only) — those three endpoints will return empty results until that
// separate, deliberate data-migration step happens.
export const getNexusArchivePool = makePoolGetter(() => resolvePoolConfig('NexusArchive', 'nexusArchive'));

// ── Isolated ad-hoc connection — for arbitrary/operator-supplied raw SQL
// (the admin SQL console) where a query might contain a session-scoped
// statement like `USE <database>`. `USE` changes the *default database* for
// whichever physical connection it runs on, and that change persists on
// that connection until it's closed or another `USE` runs on it. The cached
// pools above (getNexusPool, etc.) are shared by every route — including
// session validation against dbo.PortalSessions — and hand out their
// physical connections round-robin, so a `USE` issued through a shared pool
// silently corrupts whichever unrelated request next reuses that same
// connection. This getter always opens a brand-new, uncached ConnectionPool
// so any such state change is discarded when the caller closes it —
// never returned to a shared pool. Callers must always pool.close() when done.
export async function getIsolatedNexusConnection() {
  const pool = new sql.ConnectionPool(resolvePoolConfig('Nexus', 'nexus'));
  await pool.connect();
  return pool;
}


// ── Department page map — which HTML page requires which department ────────────
export const DEPT_PAGE_MAP = {
  'production.html':        'production',
  'production-nexus.html':  'production',
  'logistics.html':   'logistics',
  'warehouse.html':   'warehouse',
  'finance.html':     'finance',
  'sales.html':       'sales',
  'quality.html':     'quality',
  'engineering.html': 'engineering',
  'management.html':  'management',
};


// ── DB change enrichment — stamps the portal username on the last trigger-written row ─────
// The SQL trigger writes DBUser=SYSTEM_USER (the app's SQL login). Call this immediately
// after any INSERT/UPDATE/DELETE to backfill the portal username on the DataChangeLog row
// that the trigger just created for the same SPID in the last few milliseconds.
// Fire-and-forget — never throws.
export async function stampDbChange(username, tableName) {
  if (!username || !tableName) return;
  try {
    const pool = await getNexusPool();
    await pool.request()
      .input('user',  sql.NVarChar(128), username)
      .input('table', sql.NVarChar(100), tableName)
      .query(`UPDATE TOP (1) dbo.DataChangeLog
              SET DBUser = @user
              WHERE TableName = @table
                AND DBUser != @user
                AND ChangedAt >= DATEADD(second, -5, GETDATE())
                AND LogID = (
                  SELECT MAX(LogID) FROM dbo.DataChangeLog
                  WHERE TableName = @table AND ChangedAt >= DATEADD(second, -5, GETDATE())
                )`);
  } catch { /* never block the request */ }
}


// Role check helper — reads role from session (replaces config-based isAdmin)
export function isAdmin(username) {
  // For backward compat with /query endpoint — check session role directly
  return req => req.session?.user?.role === 'admin' || req.session?.user?.role === 'superadmin';
}



// ── Audit helper — writes to Nexus dbo.PortalAuditLog (fire-and-forget) ─────────────
export async function auditQuery(eventType, username, detail, req) {
  try {
    const pool = await getNexusPool();
    const ip   = req.ip || req.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  username  || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail    || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`
        INSERT INTO dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
        VALUES (@username, @eventType, @detail, @ip)
      `);
  } catch (err) {
    console.error('[audit]', err.message);
  }
}

export default {
    printersConfig,
    sapConfig,
    getNexusPool,
    getNexusOperationsPool,
    getNexusArchivePool,
    getIsolatedNexusConnection,
    DEPT_PAGE_MAP,
    stampDbChange,
    isAdmin,
    auditQuery
}