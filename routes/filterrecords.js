/**
 * routes/filterrecords.js
 *
 * Parameterised server-side filter endpoint for the table browser. Also
 * doubles as the unfiltered "load table" call (col/mode/val all omitted) --
 * routing that through here too, instead of the raw-SQL /sql/query console
 * endpoint, is what keeps it pool-aware: resolveLegacyTablePool() sends each
 * table to the database it actually lives in (NexusArchive vs
 * NexusOperations.log), whereas /sql/query always runs against Nexus via a
 * fixed isolated connection.
 *
 * POST /api/filter-records
 * Body: { tableName, col?, mode?, val? }
 *   tableName        — must be in ALLOWED_TABLES
 *   col, mode, val    — all three together for a filtered query; omit all
 *                        three for an unfiltered TOP 500 (a partial set is
 *                        rejected as a 400, not silently ignored)
 *   col               — column name, validated against a strict regex
 *   mode              — "contains" | "exact" | "starts"
 *   val               — the search value (bound as a SQL parameter — never interpolated)
 *
 * Returns up to 500 matching rows.
 *
 * Mount in server.js:
 *   import filterRecordsRoutes from './routes/filterrecords.js';
 *   app.use('/api/filter-records', requireLogin, filterRecordsRoutes);
 */

import express from 'express';
import sql     from 'mssql';
import { resolveLegacyTablePool } from '../lib/legacyTableRouting.js';

const router = express.Router();

// ── Allowlist — only these tables may be queried through this endpoint ────────
const ALLOWED_TABLES = new Set([
  'Batches', 'Ewald', 'Mixing', 'Extrusion', 'Convo', 'Firewall', 'Staging',
  'archive',
  // Sub-tables (accessible via drill-down, but also directly)
  'Coils', 'Trace', 'Waste',
  'EwaldBoxes', 'EwaldMessages', 'EwaldScrapDocs', 'EwaldWaste',
  'MixingMatDocs', 'MixingMessages', 'MixingWaste',
  'ExtrusionMessages', 'ExtrusionTrace', 'ExtrusionWaste',
  'ConvoMessages', 'ConvoTrace', 'ConvoWaste',
  'FirewallMessages',
  'StagingItems',
]);

// Column names must be safe identifiers only
const VALID_COL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// Valid filter modes
const VALID_MODES = new Set(['contains', 'exact', 'starts']);

// ── POST /api/filter-records ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { tableName, col, mode, val } = req.body;

  // --- Input validation -------------------------------------------------------
  if (!tableName) {
    return res.status(400).json({ success: false, error: 'Missing required field: tableName' });
  }

  if (!ALLOWED_TABLES.has(tableName)) {
    return res.status(403).json({ success: false, error: `Table '${tableName}' is not permitted.` });
  }

  // col/mode/val are all-or-nothing: all three omitted means "unfiltered
  // TOP 500"; any one present without the other two is a 400, not silently
  // treated as unfiltered.
  const hasFilter = col !== undefined || mode !== undefined || (val !== undefined && val !== null);

  if (hasFilter && (!col || !mode || val === undefined || val === null)) {
    return res.status(400).json({ success: false, error: 'Missing required fields: col, mode, val' });
  }

  if (hasFilter && !VALID_COL_RE.test(col)) {
    return res.status(400).json({ success: false, error: 'Invalid column name.' });
  }

  if (hasFilter && !VALID_MODES.has(mode)) {
    return res.status(400).json({ success: false, error: 'Invalid filter mode. Use: contains, exact, starts.' });
  }

  // --- Build the parameterised LIKE / = pattern --------------------------------
  // The value is always passed as a SQL parameter (@val), never interpolated.
  // Only the LIKE wildcard prefix/suffix is added here (server-controlled).
  let sqlVal;
  let useEquals = false;

  if (hasFilter) {
    switch (mode) {
      case 'exact':
        sqlVal    = val;       // exact match — use = rather than LIKE
        useEquals = true;
        break;
      case 'starts':
        sqlVal = `${val}%`;   // starts-with LIKE pattern
        break;
      case 'contains':
      default:
        sqlVal = `%${val}%`;  // contains LIKE pattern
        break;
    }
  }

  // --- Determine SQL type for binding ----------------------------------------
  // We inspect the value to pick the most appropriate type.
  // For numeric values we attempt BigInt; otherwise NVarChar.
  const num = Number(val);
  const sqlType = (!isNaN(num) && Number.isInteger(num) && String(val).trim() !== '' && useEquals)
    ? sql.BigInt
    : sql.NVarChar(500);

  const operator = useEquals ? '=' : 'LIKE';

  // --- Execute ----------------------------------------------------------------
  // Table name and column name are safe: table from allowlist, col from regex.
  // Only sqlVal is a user-supplied value and it is always bound as @val.
  try {
    const { getPool, schema } = resolveLegacyTablePool(tableName);
    const pool    = await getPool();
    const request = pool.request();
    let query = `SELECT TOP 500 * FROM ${schema}.${tableName}`;
    if (hasFilter) {
      request.input('val', sqlType, useEquals && sqlType === sql.BigInt ? num : sqlVal);
      query += ` WHERE ${col} ${operator} @val`;
    }
    const result = await request.query(query);

    res.json({ success: true, recordset: result.recordset });
  } catch (err) {
    console.error('[filterrecords]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
