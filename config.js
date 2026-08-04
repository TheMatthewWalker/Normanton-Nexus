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

export const sqlConfig = {
  user: config.sqlConfig.user,
  password: config.sqlConfig.password,
  server: config.sqlConfig.server,
  database: config.sqlConfig.database,
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

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


// ── Production database pool (separate DB, same SQL Server) ──────────────────
let _productionPool = null;
export async function getProductionPool() {
  if (!_productionPool) {
    _productionPool = new sql.ConnectionPool({
      user:     config.sqlConfig.user,
      password: config.sqlConfig.password,
      server:   config.sqlConfig.server,
      database: 'Production',
      options:  { encrypt: false, trustServerCertificate: true },
    });
    await _productionPool.connect();
  }
  return _productionPool;
}

// ── Logistics database pool (separate DB, same SQL Server) ──────────────────
let _logisticsPool = null;
export async function getLogisticsPool() {
  if (!_logisticsPool) {
    _logisticsPool = new sql.ConnectionPool({
      user:     config.sqlConfig.user,
      password: config.sqlConfig.password,
      server:   config.sqlConfig.server,
      database: 'Logistics',
      options:  { encrypt: false, trustServerCertificate: true },
    });
    await _logisticsPool.connect();
  }
  return _logisticsPool;
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
    const pool = await sql.connect(sqlConfig);
    await pool.request()
      .input('user',  sql.NVarChar(128), username)
      .input('table', sql.NVarChar(100), tableName)
      .query(`UPDATE TOP (1) kongsberg.dbo.DataChangeLog
              SET DBUser = @user
              WHERE TableName = @table
                AND DBUser != @user
                AND ChangedAt >= DATEADD(second, -5, GETDATE())
                AND LogID = (
                  SELECT MAX(LogID) FROM kongsberg.dbo.DataChangeLog
                  WHERE TableName = @table AND ChangedAt >= DATEADD(second, -5, GETDATE())
                )`);
  } catch { /* never block the request */ }
}


// Role check helper — reads role from session (replaces config-based isAdmin)
export function isAdmin(username) {
  // For backward compat with /query endpoint — check session role directly
  return req => req.session?.user?.role === 'admin' || req.session?.user?.role === 'superadmin';
}



// ── Audit helper — writes to kongsberg.dbo.PortalAuditLog (fire-and-forget) ─────────────
export async function auditQuery(eventType, username, detail, req) {
  try {
    const pool = await sql.connect(sqlConfig);
    const ip   = req.ip || req.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  username  || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail    || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`
        INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
        VALUES (@username, @eventType, @detail, @ip)
      `);
  } catch (err) {
    console.error('[audit]', err.message);
  }
}

export default {
    printersConfig,
    sqlConfig,
    sapConfig,
    getProductionPool,
    getLogisticsPool,
    DEPT_PAGE_MAP,
    stampDbChange,
    isAdmin,
    auditQuery
}