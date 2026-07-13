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


https.createServer(httpsOptions, app).listen(443, () => {
  console.log("✅ HTTPS server running on port 443");
});


http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
}).listen(80);


//app.listen(4000, "0.0.0.0", () => console.log("✅ SQL2005 Bridge accessible on network port 4000"));

