import axios   from 'axios';
import https   from 'https';
import jwt     from 'jsonwebtoken';
import express from 'express';
import fs      from 'fs';
import sql     from 'mssql';
import { sapConfig, sapServerSecret, sqlConfig } from '../config.js';

// Use a pinned certificate when connecting over HTTPS; fall back to no custom agent for HTTP (dev).
const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
    ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
    : null;

// Sign a short-lived service token for each SapServer request.
// Payload matches what SapServer expects: userId (int), issuer, audience.
export function makeSapToken() {
    return jwt.sign(
        { userId: 0 },
        sapServerSecret,
        { issuer: 'sql2005-bridge', audience: 'sap-server', expiresIn: '60s' }
    );
}

// ── Audit helper ──────────────────────────────────────────────────────────────
async function audit(eventType, actorUsername, detail, req) {
  try {
    const pool = await sql.connect(sqlConfig);
    const ip   = req.ip || req.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  actorUsername || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`
        INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
        VALUES (@username, @eventType, @detail, @ip)
      `);
  } catch (err) {
    console.error('[admin audit]', err.message);
  }
}

function getActorUsername(req) {
  return req.session?.user?.username || null;
}

function buildAuditDetail(req, summary, extra = null) {
  const detail = [`${req.method} ${req.originalUrl}`, summary, extra].filter(Boolean).join(' | ');
  return detail.slice(0, 500);
}

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/sap/token  (mounted at /api/sap in server.js)
//
// Generic helper to verify the user's session and return a JWT for authenticating to SapServer.
// ---------------------------------------------------------------------------
router.post('/token', async (req, res) => {
  try {
    const payload = {
      userId:      req.session.user.userID,
      username:    req.session.user.username,
      role:        req.session.user.role,
      departments: req.session.user.departments,
    };
    const token = jwt.sign(payload, sapServerSecret, {
      expiresIn: '8h',
      issuer:    'sql2005-bridge',
      audience:  'sap-server',
    });
    await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, 'Issued SAP token'), req);
    res.json({ token });
  } catch (err) {
    await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'Failed to issue SAP token', err.message), req);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ---------------------------------------------------------------------------
// POST /api/sap/execute-rfc  (mounted at /api/sap in server.js)
//
// Generic wrapper around SapServer's /api/rfc/execute endpoint.
// Accepts the same JSON body that SapServer expects so callers don't need
// to know the internal SapServer URL or deal with COM/SAP directly.
//
// Body:
//   functionName      {string}   SAP RFC function name
//   importParameters  {object}   Scalar inputs  (SAP EXPORTING params)
//   inputTables       {object}   Table inputs using func.Tables(name)
//   inputTablesItems  {object}   Table inputs using func.Tables.Item(name)
//   exportParameters  {string[]} Scalar output param names to read back
//   outputTables      {object}   { tableName: [fieldName, ...] }
// ---------------------------------------------------------------------------
router.post("/execute-rfc", async (req, res) => {
    const {
        functionName,
        importParameters  = {},
        inputTables       = {},
        inputTablesItems  = {},
        exportParameters  = [],
        outputTables      = {}
    } = req.body;

    if (!functionName) {
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'RFC request rejected', 'Missing functionName'), req);
        return res.status(400).json({ success: false, error: "Missing functionName" });
    }

    //console.group(`[SAP] execute-rfc → ${functionName}`);
    //console.log('Import parameters:', importParameters);
    //if (Object.keys(inputTables).length)      console.log('Input tables:',       inputTables);
    //if (Object.keys(inputTablesItems).length) console.log('Input tables items:', inputTablesItems);
    //if (exportParameters.length)              console.log('Export parameters:',  exportParameters);
    //if (Object.keys(outputTables).length)     console.log('Output tables:',      outputTables);

    try {
        const response = await axios.post(
            `${sapConfig.url}/api/rfc/execute`,
            { functionName, importParameters, inputTables, inputTablesItems, exportParameters, outputTables },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        //console.log('HTTP status:', response.status);
        //console.log('Response:', JSON.stringify(response.data, null, 2));
        //console.groupEnd();
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `RFC ${functionName} succeeded`), req);
        res.json({ success: true, data: response.data });
    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error?.message ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `RFC ${functionName || 'unknown'} failed`, message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/sap/cost-sheet  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's /api/costing/cost-sheet endpoint.
// Body:
//   date      {string}   Costing date (YYYY-MM-DD or SAP format)
//   materials {string[]} Optional list of material numbers to filter
// ---------------------------------------------------------------------------
router.post("/cost-sheet", async (req, res) => {
    const { items, date } = req.body;

    if (!Array.isArray(items)) {
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'Cost sheet request rejected', 'Missing items'), req);
        return res.status(400).json({ success: false, error: "Missing items" });
    }

    try {
        const response = await axios.post(
            `${sapConfig.url}/api/costing/cost-sheet`,
            { items, date },
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = response.data;
        if (!body.success)
            throw new Error(body.error ?? 'SapServer returned success=false');

        const rows = body.data;
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Cost sheet succeeded (${items.length} items)`), req);
        res.json({ success: true, data: rows });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'Cost sheet failed', message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/costing/period-balance
// Proxies to SapServer's /api/costing/period-balance endpoint.
// Body: { FiscalYear, PeriodFrom, PeriodTo, GlAccounts }
// ---------------------------------------------------------------------------
router.post('/costing/period-balance', async (req, res) => {
    const { FiscalYear, PeriodFrom, PeriodTo, GlAccounts } = req.body;

    if (!FiscalYear || !PeriodFrom || !PeriodTo || !Array.isArray(GlAccounts) || !GlAccounts.length)
        return res.status(400).json({ success: false, error: 'FiscalYear, PeriodFrom, PeriodTo and GlAccounts[] are required.' });

    try {
        const response = await axios.post(
            `${sapConfig.url}/api/costing/period-balance`,
            { FiscalYear, PeriodFrom, PeriodTo, GlAccounts },
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        await audit('SAP_OK', getActorUsername(req),
            buildAuditDetail(req, `Period balance: ${GlAccounts.length} GL account(s), ${FiscalYear} P${PeriodFrom}–P${PeriodTo}`), req);
        res.json({ success: true, data: body.data });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'Period balance failed', message), req);
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/costing/profit-center
// Proxies to SapServer's /api/costing/profit-center endpoint.
// Body: { DateFrom, DateTo, GlAccounts }  (dates in DD.MM.YYYY SAP format)
// ---------------------------------------------------------------------------
router.post('/costing/profit-center', async (req, res) => {
    const { DateFrom, DateTo, GlAccounts } = req.body;

    if (!DateFrom || !DateTo || !Array.isArray(GlAccounts) || !GlAccounts.length)
        return res.status(400).json({ success: false, error: 'DateFrom, DateTo and GlAccounts[] are required.' });

    try {
        const response = await axios.post(
            `${sapConfig.url}/api/costing/profit-center`,
            { DateFrom, DateTo, GlAccounts },
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        await audit('SAP_OK', getActorUsername(req),
            buildAuditDetail(req, `Profit center: ${GlAccounts.length} GL account(s), ${DateFrom}–${DateTo}`), req);
        res.json({ success: true, data: body.data });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'Profit center query failed', message), req);
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// GET /api/sap/sales-sparkline
//
// Landing-page widget: finds the "Sales" GL group from the portal DB, queries
// the current and previous calendar month from the profit-center SAP endpoint,
// then returns per-day absolute values plus a period-to-date comparison.
//
// Results are cached in memory for 5 minutes so repeated page loads don't
// hammer SAP.
// ---------------------------------------------------------------------------
let _salesSparkCache   = null;
let _salesSparkCachedAt = 0;

router.get('/sales-sparkline', async (req, res) => {
    const CACHE_TTL = 5 * 60 * 1000;
    if (_salesSparkCache && Date.now() - _salesSparkCachedAt < CACHE_TTL)
        return res.json(_salesSparkCache);

    try {
        // 1. Resolve the "Sales" GL account group from the portal DB
        const pool = await sql.connect(sqlConfig);
        const grpRes = await pool.request().query(`
            SELECT ga.GlAccount
            FROM   dbo.FinanceGlGroups g
            JOIN   dbo.FinanceGlGroupAccounts ga ON ga.GroupID = g.GroupID
            WHERE  LOWER(g.GroupLabel) = N'sales'`);

        const glAccounts = [...new Set(grpRes.recordset.map(r => r.GlAccount))];
        if (!glAccounts.length) {
            _salesSparkCache   = { success: true, data: null };
            _salesSparkCachedAt = Date.now();
            return res.json(_salesSparkCache);
        }

        // 2. Build date range: 1st of previous month → today
        const now       = new Date();
        const pad       = n => String(n).padStart(2, '0');
        const today     = now.getDate();
        const thisMonth = now.getMonth() + 1;
        const thisYear  = now.getFullYear();

        const prevDate  = new Date(thisYear, thisMonth - 2, 1);
        const prevMonth = prevDate.getMonth() + 1;
        const prevYear  = prevDate.getFullYear();

        const DateFrom = `01.${pad(prevMonth)}.${prevYear}`;
        const DateTo   = `${pad(today)}.${pad(thisMonth)}.${thisYear}`;

        // 3. SAP call
        const sapRes = await axios.post(
            `${sapConfig.url}/api/costing/profit-center`,
            { DateFrom, DateTo, GlAccounts: glAccounts },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = sapRes.data;
        if (!body.success) throw new Error(body.error ?? 'SAP error');
        const rows = body.data || [];

        // 4. Parse SAP dates (DD.MM.YYYY) and partition rows
        const parseDate = s => {
            if (!s) return null;
            const p = s.split('.');
            return p.length === 3 ? new Date(+p[2], +p[1] - 1, +p[0]) : null;
        };

        const thisRows = rows.filter(r => {
            const d = parseDate(r.postingDate);
            return d && d.getMonth() + 1 === thisMonth && d.getFullYear() === thisYear;
        });
        const prevRows = rows.filter(r => {
            const d = parseDate(r.postingDate);
            return d && d.getMonth() + 1 === prevMonth && d.getFullYear() === prevYear
                && d.getDate() <= today;
        });

        // Match the finance Profit Center card: net companyCodeValue first, then
        // display sales as a positive magnitude for the landing widget.
        const sumNet = arr => arr.reduce((s, r) => s + (Number(r.companyCodeValue) || 0), 0);
        const thisTotal = Math.abs(sumNet(thisRows));
        const prevTotal = Math.abs(sumNet(prevRows));

        const pctChange = prevTotal === 0 ? null
            : Math.round(((thisTotal - prevTotal) / prevTotal) * 1000) / 10;

        // 5. Daily absolute values for sparkline (current month, days 1..today)
        const dailyMap = {};
        for (const r of thisRows) {
            const d = parseDate(r.postingDate);
            if (!d) continue;
            dailyMap[d.getDate()] = (dailyMap[d.getDate()] || 0)
                + (Number(r.companyCodeValue) || 0);
        }
        const dailyValues = Array.from({ length: today }, (_, i) => Math.abs(dailyMap[i + 1] || 0));

        _salesSparkCache   = { success: true, data: { thisTotal, prevTotal, pctChange, dailyValues } };
        _salesSparkCachedAt = Date.now();
        res.json(_salesSparkCache);

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/warehouse/consignment-mb1b  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's /api/warehouse/consignment-mb1b endpoint.
// ---------------------------------------------------------------------------
router.post("/warehouse/consignment-mb1b", async (req, res) => {
    const params = req.body;

    try {
        const response = await axios.post(
            `${sapConfig.url}/api/warehouse/consignment-mb1b`,
            params,
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = response.data;
        if (!body.success)
            throw new Error(body.error ?? 'SapServer returned success=false');

        const rows = body.data;
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Consignment MB1B succeeded for material ${params.Material || ''}`), req);
        res.json({ success: true, data: rows });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Consignment MB1B failed for material ${params.Material || ''}`, message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/warehouse/transfer-order  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's /api/warehouse/transfer-order endpoint.
// ---------------------------------------------------------------------------
router.post("/warehouse/transfer-order", async (req, res) => {
    const params = req.body;

    try {
        const response = await axios.post(
            `${sapConfig.url}/api/warehouse/transfer-order`,
            params,
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = response.data;
        if (!body.success)
            throw new Error(body.error ?? 'SapServer returned success=false');

        const rows = body.data;
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Transfer order succeeded for material ${params.Material || ''}`), req);
        res.json({ success: true, data: rows });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Transfer order failed for material ${params.Material || ''}`, message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/sap/lips
// Delivery line items: material number, item number, quantity per delivery.
// ---------------------------------------------------------------------------
router.post('/lips', async (req, res) => {
    const { deliveries } = req.body;
    if (!Array.isArray(deliveries) || !deliveries.length)
        return res.status(400).json({ success: false, error: 'deliveries array is required.' });
    try {
        const response = await axios.post(
            `${sapConfig.url}/api/customs/lips`,
            { deliveries },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );
        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `LIPS query (${deliveries.length} deliveries)`), req);
        res.json({ success: true, data: body.data });
    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'LIPS query failed', message), req);
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/likp
// Delivery header: incoterms and consignee (KUNNR) per delivery.
// ---------------------------------------------------------------------------
router.post('/likp', async (req, res) => {
    const { deliveries } = req.body;
    if (!Array.isArray(deliveries) || !deliveries.length)
        return res.status(400).json({ success: false, error: 'deliveries array is required.' });
    try {
        const response = await axios.post(
            `${sapConfig.url}/api/customs/likp`,
            { deliveries },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );
        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `LIKP query (${deliveries.length} deliveries)`), req);
        res.json({ success: true, data: body.data });
    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'LIKP query failed', message), req);
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/vbfa
// Document flow: invoice number, invoice item, and statistical value per
// delivery line item.
// ---------------------------------------------------------------------------
router.post('/vbfa', async (req, res) => {
    const { lines } = req.body;
    if (!Array.isArray(lines) || !lines.length)
        return res.status(400).json({ success: false, error: 'lines array is required.' });
    try {
        const response = await axios.post(
            `${sapConfig.url}/api/customs/vbfa`,
            { lines },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );
        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `VBFA query (${lines.length} lines)`), req);
        res.json({ success: true, data: body.data });
    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'VBFA query failed', message), req);
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/marc
// Material master: commodity (HS) code and country of origin per material.
// ---------------------------------------------------------------------------
router.post('/marc', async (req, res) => {
    const { materials } = req.body;
    if (!Array.isArray(materials) || !materials.length)
        return res.status(400).json({ success: false, error: 'materials array is required.' });
    try {
        const response = await axios.post(
            `${sapConfig.url}/api/customs/marc`,
            { materials },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );
        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `MARC query (${materials.length} materials)`), req);
        res.json({ success: true, data: body.data });
    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'MARC query failed', message), req);
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/kna1
// Customer master: destination country per consignee code.
// ---------------------------------------------------------------------------
router.post('/kna1', async (req, res) => {
    const { customers } = req.body;
    if (!Array.isArray(customers) || !customers.length)
        return res.status(400).json({ success: false, error: 'customers array is required.' });
    try {
        const response = await axios.post(
            `${sapConfig.url}/api/customs/kna1`,
            { customers },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );
        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `KNA1 query (${customers.length} customers)`), req);
        res.json({ success: true, data: body.data });
    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'KNA1 query failed', message), req);
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// GET /api/sap/availability
// Lightweight reachability check — any HTTP response means the server is up.
// ---------------------------------------------------------------------------
router.get('/availability', async (req, res) => {
  try {
    await axios.get(`${sapConfig.url}/health`, {
      timeout: 4000,
      httpsAgent: sapAgent,
      validateStatus: () => true,
    });
    res.json({ reachable: true });
  } catch {
    res.json({ reachable: false });
  }
});

export default router;
