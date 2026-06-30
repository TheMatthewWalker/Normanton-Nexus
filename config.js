const config = JSON.parse(fs.readFileSync("./config.json"));
import fs from "fs";
import sql from "mssql";

export const sapServerSecret = process.env.SAP_SERVER_SECRET
    ?? (() => { throw new Error('SAP_SERVER_SECRET env var is not set'); })();

export const printersConfig = config.printers || [];

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
    DEPT_PAGE_MAP,
    stampDbChange,
    isAdmin,
    auditQuery
}