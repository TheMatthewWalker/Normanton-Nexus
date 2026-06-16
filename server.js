import 'dotenv/config';
import express from "express";
import session from "express-session";
import sql from "mssql";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";
import fs from "fs";
import bcrypt                 from 'bcrypt';
import rateLimit              from 'express-rate-limit';

import mixingRoutes            from './routes/mixing.js';
import shipmentMainRoutes      from './routes/shipmentmain.js';
import destinationsRoutes      from './routes/destinations.js';
import shipmentLinkRoutes      from './routes/shipmentlink.js';
import shipmentCostRoutes      from './routes/shipmentcost.js';
import costTypesRoutes         from './routes/costtypes.js';
import costElementsRoutes      from './routes/costelements.js';
import costCentersRoutes       from './routes/costcenters.js';
import forwardersRoutes        from './routes/forwarders.js';
import incotermsRoutes         from './routes/incoterms.js';
import deliveryMainRoutes      from './routes/deliverymain.js';
import deliveryLinkRoutes      from './routes/deliverylink.js';
import deliveryRoutesRoutes    from './routes/deliveryroutes.js';
import palletMainRoutes        from './routes/palletmain.js';
import palletPackagesRoutes    from './routes/palletpackages.js';
import ratesKNRoutes           from './routes/rateskn.js';
import ratesTPNRoutes          from './routes/ratestpn.js';
import forwarderApprovalRoutes from './routes/forwarderapproval.js';
import assignmentTPNRoutes     from './routes/assignmenttpn.js';
import palletDataRoutes        from './routes/palletdata.js';
import packagingDataRoutes     from './routes/packagingdata.js';
import palletValidationRoutes  from './routes/palletvalidation.js';
import productionRoutes        from './routes/production.js';
import productionNexusRoutes  from './routes/productionnexus.js';
import relatedRecordsRoutes    from './routes/relatedrecords.js';
import filterRecordsRoutes     from './routes/filterrecords.js';
import exportXlsxRoutes        from './routes/exportxlsx.js';
import reportRoutes            from './routes/reports.js';
import sapRoutes               from "./routes/sap.js";
import geminiRoutes            from './routes/gemini.js';
import freightBookingRoutes    from './routes/freightbooking.js';
import clearportExportRoutes  from './routes/clearportexport.js';
import qualityRoutes           from './routes/quality.js';
import labelsRoutes            from './routes/labels.js';
import financeRoutes           from './routes/finance.js';

import notificationsRoutes     from './routes/notifications.js';

import authRoutes              from './routes/auth.js';
import adminRoutes             from './routes/useradmin.js';
import { requireLogin, requireRole, requireDepartment } from './middleware/auth.js';

const httpsOptions = {
  key: fs.readFileSync("./certs/key.pem"),
  cert: fs.readFileSync("./certs/cert.pem")
};

const config = JSON.parse(fs.readFileSync("./config.json"));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 500, // limit each IP to X requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});

// apply rate limiter to all requests
app.use(limiter);

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,                          // reset expiry on each request
  cookie: {
    maxAge:   0.5 * 1000 * 60 * 60,            // 0.5 hour idle timeout
    httpOnly: true,                       // JS cannot read cookie
    sameSite: 'strict',                   // CSRF protection
    secure: true,                      // uncomment when running HTTPS
  }
}));

app.set('trust proxy', 1);

// ── Auth routes (public — no requireLogin) ───────────────────────────────────
app.use('/', authRoutes);

// ── Admin routes (requires admin role minimum) ────────────────────────────────
app.use('/api/admin', requireLogin, requireRole('admin'), adminRoutes);

// ── API routes (require login) ───────────────────────────────────────────────
app.use('/api/mixing', requireLogin,            mixingRoutes);
app.use('/api/shipmentmain', requireLogin,      shipmentMainRoutes);
app.use('/api/destinations', requireLogin,      destinationsRoutes);
app.use('/api/shipmentlink', requireLogin,      shipmentLinkRoutes);
app.use('/api/shipmentcost', requireLogin,      shipmentCostRoutes);
app.use('/api/costtypes', requireLogin,         costTypesRoutes);
app.use('/api/costelements', requireLogin,      costElementsRoutes);
app.use('/api/costcenters', requireLogin,       costCentersRoutes);
app.use('/api/forwarders', requireLogin,        forwardersRoutes);
app.use('/api/incoterms', requireLogin,         incotermsRoutes);
app.use('/api/deliverymain',   requireLogin,    deliveryMainRoutes);
app.use('/api/deliverylink',   requireLogin,    deliveryLinkRoutes);
app.use('/api/deliveryroutes', requireLogin,    deliveryRoutesRoutes);
app.use('/api/palletmain', requireLogin,        palletMainRoutes);
app.use('/api/palletpackages', requireLogin,    palletPackagesRoutes);
app.use('/api/rateskn', requireLogin,           ratesKNRoutes);
app.use('/api/ratestpn', requireLogin,          ratesTPNRoutes);
app.use('/api/forwarderapproval', requireLogin, forwarderApprovalRoutes);
app.use('/api/assignmenttpn', requireLogin,     assignmentTPNRoutes);
app.use('/api/palletdata', requireLogin,        palletDataRoutes);
app.use('/api/packagingdata', requireLogin,     packagingDataRoutes);
app.use('/api/palletvalidation', requireLogin,  palletValidationRoutes);
app.use('/api/production',       requireLogin, productionRoutes);
app.use('/api/productionnexus', requireLogin, productionNexusRoutes);
app.use('/api/related-records', requireLogin,   relatedRecordsRoutes);
app.use('/api/filter-records', requireLogin,    filterRecordsRoutes);
app.use('/api/export-xlsx', requireLogin,       exportXlsxRoutes);
app.use('/api/reports', requireLogin,           reportRoutes);
app.use('/api/sap', requireLogin,               sapRoutes);
app.use('/api/gemini', requireLogin,            geminiRoutes);
app.use('/api/freight-booking', requireLogin,   freightBookingRoutes);
app.use('/api/clearport',      requireLogin,   clearportExportRoutes);
app.use('/api/quality',       requireLogin,   qualityRoutes);
app.use('/api/labels',        requireLogin,   labelsRoutes);
app.use('/api/finance',       requireLogin,   financeRoutes);
app.use('/api/notifications', requireLogin,   notificationsRoutes);


// Serve static front-end files
app.use(express.static(path.join(process.cwd(), "public")));


// ── Department page map — which HTML page requires which department ────────────
const DEPT_PAGE_MAP = {
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

// Serve protected pages
app.get('/private/:page', requireLogin, (req, res, next) => {
  const page = req.params.page;
  const dept = DEPT_PAGE_MAP[page];

  // If it maps to a department, check access (superadmin bypasses this in middleware)
  if (dept) {
    return requireDepartment(dept)(req, res, () => {
      res.sendFile(path.join(__dirname, 'private', page));
    });
  }

  // admin.html — admin role minimum
  if (page === 'admin.html') {
    return requireRole('admin')(req, res, () => {
      res.sendFile(path.join(__dirname, 'private', page));
    });
  }

  // rawsql.html — superadmin only
  if (page === 'rawsql.html') {
    return requireRole('superadmin')(req, res, () => {
      res.sendFile(path.join(__dirname, 'private', page));
    });
  }

  // landing.html and other pages — just requireLogin (already checked)
  res.sendFile(path.join(__dirname, 'private', page));
});

app.get('/private/js/:file', requireLogin, (req, res) => {
  const filePath = path.join(__dirname, 'private', 'js', req.params.file);
  res.sendFile(filePath);
});

app.get('/private/css/:file', requireLogin, (req, res) => {
  const filePath = path.join(__dirname, 'private', 'css', req.params.file);
  res.sendFile(filePath);
});

app.get('/private/images/:file', requireLogin, (req, res) => {
  const filePath = path.join(__dirname, 'private', 'images', req.params.file);
  res.sendFile(filePath);
});

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

export const sapServerSecret = process.env.SAP_SERVER_SECRET
    ?? (() => { throw new Error('SAP_SERVER_SECRET env var is not set'); })();

export const printersConfig = config.printers || [];

// Role check helper — reads role from session (replaces config-based isAdmin)
function isAdmin(username) {
  // For backward compat with /query endpoint — check session role directly
  return req => req.session?.user?.role === 'admin' || req.session?.user?.role === 'superadmin';
}

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

// ── Audit helper — writes to kongsberg.dbo.PortalAuditLog (fire-and-forget) ─────────────
async function auditQuery(eventType, username, detail, req) {
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

// ✅ Query API (still requires API key)
app.post("/query", requireLogin, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });

  // Normalize query for case-insensitive checking
  const normalized = query.trim().toUpperCase();

  // Allow Admin to by-pass the block.
  const userRole   = req.session?.user?.role;
  const username   = req.session?.user?.username || null;
  const serverAdmin = userRole === 'admin' || userRole === 'superadmin';

  if (!serverAdmin) {
    // 🚫 Block any dangerous keywords even if embedded later
    const forbidden = ["DELETE", "DROP", "UPDATE", "INSERT", "ALTER", "TRUNCATE", "EXEC", "MERGE"];
    if (forbidden.some(word => normalized.includes(word))) {
      auditQuery('RAW_SQL_BLOCKED', username, query.slice(0, 500), req);
      return res.status(403).json({ error: `Forbidden keyword detected: one of ${forbidden.join(", ")}` });
    }
  }

  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(query);
    auditQuery('RAW_SQL', username, query.slice(0, 500), req);
    // Always return JSON, even if recordset is empty (e.g., for INSERT/DELETE)
    res.json({
      success: true,
      rowsAffected: result.rowsAffected,   // array of rows affected per statement
      recordset: result.recordset || []    // will be empty if no SELECT returned
    });
  } catch (err) {
    console.error('[SQL]', err.message, err.number ? `(#${err.number})` : '');
    auditQuery('RAW_SQL_ERROR', username, `${query.slice(0, 400)} — ERR: ${err.message.slice(0, 80)}`, req);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ POST version for Excel or tools sending long queries
app.post("/query-csv", async (req, res) => {
  const { query, key } = req.body;
  if (key !== config.apiKey) return res.status(403).send(key + " " + query);
  if (!query) return res.status(400).send("Missing query");

  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(query);

    
    // INSERT / UPDATE / DELETE
    if (!result.recordset) {
      const rows = result.rowsAffected?.[0] ?? 0;

      return res.status(200).json({
        success: true,
        rowsAffected: rows,
        message: rows === 0
          ? "Query executed successfully (no rows affected)"
          : `${rows} row(s) affected`
      });
    }

    // SELECT
    const rows = result.recordset;
    if (rows.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Query executed successfully (no data returned)"
      });
    }

    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(";"),
      ...rows.map(row =>
        headers.map(h => JSON.stringify(row[h] ?? "")).join(";")
      )
    ].join("\r\n");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Disposition", "attachment; filename=results.csv");
    res.setHeader("Content-Type", "text/csv");
    res.send(csv);

  } catch (err) {
    console.error('[SQL]', err.message, err.number ? `(#${err.number})` : '');
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});



https.createServer(httpsOptions, app).listen(443, () => {
  console.log("✅ HTTPS server running on port 443");
});


http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
}).listen(80);


//app.listen(4000, "0.0.0.0", () => console.log("✅ SQL2005 Bridge accessible on network port 4000"));

