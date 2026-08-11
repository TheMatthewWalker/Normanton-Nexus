import express from 'express';
import sql from 'mssql';
import { getNexusOperationsPool } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

// ── Forwarder Type -> Mode of Transport lookup (log.ForwarderModeMapping) ──
// See sql/migrate_forwarder_mode_mapping.sql for the full writeup: the
// freight/customs ShipmentCost rows created at booking time
// (routes/shipmentmain.js's mark-booked) never carried the booked
// forwarder's mode through to ShipmentCost.modeOfTransport at all. This
// table translates Forwarders.forwarderMode (the forwarder's own
// mode/type) into the canonical ModeOfTransport value used elsewhere
// (ShipmentCost.modeOfTransport, MaterialGroupMapping.ModeOfTransport).
//
// This file is both an Express router (mounted at /api/forwarder-mode-mapping
// for the admin tile) AND exports lookupModeOfTransport() directly for
// shipmentmain.js to call in-process.

const router = express.Router();
const getPool = getNexusOperationsPool;

router.get('/', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT MappingId, ForwarderMode, ModeOfTransport, Description, CreatedAtUtc, UpdatedAtUtc
      FROM log.ForwarderModeMapping
      ORDER BY ForwarderMode
    `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Distinct forwarderMode values actually in use on log.Forwarders —
// the Add/Edit Mapping modal's Forwarder Type field is populated from this
// rather than free text, so a mapping can only ever be created for a mode
// that's genuinely set on a real forwarder (no typos silently never matching
// anything in lookupModeOfTransport).
router.get('/forwarder-types', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT DISTINCT forwarderMode
      FROM log.Forwarders
      WHERE forwarderMode IS NOT NULL AND LTRIM(RTRIM(forwarderMode)) <> ''
      ORDER BY forwarderMode
    `);
    res.json({ success: true, data: recordset.map(r => r.forwarderMode) });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const { forwarderMode, modeOfTransport, description } = req.body;
    if (!forwarderMode || !String(forwarderMode).trim()) {
      return res.status(400).json({ success: false, error: { message: 'forwarderMode is required.' } });
    }
    if (!modeOfTransport || !String(modeOfTransport).trim()) {
      return res.status(400).json({ success: false, error: { message: 'modeOfTransport is required.' } });
    }

    const pool = await getPool();
    const { recordset } = await pool.request()
      .input('forwarderMode',   sql.NVarChar(20),  String(forwarderMode).trim())
      .input('modeOfTransport', sql.NVarChar(20),  String(modeOfTransport).trim())
      .input('description',     sql.NVarChar(200), description || null)
      .query(`
        INSERT INTO log.ForwarderModeMapping (ForwarderMode, ModeOfTransport, Description)
        OUTPUT INSERTED.MappingId
        VALUES (@forwarderMode, @modeOfTransport, @description)
      `);

    res.json({ success: true, data: { mappingId: recordset[0].MappingId } });
  } catch (err) {
    const message = /UQ_ForwarderModeMapping_ForwarderMode/i.test(err.message)
      ? `A mapping for Forwarder Type "${req.body.forwarderMode}" already exists.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.put('/:mappingId', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const { forwarderMode, modeOfTransport, description } = req.body;
    if (!forwarderMode || !String(forwarderMode).trim()) {
      return res.status(400).json({ success: false, error: { message: 'forwarderMode is required.' } });
    }
    if (!modeOfTransport || !String(modeOfTransport).trim()) {
      return res.status(400).json({ success: false, error: { message: 'modeOfTransport is required.' } });
    }

    const pool = await getPool();
    await pool.request()
      .input('mappingId',       sql.Int,           req.params.mappingId)
      .input('forwarderMode',   sql.NVarChar(20),  String(forwarderMode).trim())
      .input('modeOfTransport', sql.NVarChar(20),  String(modeOfTransport).trim())
      .input('description',     sql.NVarChar(200), description || null)
      .query(`
        UPDATE log.ForwarderModeMapping SET
          ForwarderMode = @forwarderMode, ModeOfTransport = @modeOfTransport,
          Description = @description, UpdatedAtUtc = GETUTCDATE()
        WHERE MappingId = @mappingId
      `);

    res.json({ success: true });
  } catch (err) {
    const message = /UQ_ForwarderModeMapping_ForwarderMode/i.test(err.message)
      ? `A mapping for Forwarder Type "${req.body.forwarderMode}" already exists.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.delete('/:mappingId', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('mappingId', sql.Int, req.params.mappingId)
      .query('DELETE FROM log.ForwarderModeMapping WHERE MappingId = @mappingId');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── lookupModeOfTransport ───────────────────────────────────────────────
// Called directly (not over HTTP) from routes/shipmentmain.js's mark-booked
// when building each ShipmentCost row. Unlike lookupMaterialGroup, this
// never throws — a missing mapping just means the raw forwarderMode value
// is used as-is (this is best-effort metadata, not a hard SAP requirement),
// and no forwarderMode at all resolves to null.
export async function lookupModeOfTransport(forwarderMode) {
  if (!forwarderMode) return null;
  try {
    const pool = await getPool();
    const { recordset } = await pool.request()
      .input('forwarderMode', sql.NVarChar(20), forwarderMode)
      .query('SELECT TOP 1 ModeOfTransport FROM log.ForwarderModeMapping WHERE ForwarderMode = @forwarderMode');
    return recordset.length ? recordset[0].ModeOfTransport : forwarderMode;
  } catch (_) {
    return forwarderMode;
  }
}

export default router;
