import express from 'express';
import sql     from 'mssql';
import axios   from 'axios';
import https   from 'https';
import fs      from 'fs';
import jwt     from 'jsonwebtoken';
import { getNexusOperationsPool, getNexusPool, sapConfig, sapServerSecret } from '../config.js';
import { requireRole, requirePermission } from '../middleware/auth.js';
import { notify } from '../lib/notify.js';

// ── SAP caller ────────────────────────────────────────────────────────────────
const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
  ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
  : null;

function makeSapToken() {
  return jwt.sign(
    // TODO: include user info in token if needed for SAP logging; currently just a placeholder
    { userId: 0 },
    sapServerSecret,
    { issuer: 'normanton-nexus', audience: 'sap-server', expiresIn: '60s' }
  );
}

// ── Audit logger — records SAP call outcomes to PortalAuditLog (fire-and-forget) ─
async function audit(eventType, username, detail, req) {
  try {
    const pool = await getNexusPool();
    const ip   = req?.ip || req?.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  username || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail   || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`INSERT INTO dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
              VALUES (@username, @eventType, @detail, @ip)`);
  } catch (err) {
    console.error('[audit]', err.message);
  }
}

async function sapPost(path, body, timeout = 30000) {
  const response = await axios.post(
    `${sapConfig.url}${path}`,
    body,
    { timeout, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
  );
  return response.data;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const router = express.Router();

// ── Process configuration ─────────────────────────────────────────────────────
// Maps each ProcessCode to its table metadata. Used by generic endpoints.
const PROCESS = {
  MX:  { table: 'prod.Mixing',       pk: 'MixingID',       ref: 'MixRef',    uom: 'KG', qtyCol: 'TotalWeightKG' },
  EX:  { table: 'prod.Extrusion',    pk: 'ExtrusionID',    ref: 'ExtRef',    uom: 'M',  qtyCol: 'LengthMetres'  },
  CO:  { table: 'prod.Convoluting',  pk: 'ConvolutingID',  ref: 'ConvRef',   uom: 'M',  qtyCol: 'LengthMetres'  },
  BR:  { table: 'prod.Braiding',     pk: 'BraidingID',     ref: 'BraidRef',  uom: 'M',  qtyCol: 'LengthMetres'  },
  CL:  { table: 'prod.Coverline',    pk: 'CoverlineID',    ref: 'CovRef',    uom: 'M',  qtyCol: 'LengthMetres'  },
  TW:  { table: 'prod.TapeWrap',     pk: 'TapeWrapID',     ref: 'TWRef',     uom: 'M',  qtyCol: 'LengthMetres'  },
  DR:  { table: 'prod.Drumming',     pk: 'DrummingID',     ref: 'DrumRef',   uom: 'M',  qtyCol: 'LengthMetres'  },
  EW:  { table: 'prod.Ewald',        pk: 'EwaldID',        ref: 'EwaldRef',  uom: 'EA', qtyCol: 'TotalPiecesEA' },
  FW:  { table: 'prod.Firewall',     pk: 'FirewallID',     ref: 'FWRef',     uom: 'EA', qtyCol: 'TotalInspectedEA' },
  HA:  { table: 'prod.HoseAssembly', pk: 'HoseAssemblyID', ref: 'HARef',     uom: 'EA', qtyCol: 'QuantityEA'    },
};

function processConfig(code) {
  const cfg = PROCESS[code];
  if (!cfg) throw Object.assign(new Error(`Unknown process code: ${code}`), { statusCode: 400 });
  return cfg;
}

// Resolves each traceability parent link's own Material, for the Drumming
// backflush BOM-mismatch check (see submitDrumming). parentBatches only
// carries {processCode, recordID} — portal genealogy pointing at a prior
// production record (see assertParentBatchesReversed above) — not a SAP
// material, so the material each link actually points at has to be looked
// up per parent before it can be compared against the finished good's BOM;
// SapServer has no access to these tables to do this lookup itself. Skips
// any parent it can't resolve (unknown code, missing row) rather than
// failing the whole submission over it — a shorter resolved list just means
// less for the BOM check downstream to verify, not an error.
async function resolveTraceabilityMaterials(pool, parentBatches) {
  const materials = new Set();
  for (const pb of parentBatches || []) {
    if (!pb.processCode || !pb.recordID) continue;
    let cfg;
    try { cfg = processConfig(pb.processCode.toUpperCase()); } catch { continue; }
    const r = await pool.request().input('id', sql.Int, Number(pb.recordID))
      .query(`SELECT Material FROM ${cfg.table} WHERE ${cfg.pk} = @id`);
    const mat = r.recordset[0]?.Material;
    if (mat) materials.add(mat);
  }
  return [...materials];
}

// Braiding never posts its own SAP backflush — the braiding work centre's
// own raw-material BOM data is unreliable, so that step is deliberately
// skipped (see the BR special-case in the "complete open run" route
// below). That means a braided semi-finished material never actually
// lands in SAP stock, so when Drumming later consumes one as a
// traceability parent, there's nothing there for the drum's own
// BOM-driven backflush to automatically consume. This backflushes the
// braided component itself first, for exactly the quantity the DRUMMED
// product's own BOM calls for (the same ratio SAP's automatic backflush
// would use, from ZBOM_INFO/MENGE, if the stock existed) — effectively
// performing braiding's missing backflush on demand, scoped to only what
// this drum is consuming right now rather than the batch's full length,
// so several drums can each draw down their own share of one braid batch.
//
// No check yet for a braid batch being drawn down past what it actually
// produced — deliberately deferred (per the brief) until this basic
// version is proven out; prod.ProductionTrace.QuantityConsumed (see
// migrate_production_v10.sql) already carries what's needed to add that
// later: SUM(QuantityConsumed) WHERE ParentProcessCode='BR' AND
// ParentRecordID=<id>, compared against prod.Braiding.LengthMetres.
//
// Returns [] with no SAP calls at all when there are no BR parents — the
// common case, most drums don't consume a braided product. Throws on a
// real SAP posting failure, deliberately: a raw-material consumption
// failure here should fail the whole drum submission the same way the
// drum's own backflush failing does (see the catch block in
// submitDrumming), not pass silently and leave SAP stock wrong. A braid
// material simply not being a component of this drummed product's BOM is
// NOT treated as an error here — the existing BOM-vs-traceability
// mismatch check on the main drumming backflush already flags that
// combination to PROD_SUPERVISOR, so this just logs and moves on rather
// than raising a second, redundant warning.
async function backflushBraidedComponents(pool, uid, material, totalLength, parentBatches) {
  const braidParents = (parentBatches || []).filter(
    pb => pb.processCode && pb.recordID && pb.processCode.toUpperCase() === 'BR'
  );
  if (!braidParents.length) return [];

  const results = [];
  const bomCache = new Map(); // braid material -> BomRow | null, avoids a repeat SAP call when the same braid material appears via multiple parent links

  for (const pb of braidParents) {
    const braidingID = Number(pb.recordID);

    const braidRow = await pool.request()
      .input('id', sql.Int, braidingID)
      .query(`SELECT BraidRef, Material, IsReversed FROM prod.Braiding WHERE BraidingID = @id`);
    const braid = braidRow.recordset[0];
    if (!braid) continue; // unresolvable parent — nothing to backflush or log against

    if (braid.IsReversed) {
      await writeEvent(pool, 'BR', braidingID, 'NOTE',
        `Drum for ${material} traced to this braid batch after it was reversed — skipped, no braid backflush posted.`, 2, uid).catch(() => {});
      continue;
    }

    const braidMaterial = braid.Material;

    if (!bomCache.has(braidMaterial)) {
      try {
        const bomRaw = await sapGet('/api/production/bom', { Material: material, Component: braidMaterial });
        const rows = bomRaw?.data ?? bomRaw ?? [];
        bomCache.set(braidMaterial, (Array.isArray(rows) ? rows[0] : null) || null);
      } catch {
        bomCache.set(braidMaterial, null);
      }
    }
    const bomRow = bomCache.get(braidMaterial);

    if (!bomRow || !(Number(bomRow.componentQty) > 0)) {
      await writeEvent(pool, 'BR', braidingID, 'NOTE',
        `Drum for ${material} traces to this braid batch, but ${braidMaterial} isn't a BOM component of ${material} (or has a zero quantity) — no braid backflush posted.`, 1, uid).catch(() => {});
      continue;
    }

    const qty = Math.round(Number(bomRow.componentQty) * totalLength * 1000) / 1000;
    if (qty <= 0) continue;

    let sapRaw;
    try {
      sapRaw = await sapPost('/api/production/backflush', {
        Material:  braidMaterial,
        Quantity:  qty,
        Header:    braid.BraidRef,
        Packaging: '',
        Charge:    '',
        Customer:  '',
      });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
      throw new Error(`Braid consumption backflush failed for ${braidMaterial} (batch ${braid.BraidRef}, ${qty.toFixed(3)} M): ${msg}`);
    }

    let sapMatDoc;
    try {
      ({ documentNumber: sapMatDoc } = parseSapBackflush(sapRaw));
    } catch (err) {
      throw new Error(`Braid consumption backflush rejected for ${braidMaterial} (batch ${braid.BraidRef}, ${qty.toFixed(3)} M): ${err.message}`);
    }

    await pool.request()
      .input('pc',   sql.NVarChar(5),   'BR').input('rid', sql.Int, braidingID)
      .input('type', sql.NVarChar(20),  'BACKFLUSH')
      .input('qty',  sql.Decimal(12,3), qty)
      .input('doc',  sql.NVarChar(10),  sapMatDoc)
      .input('uid',  sql.Int,           uid)
      .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',@doc,1,@uid)`);

    await writeEvent(pool, 'BR', braidingID, 'SAP_POST',
      `Backflushed ${qty.toFixed(3)} M against ${braid.BraidRef} — consumed by a drum of ${material} (BOM ratio ${bomRow.componentQty} ${bomRow.componentUnit || 'M'} per unit). MatDoc: ${sapMatDoc}.`, 0, uid);

    results.push({ braidingID, braidRef: braid.BraidRef, material: braidMaterial, qty, documentNumber: sapMatDoc });
  }

  return results;
}

// Metre-based linear processes that share a common entry/data pattern
const METRE_PROCESSES = new Set(['EX','CO','BR','CL','TW']);

// ── Profit-centre validation ──────────────────────────────────────────────────
// Each process may only post materials belonging to its SAP profit centre(s).
// MARC-PRCTR is read live via SapServer GET /api/production/check-profit-centre.
// FW has no material of its own (inspects an Ewald batch) — no entry here, no check.
const PROFIT_CENTRES = {
  MX: ['2000'],
  EX: ['2001', '2021'],
  CO: ['2002', '2022'],
  BR: ['2003'],
  DR: ['2004'],
  TW: ['2005'],
  CL: ['2006'],
  EW: ['2007'],
  HA: ['2009'],
};

async function sapGet(path, body, timeout = 30000) {
  const response = await axios.request({
    method: 'get',
    url: `${sapConfig.url}${path}`,
    data: body,
    timeout,
    httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}`, 'Content-Type': 'application/json' },
  });
  return response.data;
}

// Throws 400 when the material's profit centre doesn't match the process, and
// 502 when SAP can't confirm it. Fails closed — posting a wrong material into
// SAP is exactly what this check exists to prevent, so no confirmation = no post.
async function assertProfitCentre(code, material) {
  const allowed = PROFIT_CENTRES[code];
  if (!allowed) return;

  let prctr;
  try {
    const raw = await sapGet('/api/production/check-profit-centre', { Material: material });
    if (raw?.success === false) throw new Error(raw.error?.message || 'SAP profit centre check failed');
    prctr = String(raw?.data ?? '').trim();
  } catch (err) {
    const d   = err.response?.data;
    const msg = (typeof d === 'string' ? d : null) || d?.error?.message || d?.error || d?.message || err.message;
    throw Object.assign(
      new Error(`Unable to verify profit centre for ${material}: ${msg}`),
      { statusCode: 502 });
  }

  const prctrShort = prctr.replace(/^0+/, ''); // MARC-PRCTR comes back zero-padded to 10 chars
  if (!allowed.includes(prctrShort))
    throw Object.assign(
      new Error(`Material ${material} belongs to profit centre ${prctrShort || '(none)'} — not valid for ${code} (expects ${allowed.join(' or ')}).`),
      { statusCode: 400 });
}

// ── Shared SQL fragments used by reporting endpoints ─────────────────────────

const RPT_COMPLETED = `
  SELECT N'MX' AS ProcessCode,N'KG' AS UOM,TotalWeightKG AS Quantity,ShiftID,CompletedAt,Material FROM prod.Mixing      WHERE Status=4 AND IsReversed=0
  UNION ALL SELECT N'EX',N'M',LengthMetres,ShiftID,CompletedAt,Material FROM prod.Extrusion   WHERE Status=4 AND IsReversed=0
  UNION ALL SELECT N'CO',N'M',LengthMetres,ShiftID,CompletedAt,Material FROM prod.Convoluting  WHERE Status=4 AND IsReversed=0
  UNION ALL SELECT N'BR',N'M',LengthMetres,ShiftID,CompletedAt,Material FROM prod.Braiding     WHERE Status=4 AND IsReversed=0
  UNION ALL SELECT N'CL',N'M',LengthMetres,ShiftID,CompletedAt,Material FROM prod.Coverline    WHERE Status=4 AND IsReversed=0
  UNION ALL SELECT N'TW',N'M',LengthMetres,ShiftID,CompletedAt,Material FROM prod.TapeWrap     WHERE Status=4 AND IsReversed=0
  UNION ALL SELECT N'DR',N'M',LengthMetres,ShiftID,CompletedAt,Material FROM prod.Drumming     WHERE Status=4 AND IsReversed=0`;

const RPT_ALL_STATUSES = `
  SELECT N'MX' AS ProcessCode,Status,IsReversed,ShiftID,CompletedAt FROM prod.Mixing
  UNION ALL SELECT N'EX',Status,IsReversed,ShiftID,CompletedAt FROM prod.Extrusion
  UNION ALL SELECT N'CO',Status,IsReversed,ShiftID,CompletedAt FROM prod.Convoluting
  UNION ALL SELECT N'BR',Status,IsReversed,ShiftID,CompletedAt FROM prod.Braiding
  UNION ALL SELECT N'CL',Status,IsReversed,ShiftID,CompletedAt FROM prod.Coverline
  UNION ALL SELECT N'TW',Status,IsReversed,ShiftID,CompletedAt FROM prod.TapeWrap
  UNION ALL SELECT N'DR',Status,IsReversed,ShiftID,CompletedAt FROM prod.Drumming`;

// Period grouping SQL expression — col must be a trusted, hardcoded column reference
function rptPeriod(col, groupBy) {
  if (groupBy === 'month') return `CAST(DATEPART(year,${col}) AS varchar(4)) + N'-' + RIGHT(N'0'+CAST(DATEPART(month,${col}) AS varchar(2)),2)`;
  if (groupBy === 'week')  return `CAST(DATEPART(year,${col}) AS varchar(4)) + N'-W' + RIGHT(N'0'+CAST(DATEPART(week,${col}) AS varchar(2)),2)`;
  return `CONVERT(varchar(10),${col},120)`;
}

// Attach common date/filter params to a request; returns filter metadata
function rptBind(req, pool) {
  const { dateFrom, dateTo, processCode, shiftID, groupBy = 'day', material } = req.query;
  const from   = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30*86400000);
  // Date-only strings (e.g. "2026-05-11") parse as UTC midnight — extend to end-of-day
  // so records posted at any time on the selected day are included.
  const to     = dateTo   ? new Date(dateTo + 'T23:59:59') : new Date();
  const safeBy = ['day','week','month'].includes(groupBy) ? groupBy : 'day';
  const r      = pool.request().input('from', sql.DateTime, from).input('to', sql.DateTime, to);
  const extras = [];
  if (processCode) { r.input('pc',    sql.NVarChar(5),  processCode.toUpperCase()); extras.push(`ProcessCode=@pc`); }
  if (shiftID)     { r.input('shift', sql.TinyInt,      Number(shiftID));            extras.push(`ShiftID=@shift`); }
  if (material)    { r.input('mat',   sql.NVarChar(18), `%${material}%`);            extras.push(`Material LIKE @mat`); }
  return { from, to, groupBy: safeBy, r, extra: extras.length ? `AND ${extras.join(' AND ')}` : '' };
}

// ── Landing page sparkline — auth only, no supervisor gate ───────────────────

router.get('/landing-sparkline', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request().query(`
      SELECT CONVERT(varchar(10), CompletedAt, 120) AS Day,
             CAST(SUM(Quantity) AS DECIMAL(14,1)) AS TotalMetres
      FROM   (${RPT_COMPLETED}) AS B
      WHERE  UOM = N'M'
        AND  CompletedAt >= DATEADD(DAY,-13, DATEADD(DAY, DATEDIFF(DAY,0,GETDATE()), 0))
        AND  CompletedAt <  DATEADD(DAY,  1, DATEADD(DAY, DATEDIFF(DAY,0,GETDATE()), 0))
      GROUP BY CONVERT(varchar(10), CompletedAt, 120)
      ORDER BY Day`);

    const today = new Date();
    const days  = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (13 - i));
      return d.toISOString().slice(0, 10);
    });
    const map    = Object.fromEntries(r.recordset.map(row => [row.Day, Number(row.TotalMetres)]));
    const values = days.map(d => map[d] || 0);

    const lastWeek = values.slice(0, 7).reduce((s, n) => s + n, 0);
    const thisWeek = values.slice(7).reduce((s, n) => s + n, 0);
    const pctChange = lastWeek === 0 ? null
      : Math.round(((thisWeek - lastWeek) / lastWeek) * 1000) / 10;

    res.json({ success: true, data: {
      days: days.slice(7), values: values.slice(7),
      thisWeek: Math.round(thisWeek), lastWeek: Math.round(lastWeek), pctChange,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Report 1 — Production Output ─────────────────────────────────────────────

router.get('/reports/output', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const { from, to, groupBy, r, extra } = rptBind(req, pool);
    const period = rptPeriod('CompletedAt', groupBy);

    const [summary, ts] = await Promise.all([
      pool.request().input('from',sql.DateTime,from).input('to',sql.DateTime,to)
        .query(`SELECT ProcessCode,UOM,COUNT(*) AS BatchCount,
                       CAST(SUM(Quantity) AS DECIMAL(14,3)) AS TotalOutput,
                       CAST(SUM(Quantity)/COUNT(*) AS DECIMAL(14,3)) AS AvgPerBatch
                FROM (${RPT_COMPLETED}) AS B
                WHERE CompletedAt BETWEEN @from AND @to
                GROUP BY ProcessCode,UOM ORDER BY ProcessCode`),
      r.query(`SELECT ProcessCode,UOM,${period} AS Period,
                      COUNT(*) AS BatchCount,
                      CAST(SUM(Quantity) AS DECIMAL(14,3)) AS TotalOutput
               FROM (${RPT_COMPLETED}) AS B
               WHERE CompletedAt BETWEEN @from AND @to ${extra}
               GROUP BY ProcessCode,UOM,${period} ORDER BY Period,ProcessCode`),
    ]);
    res.json({ success: true, data: { summary: summary.recordset, timeSeries: ts.recordset } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Report 2 — Scrap Analysis ─────────────────────────────────────────────────

router.get('/reports/scrap', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const { from, to, groupBy, r, extra } = rptBind(req, pool);
    const period = rptPeriod('se.EnteredAt', groupBy);

    const mkScrapReq = () => pool.request().input('from',sql.DateTime,from).input('to',sql.DateTime,to);
    const [byReason, byProcess, ts] = await Promise.all([
      mkScrapReq().query(`SELECT sr.ReasonCode,sr.ReasonDescription,
                                 SUM(se.Quantity) AS TotalKG,COUNT(*) AS EntryCount
                          FROM prod.ScrapEntries se
                          JOIN prod.ScrapReasons sr ON sr.ReasonID=se.ReasonID
                          WHERE se.EnteredAt BETWEEN @from AND @to
                          GROUP BY sr.ReasonCode,sr.ReasonDescription ORDER BY TotalKG DESC`),
      mkScrapReq().query(`SELECT se.ProcessCode,SUM(se.Quantity) AS TotalKG,COUNT(*) AS EntryCount
                          FROM prod.ScrapEntries se
                          WHERE se.EnteredAt BETWEEN @from AND @to
                          GROUP BY se.ProcessCode ORDER BY TotalKG DESC`),
      r.query(`SELECT ${period} AS Period,
                      CAST(SUM(se.Quantity) AS DECIMAL(14,3)) AS TotalKG,COUNT(*) AS EntryCount
               FROM prod.ScrapEntries se
               WHERE se.EnteredAt BETWEEN @from AND @to
               GROUP BY ${period} ORDER BY Period`),
    ]);

    const totalKG  = byReason.recordset.reduce((s,r) => s + Number(r.TotalKG||0), 0);
    const topReason = byReason.recordset[0]?.ReasonDescription || '—';

    res.json({ success: true, data: {
      totals:    { TotalKG: totalKG.toFixed(3), EntryCount: byReason.recordset.reduce((s,r)=>s+r.EntryCount,0), TopReason: topReason },
      byReason:  byReason.recordset,
      byProcess: byProcess.recordset,
      timeSeries: ts.recordset,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Report 3 — SAP Backflush Performance ─────────────────────────────────────

router.get('/reports/sap-performance', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const { from, to, groupBy, r } = rptBind(req, pool);
    const period = rptPeriod('sp.PostedAt', groupBy);

    const mkSapReq = () => pool.request().input('from',sql.DateTime,from).input('to',sql.DateTime,to);
    const [byProcess, ts, alerts] = await Promise.all([
      mkSapReq().query(`SELECT ProcessCode,
                          COUNT(*) AS Total,
                          SUM(CASE WHEN IsSuccess=1 AND IsReversed=0 THEN 1 ELSE 0 END) AS Success,
                          SUM(CASE WHEN IsSuccess=0                  THEN 1 ELSE 0 END) AS Failed,
                          SUM(CASE WHEN IsSuccess=1 AND IsReversed=1 THEN 1 ELSE 0 END) AS Reversed
                        FROM prod.SAPPostings sp
                        WHERE PostingType=N'BACKFLUSH' AND PostedAt BETWEEN @from AND @to
                        GROUP BY ProcessCode ORDER BY ProcessCode`),
      r.query(`SELECT ${period} AS Period,
                      SUM(CASE WHEN IsSuccess=1 THEN 1 ELSE 0 END) AS Success,
                      SUM(CASE WHEN IsSuccess=0 THEN 1 ELSE 0 END) AS Failed
               FROM prod.SAPPostings sp
               WHERE PostingType=N'BACKFLUSH' AND sp.PostedAt BETWEEN @from AND @to
               GROUP BY ${period} ORDER BY Period`),
      mkSapReq().query(`SELECT ProcessCode,COUNT(*) AS AlertCount FROM prod.BackflushAlerts
                        WHERE CreatedAt BETWEEN @from AND @to GROUP BY ProcessCode`),
    ]);
    res.json({ success: true, data: { byProcess: byProcess.recordset, timeSeries: ts.recordset, alerts: alerts.recordset } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Report 4 — Batch Status Summary ──────────────────────────────────────────

router.get('/reports/batches', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const { from, to, r, extra } = rptBind(req, pool);
    const rows = await r.query(`
      SELECT ProcessCode,
        SUM(CASE WHEN IsReversed=1               THEN 1 ELSE 0 END) AS Reversed,
        SUM(CASE WHEN Status=4 AND IsReversed=0  THEN 1 ELSE 0 END) AS Complete,
        SUM(CASE WHEN Status=6                   THEN 1 ELSE 0 END) AS SAPFailed,
        SUM(CASE WHEN Status=5                   THEN 1 ELSE 0 END) AS Cancelled,
        COUNT(*) AS Total
      FROM (${RPT_ALL_STATUSES}) AS B
      WHERE CompletedAt BETWEEN @from AND @to ${extra}
      GROUP BY ProcessCode ORDER BY ProcessCode`);
    res.json({ success: true, data: rows.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Report 5 — Shift Performance ─────────────────────────────────────────────

router.get('/reports/shift-comparison', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const { from, to, r, extra } = rptBind(req, pool);
    const rows = await r.query(`
      SELECT s.ShiftName, B.ProcessCode, B.UOM,
             COUNT(*)        AS BatchCount,
             CAST(SUM(B.Quantity) AS DECIMAL(14,3)) AS TotalOutput
      FROM (${RPT_COMPLETED}) AS B
      JOIN prod.Shifts s ON s.ShiftID = B.ShiftID
      WHERE B.CompletedAt BETWEEN @from AND @to ${extra}
      GROUP BY s.ShiftName, B.ProcessCode, B.UOM
      ORDER BY s.ShiftName, B.ProcessCode`);
    const scrap = await pool.request()
      .input('from2',sql.DateTime,from).input('to2',sql.DateTime,to)
      .query(`SELECT se.ProcessCode,
                     CAST(SUM(se.Quantity) AS DECIMAL(14,3)) AS ScrapKG, COUNT(*) AS EntryCount
              FROM prod.ScrapEntries se
              WHERE se.EnteredAt BETWEEN @from2 AND @to2
              GROUP BY se.ProcessCode ORDER BY se.ProcessCode`);
    res.json({ success: true, data: { output: rows.recordset, scrapByProcess: scrap.recordset } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Report 6 — Operator Output ────────────────────────────────────────────────

router.get('/reports/operator-output', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const { from, to, r, extra } = rptBind(req, pool);
    const rows = await r.query(`
      SELECT pu.Username, bo.ProcessCode, AB.UOM,
             COUNT(DISTINCT bo.ProcessRecordID) AS BatchCount,
             CAST(SUM(AB.Quantity) AS DECIMAL(14,3)) AS TotalOutput
      FROM prod.BatchOperators bo
      JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = bo.UserID
      JOIN (
        SELECT N'MX' AS ProcessCode,MixingID    AS RecordID,TotalWeightKG AS Quantity,N'KG' AS UOM,CompletedAt FROM prod.Mixing      WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'EX',ExtrusionID,  LengthMetres,N'M',CompletedAt FROM prod.Extrusion   WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'CO',ConvolutingID,LengthMetres,N'M',CompletedAt FROM prod.Convoluting  WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'BR',BraidingID,   LengthMetres,N'M',CompletedAt FROM prod.Braiding     WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'CL',CoverlineID,  LengthMetres,N'M',CompletedAt FROM prod.Coverline    WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'TW',TapeWrapID,   LengthMetres,N'M',CompletedAt FROM prod.TapeWrap     WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'DR',DrummingID,   LengthMetres,N'M',CompletedAt FROM prod.Drumming     WHERE Status=4 AND IsReversed=0
      ) AS AB ON AB.ProcessCode=bo.ProcessCode AND AB.RecordID=bo.ProcessRecordID
      WHERE bo.IsPrimary=1 AND AB.CompletedAt BETWEEN @from AND @to ${extra}
      GROUP BY pu.Username, bo.ProcessCode, AB.UOM
      ORDER BY TotalOutput DESC`);
    res.json({ success: true, data: rows.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Report 7 — Material Throughput ───────────────────────────────────────────

router.get('/reports/material-output', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const { from, to, r, extra } = rptBind(req, pool);
    const rows = await r.query(`
      SELECT Material, ProcessCode, UOM,
             COUNT(*) AS BatchCount,
             CAST(SUM(Quantity) AS DECIMAL(14,3)) AS TotalOutput,
             CAST(SUM(Quantity)/COUNT(*) AS DECIMAL(14,3)) AS AvgPerBatch
      FROM (${RPT_COMPLETED}) AS B
      WHERE CompletedAt BETWEEN @from AND @to ${extra}
      GROUP BY Material, ProcessCode, UOM
      ORDER BY TotalOutput DESC`);
    res.json({ success: true, data: rows.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Generic entry — EX / CO / BR / CL / TW ───────────────────────────────────

router.post('/process/:processCode/entry', async (req, res) => {
  const code = req.params.processCode.toUpperCase();
  if (!METRE_PROCESSES.has(code))
    return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });

  const {
    material, lengthMetres, machineID, shiftID,
    parentBatches        = [],
    additionalOperatorIDs = [],
    hasScrap, scrapTotalKG, scrapReasons = [],
    notes,
  } = req.body;

  if (!material || !lengthMetres)
    return res.status(400).json({ success: false, error: 'material and lengthMetres are required.' });

  try { await assertProfitCentre(code, material); }
  catch (err) { return res.status(err.statusCode || 502).json({ success: false, error: err.message }); }

  const pool   = await getNexusOperationsPool();
  const uid    = userId(req);
  const cfg    = PROCESS[code];
  const sid    = shiftID || currentShiftID();
  const length = Number(lengthMetres);

  const ins = await pool.request()
    .input('shift', sql.TinyInt,           sid)
    .input('mach',  sql.Int,               machineID ? Number(machineID) : null)
    .input('mat',   sql.NVarChar(18),      material)
    .input('len',   sql.Decimal(12,3),     length)
    .input('uid',   sql.Int,               uid)
    .input('notes', sql.NVarChar(sql.MAX), notes || null)
    .query(`INSERT INTO ${cfg.table}
              (ShiftID,MachineID,Material,LengthMetres,Status,CompletedAt,CreatedByUserID,Notes)
            OUTPUT INSERTED.${cfg.pk}
            VALUES (@shift,@mach,@mat,@len,4,GETDATE(),@uid,@notes)`);

  const recordID = ins.recordset[0][cfg.pk];
  const batchRef = `${code}${String(recordID).padStart(8,'0')}`;

  await pool.request()
    .input('pc',  sql.NVarChar(5), code)
    .input('rid', sql.Int,         recordID)
    .input('uid', sql.Int,         uid)
    .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES (@pc,@rid,@uid,1,@uid)`);

  for (const addUid of additionalOperatorIDs) {
    await pool.request()
      .input('pc',  sql.NVarChar(5), code)
      .input('rid', sql.Int,         recordID)
      .input('uid', sql.Int,         Number(addUid))
      .input('by',  sql.Int,         uid)
      .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES (@pc,@rid,@uid,0,@by)`);
  }

  for (const pb of parentBatches) {
    if (!pb.processCode || !pb.recordID) continue;
    await pool.request()
      .input('cc',  sql.NVarChar(5), code)
      .input('cr',  sql.Int,         recordID)
      .input('pc',  sql.NVarChar(5), pb.processCode.toUpperCase())
      .input('pr',  sql.Int,         Number(pb.recordID))
      .input('uid', sql.Int,         uid)
      .query(`INSERT INTO prod.ProductionTrace (ChildProcessCode,ChildRecordID,ParentProcessCode,ParentRecordID,LinkedByUserID) VALUES (@cc,@cr,@pc,@pr,@uid)`);
  }

  if (hasScrap && scrapReasons.length) {
    if (code === 'EX') {
      for (const { reasonID, kg } of scrapReasons) {
        const qty   = Math.round(Number(kg || 0) * 1000) / 1000;
        if (!reasonID || qty <= 0) continue;

        await pool.request()
          .input('pc',  sql.NVarChar(5),   code)
          .input('rid', sql.Int,           recordID)
          .input('r',   sql.Int,           Number(reasonID))
          .input('qty', sql.Decimal(12,3), qty)
          .input('uid', sql.Int,           uid)
          .query(`INSERT INTO prod.ScrapEntries (ProcessCode,ProcessRecordID,ReasonID,Quantity,UnitOfMeasure,EnteredByUserID) VALUES (@pc,@rid,@r,@qty,'KG',@uid)`);
      }
      const totalKG = scrapReasons.reduce((s, r) => s + Number(r.kg || 0), 0);
      await writeEvent(pool, code, recordID, 'SCRAP', `Scrap recorded: ${scrapTotalKG} KG across ${scrapReasons.length} reason(s)`, 1, uid);
    } 
    else {
      const totalOcc = scrapReasons.reduce((s, r) => s + Number(r.occurrences || 0), 0);
      for (const { reasonID, occurrences } of scrapReasons) {
        const share = totalOcc > 0 ? Number(occurrences) / totalOcc : 1;
        const qty   = Math.round(Number(scrapTotalKG) * share * 1000) / 1000;

        await pool.request()
          .input('pc',  sql.NVarChar(5),   code)
          .input('rid', sql.Int,           recordID)
          .input('r',   sql.Int,           Number(reasonID))
          .input('qty', sql.Decimal(12,3), qty)
          .input('uid', sql.Int,           uid)
          .query(`INSERT INTO prod.ScrapEntries (ProcessCode,ProcessRecordID,ReasonID,Quantity,UnitOfMeasure,EnteredByUserID) VALUES (@pc,@rid,@r,@qty,'KG',@uid)`);
      }
      await writeEvent(pool, code, recordID, 'SCRAP', `Scrap recorded: ${scrapTotalKG} KG across ${scrapReasons.length} reason(s)`, 1, uid);
    }
  }

  await writeEvent(pool, code, recordID, 'STARTED', `${code} record created: ${material} ${length.toFixed(3)} M`, 0, uid);

  try {
    const sapRaw = await sapPost('/api/production/backflush', {
      Material:  material,
      Quantity:  length,
      Header:    batchRef,
      Packaging: '',
      Charge:    '',
      Customer:  '',
    });

    const { documentNumber: sapMatDoc, messageNumber, message } = parseSapBackflush(sapRaw);
    audit('SAP_OK', req.session?.user?.username, `'${batchRef}' BACKFLUSHED - Material Document = '${sapMatDoc}'`, req);

    if (messageNumber === '190') {
      await logBackflushAlert(pool, code, recordID, batchRef, sapMatDoc, messageNumber, message);
      await writeEvent(pool, code, recordID, 'NOTE', `SAP 190: No component consumption — MatDoc: ${sapMatDoc}. Flagged for data review.`, 1, uid);
    }

    await pool.request()
      .input('pc',   sql.NVarChar(5),   code)
      .input('rid',  sql.Int,           recordID)
      .input('type', sql.NVarChar(20),  'BACKFLUSH')
      .input('qty',  sql.Decimal(12,3), length)
      .input('doc',  sql.NVarChar(10),  sapMatDoc)
      .input('uid',  sql.Int,           uid)
      .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',@doc,1,@uid)`);

    await writeEvent(pool, code, recordID, 'SAP_POST', `Backflush posted — MatDoc: ${sapMatDoc}${messageNumber==='190'?' (190: no components consumed)':''}`, 0, uid);

    res.status(201).json({
      success: true,
      data: {
        recordID, batchRef, materialDocument: sapMatDoc, status: 'COMPLETE',
        ...(messageNumber === '190' ? { warning: 'SAP 190: posted but no components consumed — flagged for data review.' } : {}),
      },
    });

  } catch (sapErr) {
    await pool.request()
      .input('rid', sql.Int, recordID)
      .query(`UPDATE ${cfg.table} SET Status=6 WHERE ${cfg.pk}=@rid`);

    const errMsg = sapErr.response?.data?.error?.message || sapErr.response?.data?.error || sapErr.message;
    audit('SAP_ERROR', req.session?.user?.username, `'${batchRef}' FAILED - Message = "${errMsg}"`, req);

    await pool.request()
      .input('pc',   sql.NVarChar(5),      code)
      .input('rid',  sql.Int,              recordID)
      .input('type', sql.NVarChar(20),     'BACKFLUSH')
      .input('qty',  sql.Decimal(12,3),    length)
      .input('err',  sql.NVarChar(sql.MAX), errMsg)
      .input('uid',  sql.Int,              uid)
      .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,IsSuccess,ErrorMessage,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',0,@err,@uid)`);

    await writeEvent(pool, code, recordID, 'SAP_FAIL', `SAP backflush failed: ${errMsg}`, 2, uid);

    getNexusPool().then(kPool => notify(kPool, {
      title:       'SAP Backflush Failed',
      body:        `${batchRef} (${code}) failed to post to SAP: ${errMsg}`,
      severity:    2,
      category:    'production',
      actionLabel: 'Open Queue',
      actionURL:   '/private/production-nexus.html',
      target:      { type: 'permission', value: 'PROD_SUPERVISOR' },
    })).catch(() => {});

    res.status(201).json({
      success: true,
      data: { recordID, batchRef, status: 'SAP_FAILED', error: errMsg },
      warning: 'Record saved but SAP backflush failed. See failed backflush queue.',
    });
  }
});

// ── Create open (draft) entry — EX / CO / BR / CL / TW ──────────────────────

router.post('/process/:processCode/draft', async (req, res) => {
  try {
    const code = req.params.processCode.toUpperCase();
    if (!METRE_PROCESSES.has(code))
      return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });

    const { material, machineID, parentBatches = [], rawMaterialBatches = [], notes } = req.body;
    if (!material)
      return res.status(400).json({ success: false, error: 'material is required.' });

    // Reject wrong-profit-centre materials at setup, not just at completion —
    // otherwise the operator creates an open run they can never complete.
    await assertProfitCentre(code, material); // throws 400/502 — caught below

    const pool = await getNexusOperationsPool();
    const uid  = userId(req);
    const cfg  = PROCESS[code];
    const sid  = currentShiftID();

    const ins = await pool.request()
      .input('shift', sql.TinyInt,           sid)
      .input('mach',  sql.Int,               machineID ? Number(machineID) : null)
      .input('mat',   sql.NVarChar(18),      material)
      .input('uid',   sql.Int,               uid)
      .input('notes', sql.NVarChar(sql.MAX), notes || null)
      .query(`INSERT INTO ${cfg.table} (ShiftID,MachineID,Material,LengthMetres,Status,CreatedByUserID,Notes)
              OUTPUT INSERTED.${cfg.pk}
              VALUES (@shift,@mach,@mat,0,1,@uid,@notes)`);

    const recordID = ins.recordset[0][cfg.pk];
    const batchRef = `${code}${String(recordID).padStart(8, '0')}`;

    await pool.request()
      .input('pc',  sql.NVarChar(5), code)
      .input('rid', sql.Int,         recordID)
      .input('uid', sql.Int,         uid)
      .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES (@pc,@rid,@uid,1,@uid)`);

    for (const pb of parentBatches) {
      if (!pb.processCode || !pb.recordID) continue;
      const isMxTub = pb.processCode.toUpperCase() === 'MX' && pb.tubID;
      await pool.request()
        .input('cc',   sql.NVarChar(5), code)
        .input('cr',   sql.Int,         recordID)
        .input('pc',   sql.NVarChar(5), pb.processCode.toUpperCase())
        .input('pr',   sql.Int,         Number(pb.recordID))
        .input('ptub', sql.Int,         isMxTub ? Number(pb.tubID) : null)
        .input('uid',  sql.Int,         uid)
        .query(`INSERT INTO prod.ProductionTrace (ChildProcessCode,ChildRecordID,ParentProcessCode,ParentRecordID,ParentTubID,LinkedByUserID) VALUES (@cc,@cr,@pc,@pr,@ptub,@uid)`);
    }

    if (BOM_VALIDATED_PROCESSES.has(code))
      await persistRawMaterialBatches(pool, code, recordID, uid, rawMaterialBatches);

    await writeEvent(pool, code, recordID, 'STARTED', `${code} open entry created: ${material}`, 0, uid);

    // Informational only at draft time (clarification #2) — a mix not yet
    // staged doesn't block creating the open run, it just warns the
    // operator now rather than only discovering it at completion.
    let warnings = [];
    if (code === 'EX') {
      const problems = await validateMxTubLinks(pool, material, parentBatches).catch(() => []);
      warnings = problems.map(p => p.reason);
    } else if (BOM_VALIDATED_PROCESSES.has(code)) {
      // Download and save the BOM into the job the moment its material is
      // known, then warn (non-blocking, matching the EX/MX precedent above)
      // on any traceability link whose own material isn't a component of it
      // — see validateTraceabilityAgainstBom — and on any raw-material BOM
      // component still missing its hand-written batch number — see
      // validateRawMaterialBatches. Hard-blocked later at completion time,
      // not here (see /process/:processCode/complete).
      try {
        const bomRows = await fetchBom(material);
        await persistBomSnapshot(pool, code, recordID, material, bomRows);
        const [linkProblems, rawProblems] = await Promise.all([
          validateTraceabilityAgainstBom(pool, parentBatches, bomRows),
          validateRawMaterialBatches(pool, code, recordID, bomRows),
        ]);
        warnings = [...linkProblems, ...rawProblems].map(p => p.reason);
      } catch (err) {
        warnings = [`Unable to download BOM for ${material} — SAP BOM lookup failed (${err.message}). Traceability cannot be verified yet.`];
      }
    }

    res.status(201).json({ success: true, data: { recordID, batchRef }, ...(warnings.length ? { warnings } : {}) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ── Open runs across all processes (supervisor view + cancel) ─────────────────
// A run stuck at Status=1 (e.g. created before profit-centre validation with a
// material that can never pass completion) is cancelled here — Status=5.

const OPEN_RUN_PROCESSES = ['MX','EX','CO','BR','CL','TW','DR','EW','HA'];
const HAS_ISREVERSED     = new Set(['MX','EX','CO','BR','CL','TW','DR']);

router.get('/open-runs', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool  = await getNexusOperationsPool();
    const union = OPEN_RUN_PROCESSES.map(code => {
      const cfg = PROCESS[code];
      const rev = HAS_ISREVERSED.has(code) ? 'AND t.IsReversed = 0' : '';
      return `SELECT N'${code}' AS ProcessCode, t.${cfg.pk} AS RecordID, t.${cfg.ref} AS BatchRef,
                     t.Material, t.CreatedAt, pu.Username AS CreatedBy
              FROM ${cfg.table} t
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = t.CreatedByUserID
              WHERE t.Status = 1 ${rev}`;
    }).join('\nUNION ALL\n');

    const result = await pool.request().query(`${union}\nORDER BY CreatedAt DESC`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/open-runs/:processCode/:recordId/cancel', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const code = req.params.processCode.toUpperCase();
  const id   = Number(req.params.recordId);

  try {
    const cfg  = processConfig(code);
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    const upd = await pool.request()
      .input('id', sql.Int, id)
      .query(`UPDATE ${cfg.table} SET Status=5 WHERE ${cfg.pk}=@id AND Status=1`);

    if (!upd.rowsAffected[0])
      return res.status(409).json({ success: false, error: 'Record is not open — it may already be completed or cancelled.' });

    const reason = String(req.body?.reason || '').trim();
    await writeEvent(pool, code, id, 'CANCELLED',
      `Open run cancelled by supervisor${reason ? ` — ${reason}` : ''}`, 0, uid);

    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ── List open entries — EX / CO / BR / CL / TW ───────────────────────────────

router.get('/process/:processCode/open-entries', async (req, res) => {
  try {
    const code = req.params.processCode.toUpperCase();
    if (!METRE_PROCESSES.has(code))
      return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });

    const cfg  = PROCESS[code];
    const pool = await getNexusOperationsPool();

    const result = await pool.request()
      .query(`SELECT t.${cfg.pk} AS RecordID, t.${cfg.ref} AS BatchRef,
                     t.Material, t.MachineID, m.MachineCode, m.MachineName,
                     t.Notes, t.CreatedAt,
                     pu.Username AS CreatedBy
              FROM ${cfg.table} t
              LEFT JOIN prod.Machines m ON m.MachineID = t.MachineID
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = t.CreatedByUserID
              WHERE t.Status = 1 AND t.IsReversed = 0
              ORDER BY t.CreatedAt DESC`);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Complete an open entry — EX / CO / BR / CL / TW ──────────────────────────

router.post('/process/:processCode/complete/:recordID', async (req, res) => {
  try {
    const code     = req.params.processCode.toUpperCase();
    const recordID = Number(req.params.recordID);
    if (!METRE_PROCESSES.has(code))
      return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });

    const {
      lengthMetres, shiftID,
      additionalOperatorIDs = [],
      hasScrap, scrapTotalKG, scrapReasons = [],
      notes,
    } = req.body;

    if (!lengthMetres || Number(lengthMetres) <= 0)
      return res.status(400).json({ success: false, error: 'lengthMetres is required.' });

    const pool   = await getNexusOperationsPool();
    const uid    = userId(req);
    const cfg    = PROCESS[code];
    const sid    = shiftID || currentShiftID();
    const length = Number(lengthMetres);

    const check = await pool.request()
      .input('rid', sql.Int, recordID)
      .query(`SELECT ${cfg.pk}, Material, Status FROM ${cfg.table} WHERE ${cfg.pk}=@rid`);

    if (!check.recordset.length)
      return res.status(404).json({ success: false, error: 'Record not found.' });
    if (check.recordset[0].Status !== 1)
      return res.status(409).json({ success: false, error: 'Record is not open — it may already be complete or cancelled.' });

    const material = check.recordset[0].Material;
    const batchRef = `${code}${String(recordID).padStart(8, '0')}`;

    // Batch may predate the profit-centre rule — validate again before posting
    try { await assertProfitCentre(code, material); }
    catch (err) { return res.status(err.statusCode || 502).json({ success: false, error: err.message }); }

    await pool.request()
      .input('rid',   sql.Int,               recordID)
      .input('len',   sql.Decimal(12, 3),    length)
      .input('shift', sql.TinyInt,           sid)
      .input('notes', sql.NVarChar(sql.MAX), notes || null)
      .query(`UPDATE ${cfg.table} SET LengthMetres=@len, ShiftID=@shift, Status=4, CompletedAt=GETDATE(), Notes=COALESCE(@notes, Notes) WHERE ${cfg.pk}=@rid`);

    for (const addUid of additionalOperatorIDs) {
      try {
        await pool.request()
          .input('pc',  sql.NVarChar(5), code)
          .input('rid', sql.Int,         recordID)
          .input('uid', sql.Int,         Number(addUid))
          .input('by',  sql.Int,         uid)
          .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES (@pc,@rid,@uid,0,@by)`);
      } catch { /* ignore duplicate operator */ }
    }

    if (hasScrap && scrapReasons.length) {
      if (code === 'EX') {
        for (const { reasonID, kg } of scrapReasons) {
          const qty   = Math.round(Number(kg) * 1000) / 1000;
          await pool.request()
            .input('pc',  sql.NVarChar(5),   code)
            .input('rid', sql.Int,           recordID)
            .input('r',   sql.Int,           Number(reasonID))
            .input('qty', sql.Decimal(12,3), qty)
            .input('uid', sql.Int,           uid)
            .query(`INSERT INTO prod.ScrapEntries (ProcessCode,ProcessRecordID,ReasonID,Quantity,UnitOfMeasure,EnteredByUserID) VALUES (@pc,@rid,@r,@qty,'KG',@uid)`);
        }
        await writeEvent(pool, code, recordID, 'SCRAP', `Scrap recorded: ${scrapTotalKG} KG across ${scrapReasons.length} reason(s)`, 1, uid);
      } else {
        const totalOcc = scrapReasons.reduce((s, r) => s + Number(r.occurrences || 0), 0);
        for (const { reasonID, occurrences } of scrapReasons) {
          const share = totalOcc > 0 ? Number(occurrences) / totalOcc : 1;
          const qty   = Math.round(Number(scrapTotalKG) * share * 1000) / 1000;
          await pool.request()
            .input('pc',  sql.NVarChar(5),   code)
            .input('rid', sql.Int,           recordID)
            .input('r',   sql.Int,           Number(reasonID))
            .input('qty', sql.Decimal(12,3), qty)
            .input('uid', sql.Int,           uid)
            .query(`INSERT INTO prod.ScrapEntries (ProcessCode,ProcessRecordID,ReasonID,Quantity,UnitOfMeasure,EnteredByUserID) VALUES (@pc,@rid,@r,@qty,'KG',@uid)`);
        }
        await writeEvent(pool, code, recordID, 'SCRAP', `Scrap recorded: ${scrapTotalKG} KG across ${scrapReasons.length} reason(s)`, 1, uid);
      }
    }

    await writeEvent(pool, code, recordID, 'STARTED', `${code} completed: ${material} ${length.toFixed(3)} M`, 0, uid);

    // BOM-vs-traceability hard block — CO/BR/CL/TW (not EX, which has its
    // own separate MX-tub-staging-aware check below). Re-reads the actual
    // linked parents fresh from prod.ProductionTrace (don't trust anything
    // computed at draft time — a link may have been added/removed since)
    // and the job's persisted BOM snapshot (its latest batch — see
    // "Refresh BOM"), so a since-corrected BOM is picked up here too. An
    // APPROVED concession clears its own specific mismatch; anything still
    // unresolved blocks completion outright — applies to BR too even though
    // it never posts its own backflush (see the early return just below):
    // BR still consumes real raw material, and a wrong-material link there
    // is exactly as much a traceability problem as on any other process.
    //
    // bomRows/jobConcessions are hoisted here (not just block-scoped) so the
    // backflush section below can reuse them to decide whether this job's
    // SAP post needs to go via the explicit goods-movement path instead of
    // the normal automatic backflush.
    let bomRows = [];
    let jobConcessions = [];
    if (BOM_VALIDATED_PROCESSES.has(code)) {
      const traceRows = await pool.request()
        .input('cc', sql.NVarChar(5), code).input('cr', sql.Int, recordID)
        .query(`SELECT ParentProcessCode AS processCode, ParentRecordID AS recordID
                FROM prod.ProductionTrace WHERE ChildProcessCode=@cc AND ChildRecordID=@cr`);

      bomRows = await latestBomSnapshot(pool, code, recordID);
      const problems = await validateTraceabilityAgainstBom(pool, traceRows.recordset, bomRows);
      const blocking = await unresolvedProblems(pool, code, recordID, problems);

      // Raw-material BOM components (profit centre RAW_MATERIAL_PROFIT_CENTRE)
      // have no portal record to concede against — a missing hand-written
      // batch number always blocks, never bypassable via a concession.
      const rawProblems = await validateRawMaterialBatches(pool, code, recordID, bomRows);

      if (blocking.length || rawProblems.length) {
        const errMsg = `Blocked: ${[...blocking, ...rawProblems].map(p => p.reason).join(' ')}${blocking.length ? ' Raise a concession from the traceability screen, or use "Refresh BOM" if SAP\'s BOM has since been corrected.' : ''}`;
        return await markSapFailed(res, req, pool, code, cfg, recordID, batchRef, length, errMsg, uid);
      }

      if (problems.length) jobConcessions = await approvedConcessions(pool, code, recordID);
    }

    if (code === 'BR') {
      return res.status(200).json({ success: true, data: { recordID, batchRef, status: 'COMPLETE' } });
    }

    // Billet-staging gate — EX only (mix material only flows into Extrusion
    // in the real value stream). Populate reporting data regardless of
    // outcome, then re-check fresh (don't trust anything computed at draft
    // time — the linked tub's status may have changed since). A problem
    // here skips the SAP call entirely, landing this exactly where a real
    // SAP failure would (Status=6, failed-backflush queue) — the EX
    // record/ExtRef/label already exist from draft time either way.
    if (code === 'EX') {
      const traceMxParents = await pool.request()
        .input('cc', sql.NVarChar(5), code).input('cr', sql.Int, recordID)
        .query(`SELECT ParentRecordID AS recordID, ParentTubID AS tubID
                FROM prod.ProductionTrace
                WHERE ChildProcessCode=@cc AND ChildRecordID=@cr AND ParentProcessCode=N'MX'`);
      const mxParentBatches = traceMxParents.recordset.map(r => ({ processCode: 'MX', recordID: r.recordID, tubID: r.tubID }));

      if (mxParentBatches.length) {
        await apportionMxExpectedConsumption(pool, code, recordID, material, length).catch(() => {});

        const problems = await validateMxTubLinks(pool, material, mxParentBatches);
        if (problems.length) {
          const errMsg = `Blocked: ${problems.map(p => p.reason).join(' ')}`;
          return await markSapFailed(res, req, pool, code, cfg, recordID, batchRef, length, errMsg, uid);
        }
      }
    }

    try {
      // Concession-covered jobs bypass the normal automatic BOM-driven
      // backflush entirely and post every component explicitly instead
      // (correct ones included) — see buildActualComponentList. Avoids the
      // automatic backflush also silently consuming the original wrong BOM
      // material on top of the explicit posting.
      if (jobConcessions.length) {
        const components = buildActualComponentList(bomRows, jobConcessions, length);
        const gmRaw = await sapPost('/api/production/goods-movement-backflush', {
          Material:   material,
          Header:     batchRef,
          Components: components,
        });
        const { documentNumber: sapMatDoc } = parseGoodsMovement(gmRaw);
        audit('SAP_OK', req.session?.user?.username, `'${batchRef}' BACKFLUSHED (concession, goods movement) - Material Document = '${sapMatDoc}'`, req);

        await pool.request()
          .input('pc',   sql.NVarChar(5),   code)
          .input('rid',  sql.Int,           recordID)
          .input('type', sql.NVarChar(20),  'BACKFLUSH')
          .input('qty',  sql.Decimal(12,3), length)
          .input('doc',  sql.NVarChar(10),  sapMatDoc)
          .input('uid',  sql.Int,           uid)
          .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',@doc,1,@uid)`);

        await writeEvent(pool, code, recordID, 'SAP_POST',
          `Backflush posted via concession goods movement — MatDoc: ${sapMatDoc}. Components: ${components.map(c => `${c.Material} x${c.Quantity}`).join(', ')}.`, 0, uid);

        for (const c of jobConcessions) {
          await pool.request()
            .input('id', sql.Int, c.ConcessionID).input('doc', sql.NVarChar(10), sapMatDoc)
            .query(`UPDATE prod.TraceabilityConcessions SET AppliedAt=GETDATE(), MaterialDocumentSAP=@doc WHERE ConcessionID=@id`);
        }

        return res.status(200).json({
          success: true,
          data: { recordID, batchRef, materialDocument: sapMatDoc, status: 'COMPLETE', concessionApplied: true },
        });
      }

      const sapRaw = await sapPost('/api/production/backflush', {
        Material:  material,
        Quantity:  length,
        Header:    batchRef,
        Packaging: '',
        Charge:    '',
        Customer:  '',
      });

      const { documentNumber: sapMatDoc, messageNumber, message } = parseSapBackflush(sapRaw);
      audit('SAP_OK', req.session?.user?.username, `'${batchRef}' BACKFLUSHED - Material Document = '${sapMatDoc}'`, req);

      if (messageNumber === '190') {
        await logBackflushAlert(pool, code, recordID, batchRef, sapMatDoc, messageNumber, message);
        await writeEvent(pool, code, recordID, 'NOTE', `SAP 190: No component consumption — MatDoc: ${sapMatDoc}. Flagged for data review.`, 1, uid);
      }

      await pool.request()
        .input('pc',   sql.NVarChar(5),   code)
        .input('rid',  sql.Int,           recordID)
        .input('type', sql.NVarChar(20),  'BACKFLUSH')
        .input('qty',  sql.Decimal(12,3), length)
        .input('doc',  sql.NVarChar(10),  sapMatDoc)
        .input('uid',  sql.Int,           uid)
        .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',@doc,1,@uid)`);

      await writeEvent(pool, code, recordID, 'SAP_POST', `Backflush posted — MatDoc: ${sapMatDoc}${messageNumber==='190'?' (190: no components consumed)':''}`, 0, uid);

      res.status(200).json({
        success: true,
        data: {
          recordID, batchRef, materialDocument: sapMatDoc, status: 'COMPLETE',
          ...(messageNumber === '190' ? { warning: 'SAP 190: posted but no components consumed — flagged for data review.' } : {}),
        },
      });

    } catch (sapErr) {
      const errMsg = sapErr.response?.data?.error?.message || sapErr.response?.data?.error || sapErr.message;
      await markSapFailed(res, req, pool, code, cfg, recordID, batchRef, length, errMsg, uid);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Generic data view — EX / CO / BR / CL / TW ───────────────────────────────

router.get('/process/:processCode/data', async (req, res) => {
  const code = req.params.processCode.toUpperCase();
  if (!METRE_PROCESSES.has(code))
    return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });

  const { material, dateFrom, dateTo } = req.query;
  const cfg = PROCESS[code];

  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('mat',  sql.NVarChar(18), material ? `%${material}%` : null)
      .input('from', sql.DateTime,     dateFrom  ? new Date(dateFrom) : null)
      .input('to',   sql.DateTime,     dateTo    ? new Date(dateTo)   : null)
      .query(`SELECT t.${cfg.pk}  AS RecordID,
                     t.${cfg.ref} AS BatchRef,
                     t.ShiftID, s.ShiftName,
                     t.MachineID, m.MachineCode, m.MachineName,
                     t.Material, t.LengthMetres,
                     t.Status, t.IsReversed, sc.StatusName,
                     t.StartedAt, t.CompletedAt, t.Notes,
                     pu.Username AS CreatedBy
              FROM   ${cfg.table} t
              LEFT JOIN prod.Shifts              s  ON s.ShiftID   = t.ShiftID
              LEFT JOIN prod.Machines            m  ON m.MachineID = t.MachineID
              LEFT JOIN prod.StatusCodes         sc ON sc.StatusID = t.Status
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID  = t.CreatedByUserID
              WHERE  (@mat  IS NULL OR t.Material   LIKE @mat)
                AND  (@from IS NULL OR t.StartedAt >= @from)
                AND  (@to   IS NULL OR t.StartedAt <= @to)
              ORDER BY t.StartedAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Safeguard for re-drum traceability — a Drumming (DR) parent referenced as
// traceability must already be marked reversed (see lib/redrumReversal.js,
// which sets IsReversed automatically once the original drum's backflush has
// actually been reversed in SAP) before a new drum can be logged against it.
// Blocks the whole submission rather than letting a partial record through.
async function assertParentBatchesReversed(pool, parentBatches) {
  const drParents = (parentBatches || [])
    .filter(pb => pb.processCode && String(pb.processCode).toUpperCase() === 'DR' && pb.recordID);

  for (const pb of drParents) {
    const r = await pool.request()
      .input('id', sql.Int, Number(pb.recordID))
      .query(`SELECT IsReversed FROM prod.Drumming WHERE DrummingID = @id`);

    if (!r.recordset.length || !r.recordset[0].IsReversed) {
      const err = new Error(
        `This drum cannot be processed, as the original drum (DR${String(pb.recordID).padStart(8, '0')}) ` +
        `has not been correctly reversed yet. Please seek advice from a supervisor.`
      );
      err.statusCode = 409;
      throw err;
    }
  }
}

// ── Billet staging: MX tub parent-link validation + BOM apportionment ───────
// Extrusion is the only downstream process that consumes mixed material
// directly (see PROFIT_CENTRES and BR's own comment on not consuming
// mixed rubber directly) — these two helpers are only ever invoked for EX.
//
// Mix materials are confirmed NOT batch-managed in SAP — there is no SAP
// batch/charge for a mix at all. Staging and tub-level traceability here
// are a Normanton-Nexus-only concept; nothing below has, or needs, a SAP
// counterpart to keep in sync.

// Checks every MX parentBatches entry (each must carry a tubID — the
// caller is responsible for having collected that from the tub picker,
// not just a bare MixingID) against two independent conditions: (1) the
// tub is actually staged into Billet, not scrapped, and belongs to the
// stated mix; (2) the tub's own Material is really a component of the
// extruded material's real SAP BOM — a wrong-mix pick is just as much a
// problem as an unstaged one. Returns a problems[] array (empty = all
// good); never throws — callers decide whether a non-empty result is a
// soft warning (draft time) or a hard block (complete/retry time).
async function validateMxTubLinks(pool, extrudedMaterial, parentBatches) {
  const mxParents = (parentBatches || [])
    .filter(pb => pb.processCode && String(pb.processCode).toUpperCase() === 'MX' && pb.recordID);
  if (!mxParents.length) return [];

  // One BOM lookup covers every MX parent on this record — no per-tub SAP round trips.
  let bomRows;
  try {
    const bomRaw = await sapGet('/api/production/bom', { Material: extrudedMaterial });
    bomRows = bomRaw?.data ?? bomRaw ?? [];
  } catch {
    // BOM lookup itself failing is a SAP-availability problem, not a
    // traceability problem — surface it as its own single entry rather
    // than treating every linked tub as "wrong material".
    return [{ reason: `Unable to verify BOM for ${extrudedMaterial} — SAP BOM lookup failed.` }];
  }
  const bomMaterials = new Set(bomRows.map(r => r.component));

  // Resolves a mix's printed reference (e.g. "MX00000005") for messages
  // where no valid tub row was found to read it off below — an operator
  // reading the failed-backflush log has no way to make sense of a raw
  // MixingID/TubID without knowing the SQL schema, so every message here
  // must use MixRef + the tub's own sequence number (the same "Tub N"
  // labelling already printed on the physical ticket/tub picker), never
  // the internal primary keys.
  async function mixRefFor(mixingID) {
    const r = await pool.request().input('id', sql.Int, mixingID).query(`SELECT MixRef FROM prod.Mixing WHERE MixingID = @id`);
    return r.recordset[0]?.MixRef || `MX${String(mixingID).padStart(8, '0')}`;
  }

  const problems = [];
  for (const pb of mxParents) {
    if (!pb.tubID) {
      problems.push({ ...pb, reason: `No specific tub selected for ${await mixRefFor(Number(pb.recordID))} — pick a tub via the tub picker.` });
      continue;
    }
    const r = await pool.request().input('id', sql.Int, Number(pb.tubID))
      .query(`SELECT t.MixingID, t.TubSeq, t.IsStaged, t.IsScrapped, m.Material, m.MixRef
              FROM prod.MixingTubs t JOIN prod.Mixing m ON m.MixingID = t.MixingID
              WHERE t.TubID = @id`);
    const t = r.recordset[0];
    if (!t || t.MixingID !== Number(pb.recordID)) {
      problems.push({ ...pb, reason: `Tub not found, or does not belong to ${await mixRefFor(Number(pb.recordID))}.` });
      continue;
    }

    const label = `${t.MixRef} tub ${t.TubSeq}`;
    if (t.IsScrapped) {
      problems.push({ ...pb, reason: `${label} has been scrapped.` });
      continue;
    }
    if (!t.IsStaged) {
      problems.push({ ...pb, reason: `${label} has not been staged into Billet yet.` });
      continue;
    }
    if (!bomMaterials.has(t.Material)) {
      problems.push({ ...pb, reason: `${label}'s material (${t.Material}) is not a component of ${extrudedMaterial}'s SAP BOM.` });
    }
  }
  return problems;
}

// Populates ProductionTrace.ExpectedConsumptionKG for every MX-tub parent
// link on an Extrusion record, using the same BOM-ratio-times-quantity
// formula backflushBraidedComponents already uses elsewhere in this file.
// When multiple linked tubs share the same component material, that
// material's BOM-derived total is split EQUALLY across them — the operator
// picked several tubs of the same mix; there's no other signal in the data
// to weight them by. Purely a reporting/reconciliation figure (see the
// plan's clarification #5) — it never gates or decrements anything.
// Safe to call even when validateMxTubLinks found problems — a rejected
// entry should still get accurate expected-consumption data recorded.
async function apportionMxExpectedConsumption(pool, code, recordID, extrudedMaterial, lengthMetres) {
  const traceRows = await pool.request()
    .input('cc', sql.NVarChar(5), code).input('cr', sql.Int, recordID)
    .query(`SELECT tr.TraceID, t.Material
            FROM prod.ProductionTrace tr
            JOIN prod.MixingTubs t ON t.TubID = tr.ParentTubID
            WHERE tr.ChildProcessCode = @cc AND tr.ChildRecordID = @cr
              AND tr.ParentProcessCode = N'MX' AND tr.ParentTubID IS NOT NULL`);
  if (!traceRows.recordset.length) return;

  let bomRows;
  try {
    const bomRaw = await sapGet('/api/production/bom', { Material: extrudedMaterial });
    bomRows = bomRaw?.data ?? bomRaw ?? [];
  } catch { return; } // BOM unavailable — leave ExpectedConsumptionKG unset rather than guess

  const bomByMaterial = new Map(bomRows.map(r => [r.component, Number(r.componentQty || 0)]));

  const traceIDsByMaterial = new Map();
  for (const row of traceRows.recordset) {
    if (!traceIDsByMaterial.has(row.Material)) traceIDsByMaterial.set(row.Material, []);
    traceIDsByMaterial.get(row.Material).push(row.TraceID);
  }

  for (const [material, traceIDs] of traceIDsByMaterial) {
    const ratio = bomByMaterial.get(material);
    if (!(ratio > 0)) continue; // not a real BOM component — validateMxTubLinks already flags this
    const totalExpectedKG = Math.round(ratio * Number(lengthMetres) * 1000) / 1000;
    const share = Math.round((totalExpectedKG / traceIDs.length) * 1000) / 1000;
    for (const traceID of traceIDs) {
      await pool.request().input('id', sql.Int, traceID).input('kg', sql.Decimal(12, 3), share)
        .query(`UPDATE prod.ProductionTrace SET ExpectedConsumptionKG = @kg WHERE TraceID = @id`);
    }
  }
}

// ── BOM-validated traceability — CO / BR / CL / TW / DR ──────────────────────
// Generalizes validateMxTubLinks's "does the linked parent's material really
// belong to this job's BOM" check to any parent link (not just MX tubs), for
// the five processes that get a downloaded-and-saved BOM snapshot. EX/MX keep
// their own separate, tub-staging-aware check above — deliberately not
// touched or merged with this (see the approved plan).
const BOM_VALIDATED_PROCESSES = new Set(['CO', 'BR', 'CL', 'TW', 'DR']);

// Materials at this SAP profit centre are raw materials — bought in, never
// produced by any Normanton-Nexus process, so there's no prod.Mixing/
// Extrusion/etc. record to resolve a traceability link against. Their
// traceability is a hand-written SAP batch number instead (see
// prod.RawMaterialBatches / validateRawMaterialBatches below) — nothing to
// resolve, so no wrong-material mismatch is possible for these, only a
// missing entry.
const RAW_MATERIAL_PROFIT_CENTRE = '2012';

// Bulk profit-centre lookup for every distinct material in one SAP round
// trip (see SapServer's GET /api/production/check-profit-centres) rather
// than one check-profit-centre call per BOM component. Returns
// Map<material, profitCentre> with leading zeros already stripped — same
// convention assertProfitCentre uses (MARC-PRCTR comes back zero-padded to
// 10 chars).
async function fetchProfitCentres(materials) {
  const distinct = [...new Set((materials || []).filter(Boolean))];
  if (!distinct.length) return new Map();
  const raw  = await sapGet('/api/production/check-profit-centres', { Materials: distinct });
  const rows = raw?.data ?? raw ?? [];
  return new Map(rows.map(r => [r.material, String(r.profitCentre || '').replace(/^0+/, '')]));
}

// Live BOM lookup for `material` — the finished/produced good, same role as
// `extrudedMaterial` in validateMxTubLinks. Shared by the preview endpoint
// and the persist-at-creation step so both hit SAP exactly once per call.
// Enriches each row with its own profit centre (one extra bulk call, not
// one per component) so callers can tell a raw material apart from a
// portal-tracked semi-finished material without a further round trip.
async function fetchBom(material) {
  const bomRaw  = await sapGet('/api/production/bom', { Material: material });
  const bomRows = bomRaw?.data ?? bomRaw ?? [];
  if (!bomRows.length) return bomRows;

  const profitCentres = await fetchProfitCentres(bomRows.map(r => r.component)).catch(() => new Map());
  return bomRows.map(r => {
    const profitCentre = profitCentres.get(r.component) || null;
    return { ...r, profitCentre, isRawMaterial: profitCentre === RAW_MATERIAL_PROFIT_CENTRE };
  });
}

// Persists a fetched BOM snapshot into prod.ProductionBom for a job. Never
// deletes a prior batch — see the /bom/refresh route — so DownloadedAt always
// distinguishes the creation-time snapshot from any later refresh, keeping
// "what BOM was this job built against" intact for audit even after a
// refresh changes what validation uses going forward.
async function persistBomSnapshot(pool, code, recordID, material, bomRows) {
  for (const r of bomRows) {
    await pool.request()
      .input('pc',    sql.NVarChar(5),   code)
      .input('rid',   sql.Int,           recordID)
      .input('mat',   sql.NVarChar(18),  material)
      .input('comp',  sql.NVarChar(18),  r.component)
      .input('item',  sql.NVarChar(4),   r.item ?? null)
      .input('qty',   sql.Decimal(12, 4), r.componentQty ?? null)
      .input('unit',  sql.NVarChar(3),   r.componentUnit ?? null)
      .input('sloc',  sql.NVarChar(4),   r.storageLocation ?? null)
      .input('prctr', sql.NVarChar(10),  r.profitCentre ?? null)
      .query(`INSERT INTO prod.ProductionBom
                (ProcessCode,RecordID,Material,Component,Item,ComponentQty,ComponentUnit,StorageLocation,ProfitCentre)
              VALUES (@pc,@rid,@mat,@comp,@item,@qty,@unit,@sloc,@prctr)`);
  }
}

// Reads back the LATEST persisted BOM batch for a job (MAX(DownloadedAt) —
// see persistBomSnapshot/the refresh route for why old batches aren't
// deleted on refresh). Returned shape matches fetchBom's live rows
// (component/componentQty/componentUnit/item/storageLocation/profitCentre/
// isRawMaterial) so both feed the same validation/rendering code paths
// interchangeably.
async function latestBomSnapshot(pool, code, recordID) {
  const r = await pool.request()
    .input('pc', sql.NVarChar(5), code).input('rid', sql.Int, recordID)
    .query(`SELECT Component AS component, ComponentQty AS componentQty, ComponentUnit AS componentUnit,
                   Item AS item, StorageLocation AS storageLocation, ProfitCentre AS profitCentre
            FROM prod.ProductionBom
            WHERE ProcessCode=@pc AND RecordID=@rid
              AND DownloadedAt = (SELECT MAX(DownloadedAt) FROM prod.ProductionBom WHERE ProcessCode=@pc AND RecordID=@rid)`);
  return r.recordset.map(row => ({ ...row, isRawMaterial: row.profitCentre === RAW_MATERIAL_PROFIT_CENTRE }));
}

// Records a hand-written SAP batch number against a raw-material BOM
// component — no resolving, no processCode/recordID, since there's no
// portal record for a raw material to link to. Inserted unconditionally
// (same "insert now, validate separately" pattern as parentBatches ->
// prod.ProductionTrace above) — validateRawMaterialBatches below decides
// whether what's here actually satisfies the job's BOM.
async function persistRawMaterialBatches(pool, code, recordID, uid, rawMaterialBatches) {
  for (const rb of rawMaterialBatches || []) {
    const batchNumber = String(rb?.batchNumber || '').trim();
    if (!rb?.material || !batchNumber) continue;
    await pool.request()
      .input('pc',    sql.NVarChar(5),  code)
      .input('rid',   sql.Int,          recordID)
      .input('mat',   sql.NVarChar(18), rb.material)
      .input('batch', sql.NVarChar(50), batchNumber)
      .input('uid',   sql.Int,          uid)
      .query(`INSERT INTO prod.RawMaterialBatches (ProcessCode,RecordID,Material,BatchNumber,LinkedByUserID) VALUES (@pc,@rid,@mat,@batch,@uid)`);
  }
}

// Checks every raw-material BOM component has at least one hand-written
// batch number recorded against it. Unlike validateTraceabilityAgainstBom,
// there's nothing to mismatch here (the operator can't pick the "wrong"
// portal record for something with no portal record at all) — only a
// missing entry — so these problems are never concession-eligible
// (unresolvedProblems/prod.TraceabilityConcessions don't apply) and always
// hard-block completion until filled in.
async function validateRawMaterialBatches(pool, code, recordID, bomRows) {
  const rawComponents = [...new Set((bomRows || []).filter(r => r.isRawMaterial).map(r => r.component))];
  if (!rawComponents.length) return [];

  const r = await pool.request()
    .input('pc', sql.NVarChar(5), code).input('rid', sql.Int, recordID)
    .query(`SELECT DISTINCT Material FROM prod.RawMaterialBatches WHERE ProcessCode=@pc AND RecordID=@rid`);
  const recorded = new Set(r.recordset.map(row => row.Material));

  return rawComponents
    .filter(mat => !recorded.has(mat))
    .map(mat => ({ material: mat, reason: `${mat} is a raw material (profit centre ${RAW_MATERIAL_PROFIT_CENTRE}) — enter its supplier/SAP batch number.` }));
}

// Generalization of validateMxTubLinks's core check (same problems[] /
// never-throws contract) to any parent link, for CO/BR/CL/TW/DR. Resolves
// each linked parent's own Material (same table lookup as
// resolveTraceabilityMaterials) and checks it belongs to bomRows' component
// set — NOT whether it was linked under the "right" checklist row on the
// client, which is purely presentational grouping.
async function validateTraceabilityAgainstBom(pool, parentBatches, bomRows) {
  const bomMaterials = new Set(bomRows.map(r => r.component));
  const problems = [];
  for (const pb of parentBatches || []) {
    if (!pb.processCode || !pb.recordID) continue;
    let cfg;
    try { cfg = processConfig(pb.processCode.toUpperCase()); } catch { continue; }
    const r = await pool.request().input('id', sql.Int, Number(pb.recordID))
      .query(`SELECT Material FROM ${cfg.table} WHERE ${cfg.pk} = @id`);
    const mat   = r.recordset[0]?.Material;
    const label = `${pb.processCode.toUpperCase()}${String(pb.recordID).padStart(8, '0')}`;
    if (!mat) { problems.push({ ...pb, reason: `${label} not found.` }); continue; }
    if (!bomMaterials.has(mat)) {
      problems.push({ ...pb, material: mat, reason: `${label}'s material (${mat}) is not a component of this job's BOM.` });
    }
  }
  return problems;
}

// Filters problems[] down to those NOT covered by an APPROVED concession —
// this is what actually gates completion/posting. "Covered" means an
// approved prod.TraceabilityConcessions row exists for that exact parent
// link (ParentProcessCode/ParentRecordID).
async function unresolvedProblems(pool, code, recordID, problems) {
  const out = [];
  for (const p of problems) {
    if (!p.processCode || !p.recordID) { out.push(p); continue; }
    const c = await pool.request()
      .input('pc',   sql.NVarChar(5), code).input('rid',  sql.Int, recordID)
      .input('ppc',  sql.NVarChar(5), p.processCode.toUpperCase())
      .input('prid', sql.Int,         Number(p.recordID))
      .query(`SELECT TOP 1 1 AS x FROM prod.TraceabilityConcessions
              WHERE ProcessCode=@pc AND RecordID=@rid AND ParentProcessCode=@ppc AND ParentRecordID=@prid AND Status=N'APPROVED'`);
    if (!c.recordset.length) out.push(p);
  }
  return out;
}

// Fetches every APPROVED concession for a job — used to build the explicit
// goods-movement component list when posting under a concession (see
// buildActualComponentList) and to decide whether a job's posting should be
// redirected away from the normal automatic backflush at all.
async function approvedConcessions(pool, code, recordID) {
  const r = await pool.request()
    .input('pc', sql.NVarChar(5), code).input('rid', sql.Int, recordID)
    .query(`SELECT ConcessionID, Component, ActualMaterial, Quantity
            FROM prod.TraceabilityConcessions
            WHERE ProcessCode=@pc AND RecordID=@rid AND Status=N'APPROVED'`);
  return r.recordset;
}

// Builds the full explicit component list SapServer's goods-movement-backflush
// endpoint needs, for a job posting under one or more approved concessions —
// per the approved plan's "full replacement" decision: EVERY component is
// posted explicitly (correct ones included), not just the mismatched one, so
// the normal automatic BOM-driven backflush never also silently consumes the
// original wrong material on top of this explicit posting.
function buildActualComponentList(bomRows, concessions, totalQty) {
  return bomRows.map(row => {
    const concession = concessions.find(c => c.Component === row.component);
    const material = concession ? concession.ActualMaterial : row.component;
    const quantity = concession && concession.Quantity != null
      ? Number(concession.Quantity)
      : Math.round(Number(row.componentQty || 0) * Number(totalQty) * 1000) / 1000;
    return { Material: material, Quantity: quantity, Unit: row.componentUnit, StorageLocation: row.storageLocation };
  });
}

async function writeEvent(pool, processCode, recordId, eventType, message, severity, userId) {
  await pool.request()
    .input('pc',  sql.NVarChar(5),   processCode)
    .input('rid', sql.Int,           recordId)
    .input('et',  sql.NVarChar(20),  eventType)
    .input('msg', sql.NVarChar(sql.MAX), message)
    .input('sev', sql.TinyInt,       severity ?? 0)
    .input('uid', sql.Int,           userId)
    .query(`INSERT INTO prod.EventLog
              (ProcessCode, ProcessRecordID, EventType, EventMessage, Severity, CreatedByUserID)
            VALUES (@pc, @rid, @et, @msg, @sev, @uid)`);
}

function userId(req) { return req.session?.user?.userID ?? 0; }

// ── Reference data ────────────────────────────────────────────────────────────

router.get('/shifts', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request().query(`SELECT ShiftID, ShiftName, StartTime, EndTime, SpansMidnight FROM prod.Shifts WHERE IsActive = 1 ORDER BY ShiftID`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

router.get('/work-centres', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request().query(`
      SELECT wc.WorkCentreID, wc.ProcessCode, wc.WorkCentreName, wc.SAPWorkCentre,
             m.MachineID, m.MachineCode, m.MachineName, m.IdealOutputPerHour, m.PlannedHoursPerShift
      FROM   prod.WorkCentres wc
      LEFT JOIN prod.Machines m ON m.WorkCentreID = wc.WorkCentreID AND m.IsActive = 1
      WHERE  wc.IsActive = 1
      ORDER BY wc.ProcessCode, wc.WorkCentreName, m.MachineCode`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/scrap-reasons', async (req, res) => {
  const { pc } = req.query;
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('pc', sql.NVarChar(5), pc ? pc.toUpperCase() : null)
      .query(`SELECT ReasonID, ReasonCode, ReasonDescription, AppliesTo
              FROM prod.ScrapReasons
              WHERE IsActive = 1
                AND (@pc IS NULL OR AppliesTo IS NULL OR AppliesTo = @pc
                     OR AppliesTo LIKE @pc + ',%'
                     OR AppliesTo LIKE '%,' + @pc + ',%'
                     OR AppliesTo LIKE '%,' + @pc)
              ORDER BY ReasonCode`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Active batches (live dashboard) ──────────────────────────────────────────

router.get('/active', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request().query(`
      SELECT ab.ProcessCode, ab.RecordID, ab.BatchRef, ab.Material,
             ab.Quantity, ab.UOM, ab.Status, ab.ShiftID, ab.MachineID,
             ab.CreatedAt, ab.StartedAt,
             s.ShiftName,
             m.MachineCode, m.MachineName,
             sc.StatusName,
             -- Primary operator name via kongsberg PortalUsers
             pu.Username AS PrimaryOperator
      FROM   prod.vw_ActiveBatches ab
      LEFT JOIN prod.Shifts      s  ON s.ShiftID    = ab.ShiftID
      LEFT JOIN prod.Machines    m  ON m.MachineID  = ab.MachineID
      LEFT JOIN prod.StatusCodes sc ON sc.StatusID  = ab.Status
      LEFT JOIN prod.BatchOperators bo
        ON bo.ProcessCode = ab.ProcessCode AND bo.ProcessRecordID = ab.RecordID
        AND bo.IsPrimary = 1 AND bo.RemovedAt IS NULL
      LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = bo.UserID
      ORDER BY ab.StartedAt DESC, ab.CreatedAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Single batch detail ───────────────────────────────────────────────────────

router.get('/batch/:processCode/:recordId', async (req, res) => {
  try {
    const cfg  = processConfig(req.params.processCode.toUpperCase());
    const id   = Number(req.params.recordId);
    const pool = await getNexusOperationsPool();

    const r = await pool.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM ${cfg.table} WHERE ${cfg.pk} = @id`);

    if (!r.recordset.length) return res.status(404).json({ success: false, error: 'Batch not found.' });

    // Operators
    const ops = await pool.request()
      .input('pc',  sql.NVarChar(5), req.params.processCode.toUpperCase())
      .input('rid', sql.Int, id)
      .query(`SELECT bo.BatchOperatorID, bo.UserID, bo.IsPrimary, bo.AssignedAt, bo.RemovedAt,
                     pu.Username
              FROM   prod.BatchOperators bo
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = bo.UserID
              WHERE  bo.ProcessCode = @pc AND bo.ProcessRecordID = @rid
              ORDER BY bo.IsPrimary DESC, bo.AssignedAt`);

    res.json({ success: true, data: { batch: r.recordset[0], operators: ops.recordset } });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// ── Create new batch ──────────────────────────────────────────────────────────

router.post('/batch', async (req, res) => {
  const { processCode, shiftID, machineID, material, operatorUserID, ...extra } = req.body;
  if (!processCode || !shiftID || !material)
    return res.status(400).json({ success: false, error: 'processCode, shiftID and material are required.' });

  const code = processCode.toUpperCase();
  const uid  = operatorUserID ?? userId(req);

  try {
    processConfig(code); // validates code
    await assertProfitCentre(code, material); // throws 400/502 — caught below
    const pool = await getNexusOperationsPool();
    let insertId;

    // Process-specific insert
    if (code === 'MX') {
      const { mixCode, supplierBatchNo, supplierTubNo, notes } = extra;
      const r = await pool.request()
        .input('shift',   sql.TinyInt,    shiftID)
        .input('mat',     sql.NVarChar(18), material)
        .input('mc',      sql.NVarChar(18), mixCode || '')
        .input('sbn',     sql.NVarChar(50), supplierBatchNo || '')
        .input('stn',     sql.NVarChar(20), supplierTubNo || '')
        .input('uid',     sql.Int,          uid)
        .input('notes',   sql.NVarChar(sql.MAX), notes || null)
        .query(`INSERT INTO prod.Mixing (ShiftID,Material,MixCode,SupplierBatchNo,SupplierTubNo,CreatedByUserID,Notes)
                OUTPUT INSERTED.MixingID VALUES (@shift,@mat,@mc,@sbn,@stn,@uid,@notes)`);
      insertId = r.recordset[0].MixingID;

    } else if (code === 'DR') {
      const { salesOrderSAP, customerID, notes } = extra;
      const r = await pool.request()
        .input('shift', sql.TinyInt,           shiftID)
        .input('mach',  sql.Int,               machineID || null)
        .input('mat',   sql.NVarChar(18),      material)
        .input('so',    sql.NVarChar(12),      salesOrderSAP || null)
        .input('cust',  sql.NVarChar(50),      customerID    || null)
        .input('uid',   sql.Int,               uid)
        .input('notes', sql.NVarChar(sql.MAX), notes || null)
        .query(`INSERT INTO prod.Drumming (ShiftID,MachineID,Material,SalesOrderSAP,CustomerID,CreatedByUserID,Notes)
                OUTPUT INSERTED.DrummingID VALUES (@shift,@mach,@mat,@so,@cust,@uid,@notes)`);
      insertId = r.recordset[0].DrummingID;

    } else if (code === 'EW') {
      const { firewallRequired, notes } = extra;
      const r = await pool.request()
        .input('shift',  sql.TinyInt,    shiftID)
        .input('mach',   sql.Int,        machineID || null)
        .input('mat',    sql.NVarChar(18), material)
        .input('fw',     sql.Bit,         firewallRequired !== false ? 1 : 0)
        .input('uid',    sql.Int,          uid)
        .input('notes',  sql.NVarChar(sql.MAX), notes || null)
        .query(`INSERT INTO prod.Ewald (ShiftID,MachineID,Material,FirewallRequired,CreatedByUserID,Notes)
                OUTPUT INSERTED.EwaldID VALUES (@shift,@mach,@mat,@fw,@uid,@notes)`);
      insertId = r.recordset[0].EwaldID;

    } else if (code === 'FW') {
      const { ewaldID } = extra;
      if (!ewaldID) return res.status(400).json({ success: false, error: 'ewaldID required for Firewall.' });
      const r = await pool.request()
        .input('ewid',   sql.Int, ewaldID)
        .input('uid',    sql.Int, uid)
        .input('notes',  sql.NVarChar(sql.MAX), extra.notes || null)
        .query(`INSERT INTO prod.Firewall (EwaldID,InspectedByUserID,Notes)
                OUTPUT INSERTED.FirewallID VALUES (@ewid,@uid,@notes)`);
      insertId = r.recordset[0].FirewallID;

    } else if (code === 'HA') {
      const { salesOrderSAP, notes } = extra;
      // Snapshot QA routing
      const qaRow = await pool.request()
        .input('mat', sql.NVarChar(18), material)
        .query(`SELECT RequiresQA FROM prod.HoseAssemblyQARouting WHERE Material = @mat`);
      const requiresQA = qaRow.recordset[0]?.RequiresQA ?? 0;
      const r = await pool.request()
        .input('shift',  sql.TinyInt,    shiftID)
        .input('mach',   sql.Int,        machineID || null)
        .input('mat',    sql.NVarChar(18), material)
        .input('so',     sql.NVarChar(12), salesOrderSAP || null)
        .input('qa',     sql.Bit,          requiresQA)
        .input('uid',    sql.Int,          uid)
        .input('notes',  sql.NVarChar(sql.MAX), notes || null)
        .query(`INSERT INTO prod.HoseAssembly (ShiftID,MachineID,Material,SalesOrderSAP,RequiresQA,CreatedByUserID,Notes)
                OUTPUT INSERTED.HoseAssemblyID VALUES (@shift,@mach,@mat,@so,@qa,@uid,@notes)`);
      insertId = r.recordset[0].HoseAssemblyID;

    } else {
      // Generic metre-based processes: EX, CO, BR, CL, TW
      const cfg = PROCESS[code];
      const r = await pool.request()
        .input('shift',  sql.TinyInt,    shiftID)
        .input('mach',   sql.Int,        machineID || null)
        .input('mat',    sql.NVarChar(18), material)
        .input('uid',    sql.Int,          uid)
        .input('notes',  sql.NVarChar(sql.MAX), extra.notes || null)
        .query(`INSERT INTO ${cfg.table} (ShiftID,MachineID,Material,CreatedByUserID,Notes)
                OUTPUT INSERTED.${cfg.pk} VALUES (@shift,@mach,@mat,@uid,@notes)`);
      insertId = r.recordset[0][cfg.pk];
    }

    // Primary operator
    await pool.request()
      .input('pc',  sql.NVarChar(5), code)
      .input('rid', sql.Int, insertId)
      .input('uid', sql.Int, uid)
      .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID)
              VALUES (@pc,@rid,@uid,1,@uid)`);

    // Event log
    await writeEvent(pool, code, insertId, 'STARTED', `Batch created by user ${uid}`, 0, uid);

    res.status(201).json({ success: true, data: { processCode: code, recordId: insertId } });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// ── Update batch status ───────────────────────────────────────────────────────

router.patch('/batch/:processCode/:recordId/status', async (req, res) => {
  const code = req.params.processCode.toUpperCase();
  const id   = Number(req.params.recordId);
  const { status } = req.body;
  if (!status) return res.status(400).json({ success: false, error: 'status is required.' });

  try {
    const cfg  = processConfig(code);
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    const setClause = status === 2 /* IN_PROGRESS */ ? `Status=@s, StartedAt=GETDATE()`
                    : status === 4 /* COMPLETE */     ? `Status=@s, CompletedAt=GETDATE()`
                    : `Status=@s`;

    await pool.request()
      .input('id', sql.Int,    id)
      .input('s',  sql.TinyInt, status)
      .query(`UPDATE ${cfg.table} SET ${setClause} WHERE ${cfg.pk}=@id AND IsReversed=0`);

    const statusNames = { 1:'OPEN', 2:'IN_PROGRESS', 3:'ON_HOLD', 4:'COMPLETE', 5:'CANCELLED' };
    await writeEvent(pool, code, id, statusNames[status] ?? 'NOTE', `Status changed to ${statusNames[status] ?? status}`, 0, uid);

    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// ── Update batch quantity ─────────────────────────────────────────────────────

router.patch('/batch/:processCode/:recordId/quantity', async (req, res) => {
  const code = req.params.processCode.toUpperCase();
  const id   = Number(req.params.recordId);
  const { quantity } = req.body;
  if (quantity == null) return res.status(400).json({ success: false, error: 'quantity is required.' });

  try {
    const cfg  = processConfig(code);
    const pool = await getNexusOperationsPool();

    await pool.request()
      .input('id', sql.Int,            id)
      .input('q',  sql.Decimal(12, 3), quantity)
      .query(`UPDATE ${cfg.table} SET ${cfg.qtyCol}=@q WHERE ${cfg.pk}=@id AND IsReversed=0`);

    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// ── Operators ─────────────────────────────────────────────────────────────────

router.post('/batch/:processCode/:recordId/operators', async (req, res) => {
  const code = req.params.processCode.toUpperCase();
  const id   = Number(req.params.recordId);
  const { addUserID } = req.body;
  if (!addUserID) return res.status(400).json({ success: false, error: 'addUserID is required.' });

  try {
    processConfig(code);
    const pool  = await getNexusOperationsPool();
    const uid   = userId(req);

    // Check not already active on this batch
    const exists = await pool.request()
      .input('pc',  sql.NVarChar(5), code)
      .input('rid', sql.Int, id)
      .input('uid', sql.Int, addUserID)
      .query(`SELECT 1 FROM prod.BatchOperators WHERE ProcessCode=@pc AND ProcessRecordID=@rid AND UserID=@uid AND RemovedAt IS NULL`);
    if (exists.recordset.length) return res.status(409).json({ success: false, error: 'User is already active on this batch.' });

    await pool.request()
      .input('pc',  sql.NVarChar(5), code)
      .input('rid', sql.Int, id)
      .input('uid', sql.Int, addUserID)
      .input('by',  sql.Int, uid)
      .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES (@pc,@rid,@uid,0,@by)`);

    await writeEvent(pool, code, id, 'OPERATOR_ADD', `User ${addUserID} added to batch`, 0, uid);
    res.status(201).json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

router.delete('/batch/:processCode/:recordId/operators/:targetUserId', async (req, res) => {
  const code       = req.params.processCode.toUpperCase();
  const id         = Number(req.params.recordId);
  const targetUid  = Number(req.params.targetUserId);

  try {
    processConfig(code);
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    await pool.request()
      .input('pc',  sql.NVarChar(5), code)
      .input('rid', sql.Int, id)
      .input('uid', sql.Int, targetUid)
      .query(`UPDATE prod.BatchOperators SET RemovedAt=GETDATE() WHERE ProcessCode=@pc AND ProcessRecordID=@rid AND UserID=@uid AND RemovedAt IS NULL`);

    await writeEvent(pool, code, id, 'OPERATOR_REMOVE', `User ${targetUid} removed from batch`, 0, uid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Traceability ──────────────────────────────────────────────────────────────

router.post('/trace', async (req, res) => {
  const { childProcessCode, childRecordID, parentProcessCode, parentRecordID } = req.body;
  if (!childProcessCode || !childRecordID || !parentProcessCode || !parentRecordID)
    return res.status(400).json({ success: false, error: 'childProcessCode, childRecordID, parentProcessCode, parentRecordID are required.' });

  try {
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    await pool.request()
      .input('cc', sql.NVarChar(5), childProcessCode.toUpperCase())
      .input('cr', sql.Int, childRecordID)
      .input('pc', sql.NVarChar(5), parentProcessCode.toUpperCase())
      .input('pr', sql.Int, parentRecordID)
      .input('uid', sql.Int, uid)
      .query(`INSERT INTO prod.ProductionTrace (ChildProcessCode,ChildRecordID,ParentProcessCode,ParentRecordID,LinkedByUserID)
              VALUES (@cc,@cr,@pc,@pr,@uid)`);

    res.status(201).json({ success: true });
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ success: false, error: 'This trace link already exists.' });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/trace/:processCode/:recordId', async (req, res) => {
  const code = req.params.processCode.toUpperCase();
  const id   = Number(req.params.recordId);

  try {
    const pool = await getNexusOperationsPool();

    // Step 1: recursive CTE — all ancestors of the given batch
    const traceR = await pool.request()
      .input('cc', sql.NVarChar(5), code)
      .input('cr', sql.Int, id)
      .query(`
        WITH TraceChain AS (
          SELECT ChildProcessCode, ChildRecordID, ParentProcessCode, ParentRecordID, 0 AS Depth
          FROM   prod.ProductionTrace
          WHERE  ChildProcessCode = @cc AND ChildRecordID = @cr
          UNION ALL
          SELECT t.ChildProcessCode, t.ChildRecordID, t.ParentProcessCode, t.ParentRecordID, tc.Depth + 1
          FROM   prod.ProductionTrace t
          INNER JOIN TraceChain tc ON t.ChildProcessCode = tc.ParentProcessCode
                                  AND t.ChildRecordID   = tc.ParentRecordID
        )
        SELECT * FROM TraceChain ORDER BY Depth`);

    const chain = traceR.recordset;

    // Step 2: collect every unique (ProcessCode, RecordID) pair in the chain,
    // always including the searched batch itself even when there are no links.
    const pcGroups = {}; // { PC: Set(rids) }
    const addPair = (pc, rid) => {
      if (!PROCESS[pc]) return;
      if (!pcGroups[pc]) pcGroups[pc] = new Set();
      pcGroups[pc].add(rid);
    };
    addPair(code, id);
    chain.forEach(r => {
      addPair(r.ChildProcessCode,  r.ChildRecordID);
      addPair(r.ParentProcessCode, r.ParentRecordID);
    });

    // Step 3: one round-trip UNION query to fetch BatchRef, Material, Quantity,
    // CreatedAt and primary operator for every pair found above.
    const req2 = pool.request();
    const parts = [];
    let p = 0;

    for (const [pc, ridSet] of Object.entries(pcGroups)) {
      const cfg = PROCESS[pc];
      const idParams = [...ridSet].map(rid => {
        const nm = `id${p++}`;
        req2.input(nm, sql.Int, rid);
        return `@${nm}`;
      }).join(',');

      parts.push(`
        SELECT '${pc}' AS ProcessCode, t.${cfg.pk} AS RecordID,
               t.${cfg.ref} AS BatchRef, t.Material,
               CAST(t.${cfg.qtyCol} AS DECIMAL(14,3)) AS Quantity, '${cfg.uom}' AS UOM,
               t.CreatedAt, pu.Username AS Operator
        FROM   ${cfg.table} t
        LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = t.CreatedByUserID
        WHERE  t.${cfg.pk} IN (${idParams})`);
    }

    const details = {};
    if (parts.length) {
      const detailR = await req2.query(parts.join('\nUNION ALL\n'));
      detailR.recordset.forEach(r => { details[`${r.ProcessCode}-${r.RecordID}`] = r; });
    }

    res.json({ success: true, data: { chain, details } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Scrap ─────────────────────────────────────────────────────────────────────

router.post('/scrap', async (req, res) => {
  const { processCode, processRecordID, reasonID, quantity, unitOfMeasure, notes } = req.body;
  if (!processCode || !processRecordID || !reasonID || !quantity || !unitOfMeasure)
    return res.status(400).json({ success: false, error: 'processCode, processRecordID, reasonID, quantity, unitOfMeasure are required.' });

  try {
    processConfig(processCode.toUpperCase());
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    await pool.request()
      .input('pc',  sql.NVarChar(5),   processCode.toUpperCase())
      .input('rid', sql.Int,           processRecordID)
      .input('rid2', sql.Int,          reasonID)
      .input('qty', sql.Decimal(12,3), quantity)
      .input('uom', sql.NVarChar(5),   unitOfMeasure)
      .input('uid', sql.Int,           uid)
      .input('notes', sql.NVarChar(sql.MAX), notes || null)
      .query(`INSERT INTO prod.ScrapEntries (ProcessCode,ProcessRecordID,ReasonID,Quantity,UnitOfMeasure,EnteredByUserID,Notes)
              VALUES (@pc,@rid,@rid2,@qty,@uom,@uid,@notes)`);

    await writeEvent(pool, processCode.toUpperCase(), processRecordID, 'SCRAP',
      `Scrap: ${quantity} ${unitOfMeasure} — reason ${reasonID}`, 1, uid);

    getNexusPool().then(kPool => notify(kPool, {
      title:       'Scrap Pending Approval',
      body:        `${quantity} ${unitOfMeasure} scrap logged on ${processCode.toUpperCase()}-${String(processRecordID).padStart(8,'0')} — awaiting supervisor approval.`,
      severity:    1,
      category:    'production',
      actionLabel: 'Approve Scrap',
      actionURL:   '/private/production-nexus.html',
      target:      { type: 'permission', value: 'PROD_SUPERVISOR' },
    })).catch(() => {});

    res.status(201).json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// ── Event log ─────────────────────────────────────────────────────────────────

router.get('/batch/:processCode/:recordId/events', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('pc',  sql.NVarChar(5), req.params.processCode.toUpperCase())
      .input('rid', sql.Int,         Number(req.params.recordId))
      .query(`SELECT EventID, EventType, EventMessage, Severity, CreatedAt, CreatedByUserID
              FROM   prod.EventLog
              WHERE  ProcessCode = @pc AND ProcessRecordID = @rid
              ORDER BY CreatedAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/event', async (req, res) => {
  const { processCode, processRecordID, eventType, message, severity } = req.body;
  if (!processCode || !processRecordID || !eventType || !message)
    return res.status(400).json({ success: false, error: 'processCode, processRecordID, eventType and message are required.' });
  try {
    const pool = await getNexusOperationsPool();
    await writeEvent(pool, processCode.toUpperCase(), processRecordID, eventType, message, severity ?? 0, userId(req));
    res.status(201).json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Batch history ─────────────────────────────────────────────────────────────

router.get('/history', async (req, res) => {
  const { processCode, material, ref, fromDate, toDate, page = 1, pageSize = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(pageSize);

  try {
    const pool = await getNexusOperationsPool();
    const parts = [];

    // Build a single request object that carries all filter parameters
    const request = pool.request()
      .input('offset',   sql.Int, offset)
      .input('pageSize', sql.Int, Number(pageSize));

    // Column names match the AllBatches inner aliases (PC, BatchRef, Material, CreatedAt)
    if (processCode) { parts.push(`PC = @pc`);             request.input('pc',   sql.NVarChar(5),  processCode.toUpperCase()); }
    if (material)    { parts.push(`Material = @mat`);      request.input('mat',  sql.NVarChar(18), material); }
    if (ref)         { parts.push(`BatchRef LIKE @ref`);   request.input('ref',  sql.NVarChar(20), `%${ref}%`); }
    if (fromDate)    { parts.push(`CreatedAt >= @from`);   request.input('from', sql.DateTime,     new Date(fromDate)); }
    if (toDate)      { parts.push(`CreatedAt <= @to`);     request.input('to',   sql.DateTime,     new Date(toDate)); }

    // Filter is applied inside AllBatches (before ROW_NUMBER) so pagination counts correctly
    const innerWhere = parts.length ? `WHERE ${parts.join(' AND ')}` : '';

    const hist = await request.query(`
      SELECT ProcessCode, RecordID, BatchRef, Material, Quantity, UOM, Status, CreatedAt, CompletedAt
      FROM (
        SELECT ROW_NUMBER() OVER (ORDER BY CreatedAt DESC) AS RowNum,
               PC AS ProcessCode, RID AS RecordID, BatchRef, Material, Qty AS Quantity, UOM, Status, CreatedAt, CompletedAt
        FROM (
          SELECT N'MX'  AS PC, MixingID       AS RID, MixRef     AS BatchRef, Material, CAST(TotalWeightKG         AS DECIMAL(12,3)) AS Qty, N'KG' AS UOM, Status, CreatedAt, CompletedAt FROM prod.Mixing       
          UNION ALL SELECT N'EX',  ExtrusionID,    ExtRef,   Material, LengthMetres,                         N'M',  Status, CreatedAt, CompletedAt FROM prod.Extrusion    
          UNION ALL SELECT N'CO',  ConvolutingID,  ConvRef,  Material, LengthMetres,                         N'M',  Status, CreatedAt, CompletedAt FROM prod.Convoluting  
          UNION ALL SELECT N'BR',  BraidingID,     BraidRef, Material, LengthMetres,                         N'M',  Status, CreatedAt, CompletedAt FROM prod.Braiding     
          UNION ALL SELECT N'CL',  CoverlineID,    CovRef,   Material, LengthMetres,                         N'M',  Status, CreatedAt, CompletedAt FROM prod.Coverline    
          UNION ALL SELECT N'TW',  TapeWrapID,     TWRef,    Material, LengthMetres,                         N'M',  Status, CreatedAt, CompletedAt FROM prod.TapeWrap     
          UNION ALL SELECT N'DR',  DrummingID,     DrumRef,  Material, LengthMetres,                         N'M',  Status, CreatedAt, CompletedAt FROM prod.Drumming     
          UNION ALL SELECT N'EW',  EwaldID,        EwaldRef, Material, CAST(TotalPiecesEA AS DECIMAL(12,3)), N'EA', Status, CreatedAt, CompletedAt FROM prod.Ewald        
          UNION ALL SELECT N'HA',  HoseAssemblyID, HARef,    Material, CAST(QuantityEA    AS DECIMAL(12,3)), N'EA', Status, CreatedAt, CompletedAt FROM prod.HoseAssembly 
        ) AS AllBatches
        ${innerWhere}
      ) AS Paged
      WHERE RowNum > @offset AND RowNum <= (@offset + @pageSize)
      ORDER BY CreatedAt DESC`);

    res.json({ success: true, data: hist.recordset, page: Number(page), pageSize: Number(pageSize) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Ewald boxes ───────────────────────────────────────────────────────────────

router.get('/ewald/:ewaldId/boxes', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('id', sql.Int, Number(req.params.ewaldId))
      .query(`SELECT EwaldBoxID, PiecesEA, CustomerCode, SAPBatchNumber, BackflushedAt, IsReversed, ReversedAt, ReversalDocumentSAP
              FROM   prod.EwaldBoxes WHERE EwaldID=@id ORDER BY EwaldBoxID`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/ewald/:ewaldId/boxes', async (req, res) => {
  const { piecesEA, customerCode, sapBatchNumber } = req.body;
  if (!piecesEA) return res.status(400).json({ success: false, error: 'piecesEA is required.' });
  try {
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);
    const ewaldId = Number(req.params.ewaldId);

    await pool.request()
      .input('eid',  sql.Int,          ewaldId)
      .input('pcs',  sql.Int,          piecesEA)
      .input('cc',   sql.NVarChar(10), customerCode || null)
      .input('sap',  sql.NVarChar(10), sapBatchNumber || null)
      .input('uid',  sql.Int,          uid)
      .query(`INSERT INTO prod.EwaldBoxes (EwaldID,PiecesEA,CustomerCode,SAPBatchNumber,BackflushedAt,BackflushedByUserID)
              VALUES (@eid,@pcs,@cc,@sap,GETDATE(),@uid)`);

    await writeEvent(pool, 'EW', ewaldId, 'SAP_POST', `Box posted: ${piecesEA} EA — SAP batch ${sapBatchNumber || 'pending'}`, 0, uid);
    res.status(201).json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── SAP postings log ──────────────────────────────────────────────────────────

router.post('/sap-posting', async (req, res) => {
  const { processCode, processRecordID, postingType, quantity, unitOfMeasure,
          materialDocumentSAP, salesOrderSAP, productionOrderSAP, sapBatchNumber, isSuccess, errorMessage } = req.body;
  try {
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    await pool.request()
      .input('pc',   sql.NVarChar(5),   processCode.toUpperCase())
      .input('rid',  sql.Int,           processRecordID)
      .input('type', sql.NVarChar(20),  postingType)
      .input('qty',  sql.Decimal(12,3), quantity)
      .input('uom',  sql.NVarChar(5),   unitOfMeasure)
      .input('mdoc', sql.NVarChar(10),  materialDocumentSAP || null)
      .input('so',   sql.NVarChar(12),  salesOrderSAP || null)
      .input('po',   sql.NVarChar(12),  productionOrderSAP || null)
      .input('sb',   sql.NVarChar(10),  sapBatchNumber || null)
      .input('ok',   sql.Bit,           isSuccess ? 1 : 0)
      .input('err',  sql.NVarChar(sql.MAX), errorMessage || null)
      .input('uid',  sql.Int,           uid)
      .query(`INSERT INTO prod.SAPPostings
                (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,
                 MaterialDocumentSAP,SalesOrderSAP,ProductionOrderSAP,SAPBatchNumber,
                 IsSuccess,ErrorMessage,PostedByUserID)
              VALUES (@pc,@rid,@type,@qty,@uom,@mdoc,@so,@po,@sb,@ok,@err,@uid)`);

    const evt = isSuccess ? 'SAP_POST' : 'SAP_FAIL';
    await writeEvent(pool, processCode.toUpperCase(), processRecordID, evt,
      `${postingType} — ${quantity} ${unitOfMeasure} — doc: ${materialDocumentSAP || 'none'}`,
      isSuccess ? 0 : 2, uid);

    res.status(201).json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Reversal ──────────────────────────────────────────────────────────────────

router.get('/reversal/search', async (req, res) => {
  const { materialDocument } = req.query;
  if (!materialDocument) return res.status(400).json({ success: false, error: 'materialDocument is required.' });
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('doc', sql.NVarChar(10), materialDocument)
      .query(`SELECT SAPPostingID, ProcessCode, ProcessRecordID, PostingType, Quantity, UnitOfMeasure,
                     MaterialDocumentSAP, PostedAt, IsReversed
              FROM   prod.SAPPostings WHERE MaterialDocumentSAP = @doc`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Scrap cleanup triggered by a backflush reversal ──────────────────────────
// Called whenever a job's backflush is reversed (bulk or single path).
// • Pending scrap (not yet approved) → voided so it cannot be approved later.
// • Already SAP-posted scrap → reversed via SapServer, marked in DB.
async function reverseJobScrap(pool, processCode, recordID, uid) {
  // Void all non-posted scrap for this job — covers both "awaiting approval"
  // (IsApproved=0) and "failed to post / retry" (IsApproved=1, SAPPosted=0).
  // These entries are removed from every active scrap queue by IsVoided=1.
  await pool.request()
    .input('pc',  sql.NVarChar(5), processCode)
    .input('rid', sql.Int,         recordID)
    .query(`UPDATE prod.ScrapEntries
            SET IsVoided = 1
            WHERE ProcessCode = @pc AND ProcessRecordID = @rid
              AND SAPPosted = 0`);

  // Find all unversed SAP scrap documents for this job
  const docsR = await pool.request()
    .input('pc',  sql.NVarChar(5), processCode)
    .input('rid', sql.Int,         recordID)
    .query(`SELECT smd.ScrapDocumentID, smd.MaterialDocument
            FROM   prod.ScrapMaterialDocuments smd
            JOIN   prod.ScrapEntries se ON se.ScrapID = smd.ScrapID
            WHERE  se.ProcessCode = @pc AND se.ProcessRecordID = @rid
              AND  smd.IsReversed = 0
              AND  smd.MaterialDocument IS NOT NULL`);

  for (const doc of docsR.recordset) {
    let reversalDoc = null;
    try {
      const raw = await sapPost('/api/production/scrap/reverse', { MaterialDocument: doc.MaterialDocument });
      reversalDoc = raw?.data?.documentNumber || raw?.documentNumber || null;
    } catch (err) {
      console.error(`[scrap-reverse] SAP call failed for doc ${doc.MaterialDocument}:`, err.message);
    }
    await pool.request()
      .input('id',  sql.Int,          doc.ScrapDocumentID)
      .input('rev', sql.NVarChar(10), reversalDoc)
      .input('uid', sql.Int,          uid)
      .query(`UPDATE prod.ScrapMaterialDocuments
              SET IsReversed = 1, ReversalDocument = @rev,
                  ReversedAt = GETDATE(), ReversedByUserID = @uid
              WHERE ScrapDocumentID = @id`);
  }
}

router.patch('/reversal/:sapPostingId', async (req, res) => {
  const { reversalDocumentSAP } = req.body;
  const postingId = Number(req.params.sapPostingId);
  if (!reversalDocumentSAP) return res.status(400).json({ success: false, error: 'reversalDocumentSAP is required.' });

  try {
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    // Get the posting to find the process record
    const post = await pool.request()
      .input('id', sql.Int, postingId)
      .query(`SELECT ProcessCode, ProcessRecordID FROM prod.SAPPostings WHERE SAPPostingID=@id`);
    if (!post.recordset.length) return res.status(404).json({ success: false, error: 'SAP posting not found.' });

    const { ProcessCode, ProcessRecordID } = post.recordset[0];

    // Mark posting reversed
    await pool.request()
      .input('id',  sql.Int,          postingId)
      .input('doc', sql.NVarChar(10), reversalDocumentSAP)
      .input('uid', sql.Int,          uid)
      .query(`UPDATE prod.SAPPostings SET IsReversed=1, ReversalDocumentSAP=@doc, ReversedAt=GETDATE(), ReversedByUserID=@uid WHERE SAPPostingID=@id`);

    // Mark process record reversed
    const cfg = PROCESS[ProcessCode];
    if (cfg) {
      await pool.request()
        .input('rid', sql.Int, ProcessRecordID)
        .input('uid', sql.Int, uid)
        .query(`UPDATE ${cfg.table} SET IsReversed=1, ReversedAt=GETDATE(), ReversedByUserID=@uid WHERE ${cfg.pk}=@rid`);
    }

    await reverseJobScrap(pool, ProcessCode, ProcessRecordID, uid);

    await writeEvent(pool, ProcessCode, ProcessRecordID, 'REVERSAL',
      `SAP posting ${postingId} reversed — reversal doc: ${reversalDocumentSAP}`, 1, uid);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Reverse a SAP backflush document via ZF40N ────────────────────────────────

router.post('/reversal/execute', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const { materialDocument } = req.body;
  if (!materialDocument)
    return res.status(400).json({ success: false, error: 'materialDocument is required.' });

  try {
    const raw = await sapPost('/api/production/reverse-backflush', { MaterialDocument: materialDocument });

    if (raw?.success === false)
      return res.status(502).json({ success: false, error: (typeof raw.error === 'string' ? raw.error : raw.error?.message) || raw.message || 'SAP server error' });

    const { type, messageClass, messageNumber, documentNumber, message } = raw?.data ?? raw ?? {};

    if (type === 'S' && messageClass === 'RM' && messageNumber === '196') {
      audit('SAP_OK', req.session?.user?.username, `'${materialDocument}' REVERSED - Reversal Document = '${documentNumber || ''}'`, req);
      return res.json({
        success: true,
        data: { reversalDocument: documentNumber || null, originalDocument: materialDocument },
      });
    }

    // Known error codes with user-friendly messages
    if (type === 'E') {
      if (messageClass === 'RM' && messageNumber === '210') {
        audit('SAP_ERROR', req.session?.user?.username, `'${materialDocument}' REVERSAL FAILED - Message = "Already reversed"`, req);
        return res.status(409).json({ success: false, error: 'This document has already been reversed — no further action needed.' });
      }
      if (messageClass === 'M7' && messageNumber === '066') {
        audit('SAP_ERROR', req.session?.user?.username, `'${materialDocument}' REVERSAL FAILED - Message = "Must use MBST"`, req);
        return res.status(422).json({ success: false, error: 'This document needs to be reversed using MBST.' });
      }
      const errMsg = message || `SAP error: ${messageClass} ${messageNumber}`;
      audit('SAP_ERROR', req.session?.user?.username, `'${materialDocument}' REVERSAL FAILED - Message = "${errMsg}"`, req);
      return res.status(502).json({ success: false, error: errMsg });
    }

    const errMsg = message || `Unexpected SAP response: ${type} ${messageClass} ${messageNumber}`;
    audit('SAP_ERROR', req.session?.user?.username, `'${materialDocument}' REVERSAL FAILED - Message = "${errMsg}"`, req);
    return res.status(502).json({ success: false, error: errMsg });

  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
    audit('SAP_ERROR', req.session?.user?.username, `'${materialDocument}' REVERSAL FAILED - Message = "${errMsg}"`, req);
    res.status(502).json({ success: false, error: errMsg });
  }
});

// ── Scrap SAP helpers ─────────────────────────────────────────────────────────

// Unwraps the BdcWrapper response from /api/production/scrap/post.
// Validates every BdcResponse: type=S, messageClass=M7, messageNumber=060.
// Returns the responses array or throws with the first failure message.
function parseBomScrapResponse(sapRaw) {
  if (sapRaw?.success === false) throw new Error((typeof sapRaw.error === 'string' ? sapRaw.error : sapRaw.error?.message) || 'SAP scrap server error');
  const responses = sapRaw?.data?.responses;
  if (!Array.isArray(responses) || !responses.length)
    throw new Error('SAP returned no posting responses');
  for (const r of responses) {
    if (r.type !== 'S' || r.messageClass !== 'M7' || r.messageNumber !== '060')
      throw new Error(r.message || `SAP posting failed: ${r.type} ${r.messageClass} ${r.messageNumber}`);
  }
  return responses;
}

// Unwraps the StockAdjustmentResponse-shaped result from
// /api/production/mixing-scrap (BAPI_GOODSMVT_CREATE, movement 551) — the
// mix-expiry finished-good scrap endpoint, distinct from parseBomScrapResponse
// above (which handles /scrap/post's BDC array-of-responses shape for
// looping over BOM components). SapServer's own ParseStockAdjustmentResponse
// already computes `success` (non-blank material document + no blocking
// RETURN message) — this just unwraps the envelope and turns a failure into
// a thrown Error carrying SAP's own RETURN messages, same contract every
// other parse* helper in this file follows.
function parseMixingScrapResponse(sapRaw) {
  if (sapRaw?.success === false) throw new Error(sapRaw.error?.message || sapRaw.error || 'SAP scrap server error');
  const r = sapRaw?.data;
  if (!r) throw new Error('SAP returned no posting response');
  if (!r.success) {
    const msg = (r.messages || []).map(m => m.message).filter(Boolean).join(' ');
    throw new Error(msg || 'SAP rejected the mixing scrap posting.');
  }
  return r;
}

// Inserts one ScrapMaterialDocuments row per BdcResponse.
async function insertScrapDocuments(pool, scrapID, responses, uid) {
  for (const r of responses) {
    await pool.request()
      .input('scrapID', sql.Int,          scrapID)
      .input('doc',     sql.NVarChar(18), r.documentNumber || '')
      .input('type',    sql.NVarChar(1),  r.type           || '')
      .input('mc',      sql.NVarChar(3),  r.messageClass   || null)
      .input('mn',      sql.NVarChar(4),  r.messageNumber  || null)
      .input('msg',     sql.NVarChar(500),r.message        || null)
      .input('uid',     sql.Int,          uid)
      .query(`
        INSERT INTO prod.ScrapMaterialDocuments
          (ScrapID, MaterialDocument, SAPType, MessageClass, MessageNumber, SAPMessage, PostedByUserID)
        VALUES (@scrapID, @doc, @type, @mc, @mn, @msg, @uid)
      `);
  }
}

// ── Scrap summary ────────────────────────────────────────────────────────────

router.get('/scrap/summary', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request().query(`
      SELECT se.ProcessCode,
             sr.ReasonCode, sr.ReasonDescription,
             se.UnitOfMeasure,
             COUNT(*)         AS EntryCount,
             SUM(se.Quantity) AS TotalScrap
      FROM   prod.ScrapEntries se
      LEFT JOIN prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
      WHERE  se.SAPPosted = 1
        AND  EXISTS (
               SELECT 1 FROM prod.ScrapMaterialDocuments smd
               WHERE  smd.ScrapID = se.ScrapID AND smd.IsReversed = 0
             )
      GROUP  BY se.ProcessCode, sr.ReasonCode, sr.ReasonDescription, se.UnitOfMeasure
      ORDER  BY se.ProcessCode, TotalScrap DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Scrap — failed postings (approved but SAP rejected) ──────────────────────

router.get('/scrap/failed', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request().query(`
      SELECT se.ScrapID, se.ProcessCode, se.ProcessRecordID,
             se.ReasonID, sr.ReasonCode, sr.ReasonDescription,
             se.Quantity, se.UnitOfMeasure, se.EnteredAt,
             se.SAPErrorMessage, se.ApprovedAt,
             pu.Username AS EnteredBy,
             COALESCE(mx.MixRef, dr.DrumRef, ex.ExtRef, co.ConvRef,
                      br.BraidRef, cl.CovRef, tw.TWRef, ew.EwaldRef, ha.HARef) AS BatchRef,
             COALESCE(mx.Material, dr.Material, ex.Material, co.Material,
                      br.Material, cl.Material, tw.Material, ew.Material, ha.Material) AS Material
      FROM   prod.ScrapEntries se
      JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
      LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = se.EnteredByUserID
      LEFT JOIN prod.Mixing       mx ON mx.MixingID       = se.ProcessRecordID AND se.ProcessCode = 'MX'
      LEFT JOIN prod.Drumming     dr ON dr.DrummingID     = se.ProcessRecordID AND se.ProcessCode = 'DR'
      LEFT JOIN prod.Extrusion    ex ON ex.ExtrusionID    = se.ProcessRecordID AND se.ProcessCode = 'EX'
      LEFT JOIN prod.Convoluting  co ON co.ConvolutingID  = se.ProcessRecordID AND se.ProcessCode = 'CO'
      LEFT JOIN prod.Braiding     br ON br.BraidingID     = se.ProcessRecordID AND se.ProcessCode = 'BR'
      LEFT JOIN prod.Coverline    cl ON cl.CoverlineID    = se.ProcessRecordID AND se.ProcessCode = 'CL'
      LEFT JOIN prod.TapeWrap     tw ON tw.TapeWrapID     = se.ProcessRecordID AND se.ProcessCode = 'TW'
      LEFT JOIN prod.Ewald        ew ON ew.EwaldID        = se.ProcessRecordID AND se.ProcessCode = 'EW'
      LEFT JOIN prod.HoseAssembly ha ON ha.HoseAssemblyID = se.ProcessRecordID AND se.ProcessCode = 'HA'
      WHERE  se.IsApproved = 1 AND se.SAPPosted = 0 AND se.IsVoided = 0
      ORDER BY se.ApprovedAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Scrap — retry a failed posting (with optional field edits) ────────────────

router.patch('/scrap/:scrapId/retry', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const scrapID = Number(req.params.scrapId);
  const { quantity, reasonID } = req.body;
  const pool = await getNexusOperationsPool();
  const uid  = userId(req);

  try {
    if (quantity || reasonID) {
      await pool.request()
        .input('id',  sql.Int,           scrapID)
        .input('qty', sql.Decimal(12,3), quantity ? Number(quantity) : null)
        .input('rid', sql.Int,           reasonID ? Number(reasonID) : null)
        .query(`UPDATE prod.ScrapEntries SET
          Quantity = COALESCE(@qty, Quantity),
          ReasonID = COALESCE(@rid, ReasonID)
          WHERE ScrapID = @id`);
    }

    const scrapR = await pool.request()
      .input('id', sql.Int, scrapID)
      .query(`SELECT se.ScrapID, se.ProcessCode, se.ProcessRecordID,
                     se.Quantity, se.UnitOfMeasure, sr.ReasonCode
              FROM   prod.ScrapEntries se
              JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
              WHERE  se.ScrapID = @id AND se.IsApproved = 1 AND se.SAPPosted = 0 AND se.IsVoided = 0`);

    if (!scrapR.recordset.length)
      return res.status(404).json({ success: false, error: 'Entry not found, already posted, or voided.' });

    const s   = scrapR.recordset[0];
    const cfg = PROCESS[s.ProcessCode];
    if (!cfg) return res.status(400).json({ success: false, error: `Unknown process code: ${s.ProcessCode}` });

    const matR = await pool.request()
      .input('id', sql.Int, s.ProcessRecordID)
      .query(`SELECT Material, ${cfg.ref} AS BatchRef FROM ${cfg.table} WHERE ${cfg.pk} = @id`);

    if (!matR.recordset.length) return res.status(404).json({ success: false, error: 'Process record not found.' });

    const { Material: material, BatchRef: batchRef } = matR.recordset[0];
    const reasonCode  = s.ReasonCode?.trim();
    const sapPayload  = {
      Material:     material,
      Quantity:     Number(s.Quantity),
      Header:       batchRef || String(scrapID),
      MovementType: '551',
    };
    if (reasonCode?.length === 4) sapPayload.ScrapReason = reasonCode;

    const sapRaw    = await sapPost('/api/production/scrap/post', sapPayload);
    const responses = parseBomScrapResponse(sapRaw);

    await insertScrapDocuments(pool, scrapID, responses, uid);

    await pool.request()
      .input('id', sql.Int, scrapID)
      .query(`UPDATE prod.ScrapEntries SET SAPPosted=1, SAPErrorMessage=NULL WHERE ScrapID=@id`);

    const docList = responses.map(r => r.documentNumber).filter(Boolean).join(', ');
    audit('SAP_OK', req.session?.user?.username, `'${batchRef}' SCRAP POSTED - Material Documents = '${docList}'`, req);
    await writeEvent(pool, s.ProcessCode, s.ProcessRecordID, 'NOTE',
      `Scrap retry succeeded — ScrapID ${scrapID} — MatDocs: ${docList}`, 0, uid);

    res.json({ success: true, data: { materialDocuments: responses.map(r => r.documentNumber) } });

  } catch (err) {
    const d = err.response?.data;
    const errMsg = err.response?.status === 404
      ? `SAP endpoint not found (404) — /api/production/scrap/post has not been deployed on the SapServer yet.`
      : (typeof d === 'string' ? d : null) || d?.error || d?.message || d?.title
        || (d?.errors ? JSON.stringify(d.errors) : null) || err.message;
    audit('SAP_ERROR', req.session?.user?.username, `'${batchRef}' SCRAP FAILED - Message = "${errMsg}"`, req);
    await pool.request()
      .input('id',  sql.Int,              scrapID)
      .input('err', sql.NVarChar(sql.MAX), errMsg)
      .query(`UPDATE prod.ScrapEntries SET SAPErrorMessage=@err WHERE ScrapID=@id`).catch(() => {});
    res.status(502).json({ success: false, error: errMsg });
  }
});

router.get('/scrap/entries', async (req, res) => {
  const { processCode, processRecordID, reasonCode } = req.query;
  try {
    const pool = await getNexusOperationsPool();
    const request = pool.request();
    let where = '';
    if (processCode) {
      request.input('pc', sql.NVarChar(5), processCode.toUpperCase());
      where += ' AND se.ProcessCode = @pc';
    }
    if (processRecordID) {
      request.input('rid', sql.Int, Number(processRecordID));
      where += ' AND se.ProcessRecordID = @rid';
    }
    if (reasonCode) {
      request.input('rc', sql.NVarChar(10), reasonCode);
      where += ' AND sr.ReasonCode = @rc';
    }
    const r = await request.query(`
      SELECT se.ScrapID, se.ProcessCode, se.ProcessRecordID,
             sr.ReasonCode, sr.ReasonDescription,
             se.Quantity, se.UnitOfMeasure, se.EnteredAt, se.Notes,
             se.IsApproved, se.SAPPosted, se.SAPMaterialDocument, se.SAPErrorMessage,
             se.IsReversed,
             pu.Username AS EnteredBy,
             COALESCE(mx.MixRef, dr.DrumRef, ex.ExtRef, co.ConvRef,
                      br.BraidRef, cl.CovRef, tw.TWRef, ew.EwaldRef, ha.HARef) AS BatchRef,
             COALESCE(mx.Material, dr.Material, ex.Material, co.Material,
                      br.Material, cl.Material, tw.Material, ew.Material, ha.Material) AS Material
      FROM   prod.ScrapEntries se
      LEFT JOIN prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
      LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = se.EnteredByUserID
      LEFT JOIN prod.Mixing       mx ON mx.MixingID       = se.ProcessRecordID AND se.ProcessCode = 'MX'
      LEFT JOIN prod.Drumming     dr ON dr.DrummingID     = se.ProcessRecordID AND se.ProcessCode = 'DR'
      LEFT JOIN prod.Extrusion    ex ON ex.ExtrusionID    = se.ProcessRecordID AND se.ProcessCode = 'EX'
      LEFT JOIN prod.Convoluting  co ON co.ConvolutingID  = se.ProcessRecordID AND se.ProcessCode = 'CO'
      LEFT JOIN prod.Braiding     br ON br.BraidingID     = se.ProcessRecordID AND se.ProcessCode = 'BR'
      LEFT JOIN prod.Coverline    cl ON cl.CoverlineID    = se.ProcessRecordID AND se.ProcessCode = 'CL'
      LEFT JOIN prod.TapeWrap     tw ON tw.TapeWrapID     = se.ProcessRecordID AND se.ProcessCode = 'TW'
      LEFT JOIN prod.Ewald        ew ON ew.EwaldID        = se.ProcessRecordID AND se.ProcessCode = 'EW'
      LEFT JOIN prod.HoseAssembly ha ON ha.HoseAssemblyID = se.ProcessRecordID AND se.ProcessCode = 'HA'
      WHERE  1=1 ${where}
      ORDER BY se.EnteredAt DESC`);

    const entries = r.recordset;

    // Attach material documents from ScrapMaterialDocuments for entries that have them
    if (entries.length) {
      const ids = entries.map(e => e.ScrapID);
      // Build parameterised IN list
      const docsReq = pool.request();
      const idParams = ids.map((id, i) => {
        docsReq.input(`sid${i}`, sql.Int, id);
        return `@sid${i}`;
      }).join(',');

      const docsR = await docsReq.query(`
        SELECT ScrapID, MaterialDocument, IsReversed, ReversalDocument
        FROM   prod.ScrapMaterialDocuments
        WHERE  ScrapID IN (${idParams})
        ORDER  BY ScrapDocumentID
      `);

      // Group by ScrapID
      const docMap = {};
      for (const d of docsR.recordset) {
        if (!docMap[d.ScrapID]) docMap[d.ScrapID] = [];
        docMap[d.ScrapID].push({
          materialDocument: d.MaterialDocument,
          isReversed:       d.IsReversed,
          reversalDocument: d.ReversalDocument,
        });
      }

      for (const entry of entries) {
        entry.materialDocuments = docMap[entry.ScrapID] || [];
      }
    }

    res.json({ success: true, data: entries });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Portal users lookup (for operator search) ─────────────────────────────────

router.get('/users', async (req, res) => {
  const { q } = req.query;
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('q', sql.NVarChar(80), `%${q || ''}%`)
      .query(`SELECT UserID, Username,
                     ISNULL(FirstName,'') AS FirstName,
                     ISNULL(LastName,'')  AS LastName,
                     CASE
                       WHEN FirstName IS NOT NULL AND LastName IS NOT NULL
                       THEN FirstName + N' ' + LastName
                       ELSE Username
                     END AS DisplayName
              FROM Nexus.dbo.PortalUsers
              WHERE IsActive=1
                AND (Username   LIKE @q
                  OR FirstName  LIKE @q
                  OR LastName   LIKE @q
                  OR (FirstName + N' ' + LastName) LIKE @q)
              ORDER BY DisplayName`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── MIXING — immediate entry + SAP backflush ──────────────────────────────────

router.post('/mixing/entry', async (req, res) => {
  const { mixCode, supplierBatchNo, supplierTubNo, tubs, notes } = req.body;
  const supplierBatch = String(supplierBatchNo || '').trim();
  const supplierTub   = String(supplierTubNo   || '').trim();

  if (!mixCode || !Array.isArray(tubs) || !tubs.length)
    return res.status(400).json({ success: false, error: 'mixCode and at least one tub are required.' });
  if (!supplierBatch || !supplierTub)
    return res.status(400).json({ success: false, error: 'Supplier batch number and supplier tub number are required.' });
  if (tubs.some(t => {
    const weightKG = Number(t.weightKG);
    return !Number.isFinite(weightKG) || weightKG <= 0 || weightKG > 38;
  }))
    return res.status(400).json({ success: false, error: 'Each tub weight must be greater than 0 and no more than 38 KG.' });

  const pool    = await getNexusOperationsPool();
  const uid     = userId(req);
  const shiftID = currentShiftID();
  const totalWeightKG = tubs.reduce((s, t) => s + Number(t.weightKG || 0), 0);

  const dup = await pool.request()
    .input('sbn', sql.NVarChar(50), supplierBatch)
    .input('stn', sql.NVarChar(20), supplierTub)
    .query(`SELECT TOP 1 MixingID, MixRef
            FROM   prod.Mixing
            WHERE  LTRIM(RTRIM(SupplierBatchNo)) = @sbn
              AND  LTRIM(RTRIM(SupplierTubNo))   = @stn
            ORDER BY MixingID DESC`);
  if (dup.recordset.length) {
    const ref = dup.recordset[0].MixRef || `MX${String(dup.recordset[0].MixingID).padStart(8, '0')}`;
    return res.status(409).json({
      success: false,
      error: `Backflush aborted. Supplier batch ${supplierBatch} and tub ${supplierTub} have already been used on ${ref}. Please check the tub details.`,
    });
  }

  try { await assertProfitCentre('MX', mixCode); }
  catch (err) { return res.status(err.statusCode || 502).json({ success: false, error: err.message }); }

  // 1. Insert Mixing parent record — set to SAP_FAILED (6) if any tub fails below
  const ins = await pool.request()
    .input('shift', sql.TinyInt,           shiftID)
    .input('mat',   sql.NVarChar(18),      mixCode)
    .input('mc',    sql.NVarChar(18),      mixCode)
    .input('wt',    sql.Decimal(12,3),     totalWeightKG)
    .input('sbn',   sql.NVarChar(50),      supplierBatch)
    .input('stn',   sql.NVarChar(20),      supplierTub)
    .input('uid',   sql.Int,               uid)
    .input('notes', sql.NVarChar(sql.MAX), notes || null)
    .query(`INSERT INTO prod.Mixing
              (ShiftID,Material,MixCode,TotalWeightKG,SupplierBatchNo,SupplierTubNo,Status,StartedAt,CompletedAt,CreatedByUserID,Notes)
            OUTPUT INSERTED.MixingID
            VALUES (@shift,@mat,@mc,@wt,@sbn,@stn,4,GETDATE(),GETDATE(),@uid,@notes)`);

  const mixingID = ins.recordset[0].MixingID;

  await pool.request()
    .input('rid', sql.Int, mixingID).input('uid', sql.Int, uid)
    .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES ('MX',@rid,@uid,1,@uid)`);

  await writeEvent(pool, 'MX', mixingID, 'STARTED',
    `Mixing record created: ${mixCode} — ${totalWeightKG.toFixed(3)} KG across ${tubs.length} tub(s)`, 0, uid);

  // 2. Insert each tub and post individually to SAP
  let anyFailed = false;
  const tubResults = [];

  for (let i = 0; i < tubs.length; i++) {
    const t = tubs[i];
    const tubWeightKG = Number(t.weightKG || 0);

    const tubIns = await pool.request()
      .input('mid', sql.Int,           mixingID)
      .input('seq', sql.Int,           i + 1)
      .input('stn', sql.NVarChar(20),  supplierTub)
      .input('wt',  sql.Decimal(10,3), tubWeightKG)
      .query(`INSERT INTO prod.MixingTubs (MixingID,TubSeq,SupplierTubNo,TubWeightKG)
              OUTPUT INSERTED.TubID VALUES (@mid,@seq,@stn,@wt)`);
    const tubID = tubIns.recordset[0].TubID;

    const mixRef = `MX${String(mixingID).padStart(8, '0')}`;
    try {
      const sapRaw = await sapPost('/api/production/backflush', {
        Material:  mixCode,
        Quantity:  tubWeightKG,
        Header:    mixRef,
        Packaging: '',
        Charge:    supplierBatch,
        Customer:  '',
      });
      const { documentNumber: sapMatDoc, messageNumber, message } = parseSapBackflush(sapRaw);
      audit('SAP_OK', req.session?.user?.username, `'${mixRef}' BACKFLUSHED - Material Document = '${sapMatDoc}'`, req);

      if (messageNumber === '190') {
        await logBackflushAlert(pool, 'MX', mixingID, mixRef, sapMatDoc, messageNumber, message);
        await writeEvent(pool, 'MX', mixingID, 'NOTE',
          `SAP 190 tub ${i+1}: No component consumption — MatDoc: ${sapMatDoc}. Flagged for data review.`, 1, uid);
      }

      await pool.request()
        .input('tid', sql.Int,          tubID)
        .input('doc', sql.NVarChar(10), sapMatDoc)
        .query(`UPDATE prod.MixingTubs SET MaterialDocumentSAP=@doc, SAPSuccess=1 WHERE TubID=@tid`);

      await pool.request()
        .input('pc',  sql.NVarChar(5),   'MX').input('rid', sql.Int,          mixingID)
        .input('type',sql.NVarChar(20),  'BACKFLUSH').input('qty', sql.Decimal(12,3), tubWeightKG)
        .input('doc', sql.NVarChar(10),  sapMatDoc).input('uid', sql.Int,          uid)
        .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'KG',@doc,1,@uid)`);

      await writeEvent(pool, 'MX', mixingID, 'SAP_POST',
        `Tub ${i+1} posted — MatDoc: ${sapMatDoc} — ${tubWeightKG} KG${messageNumber === '190' ? ' (190: no components consumed)' : ''}`, 0, uid);

      tubResults.push({ tubID, tubSeq: i + 1, supplierTubNo: supplierTub, weightKG: tubWeightKG, materialDocument: sapMatDoc, success: true });

    } catch (sapErr) {
      anyFailed = true;
      const d = sapErr.response?.data;
      const errMsg = (typeof d === 'string' ? d : null)
        || (typeof d?.error === 'string' ? d.error : d?.error?.message) || d?.message || d?.title
        || (d?.errors ? JSON.stringify(d.errors) : null)
        || sapErr.message;

      await pool.request()
        .input('tid', sql.Int,               tubID)
        .input('err', sql.NVarChar(sql.MAX), errMsg)
        .query(`UPDATE prod.MixingTubs SET SAPSuccess=0, SAPErrorMessage=@err WHERE TubID=@tid`);

      await pool.request()
        .input('pc',  sql.NVarChar(5),      'MX').input('rid',  sql.Int,              mixingID)
        .input('type',sql.NVarChar(20),     'BACKFLUSH').input('qty',  sql.Decimal(12,3),  tubWeightKG)
        .input('err', sql.NVarChar(sql.MAX), errMsg).input('uid',  sql.Int,              uid)
        .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,IsSuccess,ErrorMessage,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'KG',0,@err,@uid)`);

      audit('SAP_ERROR', req.session?.user?.username, `'${mixRef}' FAILED - Message = "${errMsg}"`, req);
      await writeEvent(pool, 'MX', mixingID, 'SAP_FAIL',
        `Tub ${i+1} (${supplierTub}) SAP failed: ${errMsg}`, 2, uid);

      tubResults.push({ tubID, tubSeq: i + 1, supplierTubNo: supplierTub, weightKG: tubWeightKG, error: errMsg, success: false });
    }
  }

  // 3. If any tub failed, mark Mixing as SAP_FAILED
  if (anyFailed) {
    await pool.request()
      .input('rid', sql.Int, mixingID)
      .query(`UPDATE prod.Mixing SET Status=6 WHERE MixingID=@rid`);

    const mixRef = `MX-${String(mixingID).padStart(8, '0')}`;
    getNexusPool().then(kPool => notify(kPool, {
      title:       'SAP Backflush Failed',
      body:        `${mixRef} (Mixing) had one or more tubs fail SAP posting.`,
      severity:    2,
      category:    'production',
      actionLabel: 'Open Queue',
      actionURL:   '/private/production-nexus.html',
      target:      { type: 'permission', value: 'PROD_SUPERVISOR' },
    })).catch(() => {});
  }

  res.status(201).json({
    success: true,
    data: {
      recordID: mixingID,
      mixingID,
      batchRef: `MX${String(mixingID).padStart(8, '0')}`,
      status: anyFailed ? 'SAP_FAILED' : 'COMPLETE',
      totalWeightKG,
      tubs: tubResults,
    },
    ...(anyFailed ? { warning: 'Some tubs failed SAP posting. See failed backflush queue.' } : {}),
  });
});

// ── BOM download & validation — CO / BR / CL / TW / DR ──────────────────────
// Live preview, used before a job record exists (building the checklist
// while still filling in the New Entry form / Drumming wizard). Replaces the
// old POST /drumming/bom, which was dead code from the UI's perspective and
// had a stale response shape (result.components / {material,description,
// quantityPer}) that never matched the real BomRow shape used everywhere
// else in this file.
router.get('/process/:processCode/bom-preview', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const material = String(req.query.material || '').trim();
  if (!BOM_VALIDATED_PROCESSES.has(code))
    return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });
  if (!material) return res.status(400).json({ success: false, error: 'material is required.' });
  try {
    const bomRows = await fetchBom(material);
    res.json({ success: true, data: bomRows });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
    res.status(502).json({ success: false, error: `BOM lookup failed: ${msg}` });
  }
});

// Persisted snapshot for an existing job — the LATEST batch (see
// persistBomSnapshot/latestBomSnapshot). Used once a draft/record exists
// (e.g. reopening Complete Run) so the checklist and validation re-render
// against what was actually saved, not a possibly-since-changed live BOM.
router.get('/process/:processCode/:recordID/bom', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const recordID = Number(req.params.recordID);
  if (!BOM_VALIDATED_PROCESSES.has(code))
    return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });
  try {
    const pool    = await getNexusOperationsPool();
    const bomRows = await latestBomSnapshot(pool, code, recordID);
    res.json({ success: true, data: bomRows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Re-downloads the BOM from SAP and appends a new snapshot batch — for when
// the real fix for a mismatch was correcting the BOM in SAP, not raising a
// concession. Never deletes the prior batch (see persistBomSnapshot) so the
// original creation-time snapshot stays intact for audit; the new batch
// becomes what validation uses going forward. Re-runs
// validateTraceabilityAgainstBom against the fresh rows so the caller can
// immediately see which problems (if any) the refresh resolved.
router.post('/process/:processCode/:recordID/bom/refresh', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const recordID = Number(req.params.recordID);
  if (!BOM_VALIDATED_PROCESSES.has(code))
    return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });
  try {
    const cfg  = processConfig(code);
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    const jobRow = await pool.request().input('id', sql.Int, recordID)
      .query(`SELECT Material FROM ${cfg.table} WHERE ${cfg.pk} = @id`);
    const material = jobRow.recordset[0]?.Material;
    if (!material) return res.status(404).json({ success: false, error: 'Job not found.' });

    const bomRows = await fetchBom(material);
    await persistBomSnapshot(pool, code, recordID, material, bomRows);
    await writeEvent(pool, code, recordID, 'NOTE',
      `BOM re-downloaded from SAP (refresh) — ${bomRows.length} component(s).`, 0, uid);

    const traceRows = await pool.request()
      .input('cc', sql.NVarChar(5), code).input('cr', sql.Int, recordID)
      .query(`SELECT ParentProcessCode AS processCode, ParentRecordID AS recordID
              FROM prod.ProductionTrace WHERE ChildProcessCode=@cc AND ChildRecordID=@cr`);
    const problems = await validateTraceabilityAgainstBom(pool, traceRows.recordset, bomRows);

    res.json({ success: true, data: { bomRows, problems } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// The parent-batch links already saved against a job — used by the
// Complete Run wizard's read-only Traceability Check step to re-render the
// BOM checklist for a job whose batches were linked back at draft time
// (this endpoint isn't scoped to BOM_VALIDATED_PROCESSES since it's just a
// plain read of prod.ProductionTrace, useful for any process code).
router.get('/process/:processCode/:recordID/trace', async (req, res) => {
  try {
    const code     = req.params.processCode.toUpperCase();
    const recordID = Number(req.params.recordID);
    const pool     = await getNexusOperationsPool();
    const r = await pool.request()
      .input('cc', sql.NVarChar(5), code).input('cr', sql.Int, recordID)
      .query(`SELECT ParentProcessCode AS processCode, ParentRecordID AS recordID, ParentTubID AS tubID
              FROM prod.ProductionTrace WHERE ChildProcessCode=@cc AND ChildRecordID=@cr`);
    res.json({ success: true, data: r.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Raw-material batch numbers (hand-written, no resolving) ─────────────────
// For BOM components at profit centre RAW_MATERIAL_PROFIT_CENTRE — bought
// in, never produced by any Normanton-Nexus process, so there's no portal
// record to link against (see validateRawMaterialBatches above). These
// three routes let a job's raw-material batches be added to/listed/removed
// after the job already exists (draft/submitDrumming persist whatever was
// entered in the New Entry form/Drumming wizard directly, in the same
// request — see persistRawMaterialBatches).

router.get('/process/:processCode/:recordID/raw-material-batches', async (req, res) => {
  try {
    const code     = req.params.processCode.toUpperCase();
    const recordID = Number(req.params.recordID);
    const pool     = await getNexusOperationsPool();
    const r = await pool.request()
      .input('pc', sql.NVarChar(5), code).input('rid', sql.Int, recordID)
      .query(`SELECT BatchID AS batchID, Material AS material, BatchNumber AS batchNumber
              FROM prod.RawMaterialBatches WHERE ProcessCode=@pc AND RecordID=@rid ORDER BY LinkedAt`);
    res.json({ success: true, data: r.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/process/:processCode/:recordID/raw-material-batch', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const recordID = Number(req.params.recordID);
  if (!BOM_VALIDATED_PROCESSES.has(code))
    return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });

  const { material, batchNumber } = req.body;
  if (!material || !String(batchNumber || '').trim())
    return res.status(400).json({ success: false, error: 'material and batchNumber are required.' });

  try {
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);
    await persistRawMaterialBatches(pool, code, recordID, uid, [{ material, batchNumber }]);
    await writeEvent(pool, code, recordID, 'NOTE', `Raw material batch recorded for ${material}: ${String(batchNumber).trim()}`, 0, uid);
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

router.delete('/process/:processCode/:recordID/raw-material-batch/:batchID', async (req, res) => {
  try {
    const pool    = await getNexusOperationsPool();
    const batchID = Number(req.params.batchID);
    const upd = await pool.request().input('id', sql.Int, batchID)
      .query(`DELETE FROM prod.RawMaterialBatches WHERE BatchID=@id`);
    if (!upd.rowsAffected[0]) return res.status(404).json({ success: false, error: 'Batch entry not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Traceability Concessions — Production raises, Quality approves ──────────
// Modeled on the existing scrap-approval flow (POST /scrap/approve below):
// raise a pending row, notify the approver role, separate gated
// approve/reject endpoints. See unresolvedProblems/buildActualComponentList
// above for how an APPROVED concession actually unblocks and reroutes a
// job's SAP posting.

router.post('/process/:processCode/:recordID/concession', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const recordID = Number(req.params.recordID);
  if (!BOM_VALIDATED_PROCESSES.has(code))
    return res.status(400).json({ success: false, error: `${code} is not handled by this endpoint.` });

  const { parentProcessCode, parentRecordID, component, actualMaterial, quantity, reason } = req.body;
  if (!parentProcessCode || !parentRecordID || !component || !actualMaterial || !String(reason || '').trim())
    return res.status(400).json({ success: false, error: 'parentProcessCode, parentRecordID, component, actualMaterial and reason are required.' });

  try {
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);
    const ppc  = parentProcessCode.toUpperCase();

    const existing = await pool.request()
      .input('pc', sql.NVarChar(5), code).input('rid', sql.Int, recordID)
      .input('ppc', sql.NVarChar(5), ppc).input('prid', sql.Int, Number(parentRecordID))
      .query(`SELECT TOP 1 ConcessionID FROM prod.TraceabilityConcessions
              WHERE ProcessCode=@pc AND RecordID=@rid AND ParentProcessCode=@ppc AND ParentRecordID=@prid AND Status IN (N'PENDING', N'APPROVED')`);
    if (existing.recordset.length)
      return res.status(409).json({ success: false, error: 'A concession for this link is already pending or approved.' });

    const ins = await pool.request()
      .input('pc',     sql.NVarChar(5),   code)
      .input('rid',     sql.Int,           recordID)
      .input('ppc',     sql.NVarChar(5),   ppc)
      .input('prid',    sql.Int,           Number(parentRecordID))
      .input('comp',    sql.NVarChar(18),  component)
      .input('mat',     sql.NVarChar(18),  actualMaterial)
      .input('qty',     sql.Decimal(12,4), quantity != null && quantity !== '' ? Number(quantity) : null)
      .input('reason',  sql.NVarChar(500), String(reason).trim())
      .input('uid',     sql.Int,           uid)
      .query(`INSERT INTO prod.TraceabilityConcessions
                (ProcessCode,RecordID,ParentProcessCode,ParentRecordID,Component,ActualMaterial,Quantity,Reason,RaisedByUserID)
              OUTPUT INSERTED.ConcessionID
              VALUES (@pc,@rid,@ppc,@prid,@comp,@mat,@qty,@reason,@uid)`);
    const concessionID = ins.recordset[0].ConcessionID;

    await writeEvent(pool, code, recordID, 'NOTE',
      `Traceability concession raised for ${ppc}${String(parentRecordID).padStart(8, '0')} (${component} → ${actualMaterial}): ${reason}`, 1, uid);

    const batchRef = `${code}${String(recordID).padStart(8, '0')}`;
    const username = req.session?.user?.username || `user #${uid}`;
    getNexusPool().then(kPool => notify(kPool, {
      title:       'Traceability Concession Raised',
      body:        `${batchRef} — ${component} traceability shows ${actualMaterial} instead. Raised by ${username}: ${reason}`,
      severity:    1,
      category:    'quality',
      actionLabel: 'Review Concession',
      actionURL:   '/private/quality.html',
      target:      { type: 'permission', value: 'QUAL_CONCESSION' },
    })).catch(() => {});

    res.status(201).json({ success: true, data: { concessionID } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

router.get('/concessions', requirePermission('QUAL_CONCESSION'), async (req, res) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const pool   = await getNexusOperationsPool();
    const r = await pool.request().input('status', sql.NVarChar(20), status)
      .query(`SELECT c.*, pu.Username AS RaisedByUsername, ru.Username AS ReviewedByUsername
              FROM prod.TraceabilityConcessions c
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = c.RaisedByUserID
              LEFT JOIN Nexus.dbo.PortalUsers ru ON ru.UserID = c.ReviewedByUserID
              WHERE c.Status = @status
              ORDER BY c.RaisedAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

async function reviewConcession(req, res, status) {
  const id    = Number(req.params.id);
  const notes = String(req.body?.notes || '').trim();
  try {
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    const cur = await pool.request().input('id', sql.Int, id)
      .query(`SELECT * FROM prod.TraceabilityConcessions WHERE ConcessionID=@id`);
    const row = cur.recordset[0];
    if (!row) return res.status(404).json({ success: false, error: 'Concession not found.' });
    if (row.Status !== 'PENDING')
      return res.status(409).json({ success: false, error: `This concession is already ${row.Status.toLowerCase()}.` });

    await pool.request()
      .input('id', sql.Int, id).input('status', sql.NVarChar(20), status)
      .input('uid', sql.Int, uid).input('notes', sql.NVarChar(500), notes || null)
      .query(`UPDATE prod.TraceabilityConcessions
              SET Status=@status, ReviewedByUserID=@uid, ReviewedAt=GETDATE(), ReviewNotes=@notes
              WHERE ConcessionID=@id`);

    await writeEvent(pool, row.ProcessCode, row.RecordID, 'NOTE',
      `Traceability concession ${status.toLowerCase()} for ${row.ParentProcessCode}${String(row.ParentRecordID).padStart(8, '0')}${notes ? ` — ${notes}` : ''}`, 1, uid);

    const batchRef = `${row.ProcessCode}${String(row.RecordID).padStart(8, '0')}`;
    const raiser = await pool.request().input('id', sql.Int, row.RaisedByUserID)
      .query(`SELECT Username FROM Nexus.dbo.PortalUsers WHERE UserID=@id`);
    const raiserUsername = raiser.recordset[0]?.Username;

    if (raiserUsername) {
      getNexusPool().then(kPool => notify(kPool, {
        title:       status === 'APPROVED' ? 'Concession Approved' : 'Concession Rejected',
        body:        `${batchRef} — your concession for ${row.Component} was ${status.toLowerCase()}${notes ? `: ${notes}` : '.'}`,
        severity:    status === 'APPROVED' ? 0 : 2,
        category:    'production',
        actionLabel: 'Open Batch',
        actionURL:   '/private/production-nexus.html',
        target:      { type: 'user', value: raiserUsername },
      })).catch(() => {});
    }

    res.json({ success: true, data: { concessionID: id, status } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
}

router.post('/concessions/:id/approve', requirePermission('QUAL_CONCESSION'), (req, res) => reviewConcession(req, res, 'APPROVED'));
router.post('/concessions/:id/reject',  requirePermission('QUAL_CONCESSION'), (req, res) => reviewConcession(req, res, 'REJECTED'));

// ── DRUMMING — full wizard submission + SAP backflush ────────────────────────

router.post('/drumming/entry', async (req, res) => {
  const {
    material, shiftID,
    parentBatches = [],                        // traceability — [{processCode, recordID}]
    additionalOperatorIDs = [],
    packagingType, testPressurePSI,            // Phase 3
    coilLengths = [],                           // Phase 4: array of decimals
    hasScrap, scrapTotalKG, scrapReasons = [], // Phase 5: [{reasonID, occurrences}]
    salesOrderSAP, customerID, notes,          // Phase 6
  } = req.body;

  if (!material || !coilLengths.length)
    return res.status(400).json({ success: false, error: 'material and at least one coilLength are required.' });

  const pool = await getNexusOperationsPool();

  try { await assertParentBatchesReversed(pool, parentBatches); }
  catch (err) { return res.status(err.statusCode || 500).json({ success: false, error: err.message }); }

  try { await assertProfitCentre('DR', material); }
  catch (err) { return res.status(err.statusCode || 502).json({ success: false, error: err.message }); }

  const uid  = userId(req);
  const sid  = shiftID || currentShiftID();
  const totalLength = coilLengths.reduce((s, l) => s + Number(l), 0);

  // 1. Insert Drumming record
  const ins = await pool.request()
    .input('shift',  sql.TinyInt,    sid)
    .input('mat',    sql.NVarChar(18), material)
    .input('len',    sql.Decimal(12,3), totalLength)
    .input('pkg',    sql.NVarChar(3),  packagingType || null)
    .input('psi',    sql.Decimal(6,2), testPressurePSI ? Number(testPressurePSI) : null)
    .input('so',     sql.NVarChar(12), salesOrderSAP || null)
    .input('cust',   sql.NVarChar(50), customerID    || null)
    .input('uid',    sql.Int,          uid)
    .input('notes',  sql.NVarChar(sql.MAX), notes || null)
    .query(`INSERT INTO prod.Drumming
              (ShiftID,Material,LengthMetres,PackagingType,TestPressurePSI,SalesOrderSAP,
               CustomerID,Status,StartedAt,CompletedAt,CreatedByUserID,Notes)
            OUTPUT INSERTED.DrummingID
            VALUES (@shift,@mat,@len,@pkg,@psi,@so,@cust,4,GETDATE(),GETDATE(),@uid,@notes)`);

  const drummingID = ins.recordset[0].DrummingID;

  // 2. Insert coil lengths
  for (let i = 0; i < coilLengths.length; i++) {
    await pool.request()
      .input('did', sql.Int,           drummingID)
      .input('seq', sql.Int,           i + 1)
      .input('len', sql.Decimal(10,3), Number(coilLengths[i]))
      .query(`INSERT INTO prod.DrummingCoils (DrummingID,CoilSeq,LengthM) VALUES (@did,@seq,@len)`);
  }

  // 3. Primary operator + additional operators
  await pool.request()
    .input('rid', sql.Int, drummingID).input('uid', sql.Int, uid)
    .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES ('DR',@rid,@uid,1,@uid)`);
  for (const addUid of additionalOperatorIDs) {
    await pool.request()
      .input('rid', sql.Int, drummingID).input('uid', sql.Int, addUid).input('by', sql.Int, uid)
      .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES ('DR',@rid,@uid,0,@by)`);
  }

  // 4. Trace links to previous stages (one row per parent batch)
  for (const pb of parentBatches) {
    if (!pb.processCode || !pb.recordID) continue;
    await pool.request()
      .input('cc', sql.NVarChar(5), 'DR').input('cr', sql.Int, drummingID)
      .input('pc', sql.NVarChar(5), pb.processCode.toUpperCase()).input('pr', sql.Int, Number(pb.recordID))
      .input('uid', sql.Int, uid)
      .query(`INSERT INTO prod.ProductionTrace (ChildProcessCode,ChildRecordID,ParentProcessCode,ParentRecordID,LinkedByUserID) VALUES (@cc,@cr,@pc,@pr,@uid)`);
  }

  // 5. Scrap entries
  if (hasScrap && scrapTotalKG && scrapReasons.length) {
    const totalOccurrences = scrapReasons.reduce((s, r) => s + Number(r.occurrences || 0), 0);
    for (const { reasonID, occurrences } of scrapReasons) {
      const share = totalOccurrences > 0 ? Number(occurrences) / totalOccurrences : 1;
      const scrapQty = Math.round(Number(scrapTotalKG) * share * 1000) / 1000;
      await pool.request()
        .input('pc',  sql.NVarChar(5),   'DR').input('rid', sql.Int, drummingID)
        .input('rid2',sql.Int,           Number(reasonID))
        .input('qty', sql.Decimal(12,3), scrapQty)
        .input('uid', sql.Int,           uid)
        .query(`INSERT INTO prod.ScrapEntries (ProcessCode,ProcessRecordID,ReasonID,Quantity,UnitOfMeasure,EnteredByUserID) VALUES (@pc,@rid,@rid2,@qty,'KG',@uid)`);
    }
    await writeEvent(pool, 'DR', drummingID, 'SCRAP', `Scrap recorded: ${scrapTotalKG} KG across ${scrapReasons.length} reason(s)`, 1, uid);
  }

  await writeEvent(pool, 'DR', drummingID, 'STARTED', `Drumming record created: ${material} ${totalLength.toFixed(3)} M`, 0, uid);

  // 6. SAP backflush via ZF40N
  const drumRef = `DR-${String(drummingID).padStart(8, '0')}`;
  try {
    const sapRaw = await sapPost('/api/production/backflush', {
      Material:  material,
      Quantity:  totalLength,
      Header:    drumRef,
      Packaging: packagingType || '',
      Charge:    '',
      Customer:  customerID || '',
    });

    const { documentNumber: sapMatDoc, messageNumber, message } = parseSapBackflush(sapRaw);
    audit('SAP_OK', req.session?.user?.username, `'${drumRef}' BACKFLUSHED - Material Document = '${sapMatDoc}'`, req);

    // 190 = posted but no component consumption — flag for data analyst review
    if (messageNumber === '190') {
      await logBackflushAlert(pool, 'DR', drummingID, drumRef, sapMatDoc, messageNumber, message);
      await writeEvent(pool, 'DR', drummingID, 'NOTE',
        `SAP 190: No component consumption — MatDoc: ${sapMatDoc}. Flagged for data review.`, 1, uid);
    }

    await pool.request()
      .input('pc',  sql.NVarChar(5),   'DR').input('rid', sql.Int, drummingID)
      .input('type',sql.NVarChar(20),  'BACKFLUSH')
      .input('qty', sql.Decimal(12,3), totalLength)
      .input('doc', sql.NVarChar(10),  sapMatDoc)
      .input('uid', sql.Int,           uid)
      .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',@doc,1,@uid)`);

    await writeEvent(pool, 'DR', drummingID, 'SAP_POST',
      `Backflush posted — MatDoc: ${sapMatDoc}${messageNumber === '190' ? ' (190: no components consumed)' : ''}`, 0, uid);

    res.status(201).json({
      success: true,
      data: {
        drummingID, materialDocument: sapMatDoc, status: 'COMPLETE',
        ...(messageNumber === '190' ? { warning: 'SAP 190: posted but no components consumed — flagged for data review.' } : {}),
      },
    });

  } catch (sapErr) {
    await pool.request()
      .input('rid', sql.Int, drummingID)
      .query(`UPDATE prod.Drumming SET Status=6 WHERE DrummingID=@rid`);

    const errMsg = sapErr.response?.data?.error?.message || sapErr.response?.data?.error || sapErr.message;
    audit('SAP_ERROR', req.session?.user?.username, `'${drumRef}' FAILED - Message = "${errMsg}"`, req);

    await pool.request()
      .input('pc',  sql.NVarChar(5),'DR').input('rid',sql.Int,drummingID)
      .input('type',sql.NVarChar(20),'BACKFLUSH').input('qty',sql.Decimal(12,3),totalLength)
      .input('err', sql.NVarChar(sql.MAX),errMsg).input('uid',sql.Int,uid)
      .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,IsSuccess,ErrorMessage,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',0,@err,@uid)`);

    await writeEvent(pool, 'DR', drummingID, 'SAP_FAIL', `SAP backflush failed: ${errMsg}`, 2, uid);

    res.status(201).json({
      success: true,
      data: { drummingID, status: 'SAP_FAILED', error: errMsg },
      warning: 'Record saved but SAP backflush failed. See failed backflush queue.',
    });
  }
});


// ── DRUMMING — Make-to-Stock / Make-to-Order submissions ─────────────────────
// Both endpoints share the same DB logic; only the SAP endpoint differs.

async function submitDrumming(req, res, entryType) {
  const {
    material, shiftID,
    customerNumber, orderNumber, orderItem,
    packagingID, weightKG,
    parentBatches = [],
    rawMaterialBatches = [],
    coilLengths = [],
    hasScrap, scrapTotalKG, scrapReasons = [],
    comments,
  } = req.body;

  const MAX_COIL_LENGTHS = 1000;

  if (!Array.isArray(coilLengths))
    return res.status(400).json({ success: false, error: 'coilLengths must be an array.' });

  if (coilLengths.length === 0 || coilLengths.length > MAX_COIL_LENGTHS)
    return res.status(400).json({ success: false, error: `coilLengths must contain between 1 and ${MAX_COIL_LENGTHS} items.` });

  if (!material || !packagingID || !weightKG)
    return res.status(400).json({ success: false, error: 'material, packagingID, weightKG and at least one coilLength are required.' });

  const pool = await getNexusOperationsPool();

  try { await assertParentBatchesReversed(pool, parentBatches); }
  catch (err) { return res.status(err.statusCode || 500).json({ success: false, error: err.message }); }

  try { await assertProfitCentre('DR', material); }
  catch (err) { return res.status(err.statusCode || 502).json({ success: false, error: err.message }); }
  const uid  = userId(req);
  const sid  = shiftID || currentShiftID();
  const totalLength = coilLengths.reduce((s, l) => s + Number(l), 0);

  const ins = await pool.request()
    .input('shift', sql.TinyInt,           sid)
    .input('mat',   sql.NVarChar(18),      material)
    .input('len',   sql.Decimal(12,3),     totalLength)
    .input('wt',    sql.Decimal(12,3),     Number(weightKG))
    .input('pkg',   sql.NVarChar(10),      packagingID)
    .input('cust',  sql.NVarChar(50),      customerNumber || null)
    .input('so',    sql.NVarChar(20),      orderNumber    || null)
    .input('item',  sql.NVarChar(6),       orderItem      || null)
    .input('etype', sql.NVarChar(10),      entryType)
    .input('uid',   sql.Int,               uid)
    .input('notes', sql.NVarChar(sql.MAX), comments || null)
    .query(`INSERT INTO prod.Drumming
              (ShiftID,Material,LengthMetres,WeightKG,PackagingType,CustomerID,SalesOrderSAP,OrderItem,
               EntryType,Status,StartedAt,CompletedAt,CreatedByUserID,Notes)
            OUTPUT INSERTED.DrummingID
            VALUES (@shift,@mat,@len,@wt,@pkg,@cust,@so,@item,@etype,4,GETDATE(),GETDATE(),@uid,@notes)`);

  const drummingID = ins.recordset[0].DrummingID;

  // Download and save the BOM into the job the moment its material is known
  // (Drumming has no separate draft step — this is the earliest point a
  // record/recordID exists to save it against). A failed lookup here isn't
  // fatal to record creation — it just means the pre-backflush block below
  // treats every traceability link as unverifiable and blocks on it, same
  // as any other BOM-lookup failure.
  let drBomRows = [];
  try {
    drBomRows = await fetchBom(material);
    await persistBomSnapshot(pool, 'DR', drummingID, material, drBomRows);
  } catch (err) {
    await writeEvent(pool, 'DR', drummingID, 'NOTE', `BOM download failed: ${err.message}`, 1, uid).catch(() => {});
  }

  for (let i = 0; i < coilLengths.length; i++) {
    await pool.request()
      .input('did', sql.Int,           drummingID)
      .input('seq', sql.Int,           i + 1)
      .input('len', sql.Decimal(10,3), Number(coilLengths[i]))
      .query(`INSERT INTO prod.DrummingCoils (DrummingID,CoilSeq,LengthM) VALUES (@did,@seq,@len)`);
  }

  await pool.request()
    .input('rid', sql.Int, drummingID).input('uid', sql.Int, uid)
    .query(`INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES ('DR',@rid,@uid,1,@uid)`);

  for (const pb of parentBatches) {
    if (!pb.processCode || !pb.recordID) continue;
    await pool.request()
      .input('cc', sql.NVarChar(5), 'DR').input('cr', sql.Int, drummingID)
      .input('pc', sql.NVarChar(5), pb.processCode.toUpperCase()).input('pr', sql.Int, Number(pb.recordID))
      .input('uid', sql.Int, uid)
      .query(`INSERT INTO prod.ProductionTrace (ChildProcessCode,ChildRecordID,ParentProcessCode,ParentRecordID,LinkedByUserID) VALUES (@cc,@cr,@pc,@pr,@uid)`);
  }

  await persistRawMaterialBatches(pool, 'DR', drummingID, uid, rawMaterialBatches);

  if (hasScrap && scrapTotalKG && scrapReasons.length) {
    const totalOcc = scrapReasons.reduce((s, r) => s + Number(r.occurrences || 0), 0);
    for (const { reasonID, occurrences } of scrapReasons) {
      const share    = totalOcc > 0 ? Number(occurrences) / totalOcc : 1;
      const scrapQty = Math.round(Number(scrapTotalKG) * share * 1000) / 1000;
      await pool.request()
        .input('pc',  sql.NVarChar(5),   'DR').input('rid', sql.Int, drummingID)
        .input('rid2',sql.Int,           Number(reasonID))
        .input('qty', sql.Decimal(12,3), scrapQty)
        .input('uid', sql.Int,           uid)
        .query(`INSERT INTO prod.ScrapEntries (ProcessCode,ProcessRecordID,ReasonID,Quantity,UnitOfMeasure,EnteredByUserID) VALUES (@pc,@rid,@rid2,@qty,'KG',@uid)`);
    }
    await writeEvent(pool, 'DR', drummingID, 'SCRAP', `Scrap recorded: ${scrapTotalKG} KG across ${scrapReasons.length} reason(s)`, 1, uid);
  }

  await writeEvent(pool, 'DR', drummingID, 'STARTED', `Drumming (${entryType}) created: ${material} ${totalLength.toFixed(3)} M ${Number(weightKG)} KG`, 0, uid);

  const drumRef = `DR-${String(drummingID).padStart(8, '0')}`;

  // BOM-vs-traceability hard block — checked BEFORE any SAP posting at all
  // (including the braid-consumption backflush below), so a blocked
  // submission never partially posts to SAP. Re-reads the actual linked
  // parents fresh from prod.ProductionTrace and the just-persisted BOM
  // snapshot. An APPROVED concession clears its own specific mismatch;
  // anything still unresolved blocks the whole submission — this replaces
  // the old post-hoc, never-blocking bomMismatch check further below (kept
  // in place as defense-in-depth; it should now rarely fire).
  const drTraceRows = await pool.request()
    .input('cc', sql.NVarChar(5), 'DR').input('cr', sql.Int, drummingID)
    .query(`SELECT ParentProcessCode AS processCode, ParentRecordID AS recordID
            FROM prod.ProductionTrace WHERE ChildProcessCode=@cc AND ChildRecordID=@cr`);

  const drProblems = await validateTraceabilityAgainstBom(pool, drTraceRows.recordset, drBomRows);
  const drBlocking = await unresolvedProblems(pool, 'DR', drummingID, drProblems);
  const drRawProblems = await validateRawMaterialBatches(pool, 'DR', drummingID, drBomRows);

  if (drBlocking.length || drRawProblems.length) {
    const errMsg = `Blocked: ${[...drBlocking, ...drRawProblems].map(p => p.reason).join(' ')}${drBlocking.length ? ' Raise a concession from the traceability screen, or use "Refresh BOM" if SAP\'s BOM has since been corrected.' : ''}`;
    await pool.request().input('rid', sql.Int, drummingID).query(`UPDATE prod.Drumming SET Status=6 WHERE DrummingID=@rid`);
    await writeEvent(pool, 'DR', drummingID, 'SAP_FAIL', errMsg, 2, uid);
    return res.status(409).json({ success: false, data: { drummingID, batchRef: drumRef, status: 'BLOCKED' }, error: errMsg });
  }
  const drConcessions = drProblems.length ? await approvedConcessions(pool, 'DR', drummingID) : [];

  try {
    // Resolve what each traceability link the operator entered actually
    // points at (see resolveTraceabilityMaterials above) — SapServer needs
    // the real materials to check against this drum's BOM, not the portal
    // process-code/record-id references stored in prod.ProductionTrace.
    const traceMaterials = await resolveTraceabilityMaterials(pool, parentBatches);

    // Backflush any braided (BR) traceability parents FIRST — braiding
    // never posts its own SAP backflush, so this drum's own backflush
    // below can't rely on that stock already existing (see
    // backflushBraidedComponents above). A failure here throws, which is
    // caught by the same catch block below as a drumming-backflush
    // failure — deliberately: don't post the drum's own backflush if the
    // raw material it consumed couldn't be accounted for in SAP.
    const braidConsumption = await backflushBraidedComponents(pool, uid, material, totalLength, parentBatches);
    if (braidConsumption.length) {
      const summary = braidConsumption.map(b => `${b.braidRef} (${b.qty.toFixed(3)} M, MatDoc ${b.documentNumber})`).join(', ');
      await writeEvent(pool, 'DR', drummingID, 'NOTE', `Backflushed braided component(s) before drum backflush: ${summary}.`, 0, uid);

      // The ProductionTrace link rows for all parents were already inserted
      // unconditionally above; fill in the consumed quantity and the SAP
      // document it was posted under for just the BR ones now that it's
      // known. MaterialDocumentSAP is what lets redrumReversal.js find and
      // reverse this exact braid backflush later if the drum gets reversed
      // — without it, there'd be no reliable way to tell which of possibly
      // several postings against the same braid batch belonged to this drum.
      for (const b of braidConsumption) {
        await pool.request()
          .input('cc',  sql.NVarChar(5),   'DR').input('cr', sql.Int, drummingID)
          .input('pc',  sql.NVarChar(5),   'BR').input('pr', sql.Int, b.braidingID)
          .input('qty', sql.Decimal(12,3), b.qty)
          .input('doc', sql.NVarChar(10),  b.documentNumber || null)
          .query(`UPDATE prod.ProductionTrace SET QuantityConsumed=@qty, UnitOfMeasure='M', MaterialDocumentSAP=@doc
                  WHERE ChildProcessCode=@cc AND ChildRecordID=@cr AND ParentProcessCode=@pc AND ParentRecordID=@pr`);
      }
    }

    let sapMatDoc, sapBatch = null, messageNumber = null, message = '', rcBatch = null, rcPack = null;
    let bomMismatch = false, expectedComponents = [], actualComponents = [];
    let concessionApplied = false;

    if (drConcessions.length) {
      // Concession-covered — bypass the normal automatic BOM-driven
      // backflush entirely and post every component explicitly instead
      // (correct ones included) — see buildActualComponentList. Avoids the
      // automatic backflush also silently consuming the original wrong BOM
      // material on top of this explicit posting.
      const components = buildActualComponentList(drBomRows, drConcessions, totalLength);
      const gmRaw = await sapPost('/api/production/goods-movement-backflush', {
        Material: material, Header: drumRef, Components: components,
      });
      ({ documentNumber: sapMatDoc } = parseGoodsMovement(gmRaw));
      concessionApplied = true;
      audit('SAP_OK', req.session?.user?.username, `'${drumRef}' BACKFLUSHED (concession, goods movement) - Material Document = '${sapMatDoc}'`, req);

      await pool.request()
        .input('pc',  sql.NVarChar(5),   'DR').input('rid', sql.Int, drummingID)
        .input('type',sql.NVarChar(20),  'BACKFLUSH')
        .input('qty', sql.Decimal(12,3), totalLength)
        .input('doc', sql.NVarChar(10),  sapMatDoc)
        .input('uid', sql.Int,           uid)
        .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',@doc,1,@uid)`);

      await writeEvent(pool, 'DR', drummingID, 'SAP_POST',
        `Backflush posted via concession goods movement — MatDoc: ${sapMatDoc}. Components: ${components.map(c => `${c.Material} x${c.Quantity}`).join(', ')}.`, 0, uid);

      for (const c of drConcessions) {
        await pool.request()
          .input('id', sql.Int, c.ConcessionID).input('doc', sql.NVarChar(10), sapMatDoc)
          .query(`UPDATE prod.TraceabilityConcessions SET AppliedAt=GETDATE(), MaterialDocumentSAP=@doc WHERE ConcessionID=@id`);
      }
    } else {
      const sapRaw = await sapPost('/api/production/drumming-backflush', {
        Material:              material,
        Quantity:              totalLength,
        Header:                drumRef,
        Customer:              customerNumber || '',
        PackCode:              packagingID,
        WeightKG:              Number(weightKG),
        TraceabilityMaterials: traceMaterials,
      });

      ({
        documentNumber: sapMatDoc, batch: sapBatch, rcBatch, rcPack,
        messageNumber, message, bomMismatch, expectedComponents, actualComponents,
      } = parseDrumBackflush(sapRaw));
      audit('SAP_OK', req.session?.user?.username, `'${drumRef}' BACKFLUSHED - Material Document = '${sapMatDoc}'${sapBatch ? ` - Batch = '${sapBatch}'` : ''}`, req);

      if (messageNumber === '190') {
        await logBackflushAlert(pool, 'DR', drummingID, drumRef, sapMatDoc, messageNumber, message);
        await writeEvent(pool, 'DR', drummingID, 'NOTE',
          `SAP 190: No component consumption — MatDoc: ${sapMatDoc}. Flagged for data review.`, 1, uid);
      }

      await pool.request()
        .input('pc',  sql.NVarChar(5),   'DR').input('rid', sql.Int, drummingID)
        .input('type',sql.NVarChar(20),  'BACKFLUSH')
        .input('qty', sql.Decimal(12,3), totalLength)
        .input('doc', sql.NVarChar(10),  sapMatDoc)
        .input('batch',sql.NVarChar(10), sapBatch || null)
        .input('uid', sql.Int,           uid)
        .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,SAPBatchNumber,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',@doc,@batch,1,@uid)`);

      await writeEvent(pool, 'DR', drummingID, 'SAP_POST',
        `Backflush posted — MatDoc: ${sapMatDoc}${sapBatch ? `, Batch: ${sapBatch}` : ''}${messageNumber === '190' ? ' (190: no components consumed)' : ''}${rcBatch && rcBatch !== '0' ? ` — Z_ZPRODBATCH_MAINT RC_BATCH=${rcBatch}` : ''}${rcPack && rcPack !== '0' ? ` RC_PACK=${rcPack}` : ''}`, 0, uid);
    }

    // BOM vs traceability mismatch — defense-in-depth only now that the
    // pre-backflush hard block above catches this before SAP is ever
    // called; kept here (never blocks, by design) in case SapServer's own
    // internal check catches something this portal-side check couldn't.
    // Never fires for the concession path above, which doesn't call
    // drumming-backflush (and therefore SapServer's own internal check) at
    // all — bomMismatch stays false in that branch.
    let bomWarning;
    if (bomMismatch) {
      const expectedText = expectedComponents?.length ? expectedComponents.join(', ') : '(no components found)';
      const actualText   = actualComponents?.length   ? actualComponents.join(', ')   : '(none)';
      const username     = req.session?.user?.username || `user #${uid}`;
      bomWarning = `Traceability does not match this material's BOM — expected ${expectedText}, traceability shows ${actualText}.`;

      await writeEvent(pool, 'DR', drummingID, 'NOTE',
        `BOM mismatch: backflushed ${material}, BOM expects ${expectedText}, traceability shows ${actualText} (entered by ${username}).`, 2, uid);

      getNexusPool().then(kPool => notify(kPool, {
        title:       'Drumming traceability does not match BOM',
        body:        `${drumRef} backflushed ${material} — BOM expects ${expectedText}, but traceability shows ${actualText}. Entered by ${username}.`,
        severity:    2,
        category:    'production',
        actionLabel: 'Open Queue',
        actionURL:   '/private/production-nexus.html',
        target:      { type: 'permission', value: 'PROD_SUPERVISOR' },
      })).catch(() => {});
    }

    // Locally patch the AgreementSnapshot row's dock-stock figure so the
    // Required quantity operators see on Order Lookup / the Production
    // Schedule report reflects this drum immediately, rather than waiting
    // for the next 30-min sync. Targeted UPDATE, not a separate overlay
    // table — self-healing regardless of outcome, since the next sync
    // overwrites this row with fresh SAP truth either way.
    //
    // orderNumber/orderItem here are whatever the operator picked from
    // /order-lookup — now OriginalDoc/OriginalDocItem-sourced (see
    // AGREEMENT_LOOKUP_COLUMNS above), so match on those same columns
    // rather than the raw ReferenceDocument/Item, which may already have
    // flipped to a delivery number for this line by the time the drum is
    // posted.
    let stockSyncWarning;
    if (entryType === 'customer' && orderNumber && orderItem) {
      try {
        await pool.request()
          .input('ref',  sql.NVarChar(10),  orderNumber)
          .input('item', sql.NVarChar(6),   orderItem)
          .input('qty',  sql.Decimal(15,3), totalLength)
          .query(`
            UPDATE log.AgreementSnapshot
            SET DockStockAllocated = ISNULL(DockStockAllocated,0) + @qty
            WHERE OriginalDoc = @ref AND OriginalDocItem = @item`);
      } catch (err) {
        console.error('[drumming] local AgreementSnapshot stock patch failed', err.message);
        stockSyncWarning = 'Drum posted successfully, but the live order-schedule figure could not be refreshed immediately (it will catch up on the next sync).';
      }
    }

    const sapWarning = messageNumber === '190' ? 'SAP 190: posted but no components consumed — flagged for data review.' : null;

    return res.status(201).json({
      success: true,
      data: {
        drummingID, materialDocument: sapMatDoc, batch: sapBatch, bomMismatch: !!bomMismatch, status: 'COMPLETE',
        concessionApplied,
        ...((sapWarning || bomWarning || stockSyncWarning) ? { warning: [sapWarning, bomWarning, stockSyncWarning].filter(Boolean).join(' ') } : {}),
      },
    });

  } catch (sapErr) {
    await pool.request()
      .input('rid', sql.Int, drummingID)
      .query(`UPDATE prod.Drumming SET Status=6 WHERE DrummingID=@rid`);

    const errMsg = sapErr.response?.data?.error?.message || sapErr.response?.data?.error || sapErr.message;
    audit('SAP_ERROR', req.session?.user?.username, `'${drumRef}' FAILED - Message = "${errMsg}"`, req);

    await pool.request()
      .input('pc',  sql.NVarChar(5),'DR').input('rid',sql.Int,drummingID)
      .input('type',sql.NVarChar(20),'BACKFLUSH').input('qty',sql.Decimal(12,3),totalLength)
      .input('err', sql.NVarChar(sql.MAX),errMsg).input('uid',sql.Int,uid)
      .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,IsSuccess,ErrorMessage,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',0,@err,@uid)`);

    await writeEvent(pool, 'DR', drummingID, 'SAP_FAIL', `SAP backflush failed: ${errMsg}`, 2, uid);

    getNexusPool().then(kPool => notify(kPool, {
      title:       'SAP Backflush Failed',
      body:        `${drumRef} (Drumming) failed to post to SAP: ${errMsg}`,
      severity:    2,
      category:    'production',
      actionLabel: 'Open Queue',
      actionURL:   '/private/production-nexus.html',
      target:      { type: 'permission', value: 'PROD_SUPERVISOR' },
    })).catch(() => {});

    return res.status(201).json({
      success: true,
      data: { drummingID, status: 'SAP_FAILED', error: errMsg },
      warning: 'Record saved but SAP backflush failed. See failed backflush queue.',
    });
  }
}

router.post('/drumming/stock',    async (req, res) => { try { await submitDrumming(req, res, 'stock');    } catch (err) { res.status(500).json({ success: false, error: err.message }); } });
router.post('/drumming/customer', async (req, res) => { try { await submitDrumming(req, res, 'customer'); } catch (err) { res.status(500).json({ success: false, error: err.message }); } });


// ── Mixing — get tub weights and SAP postings for a record ───────────────────

router.get('/mixing/:mixingId/tubs', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('id', sql.Int, Number(req.params.mixingId))
      .query(`SELECT TubID, TubSeq, TubWeightKG,
                     MaterialDocumentSAP, SAPSuccess, SAPErrorMessage,
                     IsStaged, StagedAt, ConditioningTimeHours, StagedByUserID, StagedQuantityKG,
                     IsScrapped, ScrappedAt, ScrappedByUserID, ScrapReasonID, ScrapMaterialDocumentSAP, ScrapSAPErrorMessage,
                     ExpiryOverrideAt, ExpiryOverrideByUserID, ExpiryOverrideReason
              FROM   prod.MixingTubs
              WHERE  MixingID = @id
              ORDER BY TubSeq`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Billet staging — mix tub lifecycle (stage / return / expiry) ────────────
// Mix materials are not batch-managed in SAP; everything below is a
// Normanton-Nexus-only concept (staging status, "Conditioning Time", Billet
// balance) with no SAP counterpart to keep in sync — see validateMxTubLinks
// above for why.

const MX_AGE_HOURS_SQL  = `(DATEDIFF(MINUTE, m.CompletedAt, GETDATE()) / 60.0)`;
const MX_AGE_BUCKET_SQL = `CASE
    WHEN ${MX_AGE_HOURS_SQL} > 96 THEN N'expired'
    WHEN ${MX_AGE_HOURS_SQL} > 72 THEN N'72-96'
    WHEN ${MX_AGE_HOURS_SQL} > 48 THEN N'48-72'
    WHEN ${MX_AGE_HOURS_SQL} > 24 THEN N'24-48'
    ELSE N'0-24'
  END`;

// Mixes produced but not (or no longer) staged into Billet, bucketed by age
// and sorted oldest-first — powers the "Billet Staging" screen (reached via
// the Extrusion tile's entry chooser). Naturally re-surfaces fully-returned
// tubs too (they're back at IsStaged=0). Expired (>96h) tubs are deliberately
// excluded here — they only ever surface on the supervisor "Expired Mix
// Batches" queue (GET /mixing/expired), not this operator-facing list.
router.get('/mixing/staging/queue', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request().query(`
      SELECT t.TubID, t.MixingID, t.TubSeq, t.SupplierTubNo, t.TubWeightKG,
             m.Material, m.MixCode, m.MixRef, m.CompletedAt,
             ${MX_AGE_HOURS_SQL} AS AgeHours,
             ${MX_AGE_BUCKET_SQL} AS Bucket
      FROM   prod.MixingTubs t
      JOIN   prod.Mixing m ON m.MixingID = t.MixingID
      WHERE  t.IsStaged = 0 AND t.IsScrapped = 0 AND t.SAPSuccess = 1
        AND  m.IsReversed = 0 AND m.Status NOT IN (5, 6)
        AND  ${MX_AGE_HOURS_SQL} <= 96
      ORDER BY m.CompletedAt ASC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Minimum age before a mix can be staged/used — mirrors the 96h maximum
// (shelf-life expiry) but at the other end: material needs at least this
// long to condition before it's fit for the next stage.
const MX_MIN_AGE_HOURS = 24;

// Shared staging logic — every path that can stage a tub (the manual
// PATCH .../stage button and the scan-a-ticket PATCH .../stage-by-ref
// endpoint below) goes through this, so every guard (including the 24h
// minimum) is enforced identically everywhere, not re-implemented per
// entry point. Returns { status, body } — never throws for an ordinary
// validation failure, only for a genuine unexpected error (caller decides
// how to map that).
async function stageTub(pool, uid, tubId) {
  const cur = await pool.request().input('id', sql.Int, tubId).query(`
    SELECT t.MixingID, t.TubSeq, t.TubWeightKG, t.IsStaged, t.IsScrapped, t.ExpiryOverrideAt,
           m.MixRef, m.IsReversed, m.Status,
           ${MX_AGE_HOURS_SQL} AS AgeHours,
           (SELECT ISNULL(SUM(QuantityKG), 0) FROM prod.MixingTubReturns WHERE TubID = t.TubID) AS ReturnedKG
    FROM prod.MixingTubs t JOIN prod.Mixing m ON m.MixingID = t.MixingID
    WHERE t.TubID = @id`);
  const t = cur.recordset[0];
  if (!t) return { status: 404, body: { success: false, error: 'Tub not found.' } };
  if (t.IsScrapped) return { status: 409, body: { success: false, error: 'This tub has been scrapped and cannot be staged.' } };
  if (t.IsReversed || [5, 6].includes(t.Status))
    return { status: 409, body: { success: false, error: 'The parent mix has been reversed or cancelled.' } };
  if (t.IsStaged) return { status: 409, body: { success: false, error: 'This tub is already staged into Billet.' } };
  if (t.AgeHours < MX_MIN_AGE_HOURS && !t.ExpiryOverrideAt) {
    const remaining = Math.round((MX_MIN_AGE_HOURS - t.AgeHours) * 10) / 10;
    return { status: 409, body: {
      success: false,
      error: `This tub is only ${t.AgeHours.toFixed(1)}h old — mixes need at least ${MX_MIN_AGE_HOURS}h before they can be staged (available in ${remaining}h).`,
    } };
  }
  if (t.AgeHours > 96 && !t.ExpiryOverrideAt)
    return { status: 409, body: { success: false, error: 'This tub is expired (>96h) and requires supervisor review — approve scrap or override expiry from the Expired Mix Batches queue.' } };

  const balance = Math.round((Number(t.TubWeightKG) - Number(t.ReturnedKG)) * 1000) / 1000;
  await pool.request()
    .input('id', sql.Int, tubId).input('uid', sql.Int, uid).input('bal', sql.Decimal(10, 3), balance)
    .input('hrs', sql.Decimal(6, 2), t.AgeHours)
    .query(`UPDATE prod.MixingTubs
            SET IsStaged=1, StagedAt=GETDATE(), ConditioningTimeHours=@hrs, StagedByUserID=@uid, StagedQuantityKG=@bal
            WHERE TubID=@id`);

  // EventType is constrained by CK_EventLog_EventType to a fixed enum
  // (NOTE/FIREWALL/REVERSAL/SAP_FAIL/SAP_POST/SCRAP/OPERATOR_ADD/
  // OPERATOR_REMOVE/CANCELLED/ON_HOLD/COMPLETED/STARTED) that predates this
  // feature and has no "STAGED" value — use NOTE, same as every other
  // event kind not covered by that enum, and keep the specific meaning in
  // the message text itself.
  await writeEvent(pool, 'MX', t.MixingID, 'NOTE', `Tub ${tubId} staged into Billet (${t.AgeHours.toFixed(1)}h after production)`, 0, uid);

  const mixRef = t.MixRef || `MX-${String(t.MixingID).padStart(8, '0')}`;
  return { status: 200, body: { success: true, data: { tubId, mixRef, tubSeq: t.TubSeq, stagedQuantityKG: balance } } };
}

// Stage a tub into Billet — an ordinary operator action (see the plan's
// open question on PROD_ENTRY enforcement; matches today's unenforced
// convention for entry-level routes elsewhere in this file).
router.patch('/mixing/tubs/:tubId/stage', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const { status, body } = await stageTub(pool, userId(req), Number(req.params.tubId));
    res.status(status).json(body);
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// Scan-to-stage — parses the exact ref printed/barcoded on a tub's physical
// ticket (prod.Mixing.MixRef, a persisted "MX-{8-digit MixingID}" computed
// column, plus "-T{TubSeq}" appended by routes/labels.js's
// fetchMixingTicketsData) back into a TubID, then runs it through the same
// stageTub() guards as the manual button — scan errors read identically to
// button errors.
router.patch('/mixing/tubs/stage-by-ref', async (req, res) => {
  const raw = String(req.body?.ref || '').trim();
  const match = raw.match(/^MX-(\d+)-T(\d+)$/i);
  if (!match)
    return res.status(400).json({ success: false, error: `Unrecognised ticket format: "${raw}". Expected something like MX-00000064-T1.` });

  try {
    const pool = await getNexusOperationsPool();
    const mixingId = Number(match[1]);
    const tubSeq   = Number(match[2]);

    const tubRow = await pool.request().input('mid', sql.Int, mixingId).input('seq', sql.Int, tubSeq)
      .query(`SELECT TubID FROM prod.MixingTubs WHERE MixingID = @mid AND TubSeq = @seq`);
    if (!tubRow.recordset.length)
      return res.status(404).json({ success: false, error: `Ticket not recognised — no tub matches ${raw}.` });

    const { status, body } = await stageTub(pool, userId(req), tubRow.recordset[0].TubID);
    res.status(status).json(body);
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// Return part or all of a staged tub's remaining Billet balance back to the
// Conditioning Room — the only action that decrements StagedQuantityKG.
router.post('/mixing/tubs/:tubId/return-to-conditioning', async (req, res) => {
  const tubId      = Number(req.params.tubId);
  const quantityKG = Number(req.body?.quantityKG);
  const notes      = req.body?.notes ? String(req.body.notes).slice(0, 500) : null;
  try {
    if (!(quantityKG > 0)) return res.status(400).json({ success: false, error: 'quantityKG must be greater than 0.' });

    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    const cur = await pool.request().input('id', sql.Int, tubId)
      .query(`SELECT MixingID, IsStaged, StagedQuantityKG FROM prod.MixingTubs WHERE TubID=@id`);
    const t = cur.recordset[0];
    if (!t) return res.status(404).json({ success: false, error: 'Tub not found.' });
    if (!t.IsStaged) return res.status(409).json({ success: false, error: 'This tub is not currently staged.' });
    if (quantityKG > Number(t.StagedQuantityKG))
      return res.status(409).json({ success: false, error: `Cannot return ${quantityKG} KG — only ${t.StagedQuantityKG} KG is currently staged.` });

    await pool.request()
      .input('tid', sql.Int, tubId).input('qty', sql.Decimal(10, 3), quantityKG)
      .input('uid', sql.Int, uid).input('notes', sql.NVarChar(500), notes)
      .query(`INSERT INTO prod.MixingTubReturns (TubID,QuantityKG,ReturnedByUserID,Notes) VALUES (@tid,@qty,@uid,@notes)`);

    const newBalance = Math.round((Number(t.StagedQuantityKG) - quantityKG) * 1000) / 1000;
    await pool.request()
      .input('id', sql.Int, tubId).input('bal', sql.Decimal(10, 3), newBalance)
      .input('staged', sql.Bit, newBalance > 0 ? 1 : 0)
      .query(`UPDATE prod.MixingTubs SET StagedQuantityKG=@bal, IsStaged=@staged WHERE TubID=@id`);

    await writeEvent(pool, 'MX', t.MixingID, 'NOTE', `${quantityKG} KG returned to Conditioning from tub ${tubId}${notes ? ` — ${notes}` : ''}`, 0, uid);
    res.json({ success: true, data: { tubId, stagedQuantityKG: newBalance, isStaged: newBalance > 0 } });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// Tub search/picker — used by the front-end MX parent picker in the
// Extrusion entry wizard. Returns every tub (not just staged ones) so the
// picker can show status rather than silently filtering.
router.get('/mixing/tubs/search', async (req, res) => {
  const qRaw = String(req.query.q || '').trim();
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request().input('q', sql.NVarChar(60), qRaw ? `%${qRaw}%` : null).query(`
      SELECT TOP 50
             t.TubID, t.MixingID, t.TubSeq, t.SupplierTubNo, t.TubWeightKG,
             t.IsStaged, t.StagedQuantityKG, t.ConditioningTimeHours, t.IsScrapped,
             m.Material, m.MixCode, m.MixRef, m.CompletedAt,
             ${MX_AGE_HOURS_SQL} AS AgeHours,
             ${MX_AGE_BUCKET_SQL} AS Bucket
      FROM   prod.MixingTubs t JOIN prod.Mixing m ON m.MixingID = t.MixingID
      WHERE  m.IsReversed = 0 AND t.SAPSuccess = 1
        AND  (@q IS NULL OR m.MixRef LIKE @q OR m.MixCode LIKE @q OR m.Material LIKE @q OR t.SupplierTubNo LIKE @q)
      ORDER BY m.CompletedAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Billet staging — supervisor expiry actions ───────────────────────────────

// Expired, unstaged, un-actioned tubs — the supervisor review queue.
router.get('/mixing/expired', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request().query(`
      SELECT t.TubID, t.MixingID, t.TubSeq, t.SupplierTubNo, t.TubWeightKG,
             m.Material, m.MixCode, m.MixRef, m.CompletedAt,
             ${MX_AGE_HOURS_SQL} AS AgeHours
      FROM   prod.MixingTubs t JOIN prod.Mixing m ON m.MixingID = t.MixingID
      WHERE  ${MX_AGE_HOURS_SQL} > 96 AND t.IsStaged = 0 AND t.IsScrapped = 0
        AND  t.ExpiryOverrideAt IS NULL AND t.SAPSuccess = 1
        AND  m.IsReversed = 0 AND m.Status NOT IN (5, 6)
      ORDER BY m.CompletedAt ASC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Approve scrapping an expired, unstaged tub — posts a real SAP scrap
// movement against the mix material itself (SapServer's
// POST /api/production/mixing-scrap, movement 551, no batch — see the
// comment on validateMxTubLinks). Reuses the existing prod.ScrapEntries
// approve/post lifecycle (same fields/flow as /scrap/approve above) so the
// Posted Scrap / Scrap Reversal tiles pick this up for free.
router.post('/mixing/tubs/:tubId/expiry/scrap', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const tubId    = Number(req.params.tubId);
  const reasonID = Number(req.body?.reasonID) || 241; // default: 'Out of date polymer mix' (AppliesTo='MX')
  const pool = await getNexusOperationsPool();
  const uid  = userId(req);
  let scrapID;

  try {
    const cur = await pool.request().input('id', sql.Int, tubId).query(`
      SELECT t.MixingID, t.TubWeightKG, t.IsStaged, t.IsScrapped, t.ExpiryOverrideAt,
             m.MixCode, m.MixRef, ${MX_AGE_HOURS_SQL} AS AgeHours
      FROM prod.MixingTubs t JOIN prod.Mixing m ON m.MixingID = t.MixingID
      WHERE t.TubID = @id`);
    const t = cur.recordset[0];
    if (!t) return res.status(404).json({ success: false, error: 'Tub not found.' });
    if (t.IsScrapped) return res.status(409).json({ success: false, error: 'This tub has already been scrapped.' });
    if (t.IsStaged) return res.status(409).json({ success: false, error: 'This tub is already staged into Billet — scrapping is only for unstaged, expired tubs.' });
    if (t.ExpiryOverrideAt) return res.status(409).json({ success: false, error: "This tub's expiry has already been overridden." });
    if (!(t.AgeHours > 96)) return res.status(409).json({ success: false, error: 'This tub is not yet expired.' });

    const seIns = await pool.request()
      .input('rid', sql.Int, t.MixingID).input('r', sql.Int, reasonID)
      .input('qty', sql.Decimal(12, 3), t.TubWeightKG).input('uid', sql.Int, uid)
      .query(`INSERT INTO prod.ScrapEntries (ProcessCode,ProcessRecordID,ReasonID,Quantity,UnitOfMeasure,EnteredByUserID)
              OUTPUT INSERTED.ScrapID
              VALUES ('MX',@rid,@r,@qty,'KG',@uid)`);
    scrapID = seIns.recordset[0].ScrapID;

    const mixRef = t.MixRef || `MX${String(t.MixingID).padStart(8, '0')}`;
    const sapRaw = await sapPost('/api/production/mixing-scrap', {
      Material: t.MixCode, Quantity: Number(t.TubWeightKG),
      ScrapReason: '4917', Header: mixRef,
    });
    const bdc = parseMixingScrapResponse(sapRaw);

    await pool.request()
      .input('id', sql.Int, scrapID).input('uid', sql.Int, uid).input('doc', sql.NVarChar(10), bdc.materialDocument || null)
      .query(`UPDATE prod.ScrapEntries SET IsApproved=1, ApprovedAt=GETDATE(), ApprovedByUserID=@uid, SAPPosted=1, SAPMaterialDocument=@doc, SAPErrorMessage=NULL WHERE ScrapID=@id`);

    await pool.request()
      .input('id', sql.Int, tubId).input('uid', sql.Int, uid).input('r', sql.Int, reasonID).input('doc', sql.NVarChar(10), bdc.materialDocument || null)
      .query(`UPDATE prod.MixingTubs SET IsScrapped=1, ScrappedAt=GETDATE(), ScrappedByUserID=@uid, ScrapReasonID=@r, ScrapMaterialDocumentSAP=@doc, ScrapSAPErrorMessage=NULL WHERE TubID=@id`);

    await pool.request()
      .input('pc', sql.NVarChar(5), 'MX').input('rid', sql.Int, t.MixingID)
      .input('type', sql.NVarChar(20), 'SCRAP').input('qty', sql.Decimal(12, 3), t.TubWeightKG)
      .input('doc', sql.NVarChar(10), bdc.materialDocument || null).input('uid', sql.Int, uid)
      .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'KG',@doc,1,@uid)`);

    audit('SAP_OK', req.session?.user?.username, `Mixing tub ${tubId} SCRAP POSTED - Material Document = '${bdc.materialDocument}'`, req);
    await writeEvent(pool, 'MX', t.MixingID, 'SCRAP', `Tub ${tubId} scrapped (expired, ${t.AgeHours.toFixed(1)}h) — MatDoc: ${bdc.materialDocument}`, 1, uid);

    res.json({ success: true, data: { tubId, scrapID, materialDocument: bdc.materialDocument } });
  } catch (err) {
    if (scrapID) {
      const d = err.response?.data;
      const errMsg = (typeof d === 'string' ? d : null) || d?.error?.message || d?.error || d?.message || err.message;
      await pool.request()
        .input('id', sql.Int, scrapID).input('uid', sql.Int, uid).input('err', sql.NVarChar(sql.MAX), errMsg)
        .query(`UPDATE prod.ScrapEntries SET IsApproved=1, ApprovedAt=GETDATE(), ApprovedByUserID=@uid, SAPPosted=0, SAPErrorMessage=@err WHERE ScrapID=@id`).catch(() => {});
      await pool.request().input('id', sql.Int, tubId).input('err', sql.NVarChar(sql.MAX), errMsg)
        .query(`UPDATE prod.MixingTubs SET ScrapSAPErrorMessage=@err WHERE TubID=@id`).catch(() => {});
      audit('SAP_ERROR', req.session?.user?.username, `Mixing tub ${tubId} SCRAP FAILED - Message = "${errMsg}"`, req);
      return res.status(502).json({ success: false, error: `SAP scrap posting failed: ${errMsg}` });
    }
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// Supervisor override — moves an expired, unstaged tub into Billet anyway,
// with a required reason, unblocking backflush for anything linked to it.
router.post('/mixing/tubs/:tubId/expiry/override', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const tubId  = Number(req.params.tubId);
  const reason = String(req.body?.reason || '').trim();
  try {
    if (!reason) return res.status(400).json({ success: false, error: 'A reason is required to override expiry.' });

    const pool = await getNexusOperationsPool();
    const uid  = userId(req);

    const cur = await pool.request().input('id', sql.Int, tubId).query(`
      SELECT t.MixingID, t.TubWeightKG, t.IsStaged, t.IsScrapped,
             ${MX_AGE_HOURS_SQL} AS AgeHours,
             (SELECT ISNULL(SUM(QuantityKG), 0) FROM prod.MixingTubReturns WHERE TubID = t.TubID) AS ReturnedKG
      FROM prod.MixingTubs t JOIN prod.Mixing m ON m.MixingID = t.MixingID
      WHERE t.TubID = @id`);
    const t = cur.recordset[0];
    if (!t) return res.status(404).json({ success: false, error: 'Tub not found.' });
    if (t.IsScrapped) return res.status(409).json({ success: false, error: 'This tub has been scrapped.' });
    if (t.IsStaged) return res.status(409).json({ success: false, error: 'This tub is already staged.' });
    if (!(t.AgeHours > 96)) return res.status(409).json({ success: false, error: 'This tub is not yet expired — use the normal staging action.' });

    const balance = Math.round((Number(t.TubWeightKG) - Number(t.ReturnedKG)) * 1000) / 1000;
    await pool.request()
      .input('id', sql.Int, tubId).input('uid', sql.Int, uid).input('bal', sql.Decimal(10, 3), balance)
      .input('hrs', sql.Decimal(6, 2), t.AgeHours).input('reason', sql.NVarChar(500), reason)
      .query(`UPDATE prod.MixingTubs
              SET IsStaged=1, StagedAt=GETDATE(), ConditioningTimeHours=@hrs, StagedByUserID=@uid, StagedQuantityKG=@bal,
                  ExpiryOverrideAt=GETDATE(), ExpiryOverrideByUserID=@uid, ExpiryOverrideReason=@reason
              WHERE TubID=@id`);

    await writeEvent(pool, 'MX', t.MixingID, 'NOTE', `Expiry overridden by supervisor for tub ${tubId} (${t.AgeHours.toFixed(1)}h) — ${reason}`, 1, uid);
    res.json({ success: true, data: { tubId, stagedQuantityKG: balance } });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// ── Drumming — get coil lengths for a record ─────────────────────────────────

router.get('/drumming/:drummingId/coils', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('id', sql.Int, Number(req.params.drummingId))
      .query(`SELECT CoilID, CoilSeq, LengthM FROM prod.DrummingCoils WHERE DrummingID=@id ORDER BY CoilSeq`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Quick check for the traceability safeguard's instant client-side feedback
// (see assertParentBatchesReversed for the authoritative server-side check
// applied at submission time).
router.get('/drumming/:drummingId/reversal-status', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('id', sql.Int, Number(req.params.drummingId))
      .query(`SELECT IsReversed FROM prod.Drumming WHERE DrummingID=@id`);
    if (!r.recordset.length) return res.status(404).json({ success: false, error: 'Drumming record not found.' });
    res.json({ success: true, data: { isReversed: !!r.recordset[0].IsReversed } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// ══════════════════════════════════════════════════════════════════════════
// ── Drumming Ticket / Order Lookup ────────────────────────────────────────
// Searches log.AgreementSnapshot — same NexusOperations database as the
// prod.* schema the rest of this file uses, just a different schema (the
// two used to be separate databases — kongsberg vs Production — before the
// Nexus/NexusOperations restructure; see migrations/README.md). Unlike the
// Production Schedule report (routes/productionschedulesql.js), this is PTFE-only-free
// and unwindowed: every open value stream, every due date, since an
// operator drumming up an order needs to find it regardless of which
// report bucket it'd otherwise fall into.
// ══════════════════════════════════════════════════════════════════════════

// ReferenceDocument/Item here are OriginalDoc/OriginalDocItem, not the raw
// AgreementSnapshot columns — see performanceorderlink.js's header comment.
// Without this, an operator searching by order number (or reprinting a
// ticket) for a line that's just been picked would get "no open items
// found", because SAP has already flipped that line's raw ReferenceDocument
// to the delivery number — and the drum they produce would get logged
// against the delivery number instead of the sales order in prod.Drumming
// (see submitDrumming's stock-patch UPDATE below, which now matches on the
// same aliased columns for the same reason).
const AGREEMENT_LOOKUP_COLUMNS = `
        Customer, CustomerName, OriginalDoc AS ReferenceDocument, OriginalDocItem AS Item, Material, MaterialText,
        CustomerMaterial, ValueStream,
        CAST(CONVERT(VARCHAR(8), RequestDate, 112) AS DATETIME) AS RequestDate,
        OrderQty, Uom,
        DockStockAllocated   AS StockQty,
        (OrderQty - DockStockAllocated) AS RequiredQty`;

router.get('/order-lookup', async (req, res) => {
  try {
    const material = String(req.query.material || '').trim();
    const customer = String(req.query.customer || '').trim();
    if (!material && !customer)
      return res.status(400).json({ success: false, error: 'Enter a part number or customer number to search.' });

    const pool = await getNexusOperationsPool();
    const r = pool.request();
    const conditions = [];
    if (material) { r.input('mat', sql.NVarChar(40), `%${material}%`); conditions.push('Material LIKE @mat'); }
    if (customer) {
      r.input('cust',     sql.NVarChar(40), `%${customer}%`);
      r.input('custName', sql.NVarChar(40), `%${customer}%`);
      conditions.push('(Customer LIKE @cust OR CustomerName LIKE @custName)');
    }

    const result = await r.query(`
      SELECT ${AGREEMENT_LOOKUP_COLUMNS}
      FROM log.AgreementSnapshot
      WHERE ${conditions.join(' AND ')}
      ORDER BY RequestDate, CustomerName, ReferenceDocument, Item`);

    res.json({ success: true, data: result.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Every open item on a specific order — used by the reworked Make-to-Order
// wizard: operator enters an order number first, picks which item they're
// drumming, and material/customer auto-fill from the selected row.
router.get('/order-lookup/by-order/:orderNumber', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const result = await pool.request()
      .input('ref', sql.NVarChar(10), req.params.orderNumber.trim())
      .query(`
        SELECT ${AGREEMENT_LOOKUP_COLUMNS}
        FROM log.AgreementSnapshot
        WHERE OriginalDoc = @ref
        ORDER BY Item`);

    if (!result.recordset.length)
      return res.status(404).json({ success: false, error: `No open items found on order ${req.params.orderNumber}.` });

    res.json({ success: true, data: result.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Drumming Ticket (printable) ───────────────────────────────────────────
// Combines the AgreementSnapshot line, a live SAP RFC_READ_TEXT lookup for
// the order's special-instructions text (via the new SapServer endpoint —
// deliberately NOT cached, per the user's "process critical" instruction),
// and the standing log.CustomerStandardInstructions text for the customer.
// Served as a full HTML page (same pattern as buildProductionPlanHTML in
// routes/performance.js) and opened client-side with window.open(...,
// '_blank'), which auto-triggers window.print() — prints to the operator's
// OS-default printer via the browser's native dialog, NOT the network-
// printer TCP flow labelPrint()/tcpPrint() use elsewhere in this app.

async function loadDrummingTicketData(referenceDocument, item) {
  const pool = await getNexusOperationsPool();
  const lineRes = await pool.request()
    .input('ref', sql.NVarChar(10), referenceDocument)
    .input('item', sql.NVarChar(6), item)
    .query(`
      SELECT ${AGREEMENT_LOOKUP_COLUMNS}
      FROM log.AgreementSnapshot
      WHERE OriginalDoc = @ref AND OriginalDocItem = @item`);

  const line = lineRes.recordset[0];
  if (!line) return { line: null };

  const custRes = await pool.request()
    .input('cust', sql.NVarChar(10), line.Customer)
    .query(`SELECT Instructions FROM log.CustomerStandardInstructions WHERE Customer = @cust`);
  const customerStandardInstructions = custRes.recordset[0]?.Instructions || '';

  let sapInstructions = '';
  try {
    const sapRes = await sapGet(`/api/production/order-text/${encodeURIComponent(referenceDocument)}/${encodeURIComponent(item)}`);
    sapInstructions = sapRes?.success !== false ? (sapRes?.data || '') : '';
  } catch (err) {
    sapInstructions = `[Could not reach SAP for special instructions: ${err.message}]`;
  }

  return { line, customerStandardInstructions, sapInstructions };
}

function buildDrummingTicketHTML({ line, customerStandardInstructions, sapInstructions }) {
  const generatedAt = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const orderRef = `${line.ReferenceDocument}-${line.Item}`;

  // Hand-fill coil checklist — 35 numbered slots across 3 columns (No / Coil / ID OK),
  // matching the Excel Ticket tab's operator grid.
  const perCol = Math.ceil(35 / 3);
  const coilCol = (start, end) => `
    <table class="coil-grid">
      <thead><tr><th>No</th><th>Coil</th><th>ID OK</th></tr></thead>
      <tbody>
        ${Array.from({ length: end - start + 1 }, (_, i) => `
          <tr><td class="num">${start + i}</td><td></td><td></td></tr>`).join('')}
      </tbody>
    </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Drumming Ticket — ${esc(orderRef)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #0F172A; margin: 0; font-size: 12px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .subtitle { font-size: 11px; color: #64748B; margin: 0 0 16px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #CBD5E1; margin-bottom: 14px; }
  .info-cell { border: 1px solid #CBD5E1; padding: 6px 10px; }
  .info-label { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; color: #64748B; font-weight: 700; }
  .info-value { font-size: 13px; font-weight: 600; margin-top: 2px; }
  .info-value.blank { border-bottom: 1px solid #94A3B8; min-height: 16px; }
  .section-title { background: #1F3864; color: #fff; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 5px 10px; margin: 14px 0 0; }
  .section-body { border: 1px solid #CBD5E1; border-top: none; padding: 8px 10px; white-space: pre-wrap; min-height: 20px; }
  .section-body.empty { color: #94A3B8; font-style: italic; }
  .coils-wrap { display: flex; gap: 10px; margin-top: 14px; }
  table.coil-grid { border-collapse: collapse; font-size: 10px; flex: 1; }
  table.coil-grid th, table.coil-grid td { border: 1px solid #CBD5E1; padding: 2px 6px; text-align: left; }
  table.coil-grid th { background: #F1F5F9; font-size: 9px; text-transform: uppercase; }
  table.coil-grid td.num { text-align: center; color: #64748B; width: 20px; }
  .signoff-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14px; }
  .signoff-cell { border-bottom: 1px solid #94A3B8; padding: 12px 4px 4px; }
  .signoff-label { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; color: #64748B; }
  @media print { .no-print { display: none; } }
  .no-print { margin-top: 16px; font-size: 11px; color: #64748B; }
</style>
</head>
<body>
  <h1>Drumming Ticket</h1>
  <p class="subtitle">Order ${esc(orderRef)} &middot; Generated ${esc(generatedAt)}</p>

  <div class="info-grid">
    <div class="info-cell"><div class="info-label">Customer</div><div class="info-value">${esc(line.Customer)} — ${esc(line.CustomerName || '')}</div></div>
    <div class="info-cell"><div class="info-label">Customer Material</div><div class="info-value">${esc(line.CustomerMaterial || '—')}</div></div>
    <div class="info-cell"><div class="info-label">Material</div><div class="info-value">${esc(line.Material)} — ${esc(line.MaterialText || '')}</div></div>
    <div class="info-cell"><div class="info-label">Required Length</div><div class="info-value">${Number(line.RequiredQty || 0).toLocaleString('en-GB', { maximumFractionDigits: 3 })} ${esc(line.Uom || '')}</div></div>
    <div class="info-cell"><div class="info-label">Packaging</div><div class="info-value blank">&nbsp;</div></div>
    <div class="info-cell"><div class="info-label">Packaging Barcode</div><div class="info-value blank">&nbsp;</div></div>
    <div class="info-cell"><div class="info-label">Batch Traceability Number</div><div class="info-value blank">&nbsp;</div></div>
    <div class="info-cell"><div class="info-label">Drum No</div><div class="info-value blank">&nbsp;</div></div>
  </div>

  <div class="section-title">Special Instructions</div>
  <div class="section-body">Order Number: ${esc(orderRef)}</div>
  <div class="section-title">Customer Requirement (SAP)</div>
  <div class="section-body ${sapInstructions ? '' : 'empty'}">${sapInstructions ? esc(sapInstructions) : 'No special instructions held against this order in SAP.'}</div>
  <div class="section-title">Customer Standard Instructions</div>
  <div class="section-body ${customerStandardInstructions ? '' : 'empty'}">${customerStandardInstructions ? esc(customerStandardInstructions) : 'No standard instructions held for this customer.'}</div>

  <div class="section-title">Operator Coil Checklist</div>
  <div class="section-body" style="padding-top:10px">
    <div class="coils-wrap">
      ${coilCol(1, perCol)}
      ${coilCol(perCol + 1, perCol * 2)}
      ${coilCol(perCol * 2 + 1, 35)}
    </div>
    <div class="signoff-grid">
      <div class="signoff-cell"><div class="signoff-label">Stripped By</div></div>
      <div class="signoff-cell"><div class="signoff-label">Swaged By</div></div>
      <div class="signoff-cell"><div class="signoff-label">No of Joints</div></div>
      <div class="signoff-cell"><div class="signoff-label">Checked By</div></div>
      <div class="signoff-cell"><div class="signoff-label">Date</div></div>
      <div class="signoff-cell"><div class="signoff-label">Shift</div></div>
    </div>
  </div>

  <p class="no-print">This window should print automatically. If it doesn't, use your browser's Print command (Ctrl/Cmd+P).</p>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
</body>
</html>`;
}

router.get('/drumming/ticket/:referenceDocument/:item/print', async (req, res) => {
  try {
    const { line, customerStandardInstructions, sapInstructions } =
      await loadDrummingTicketData(req.params.referenceDocument.trim(), req.params.item.trim());

    if (!line)
      return res.status(404).send(`<pre>No open order line found for ${esc(req.params.referenceDocument)} / ${esc(req.params.item)}.</pre>`);

    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(buildDrummingTicketHTML({ line, customerStandardInstructions, sapInstructions }));
  } catch (err) {
    console.error('[drumming/ticket/print]', err.message);
    res.status(500).send(`<pre>Failed to build drumming ticket: ${esc(err.message)}</pre>`);
  }
});


// ── Failed backflush queue ────────────────────────────────────────────────────

router.get('/failed-backflush', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();

    // Find all process records with Status=6 (SAP_FAILED)
    // and join the most recent failed SAP posting for the error message
    const r = await pool.request().query(`
      SELECT ab.ProcessCode, ab.RecordID, ab.BatchRef, ab.Material,
             ab.Quantity, ab.UOM, ab.CreatedAt,
             sp.ErrorMessage, sp.PostedAt AS FailedAt, sp.SAPPostingID
      FROM (
        SELECT N'MX'  AS ProcessCode, MixingID       AS RecordID, MixRef     AS BatchRef, Material, CAST(TotalWeightKG         AS DECIMAL(12,3)) AS Quantity, N'KG' AS UOM, CreatedAt FROM prod.Mixing       WHERE Status=6
        UNION ALL SELECT N'EX', ExtrusionID,    ExtRef,   Material, LengthMetres,                         N'M',  CreatedAt FROM prod.Extrusion    WHERE Status=6
        UNION ALL SELECT N'CO',  ConvolutingID,  ConvRef,  Material, LengthMetres,                         N'M',  CreatedAt FROM prod.Convoluting  WHERE Status=6
        UNION ALL SELECT N'BR',  BraidingID,     BraidRef, Material, LengthMetres,                         N'M',  CreatedAt FROM prod.Braiding     WHERE Status=6
        UNION ALL SELECT N'CL',  CoverlineID,    CovRef,   Material, LengthMetres,                         N'M',  CreatedAt FROM prod.Coverline    WHERE Status=6
        UNION ALL SELECT N'TW',  TapeWrapID,     TWRef,    Material, LengthMetres,                         N'M',  CreatedAt FROM prod.TapeWrap     WHERE Status=6
        UNION ALL SELECT N'DR',  DrummingID,     DrumRef,  Material, LengthMetres,                         N'M',  CreatedAt FROM prod.Drumming     WHERE Status=6
        UNION ALL SELECT N'EW',  EwaldID,        EwaldRef, Material, CAST(TotalPiecesEA AS DECIMAL(12,3)), N'EA', CreatedAt FROM prod.Ewald        WHERE Status=6
        UNION ALL SELECT N'HA',  HoseAssemblyID, HARef,    Material, CAST(QuantityEA    AS DECIMAL(12,3)), N'EA', CreatedAt FROM prod.HoseAssembly WHERE Status=6
      ) AS ab
      CROSS APPLY (
        SELECT TOP 1 ErrorMessage, PostedAt, SAPPostingID
        FROM   prod.SAPPostings
        WHERE  ProcessCode = ab.ProcessCode AND ProcessRecordID = ab.RecordID AND IsSuccess = 0
        ORDER  BY PostedAt DESC
      ) sp
      ORDER BY ab.CreatedAt DESC`);

    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Retry any failed backflush — supervisor edits data, system re-submits
router.patch('/failed-backflush/:processCode/:recordId/retry', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const code = req.params.processCode.toUpperCase();
  const id   = Number(req.params.recordId);
  const uid  = userId(req);

  try {
    const pool = await getNexusOperationsPool();

    if (code === 'MX') {
      const { mixCode, supplierBatchNo, supplierTubNo, notes } = req.body;

      // Apply any parent-level corrections
      await pool.request()
        .input('rid',  sql.Int,              id)
        .input('mc',   sql.NVarChar(18),     mixCode         || null)
        .input('mat',  sql.NVarChar(18),     mixCode         || null)
        .input('sbn',  sql.NVarChar(50),     supplierBatchNo || null)
        .input('stn',  sql.NVarChar(20),     supplierTubNo   || null)
        .input('notes',sql.NVarChar(sql.MAX), notes          || null)
        .query(`UPDATE prod.Mixing SET
          MixCode=COALESCE(@mc,MixCode), Material=COALESCE(@mat,Material),
          SupplierBatchNo=COALESCE(@sbn,SupplierBatchNo),
          SupplierTubNo=COALESCE(@stn,SupplierTubNo),
          Notes=COALESCE(@notes,Notes), Status=4
          WHERE MixingID=@rid`);

      const cur = await pool.request().input('rid',sql.Int,id)
        .query(`SELECT MixCode,TotalWeightKG,SupplierBatchNo,ShiftID FROM prod.Mixing WHERE MixingID=@rid`);
      const m = cur.recordset[0];

      // Retry all failed tubs
      const tubsRes = await pool.request().input('mid',sql.Int,id)
        .query(`SELECT TubID,TubSeq,SupplierTubNo,TubWeightKG FROM prod.MixingTubs WHERE MixingID=@mid AND SAPSuccess=0 ORDER BY TubSeq`);
      const failedTubs = tubsRes.recordset;

      if (!failedTubs.length)
        return res.status(400).json({ success: false, error: 'No failed tubs found for this mixing record.' });

      await writeEvent(pool,'MX',id,'NOTE',`Retry by supervisor ${uid} — ${failedTubs.length} tub(s) pending`,0,uid);

      let anyFailed = false;
      const results = [];

      const mixRef = `MX-${String(id).padStart(8, '0')}`;
      for (const tub of failedTubs) {
        try {
          const sapRaw = await sapPost('/api/production/backflush', {
            Material:  m.MixCode,
            Quantity:  tub.TubWeightKG,
            Header:    mixRef,
            Packaging: '',
            Charge:    m.SupplierBatchNo || '',
            Customer:  '',
          });
          const { documentNumber: sapMatDoc, messageNumber, message } = parseSapBackflush(sapRaw);
          audit('SAP_OK', req.session?.user?.username, `'${mixRef}' BACKFLUSHED - Material Document = '${sapMatDoc}'`, req);

          if (messageNumber === '190') {
            await logBackflushAlert(pool, 'MX', id, mixRef, sapMatDoc, messageNumber, message);
            await writeEvent(pool, 'MX', id, 'NOTE',
              `SAP 190 tub ${tub.TubSeq} retry: No component consumption — MatDoc: ${sapMatDoc}. Flagged for data review.`, 1, uid);
          }

          await pool.request()
            .input('tid',sql.Int,tub.TubID).input('doc',sql.NVarChar(10),sapMatDoc)
            .query(`UPDATE prod.MixingTubs SET MaterialDocumentSAP=@doc,SAPSuccess=1,SAPErrorMessage=NULL WHERE TubID=@tid`);

          await pool.request()
            .input('pc',sql.NVarChar(5),'MX').input('rid',sql.Int,id)
            .input('type',sql.NVarChar(20),'BACKFLUSH').input('qty',sql.Decimal(12,3),tub.TubWeightKG)
            .input('doc',sql.NVarChar(10),sapMatDoc).input('uid',sql.Int,uid)
            .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'KG',@doc,1,@uid)`);

          await writeEvent(pool,'MX',id,'SAP_POST',`Tub ${tub.TubSeq} retry succeeded — MatDoc: ${sapMatDoc}${messageNumber === '190' ? ' (190: no components consumed)' : ''}`,0,uid);

          results.push({ tubID: tub.TubID, success: true, materialDocument: sapMatDoc });
        } catch (sapErr) {
          anyFailed = true;
          const errMsg = sapErr.response?.data?.error?.message || sapErr.response?.data?.error || sapErr.message;
          audit('SAP_ERROR', req.session?.user?.username, `'${mixRef}' FAILED - Message = "${errMsg}"`, req);
          await pool.request()
            .input('tid',sql.Int,tub.TubID).input('err',sql.NVarChar(sql.MAX),errMsg)
            .query(`UPDATE prod.MixingTubs SET SAPErrorMessage=@err WHERE TubID=@tid`);
          await writeEvent(pool,'MX',id,'SAP_FAIL',`Tub ${tub.TubSeq} retry failed: ${errMsg}`,2,uid);
          results.push({ tubID: tub.TubID, success: false, error: errMsg });
        }
      }

      if (anyFailed) {
        await pool.request().input('rid',sql.Int,id)
          .query(`UPDATE prod.Mixing SET Status=6 WHERE MixingID=@rid`);
        return res.json({ success: true, data: { status: 'SAP_FAILED', tubs: results }, warning: 'Some tubs still failed.' });
      }

      return res.json({ success: true, data: { status: 'COMPLETE', tubs: results } });
    }

    // DR — re-post to /drumming/stock or /drumming/customer based on EntryType
    if (code === 'DR') {
      const { material, packagingID, weightKG, lengthMetres, customerNumber, orderNumber, comments } = req.body;

      await pool.request()
        .input('rid',  sql.Int,               id)
        .input('mat',  sql.NVarChar(18),      material       || null)
        .input('len',  sql.Decimal(12,3),     lengthMetres != null ? Number(lengthMetres) : null)
        .input('pkg',  sql.NVarChar(10),      packagingID    || null)
        .input('wt',   sql.Decimal(12,3),     weightKG != null ? Number(weightKG) : null)
        .input('cust', sql.NVarChar(50),      customerNumber || null)
        .input('so',   sql.NVarChar(20),      orderNumber    || null)
        .input('notes',sql.NVarChar(sql.MAX), comments       || null)
        .query(`UPDATE prod.Drumming SET
          Material      = COALESCE(@mat,  Material),
          LengthMetres  = COALESCE(@len,  LengthMetres),
          PackagingType = COALESCE(@pkg,  PackagingType),
          WeightKG      = COALESCE(@wt,   WeightKG),
          CustomerID    = COALESCE(@cust, CustomerID),
          SalesOrderSAP = COALESCE(@so,   SalesOrderSAP),
          Notes         = COALESCE(@notes,Notes)
          WHERE DrummingID = @rid`);

      const cur = await pool.request().input('id', sql.Int, id)
        .query(`SELECT DrumRef, Material, LengthMetres, WeightKG, PackagingType,
                       CustomerID, SalesOrderSAP, EntryType FROM prod.Drumming WHERE DrummingID=@id`);
      if (!cur.recordset.length) return res.status(404).json({ success: false, error: 'Record not found.' });
      const d = cur.recordset[0];

      await writeEvent(pool, 'DR', id, 'NOTE', `Retry by supervisor ${uid}`, 0, uid);

      // BOM-vs-traceability re-check — a drum can land in this queue
      // specifically because it was BLOCKED (not a real SAP failure) by the
      // pre-backflush check in submitDrumming; re-check fresh here (a
      // concession may have been approved since, or "Refresh BOM" may have
      // resolved it) before retrying, same gate as the original submission.
      const drTraceRows = await pool.request()
        .input('cc', sql.NVarChar(5), 'DR').input('cr', sql.Int, id)
        .query(`SELECT ParentProcessCode AS processCode, ParentRecordID AS recordID
                FROM prod.ProductionTrace WHERE ChildProcessCode=@cc AND ChildRecordID=@cr`);
      const drBomRows  = await latestBomSnapshot(pool, 'DR', id);
      const drProblems = await validateTraceabilityAgainstBom(pool, drTraceRows.recordset, drBomRows);
      const drBlocking = await unresolvedProblems(pool, 'DR', id, drProblems);
      const drRawProblems = await validateRawMaterialBatches(pool, 'DR', id, drBomRows);

      if (drBlocking.length || drRawProblems.length) {
        const errMsg = `Still blocked: ${[...drBlocking, ...drRawProblems].map(p => p.reason).join(' ')}${drBlocking.length ? ' Raise a concession from the traceability screen, or use "Refresh BOM" if SAP\'s BOM has since been corrected.' : ''}`;
        return res.status(409).json({ success: false, data: { drummingID: id, status: 'BLOCKED' }, error: errMsg });
      }
      const drConcessions = drProblems.length ? await approvedConcessions(pool, 'DR', id) : [];

      let sapMatDoc, messageNumber = null, message = '';
      let concessionApplied = false;

      if (drConcessions.length) {
        const components = buildActualComponentList(drBomRows, drConcessions, d.LengthMetres);
        const gmRaw = await sapPost('/api/production/goods-movement-backflush', {
          Material: d.Material, Header: d.DrumRef, Components: components,
        });
        ({ documentNumber: sapMatDoc } = parseGoodsMovement(gmRaw));
        concessionApplied = true;
        audit('SAP_OK', req.session?.user?.username, `'${d.DrumRef}' BACKFLUSHED (concession, goods movement, retry) - Material Document = '${sapMatDoc}'`, req);

        for (const c of drConcessions) {
          await pool.request()
            .input('cid', sql.Int, c.ConcessionID).input('doc', sql.NVarChar(10), sapMatDoc)
            .query(`UPDATE prod.TraceabilityConcessions SET AppliedAt=GETDATE(), MaterialDocumentSAP=@doc WHERE ConcessionID=@cid`);
        }
      } else {
        const entryType = d.EntryType || 'stock';
        const sapRaw = await sapPost(`/drumming/${entryType}`, {
          Material:    d.Material,
          TotalLength: d.LengthMetres,
          WeightKG:    d.WeightKG    || 0,
          Header:      d.DrumRef,
          Packaging:   d.PackagingType  || '',
          Customer:    d.CustomerID     || '',
          Order:       d.SalesOrderSAP  || '',
        });

        ({ documentNumber: sapMatDoc, messageNumber, message } = parseSapBackflush(sapRaw));
        audit('SAP_OK', req.session?.user?.username, `'${d.DrumRef}' BACKFLUSHED - Material Document = '${sapMatDoc}'`, req);

        if (messageNumber === '190') {
          await logBackflushAlert(pool, 'DR', id, d.DrumRef, sapMatDoc, messageNumber, message);
          await writeEvent(pool, 'DR', id, 'NOTE',
            `SAP 190 on retry: No component consumption — MatDoc: ${sapMatDoc}. Flagged for data review.`, 1, uid);
        }
      }

      await pool.request()
        .input('pc',  sql.NVarChar(5),   'DR').input('rid', sql.Int, id)
        .input('type',sql.NVarChar(20),  'BACKFLUSH').input('qty', sql.Decimal(12,3), d.LengthMetres)
        .input('doc', sql.NVarChar(10),  sapMatDoc).input('uid', sql.Int, uid)
        .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',@doc,1,@uid)`);

      await pool.request().input('id', sql.Int, id)
        .query(`UPDATE prod.Drumming SET Status=4 WHERE DrummingID=@id`);

      await writeEvent(pool, 'DR', id, 'SAP_POST',
        `Retry succeeded${concessionApplied ? ' via concession goods movement' : ''} — MatDoc: ${sapMatDoc}${messageNumber === '190' ? ' (190: no components consumed)' : ''}`, 0, uid);

      return res.json({
        success: true,
        data: {
          materialDocument: sapMatDoc, status: 'COMPLETE', concessionApplied,
          ...(messageNumber === '190' ? { warning: 'SAP 190: posted but no components consumed — flagged for data review.' } : {}),
        },
      });
    }

    // Metre-based processes (EX/CO/BR/CL/TW) — retry via ZF40N backflush
    if (METRE_PROCESSES.has(code)) {
      const cfg = PROCESS[code];
      const { material, lengthMetres, notes, parentBatches } = req.body;

      // Apply any corrections before re-reading
      await pool.request()
        .input('rid',  sql.Int,              id)
        .input('mat',  sql.NVarChar(18),     material     || null)
        .input('len',  sql.Decimal(12,3),    lengthMetres ? Number(lengthMetres) : null)
        .input('notes',sql.NVarChar(sql.MAX), notes       || null)
        .query(`UPDATE ${cfg.table} SET
          Material     = COALESCE(@mat,  Material),
          LengthMetres = COALESCE(@len,  LengthMetres),
          Notes        = COALESCE(@notes,Notes)
          WHERE ${cfg.pk} = @rid`);

      const cur = await pool.request().input('id', sql.Int, id)
        .query(`SELECT ${cfg.ref} AS BatchRef, Material, LengthMetres FROM ${cfg.table} WHERE ${cfg.pk}=@id`);
      if (!cur.recordset.length) return res.status(404).json({ success: false, error: 'Record not found.' });
      const d = cur.recordset[0];

      // Billet-staging re-gate — EX only. A supervisor can either fix the
      // underlying mix (stage it / override its expiry) and retry with the
      // same link, or replace which tub(s) this run traces back to by
      // supplying a fresh parentBatches array here. Either way, this must
      // not fall through to a real SAP call until the link is valid.
      if (code === 'EX') {
        if (Array.isArray(parentBatches)) {
          await pool.request().input('cc', sql.NVarChar(5), code).input('cr', sql.Int, id)
            .query(`DELETE FROM prod.ProductionTrace WHERE ChildProcessCode=@cc AND ChildRecordID=@cr AND ParentProcessCode=N'MX'`);
          for (const pb of parentBatches) {
            if (!pb.processCode || !pb.recordID || pb.processCode.toUpperCase() !== 'MX') continue;
            await pool.request()
              .input('cc', sql.NVarChar(5), code).input('cr', sql.Int, id)
              .input('pr', sql.Int, Number(pb.recordID)).input('ptub', sql.Int, pb.tubID ? Number(pb.tubID) : null)
              .input('uid', sql.Int, uid)
              .query(`INSERT INTO prod.ProductionTrace (ChildProcessCode,ChildRecordID,ParentProcessCode,ParentRecordID,ParentTubID,LinkedByUserID) VALUES (@cc,@cr,N'MX',@pr,@ptub,@uid)`);
          }
        }

        const traceMxParents = await pool.request()
          .input('cc', sql.NVarChar(5), code).input('cr', sql.Int, id)
          .query(`SELECT ParentRecordID AS recordID, ParentTubID AS tubID
                  FROM prod.ProductionTrace
                  WHERE ChildProcessCode=@cc AND ChildRecordID=@cr AND ParentProcessCode=N'MX'`);
        const mxParentBatches = traceMxParents.recordset.map(r => ({ processCode: 'MX', recordID: r.recordID, tubID: r.tubID }));

        if (mxParentBatches.length) {
          await apportionMxExpectedConsumption(pool, code, id, d.Material, d.LengthMetres).catch(() => {});

          const problems = await validateMxTubLinks(pool, d.Material, mxParentBatches);
          if (problems.length) {
            return res.status(409).json({
              success: false,
              error: `Cannot retry — ${problems.map(p => p.reason).join(' ')} Stage the tub, override its expiry, or change the linked tub.`,
            });
          }
        }
      }

      await writeEvent(pool, code, id, 'NOTE', `Retry by supervisor ${uid}`, 0, uid);

      const sapRaw = await sapPost('/api/production/backflush', {
        Material: d.Material, Quantity: d.LengthMetres,
        Header: d.BatchRef, Packaging: '', Charge: '', Customer: '',
      });

      const { documentNumber: sapMatDoc, messageNumber, message } = parseSapBackflush(sapRaw);
      audit('SAP_OK', req.session?.user?.username, `'${d.BatchRef}' BACKFLUSHED - Material Document = '${sapMatDoc}'`, req);

      if (messageNumber === '190') {
        await logBackflushAlert(pool, code, id, d.BatchRef, sapMatDoc, messageNumber, message);
        await writeEvent(pool, code, id, 'NOTE', `SAP 190 on retry: No component consumption — MatDoc: ${sapMatDoc}.`, 1, uid);
      }

      await pool.request()
        .input('pc',   sql.NVarChar(5),   code)
        .input('rid',  sql.Int,           id)
        .input('type', sql.NVarChar(20),  'BACKFLUSH')
        .input('qty',  sql.Decimal(12,3), d.LengthMetres)
        .input('doc',  sql.NVarChar(10),  sapMatDoc)
        .input('uid',  sql.Int,           uid)
        .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',@doc,1,@uid)`);

      await pool.request().input('id',sql.Int,id)
        .query(`UPDATE ${cfg.table} SET Status=4 WHERE ${cfg.pk}=@id`);

      await writeEvent(pool, code, id, 'SAP_POST', `Retry succeeded — MatDoc: ${sapMatDoc}`, 0, uid);
      return res.json({ success: true, data: { materialDocument: sapMatDoc, status: 'COMPLETE' } });
    }

    if (code === 'EW') {
      const { material, notes } = req.body;
      await pool.request()
        .input('rid',  sql.Int,               id)
        .input('mat',  sql.NVarChar(18),      material || null)
        .input('notes',sql.NVarChar(sql.MAX), notes    || null)
        .query(`UPDATE prod.Ewald SET
          Material = COALESCE(@mat,  Material),
          Notes    = COALESCE(@notes,Notes),
          Status   = 4
          WHERE EwaldID = @rid`);
      await writeEvent(pool, 'EW', id, 'NOTE', `Supervisor ${uid} reviewed and marked complete from failed-backflush queue`, 0, uid);
      return res.json({ success: true, data: { status: 'COMPLETE' } });
    }

    if (code === 'HA') {
      const { material, salesOrderSAP, notes } = req.body;
      await pool.request()
        .input('rid',  sql.Int,               id)
        .input('mat',  sql.NVarChar(18),      material      || null)
        .input('so',   sql.NVarChar(12),      salesOrderSAP || null)
        .input('notes',sql.NVarChar(sql.MAX), notes         || null)
        .query(`UPDATE prod.HoseAssembly SET
          Material      = COALESCE(@mat, Material),
          SalesOrderSAP = COALESCE(@so,  SalesOrderSAP),
          Notes         = COALESCE(@notes,Notes),
          Status        = 4
          WHERE HoseAssemblyID = @rid`);
      await writeEvent(pool, 'HA', id, 'NOTE', `Supervisor ${uid} reviewed and marked complete from failed-backflush queue`, 0, uid);
      return res.json({ success: true, data: { status: 'COMPLETE' } });
    }

    // FW — not yet implemented
    return res.status(400).json({ success: false, error: `Retry not yet implemented for process ${code}.` });

  } catch (sapErr) {
    const pool2 = await getNexusOperationsPool();
    const errMsg = sapErr.response?.data?.error?.message || sapErr.response?.data?.error || sapErr.message;
    audit('SAP_ERROR', req.session?.user?.username, `'${code}${String(id).padStart(8,'0')}' FAILED - Message = "${errMsg}"`, req);
    const cfg = PROCESS[code];
    if (cfg) {
      await pool2.request().input('id',sql.Int,id).query(`UPDATE ${cfg.table} SET Status=6 WHERE ${cfg.pk}=@id`);
    }
    await writeEvent(pool2,code,id,'SAP_FAIL',`Retry failed: ${errMsg}`,2,userId(req));
    res.status(502).json({ success: false, error: errMsg });
  }
});


// Cancel a failed backflush record — supervisor action, sets Status=5
router.patch('/failed-backflush/:processCode/:recordId/cancel', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const code = req.params.processCode.toUpperCase();
  const id   = Number(req.params.recordId);
  const uid  = userId(req);

  let table, pk;
  if (code === 'MX') { table = 'prod.Mixing'; pk = 'MixingID'; }
  else {
    const cfg = PROCESS[code];
    if (!cfg) return res.status(400).json({ success: false, error: `Unknown process code: ${code}.` });
    table = cfg.table; pk = cfg.pk;
  }

  try {
    const pool = await getNexusOperationsPool();
    await pool.request()
      .input('id', sql.Int, id)
      .query(`UPDATE ${table} SET Status=5 WHERE ${pk}=@id AND Status=6`);
    await writeEvent(pool, code, id, 'CANCELLED', `Record cancelled by supervisor ${uid} from failed-backflush queue`, 0, uid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// ── Mixing data — filtered query for analysts ────────────────────────────────

router.get('/mixing/data', async (req, res) => {
  const { material, dateFrom, dateTo, shift, supplierBatchNo } = req.query;
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('mat',  sql.NVarChar(18),  material       ? `%${material}%`       : null)
      .input('from', sql.DateTime,      dateFrom        ? new Date(dateFrom)     : null)
      .input('to',   sql.DateTime,      dateTo          ? new Date(dateTo)       : null)
      .input('sft',  sql.TinyInt,       shift           ? Number(shift)          : null)
      .input('sbn',  sql.NVarChar(50),  supplierBatchNo ? `%${supplierBatchNo}%` : null)
      .query(`SELECT m.MixingID, m.MixRef, m.ShiftID, s.ShiftName,
                     m.Material, m.MixCode, m.TotalWeightKG,
                     m.SupplierBatchNo, m.SupplierTubNo,
                     m.Status, m.IsReversed, sc.StatusName, m.StartedAt, m.CompletedAt, m.Notes,
                     pu.Username AS CreatedBy
              FROM   prod.Mixing m
              LEFT JOIN prod.Shifts              s  ON s.ShiftID   = m.ShiftID
              LEFT JOIN prod.StatusCodes         sc ON sc.StatusID = m.Status
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID  = m.CreatedByUserID
              WHERE  (@mat IS NULL OR m.Material       LIKE @mat)
                AND  (@from IS NULL OR m.StartedAt    >= @from)
                AND  (@to   IS NULL OR m.StartedAt    <= @to)
                AND  (@sft  IS NULL OR m.ShiftID       = @sft)
                AND  (@sbn  IS NULL OR m.SupplierBatchNo LIKE @sbn)
              ORDER BY m.StartedAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Drumming data — filtered query for analysts ──────────────────────────────

router.get('/drumming/data', async (req, res) => {
  const { material, dateFrom, dateTo, customerID, salesOrderSAP } = req.query;
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('mat',  sql.NVarChar(18), material      ? `%${material}%`      : null)
      .input('from', sql.DateTime,     dateFrom       ? new Date(dateFrom)    : null)
      .input('to',   sql.DateTime,     dateTo         ? new Date(dateTo)      : null)
      .input('cust', sql.NVarChar(50), customerID     ? `%${customerID}%`    : null)
      .input('so',   sql.NVarChar(12), salesOrderSAP  ? `%${salesOrderSAP}%` : null)
      .query(`SELECT d.DrummingID, d.DrumRef, d.ShiftID, s.ShiftName,
                     d.Material, d.LengthMetres, d.PackagingType, d.TestPressurePSI,
                     d.SalesOrderSAP, d.CustomerID, d.CustomerOrderNo,
                     d.Status, d.IsReversed, sc.StatusName, d.StartedAt, d.CompletedAt, d.Notes,
                     pu.Username AS CreatedBy
              FROM   prod.Drumming d
              LEFT JOIN prod.Shifts              s  ON s.ShiftID   = d.ShiftID
              LEFT JOIN prod.StatusCodes         sc ON sc.StatusID = d.Status
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID  = d.CreatedByUserID
              WHERE  (@mat  IS NULL OR d.Material      LIKE @mat)
                AND  (@from IS NULL OR d.StartedAt    >= @from)
                AND  (@to   IS NULL OR d.StartedAt    <= @to)
                AND  (@cust IS NULL OR d.CustomerID   LIKE @cust)
                AND  (@so   IS NULL OR d.SalesOrderSAP LIKE @so)
              ORDER BY d.StartedAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Scrap — pending supervisor approval ──────────────────────────────────────

router.get('/scrap/pending', async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();

    // Column-existence guards: both IsApproved and IsVoided were added in migrations.
    // If either column is absent the filter is omitted so the page still renders.
    const colChk = await pool.request()
      .query(`SELECT name FROM sys.columns
              WHERE object_id = OBJECT_ID(N'prod.ScrapEntries')
                AND name IN (N'IsApproved', N'IsVoided')`);
    const cols = new Set(colChk.recordset.map(r => r.name));
    const approvedFilter = cols.has('IsApproved') ? 'AND se.IsApproved = 0' : '';
    const voidedFilter   = cols.has('IsVoided')   ? 'AND se.IsVoided   = 0' : '';

    const r = await pool.request().query(`
      SELECT se.ScrapID, se.ProcessCode, se.ProcessRecordID,
             sr.ReasonCode, sr.ReasonDescription,
             se.Quantity, se.UnitOfMeasure, se.EnteredAt, se.Notes,
             pu.Username AS EnteredBy,
             COALESCE(mx.MixRef, dr.DrumRef, ex.ExtRef, co.ConvRef,
                      br.BraidRef, cl.CovRef, tw.TWRef, ew.EwaldRef, ha.HARef) AS BatchRef,
             COALESCE(mx.Material, dr.Material, ex.Material, co.Material,
                      br.Material, cl.Material, tw.Material, ew.Material, ha.Material) AS Material
      FROM   prod.ScrapEntries se
      JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
      LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = se.EnteredByUserID
      LEFT JOIN prod.Mixing       mx ON mx.MixingID       = se.ProcessRecordID AND se.ProcessCode = 'MX'
      LEFT JOIN prod.Drumming     dr ON dr.DrummingID     = se.ProcessRecordID AND se.ProcessCode = 'DR'
      LEFT JOIN prod.Extrusion    ex ON ex.ExtrusionID    = se.ProcessRecordID AND se.ProcessCode = 'EX'
      LEFT JOIN prod.Convoluting  co ON co.ConvolutingID  = se.ProcessRecordID AND se.ProcessCode = 'CO'
      LEFT JOIN prod.Braiding     br ON br.BraidingID     = se.ProcessRecordID AND se.ProcessCode = 'BR'
      LEFT JOIN prod.Coverline    cl ON cl.CoverlineID    = se.ProcessRecordID AND se.ProcessCode = 'CL'
      LEFT JOIN prod.TapeWrap     tw ON tw.TapeWrapID     = se.ProcessRecordID AND se.ProcessCode = 'TW'
      LEFT JOIN prod.Ewald        ew ON ew.EwaldID        = se.ProcessRecordID AND se.ProcessCode = 'EW'
      LEFT JOIN prod.HoseAssembly ha ON ha.HoseAssemblyID = se.ProcessRecordID AND se.ProcessCode = 'HA'
      WHERE  1=1 ${approvedFilter} ${voidedFilter}
      ORDER BY se.EnteredAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Scrap — approve and post selected entries to SAP ─────────────────────────

router.post('/scrap/approve', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const { scrapIDs } = req.body;
  if (!Array.isArray(scrapIDs) || !scrapIDs.length)
    return res.status(400).json({ success: false, error: 'scrapIDs array required.' });

  const pool = await getNexusOperationsPool();
  const uid  = userId(req);

  const results = await Promise.all(scrapIDs.map(async (scrapID) => {
    try {
      const scrapR = await pool.request()
        .input('id', sql.Int, Number(scrapID))
        .query(`SELECT se.ScrapID, se.ProcessCode, se.ProcessRecordID,
                       se.Quantity, se.UnitOfMeasure, sr.ReasonCode
                FROM   prod.ScrapEntries se
                JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
                WHERE  se.ScrapID = @id AND se.IsApproved = 0 AND se.IsVoided = 0`);

      if (!scrapR.recordset.length)
        return { scrapID, success: false, error: 'Not found, already approved, or voided.' };

      const s   = scrapR.recordset[0];
      const cfg = PROCESS[s.ProcessCode];
      if (!cfg) return { scrapID, success: false, error: `Unknown process: ${s.ProcessCode}` };

      const matR = await pool.request()
        .input('id', sql.Int, s.ProcessRecordID)
        .query(`SELECT Material, ${cfg.ref} AS BatchRef, IsReversed FROM ${cfg.table} WHERE ${cfg.pk} = @id`);

      if (!matR.recordset.length) return { scrapID, success: false, error: 'Process record not found.' };

      if (matR.recordset[0].IsReversed)
        return { scrapID, success: false, error: 'Cannot approve — the parent backflush has been reversed.' };

      const { Material: material, BatchRef: batchRef } = matR.recordset[0];
      const reasonCode = s.ReasonCode?.trim();
      const sapPayload = {
        Material:     material,
        Quantity:     Number(s.Quantity),
        Header:       batchRef || String(scrapID),
        MovementType: '551',
      };
      if (reasonCode?.length === 4) sapPayload.ScrapReason = reasonCode;

      const sapRaw    = await sapPost('/api/production/scrap/post', sapPayload);
      const responses = parseBomScrapResponse(sapRaw);

      await insertScrapDocuments(pool, Number(scrapID), responses, uid);

      await pool.request()
        .input('id',  sql.Int, Number(scrapID))
        .input('uid', sql.Int, uid)
        .query(`UPDATE prod.ScrapEntries
                SET IsApproved=1, ApprovedAt=GETDATE(), ApprovedByUserID=@uid,
                    SAPPosted=1, SAPErrorMessage=NULL
                WHERE ScrapID=@id`);

      const docList = responses.map(r => r.documentNumber).filter(Boolean).join(', ');
      audit('SAP_OK', req.session?.user?.username, `'${scrapID}' SCRAP POSTED - Material Documents = '${docList}'`, req);
      await writeEvent(pool, s.ProcessCode, s.ProcessRecordID, 'NOTE',
        `Scrap approved & posted — ScrapID ${scrapID} — MatDocs: ${docList}`, 0, uid);

      return { scrapID, success: true, materialDocuments: responses.map(r => r.documentNumber) };

    } catch (err) {
      const d = err.response?.data;
      const errMsg = err.response?.status === 404
        ? `SAP endpoint not found (404) — /api/production/scrap/post has not been deployed on the SapServer yet.`
        : (typeof d === 'string' ? d : null) || d?.error || d?.message || d?.title
          || (d?.errors ? JSON.stringify(d.errors) : null) || err.message;

      audit('SAP_ERROR', req.session?.user?.username, `'${scrapID}' SCRAP FAILED - Message = "${errMsg}"`, req);
      // Only mark as approved+failed when the SAP server was actually reached.
      // A 404 means the endpoint doesn't exist — leave the entry as pending so
      // it can be retried once the SapServer is updated.
      if (err.response?.status !== 404) {
        await pool.request()
          .input('id',  sql.Int,               Number(scrapID))
          .input('uid', sql.Int,               uid)
          .input('err', sql.NVarChar(sql.MAX), errMsg)
          .query(`UPDATE prod.ScrapEntries SET IsApproved=1, ApprovedAt=GETDATE(), ApprovedByUserID=@uid,
                  SAPPosted=0, SAPErrorMessage=@err WHERE ScrapID=@id`).catch(() => {});
      }
      return { scrapID, success: false, error: errMsg };
    }
  }));

  res.json({ success: true, results });
});

// ── Scrap — reject selected pending entries ──────────────────────────────────
// Voids the entries (IsVoided=1) so they disappear from the approval queue and
// can never be approved or posted to SAP. Only pending, un-posted entries are
// eligible — approved/posted scrap must go through Scrap Reversal instead.

router.post('/scrap/reject', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const { scrapIDs } = req.body;
  if (!Array.isArray(scrapIDs) || !scrapIDs.length)
    return res.status(400).json({ success: false, error: 'scrapIDs array required.' });

  const pool = await getNexusOperationsPool();
  const uid  = userId(req);

  const results = await Promise.all(scrapIDs.map(async (scrapID) => {
    try {
      const scrapR = await pool.request()
        .input('id', sql.Int, Number(scrapID))
        .query(`SELECT se.ProcessCode, se.ProcessRecordID, se.Quantity, se.UnitOfMeasure,
                       sr.ReasonCode
                FROM   prod.ScrapEntries se
                JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
                WHERE  se.ScrapID = @id AND se.IsApproved = 0 AND se.IsVoided = 0 AND se.SAPPosted = 0`);

      if (!scrapR.recordset.length)
        return { scrapID, success: false, error: 'Not found, already approved, or voided.' };

      const s = scrapR.recordset[0];

      await pool.request()
        .input('id', sql.Int, Number(scrapID))
        .query(`UPDATE prod.ScrapEntries SET IsVoided = 1
                WHERE ScrapID = @id AND IsApproved = 0 AND IsVoided = 0 AND SAPPosted = 0`);

      audit('SCRAP_REJECT', req.session?.user?.username,
        `ScrapID '${scrapID}' REJECTED - ${s.Quantity} ${s.UnitOfMeasure} reason ${s.ReasonCode}`, req);
      await writeEvent(pool, s.ProcessCode, s.ProcessRecordID, 'NOTE',
        `Scrap rejected by supervisor — ScrapID ${scrapID} (${s.Quantity} ${s.UnitOfMeasure}, reason ${s.ReasonCode})`, 0, uid);

      return { scrapID, success: true };
    } catch (err) {
      return { scrapID, success: false, error: err.message };
    }
  }));

  res.json({ success: true, results });
});

// ── GET /scrap/:scrapId/documents — all SAP material documents for a scrap entry
router.get('/scrap/:scrapId/documents', async (req, res) => {
  const scrapID = Number(req.params.scrapId);
  if (!scrapID || isNaN(scrapID))
    return res.status(400).json({ success: false, error: 'Invalid scrap ID.' });
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('id', sql.Int, scrapID)
      .query(`
        SELECT ScrapDocumentID, MaterialDocument, SAPType, MessageClass, MessageNumber,
               SAPMessage, PostedAt, PostedByUserID,
               IsReversed, ReversalDocument, ReversedAt, ReversedByUserID
        FROM   prod.ScrapMaterialDocuments
        WHERE  ScrapID = @id
        ORDER  BY ScrapDocumentID
      `);
    res.json({ success: true, data: r.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Scrap Reversal — search + missed-reversals + reverse action ──────────────

// Shared query for scrap material documents enriched with batch + process details.
// @where is a trusted SQL fragment built server-side (never from user input).
function scrapDocSql(where) {
  // BackflushReversed is TRUE when EITHER:
  //   a) the process table's own IsReversed = 1 (set by markReversed on the Drumming/Extrusion/etc record), OR
  //   b) prod.SAPPostings has a reversed backflush for this job (always updated by markReversed —
  //      more reliable for historical reversals done before the process-table update was added)
  return `
    SELECT smd.ScrapDocumentID, smd.ScrapID, smd.MaterialDocument,
           smd.IsReversed, smd.ReversalDocument, smd.PostedAt,
           se.ProcessCode, se.ProcessRecordID,
           CAST(se.Quantity AS DECIMAL(12,3)) AS Quantity, se.UnitOfMeasure,
           sr.ReasonCode, sr.ReasonDescription,
           pu.Username AS PostedBy,
           prc.BatchRef, prc.Material,
           CASE WHEN ISNULL(prc.ProcRev, 0) = 1
                  OR EXISTS (
                       SELECT 1 FROM prod.SAPPostings sp2
                       WHERE  sp2.ProcessCode      = se.ProcessCode
                         AND  sp2.ProcessRecordID  = se.ProcessRecordID
                         AND  sp2.IsReversed       = 1
                         AND  sp2.MaterialDocumentSAP IS NOT NULL
                     )
                THEN 1 ELSE 0 END AS BackflushReversed
    FROM   prod.ScrapMaterialDocuments smd
    JOIN   prod.ScrapEntries se ON se.ScrapID = smd.ScrapID
    LEFT JOIN prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
    LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = smd.PostedByUserID
    LEFT JOIN (
      SELECT N'MX' AS PC, MixingID    AS RID, MixRef    AS BatchRef, Material, IsReversed AS ProcRev FROM prod.Mixing
      UNION ALL SELECT N'EX', ExtrusionID,    ExtRef,   Material, IsReversed FROM prod.Extrusion
      UNION ALL SELECT N'CO', ConvolutingID,  ConvRef,  Material, IsReversed FROM prod.Convoluting
      UNION ALL SELECT N'BR', BraidingID,     BraidRef, Material, IsReversed FROM prod.Braiding
      UNION ALL SELECT N'CL', CoverlineID,    CovRef,   Material, IsReversed FROM prod.Coverline
      UNION ALL SELECT N'TW', TapeWrapID,     TWRef,    Material, IsReversed FROM prod.TapeWrap
      UNION ALL SELECT N'DR', DrummingID,     DrumRef,  Material, IsReversed FROM prod.Drumming
    ) prc ON prc.PC = se.ProcessCode AND prc.RID = se.ProcessRecordID
    WHERE  smd.MaterialDocument IS NOT NULL
      ${where}
    ORDER BY smd.PostedAt DESC`;
}

// Unreversed scrap docs where the parent backflush has since been reversed
router.get('/scrap-reversal/missed', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .query(scrapDocSql(`AND smd.IsReversed = 0
         AND (ISNULL(prc.ProcRev, 0) = 1
              OR EXISTS (SELECT 1 FROM prod.SAPPostings sp2
                         WHERE sp2.ProcessCode = se.ProcessCode
                           AND sp2.ProcessRecordID = se.ProcessRecordID
                           AND sp2.IsReversed = 1
                           AND sp2.MaterialDocumentSAP IS NOT NULL))`));
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Flexible search — at least one param required
router.get('/scrap-reversal/search', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const { materialDocument, batchRef, material, processCode, dateFrom, dateTo, operator } = req.query;
  if (!materialDocument && !batchRef && !material && !processCode && !dateFrom && !dateTo && !operator)
    return res.status(400).json({ success: false, error: 'At least one search parameter is required.' });

  try {
    const pool = await getNexusOperationsPool();
    const req2 = pool.request();
    const conds = [];

    if (materialDocument) { req2.input('doc',  sql.NVarChar(20), `%${materialDocument}%`); conds.push('AND smd.MaterialDocument LIKE @doc'); }
    if (batchRef)         { req2.input('ref',  sql.NVarChar(25), `%${batchRef}%`);         conds.push('AND prc.BatchRef LIKE @ref'); }
    if (material)         { req2.input('mat',  sql.NVarChar(18), `%${material}%`);          conds.push('AND prc.Material LIKE @mat'); }
    if (processCode)      { req2.input('pc',   sql.NVarChar(5),  processCode.toUpperCase()); conds.push('AND se.ProcessCode = @pc'); }
    if (dateFrom)         { req2.input('from', sql.NVarChar(20), `${dateFrom} 00:00:00`);   conds.push('AND smd.PostedAt >= CONVERT(datetime, @from, 120)'); }
    if (dateTo)           { req2.input('to',   sql.NVarChar(20), `${dateTo} 23:59:59`);     conds.push('AND smd.PostedAt <= CONVERT(datetime, @to, 120)'); }
    if (operator)         { req2.input('op',   sql.NVarChar(80), `%${operator}%`);          conds.push('AND pu.Username LIKE @op'); }

    const r = await req2.query(scrapDocSql(conds.join(' ')));
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Shared by the single-item route below and its /bulk SSE sibling — same
// never-throws contract as sap.js's executeBatchCleanupItem, since the bulk
// route runs many of these concurrently via Promise.all and one item's
// rejection must not cancel the others still in flight. pool/uid are passed
// in rather than resolved per-item, since the bulk route only wants to fetch
// the connection pool once for the whole batch.
async function reverseScrapDocumentItem({ scrapDocumentID, materialDocument }, uid, pool, req) {
  if (!scrapDocumentID || !materialDocument)
    return { status: 400, success: false, error: 'scrapDocumentID and materialDocument are required.' };

  try {
    const chk = await pool.request()
      .input('id', sql.Int, Number(scrapDocumentID))
      .query(`SELECT IsReversed FROM prod.ScrapMaterialDocuments WHERE ScrapDocumentID = @id`);
    if (!chk.recordset.length)
      return { status: 404, success: false, error: 'Scrap document not found.' };
    if (chk.recordset[0].IsReversed)
      return { status: 409, success: false, error: 'Already reversed.' };

    // Helper: check if SAP response data contains M7/067 (already reversed)
    const isAlreadyReversed = (data) => {
      if (!data) return false;
      const responses = data?.data?.responses;
      if (Array.isArray(responses)) {
        return responses.some(r => r.messageClass === 'M7' && r.messageNumber === '067');
      }
      const inner = data?.data ?? data;
      return inner?.messageClass === 'M7' && inner?.messageNumber === '067';
    };

    const syncDb = async (reversalDoc) => {
      await pool.request()
        .input('id',  sql.Int,          Number(scrapDocumentID))
        .input('rev', sql.NVarChar(10), reversalDoc || null)
        .input('uid', sql.Int,          uid)
        .query(`UPDATE prod.ScrapMaterialDocuments
                SET IsReversed = 1, ReversalDocument = @rev,
                    ReversedAt = GETDATE(), ReversedByUserID = @uid
                WHERE ScrapDocumentID = @id`);
    };

    let raw;
    try {
      // 120s, not the 30s default — the Scrap Reversal UI fires every
      // selected document's reversal in one bulk request (see
      // /scrap-reversal/reverse/bulk below) rather than one at a time, so a
      // document queued behind several ~15s-each reversals on the same
      // SapServer worker thread may not even start until well past 30s.
      raw = await sapPost('/api/production/scrap/reverse', { MaterialDocument: String(materialDocument) }, 120000);
    } catch (sapErr) {
      const d = sapErr.response?.data;
      // M7/067 from SapServer non-2xx response — already reversed in SAP, sync DB
      if (isAlreadyReversed(d)) {
        await syncDb(null);
        audit('SAP_OK', req.session?.user?.username,
          `'${materialDocument}' SCRAP ALREADY REVERSED IN SAP - synced`, req);
        return { status: 200, success: true, synced: true, data: { reversalDocument: null } };
      }
      throw sapErr;
    }

    // M7/067 in a 200 response body — same treatment
    if (isAlreadyReversed(raw)) {
      await syncDb(null);
      audit('SAP_OK', req.session?.user?.username,
        `'${materialDocument}' SCRAP ALREADY REVERSED IN SAP - synced`, req);
      return { status: 200, success: true, synced: true, data: { reversalDocument: null } };
    }

    // Explicit failure from SapServer wrapper (not M7/067)
    if (raw?.success === false) {
      throw new Error((typeof raw.error === 'string' ? raw.error : raw.error?.message) || raw.message || 'SAP server error');
    }

    const responses = raw?.data?.responses;
    const reversalDoc = (Array.isArray(responses) ? responses[0]?.documentNumber : null)
                     || raw?.data?.documentNumber || raw?.documentNumber || null;

    await syncDb(reversalDoc);

    audit('SAP_OK', req.session?.user?.username,
      `'${materialDocument}' SCRAP REVERSED - Reversal Document = '${reversalDoc || ''}'`, req);

    return { status: 200, success: true, data: { reversalDocument: reversalDoc } };
  } catch (err) {
    const d = err.response?.data;
    const errMsg = (typeof d === 'string' ? d : null) || (typeof d?.error === 'string' ? d.error : d?.error?.message) || d?.message || d?.title || err.message;
    audit('SAP_ERROR', req.session?.user?.username,
      `'${materialDocument}' SCRAP REVERSAL FAILED - Message = "${errMsg}"`, req);
    return { status: 502, success: false, error: errMsg };
  }
}

// Reverse a single scrap material document via SapServer
router.post('/scrap-reversal/reverse', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  try {
    const pool = await getNexusOperationsPool();
    const uid  = userId(req);
    const { status, ...result } = await reverseScrapDocumentItem(req.body, uid, pool, req);
    res.status(status).json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /scrap-reversal/reverse/bulk
//
// Same as /scrap-reversal/reverse above, but for the whole set of documents
// selected in the Scrap Reversal UI in one request instead of N — that UI
// used to fire one HTTP request per selected document concurrently via
// client-side Promise.all (still N round trips, just not serialized). This
// collapses that to ONE request, streamed back as SSE progress events as
// each SapServer call settles — same event shape as /reversal/bulk above
// (type: 'start'/'progress'/'complete'), so the frontend can reuse the same
// SSE parsing it already has for that route.
//
// Body: { items: [{ scrapDocumentID, materialDocument }, ...] }.
// ---------------------------------------------------------------------------
router.post('/scrap-reversal/reverse/bulk', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ success: false, error: 'items array required.' });

  const pool  = await getNexusOperationsPool();
  const uid   = userId(req);
  const total = items.length;

  // Disable socket inactivity timeout for this long-running SSE connection
  req.socket.setTimeout(0);

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = data => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  send({ type: 'start', total });

  // Heartbeat every 20s keeps proxies and firewalls from closing an idle connection
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 20000);

  let done = 0;

  try {
    // Fire every reversal at SapServer in parallel via reverseScrapDocumentItem
    // — same never-throws contract as /reversal/bulk relies on above.
    await Promise.all(items.map(async item => {
      const result = await reverseScrapDocumentItem(item, uid, pool, req);
      send({
        type: 'progress', done: ++done, total,
        scrapDocumentID: item.scrapDocumentID, materialDocument: item.materialDocument,
        success: result.success, synced: result.synced || false,
        reversalDocument: result.data?.reversalDocument || null,
        error: result.success ? undefined : result.error,
      });
    }));
  } finally {
    clearInterval(heartbeat);
  }

  send({ type: 'complete', total });
  res.end();
});

// ── Reversal — SAP postings for a specific batch ─────────────────────────────

router.get('/reversal/by-batch/:processCode/:recordId', async (req, res) => {
  const pc  = req.params.processCode.toUpperCase();
  const rid = Number(req.params.recordId);
  try {
    const pool = await getNexusOperationsPool();
    const r = await pool.request()
      .input('pc',  sql.NVarChar(5), pc)
      .input('rid', sql.Int,         rid)
      .query(`SELECT sp.SAPPostingID, sp.PostingType, sp.MaterialDocumentSAP,
                     sp.Quantity, sp.UnitOfMeasure, sp.IsReversed,
                     sp.ReversalDocumentSAP, sp.PostedAt, sp.ReversedAt,
                     pu.Username AS PostedBy
              FROM   prod.SAPPostings sp
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = sp.PostedByUserID
              WHERE  sp.ProcessCode = @pc AND sp.ProcessRecordID = @rid
                AND  sp.IsSuccess = 1 AND sp.MaterialDocumentSAP IS NOT NULL
              ORDER BY sp.PostedAt DESC`);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Reversal — flexible search by material / date range / operator ────────────

router.get('/reversal/find', async (req, res) => {
  const { material, dateFrom, dateTo, operator } = req.query;
  if (!material && !dateFrom && !dateTo && !operator)
    return res.status(400).json({ success: false, error: 'At least one search parameter is required.' });

  try {
    const pool = await getNexusOperationsPool();

    // Build full datetime strings so SQL Server can use CONVERT style 120
    // (yyyy-mm-dd hh:mi:ss — reliably supported in SQL Server 2005).
    // Style 23 (date-only) is inconsistent with NVarChar params in SS2005.
    const dateFromStr = dateFrom ? `${dateFrom} 00:00:00` : null;
    const dateToStr   = dateTo   ? `${dateTo} 23:59:59`   : null;

    const r = await pool.request()
      .input('material', sql.NVarChar(18), material ? `%${material}%` : null)
      .input('dateFrom', sql.NVarChar(20), dateFromStr)
      .input('dateTo',   sql.NVarChar(20), dateToStr)
      .input('operator', sql.NVarChar(80), operator ? `%${operator}%` : null)
      .query(`
        SELECT sp.SAPPostingID, sp.ProcessCode, sp.ProcessRecordID,
               sp.PostingType, sp.Quantity, sp.UnitOfMeasure,
               sp.MaterialDocumentSAP, sp.PostedAt, sp.IsReversed,
               sp.ReversalDocumentSAP, sp.ReversedAt,
               pu.Username AS PostedBy,
               mat.Material
        FROM   prod.SAPPostings sp
        LEFT JOIN (
          SELECT N'MX' AS PC, MixingID       AS RID, Material FROM prod.Mixing
          UNION ALL SELECT N'EX', ExtrusionID,    Material FROM prod.Extrusion
          UNION ALL SELECT N'CO', ConvolutingID,  Material FROM prod.Convoluting
          UNION ALL SELECT N'BR', BraidingID,     Material FROM prod.Braiding
          UNION ALL SELECT N'CL', CoverlineID,    Material FROM prod.Coverline
          UNION ALL SELECT N'TW', TapeWrapID,     Material FROM prod.TapeWrap
          UNION ALL SELECT N'DR', DrummingID,     Material FROM prod.Drumming
        ) mat ON mat.PC = sp.ProcessCode AND mat.RID = sp.ProcessRecordID
        LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = sp.PostedByUserID
        WHERE  sp.IsSuccess = 1 AND sp.MaterialDocumentSAP IS NOT NULL
          AND  (@material IS NULL OR mat.Material LIKE @material)
          AND  (@dateFrom IS NULL OR sp.PostedAt >= CONVERT(datetime, @dateFrom, 120))
          AND  (@dateTo   IS NULL OR sp.PostedAt <= CONVERT(datetime, @dateTo,   120))
          AND  (@operator IS NULL OR pu.Username  LIKE @operator)
        ORDER BY sp.PostedAt DESC
      `);
    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Reversal — bulk reverse via SapServer (parallel) ────────────────────────

router.post('/reversal/bulk', requirePermission('PROD_SUPERVISOR'), async (req, res) => {
  const { materialDocuments } = req.body;
  if (!Array.isArray(materialDocuments) || !materialDocuments.length)
    return res.status(400).json({ success: false, error: 'materialDocuments array required.' });

  const pool  = await getNexusOperationsPool();
  const uid   = userId(req);
  const total = materialDocuments.length;

  // Disable socket inactivity timeout for this long-running SSE connection
  req.socket.setTimeout(0);

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = data => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  send({ type: 'start', total });

  // Heartbeat every 20s keeps proxies and firewalls from closing an idle connection
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 20000);

  let done = 0;

  const markReversed = async (matDoc, reversalDoc) => {
    const postR = await pool.request()
      .input('doc', sql.NVarChar(10), String(matDoc))
      .query(`SELECT TOP 1 ProcessCode, ProcessRecordID FROM prod.SAPPostings
              WHERE MaterialDocumentSAP=@doc AND IsSuccess=1`);

    await pool.request()
      .input('doc', sql.NVarChar(10), String(matDoc))
      .input('rev', sql.NVarChar(10), reversalDoc || null)
      .input('uid', sql.Int,          uid)
      .query(`UPDATE prod.SAPPostings SET IsReversed=1, ReversalDocumentSAP=@rev,
              ReversedAt=GETDATE(), ReversedByUserID=@uid
              WHERE MaterialDocumentSAP=@doc AND IsSuccess=1`);

    if (postR.recordset.length) {
      const { ProcessCode, ProcessRecordID } = postR.recordset[0];
      const cfg = PROCESS[ProcessCode];
      if (cfg) {
        await pool.request()
          .input('id', sql.Int, ProcessRecordID)
          .query(`UPDATE ${cfg.table} SET IsReversed=1 WHERE ${cfg.pk}=@id`);
      }
      await reverseJobScrap(pool, ProcessCode, ProcessRecordID, uid);
    }
  };

  try {
    // Fire all requests to SapServer in parallel — SapServer pools them internally.
    // Each promise emits an SSE progress event the moment it settles.
    // Timeout is 120s per call (reversal can be slow under SAP load).
    await Promise.all(materialDocuments.map(async (matDoc) => {
      try {
        const raw = await sapPost('/api/production/reverse-backflush', { MaterialDocument: String(matDoc) }, 120000);

        if (raw?.success === false) {
          const errMsg = (typeof raw.error === 'string' ? raw.error : raw.error?.message) || 'SAP server error';
          audit('SAP_ERROR', req.session?.user?.username, `'${matDoc}' REVERSAL FAILED - Message = "${errMsg}"`, req);
          send({ type: 'progress', done: ++done, total, materialDocument: matDoc, success: false, error: errMsg });
          return;
        }

        const zf = raw?.data ?? raw;
        const { type, messageClass, messageNumber, documentNumber, message } = zf || {};

        if (type === 'S' && messageClass === 'RM' && messageNumber === '196') {
          await markReversed(matDoc, documentNumber);
          audit('SAP_OK', req.session?.user?.username, `'${matDoc}' REVERSED - Reversal Document = '${documentNumber || ''}'`, req);
          send({ type: 'progress', done: ++done, total, materialDocument: matDoc,
                 success: true, reversalDocument: documentNumber });
          return;
        }

        if (type === 'E' && messageClass === 'RM' && messageNumber === '210') {
          await markReversed(matDoc, null);
          audit('SAP_ERROR', req.session?.user?.username, `'${matDoc}' REVERSAL FAILED - Message = "Already reversed — synced"`, req);
          send({ type: 'progress', done: ++done, total, materialDocument: matDoc,
                 success: false, synced: true, error: 'Already reversed in SAP — record updated.' });
          return;
        }

        if (type === 'E' && messageClass === 'M7' && messageNumber === '066') {
          audit('SAP_ERROR', req.session?.user?.username, `'${matDoc}' REVERSAL FAILED - Message = "Must use MBST"`, req);
          send({ type: 'progress', done: ++done, total, materialDocument: matDoc,
                 success: false, error: 'Must be reversed using MBST.' });
          return;
        }

        const rejMsg = message || `SAP rejected: ${type} ${messageClass} ${messageNumber}`;
        audit('SAP_ERROR', req.session?.user?.username, `'${matDoc}' REVERSAL FAILED - Message = "${rejMsg}"`, req);
        send({ type: 'progress', done: ++done, total, materialDocument: matDoc, success: false, error: rejMsg });

      } catch (err) {
        const d = err.response?.data;
        const errMsg = (typeof d === 'string' ? d : null) || (typeof d?.error === 'string' ? d.error : d?.error?.message) || d?.message || d?.title || err.message;
        audit('SAP_ERROR', req.session?.user?.username, `'${matDoc}' REVERSAL FAILED - Message = "${errMsg}"`, req);
        send({ type: 'progress', done: ++done, total, materialDocument: matDoc, success: false, error: errMsg });
      }
    }));
  } finally {
    clearInterval(heartbeat);
  }

  send({ type: 'complete', total });
  res.end();
});

// ── SAP backflush response validation ────────────────────────────────────────

// Validates a ZF40N response from the SapServer envelope { success, data, error }.
// Returns { documentNumber, messageNumber, message } on success.
// Throws a user-readable error on anything else.
function parseSapBackflush(result) {
  // SapServer wraps all responses: { success: bool, data: <ZF40N result>, error: { code, message } | null }
  // — .error is an object, not a plain string (see SapServer's CLAUDE.md
  // "Error Handling"); this file got bitten by that exact assumption once
  // already (see 7410e6f), so unwrap .message before falling back to it.
  if (result?.success === false) {
    throw new Error((typeof result.error === 'string' ? result.error : result.error?.message) || result.message || 'SAP server error');
  }

  // Unwrap the ZF40N result — fall back to result itself if already unwrapped
  const zf = result?.data ?? result;
  const { type, messageClass, messageNumber, documentNumber, message } = zf || {};

  if (type === 'S' && messageClass === 'RM' && (messageNumber === '190' || messageNumber === '191')) {
    return { documentNumber: documentNumber || null, messageNumber, message: message || '' };
  }

  throw new Error(message || `SAP backflush rejected: ${type} ${messageClass} ${messageNumber}`);
}

// Validates SapServer's POST /api/production/goods-movement-backflush
// response (BAPI_GOODSMVT_CREATE, used in place of the normal automatic
// backflush for a concession-covered job — see buildActualComponentList).
// Same ApiResponse<T> envelope as every other SapServer call in this file;
// GoodsMovementResponse itself carries { materialDocument, success,
// messages: [{type, message}] } — same success/messages shape as
// StockAdjustmentResponse on the SapServer side.
function parseGoodsMovement(result) {
  if (result?.success === false) {
    throw new Error((typeof result.error === 'string' ? result.error : result.error?.message) || result.message || 'SAP server error');
  }
  const data = result?.data ?? result;
  if (!data?.success || !data?.materialDocument) {
    const msg = (data?.messages || []).map(m => m.message).filter(Boolean).join(' ')
      || 'Goods movement rejected — no material document returned.';
    throw new Error(msg);
  }
  return { documentNumber: data.materialDocument };
}

// Validates the combined drumming-backflush response (SapServer's
// POST /api/production/drumming-backflush, DrumBackflushResponse) — same
// success criteria as parseSapBackflush (the underlying ZF40N call's own
// S/RM/190|191), just nested one level deeper under `backflush` since this
// response also carries the produced batch, the Z_ZPRODBATCH_MAINT result
// (rcBatch/rcPack) and the BOM-vs-traceability check.
function parseDrumBackflush(result) {
  if (result?.success === false) {
    throw new Error((typeof result.error === 'string' ? result.error : result.error?.message) || result.message || 'SAP server error');
  }

  const data = result?.data ?? result;
  const zf = data?.backflush ?? {};
  const { type, messageClass, messageNumber, documentNumber, message } = zf;

  if (!(type === 'S' && messageClass === 'RM' && (messageNumber === '190' || messageNumber === '191'))) {
    throw new Error(message || `SAP backflush rejected: ${type} ${messageClass} ${messageNumber}`);
  }

  return {
    documentNumber:     data.materialDocument || documentNumber || null,
    batch:              data.batch || null,
    rcBatch:             data.rcBatch || null,
    rcPack:              data.rcPack || null,
    messageNumber,
    message:             message || '',
    bomMismatch:         !!data.bomMismatch,
    expectedComponents:  data.expectedComponents || [],
    actualComponents:    data.actualComponents || [],
  };
}

// Logs a 190 (no component consumption) to prod.BackflushAlerts for data review.
async function logBackflushAlert(pool, processCode, recordID, batchRef, materialDocument, messageNumber, messageText) {
  await pool.request()
    .input('pc',  sql.NVarChar(5),   processCode)
    .input('rid', sql.Int,           recordID)
    .input('ref', sql.NVarChar(15),  batchRef || null)
    .input('doc', sql.NVarChar(10),  materialDocument || null)
    .input('mn',  sql.NVarChar(4),   messageNumber)
    .input('msg', sql.NVarChar(500), messageText || '')
    .query(`INSERT INTO prod.BackflushAlerts
              (ProcessCode,ProcessRecordID,BatchRef,MaterialDocument,MessageNumber,MessageText,AlertType)
            VALUES (@pc,@rid,@ref,@doc,@mn,@msg,'NO_COMPONENT_CONSUMPTION')`);
}

// Shared "SAP posting didn't happen" tail for the metre-process complete
// route — used both when a genuine SAP backflush call throws, and when a
// portal-side check (e.g. an unstaged/wrong-material MX tub link) deliberately
// skips the SAP call altogether before ever attempting it. Sets Status=6,
// records a failed SAPPostings row, writes SAP_FAIL to the event log,
// notifies PROD_SUPERVISOR, and sends the standard SAP_FAILED response —
// identical shape either way, so the failed-backflush queue can't tell (and
// doesn't need to) which case produced a given row.
async function markSapFailed(res, req, pool, code, cfg, recordID, batchRef, length, errMsg, uid) {
  await pool.request()
    .input('rid', sql.Int, recordID)
    .query(`UPDATE ${cfg.table} SET Status=6 WHERE ${cfg.pk}=@rid`);

  audit('SAP_ERROR', req.session?.user?.username, `'${batchRef}' FAILED - Message = "${errMsg}"`, req);

  await pool.request()
    .input('pc',   sql.NVarChar(5),      code)
    .input('rid',  sql.Int,              recordID)
    .input('type', sql.NVarChar(20),     'BACKFLUSH')
    .input('qty',  sql.Decimal(12,3),    length)
    .input('err',  sql.NVarChar(sql.MAX), errMsg)
    .input('uid',  sql.Int,              uid)
    .query(`INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,IsSuccess,ErrorMessage,PostedByUserID) VALUES (@pc,@rid,@type,@qty,'M',0,@err,@uid)`);

  await writeEvent(pool, code, recordID, 'SAP_FAIL', `SAP backflush failed: ${errMsg}`, 2, uid);

  getNexusPool().then(kPool => notify(kPool, {
    title:       'SAP Backflush Failed',
    body:        `${batchRef} (${code}) failed to post to SAP: ${errMsg}`,
    severity:    2,
    category:    'production',
    actionLabel: 'Open Queue',
    actionURL:   '/private/production-nexus.html',
    target:      { type: 'permission', value: 'PROD_SUPERVISOR' },
  })).catch(() => {});

  res.status(200).json({
    success: true,
    data: { recordID, batchRef, status: 'SAP_FAILED', error: errMsg },
    warning: 'Record saved but SAP backflush failed. See failed backflush queue.',
  });
}

// ── Shift helper ──────────────────────────────────────────────────────────────
function currentShiftID() {
  const h = new Date().getHours();
  if (h >= 6  && h < 14) return 1; // DAYS
  if (h >= 14 && h < 22) return 2; // AFTERS
  return 3;                          // NIGHTS
}

export default router;
