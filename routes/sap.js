import axios   from 'axios';
import https   from 'https';
import jwt     from 'jsonwebtoken';
import express from 'express';
import fs      from 'fs';
import sql     from 'mssql';
import { sapConfig, sapServerSecret, getNexusPool, getNexusOperationsPool } from '../config.js';
import { maybeReverseBatchManagedReturn } from '../lib/redrumReversal.js';
import { requirePermission } from '../middleware/auth.js';
import { assertTransfersAllowed, TransferBlockedError } from '../lib/stockCountGuard.js';

// Use a pinned certificate when connecting over HTTPS; fall back to no custom agent for HTTP (dev).
const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
export const sapAgent = fs.existsSync(certPath)
    ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
    : null;

// Sign a short-lived service token for each SapServer request.
// Payload matches what SapServer expects: userId (int), issuer, audience.
export function makeSapToken() {
    return jwt.sign(
        { userId: 0 },
        sapServerSecret,
        { issuer: 'normanton-nexus', audience: 'sap-server', expiresIn: '60s' }
    );
}


// ── Audit helper ──────────────────────────────────────────────────────────────
async function audit(eventType, actorUsername, detail, req) {
  try {
    const pool = await getNexusPool();
    const ip   = req.ip || req.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  actorUsername || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`
        INSERT INTO dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
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
      issuer:    'normanton-nexus',
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
        const pool = await getNexusOperationsPool();
        const grpRes = await pool.request().query(`
            SELECT ga.GlAccount
            FROM   acct.FinanceGlGroups g
            JOIN   acct.FinanceGlGroupAccounts ga ON ga.GroupID = g.GroupID
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
        const status = err.response?.status ?? 500;
        // A rejected MB1B/LT01 leg (deficit stock, etc.) comes back from
        // SapServer as a 422 with error: { code, message } — unwrap
        // .message so the operator sees SAP's real reason instead of
        // "[object Object]".
        const message = err.response?.data?.error?.message ?? err.response?.data?.error ?? err.message;
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
        await assertTransfersAllowed(params.StorageLocation);

        const response = await axios.post(
            `${sapConfig.url}/api/warehouse/transfer-order`,
            params,
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = response.data;
        if (!body.success)
            throw new Error(body.error ?? 'SapServer returned success=false');

        const rows = body.data;
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Transfer order succeeded for material ${params.Material || ''}`, rows?.transferOrderNumber ? `TR ${rows.transferOrderNumber}` : null), req);

        const redrum = await maybeReverseBatchManagedReturn({
            batch: params.Batch || null,
            destinationStorageType: params.DestinationType,
            destinationBin: params.DestinationBin,
            storageLocation: params.StorageLocation,
            audit, actorUsername: getActorUsername(req), req,
        });

        res.json({ success: true, data: rows, ...(redrum ? { redrum } : {}) });

    } catch (err) {
        if (err instanceof TransferBlockedError) {
            await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Transfer order blocked for material ${params.Material || ''}`, err.message), req);
            return res.status(409).json({ success: false, error: err.message });
        }
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Transfer order failed for material ${params.Material || ''}`, message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/sap/warehouse/transfer-order-bulk  (mounted at /api/sap in server.js)
//
// Same per-item logic as /warehouse/transfer-order and /warehouse/
// consignment-mb1b immediately above (guard check, SapServer call, audit,
// redrum reversal) — but takes a whole list of rows in ONE request and fires
// them at SapServer concurrently via Promise.all, instead of the caller
// awaiting one transfer order at a time. Used by Stock Management's Mass
// Transfer panel (wsmWireMassTransfer/wsmCreateTransferOrdersBulk), which
// used to send one row, wait ~15-60s for SAP, then send the next — SapServer
// logs showed every one of those calls landing on the same slot/thread with
// zero queue depth in between, i.e. never more than one in flight, even
// though the pool has 3 service STA worker threads that can each run a call
// independently. Deliberately NOT LOG_SUPER-gated, matching the two
// single-item routes above it: mass transfer is an ordinary Stock Management
// action available to any logged-in user, unlike the supervisor-only
// batch-cleanup-transfer(-bulk) pair below.
//
// Body: { items: [{ kind: 'transfer'|'consignment', payload }, ...] } — same
// per-item shape as batch-cleanup-transfer-bulk; payload is the flat body
// each single-item route above expects.
// Response: { success: true, results: [{ success, data|error, redrum? }, ...] }
// in the same order as the input items.
// ---------------------------------------------------------------------------

async function executeTransferItem({ kind, payload }, req) {
    if (kind !== 'transfer' && kind !== 'consignment') {
        return { success: false, error: "kind must be 'transfer' or 'consignment'" };
    }

    if (kind === 'consignment') {
        try {
            const response = await axios.post(`${sapConfig.url}/api/warehouse/consignment-mb1b`, payload, {
                timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` }
            });
            const body = response.data;
            if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
            await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Consignment MB1B succeeded for material ${payload?.Material || ''}`), req);
            return { success: true, data: body.data };
        } catch (err) {
            const status  = err.response?.status ?? 500;
            const message = err.response?.data?.error?.message ?? err.response?.data?.error ?? err.message;
            await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Consignment MB1B failed for material ${payload?.Material || ''}`, message), req);
            console.error('Error:', status, message);
            if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
            return { success: false, error: message };
        }
    }

    try {
        await assertTransfersAllowed(payload?.StorageLocation);

        const response = await axios.post(`${sapConfig.url}/api/warehouse/transfer-order`, payload, {
            timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` }
        });
        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        const rows = body.data;
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Transfer order succeeded for material ${payload?.Material || ''}`, rows?.transferOrderNumber ? `TR ${rows.transferOrderNumber}` : null), req);

        const redrum = await maybeReverseBatchManagedReturn({
            batch: payload.Batch || null,
            destinationStorageType: payload.DestinationType,
            destinationBin: payload.DestinationBin,
            storageLocation: payload.StorageLocation,
            audit, actorUsername: getActorUsername(req), req,
        });

        return { success: true, data: rows, ...(redrum ? { redrum } : {}) };
    } catch (err) {
        if (err instanceof TransferBlockedError) {
            await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Transfer order blocked for material ${payload?.Material || ''}`, err.message), req);
            return { success: false, error: err.message };
        }
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Transfer order failed for material ${payload?.Material || ''}`, message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        return { success: false, error: message };
    }
}

router.post('/warehouse/transfer-order-bulk', async (req, res) => {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'items must be a non-empty array' });
    }

    const results = await Promise.all(items.map(item => executeTransferItem(item, req)));
    res.json({ success: true, results });
});

// ---------------------------------------------------------------------------
// POST /api/sap/warehouse/batch-cleanup-transfer  (mounted at /api/sap in server.js)
//
// Gated wrapper around the same transfer-order / consignment-mb1b endpoints
// the normal Stock Management transfer panel already calls unauthenticated
// beyond requireLogin — used ONLY by the Stock Management "Batch
// Discrepancies" tool (zero-sum clean-up + multi-bin consolidation), which
// moves stock across many batches automatically rather than one row at a
// time a person explicitly picked. requirePermission('LOG_SUPER') keeps that
// bulk/automated path supervisor-only without touching the existing
// unrestricted /warehouse/transfer-order and /warehouse/consignment-mb1b
// proxies used by manual single/mass transfers elsewhere in Stock
// Management and the standalone Transfer Orders tile.
//
// Body: { kind: 'transfer' | 'consignment', payload: {...} } — payload shape
// matches CreateTransferOrderRequest or ConsignmentMb1bRequest respectively,
// same as the two proxies above.
// ---------------------------------------------------------------------------

// Shared by the single-item route below and the -bulk route that follows it.
// Never throws — every failure mode (validation, TransferBlockedError, SAP/
// network error) resolves to { success: false, error }, since the bulk route
// runs many of these concurrently via Promise.all and one item's rejection
// must not cancel the others still in flight.
// Returns { status, ...body } — status is the HTTP status the single-item
// route below responds with; the bulk route strips it back off since a
// per-item failure there is carried in the result's `success`/`error` fields
// rather than the (always-200) response's own status line.
async function executeBatchCleanupItem({ kind, payload }, req) {
    if (kind !== 'transfer' && kind !== 'consignment') {
        return { status: 400, success: false, error: "kind must be 'transfer' or 'consignment'" };
    }

    const sapPath = kind === 'consignment' ? '/api/warehouse/consignment-mb1b' : '/api/warehouse/transfer-order';

    try {
        if (kind === 'transfer') await assertTransfersAllowed(payload?.StorageLocation);

        const response = await axios.post(`${sapConfig.url}${sapPath}`, payload, {
            timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` }
        });

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        const trNumber = kind === 'transfer' ? body.data?.transferOrderNumber : null;
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Batch clean-up ${kind} succeeded for material ${payload?.Material || ''}, batch ${payload?.Batch || ''}`, trNumber ? `TR ${trNumber}` : null), req);

        const redrum = kind === 'transfer' ? await maybeReverseBatchManagedReturn({
            batch: payload.Batch || null,
            destinationStorageType: payload.DestinationType,
            destinationBin: payload.DestinationBin,
            storageLocation: payload.StorageLocation,
            audit, actorUsername: getActorUsername(req), req,
        }) : null;

        return { status: 200, success: true, data: body.data, ...(redrum ? { redrum } : {}) };

    } catch (err) {
        if (err instanceof TransferBlockedError) {
            await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Batch clean-up ${kind} blocked for material ${payload?.Material || ''}`, err.message), req);
            return { status: 409, success: false, error: err.message };
        }
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error?.message ?? err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Batch clean-up ${kind} failed for material ${payload?.Material || ''}, batch ${payload?.Batch || ''}`, message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        return { status, success: false, error: message };
    }
}

router.post('/warehouse/batch-cleanup-transfer', requirePermission('LOG_SUPER'), async (req, res) => {
    const { status, ...result } = await executeBatchCleanupItem(req.body, req);
    res.status(status).json(result);
});

// ---------------------------------------------------------------------------
// POST /api/sap/warehouse/batch-cleanup-transfer-bulk  (mounted at /api/sap in server.js)
//
// Same as /warehouse/batch-cleanup-transfer above, but takes the WHOLE set of
// moves for one clean-up plan in a single request and fires them at SapServer
// concurrently (Promise.all) instead of the caller awaiting them one at a
// time. SapServer's connection pool already load-balances concurrent RFC
// calls across its service STA worker threads (least-loaded routing, see
// SapServer's SapConnectionPool.SelectWorker) — sending items sequentially
// meant that pool never actually had more than one of this tool's requests
// in flight, so this is what lets it actually parallelise. There's no SAP-side
// "enough stock in the bin" check gating transfer creation, so there's no
// correctness reason to serialize these; each item still gets its own
// independent try/catch (via executeBatchCleanupItem) so one failure doesn't
// abort the rest.
//
// Body: { items: [{ kind, payload }, ...] } — same per-item shape as the
// single route above.
// Response: { success: true, results: [{ success, data|error, redrum? }, ...] }
// in the same order as the input items.
// ---------------------------------------------------------------------------
router.post('/warehouse/batch-cleanup-transfer-bulk', requirePermission('LOG_SUPER'), async (req, res) => {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'items must be a non-empty array' });
    }

    const results = await Promise.all(items.map(async item => {
        const { status, ...result } = await executeBatchCleanupItem(item, req);
        return result;
    }));
    res.json({ success: true, results });
});


// ---------------------------------------------------------------------------
// POST /api/sap/warehouse/stock-adjustment  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's POST /api/warehouse/stock-adjustment endpoint
// (BAPI_GOODSMVT_CREATE, movement types 711/712 for ordinary unrestricted
// stock, or 717/718 for stock category 'S'/blocked stock, since 711/712
// aren't valid postings against it) — the write-off/correction half of the
// Stock Investigations tool: once stock parked in the holding bin (999/TEMP)
// via Batch Discrepancies' "Move to Holding" has actually been investigated
// and understood, this posts the movement needed to zero it out rather than
// leaving it sitting there indefinitely. Gated the same way as
// /warehouse/batch-cleanup-transfer — a supervisor-only correction path, not
// a manual single-row move a person explicitly picked off a live count.
//
// Query: dryRun ('true' to echo the built RFC request without calling SAP,
// passed straight through to SapServer).
// Body matches SapServer's StockAdjustmentRequest: Material, StorageLocation,
// StorageType, StorageBin (stock sits inside warehouse management, so both
// the WM bin and the IM storage location are required), MovementType
// ('711'|'712'|'717'|'718'), Quantity, Unit, and optional Batch,
// StockCategory, SpecialStockIndicator, SpecialStockNumber, ValuationType,
// Reference, PostingDate, DocumentDate, TestRun, Plant.
// ---------------------------------------------------------------------------
router.post('/warehouse/stock-adjustment', requirePermission('LOG_SUPER'), async (req, res) => {
    const params = req.body;
    const dryRun = req.query.dryRun === 'true';

    try {
        const response = await axios.post(
            `${sapConfig.url}/api/warehouse/stock-adjustment${dryRun ? '?dryRun=true' : ''}`,
            params,
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Stock adjustment (${params.MovementType || ''}) succeeded for material ${params.Material || ''}`), req);
        res.json({ success: true, data: body.data });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Stock adjustment (${params.MovementType || ''}) failed for material ${params.Material || ''}`, message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/warehouse/delete-tr  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's POST /api/warehouse/delete-tr endpoint — replicates
// wm_open_tr.xlsm's ati_code.delete_tr (transaction LB02) for TRs that were
// processed manually outside the portal (e.g. via LT01) and are now orphaned,
// plus the bulk delete step of the TR Cleanup Assistant. requirePermission
// ('LOG_SUPER') gated, same as /warehouse/batch-cleanup-transfer and
// /warehouse/stock-adjustment above — deleting a TR in SAP is unrecoverable,
// unlike the routine unrestricted /warehouse/create-lt04 proxy.
//
// Body: { TrNumber } — matches SapServer's DeleteTrRequest.
// ---------------------------------------------------------------------------
router.post('/warehouse/delete-tr', requirePermission('LOG_SUPER'), async (req, res) => {
    const params = req.body;

    try {
        const response = await axios.post(
            `${sapConfig.url}/api/warehouse/delete-tr`,
            params,
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Delete TR ${params.TrNumber || ''} succeeded`), req);
        res.json({ success: true, data: body.data });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `Delete TR ${params.TrNumber || ''} failed`, message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// GET /api/sap/warehouse/stock  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's GET /api/warehouse/stock endpoint (LQUA via
// ZRFC_READ_TABLES — see WarehouseHelpers.BuildStockRequest, which returns
// every quant for warehouse 312 when no query filters are supplied). No
// filters are sent by default — the Stock Management screen in
// private/js/warehouse.js pulls the whole warehouse once and does all
// searching/filtering client-side, same "fetch once" approach
// routes/staging.js's fetchLquaStock already relies on for Staging Post
// (that one calls SapServer directly rather than through this proxy since
// it never needs to be reachable from the browser — this route exists
// because the Stock Management UI does).
// ---------------------------------------------------------------------------
router.get('/warehouse/stock', async (req, res) => {
    const { material, storageType, bin, batch, storageLocation, stockCategory, profitCentre } = req.query;

    try {
        const response = await axios.get(`${sapConfig.url}/api/warehouse/stock`, {
            params: { material, storageType, bin, batch, storageLocation, stockCategory, profitCentre, rowCount: 9999 },
            timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` }
        });

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, 'Warehouse stock query'), req);
        res.json({ success: true, data: body.data });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'Warehouse stock query failed', message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// GET /api/sap/warehouse/open-transfer-requirements  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's GET /api/warehouse/open-transfer-requirements
// endpoint — lists open Transfer Requirements (LTBK/LTBP, auto-created from
// a 131 goods movement) ready to be turned into a confirmed TO via LT04.
// Backs the Transfer Requirements (LT04) tile in Stock Management. Optional
// mrpController/material/storageLocation/createdBy query params narrow the
// list — mrpController matches the source Excel macro's operators' existing
// filter; the other three extend search beyond what the macro offered, since
// OpenTransferRequirementRow already carried that data without exposing it
// as a filter. Unrestricted to any logged-in user, same as /warehouse/stock
// and /warehouse/transfer-order above — this is routine operator use, not a
// supervisor-only correction path.
// ---------------------------------------------------------------------------
router.get('/warehouse/open-transfer-requirements', async (req, res) => {
    const { mrpController, material, storageLocation, createdBy } = req.query;

    try {
        const response = await axios.get(`${sapConfig.url}/api/warehouse/open-transfer-requirements`, {
            params: { mrpController, material, storageLocation, createdBy },
            timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` }
        });

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, 'Open transfer requirements query'), req);
        res.json({ success: true, data: body.data });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'Open transfer requirements query failed', message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// GET /api/sap/warehouse/bin-storage-types  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's GET /api/warehouse/bin-storage-types endpoint —
// looks up which storage type(s) a scanned/typed bin is registered under in
// LAGP, so the destination storage type never has to be typed by hand
// anywhere a bin is entered (LT04 scan flow + modal, Stock Management
// single/mass transfer forms, the Transfer Orders tile). Unrestricted to any
// logged-in user, same as the other read-only warehouse lookups.
//
// Deliberately NOT audited, unlike every other GET route in this file — this
// fires on blur/Enter from up to 7 different form fields across the app, far
// more often than a deliberate "query" action, and would flood
// PortalAuditLog with no investigative value. This is intentional, not an
// oversight.
// ---------------------------------------------------------------------------
router.get('/warehouse/bin-storage-types', async (req, res) => {
    const { bin } = req.query;

    try {
        const response = await axios.get(`${sapConfig.url}/api/warehouse/bin-storage-types`, {
            params: { bin },
            timeout: 15000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` }
        });

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        res.json({ success: true, data: body.data });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// GET /api/sap/warehouse/tr-cleanup-candidates  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's GET /api/warehouse/tr-cleanup-candidates endpoint —
// an automated version of the judgment call wm_open_tr.xlsm's operators have
// always made by eyeballing the macro's raw batch-stock/current-bin columns.
// Read-only, so unrestricted to any logged-in user same as
// open-transfer-requirements above; only the resulting bulk delete (via
// /warehouse/delete-tr below) is supervisor-gated.
// ---------------------------------------------------------------------------
router.get('/warehouse/tr-cleanup-candidates', async (req, res) => {
    try {
        const response = await axios.get(`${sapConfig.url}/api/warehouse/tr-cleanup-candidates`, {
            timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` }
        });

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, 'TR cleanup candidates query'), req);
        res.json({ success: true, data: body.data });

    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'TR cleanup candidates query failed', message), req);
        console.error('Error:', status, message);
        if (err.response?.data) console.error('Response body:', JSON.stringify(err.response.data, null, 2));
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/warehouse/create-lt04  (mounted at /api/sap in server.js)
//
// Proxies to SapServer's POST /api/warehouse/create-lt04 endpoint —
// replicates transaction LT04 (create + auto-confirm a TO from an open TR),
// including create_LT04's own quality-block pre-check (fails with a 422 if
// the batch hasn't been scanned out of firewall yet). Unrestricted to any
// logged-in user, same as /warehouse/transfer-order — this replaces the
// operator's routine manual LT04 entry, not a supervisor-only action.
//
// Body: { TrNumber, Material, Quantity, DestinationType, DestinationBin,
// PalletOrBatch, Reference?, StorageLocation? } — matches SapServer's
// CreateLt04Request, plus an optional StorageLocation used ONLY for the
// stock-count transfer guard below (stripped before forwarding to
// SapServer, whose CreateLt04Request has no such field) — the frontend
// already has it on hand from the open-TR row this action was launched
// from (GET /warehouse/open-transfer-requirements). Older/unaware callers
// that omit it simply skip the guard rather than failing closed.
// ---------------------------------------------------------------------------
router.post('/warehouse/create-lt04', async (req, res) => {
    const { StorageLocation, ...params } = req.body;

    try {
        await assertTransfersAllowed(StorageLocation);

        const response = await axios.post(
            `${sapConfig.url}/api/warehouse/create-lt04`,
            params,
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');

        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `LT04 succeeded for TR ${params.TrNumber || ''}`), req);
        res.json({ success: true, data: body.data });

    } catch (err) {
        if (err instanceof TransferBlockedError) {
            await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `LT04 blocked for TR ${params.TrNumber || ''}`, err.message), req);
            return res.status(409).json({ success: false, error: err.message });
        }
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, `LT04 failed for TR ${params.TrNumber || ''}`, message), req);
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
// POST /api/sap/vbrk
// Billing document header: invoice currency (WAERK) and invoice date (FKDAT)
// per invoice number.
// ---------------------------------------------------------------------------
router.post('/vbrk', async (req, res) => {
    const { invoices } = req.body;
    if (!Array.isArray(invoices) || !invoices.length)
        return res.status(400).json({ success: false, error: 'invoices array is required.' });
    try {
        const response = await axios.post(
            `${sapConfig.url}/api/customs/vbrk`,
            { invoices },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );
        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `VBRK query (${invoices.length} invoices)`), req);
        res.json({ success: true, data: body.data });
    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'VBRK query failed', message), req);
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/consignment-price
// Consignment-customer fallback pricing: customs sales price per
// consignee/material pair, from SAP's standard pricing-condition tables
// (A005/KONP), for delivery lines with no VBFA billing document (goods
// shipped without a commercial invoice).
// ---------------------------------------------------------------------------
router.post('/consignment-price', async (req, res) => {
    const { lines } = req.body;
    if (!Array.isArray(lines) || !lines.length)
        return res.status(400).json({ success: false, error: 'lines array is required.' });
    try {
        const response = await axios.post(
            `${sapConfig.url}/api/customs/consignment-price`,
            { lines },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );
        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Consignment price query (${lines.length} lines)`), req);
        res.json({ success: true, data: body.data });
    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'Consignment price query failed', message), req);
        res.status(status).json({ success: false, error: message });
    }
});


// ---------------------------------------------------------------------------
// POST /api/sap/picksheet-stock
// Warehouse picksheet stock lookup: LQUA + ZPRODBATCH batches for a given
// material list, including any delivery a batch is already tagged against
// (ZPRODBATCH~VBELN) — used by the pallet builder to show what's physically
// available for a picksheet's required materials.
// ---------------------------------------------------------------------------
router.post('/picksheet-stock', async (req, res) => {
    const { materials } = req.body;
    if (!Array.isArray(materials) || !materials.length)
        return res.status(400).json({ success: false, error: 'materials array is required.' });
    try {
        const response = await axios.post(
            `${sapConfig.url}/api/warehouse/picksheet-stock`,
            { materials },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );
        const body = response.data;
        if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
        await audit('SAP_OK', getActorUsername(req), buildAuditDetail(req, `Picksheet stock query (${materials.length} materials)`), req);
        res.json({ success: true, data: body.data });
    } catch (err) {
        const status  = err.response?.status  ?? 500;
        const message = err.response?.data?.error ?? err.message;
        await audit('SAP_ERROR', getActorUsername(req), buildAuditDetail(req, 'Picksheet stock query failed', message), req);
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
