// routes/materialRequestUnits.js
//
// Material Request Units — log.MaterialRequestUnits, see
// migrations/nexus_operations/20260811130000_add_material_request_units.cjs
// for the full writeup. Lets Production raise a Staging Post request in a
// unit they actually think in on the floor ("1 spool", "3 tubs") instead of
// a raw KG figure — each row is one (Material, Unit) -> ConversionQty (KG
// per 1 of that unit) mapping, maintained here via the Material Request
// Units admin tile in Logistics.
//
// GET / and GET /by-material/:material are intentionally NOT behind
// LOG_ADMIN — Staging Post's request form is used by any logged-in
// production operator and needs to read this list to populate the unit
// dropdown, same reasoning as stagingsql.js's searchMaterials. Only
// writes (add/edit/delete/bulk) require LOG_ADMIN.

import express from 'express';
import sql from 'mssql';
import { getNexusOperationsPool } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

const router = express.Router();
const getPool = getNexusOperationsPool;

router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT RequestUnitId, Material, Unit, ConversionQty, CreatedBy, CreatedAtUtc, UpdatedAtUtc
      FROM log.MaterialRequestUnits
      ORDER BY Material, Unit
    `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Staging Post's request form calls this once a material is picked, to
// populate (or hide) the unit dropdown — cheap enough to call per-pick
// rather than caching the full table client-side, since the list only ever
// matters for whichever one material is currently selected.
router.get('/by-material/:material', async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request()
      .input('material', sql.NVarChar(18), req.params.material)
      .query(`
        SELECT RequestUnitId, Material, Unit, ConversionQty
        FROM log.MaterialRequestUnits
        WHERE Material = @material
        ORDER BY Unit
      `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

function validateBody(body) {
  const { material, unit, conversionQty } = body;
  if (!material || !String(material).trim()) return 'material is required.';
  if (!unit || !String(unit).trim()) return 'unit is required.';
  if (!(Number(conversionQty) > 0)) return 'conversionQty must be greater than zero.';
  return null;
}

function duplicateMessage(err, material, unit) {
  return /UQ_MaterialRequestUnits_Material_Unit/i.test(err.message)
    ? `A conversion for ${material} / ${unit} already exists.`
    : err.message;
}

router.post('/', requirePermission('LOG_ADMIN'), async (req, res) => {
  const { material, unit, conversionQty } = req.body;
  const validationError = validateBody(req.body);
  if (validationError) return res.status(400).json({ success: false, error: { message: validationError } });

  try {
    const pool = await getPool();
    const { recordset } = await pool.request()
      .input('material',      sql.NVarChar(18),  String(material).trim())
      .input('unit',          sql.NVarChar(20),  String(unit).trim())
      .input('conversionQty', sql.Decimal(15, 3), Number(conversionQty))
      .input('createdBy',     sql.NVarChar(100), req.session?.user?.username || null)
      .query(`
        INSERT INTO log.MaterialRequestUnits (Material, Unit, ConversionQty, CreatedBy)
        OUTPUT INSERTED.RequestUnitId
        VALUES (@material, @unit, @conversionQty, @createdBy)
      `);
    res.json({ success: true, data: { requestUnitId: recordset[0].RequestUnitId } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: duplicateMessage(err, material, unit) } });
  }
});

router.put('/:id', requirePermission('LOG_ADMIN'), async (req, res) => {
  const { material, unit, conversionQty } = req.body;
  const validationError = validateBody(req.body);
  if (validationError) return res.status(400).json({ success: false, error: { message: validationError } });

  try {
    const pool = await getPool();
    await pool.request()
      .input('id',             sql.Int,           req.params.id)
      .input('material',      sql.NVarChar(18),  String(material).trim())
      .input('unit',          sql.NVarChar(20),  String(unit).trim())
      .input('conversionQty', sql.Decimal(15, 3), Number(conversionQty))
      .query(`
        UPDATE log.MaterialRequestUnits SET
          Material = @material, Unit = @unit, ConversionQty = @conversionQty, UpdatedAtUtc = GETUTCDATE()
        WHERE RequestUnitId = @id
      `);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: duplicateMessage(err, material, unit) } });
  }
});

router.delete('/:id', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Int, req.params.id)
      .query('DELETE FROM log.MaterialRequestUnits WHERE RequestUnitId = @id');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── CSV bulk upload ──────────────────────────────────────────────────────────
// Upsert, not insert-only — re-uploading a CSV to correct a conversion
// figure is the expected workflow, not just first-time loading. Row-level
// failures (bad material, etc.) are collected rather than aborting the
// whole batch, same pattern as routes/deliverymain.js's /bulk.
router.post('/bulk', requirePermission('LOG_ADMIN'), async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ success: false, error: { message: 'records array is required and must not be empty.' } });
  }

  const pool = await getPool();
  const createdBy = req.session?.user?.username || null;
  let inserted = 0, updated = 0;
  const errors = [];

  for (const r of records) {
    const validationError = validateBody(r);
    if (validationError) {
      errors.push({ material: r.material, unit: r.unit, error: validationError });
      continue;
    }
    try {
      const result = await pool.request()
        .input('material',      sql.NVarChar(18),  String(r.material).trim())
        .input('unit',          sql.NVarChar(20),  String(r.unit).trim())
        .input('conversionQty', sql.Decimal(15, 3), Number(r.conversionQty))
        .input('createdBy',     sql.NVarChar(100), createdBy)
        .query(`
          MERGE log.MaterialRequestUnits AS target
          USING (SELECT @material AS Material, @unit AS Unit) AS src
            ON target.Material = src.Material AND target.Unit = src.Unit
          WHEN MATCHED THEN
            UPDATE SET ConversionQty = @conversionQty, UpdatedAtUtc = GETUTCDATE()
          WHEN NOT MATCHED THEN
            INSERT (Material, Unit, ConversionQty, CreatedBy)
            VALUES (@material, @unit, @conversionQty, @createdBy)
          OUTPUT $action AS Action;
        `);
      if (result.recordset[0]?.Action === 'INSERT') inserted++;
      else updated++;
    } catch (err) {
      errors.push({ material: r.material, unit: r.unit, error: err.message });
    }
  }

  res.json({ success: true, inserted, updated, errors });
});

// ── In-process lookup ─────────────────────────────────────────────────────────
// Called directly by routes/staging.js's POST /requests — the conversion is
// computed server-side from this table rather than trusting a
// client-supplied KG figure, same reasoning as materialgroups.js's
// lookupMaterialGroup. Throws when the (material, unit) pair isn't
// configured, naming both, so the caller surfaces a clear "not set up yet"
// error rather than silently falling back to some default factor.
export async function getConversionQty(material, unit) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('material', sql.NVarChar(18), material)
    .input('unit',     sql.NVarChar(20), unit)
    .query(`
      SELECT ConversionQty FROM log.MaterialRequestUnits
      WHERE Material = @material AND Unit = @unit
    `);
  if (!recordset.length) {
    throw new Error(`No conversion configured for ${unit} of ${material}. Add one on the Material Request Units admin tile before this unit can be requested.`);
  }
  return Number(recordset[0].ConversionQty);
}

export default router;
