import express from 'express';
import sql from 'mssql';
import { getNexusOperationsPool } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

// ── SAP Material Group lookup (log.MaterialGroupMapping) ──────────────────
// See sql/migrate_material_group_mapping.sql for the full writeup on why
// this table exists: routes/shipmentcost.js's post-migo used to build the
// PO item's MaterialGroup as free text (`${modeOfTransport} Freight`),
// which isn't a real SAP code and is what caused PO creation to keep
// rolling back. Real codes (e.g. "ITLG01A") are tied to GL account and, in
// this business's case, mode of transport, so this is a proper lookup
// table rather than a hardcoded constant — maintained via the Material
// Group Mapping admin tile in Logistics.
//
// This file is both an Express router (mounted at /api/material-groups for
// the admin tile) AND exports lookupMaterialGroup() directly for
// shipmentcost.js to call in-process — no HTTP round-trip needed since
// they're both part of the same Node process.

const router = express.Router();
const getPool = getNexusOperationsPool;

router.get('/', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT MappingId, CostElement, ModeOfTransport, MaterialGroup, Description, CreatedAtUtc, UpdatedAtUtc
      FROM log.MaterialGroupMapping
      ORDER BY CostElement, ModeOfTransport
    `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const { costElement, modeOfTransport, materialGroup, description } = req.body;
    if (!costElement || !String(costElement).trim()) {
      return res.status(400).json({ success: false, error: { message: 'costElement (GL account) is required.' } });
    }
    if (!materialGroup || !String(materialGroup).trim()) {
      return res.status(400).json({ success: false, error: { message: 'materialGroup is required.' } });
    }

    const pool = await getPool();
    const { recordset } = await pool.request()
      .input('costElement',     sql.NVarChar(10),  String(costElement).trim())
      .input('modeOfTransport', sql.NVarChar(20),  modeOfTransport || null)
      .input('materialGroup',   sql.NVarChar(9),   String(materialGroup).trim())
      .input('description',     sql.NVarChar(200), description || null)
      .query(`
        INSERT INTO log.MaterialGroupMapping (CostElement, ModeOfTransport, MaterialGroup, Description)
        OUTPUT INSERTED.MappingId
        VALUES (@costElement, @modeOfTransport, @materialGroup, @description)
      `);

    res.json({ success: true, data: { mappingId: recordset[0].MappingId } });
  } catch (err) {
    // UQ_MGM_CostElement_ModeKey violation reads as a generic SQL error
    // otherwise — surface it plainly, this is the one thing an admin is
    // likely to hit (a duplicate GL account + mode combination, or a
    // second default row for a GL account that already has one).
    const message = /UQ_MGM_CostElement_ModeKey/i.test(err.message)
      ? `A mapping for CostElement ${req.body.costElement}${req.body.modeOfTransport ? ` / ${req.body.modeOfTransport}` : ' (default)'} already exists.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.put('/:mappingId', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const { costElement, modeOfTransport, materialGroup, description } = req.body;
    if (!costElement || !String(costElement).trim()) {
      return res.status(400).json({ success: false, error: { message: 'costElement (GL account) is required.' } });
    }
    if (!materialGroup || !String(materialGroup).trim()) {
      return res.status(400).json({ success: false, error: { message: 'materialGroup is required.' } });
    }

    const pool = await getPool();
    await pool.request()
      .input('mappingId',       sql.Int,           req.params.mappingId)
      .input('costElement',     sql.NVarChar(10),  String(costElement).trim())
      .input('modeOfTransport', sql.NVarChar(20),  modeOfTransport || null)
      .input('materialGroup',   sql.NVarChar(9),   String(materialGroup).trim())
      .input('description',     sql.NVarChar(200), description || null)
      .query(`
        UPDATE log.MaterialGroupMapping SET
          CostElement = @costElement, ModeOfTransport = @modeOfTransport,
          MaterialGroup = @materialGroup, Description = @description,
          UpdatedAtUtc = GETUTCDATE()
        WHERE MappingId = @mappingId
      `);

    res.json({ success: true });
  } catch (err) {
    const message = /UQ_MGM_CostElement_ModeKey/i.test(err.message)
      ? `A mapping for CostElement ${req.body.costElement}${req.body.modeOfTransport ? ` / ${req.body.modeOfTransport}` : ' (default)'} already exists.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.delete('/:mappingId', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('mappingId', sql.Int, req.params.mappingId)
      .query('DELETE FROM log.MaterialGroupMapping WHERE MappingId = @mappingId');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── lookupMaterialGroup ─────────────────────────────────────────────────
// Called directly (not over HTTP) from routes/shipmentcost.js's post-migo,
// once per PO item, in place of the old `${modeOfTransport} Freight` free
// text. Tries the exact (costElement, modeOfTransport) row first, then
// falls back to the (costElement, NULL) default row for that GL account.
// Throws — deliberately, not a silent fallback to some placeholder code —
// naming the exact combination that's missing, so post-migo's existing
// per-group try/catch (routes/shipmentcost.js) surfaces it as a clear
// per-shipment failure rather than sending SAP another free-text value
// that will just roll back again with a confusing SAP-side error.
export async function lookupMaterialGroup(costElement, modeOfTransport) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('costElement',     sql.NVarChar(10), costElement || '')
    .input('modeOfTransport', sql.NVarChar(20), modeOfTransport || null)
    .query(`
      SELECT TOP 1 MaterialGroup, ModeOfTransport
      FROM log.MaterialGroupMapping
      WHERE CostElement = @costElement
        AND (ModeOfTransport = @modeOfTransport OR ModeOfTransport IS NULL)
      ORDER BY CASE WHEN ModeOfTransport IS NULL THEN 1 ELSE 0 END
    `);

  if (!recordset.length) {
    throw new Error(
      `No Material Group mapping found for GL account ${costElement || '(none)'}` +
      `${modeOfTransport ? ` / ${modeOfTransport}` : ''}. Add one on the Material Group Mapping ` +
      `admin tile before this cost line can be posted to SAP.`
    );
  }

  return recordset[0].MaterialGroup;
}

export default router;
