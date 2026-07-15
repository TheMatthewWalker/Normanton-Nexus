/**
 * routes/exportxlsx.js
 *
 * Builds and streams a multi-sheet .xlsx file containing:
 *   Sheet 1  — the main table (filtered or unfiltered, up to 10 000 rows)
 *   Sheet 2+ — one sheet per related sub-table, containing ALL matching rows
 *              across every record returned in Sheet 1.
 *
 * POST /api/export-xlsx
 * Body: {
 *   tableName  : string            — must be in ALLOWED_TABLES
 *   filter     : { col, mode, val } | null
 *   relations  : [{ table, pkCol, fkCol }]  — from the client DRILLDOWN map
 * }
 *
 * Requires exceljs:
 *   npm install exceljs
 *
 * Mount in server.js:
 *   import exportXlsxRoutes from './routes/exportxlsx.js';
 *   app.use('/api/export-xlsx', requireLogin, exportXlsxRoutes);
 */

import express  from 'express';
import sql      from 'mssql';
import ExcelJS  from 'exceljs';
import { sqlConfig } from '../config.js';

const router = express.Router();

// ── Allowlist ─────────────────────────────────────────────────────────────────
const ALLOWED_TABLES = new Set([
  'Batches', 'Ewald', 'Mixing', 'Extrusion', 'Convo', 'Firewall', 'Staging',
  'archive',
  'Coils', 'Trace', 'Waste',
  'EwaldBoxes', 'EwaldMessages', 'EwaldScrapDocs', 'EwaldWaste',
  'MixingMatDocs', 'MixingMessages', 'MixingWaste',
  'ExtrusionMessages', 'ExtrusionTrace', 'ExtrusionWaste',
  'ConvoMessages', 'ConvoTrace', 'ConvoWaste',
  'FirewallMessages', 'StagingItems',
  'ShipmentMain', 'PalletMain', 'DeliveryMain',
  'ShipmentLink', 'ShipmentCost', 'PalletPackages', 'DeliveryLink',
]);

const VALID_COL_RE   = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VALID_MODES    = new Set(['contains', 'exact', 'starts']);

// ── Styling constants ─────────────────────────────────────────────────────────
const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } }; // dark navy
const HEADER_FONT  = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; // white on dark header
const HEADER_ALIGN = { vertical: 'middle', horizontal: 'left' };
const BODY_FONT    = { name: 'Arial', size: 10, color: { argb: 'FF000000' } };              // black body text
const EVEN_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }; // white rows
const ODD_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF4' } }; // light grey-blue rows
const BORDER_STYLE = { style: 'thin', color: { argb: 'FFBFCAD4' } };                        // subtle grey border
const CELL_BORDER  = { top: BORDER_STYLE, bottom: BORDER_STYLE, left: BORDER_STYLE, right: BORDER_STYLE };

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a recordset to a worksheet with styled headers and alternating rows */
function writeSheet(ws, rows) {
  if (!rows || rows.length === 0) {
    ws.addRow(['No data found']);
    return;
  }

  const cols = Object.keys(rows[0]);

  // Header row
  const headerRow = ws.addRow(cols);
  headerRow.height = 22;
  headerRow.eachCell(cell => {
    cell.fill      = HEADER_FILL;
    cell.font      = HEADER_FONT;
    cell.alignment = HEADER_ALIGN;
    cell.border    = CELL_BORDER;
  });

  // Data rows
  rows.forEach((row, i) => {
    const values  = cols.map(c => {
      const v = row[c];
      // Keep dates as dates, coerce everything else to string or number
      if (v instanceof Date) return v;
      if (typeof v === 'number') return v;
      if (v === null || v === undefined) return '';
      return String(v);
    });
    const dataRow = ws.addRow(values);
    const fill    = i % 2 === 0 ? ODD_FILL : EVEN_FILL;
    dataRow.eachCell(cell => {
      cell.fill   = fill;
      cell.font   = BODY_FONT;
      cell.border = CELL_BORDER;
    });
  });

  // Auto-width columns (cap at 50 chars)
  ws.columns.forEach((col, idx) => {
    const header  = cols[idx] || '';
    let maxLen    = header.length;
    rows.forEach(row => {
      const v = row[cols[idx]];
      const l = v != null ? String(v).length : 0;
      if (l > maxLen) maxLen = l;
    });
    col.width = Math.min(maxLen + 3, 52);
  });

  // Auto-filter on all columns
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: cols.length },
  };

  // Freeze the header row
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/** Run a parameterised SELECT against a single table with an optional filter */
async function fetchTable(pool, tableName, filter, limit = 10000) {
  let result;
  if (!filter) {
    result = await pool.request()
      .query(`SELECT TOP ${limit} * FROM dbo.${tableName}`);
  } else {
    let sqlVal;
    switch (filter.mode) {
      case 'exact':  sqlVal = filter.val;           break;
      case 'starts': sqlVal = `${filter.val}%`;     break;
      default:       sqlVal = `%${filter.val}%`;    break;
    }
    const op = filter.mode === 'exact' ? '=' : 'LIKE';
    result = await pool.request()
      .input('val', sql.NVarChar(500), sqlVal)
      .query(`SELECT TOP ${limit} * FROM dbo.${tableName} WHERE ${filter.col} ${op} @val`);
  }
  return result.recordset || [];
}

/** Fetch related rows for a sub-table given a list of FK values */
async function fetchRelated(pool, tableName, fkCol, fkValues) {
  if (!fkValues || fkValues.length === 0) return [];

  // De-duplicate values
  const unique = [...new Set(fkValues.map(v => String(v ?? '')).filter(Boolean))];

  // SQL Server has a hard limit of 2100 parameters per RPC call.
  // Chunking into batches of 500 stays well within that limit even with
  // other parameters in play, and the results are merged in JS.
  const CHUNK = 500;
  const allRows = [];

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk      = unique.slice(i, i + CHUNK);
    const paramNames = chunk.map((_, j) => `@v${j}`).join(', ');
    const req        = pool.request();
    chunk.forEach((v, j) => req.input(`v${j}`, sql.NVarChar(256), v));

    const result = await req.query(
      `SELECT TOP 10000 * FROM dbo.${tableName} WHERE ${fkCol} IN (${paramNames})`
    );
    allRows.push(...(result.recordset || []));
  }

  return allRows;
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { tableName, filter, relations } = req.body;

  // --- Validate ---------------------------------------------------------------
  if (!tableName) {
    return res.status(400).json({ error: 'Missing tableName' });
  }
  if (!ALLOWED_TABLES.has(tableName)) {
    return res.status(403).json({ error: `Table '${tableName}' is not permitted.` });
  }
  if (filter) {
    if (!VALID_COL_RE.test(filter.col))     return res.status(400).json({ error: 'Invalid filter column.' });
    if (!VALID_MODES.has(filter.mode))      return res.status(400).json({ error: 'Invalid filter mode.' });
    if (typeof filter.val !== 'string')     return res.status(400).json({ error: 'Invalid filter value.' });
  }
  if (relations && !Array.isArray(relations)) {
    return res.status(400).json({ error: 'relations must be an array.' });
  }

  // Validate each relation entry
  const safeRelations = (relations || []).filter(r =>
    r && ALLOWED_TABLES.has(r.table) &&
    VALID_COL_RE.test(r.pkCol) &&
    VALID_COL_RE.test(r.fkCol)
  );

  try {
    const pool = await sql.connect(sqlConfig);

    // 1. Fetch main table data
    const mainRows = await fetchTable(pool, tableName, filter || null);

    // 2. For each relation, collect all unique PK values from the main rows
    //    then fetch the matching child rows in one IN query per sub-table
    const relatedData = [];
    for (const rel of safeRelations) {
      const pkValues = mainRows.map(r => r[rel.pkCol]).filter(v => v != null);
      const rows     = await fetchRelated(pool, rel.table, rel.fkCol, pkValues);
      relatedData.push({ rel, rows });
    }

    // 3. Build workbook
    const wb = new ExcelJS.Workbook();
    wb.creator  = 'Kongsberg Portal';
    wb.created  = new Date();

    // Sheet 1 — main table
    const mainSheet = wb.addWorksheet(tableName.substring(0, 31)); // Excel sheet name limit
    writeSheet(mainSheet, mainRows);

    // Sheets 2+ — related sub-tables (only if they have data or are expected)
    for (const { rel, rows } of relatedData) {
      const sheetName = rel.table.substring(0, 31);
      const ws        = wb.addWorksheet(sheetName);
      writeSheet(ws, rows);
    }

    // 4. Stream the file back
    const filename = `${tableName}_export_${new Date().toISOString().slice(0,10)}.xlsx`;
    res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('[exportxlsx]', err.message);
    // Only send JSON error if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

export default router;