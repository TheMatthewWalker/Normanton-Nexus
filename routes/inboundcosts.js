// routes/inboundcosts.js
//
// Inbound Log cost tracking — "Associated Costs" on an existing shipment,
// and the cost line a Manual Inbound Shipment creates for itself.
//
// This file only adds/lists/removes lines in Logistics.dbo.ShipmentCost —
// posting to SAP is NOT done here. Per the user, inbound cost lines post
// through the SAME log and endpoint as outbound freight costs
// (routes/shipmentcost.js's GET /unprocessed + POST /post-migo), not a
// separate route. Both directions live in the same table, distinguished by
// which FK is set: shipmentID (outbound, -> Logistics.dbo.ShipmentMain) or
// poShipmentID (inbound, -> kongsberg.dbo.PurchaseOrderShipment) — see
// shipmentcost.js for the unified query/posting logic.
//
// Storage: Logistics.dbo.ShipmentCost — the same table the outbound flow
// uses — via a new poShipmentID column (nullable, points at
// dbo.PurchaseOrderShipment.ShipmentId in this connection's default DB)
// instead of overloading shipmentID (which is scoped to Logistics.dbo.
// ShipmentMain, a different identity space). Every existing outbound query
// INNER JOINs ShipmentMain on shipmentID, so rows with shipmentID NULL /
// poShipmentID set are automatically invisible to that code unless it's
// been updated to also look at poShipmentID (as shipmentcost.js now is).
//
// GL account + cost centre: per the user's spec, associated-cost lines on
// an Inbound Log shipment always use cost centre 2012 (fixed — not a
// dropdown), with the GL code driven by a standard/premium toggle
// (602200 / 602100, both already seeded in Logistics.dbo.CostElements by
// migrate_shipment_costing.sql). The cost-centre DROPDOWN the user asked
// for is specific to Manual Inbound Shipment creation (routes/performance.js
// createManualOrderShipment caller below) — see that route.
//
// modeOfTransport is captured per line (defaulted from the shipment's own
// ModeOfTransport at insert time) — per the user, this will drive the
// material group of the PO the freight cost eventually needs (Road/Sea/Air
// use different material groups). That PO-creation step isn't built yet;
// see migrate_inbound_costs_forwarders.sql's comment on the column.

import express from 'express';
import sql     from 'mssql';
import { sqlConfig } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

const canView = requirePermission('LOG_MRP');

const INBOUND_COST_CENTER = '0000002012';

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
// performancesql.js's createManualOrderShipment comment. modeOfTransport
// defaults from the shipment's own value when not supplied explicitly.
export async function insertInboundCostLine(pool, { poShipmentID, costCenter, tier, amount, information, modeOfTransport }) {
  const elementCode = await lookupElementCode(pool, 'inbound', tier === 'premium' ? 'premium' : 'standard');
  if (!elementCode) {
    const err = new Error(`No inbound ${tier} cost element configured in Logistics.dbo.CostElements.`);
    err.statusCode = 422;
    throw err;
  }

  let mode = modeOfTransport || null;
  if (!mode) {
    const { recordset } = await pool.request()
      .input('poShipmentId', sql.Int, poShipmentID)
      .query('SELECT ModeOfTransport FROM dbo.PurchaseOrderShipment WHERE ShipmentId = @poShipmentId');
    mode = recordset[0]?.ModeOfTransport ?? null;
  }

  const result = await pool.request()
    .input('poShipmentID',    sql.Int,            poShipmentID)
    .input('costType',        sql.NVarChar,       '1') // 'General Freight' — same CostTypes row the outbound flow uses
    .input('costElement',     sql.NVarChar,       elementCode)
    .input('costCenter',      sql.NVarChar,       costCenter || INBOUND_COST_CENTER)
    .input('expectedCost',    sql.Decimal(18, 2), amount)
    .input('modeOfTransport', sql.NVarChar(20),   mode)
    .query(`INSERT INTO Logistics.dbo.ShipmentCost
              (poShipmentID, costType, costElement, costCenter, expectedCost, actualCost, migoStatus, modeOfTransport)
            OUTPUT INSERTED.costID
            VALUES (@poShipmentID, @costType, @costElement, @costCenter, @expectedCost, @expectedCost, 0, @modeOfTransport)`);

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
               sc.expectedCost, sc.actualCost, sc.migoStatus, sc.materialDocument, sc.modeOfTransport,
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
// Body: { poShipmentID, tier: 'standard'|'premium', amount, information?, modeOfTransport? }
// Cost centre is always the fixed inbound default (2012) here — see header
// comment for why that differs from Manual Inbound Shipment creation.
// Posting to SAP happens from the Unprocessed Costs admin tile, not here —
// see routes/shipmentcost.js.
router.post('/', canView, async (req, res) => {
  try {
    const { poShipmentID, tier, amount, information, modeOfTransport } = req.body;
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
      poShipmentID, tier, amount: Number(amount), information, modeOfTransport,
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

export default router;
