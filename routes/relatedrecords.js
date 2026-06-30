/**
 * routes/relatedrecords.js
 *
 * Parameterised endpoint for the drill-down feature.
 * Accepts { tableName, fkCol, fkValue } and returns all rows from
 * dbo.<tableName> WHERE <fkCol> = @fkValue using a parameterised query
 * (no string interpolation of user values into SQL).
 *
 * Only tables listed in ALLOWED_TABLES can be queried through this route
 * to prevent blind table enumeration.
 */

import express from 'express';
import sql     from 'mssql';
import { sqlConfig } from '../config.js';

const router = express.Router();

// ── Allowlist of tables that may be queried via drill-down ──────────────────
const ALLOWED_TABLES = new Set([
  // Production sub-tables
  'Coils', 'Trace', 'Waste', 'Messages',
  'MixingMatDocs', 'MixingMessages', 'MixingWaste',
  'ExtrusionMessages', 'ExtrusionTrace', 'ExtrusionWaste',
  'ConvoMessages', 'ConvoTrace', 'ConvoWaste',
  'EwaldBoxes', 'EwaldMessages', 'EwaldScrapDocs', 'EwaldWaste',
  'FirewallMessages',
  'StagingItems',
  // Shipment sub-tables

  // Main tables (sidebar loads)
  'Batches', 'Mixing', 'Extrusion', 'Convo', 'Ewald', 'Firewall', 'Staging',
  // Reference tables

]);

// Allowlist of column names that may be used as FK filter columns.
// Column names are validated against this pattern to prevent SQL injection
// via the column name parameter (table names come from the allowlist above).
const VALID_COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// ── POST /api/related-records ───────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { tableName, fkCol, fkValue } = req.body;

  // --- Validate inputs -------------------------------------------------------
  if (!tableName || !fkCol || fkValue === undefined || fkValue === null) {
    return res.status(400).json({ success: false, error: 'Missing required fields: tableName, fkCol, fkValue' });
  }

  if (!ALLOWED_TABLES.has(tableName)) {
    return res.status(403).json({ success: false, error: `Table '${tableName}' is not permitted via this endpoint.` });
  }

  if (!VALID_COLUMN_RE.test(fkCol)) {
    return res.status(400).json({ success: false, error: 'Invalid column name.' });
  }

  // --- Determine the correct mssql type for the value ----------------------
  // We use NVarChar for all parameters for simplicity, since SQL Server will perform implicit conversions as needed.
  const sqlType = sql.NVarChar(256);

  // --- Execute parameterised query ------------------------------------------
  // Table and column names are NOT user-controlled values; tableName comes from
  // the server-side allowlist and fkCol is validated against a strict regex.
  // Only fkValue is bound as a parameter.
  try {
    const pool   = await sql.connect(sqlConfig);
    const result = await pool.request()
      .input('fkValue', sqlType, fkValue)
      .query(`SELECT TOP 500 * FROM dbo.${tableName} WHERE ${fkCol} = @fkValue`);

    res.json({ success: true, recordset: result.recordset });
  } catch (err) {
    console.error('[relatedrecords]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
