// routes/inboundcosts.js
//
// Inbound Log cost tracking — "Associated Costs" on an existing shipment,
// and the cost line a Manual Inbound Shipment creates for itself. Both post
// to SAP through the same, already-working mechanism the outbound freight
// flow was meant to use (SapServer's BAPI_ACC_DOCUMENT_POST, exposed at
// /api/costing/freight-posting) — NOT routes/shipmentcost.js's /post-migo,
// which points at /api/logistics/post-freight, an endpoint that doesn't
// exist anywhere in SapServer (confirmed via grep — that outbound flow is
// currently dead). This file reuses the correct endpoint from the start.
//
// Storage: Logistics.dbo.ShipmentCost — the same table the outbound flow
// uses — via a new poShipmentID column (nullable, points at kongsberg.dbo.
// PurchaseOrderShipment.ShipmentId) instead of overloading shipmentID
// (which is scoped to Logistics.dbo.ShipmentMain, a different identity
// space). Every existing outbound query INNER JOINs ShipmentMain on
// shipmentID, so rows with shipmentID NULL / poShipmentID set are
// automatically invisible to that code.
//
// GL account + cost centre: per the user's spec, associated-cost lines on
// an Inbound Log shipment always use cost centre 2012 (fixed — not a
// dropdown), with the GL code driven by a standard/premium toggle
// (602200 / 602100, both already seeded in Logistics.dbo.CostElements by
// migrate_shipment_costing.sql). The cost-centre DROPDOWN the user asked
// for is specific to Manual Inbound Shipment creation (routes/performance.js
// createManualOrderShipment caller below) — see that route.
//
// Vendor for the SAP posting = the shipment's haulier, via
// PurchaseOrderShipment.ForwarderID — confirmed with the user that
// forwarderID IS the SAP vendor code already (Logistics.dbo.Forwarders),
// so no separate vendor-mapping column was needed.

import express from 'express';
import sql     from 'mssql';
import axios   from 'axios';
import https   from 'https';
import fs      from 'fs';
import jwt     from 'jsonwebtoken';
import { sqlConfig, sapConfig, sapServerSecret } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

const canView = requirePermission('LOG_MRP');
// Posting real accounting documents to SAP is an Admin-tier action, same
// tier as the outbound Freight Spend / Unprocessed Costs tiles.
const canPost = requirePermission('LOG_ADMIN');

const INBOUND_COST_CENTER = '0000002012';

// ── SAP caller ───────────────────────────────────────────────────────────
const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
  ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
  : null;

function makeSapToken(userId) {
  return jwt.sign(
    { userId: userId ?? 0 },
    sapServerSecret,
    { issuer: 'sql2005-bridge', audience: 'sap-server', expiresIn: '60s' }
  );
}

function userId(req) {
  return req.session?.user?.userID;
}

// Looks up the SAP cost-element (GL) code for a direction/tier pair —
// same table + convention as shipmentcost.js's /estimate route.
async function lookupElementCode(pool, direction, tier) {
  const { recordset } = await pool.request()
    .input('direction', sql.NVarChar, direction)
    .input('tier',      sql.NVarChar, tier)
    .query(`SELECT TOP 1 elementCode FROM Logistics.dbo.CostElements
            WHERE direction = @direction AND tier = @tier`);
  return recordset[0]?.elementCode ?? null;
}

// Shared by "Add Cost" on an existing shipment and Manual Inbound Shipment
// creation (which auto-creates one line from its Price field) — see
// performancesql.js's createManualOrderShipment comment.
export async function insertInboundCostLine(pool, { poShipmentID, costCenter, tier, amount, information }) {
  const elementCode = await lookupElementCode(pool, 'inbound', tier === 'premium' ? 'premium' : 'standard');
  if (!elementCode) {
    const err = new Error(`No inbound ${tier} cost element configured in Logistics.dbo.CostElements.`);
    err.statusCode = 422;
    throw err;
  }

  const result = await pool.request()
    .input('poShipmentID', sql.Int,            poShipmentID)
    .input('costType',     sql.NVarChar,       '1') // 'General Freight' — same CostTypes row the outbound flow uses
    .input('costElement',  sql.NVarChar,       elementCode)
    .input('costCenter',   sql.NVarChar,       costCenter || INBOUND_COST_CENTER)
    .input('expectedCost', sql.Decimal(18, 2), amount)
    .input('information',  sql.NVarChar(200),  information || null)
    .query(`INSERT INTO Logistics.dbo.ShipmentCost
              (poShipmentID, costType, costElement, costCenter, expectedCost, actualCost, migoStatus)
            OUTPUT INSERTED.costID
            VALUES (@poShipmentID, @costType, @costElement, @costCenter, @expectedCost, @expectedCost, 0)`);

  return { costID: result.recordset[0].costID, elementCode };
}

// ── List cost lines for a shipment ─────────────────────────────────────────
router.get('/shipment/:poShipmentId', canView, async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request()
      .input('poShipmentId', sql.Int, req.params.poShipmentId)
      .query(`
        SELECT sc.costID, sc.poShipmentID, sc.costElement, sc.costCenter,
               sc.expectedCost, sc.actualCost, sc.migoStatus, sc.materialDocument,
               ce.elementDescription, ce.tier
        FROM Logistics.dbo.ShipmentCost sc
        LEFT JOIN Logistics.dbo.CostElements ce ON ce.elementCode = sc.costElement AND ce.direction = 'inbound'
        WHERE sc.poShipmentID = @poShipmentId
        ORDER BY sc.costID DESC
      `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Add a cost line ─────────────────────────────────────────────────────────
// Body: { poShipmentID, tier: 'standard'|'premium', amount, information? }
// Cost centre is always the fixed inbound default (2012) here — see header
// comment for why that differs from Manual Inbound Shipment creation.
router.post('/', canView, async (req, res) => {
  try {
    const { poShipmentID, tier, amount, information } = req.body;
    if (!poShipmentID) return res.status(400).json({ success: false, error: { message: 'poShipmentID is required.' } });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ success: false, error: { message: 'amount must be greater than 0.' } });

    const pool = await getPool();

    // Confirm the shipment exists and (softly) warn callers with no
    // forwarder set yet — posting to SAP will fail without one, but adding
    // the line itself doesn't need it.
    const { recordset: shipRows } = await pool.request()
      .input('poShipmentId', sql.Int, poShipmentID)
      .query('SELECT ShipmentId, ForwarderID FROM dbo.PurchaseOrderShipment WHERE ShipmentId = @poShipmentId');
    if (!shipRows.length) return res.status(404).json({ success: false, error: { message: 'Shipment not found.' } });

    const data = await insertInboundCostLine(pool, {
      poShipmentID, tier, amount: Number(amount), information,
    });
    res.status(201).json({ success: true, data: { ...data, forwarderSet: !!shipRows[0].ForwarderID } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});

// ── Delete an unprocessed cost line ─────────────────────────────────────────
router.delete('/:costId', canView, async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request()
      .input('costId', sql.BigInt, req.params.costId)
      .query(`DELETE FROM Logistics.dbo.ShipmentCost
              OUTPUT DELETED.costID
              WHERE costID = @costId AND ISNULL(migoStatus, 0) = 0`);
    if (!recordset.length) return res.status(400).json({ success: false, error: { message: 'Line not found, or already posted to SAP.' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Post every unprocessed cost line for a shipment to SAP ─────────────────
// One BAPI_ACC_DOCUMENT_POST call per line via SapServer's single
// /api/costing/freight-posting endpoint (not the -batch variant — that
// returns a flat, uncorrelated list with no way to map a result back to
// which cost line it belongs to, which matters when only some lines
// succeed). Slower, but each line's outcome is known for certain.
router.post('/shipment/:poShipmentId/post-migo', canPost, async (req, res) => {
  try {
    const pool = await getPool();
    const poShipmentId = Number(req.params.poShipmentId);

    const { recordset: shipRows } = await pool.request()
      .input('poShipmentId', sql.Int, poShipmentId)
      .query('SELECT ShipmentId, ShipmentReference, ForwarderID, Haulier FROM dbo.PurchaseOrderShipment WHERE ShipmentId = @poShipmentId');
    const shipment = shipRows[0];
    if (!shipment) return res.status(404).json({ success: false, error: { message: 'Shipment not found.' } });
    if (!shipment.ForwarderID) {
      return res.status(422).json({ success: false, error: { message: 'This shipment has no haulier selected — choose one from the Forwarders list before posting costs to SAP.' } });
    }

    const { recordset: lines } = await pool.request()
      .input('poShipmentId', sql.Int, poShipmentId)
      .query(`SELECT costID, costElement, costCenter, expectedCost
              FROM Logistics.dbo.ShipmentCost
              WHERE poShipmentID = @poShipmentId AND ISNULL(migoStatus, 0) = 0`);
    if (!lines.length) return res.status(400).json({ success: false, error: { message: 'No unprocessed cost lines on this shipment.' } });

    const docDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const token = makeSapToken(userId(req));
    const results = [];

    for (const line of lines) {
      try {
        const sapResp = await axios.post(
          `${sapConfig.url}/api/costing/freight-posting`,
          {
            docDate,
            vendor: String(shipment.ForwarderID),
            amount: Number(line.expectedCost),
            currency: 'GBP',
            glAccount: line.costElement,
            profitCenter: line.costCenter,
            shipment: shipment.ShipmentReference,
            information: `Inbound freight — ${shipment.ShipmentReference}`,
          },
          { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
        );
        const body = sapResp.data;
        const accountingNumber = body?.data?.accountingNumber;
        if (!body?.success || !accountingNumber) {
          results.push({ costID: line.costID, success: false, error: body?.error?.message || 'Posting failed.' });
          continue;
        }
        await pool.request()
          .input('costID', sql.BigInt, line.costID)
          .input('materialDocument', sql.NVarChar(20), accountingNumber)
          .query(`UPDATE Logistics.dbo.ShipmentCost SET migoStatus = 1, materialDocument = @materialDocument WHERE costID = @costID`);
        results.push({ costID: line.costID, success: true, materialDocument: accountingNumber });
      } catch (err) {
        results.push({ costID: line.costID, success: false, error: err.message });
      }
    }

    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
