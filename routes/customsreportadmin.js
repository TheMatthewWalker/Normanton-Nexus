import express from 'express';
import sql from 'mssql';
import { sqlConfig } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

// ── Customs Report reference/fallback tables ────────────────────────────
// (dbo.CustomsVatNumberOverrides, dbo.CustomsHsCodeDescriptions)
// See sql/migrate_customs_report_tables.sql for the full writeup. Both
// tables back the French VAT / DDP Customs Report tile (routes/customsreport.js):
// the report tries live SAP data first (KNA1-STCEG for VAT number) and only
// consults CustomsVatNumberOverrides when SAP has nothing for that consignee.
// SAP has no live source for HS/commodity description text at all, so
// CustomsHsCodeDescriptions is the only source for that column.
//
// This file is both an Express router (mounted at /api/customs-report-admin
// for the admin UI embedded in the Customs Report tile) AND exports
// lookupVatOverride()/lookupHsDescription() directly for customsreport.js
// to call in-process — no HTTP round-trip needed, same pattern as
// routes/materialgroups.js's exported lookupMaterialGroup().

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ── VAT number overrides ─────────────────────────────────────────────────

router.get('/vat-overrides', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT OverrideId, ConsigneeCode, VatNumber, Notes, CreatedAtUtc, UpdatedAtUtc
      FROM dbo.CustomsVatNumberOverrides
      ORDER BY ConsigneeCode
    `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/vat-overrides', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const { consigneeCode, vatNumber, notes } = req.body;
    if (!consigneeCode || !String(consigneeCode).trim()) {
      return res.status(400).json({ success: false, error: { message: 'consigneeCode is required.' } });
    }
    if (!vatNumber || !String(vatNumber).trim()) {
      return res.status(400).json({ success: false, error: { message: 'vatNumber is required.' } });
    }

    const pool = await getPool();
    const { recordset } = await pool.request()
      .input('consigneeCode', sql.NVarChar(10), String(consigneeCode).trim())
      .input('vatNumber',     sql.NVarChar(20), String(vatNumber).trim())
      .input('notes',         sql.NVarChar(200), notes || null)
      .input('createdBy',     sql.NVarChar(100), req.session?.user?.username || null)
      .query(`
        INSERT INTO dbo.CustomsVatNumberOverrides (ConsigneeCode, VatNumber, Notes, CreatedBy)
        OUTPUT INSERTED.OverrideId
        VALUES (@consigneeCode, @vatNumber, @notes, @createdBy)
      `);

    res.json({ success: true, data: { overrideId: recordset[0].OverrideId } });
  } catch (err) {
    const message = /UQ_CustomsVatNumberOverrides_Consignee/i.test(err.message)
      ? `A VAT override for consignee ${req.body.consigneeCode} already exists.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.put('/vat-overrides/:overrideId', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const { consigneeCode, vatNumber, notes } = req.body;
    if (!consigneeCode || !String(consigneeCode).trim()) {
      return res.status(400).json({ success: false, error: { message: 'consigneeCode is required.' } });
    }
    if (!vatNumber || !String(vatNumber).trim()) {
      return res.status(400).json({ success: false, error: { message: 'vatNumber is required.' } });
    }

    const pool = await getPool();
    await pool.request()
      .input('overrideId',    sql.Int,           req.params.overrideId)
      .input('consigneeCode', sql.NVarChar(10),  String(consigneeCode).trim())
      .input('vatNumber',     sql.NVarChar(20),  String(vatNumber).trim())
      .input('notes',         sql.NVarChar(200), notes || null)
      .query(`
        UPDATE dbo.CustomsVatNumberOverrides SET
          ConsigneeCode = @consigneeCode, VatNumber = @vatNumber, Notes = @notes,
          UpdatedAtUtc = GETUTCDATE()
        WHERE OverrideId = @overrideId
      `);

    res.json({ success: true });
  } catch (err) {
    const message = /UQ_CustomsVatNumberOverrides_Consignee/i.test(err.message)
      ? `A VAT override for consignee ${req.body.consigneeCode} already exists.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.delete('/vat-overrides/:overrideId', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('overrideId', sql.Int, req.params.overrideId)
      .query('DELETE FROM dbo.CustomsVatNumberOverrides WHERE OverrideId = @overrideId');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── HS / commodity code descriptions ─────────────────────────────────────

router.get('/hs-descriptions', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT HsCodeId, CommodityCode, Description, CreatedAtUtc, UpdatedAtUtc
      FROM dbo.CustomsHsCodeDescriptions
      ORDER BY CommodityCode
    `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/hs-descriptions', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const { commodityCode, description } = req.body;
    if (!commodityCode || !String(commodityCode).trim()) {
      return res.status(400).json({ success: false, error: { message: 'commodityCode is required.' } });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, error: { message: 'description is required.' } });
    }

    const pool = await getPool();
    const { recordset } = await pool.request()
      .input('commodityCode', sql.NVarChar(10),  String(commodityCode).trim())
      .input('description',   sql.NVarChar(400), String(description).trim())
      .input('createdBy',     sql.NVarChar(100), req.session?.user?.username || null)
      .query(`
        INSERT INTO dbo.CustomsHsCodeDescriptions (CommodityCode, Description, CreatedBy)
        OUTPUT INSERTED.HsCodeId
        VALUES (@commodityCode, @description, @createdBy)
      `);

    res.json({ success: true, data: { hsCodeId: recordset[0].HsCodeId } });
  } catch (err) {
    const message = /UQ_CustomsHsCodeDescriptions_Code/i.test(err.message)
      ? `A description for commodity code ${req.body.commodityCode} already exists.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.put('/hs-descriptions/:hsCodeId', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const { commodityCode, description } = req.body;
    if (!commodityCode || !String(commodityCode).trim()) {
      return res.status(400).json({ success: false, error: { message: 'commodityCode is required.' } });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, error: { message: 'description is required.' } });
    }

    const pool = await getPool();
    await pool.request()
      .input('hsCodeId',      sql.Int,           req.params.hsCodeId)
      .input('commodityCode', sql.NVarChar(10),  String(commodityCode).trim())
      .input('description',   sql.NVarChar(400), String(description).trim())
      .query(`
        UPDATE dbo.CustomsHsCodeDescriptions SET
          CommodityCode = @commodityCode, Description = @description,
          UpdatedAtUtc = GETUTCDATE()
        WHERE HsCodeId = @hsCodeId
      `);

    res.json({ success: true });
  } catch (err) {
    const message = /UQ_CustomsHsCodeDescriptions_Code/i.test(err.message)
      ? `A description for commodity code ${req.body.commodityCode} already exists.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.delete('/hs-descriptions/:hsCodeId', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('hsCodeId', sql.Int, req.params.hsCodeId)
      .query('DELETE FROM dbo.CustomsHsCodeDescriptions WHERE HsCodeId = @hsCodeId');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── In-process lookups (SAP-first, override-table-fallback) ──────────────
// Called directly from routes/customsreport.js while assembling report
// rows — never throw, a missing entry is a normal, expected outcome (the
// report shows the field blank and the row is still generated, per that
// route's error-handling design: partial data degrades a line, it never
// aborts the run).

export async function lookupVatOverride(consigneeCode) {
  if (!consigneeCode) return null;
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('consigneeCode', sql.NVarChar(10), String(consigneeCode).trim())
    .query('SELECT VatNumber FROM dbo.CustomsVatNumberOverrides WHERE ConsigneeCode = @consigneeCode');
  return recordset.length ? recordset[0].VatNumber : null;
}

export async function lookupHsDescription(commodityCode) {
  if (!commodityCode) return null;
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('commodityCode', sql.NVarChar(10), String(commodityCode).trim())
    .query('SELECT Description FROM dbo.CustomsHsCodeDescriptions WHERE CommodityCode = @commodityCode');
  return recordset.length ? recordset[0].Description : null;
}

export default router;
