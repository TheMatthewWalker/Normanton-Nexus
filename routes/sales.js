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
