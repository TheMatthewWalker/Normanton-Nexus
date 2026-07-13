import express from 'express';
import { runFullRefresh, runTurnsValClassRefresh } from '../routes/performancesync.js';
import * as sap from './performancesap.js';
import * as db  from './performancesql.js';
import sql from 'mssql';
import ExcelJS from 'exceljs';
import { sqlConfig, auditQuery } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

async function getPool() {
  return await sql.connect(sqlConfig);
}

const router = express.Router();

// ── Manual trigger for SAP refresh ─────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const results = await runFullRefresh(req);
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/refresh-log', async (req, res) => {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT TOP 20 * FROM dbo.RefreshLog ORDER BY RunId DESC
  `);
  res.json({ success: true, data: recordset });
});

router.get('/refresh-status', async (req, res) => {
  try {
    const datasets = ['Stock', 'Agreements', 'Invoicing', 'Otif'];
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT TOP 80 DatasetName, Status, CompletedAtUtc, ErrorMessage, RunId
      FROM dbo.RefreshLog
      WHERE DatasetName IN ('Stock', 'Agreements', 'Invoicing', 'Otif')
      ORDER BY RunId DESC
    `);

    const latest = {};

    for (const row of recordset) {
      if (!latest[row.DatasetName]) latest[row.DatasetName] = row;
    }

    const data = datasets.map(name => ({
      name,
      status: latest[name]?.Status || 'Missing',
      completedAtUtc: latest[name]?.CompletedAtUtc || null,
      errorMessage: latest[name]?.ErrorMessage || null
    }));

    const failures = data.filter(row => row.status !== 'Success');
    const completedTimes = data
      .filter(row => row.status === 'Success' && row.completedAtUtc)
      .map(row => new Date(row.completedAtUtc).getTime())
      .filter(time => !Number.isNaN(time));

    res.json({
      success: true,
      data: {
        lastRefreshUtc: failures.length || completedTimes.length !== datasets.length
          ? null
          : new Date(Math.max(...completedTimes)).toISOString(),
        failures,
        datasets: data
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Daily performance — the trend data ────────────────────────────────────
// This is the table the eventual graphs/metrics views should query. Never query the
// *Snapshot tables for trends — they only ever hold the latest pull.

router.get('/value-metrics', async (req, res) => {
  const pool = await getPool();

  const { recordset } = await pool.request().query(`
    SELECT MetricDate, ValueStream,
           InvoicedValue, StockValue, PickedValue
    FROM dbo.DailyPerformance
    ORDER BY MetricDate
  `);

  const result = {};

  for (const row of recordset) {
    const date = row.MetricDate.toISOString().substring(0, 10);
    const vs = row.ValueStream;

    if (!result[date]) result[date] = { date };

    if (!result[date][vs]) {
      result[date][vs] = {
        invoiced: 0,
        stock: 0,
        picked: 0
      };
    }

    result[date][vs].invoiced += row.InvoicedValue || 0;
    result[date][vs].stock += row.StockValue || 0;
    result[date][vs].picked += row.PickedValue || 0;
  }

  res.json({
    success: true,
    data: Object.values(result)
  });
});



router.get('/otif-metrics', async (req, res) => {
  const pool = await getPool();
  const unknownCentres = new Set();

  const { recordset } = await pool.request().query(`
    SELECT MetricDate, ValueStream,
           OtifOnTimeCount, OtifTotalCount
    FROM dbo.DailyPerformance
    ORDER BY MetricDate
  `);

  const result = {};

  for (const row of recordset) {
    const date = row.MetricDate.toISOString().substring(0, 10);
    const vs = row.ValueStream;

    if (!result[date]) result[date] = { date };

    if (!result[date][vs]) {
      result[date][vs] = {
        onTime: 0,
        total: 0,
        otif: 0
      };
    }

    result[date][vs].onTime += row.OtifOnTimeCount || 0;
    result[date][vs].total += row.OtifTotalCount || 0;

    const total = result[date][vs].total;

    result[date][vs].otif =
      total > 0
        ? result[date][vs].onTime / total
        : 0;
  }

  res.json({
    success: true,
    data: Object.values(result)
  });
});

// ── Order book summary ─────────────────────────────────────────────
router.get('/orderbook-summary', async (req, res, next) => {
  try {
    const rows = await db.getOrderBookSummary();

    res.json({
      success: true,
      data: rows.map(r => ({
        year: Number(r.Year),
        month: Number(r.Month),
        valueStream: r.ValueStream,

        orders: Number(r.OrdersValue || 0),
        stock: Number(r.StockValue || 0),
        picked: Number(r.PickedValue || 0)
      }))
    });

  } catch (err) {
    next(err);
  }
});

// ── Order book full breakdown (Customer > Order > Material) ─────────────────
router.get('/orderbook-breakdown', async (req, res, next) => {
  try {
    const rows = await db.getOrderBookBreakdown();

    res.json({
      success: true,
      data: rows.map(r => ({
        valueStream: r.ValueStream,
        customer: r.Customer,
        customerName: r.CustomerName || r.Customer,
        referenceDocument: r.ReferenceDocument,
        material: r.Material,
        materialText: r.MaterialText,
        requestDate: r.RequestDate ? new Date(r.RequestDate).toISOString().slice(0, 10) : null,

        orderQty: Number(r.OrderQty || 0),
        orderValue: Number(r.OrderValue || 0),
        stockQty: Number(r.StockQty || 0),
        stockValue: Number(r.StockValue || 0),
        pickedQty: Number(r.PickedQty || 0),
        pickedValue: Number(r.PickedValue || 0)
      }))
    });

  } catch (err) {
    next(err);
  }
});

// "On or before the current month" — same comparison the Month End
// Breakdown modal applies client-side (management.js isOnOrBeforeCurrentMonth),
// mirrored here so ?mode=monthEnd on the export applies the identical filter.
// Uses UTC accessors since RequestDate comes back from mssql as a UTC
// midnight Date (the SQL side truncates it via CONVERT(...,112), and this
// file's tedious config defaults to useUTC=true — see performancesql.js).
function isOnOrBeforeCurrentMonth(date) {
  if (!date) return false;

  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return false;

  const today = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const cy = today.getUTCFullYear();
  const cm = today.getUTCMonth() + 1;

  return y < cy || (y === cy && m <= cm);
}

// 1-based column index -> Excel letter ('A', 'B', ..., 'Z', 'AA', ...).
// Used to build cell references for the Stock/Picked Value formulas below —
// computed from ws.getColumn(key).number rather than hardcoded, so the
// formulas stay correct if the column order in ws.columns ever changes.
function excelColumnLetter(n) {
  let letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// ── Order book full breakdown — Excel export (Dashboard + Data) ─────────────
// ?mode=monthEnd applies the same on-or-before-current-month filter as the
// Breakdown for Month End modal; otherwise exports the full unfiltered
// dataset (same query as the JSON route above).
//
// Two sheets:
//   Dashboard — summary cards (Invoiced to date, Invoiced+Picked, Invoiced+
//   Potential Stock, and a Risk card). Every total except "Invoiced to date"
//   is a live SUMIFS/COUNTIFS formula against the Data sheet, scoped to
//   ValueStream = PTFE, so it recalculates as planners edit Stock Qty /
//   Picked Qty / Risk there. "Invoiced to date" comes from real SAP billing
//   documents (dbo.InvoiceSnapshot via dbo.DailyPerformance) — there's
//   nothing on the Data sheet to compute it from, so it's written as a plain
//   value, accurate as of the moment this file was generated.
//   Data — the row-level export (as before), plus two new blank columns:
//   Risk and Reason. Flagging a row "x" in Risk excludes its Stock Value
//   from the Invoiced + Potential Stock card and rolls it into the Risk
//   card instead ("we may or may not get it").
router.get('/orderbook-breakdown/export', async (req, res) => {
  try {
    const mode = req.query.mode === 'monthEnd' ? 'monthEnd' : 'full';

    let [rows, invoicedToDate] = await Promise.all([
      db.getOrderBookBreakdown(),
      db.getPtfeInvoicedMonthToDate()
    ]);

    if (mode === 'monthEnd') {
      rows = rows.filter(r => isOnOrBeforeCurrentMonth(r.RequestDate));
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kongsberg Portal';
    wb.created = new Date();

    // Dashboard added first so it lands as the left-most/active tab.
    const dashboardWs = wb.addWorksheet('Dashboard');
    const dataWs = wb.addWorksheet('Data');

    // ── Data sheet ────────────────────────────────────────────────────────
    dataWs.columns = [
      { header: 'Value Stream',  key: 'valueStream',       width: 14 },
      { header: 'Customer',      key: 'customer',          width: 14 },
      { header: 'Customer Name', key: 'customerName',      width: 30 },
      { header: 'Order',         key: 'referenceDocument', width: 14 },
      { header: 'Date',          key: 'requestDate',       width: 14 },
      { header: 'Material',      key: 'material',          width: 16 },
      { header: 'Order Qty',     key: 'orderQty',          width: 14 },
      { header: 'Order Value',   key: 'orderValue',        width: 14 },
      { header: 'Stock Qty',     key: 'stockQty',          width: 14 },
      { header: 'Stock Value',   key: 'stockValue',        width: 14 },
      { header: 'Picked Qty',    key: 'pickedQty',         width: 14 },
      { header: 'Picked Value',  key: 'pickedValue',       width: 14 },
      { header: 'Risk',          key: 'risk',              width: 8 },
      { header: 'Reason',        key: 'reason',            width: 34 },
      { header: 'Last Day',                key: 'lastDay',               width: 10 },
      { header: 'Last Day Time',           key: 'lastDayTime',           width: 14 },
      { header: 'Planned Production Qty',  key: 'plannedProductionQty',  width: 16 },
      { header: 'Planned Production Value',key: 'plannedProductionValue',width: 18 },
      { header: 'At Risk Seq',             key: 'atRiskSeq',             width: 10 }
    ];

    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    const headerFont = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    const border      = { style: 'thin', color: { argb: 'FFBFCAD4' } };
    const cellBorder  = { top: border, bottom: border, left: border, right: border };
    const oddFill     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const evenFill    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF4' } };
    // Pale yellow — flags Risk/Reason as the two columns planners type into.
    const inputFill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9DB' } };

    const headerRow = dataWs.getRow(1);
    headerRow.height = 22;
    headerRow.eachCell(cell => {
      cell.fill      = headerFill;
      cell.font      = headerFont;
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.border    = cellBorder;
    });

    // Stock Value / Picked Value are written as live formulas, not static
    // numbers — this file goes to planners who manually overwrite Stock Qty /
    // Picked Qty with expected month-end figures that haven't landed in SAP
    // yet, and the Value cells need to recalculate automatically as they type.
    // Formula mirrors the SQL-side valuation exactly (see getOrderBookBreakdown
    // in performancesql.js): qty * (OrderValue / OrderQty), guarded against
    // OrderQty = 0.
    const orderQtyCol    = excelColumnLetter(dataWs.getColumn('orderQty').number);
    const orderValueCol  = excelColumnLetter(dataWs.getColumn('orderValue').number);
    const stockQtyCol    = excelColumnLetter(dataWs.getColumn('stockQty').number);
    const stockValueCol  = excelColumnLetter(dataWs.getColumn('stockValue').number);
    const pickedQtyCol   = excelColumnLetter(dataWs.getColumn('pickedQty').number);
    const pickedValueCol = excelColumnLetter(dataWs.getColumn('pickedValue').number);
    const valueStreamCol = excelColumnLetter(dataWs.getColumn('valueStream').number);
    const riskCol        = excelColumnLetter(dataWs.getColumn('risk').number);
    const lastDayCol              = excelColumnLetter(dataWs.getColumn('lastDay').number);
    const lastDayTimeCol          = excelColumnLetter(dataWs.getColumn('lastDayTime').number);
    const plannedProductionQtyCol = excelColumnLetter(dataWs.getColumn('plannedProductionQty').number);
    const plannedProductionValueCol = excelColumnLetter(dataWs.getColumn('plannedProductionValue').number);
    const materialCol            = excelColumnLetter(dataWs.getColumn('material').number);
    const referenceDocumentCol   = excelColumnLetter(dataWs.getColumn('referenceDocument').number);
    const atRiskSeqCol           = excelColumnLetter(dataWs.getColumn('atRiskSeq').number);
    // Hidden running-count helper: numbers PTFE rows flagged Risk = "x" in the
    // order they appear (1, 2, 3…), so the Dashboard's At-Risk Lines list can
    // pull them out with plain INDEX/MATCH — no TEXTJOIN, no dynamic arrays,
    // no CSE. Works identically on every Excel version, unlike the old
    // array-formula approach.
    dataWs.getColumn('atRiskSeq').hidden = true;

    rows.forEach((r, i) => {
      const excelRow = i + 2; // header occupies row 1

      const row = dataWs.addRow({
        valueStream: r.ValueStream,
        customer: r.Customer,
        customerName: r.CustomerName || r.Customer,
        referenceDocument: r.ReferenceDocument,
        requestDate: r.RequestDate ? new Date(r.RequestDate).toISOString().slice(0, 10) : '',
        material: r.Material,
        orderQty: Number(r.OrderQty || 0),
        orderValue: Number(r.OrderValue || 0),
        stockQty: Number(r.StockQty || 0),
        pickedQty: Number(r.PickedQty || 0),
        risk: '',
        reason: '',
        lastDay: '',
        lastDayTime: '',
        // Defaults to Stock Qty — planners can overtype per line, but this way
        // the Value-by-Hour "Planned" bucket and the Invoiced + Planned card
        // aren't zero out of the box just because nobody's touched the column
        // yet.
        plannedProductionQty: Number(r.StockQty || 0)
        // stockValue / pickedValue / plannedProductionValue / atRiskSeq set as
        // formulas below.
      });

      row.getCell('stockValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${stockQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: Number(r.StockValue || 0)
      };
      row.getCell('pickedValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${pickedQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: Number(r.PickedValue || 0)
      };
      // Planned Production Value — same valuation formula as Stock/Picked Value,
      // but driven off Planned Production Qty (defaults to Stock Qty above, so
      // this starts out equal to Stock Value until a planner overtypes it).
      row.getCell('plannedProductionValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${plannedProductionQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: Number(r.StockValue || 0)
      };
      // Running count of PTFE rows flagged Risk = "x", in row order — the
      // Dashboard's At-Risk Lines list uses this with INDEX/MATCH to pull out
      // the 1st, 2nd, 3rd… flagged line. Blank ("") when this row isn't a
      // flagged PTFE row, so MATCH skips straight past it.
      row.getCell('atRiskSeq').value = {
        formula: `IF(AND(${valueStreamCol}${excelRow}="PTFE",${riskCol}${excelRow}="x"),COUNTIFS($${riskCol}$2:$${riskCol}${excelRow},"x",$${valueStreamCol}$2:$${valueStreamCol}${excelRow},"PTFE"),"")`,
        result: ''
      };

      // Risk is a manual flag ("x" = we may not actually get this stock) —
      // a dropdown keeps entries consistent, though SUMIFS/COUNTIFS on the
      // Dashboard match "x" case-insensitively regardless.
      row.getCell('risk').dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"x"']
      };
      row.getCell('risk').alignment   = { horizontal: 'center' };
      row.getCell('reason').alignment = { horizontal: 'left', vertical: 'top', wrapText: true };

      // Last Day — same "x" flag pattern as Risk: marks a line as due on the
      // last day of the month, with a free-text time next to it (kept as plain
      // text rather than an Excel time value so planners can write "TBC",
      // "AM", etc. as well as a clock time).
      row.getCell('lastDay').dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"x"']
      };
      row.getCell('lastDay').alignment     = { horizontal: 'center' };
      row.getCell('lastDayTime').alignment = { horizontal: 'center' };

      const fill = i % 2 === 0 ? oddFill : evenFill;
      row.eachCell(cell => {
        cell.fill   = fill;
        cell.font   = { name: 'Arial', size: 10, color: { argb: 'FF000000' } };
        cell.border = cellBorder;
      });

      // Override the alternating fill on every manual-entry column so they
      // stand out from the SAP-sourced / formula columns.
      row.getCell('risk').fill                  = inputFill;
      row.getCell('reason').fill                 = inputFill;
      row.getCell('lastDay').fill                = inputFill;
      row.getCell('lastDayTime').fill            = inputFill;
      row.getCell('plannedProductionQty').fill   = inputFill;
    });

    ['orderQty', 'stockQty', 'pickedQty', 'plannedProductionQty'].forEach(key => {
      dataWs.getColumn(key).numFmt = '#,##0';
    });
    ['orderValue', 'stockValue', 'pickedValue'].forEach(key => {
      dataWs.getColumn(key).numFmt = '#,##0.00';
    });

    dataWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: dataWs.columns.length } };
    dataWs.views = [{ state: 'frozen', ySplit: 1 }];

    // ── Dashboard sheet ──────────────────────────────────────────────────
    const dataStockRange  = `'Data'!$${stockValueCol}:$${stockValueCol}`;
    const dataPickedRange = `'Data'!$${pickedValueCol}:$${pickedValueCol}`;
    const dataStreamRange = `'Data'!$${valueStreamCol}:$${valueStreamCol}`;
    const dataRiskRange   = `'Data'!$${riskCol}:$${riskCol}`;
    const dataLastDayRange              = `'Data'!$${lastDayCol}:$${lastDayCol}`;
    const dataPlannedQtyRange           = `'Data'!$${plannedProductionQtyCol}:$${plannedProductionQtyCol}`;
    const dataPlannedValueRange         = `'Data'!$${plannedProductionValueCol}:$${plannedProductionValueCol}`;

    // Bounded (not full-column) ranges for the two array-style formulas below
    // (At-Risk Lines list, Value-by-Hour table) — SUMPRODUCT/TEXTJOIN over a
    // full column is needlessly slow, so these are capped generously past the
    // current row count to leave room for rows added later.
    const maxDataRow = Math.max(2000, rows.length + 500);
    const b = (col) => `'Data'!$${col}$2:$${col}$${maxDataRow}`;
    const dataStreamRangeB      = b(valueStreamCol);
    const dataRiskRangeB        = b(riskCol);
    const dataLastDayRangeB     = b(lastDayCol);
    const dataLastDayTimeRangeB = b(lastDayTimeCol);
    const dataStockRangeB       = b(stockValueCol);
    const dataPlannedValueRangeB      = b(plannedProductionValueCol);
    const dataReferenceDocumentRangeB = b(referenceDocumentCol);

    // Cached display values (Excel recalculates the live formulas on open) —
    // computed the same way the formulas will: no rows are flagged Risk yet
    // at export time, so the "potential stock" total starts out equal to the
    // full stock total and the Risk card starts at zero.
    const ptfeRows = rows.filter(r => r.ValueStream === 'PTFE');
    const pickedTotalPtfe    = ptfeRows.reduce((sum, r) => sum + Number(r.PickedValue || 0), 0);
    const stockTotalPtfe     = ptfeRows.reduce((sum, r) => sum + Number(r.StockValue  || 0), 0);
    const invoicedPlusPicked = invoicedToDate + pickedTotalPtfe;
    const invoicedPlusStock  = invoicedPlusPicked + stockTotalPtfe;

    dashboardWs.columns = [
      { key: 'a', width: 16 }, { key: 'b', width: 16 }, { key: 'c', width: 16 },
      { key: 'd', width: 16 }, { key: 'e', width: 16 }, { key: 'f', width: 16 }
    ];

    const titleFill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    const titleFont      = { name: 'Arial', bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    const subFont        = { name: 'Arial', italic: true, size: 10, color: { argb: 'FF666666' } };
    const cardLabelFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
    const cardLabelFont  = { name: 'Arial', bold: true, size: 10, color: { argb: 'FF1F3864' } };
    const cardValueFont  = { name: 'Arial', bold: true, size: 20, color: { argb: 'FF1F3864' } };
    const cardDescFont   = { name: 'Arial', italic: true, size: 9, color: { argb: 'FF666666' } };
    const riskLabelFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8CBAD' } };
    const riskLabelFont  = { name: 'Arial', bold: true, size: 10, color: { argb: 'FF9C0006' } };
    const riskValueFont  = { name: 'Arial', bold: true, size: 20, color: { argb: 'FFC00000' } };
    const centerMiddle   = { horizontal: 'center', vertical: 'middle', wrapText: true };

    function setMergedCell(range, value, font, fill, alignment) {
      dashboardWs.mergeCells(range);
      const cell = dashboardWs.getCell(range.split(':')[0]);
      cell.value = value;
      if (font) cell.font = font;
      if (fill) cell.fill = fill;
      cell.alignment = alignment || centerMiddle;
      return cell;
    }

    const monthLabel = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const modeLabel = mode === 'monthEnd' ? 'Month End Breakdown' : 'Full Breakdown';
    // Date + time, not just date — this is the one clock-in-time reference point
    // for every "as of the moment this file was generated" note on the sheet
    // (Invoiced to date, Risk/Last Day/Planned Production starting at their
    // export-time values), so it needs to be precise enough to tell two
    // exports from the same day apart.
    const generatedAt = new Date().toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    dashboardWs.getRow(1).height = 28;
    setMergedCell('A1:F1', 'PTFE Order Book Dashboard', titleFont, titleFill);
    dashboardWs.getRow(2).height = 18;
    setMergedCell('A2:F2', `${modeLabel} — generated ${generatedAt}`, subFont, null);

    // Card 1 — Invoiced to date
    setMergedCell('A4:F4', `INVOICED TO DATE (PTFE — ${monthLabel})`, cardLabelFont, cardLabelFill);
    dashboardWs.getRow(5).height = 30;
    const invoicedCell = setMergedCell('A5:F5', invoicedToDate, cardValueFont, null);
    invoicedCell.numFmt = '#,##0.00';
    setMergedCell('A6:F6', 'From SAP billing documents, as of the moment this file was generated — not a live formula.', cardDescFont, null);

    // Card 2 — Invoiced + Picked
    setMergedCell('A8:F8', 'INVOICED + PICKED (PTFE)', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(9).height = 30;
    const pickedCardCell = setMergedCell(
      'A9:F9',
      { formula: `$A$5+SUMIFS(${dataPickedRange},${dataStreamRange},"PTFE")`, result: invoicedPlusPicked },
      cardValueFont, null
    );
    pickedCardCell.numFmt = '#,##0.00';
    setMergedCell('A10:F10', 'Invoiced plus stock already picked — effectively secured.', cardDescFont, null);

    // Card 3 — Invoiced + Potential Stock. Stock Qty/Value already includes
    // picked stock (picked is a subset of stock, not additional to it), so
    // this does NOT also add Picked Value on top — that would double-count
    // whatever's already been picked.
    setMergedCell('A12:F12', 'INVOICED + POTENTIAL STOCK (PTFE)', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(13).height = 30;
    const stockCardCell = setMergedCell(
      'A13:F13',
      {
        formula: `$A$5+SUMIFS(${dataStockRange},${dataStreamRange},"PTFE",${dataRiskRange},"<>x")`,
        result: invoicedToDate + stockTotalPtfe
      },
      cardValueFont, null
    );
    stockCardCell.numFmt = '#,##0.00';
    setMergedCell('A14:F14', 'Full month-end prediction: invoiced + stock not flagged at risk on the Data tab. Stock Value already includes anything picked, so Picked Value isn\'t added again here.', cardDescFont, null);

    // Card 4 — Invoiced + Planned. Excludes rows flagged Last Day = "x" —
    // those are tracked separately in the Final Day Total card and the
    // Value-by-Hour table below, so they're deliberately left out here to
    // avoid double-counting them in both places.
    setMergedCell('A16:F16', 'INVOICED + PLANNED (PTFE)', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(17).height = 30;
    const plannedCardCell = setMergedCell(
      'A17:F17',
      {
        formula: `$A$5+SUMIFS(${dataPlannedValueRange},${dataStreamRange},"PTFE",${dataLastDayRange},"<>x")`,
        result: invoicedToDate + ptfeRows.filter(r => String(r.lastDay || '').toLowerCase() !== 'x').reduce((sum, r) => sum + Number(r.StockValue || 0), 0)
      },
      cardValueFont, null
    );
    plannedCardCell.numFmt = '#,##0.00';
    setMergedCell('A18:F18', 'Invoiced plus Planned Production Value for everything NOT flagged Last Day (those are in Final Day Total below instead).', cardDescFont, null);

    // Card 4b — Final Day Total. Invoiced + Planned above, plus whatever's
    // flagged Last Day on top — the true month-end grand total once the
    // final day's production lands.
    setMergedCell('A20:F20', 'FINAL DAY TOTAL (PTFE)', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(21).height = 30;
    const finalDayTotalCell = setMergedCell(
      'A21:F21',
      {
        formula: `$A$17+SUMIFS(${dataPlannedValueRange},${dataStreamRange},"PTFE",${dataLastDayRange},"x")`,
        result: 0
      },
      cardValueFont, null
    );
    finalDayTotalCell.numFmt = '#,##0.00';
    setMergedCell('A22:F22', 'Invoiced + Planned (above) plus the Planned Production Value of everything flagged Last Day — see the hour-by-hour breakdown below for when it lands.', cardDescFont, null);

    // Card 5 — Risk
    setMergedCell('A24:C24', 'VALUE AT RISK (PTFE)', riskLabelFont, riskLabelFill);
    setMergedCell('D24:F24', 'ITEMS FLAGGED (PTFE)', riskLabelFont, riskLabelFill);
    dashboardWs.getRow(25).height = 30;
    const riskValueCell = setMergedCell(
      'A25:C25',
      { formula: `SUMIFS(${dataStockRange},${dataStreamRange},"PTFE",${dataRiskRange},"x")`, result: 0 },
      riskValueFont, null
    );
    riskValueCell.numFmt = '#,##0.00';
    setMergedCell(
      'D25:F25',
      { formula: `COUNTIFS(${dataStreamRange},"PTFE",${dataRiskRange},"x")`, result: 0 },
      riskValueFont, null
    );
    setMergedCell('A26:F26', 'Flagged rows are excluded from Invoiced + Potential Stock above — we may or may not receive this stock. See the Risk / Reason columns on the Data tab for detail.', cardDescFont, null);

    // Card 6 — At-risk lines detail. Excel has no true "hover tooltip" that
    // can show live, formula-driven content (native cell comments only hold
    // static text), so this pairs a hyperlink to the filtered Data tab (works
    // on every Excel version) with a short static list of the flagged lines
    // themselves — built with plain INDEX/MATCH against the hidden "At Risk
    // Seq" helper column on the Data tab, not TEXTJOIN/dynamic arrays, so it
    // evaluates correctly on any Excel version (2007 and up), not just
    // 365/2021+.
    setMergedCell('A28:F28', 'AT-RISK LINES (PTFE)', cardLabelFont, cardLabelFill);
    setMergedCell(
      'A29:F29',
      { text: 'Open the Data tab and use the Risk column filter arrow to show every flagged row', hyperlink: "#'Data'!A1" },
      { name: 'Arial', size: 10, color: { argb: 'FF1F3864' }, underline: true },
      null,
      { horizontal: 'left', vertical: 'middle' }
    );

    const atRiskListStartRow = 30;
    const atRiskListCount = 10;
    for (let idx = 0; idx < atRiskListCount; idx++) {
      const r = atRiskListStartRow + idx;
      const n = idx + 1;
      dashboardWs.getRow(r).height = 15;
      dashboardWs.mergeCells(`A${r}:F${r}`);
      const cell = dashboardWs.getCell(`A${r}`);
      cell.value = {
        formula: `IFERROR(INDEX(Data!$${materialCol}:$${materialCol},MATCH(${n},Data!$${atRiskSeqCol}:$${atRiskSeqCol},0))&" | Order "&INDEX(Data!$${referenceDocumentCol}:$${referenceDocumentCol},MATCH(${n},Data!$${atRiskSeqCol}:$${atRiskSeqCol},0))&" | £"&TEXT(INDEX(Data!$${stockValueCol}:$${stockValueCol},MATCH(${n},Data!$${atRiskSeqCol}:$${atRiskSeqCol},0)),"#,##0.00"),"")`,
        result: ''
      };
      cell.font = { name: 'Arial', size: 9, color: { argb: 'FF444444' } };
      cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    }
    setMergedCell(
      `A${atRiskListStartRow + atRiskListCount}:F${atRiskListStartRow + atRiskListCount}`,
      `Shows the first ${atRiskListCount} flagged lines, in the order they appear on the Data tab — works on every Excel version. More than ${atRiskListCount}? Use the link above for the full list. Blank rows above just mean fewer than ${atRiskListCount} are flagged.`,
      cardDescFont, null
    );

    // Card 7 — Due on last day of the month
    setMergedCell('A42:C42', 'VALUE DUE (PTFE) — LAST DAY', cardLabelFont, cardLabelFill);
    setMergedCell('D42:F42', 'ITEMS DUE (PTFE) — LAST DAY', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(43).height = 30;
    const lastDayValueCell = setMergedCell(
      'A43:C43',
      { formula: `SUMIFS(${dataPlannedValueRange},${dataStreamRange},"PTFE",${dataLastDayRange},"x")`, result: 0 },
      cardValueFont, null
    );
    lastDayValueCell.numFmt = '#,##0.00';
    setMergedCell(
      'D43:F43',
      { formula: `COUNTIFS(${dataStreamRange},"PTFE",${dataLastDayRange},"x")`, result: 0 },
      cardValueFont, null
    );
    setMergedCell('A44:F44', 'What product, value and time is coming through on the last day of the month. Flag a row "x" in Last Day on the Data tab and fill in Last Day Time — filter the Data tab by Last Day to see the individual products and times.', cardDescFont, null);

    // Card 8 — Value-by-hour for Last Day items. Sourced from Planned
    // Production Value (column R) — that's the "expected production" figure,
    // not Stock Value, since Last Day items are typically not made yet.
    // ExcelJS can't create native embedded chart objects (no chart API), so
    // this pairs a live SUMPRODUCT column with Excel's built-in Data Bar
    // conditional formatting for an automatic in-cell visual. For a full axis
    // chart, select A47:C71 in Excel and Insert > Chart — a one-off manual
    // step since this file regenerates fresh on every export. Rows with Last
    // Day = "x" but no parseable Last Day Time default into the Hour 0 bucket
    // rather than being dropped.
    setMergedCell('A46:F46', 'LAST DAY — EXPECTED VALUE BY HOUR (PTFE)', cardLabelFont, cardLabelFill);

    const hourHeaderRow = 47;
    dashboardWs.getCell(`A${hourHeaderRow}`).value = 'Hour';
    dashboardWs.getCell(`B${hourHeaderRow}`).value = 'Expected Value (Planned Production)';
    dashboardWs.getCell(`C${hourHeaderRow}`).value = 'Cumulative Invoiced Total';
    [`A${hourHeaderRow}`, `B${hourHeaderRow}`, `C${hourHeaderRow}`].forEach(ref => {
      const cell = dashboardWs.getCell(ref);
      cell.font = cardLabelFont;
      cell.fill = cardLabelFill;
      cell.alignment = { horizontal: 'center', wrapText: true };
    });
    dashboardWs.mergeCells(`C${hourHeaderRow}:F${hourHeaderRow}`);

    const firstHourRow = hourHeaderRow + 1; // 48
    const lastHourRow = firstHourRow + 23;  // 71

    for (let hour = 0; hour <= 23; hour++) {
      const r = firstHourRow + hour;
      dashboardWs.getCell(`A${r}`).value = hour;
      dashboardWs.getCell(`A${r}`).alignment = { horizontal: 'center' };

      // Defaults an unparseable/blank Last Day Time to hour 0 (per-request
      // fallback), rather than the old -1 sentinel that silently dropped it
      // from every bucket.
      const valueCell = dashboardWs.getCell(`B${r}`);
      valueCell.value = {
        formula: `SUMPRODUCT((${dataStreamRangeB}="PTFE")*(${dataLastDayRangeB}="x")*(IFERROR(HOUR(${dataLastDayTimeRangeB}),0)=A${r})*${dataPlannedValueRangeB})`,
        result: 0
      };
      valueCell.numFmt = '#,##0.00';

      dashboardWs.mergeCells(`C${r}:F${r}`);
      const cumulativeCell = dashboardWs.getCell(`C${r}`);
      cumulativeCell.value = {
        formula: `$A$17+SUM($B$${firstHourRow}:B${r})`,
        result: 0
      };
      cumulativeCell.numFmt = '#,##0.00';
      cumulativeCell.font = { name: 'Arial', bold: true, size: 10, color: { argb: 'FF1F3864' } };
    }

    dashboardWs.addConditionalFormatting({
      ref: `B${firstHourRow}:B${lastHourRow}`,
      rules: [{
        type: 'dataBar',
        cfvo: [{ type: 'min' }, { type: 'max' }],
        color: { argb: 'FF638EC6' },
        priority: 1
      }]
    });

    const hourTableCaptionRow = lastHourRow + 1; // 72
    setMergedCell(
      `A${hourTableCaptionRow}:F${hourTableCaptionRow}`,
      'Data bars approximate a value-by-hour chart — this export can\'t embed a native Excel chart object. For a full axis chart, select A47:C71 and Insert > Chart. Blank/unrecognised Last Day Time defaults to the Hour 0 row.',
      cardDescFont, null
    );

    dashboardWs.views = [{ showGridLines: false }];
    wb.views = [{ activeTab: 0 }];

    const filenamePrefix = mode === 'monthEnd' ? 'orderbook_month_end' : 'orderbook_breakdown';
    const filename = `${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('[orderbook-breakdown/export]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: { message: err.message } });
    }
  }
});


// ══════════════════════════════════════════════════════════════════════════
// ── MM Turns / Valuation Class ───────────────────────────────────────────
// Reads come from dbo.TurnsValClassSnapshot / dbo.ValuationClassCatalog —
// the cached daily 05:45 pull, same as every other Performance* read here.
// The change-valuation-class action is the one exception: it's a live SAP
// write, so it goes straight to SapServer and is never served from cache.
// ══════════════════════════════════════════════════════════════════════════

// ── Manual trigger for the daily SAP pull ───────────────────────────────────
router.post('/turns-valclass/refresh', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const results = await runTurnsValClassRefresh(req);
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Full data table, with filtering ─────────────────────────────────────────
// Query params (all optional): plant, valuationClass, mrpController,
// materialType, profitCentre, search (matches Material or MaterialText).
router.get('/turns-valclass', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { plant, valuationClass, mrpController, materialType, profitCentre, search } = req.query;
    const pool = await getPool();
    const request = pool.request();

    const where = [];
    if (plant)          { where.push('Plant = @plant');                    request.input('plant', sql.VarChar(4), plant); }
    if (valuationClass) { where.push('ValuationClass = @valuationClass');   request.input('valuationClass', sql.VarChar(4), valuationClass); }
    if (mrpController)  { where.push('MrpController = @mrpController');    request.input('mrpController', sql.VarChar(3), mrpController); }
    if (materialType)   { where.push('MaterialType = @materialType');      request.input('materialType', sql.VarChar(4), materialType); }
    if (profitCentre)   { where.push('ProfitCentre = @profitCentre');      request.input('profitCentre', sql.VarChar(10), profitCentre); }
    if (search)          {
      where.push('(Material LIKE @search OR MaterialText LIKE @search)');
      request.input('search', sql.VarChar(42), `%${search}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Aliased to camelCase — mssql returns rows keyed by the raw column name when
    // there's no AS, and every bit of frontend code here expects camelCase (matching
    // the /aggregates, /value-by-price and /history routes, which already alias).
    const { recordset } = await request.query(`
      SELECT
        Material AS material, Plant AS plant, MaterialText AS materialText, CreatedDate AS createdDate,
        MaterialType AS materialType, Uom AS uom, ProfitCentre AS profitCentre,
        DeletionFlag AS deletionFlag, AbcIndicator AS abcIndicator, PurchasingGroup AS purchasingGroup,
        MrpController AS mrpController, ValuationClass AS valuationClass,
        LotSizeProcedure AS lotSizeProcedure, PlanningTimeFence AS planningTimeFence,
        GrProcessingTime AS grProcessingTime, TotalReplenishmentTime AS totalReplenishmentTime,
        SafetyStock AS safetyStock, MinLotSize AS minLotSize, MaxLotSize AS maxLotSize,
        FixedLotSize AS fixedLotSize, RoundingValue AS roundingValue,
        SpecialProcurementType AS specialProcurementType, PlannedDeliveryTime AS plannedDeliveryTime,
        StockQty AS stockQty, StockValue AS stockValue, UnitPrice AS unitPrice, BookValue AS bookValue,
        LastReceiptDate AS lastReceiptDate, LastGoodsIssueDate AS lastGoodsIssueDate,
        LastConsumptionDate AS lastConsumptionDate, LastGoodsMovementDate AS lastGoodsMovementDate,
        StockTurns AS stockTurns, DaysInStock AS daysInStock, DailyRequirementValue AS dailyRequirementValue,
        TurnoverCategory AS turnoverCategory, Warning AS warning,
        SnapshotAtUtc AS snapshotAtUtc
      FROM dbo.TurnsValClassSnapshot
      ${whereSql}
      ORDER BY Material
    `);

    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Aggregate / KPI tile ─────────────────────────────────────────────────────
router.get('/turns-valclass/aggregates', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getPool();

    const totals = await pool.request().query(`
      SELECT
        COUNT(*)                                              AS materialCount,
        SUM(StockValue)                                       AS totalStockValue,
        SUM(BookValue)                                        AS totalBookValue,
        SUM(CASE WHEN Warning IS NOT NULL AND Warning <> '' THEN 1 ELSE 0 END) AS warningCount,
        AVG(CASE WHEN StockTurns  IS NOT NULL THEN StockTurns  END)            AS avgStockTurns,
        AVG(CASE WHEN DaysInStock IS NOT NULL THEN DaysInStock END)            AS avgDaysInStock
      FROM dbo.TurnsValClassSnapshot
    `);

    const byTurnoverCategory = await pool.request().query(`
      SELECT TurnoverCategory AS category, COUNT(*) AS materialCount, SUM(StockValue) AS stockValue
      FROM dbo.TurnsValClassSnapshot
      GROUP BY TurnoverCategory
      ORDER BY stockValue DESC
    `);

    const byValuationClass = await pool.request().query(`
      SELECT ValuationClass AS valuationClass, COUNT(*) AS materialCount, SUM(StockValue) AS stockValue, SUM(BookValue) AS bookValue
      FROM dbo.TurnsValClassSnapshot
      GROUP BY ValuationClass
      ORDER BY stockValue DESC
    `);

    const byMaterialType = await pool.request().query(`
      SELECT MaterialType AS materialType, COUNT(*) AS materialCount, SUM(StockValue) AS stockValue
      FROM dbo.TurnsValClassSnapshot
      GROUP BY MaterialType
      ORDER BY stockValue DESC
    `);

    res.json({
      success: true,
      data: {
        totals: totals.recordset[0],
        byTurnoverCategory: byTurnoverCategory.recordset,
        byValuationClass: byValuationClass.recordset,
        byMaterialType: byMaterialType.recordset
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Stock value breakdown by unit price band ────────────────────────────────
router.get('/turns-valclass/value-by-price', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT
        CASE
          WHEN UnitPrice IS NULL      THEN '(no price)'
          WHEN UnitPrice < 1          THEN '£0 - £1'
          WHEN UnitPrice < 5          THEN '£1 - £5'
          WHEN UnitPrice < 20         THEN '£5 - £20'
          WHEN UnitPrice < 100        THEN '£20 - £100'
          WHEN UnitPrice < 500        THEN '£100 - £500'
          ELSE '£500+'
        END AS priceBand,
        CASE
          WHEN UnitPrice IS NULL      THEN 99
          WHEN UnitPrice < 1          THEN 0
          WHEN UnitPrice < 5          THEN 1
          WHEN UnitPrice < 20         THEN 2
          WHEN UnitPrice < 100        THEN 3
          WHEN UnitPrice < 500        THEN 4
          ELSE 5
        END AS sortOrder,
        COUNT(*)          AS materialCount,
        SUM(StockQty)     AS totalStockQty,
        SUM(StockValue)   AS totalStockValue
      FROM dbo.TurnsValClassSnapshot
      GROUP BY
        CASE
          WHEN UnitPrice IS NULL THEN '(no price)'
          WHEN UnitPrice < 1     THEN '£0 - £1'
          WHEN UnitPrice < 5     THEN '£1 - £5'
          WHEN UnitPrice < 20    THEN '£5 - £20'
          WHEN UnitPrice < 100   THEN '£20 - £100'
          WHEN UnitPrice < 500   THEN '£100 - £500'
          ELSE '£500+'
        END,
        CASE
          WHEN UnitPrice IS NULL THEN 99
          WHEN UnitPrice < 1     THEN 0
          WHEN UnitPrice < 5     THEN 1
          WHEN UnitPrice < 20    THEN 2
          WHEN UnitPrice < 100   THEN 3
          WHEN UnitPrice < 500   THEN 4
          ELSE 5
        END
      ORDER BY sortOrder
    `);

    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── History / forecast for given (or all) materials ─────────────────────────
// ?materials=MAT1,MAT2  — omit for all materials in the snapshot.
router.get('/turns-valclass/history', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    let whereSql = '';
    let materials = [];

    if (req.query.materials) {
      materials = String(req.query.materials).split(',').map(m => m.trim()).filter(Boolean);
      if (materials.length) {
        const inClause = materials.map((m, i) => {
          request.input(`m${i}`, sql.VarChar(18), m);
          return `@m${i}`;
        }).join(',');
        whereSql = `WHERE Material IN (${inClause})`;
      }
    }

    const { recordset } = await request.query(`
      SELECT
        Material, MaterialText, Plant, Uom,
        HistoryM12, HistoryM11, HistoryM10, HistoryM09, HistoryM08, HistoryM07,
        HistoryM06, HistoryM05, HistoryM04, HistoryM03, HistoryM02, HistoryM01, HistoryM00,
        ForecastM12, ForecastM11, ForecastM10, ForecastM09, ForecastM08, ForecastM07,
        ForecastM06, ForecastM05, ForecastM04, ForecastM03, ForecastM02, ForecastM01, ForecastM00,
        PredictedM12, PredictedM11, PredictedM10, PredictedM09, PredictedM08, PredictedM07,
        PredictedM06, PredictedM05, PredictedM04, PredictedM03, PredictedM02, PredictedM01, PredictedM00
      FROM dbo.TurnsValClassSnapshot
      ${whereSql}
      ORDER BY Material
    `);

    const data = recordset.map(r => ({
      material: r.Material,
      materialText: r.MaterialText,
      plant: r.Plant,
      uom: r.Uom,
      consumptionHistory: [
        r.HistoryM12, r.HistoryM11, r.HistoryM10, r.HistoryM09, r.HistoryM08, r.HistoryM07,
        r.HistoryM06, r.HistoryM05, r.HistoryM04, r.HistoryM03, r.HistoryM02, r.HistoryM01, r.HistoryM00
      ],
      demandForecast: [
        r.ForecastM12, r.ForecastM11, r.ForecastM10, r.ForecastM09, r.ForecastM08, r.ForecastM07,
        r.ForecastM06, r.ForecastM05, r.ForecastM04, r.ForecastM03, r.ForecastM02, r.ForecastM01, r.ForecastM00
      ],
      predictedUsage: [
        r.PredictedM12, r.PredictedM11, r.PredictedM10, r.PredictedM09, r.PredictedM08, r.PredictedM07,
        r.PredictedM06, r.PredictedM05, r.PredictedM04, r.PredictedM03, r.PredictedM02, r.PredictedM01, r.PredictedM00
      ]
    }));

    // ── Recorded accuracy overlay (dbo.ForecastAccuracyLog) ─────────────────────
    // What SAP demand and our prediction WERE for each of the last 12 months, frozen
    // as of right before each month started, alongside what actually happened — see
    // the table comment in create_performance_turnsvalclass_database.sql for the full
    // design. Aggregated server-side (SUM by TargetMonth) rather than returned per
    // material: with the material filter applied it's a no-op (one row per group
    // anyway), and with no filter (the "all materials" view) it collapses what could
    // be hundreds of thousands of rows down to ~13, matching how the frontend already
    // sums consumptionHistory/demandForecast across materials for that same view.
    const thisMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const fromMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 12, 1));

    const accuracyRequest = pool.request();
    accuracyRequest.input('fromMonth', sql.DateTime, fromMonth);
    accuracyRequest.input('toMonth', sql.DateTime, thisMonth);
    let accuracyWhereSql = 'WHERE TargetMonth >= @fromMonth AND TargetMonth <= @toMonth';

    if (materials.length) {
      const inClause = materials.map((m, i) => {
        accuracyRequest.input(`am${i}`, sql.VarChar(18), m);
        return `@am${i}`;
      }).join(',');
      accuracyWhereSql += ` AND Material IN (${inClause})`;
    }

    const { recordset: accuracyRows } = await accuracyRequest.query(`
      SELECT TargetMonth, SUM(SapDemandQty) AS SapDemandQty, SUM(PredictedQty) AS PredictedQty, SUM(ActualQty) AS ActualQty
      FROM dbo.ForecastAccuracyLog
      ${accuracyWhereSql}
      GROUP BY TargetMonth
      ORDER BY TargetMonth
    `);

    // Same 13-slot alignment as consumptionHistory: index 12 = current month, index 0 = 12 months ago.
    const recordedSapDemand = new Array(13).fill(null);
    const recordedPredicted = new Array(13).fill(null);
    const recordedActual    = new Array(13).fill(null);

    accuracyRows.forEach(r => {
      const targetMonth = new Date(r.TargetMonth);
      const monthsBack = (thisMonth.getUTCFullYear() - targetMonth.getUTCFullYear()) * 12
                        + (thisMonth.getUTCMonth() - targetMonth.getUTCMonth());
      if (monthsBack < 0 || monthsBack > 12) return;

      const idx = 12 - monthsBack;
      recordedSapDemand[idx] = r.SapDemandQty;
      recordedPredicted[idx] = r.PredictedQty;
      recordedActual[idx]    = r.ActualQty;
    });

    res.json({
      success: true,
      data,
      accuracy: { recordedSapDemand, recordedPredicted, recordedActual }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Valuation class catalog (cached) — for the change-valuation-class dropdown ──
router.get('/turns-valclass/valuation-classes', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    let whereSql = '';

    if (req.query.materialType) {
      whereSql = 'WHERE MaterialType = @materialType';
      request.input('materialType', sql.VarChar(4), req.query.materialType);
    }

    const { recordset } = await request.query(`
      SELECT ValuationClass AS valuationClass, MaterialType AS materialType,
             AccountRef AS accountRef, Description AS description
      FROM dbo.ValuationClassCatalog
      ${whereSql}
      ORDER BY ValuationClass
    `);

    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Change valuation class — LIVE SAP write, never served from cache ────────
// Body: { order, plant?, changes: [{ material, newValuationClass }, ...] }
router.post('/turns-valclass/change-valuation-class', requirePermission('LOG_MRP'), async (req, res) => {
  const { order, plant, changes } = req.body;

  if (!order || !Array.isArray(changes) || !changes.length) {
    return res.status(400).json({ success: false, error: 'order and at least one change are required.' });
  }

  const username = req.session?.user?.username || 'unknown';
  const userId   = req.session?.user?.userID || null;

  try {
    const result = await sap.postChangeValuationClass(req, { order, plant, changes });

    await db.logValuationClassChangeBatch({
      orderNumber: order,
      plant,
      userId,
      userName: username,
      success: result.success,
      totalValueChange: result.totalValueChange,
      errorMessage: result.errorMessage,
      results: result.results
    });

    await auditQuery('VALCLASS_CHANGE', username,
      `Order ${order}: ${changes.length} material(s), success=${result.success}`, req);

    res.json({ success: true, data: result });
  } catch (err) {
    // err.data is the structured ChangeValuationClassResponse SapServer returned
    // on a 422 pre-check failure — log it too, it's still a real attempt.
    if (err.data) {
      try {
        await db.logValuationClassChangeBatch({
          orderNumber: order,
          plant,
          userId,
          userName: username,
          success: false,
          totalValueChange: err.data.totalValueChange || 0,
          errorMessage: err.data.errorMessage || err.message,
          results: err.data.results || []
        });
      } catch (logErr) {
        console.error('Failed to log rejected valuation class change batch:', logErr.message);
      }

      return res.status(422).json({ success: false, error: { message: err.message }, data: err.data });
    }

    res.status(500).json({ success: false, error: { message: err.message } });
  }
});


export default router;
