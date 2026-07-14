import 'dotenv/config';
import express from "express";
import session from "express-session";
import sql from "mssql";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";
import fs from "fs";
import crypto from "crypto";
import { spawn }             from 'child_process';
import bcrypt                 from 'bcrypt';
import rateLimit              from 'express-rate-limit';
import cron                   from 'node-cron';

import configJS                 from './config.js';

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
import deliveryMainRoutes, { runSapSync } from './routes/deliverymain.js';
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
import productionNexusRoutes   from './routes/productionnexus.js';
import relatedRecordsRoutes    from './routes/relatedrecords.js';
import filterRecordsRoutes     from './routes/filterrecords.js';
import exportXlsxRoutes        from './routes/exportxlsx.js';
import reportRoutes            from './routes/reports.js';
import sapRoutes               from "./routes/sap.js";
import geminiRoutes            from './routes/gemini.js';
import freightBookingRoutes    from './routes/freightbooking.js';
import clearportExportRoutes   from './routes/clearportexport.js';
import qualityRoutes           from './routes/quality.js';
import labelsRoutes            from './routes/labels.js';
import financeRoutes           from './routes/finance.js';
import notificationsRoutes     from './routes/notifications.js';
import performanceRoutes       from './routes/performance.js';
import sqlQueriesRoutes        from './routes/sqlqueries.js';
import { runFullRefresh, runTurnsValClassRefresh } from './routes/performancesync.js';
//import testOtifInsertRoutes     from './routes/test-otif-insert.js';
import debugRoutes             from './routes/debugsap.js';

import authRoutes              from './routes/auth.js';
import adminRoutes             from './routes/useradmin.js';
import deployRoutes            from './routes/deploy.js';
import { requireLogin, requireRole, requireDepartment } from './middleware/auth.js';

const httpsOptions = {
  key: fs.readFileSync("./certs/key.pem"),
  cert: fs.readFileSync("./certs/cert.pem")
};

const config = JSON.parse(fs.readFileSync("./config.json"));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// A fresh random value generated once, when THIS process starts — used by
// deploy-runner.cjs to prove that a restart actually replaced the running
// process, rather than just observing that "something" is answering on
// port 443 (a stale process left over from an incomplete Windows Service
// stop could otherwise keep answering and be mistaken for a successful
// restart — see GET /api/health below).
const BOOT_ID = crypto.randomUUID();
const SERVER_STARTED_AT = new Date().toISOString();

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


// ── Scheduled refresh ─────────────────────────────────────────────────────
// Every 30 minutes
cron.schedule('0,30 * * * *', () => {
  console.log('[cron] starting scheduled refresh');
  runFullRefresh()
    .then(results => console.log('[cron] refresh complete', results))
    .catch(err => console.error('[cron] refresh failed', err));
});

// MM Turns / Valuation Class — once a day at 05:45. Heavier pull (full material
// master + 13-month history/forecast) that only needs to reflect yesterday's
// close, so it's kept off the 30-min cycle above.
cron.schedule('45 5 * * *', () => {
  console.log('[cron] starting scheduled turns-valclass refresh');
  runTurnsValClassRefresh()
    .then(results => console.log('[cron] turns-valclass refresh complete', results))
    .catch(err => console.error('[cron] turns-valclass refresh failed', err));
});

// Warehouse SAP sync (open picksheets -> DeliveryMain) — every hour at xx:55
// (to avoid clashing with the 30-min refresh at xx:00 and xx:30).
cron.schedule('55 * * * *', () => {
  console.log('[cron] starting scheduled warehouse SAP sync');
  runSapSync()
    .then(result => console.log('[cron] warehouse SAP sync complete', result))
    .catch(err => console.error('[cron] warehouse SAP sync failed', err));
});

// Scheduled deployment checker — every minute. Looks for due, pending rows
// in ScheduledDeployments and hands each one off to a detached
// deploy-runner.cjs process (git pull + Windows Service restart). Detached
// so it survives this very process being killed mid-restart — see
// deploy-runner.cjs for the full explanation.
cron.schedule('* * * * *', async () => {
  try {
    const pool = await sql.connect(configJS.sqlConfig);
    const due = await pool.request().query(`
      UPDATE kongsberg.dbo.ScheduledDeployments
      SET Status = 'running', StartedAt = GETDATE()
      OUTPUT INSERTED.DeploymentID
      WHERE Status = 'pending' AND ScheduledAt <= GETDATE()
    `);
    for (const row of due.recordset) {
      console.log(`[cron] triggering scheduled deployment #${row.DeploymentID}`);
      // stdio is redirected to deploy-runner.log (NOT 'ignore') — deploy-runner.cjs
      // logs every step it takes, and this was previously being discarded entirely,
      // which is why a stuck/failed deployment showed zero diagnostic evidence.
      const logFd = fs.openSync(path.join(__dirname, 'deploy-runner.log'), 'a');
      const child = spawn(
        process.execPath,
        [path.join(__dirname, 'deploy-runner.cjs'), String(row.DeploymentID)],
        { detached: true, stdio: ['ignore', logFd, logFd], cwd: __dirname }
      );
      fs.closeSync(logFd); // the child keeps its own handle to the same file
      child.unref();
    }
  } catch (err) {
    console.error('[cron] deployment checker failed', err);
  }
});

// ── Auth routes (public — no requireLogin) ───────────────────────────────────
app.use('/', authRoutes);

// ── Health/identity endpoint — intentionally public (no requireLogin) ──────
// Purely for deploy-runner.cjs's restart verification (and general poking).
// pid + bootId together let a caller distinguish "the same process is still
// running" from "a genuinely new process is now serving requests".
app.get('/api/health', (req, res) => {
  res.json({ ok: true, pid: process.pid, bootId: BOOT_ID, startedAt: SERVER_STARTED_AT });
});

// ── Admin routes (requires admin role minimum) ────────────────────────────────
app.use('/api/admin', requireLogin, requireRole('admin'), adminRoutes);

// ── Scheduled deployments (superadmin manages; /next is any logged-in user) ─
app.use('/api/deploy', requireLogin, deployRoutes);

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
app.use('/api/performance', requireLogin, performanceRoutes);
app.use('/sql', requireLogin, sqlQueriesRoutes);
//app.use('/test-otif-insert', requireLogin, testOtifInsertRoutes);
app.use('/api/debug', debugRoutes);

// Serve static front-end files
app.use(express.static(path.join(process.cwd(), "public")));

// Serve protected pages
app.get('/private/:page', requireLogin, (req, res, next) => {
  const page = req.params.page;
  const dept = configJS.DEPT_PAGE_MAP[page];

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


const httpsServer = https.createServer(httpsOptions, app).listen(443, () => {
  console.log("✅ HTTPS server running on port 443");
});
httpsServer.on('error', err => {
  // Most likely EADDRINUSE — a previous instance is still bound to the
  // port. Fail loudly and exit rather than limping along with no server
  // actually listening; the Windows Service wrapper's own restart/recovery
  // behavior (and deploy-runner.cjs's verification, when this happens
  // during a deploy) depend on a crash here being visible and unambiguous.
  console.error('❌ HTTPS server failed to start:', err.message);
  process.exit(1);
});


const httpServer = http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
}).listen(80);
httpServer.on('error', err => {
  console.error('❌ HTTP redirect server failed to start:', err.message);
});

// ── Graceful shutdown ───────────────────────────────────────────────────
// The Windows Service stop (see deploy-runner.cjs / restart.cjs) delivers
// this via an emulated SIGINT — Windows has no real POSIX signal delivery
// to a background service process, and that emulation is not always
// reliably received (observed directly in daemon/normantonnexus.wrapper.log
// falling back to a forced kill). Handling the signal explicitly here and
// exiting promptly gives it the best chance of working cleanly, so the
// process is actually gone before anything tries to start a new one on top
// of it.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal} — shutting down…`);
  const forceExit = setTimeout(() => {
    console.warn('[server] graceful shutdown timed out — forcing exit.');
    process.exit(0);
  }, 8000);
  forceExit.unref();
  httpsServer.close(() => {});
  httpServer.close(() => {});
  // Don't wait indefinitely on close() — an idle keep-alive socket can hold
  // it open well past when we actually want to exit.
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));


//app.listen(4000, "0.0.0.0", () => console.log("✅ SQL2005 Bridge accessible on network port 4000"));

