// routes/sales.js
//
// Sales department API. Currently just Customer Standard Instructions —
// per-customer standing instruction text that appears on every Drumming
// Ticket printed for that customer (alongside the order-specific SAP
// special-instructions text, read live via RFC_READ_TEXT — see
// routes/productionnexus.js's /drumming/ticket/:referenceDocument/:item/print
// route). Managed from a tile on private/sales.html.
//
// View: Sales department. Edit (add/update/delete): SALES_SUPERVISOR — same
// permission the Production Schedule report already gates Sales-side edits
// behind (sql/migrate_production_schedule.sql), so this doesn't introduce a
// new permission.

import express from 'express';
import sql     from 'mssql';
import { sqlConfig } from '../config.js';
import { requireDepartment, requirePermission } from '../middleware/auth.js';

const router = express.Router();

const canView = requireDepartment('sales');
const canEdit = requirePermission('SALES_SUPERVISOR');

function actor(req) {
  return req.session?.user?.username || 'unknown';
}

// GET / — full list, alphabetical by customer.
router.get('/customer-instructions', canView, async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(`
      SELECT Customer, CustomerName, Instructions, LastUpdatedUtc, UpdatedByUsername
      FROM dbo.CustomerStandardInstructions
      ORDER BY Customer`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('[sales] GET /customer-instructions failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /:customer — create or update the standard instructions for a customer.
router.put('/customer-instructions/:customer', canEdit, async (req, res) => {
  try {
    const customer = req.params.customer.trim();
    const { customerName, instructions } = req.body || {};
    if (!customer) return res.status(400).json({ success: false, error: 'Customer number is required.' });
    if (!instructions || !instructions.trim())
      return res.status(400).json({ success: false, error: 'Instructions text is required.' });

    const pool = await sql.connect(sqlConfig);
    const exists = await pool.request()
      .input('cust', sql.NVarChar(10), customer)
      .query(`SELECT 1 FROM dbo.CustomerStandardInstructions WHERE Customer = @cust`);

    const r = pool.request()
      .input('cust',  sql.NVarChar(10),   customer)
      .input('name',  sql.NVarChar(35),   customerName || null)
      .input('instr', sql.NVarChar(1000), instructions.trim())
      .input('who',   sql.NVarChar(80),   actor(req));

    if (exists.recordset.length) {
      await r.query(`
        UPDATE dbo.CustomerStandardInstructions
        SET CustomerName = @name, Instructions = @instr,
            LastUpdatedUtc = GETUTCDATE(), UpdatedByUsername = @who
        WHERE Customer = @cust`);
    } else {
      await r.query(`
        INSERT INTO dbo.CustomerStandardInstructions
          (Customer, CustomerName, Instructions, LastUpdatedUtc, UpdatedByUsername)
        VALUES (@cust, @name, @instr, GETUTCDATE(), @who)`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[sales] PUT /customer-instructions failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /customer-instructions/bulk-import — mass upsert from a pasted
// spreadsheet list (Account Code / Company Name / Special Instructions —
// parsed client-side in sales.js, see parseCustomerInstructionsImport).
// Same per-row exists-then-INSERT/UPDATE logic as the single-row PUT above,
// just looped: SQL Server 2005 has no MERGE, and this table is one row per
// SAP customer (low hundreds), so a sequential loop is fine for an admin
// action rather than a hot path. Rows that fail validation (or hit a SQL
// error, e.g. a genuinely bad account code) are skipped and reported back
// individually rather than failing the whole import.
router.post('/customer-instructions/bulk-import', canEdit, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'No rows provided.' });

    const pool = await sql.connect(sqlConfig);
    const who = actor(req);
    let created = 0, updated = 0;
    const failed = [];

    for (const row of rows) {
      const customer     = String(row.customer ?? '').trim();
      // CustomerName is denormalised/display-only (see migration comment) —
      // truncate rather than fail the row over a long company name.
      const customerName = row.customerName ? String(row.customerName).trim().slice(0, 35) : null;
      const instructions = String(row.instructions ?? '').trim();

      if (!customer)             { failed.push({ customer: row.customer ?? '(blank)', error: 'Missing account code.' }); continue; }
      if (customer.length > 10)  { failed.push({ customer, error: 'Account code is longer than 10 characters.' }); continue; }
      if (!instructions)         { failed.push({ customer, error: 'Missing instructions text.' }); continue; }
      if (instructions.length > 1000) {
        failed.push({ customer, error: `Instructions text too long (${instructions.length} of max 1000 characters).` });
        continue;
      }

      try {
        const exists = await pool.request()
          .input('cust', sql.NVarChar(10), customer)
          .query(`SELECT 1 FROM dbo.CustomerStandardInstructions WHERE Customer = @cust`);

        const r = pool.request()
          .input('cust',  sql.NVarChar(10),   customer)
          .input('name',  sql.NVarChar(35),   customerName)
          .input('instr', sql.NVarChar(1000), instructions)
          .input('who',   sql.NVarChar(80),   who);

        if (exists.recordset.length) {
          await r.query(`
            UPDATE dbo.CustomerStandardInstructions
            SET CustomerName = @name, Instructions = @instr,
                LastUpdatedUtc = GETUTCDATE(), UpdatedByUsername = @who
            WHERE Customer = @cust`);
          updated++;
        } else {
          await r.query(`
            INSERT INTO dbo.CustomerStandardInstructions
              (Customer, CustomerName, Instructions, LastUpdatedUtc, UpdatedByUsername)
            VALUES (@cust, @name, @instr, GETUTCDATE(), @who)`);
          created++;
        }
      } catch (rowErr) {
        failed.push({ customer, error: rowErr.message });
      }
    }

    res.json({ success: true, data: { created, updated, failed } });
  } catch (err) {
    console.error('[sales] POST /customer-instructions/bulk-import failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /:customer
router.delete('/customer-instructions/:customer', canEdit, async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    await pool.request()
      .input('cust', sql.NVarChar(10), req.params.customer.trim())
      .query(`DELETE FROM dbo.CustomerStandardInstructions WHERE Customer = @cust`);
    res.json({ success: true });
  } catch (err) {
    console.error('[sales] DELETE /customer-instructions failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
