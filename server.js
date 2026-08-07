import './lib/logTimestamp.js'; // must stay first — see file header for why
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
import { execFile }          from 'child_process';
import bcrypt                 from 'bcrypt';
import rateLimit              from 'express-rate-limit';
import cron                   from 'node-cron';

import configJS                 from './config.js';
import { notify }               from './lib/notify.js';

import mixingRoutes            from './routes/mixing.js';
import shipmentMainRoutes      from './routes/shipmentmain.js';
import destinationsRoutes      from './routes/destinations.js';
import shipmentLinkRoutes      from './routes/shipmentlink.js';
import shipmentCostRoutes      from './routes/shipmentcost.js';
import costTypesRoutes         from './routes/costtypes.js';
import costElementsRoutes      from './routes/costelements.js';
import costCentersRoutes       from './routes/costcenters.js';
import forwardersRoutes        from './routes/forwarders.js';
import materialGroupsRoutes    from './routes/materialgroups.js';
import customsReportRoutes      from './routes/customsreport.js';
import customsReportAdminRoutes from './routes/customsreportadmin.js';
import forwarderModeMappingRoutes from './routes/forwardermodemapping.js';
import incotermsRoutes         from './routes/incoterms.js';
import inboundCostsRoutes      from './routes/inboundcosts.js';
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
import profileRoutes           from "./routes/profile.js";
import geminiRoutes            from './routes/gemini.js';
import freightBookingRoutes    from './routes/freightbooking.js';
import clearportExportRoutes   from './routes/clearportexport.js';
import qualityRoutes           from './routes/quality.js';
import labelsRoutes            from './routes/labels.js';
import financeRoutes           from './routes/finance.js';
import notificationsRoutes     from './routes/notifications.js';
import performanceRoutes       from './routes/performance.js';
import stagingRoutes           from './routes/staging.js';
import consignmentRoutes, { runConsignmentSync } from './routes/consignment.js';
import productionScheduleRoutes, { runProductionScheduleOtifDiff } from './routes/productionschedule.js';
import salesRoutes              from './routes/sales.js';
import packagingRoutes          from './routes/packaging.js';
import sqlQueriesRoutes        from './routes/sqlqueries.js';
import { runFullRefresh, runTurnsValClassRefresh } from './routes/performancesync.js';
//import testOtifInsertRoutes     from './routes/test-otif-insert.js';
import debugRoutes             from './routes/debugsap.js';

import authRoutes              from './routes/auth.js';
import adminRoutes             from './routes/useradmin.js';
import dbExplorerRoutes        from './routes/dbexplorer.js';
import deployRoutes            from './routes/deploy.js';
import { requireLogin, requireRole, requireDepartment } from './middleware/auth.js';
import { SqlSessionStore }     from './lib/sqlSessionStore.js';
import { IDLE_TIMEOUT_MS, idleTimeoutMsFor } from './config.js';

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

// SQL Server-backed session store (lib/sqlSessionStore.js) — persists
// sessions to kongsberg.dbo.PortalSessions instead of express-session's
// default in-memory MemoryStore, so a server restart (scheduled deploy,
// crash, manual bounce) no longer logs everyone out silently. Requires
// sql/migrate_portal_sessions.sql to have been run.
const sessionStore = new SqlSessionStore();

app.use(session({
  secret: config.sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,                          // reset expiry on each request
  cookie: {
    maxAge:   IDLE_TIMEOUT_MS,            // 30 min default — see config.js
    httpOnly: true,                       // JS cannot read cookie
    sameSite: 'strict',                   // CSRF protection
    secure: true,                      // uncomment when running HTTPS
  }
}));

// Per-user idle-timeout override — users with ShortIdleTimeout = 1 on
// PortalUsers (toggled in User Administration) get a 5-minute idle timeout
// instead of the 30-minute default. req.session.user.shortIdleTimeout is
// set once at login (routes/auth.js); this just re-applies the right
// maxAge to the cookie on every request so `rolling: true` refreshes it to
// the correct duration each time, not always the default. Cheap: mutating
// cookie.maxAge doesn't count as a session change for resave purposes
// (express-session's dirty-check ignores the cookie), so this still only
// costs a touch(), not a full set(), on the SQL session store.
app.use((req, res, next) => {
  if (req.session?.user) {
    req.session.cookie.maxAge = idleTimeoutMsFor(req.session.user);
  }
  next();
});

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

// Expired session cleanup — hourly. sessionStore.get() already ignores
// expired rows on its own, so this is pure housekeeping to stop
// kongsberg.dbo.PortalSessions growing unbounded with rows nobody will
// ever read again (logged-out/idle-timed-out sessions).
cron.schedule('20 * * * *', () => {
  sessionStore.cleanupExpired()
    .then(count => { if (count) console.log(`[cron] session cleanup removed ${count} expired session(s)`); })
    .catch(err => console.error('[cron] session cleanup failed', err));
});

// Production Schedule OTIF tracker — once a day at 06:10 (after the 05:45
// turns-valclass job, clear of the 30-min refresh at xx:00/xx:30 and the
// warehouse sync at xx:55). Deliberately daily, not every 30 min: this
// diffs dbo.AgreementSnapshot against dbo.OrderFulfillmentTracking and
// treats a line's disappearance as "completed" — running it every 30 min
// would risk reading a transient SAP sync gap as a real completion. See
// sql/migrate_production_schedule.sql and routes/productionschedulesql.js.
cron.schedule('10 6 * * *', () => {
  console.log('[cron] starting production schedule OTIF diff');
  runProductionScheduleOtifDiff()
    .then(result => console.log('[cron] production schedule OTIF diff complete', result))
    .catch(err => console.error('[cron] production schedule OTIF diff failed', err));
});

// Vendor Consignment Tracker GR + stock sync — once a day at 06:20 (after
// the 05:45 turns-valclass job and 06:10 OTIF diff, clear of the 30-min
// refresh and the warehouse sync at xx:55, and deliberately NOT sharing the
// 05:45 turns-valclass slot even though both jobs pull consignment stock —
// keeping this on its own slot means a slow/failed turns-valclass run can't
// hold up the balance dashboard's data, and vice versa). Pulls fresh
// consignment goods-receipt lines for every active vendor with a
// SapVendorNumber set, then refreshes dbo.ConsignmentStockSnapshot once —
// see routes/consignment.js's runConsignmentSync and
// sql/migrate_consignment_tracker.sql / migrate_consignment_stock_snapshot.sql
// for the full feature writeup.
cron.schedule('20 6 * * *', () => {
  console.log('[cron] starting consignment GR + stock sync');
  runConsignmentSync()
    .then(results => console.log('[cron] consignment GR + stock sync complete', results))
    .catch(err => console.error('[cron] consignment GR + stock sync failed', err));
});

// Runs `schtasks args...` and resolves { ok, stdout, stderr }, never
// rejects — mirrors restart-lib.cjs's runCommand() (async execFile, no
// shell, own timeout) so a hung schtasks.exe can never block this cron
// tick or the rest of the process.
function runSchtasks(args, timeoutMs = 15000) {
  return new Promise(resolve => {
    let settled = false;
    const child = execFile('schtasks', args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err || null });
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best effort */ }
      resolve({ ok: false, stdout: '', stderr: '', error: new Error(`schtasks ${args.join(' ')} timed out`) });
    }, timeoutMs).unref();
  });
}

// Scheduled deployment checker — every 15 seconds (a plain 1-minute cron
// tick meant the actual restart could lag up to 60s behind the scheduled
// time and the countdown banner hitting zero; node-cron's optional leading
// seconds field lets this tick far more often without switching away from
// node-cron for just this one job). Looks for due, pending rows in
// ScheduledDeployments and hands each one off to deploy-runner.cjs via a
// ONE-SHOT Task Scheduler task, NOT a direct child_process.spawn.
//
// WHY: a plain spawn(..., { detached: true }) used to be used here, on the
// theory that `detached` + .unref() is enough to survive this very process
// (running under the "Normanton Nexus" Windows Service) being killed
// mid-restart. It isn't, on Windows: node-windows wraps the service via
// WinSW, which runs it inside a Job Object with kill-on-close semantics
// specifically so no child process ever outlives the service. `detached`
// only creates a new process group — it does NOT exempt the child from the
// parent's Job Object (that needs CREATE_BREAKAWAY_FROM_JOB, which Node's
// spawn() never sets on Windows). Confirmed directly: a scheduled
// deployment force-killed the OLD server.js process (forceKillPort443() in
// restart-lib.cjs) and deploy-runner.log went dead silent at exactly that
// line — the whole Job Object, including the spawned deploy-runner.cjs
// process itself, was torn down along with the process it had just killed,
// before it ever got to call svc.start() again. The service stayed down
// with nothing left running to notice or recover.
//
// A Task Scheduler task is launched by the Task Scheduler service
// (svchost.exe), a completely separate process lineage from server.js —
// same reason SapServer itself runs via Task Scheduler rather than a
// Windows Service (see that repo's CLAUDE.md). deploy-runner.cjs now does
// its own logging directly to deploy-runner.log (see that file) rather
// than relying on stdio redirection here, since a Task Scheduler-launched
// process has no inherited stdio to redirect. It also deletes its own
// one-shot task on every exit path (success or failure) — see
// cleanupScheduledTask() there.
cron.schedule('*/15 * * * * *', async () => {
  try {
    const pool = await sql.connect(configJS.sqlConfig);
    const due = await pool.request().query(`
      UPDATE kongsberg.dbo.ScheduledDeployments
      SET Status = 'running', StartedAt = GETDATE()
      OUTPUT INSERTED.DeploymentID
      WHERE Status = 'pending' AND ScheduledAt <= GETDATE()
    `);
    for (const row of due.recordset) {
      const taskName = `NNDeployRunner_${row.DeploymentID}`;
      const scriptPath = path.join(__dirname, 'deploy-runner.cjs');
      console.log(`[cron] triggering scheduled deployment #${row.DeploymentID} via Task Scheduler task ${taskName}`);

      // /sc once /sd/st in the past + /f (force-overwrite, in case a
      // previous run's self-cleanup failed) — the schedule itself is
      // irrelevant since this is always launched immediately via a
      // separate `/run` right below, never left to fire on its own.
      const createResult = await runSchtasks([
        '/create', '/tn', taskName,
        '/tr', `"${process.execPath}" "${scriptPath}" ${row.DeploymentID}`,
        '/sc', 'once', '/sd', '01/01/2020', '/st', '00:00',
        '/ru', 'SYSTEM', '/rl', 'HIGHEST', '/f',
      ]);
      const runResult = createResult.ok ? await runSchtasks(['/run', '/tn', taskName]) : createResult;

      if (!runResult.ok) {
        const detail = `Failed to launch deploy-runner.cjs via Task Scheduler (task ${taskName}): ` +
          (runResult.stderr || runResult.error?.message || 'unknown schtasks failure');
        console.error(`[cron] ${detail}`);
        // Don't leave the row stuck at 'running' forever with nothing ever
        // going to pick it back up — the whole point of the safety-net
        // logic below is redundant if this specific failure mode isn't
        // itself recorded immediately.
        await pool.request()
          .input('id',  sql.Int, row.DeploymentID)
          .input('err', sql.NVarChar(sql.MAX), detail)
          .query(`UPDATE kongsberg.dbo.ScheduledDeployments
                  SET Status = 'failed', CompletedAt = GETDATE(), ErrorMessage = @err
                  WHERE DeploymentID = @id`);
        await notifyDeployFailed(pool, row.DeploymentID, detail);
      }
    }
  } catch (err) {
    console.error('[cron] deployment checker failed', err);
  }
});

// Safety net — every 5 minutes. A deployment stuck at 'running' for a long
// time (deploy-runner.cjs crashed, was killed, or the box itself rebooted
// mid-restart) would otherwise sit 'running' forever with nothing left to
// ever clear it, permanently pinning the countdown banner (GET /next
// unconditionally shows any 'running' row). deploy-runner.cjs's own
// SERVICE_RESTART_TIMEOUT_MS watchdog caps a genuinely-still-working run at
// 10 minutes, so 20 minutes here is a comfortable margin past that, not a
// tight race against it.
cron.schedule('*/5 * * * *', async () => {
  try {
    const pool = await sql.connect(configJS.sqlConfig);
    const stuck = await pool.request().query(`
      UPDATE kongsberg.dbo.ScheduledDeployments
      SET Status = 'failed', CompletedAt = GETDATE(),
          ErrorMessage = 'Stuck at running for over 20 minutes with no completion — deploy-runner.cjs likely crashed, was killed, or the host restarted mid-deployment. Check deploy-runner.log and confirm the service manually.'
      OUTPUT INSERTED.DeploymentID
      WHERE Status = 'running' AND StartedAt <= DATEADD(minute, -20, GETDATE())
    `);
    for (const row of stuck.recordset) {
      await notifyDeployFailed(pool, row.DeploymentID,
        'Stuck at running for over 20 minutes with no completion — check deploy-runner.log and confirm the service manually.');
    }
  } catch (err) {
    console.error('[cron] stuck-deployment safety net failed', err);
  }
});

// A failed scheduled deployment used to also show a banner to every
// logged-in user via GET /api/deploy/next — dropped in favour of this:
// superadmins (the only ones who can schedule/cancel a deployment or act on
// a failure anyway) get an in-app notification instead, everyone else just
// sees the service come back up as normal with no scary "maintenance
// failed" banner they have no ability to act on. Fire-and-forget, like
// every other notify() call in this codebase — a notification failure must
// never affect deployment bookkeeping.
async function notifyDeployFailed(pool, deploymentID, detail) {
  try {
    await notify(pool, {
      title:    `Scheduled Deployment #${deploymentID} Failed`,
      body:     detail,
      severity: 3,
      category: 'system',
      actionLabel: 'View Deployments',
      actionURL:   '/private/admin.html',
      target:   { type: 'role', value: 'superadmin' },
    });
  } catch (err) {
    console.error('[cron] failed to create deployment-failure notification', err.message);
  }
}

// ── Login page → landing page if already signed in ───────────────────────────
// GET / is normally served as a static file (public/index.html, the login
// form) below. If the browser already has a valid session — e.g. they hit
// back, bookmarked /, or opened a new tab while already logged in — skip
// the form and send them straight to the hub, same as a fresh login would.
app.get('/', (req, res, next) => {
  if (req.session?.user) {
    return res.redirect('/private/landing.html');
  }
  next();
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

// ── DB Explorer — SSMS-lite schema/data browser, superadmin only. Mounted
// ahead of the admin-minimum '/api/admin' catch-all below so it's matched
// first rather than relying on useradmin.js's router falling through (it
// would, since it has no matching routes, but this way is explicit). Own
// requireSuperadmin gate lives inside routes/dbexplorer.js.
app.use('/api/admin/dbexplorer', requireLogin, dbExplorerRoutes);

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
app.use('/api/material-groups', requireLogin,   materialGroupsRoutes);
app.use('/api/customsreport', requireLogin,     customsReportRoutes);
app.use('/api/customs-report-admin', requireLogin, customsReportAdminRoutes);
app.use('/api/forwarder-mode-mapping', requireLogin, forwarderModeMappingRoutes);
app.use('/api/incoterms', requireLogin,         incotermsRoutes);
app.use('/api/inboundcosts', requireLogin,      inboundCostsRoutes);
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
app.use('/api/profile', requireLogin,           profileRoutes);
app.use('/api/gemini', requireLogin,            geminiRoutes);
app.use('/api/freight-booking', requireLogin,   freightBookingRoutes);
app.use('/api/clearport',      requireLogin,   clearportExportRoutes);
app.use('/api/quality',       requireLogin,   qualityRoutes);
app.use('/api/labels',        requireLogin,   labelsRoutes);
app.use('/api/finance',       requireLogin,   financeRoutes);
app.use('/api/notifications', requireLogin,   notificationsRoutes);
app.use('/api/performance', requireLogin, performanceRoutes);
app.use('/api/staging', requireLogin, stagingRoutes);
app.use('/api/consignment', requireLogin, consignmentRoutes);
app.use('/api/production-schedule', requireLogin, productionScheduleRoutes);
app.use('/api/sales',               requireLogin, salesRoutes);
app.use('/api/packaging',           requireLogin, packagingRoutes);
app.use('/sql', requireLogin, sqlQueriesRoutes);
//app.use('/test-otif-insert', requireLogin, testOtifInsertRoutes);
app.use('/api/debug', debugRoutes);

// Serve static front-end files
app.use(express.static(path.join(process.cwd(), "public")));

// Serve protected pages
app.get('/private/:page', requireLogin, (req, res, next) => {
  const page = req.params.page;
  const dept = configJS.DEPT_PAGE_MAP[page];

  // Accounts created via the superadmin bulk-create tool (routes/useradmin.js's
  // POST /users/bulk-create) share a known initial password and carry
  // MustChangePassword = 1 until they change it (routes/profile.js's
  // POST /change-password clears it on both the row and the live session).
  // Force them onto landing.html — its blocking modal (private/js/landing.js)
  // is the only way off this restriction — rather than letting them reach
  // any other module while still on the shared password.
  if (req.session.user.mustChangePassword && page !== 'landing.html') {
    return res.redirect('/private/landing.html');
  }

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

  // landing.html and other pages — just requireLogin (already checked)
  res.sendFile(path.join(__dirname, 'private', page));
});

app.get('/private/js/:file', requireLogin, (req, res) => {
  const baseDir = path.resolve(__dirname, 'private', 'js');
  const filePath = path.resolve(baseDir, req.params.file);
  if (!filePath.startsWith(baseDir + path.sep)) {
    return res.status(403).send('Forbidden');
  }
  res.sendFile(filePath);
});

app.get('/private/css/:file', requireLogin, (req, res) => {
  const baseDir = path.resolve(__dirname, 'private', 'css');
  const filePath = path.resolve(baseDir, req.params.file);
  if (!filePath.startsWith(baseDir + path.sep)) {
    return res.status(403).send('Forbidden');
  }
  res.sendFile(filePath);
});

app.get('/private/images/:file', requireLogin, (req, res) => {
  const baseDir = path.resolve(__dirname, 'private', 'images');
  const filePath = path.resolve(baseDir, req.params.file);
  if (!filePath.startsWith(baseDir + path.sep)) {
    return res.status(403).send('Forbidden');
  }
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

