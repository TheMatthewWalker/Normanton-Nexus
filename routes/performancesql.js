import sql from 'mssql';
import { sqlConfig } from '../config.js';


// ── Helpers ───────────────────────────────────────────────────────────────────


// Handles: ISO format "2026-06-07T12:00:00"
function toDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const [datePart] = value.split('T');
    const [y, m, d] = datePart.split('-').map(Number);

    return new Date(Date.UTC(y, m - 1, d));
  }
  return new Date(value);
}


// UTC midnight, not local: tedious defaults to useUTC=true, so a local-midnight
// Date during BST would be serialised as 23:00 the previous day in MetricDate.
function startOfDay(d) {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

// ── Pool ──────────────────────────────────────────────────────────────────────
// sql.connect() returns the global singleton pool for this config — the same pattern
// your working test used. No custom pool management needed; mssql handles reconnection
// internally, and since we're not using explicit transactions, a failed request returns
// its connection to the pool cleanly on its own.
async function getPool() {
  return await sql.connect(sqlConfig);
}

// ── Snapshot writes ───────────────────────────────────────────────────────────
// TRUNCATE then batch INSERT using the UNION ALL SELECT pattern — confirmed working
// against SQL Server 2005 via your test. No explicit transactions, no BCP bulk(),
// no temp tables. Each batch is one parameterised round-trip.
//
// Why no transaction around TRUNCATE + INSERTs:
//   SQL Server 2005 transaction handling through tedious leaves pool connections in a dirty
//   state when a transaction fails (the connection isn't cleanly reset before going back
//   to the pool). Since all four tables share the same pool, one failure cascades to all
//   subsequent operations. Without an explicit transaction, each request gets a clean
//   connection from the pool regardless of what happened to other requests.
//   Trade-off: a batch failure mid-insert leaves a partial table until the next refresh
//   runs. Given this data is refreshed 3x/day and errors are surfaced immediately, that
//   window is acceptable.
//
// Batch size = floor(2000 / columnCount) to stay under SQL Server's 2100-parameter limit.

async function replaceTable(tableName, columns, rows) {
  const pool = await getPool();

  await pool.request().query(`TRUNCATE TABLE ${tableName}`);

  if (rows.length === 0) return;

  const batchSize = Math.max(1, Math.floor(2000 / columns.length));
  const colList = columns.map(([colName]) => `[${colName}]`).join(', ');


  // ✅ filter out unmapped ValueStreams FIRST — but only for tables that actually
  // carry a ValueStream column. valueStream is stamped upstream
  // (performancevaluestream.js) from each record's own profitCentre; tables like
  // TurnsValClassSnapshot / ValuationClassCatalog have no such column and must
  // not have every row silently dropped for lacking one.
  if (columns.some(([colName]) => colName === 'ValueStream')) {
    const beforeCount = rows.length;
    rows = rows.filter(row => !!row.valueStream);

    if (rows.length < beforeCount) {
      console.warn(
        `[${tableName}] dropped ${beforeCount - rows.length} of ${beforeCount} row(s) ` +
        `with no ValueStream mapping (unmapped or missing profitCentre)`
      );
    }
  }

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const request = pool.request();
    const selectClauses = [];

    for (let rowIdx = 0; rowIdx < batch.length; rowIdx++) {
      const row = batch[rowIdx];
      const paramRefs = [];

      for (let colIdx = 0; colIdx < columns.length; colIdx++) {
        const [colName, key, type, transform, maxLen] = columns[colIdx];
        const paramName = `p${rowIdx}_${colIdx}`;

        let value = row[key];

        if (transform) {
          try { value = transform(value, row); }
          catch { value = null; }
        }

        if (type === sql.Bit) value = (value === true || value === 1) ? 1 : 0;
        if (value === undefined) value = null;

        if (typeof value === 'string' && maxLen && value.length > maxLen) {
          //console.warn(`✂️ TRUNCATING ${colName}`, value);
          value = value.substring(0, maxLen);
        }

        request.input(paramName, type, value);
        paramRefs.push(`@${paramName}`);
      }

      selectClauses.push(`SELECT ${paramRefs.join(', ')}`);
    }

    try {
      await request.query(
        `INSERT INTO ${tableName} (${colList})\n${selectClauses.join('\nUNION ALL\n')}`
      );
    } catch (err) {
      console.error('❌ INSERT FAILED:', {
        table: tableName,
        batchStart: i,
        error: err.message
      });

      // ✅ dump first bad row in batch
      console.error('🔴 SAMPLE BAD ROW:', batch[0]);

      throw err;
    }
  }
}

// ── Generic batched upsert ──────────────────────────────────────────────────
// For append-only tables (ForecastAccuracyLog) that must NOT be truncated — replaceTable()
// above only works for "latest pull replaces everything" snapshots. SQL Server 2005 has no
// MERGE statement (added in 2008), so this does the same job as one: build a staging set via
// the same parameterised UNION ALL SELECT pattern as replaceTable(), then run an UPDATE
// against whatever already matches on keyColumns, followed by an INSERT for whatever didn't.
// Two round-trips per batch instead of one, but no temp tables/transactions — same reasoning
// as replaceTable() (SQL Server 2005 connection-pool behaviour under failed transactions).
async function upsertBatch(tableName, keyColumns, columns, rows) {
  if (rows.length === 0) return;

  const pool = await getPool();
  const allColumns = [...keyColumns, ...columns];
  const batchSize = Math.max(1, Math.floor(2000 / allColumns.length));
  const keyJoin = keyColumns.map(([c]) => `t.[${c}] = s.[${c}]`).join(' AND ');
  const insertCols = allColumns.map(([c]) => `[${c}]`).join(', ');
  const insertVals = allColumns.map(([c]) => `s.[${c}]`).join(', ');
  const updateSet = columns.map(([c]) => `t.[${c}] = s.[${c}]`).join(', ');

  const buildStaging = (request, batch, paramPrefix) => {
    const selectClauses = [];

    for (let rowIdx = 0; rowIdx < batch.length; rowIdx++) {
      const row = batch[rowIdx];
      const parts = [];

      for (let colIdx = 0; colIdx < allColumns.length; colIdx++) {
        const [colName, key, type, transform] = allColumns[colIdx];
        const paramName = `${paramPrefix}${rowIdx}_${colIdx}`;
        let value = transform ? transform(row[key], row) : row[key];
        if (value === undefined) value = null;

        request.input(paramName, type, value);
        parts.push(`@${paramName} AS [${colName}]`);
      }

      selectClauses.push(`SELECT ${parts.join(', ')}`);
    }

    return selectClauses.join('\nUNION ALL\n');
  };

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    try {
      const updateRequest = pool.request();
      const updateStaging = buildStaging(updateRequest, batch, 'u');
      await updateRequest.query(`
        WITH staging AS (${updateStaging})
        UPDATE t SET ${updateSet}, LastUpdatedUtc = GETUTCDATE()
        FROM ${tableName} t
        INNER JOIN staging s ON ${keyJoin};
      `);

      // Separate request/param set — a request's inputs can only be bound to one query.
      const insertRequest = pool.request();
      const insertStaging = buildStaging(insertRequest, batch, 'i');
      await insertRequest.query(`
        WITH staging AS (${insertStaging})
        INSERT INTO ${tableName} (${insertCols})
        SELECT ${insertVals}
        FROM staging s
        LEFT JOIN ${tableName} t ON ${keyJoin}
        WHERE t.[${keyColumns[0][0]}] IS NULL;
      `);
    } catch (err) {
      console.error('❌ UPSERT FAILED:', { table: tableName, batchStart: i, error: err.message });
      console.error('🔴 SAMPLE BAD ROW:', batch[0]);
      throw err;
    }
  }
}

// ── Snapshot replace functions ────────────────────────────────────────────────

export function replaceStockSnapshot(rows) {
  return replaceTable('dbo.StockSnapshot', [
    ['Material',          'material',          sql.VarChar(18), null, 18],
    ['Batch',             'batch',             sql.VarChar(10), null, 10],
    ['StorageBin',        'storageBin',        sql.VarChar(10), null, 10],
    ['StorageType',       'storageType',       sql.VarChar(3), null, 3],
    ['TotalQty',          'totalQty',          sql.Decimal(15, 3)],
    ['AvailableQty',      'availableQty',      sql.Decimal(15, 3)],
    ['StorageLocation',   'storageLocation',   sql.VarChar(4), null, 4],
    ['PackagingMaterial', 'packagingMaterial', sql.VarChar(40), null, 40],
    ['ValueStream',       'valueStream',       sql.VarChar(8), null, 8]
  ], rows);
}

export function replaceAgreementSnapshot(rows) {
  return replaceTable('dbo.AgreementSnapshot', [
    ['ProfitCentre',         'profitCentre',       sql.VarChar(10), null, 10],
    ['Plant',                'plant',              sql.VarChar(4), null, 4],
    ['Mid',                  'mid',                sql.VarChar(48), null, 48],
    ['MrpController',        'mrpController',      sql.VarChar(3), null, 3],
    ['Material',             'material',           sql.VarChar(18), null, 18],
    ['MaterialText',         'materialText',       sql.VarChar(40), null, 40],
    ['ValueStream',          'valueStream',        sql.VarChar(8), null, 8],
    ['OnHandQty',            'onHandQty',          sql.Decimal(15, 3)],
    ['Uom',                  'uom',                sql.VarChar(3), null, 3],
    ['StandardPrice',        'standardPrice',      sql.Decimal(15, 2)],
    ['LocalCurrency',        'localCurrency',      sql.VarChar(5), null, 5],
    ['Customer',             'customer',           sql.VarChar(10), null, 10],
    ['CustomerGroup',        'customerGroup',      sql.VarChar(10), null, 10],
    ['CustomerName',         'customerName',       sql.VarChar(35), null, 35],
    ['OrderType',            'orderType',          sql.VarChar(4), null, 4],
    ['ReferenceDocument',    'referenceDocument',  sql.VarChar(10), null, 10],
    ['Item',                 'item',               sql.VarChar(6), null, 6],
    ['CustomerPo',           'customerPo',         sql.VarChar(20), null, 20],
    ['CustomerMaterial',     'customerMaterial',   sql.VarChar(35), null, 35],
    ['CustomerReference',    'customerReference',  sql.VarChar(30), null, 30],
    ['UnloadingPoint',       'unloadingPoint',     sql.VarChar(25), null, 25],
    ['RequestDate',          'requestDate',        sql.DateTime,      toDate],
    ['Week',                 'week',               sql.VarChar(6), null, 6],
    ['Period',               'period',             sql.VarChar(7), null, 7],
    ['OrderQty',             'orderQty',           sql.Decimal(15, 3)],
    // Amount is populated from localAmount (GBP/home-currency), not the raw
    // document-currency amount — the document amount isn't used anywhere in
    // this app, and every query here already reads from Amount, so this
    // avoids adding a parallel LocalAmount column that every query would
    // otherwise need to be switched over to.
    ['Amount',               'localAmount',        sql.Decimal(15, 2)],
    ['Currency',              'currency',          sql.VarChar(5), null, 5],
    ['DockStockAllocated',   'dockStockAllocated', sql.Decimal(15, 3)],
    ['PickedStockAllocated', 'pickedStockAllocated', sql.Decimal(15, 3)]
  ], rows);
}

export function replaceInvoiceSnapshot(rows) {
  return replaceTable('dbo.InvoiceSnapshot', [
    ['Plant',          'plant',          sql.VarChar(4), null, 4],
    ['SalesOrg',       'salesOrg',       sql.VarChar(4), null, 4],
    ['InvoiceDate',    'invoiceDate',    sql.DateTime,     toDate],
    ['InvoiceType',    'invoiceType',    sql.VarChar(4), null, 4],
    ['InvoiceNumber',  'invoiceNumber',  sql.VarChar(10), null, 10],
    ['DeliveryNote',   'deliveryNote',   sql.VarChar(10), null, 10],
    ['SalesAgreement', 'salesAgreement', sql.VarChar(10), null, 10],
    ['SalesItem',      'salesItem',      sql.VarChar(6), null, 6],
    ['CustomerPo',     'customerPo',     sql.VarChar(35), null, 35],
    ['CustomerGroup',  'customerGroup',  sql.VarChar(10), null, 10],
    ['Customer',       'customer',       sql.VarChar(10), null, 10],
    ['Material',       'material',       sql.VarChar(18), null, 18],
    ['MaterialText',   'materialText',   sql.VarChar(40), null, 40],
    ['Quantity',       'quantity',       sql.Decimal(15, 3)],
    ['DocumentAmount', 'documentAmount', sql.Decimal(15, 2)],
    ['LocalAmount',    'localAmount',    sql.Decimal(15, 2)],
    ['Currency',       'currency',       sql.VarChar(5), null, 5],
    ['ProfitCentre',   'profitCentre',   sql.VarChar(10), null, 10],
    ['Period',         'period',         sql.VarChar(7), null, 7],
    ['ValueStream',    'valueStream',    sql.VarChar(8), null, 8]
  ], rows);
}

export function replaceOtifSnapshot(rows) {
  return replaceTable('dbo.OtifSnapshot', [
    ['Customer',     'customer',     sql.VarChar(10), null, 10],
    ['CustomerName', 'customerName', sql.VarChar(35), null, 35],
    ['Plant',        'plant',        sql.VarChar(4), null, 4],
    ['ProfitCentre', 'profitCentre', sql.VarChar(10), null, 10],
    ['Material',     'material',     sql.VarChar(18), null, 18],
    ['MaterialText', 'materialText', sql.VarChar(40), null, 40],
    ['Delivery',     'delivery',     sql.VarChar(10), null, 10],
    ['DeliveryDate', 'deliveryDate', sql.DateTime,     toDate],
    ['DeliveryQty',  'deliveryQty',  sql.Decimal(15, 3)],
    ['Uom',          'uom',          sql.VarChar(3), null, 3],
    ['TargetDate',   'targetDate',   sql.DateTime,     toDate],
    ['TargetQty',    'targetQty',    sql.Decimal(15, 3)],
    ['QtyClass',     'qtyClass',     sql.VarChar(4), null, 4],
    ['DateClass',    'dateClass',    sql.VarChar(4), null, 4],
    ['OnTime',       'onTime',       sql.Bit],
    ['ValueStream',  'valueStream',  sql.VarChar(8), null, 8]
  ], rows);
}

// ── MM Turns / Valuation Class ──────────────────────────────────────────────
// history[n] / forecast[n] are flattened into 13 wide columns each (M12..M00,
// M12 = oldest/furthest-out, M00 = current partial month) so this can reuse
// the same TRUNCATE + UNION ALL batch-insert helper as every other snapshot.
function historyForecastCols(prefix, key) {
  const cols = [];
  for (let i = 0; i <= 12; i++) {
    const suffix = String(12 - i).padStart(2, '0'); // i=0 -> M12 (oldest), i=12 -> M00 (current)
    cols.push([
      `${prefix}M${suffix}`,
      key,
      sql.Decimal(15, 3),
      (_v, row) => Array.isArray(row[key]) ? (row[key][i] ?? null) : null
    ]);
  }
  return cols;
}

// SAP's MBEW (valuation) table carries one row per Material+Plant+ValuationType —
// for split-valuated materials (BWTAR non-blank on more than one valuation type)
// that's more than one row. BuildMaterialMasterRequest joins MARC to MBEW on
// WERKS = BWKEY only (no BWTAR filter/field), so a split-valuated material comes
// back from SAP as two-or-more TurnsValClassRow entries carrying the identical
// Material+Plant — which collide against PK_TurnsValClassSnapshot (Material, Plant).
// ConsumptionHistory/DemandForecast are looked up by material only on the SAP side,
// so duplicates carry identical history/forecast arrays (safe to take from either);
// StockQty/StockValue/BookValue are per-valuation-type and must be summed to get the
// true material+plant total, with UnitPrice recomputed from the summed totals.
// consignmentQty is NOT summed here (deliberately untouched, left exactly as the
// first-seen row carries it): unlike MBEW, MKOL isn't split by valuation type at
// all — SapServer's ComputeTurnsRows looks it up once per material and stamps the
// identical value onto every duplicate valuation-type row, so summing across
// duplicates here would double/triple-count real consignment stock.
export function dedupeTurnsValClassRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = `${row.material}|${row.plant}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, { ...row, _dupeCount: 1 });
      continue;
    }

    existing.stockQty   = (Number(existing.stockQty)   || 0) + (Number(row.stockQty)   || 0);
    existing.stockValue = (Number(existing.stockValue) || 0) + (Number(row.stockValue) || 0);
    existing.bookValue  = (Number(existing.bookValue)  || 0) + (Number(row.bookValue)  || 0);
    existing.unitPrice  = existing.stockQty > 0 ? existing.stockValue / existing.stockQty : existing.unitPrice;
    existing._dupeCount += 1;
  }

  const deduped = [...map.values()];
  const mergedCount = deduped.filter(r => r._dupeCount > 1).length;

  if (mergedCount > 0) {
    console.warn(
      `[TurnsValClassSnapshot] merged ${mergedCount} material(s) with multiple SAP valuation-type ` +
      `rows (split valuation) into single Material+Plant totals`
    );
  }

  deduped.forEach(r => delete r._dupeCount);
  return deduped;
}

export function replaceTurnsValClassSnapshot(rows) {
  return replaceTable('dbo.TurnsValClassSnapshot', [
    ['Material',               'material',               sql.VarChar(18), null, 18],
    ['Plant',                  'plant',                  sql.VarChar(4),  null, 4],
    ['MaterialText',           'materialText',           sql.VarChar(40), null, 40],
    ['CreatedDate',            'createdDate',            sql.DateTime,     toDate],
    ['MaterialType',           'materialType',           sql.VarChar(4),  null, 4],
    ['Uom',                    'uom',                    sql.VarChar(3),  null, 3],
    ['ProfitCentre',           'profitCentre',           sql.VarChar(10), null, 10],
    ['DeletionFlag',           'deletionFlag',           sql.Bit],
    ['AbcIndicator',           'abcIndicator',           sql.VarChar(1),  null, 1],
    ['PurchasingGroup',        'purchasingGroup',        sql.VarChar(3),  null, 3],
    ['MrpController',          'mrpController',          sql.VarChar(3),  null, 3],
    ['ValuationClass',         'valuationClass',         sql.VarChar(4),  null, 4],
    ['LotSizeProcedure',       'lotSizeProcedure',       sql.VarChar(2),  null, 2],
    ['PlanningTimeFence',      'planningTimeFence',      sql.Decimal(9, 0)],
    ['GrProcessingTime',       'grProcessingTime',       sql.Decimal(9, 2)],
    ['TotalReplenishmentTime', 'totalReplenishmentTime', sql.Decimal(9, 2)],
    ['SafetyStock',            'safetyStock',            sql.Decimal(15, 3)],
    ['MinLotSize',             'minLotSize',             sql.Decimal(15, 3)],
    ['MaxLotSize',             'maxLotSize',             sql.Decimal(15, 3)],
    ['FixedLotSize',           'fixedLotSize',           sql.Decimal(15, 3)],
    ['RoundingValue',          'roundingValue',          sql.Decimal(15, 3)],
    ['SpecialProcurementType', 'specialProcurementType', sql.VarChar(2),  null, 2],
    ['PlannedDeliveryTime',    'plannedDeliveryTime',    sql.Decimal(9, 2)],

    ['StockQty',               'stockQty',               sql.Decimal(15, 3)],
    ['ConsignmentQty',         'consignmentQty',         sql.Decimal(15, 3)],
    ['StockValue',             'stockValue',             sql.Decimal(18, 2)],
    ['UnitPrice',              'unitPrice',              sql.Decimal(15, 4)],
    ['BookValue',              'bookValue',              sql.Decimal(18, 2)],

    ...historyForecastCols('History', 'consumptionHistory'),
    ...historyForecastCols('Forecast', 'demandForecast'),
    // predictedUsage is attached to each row in performancesync.js (computePredictedUsage,
    // from performanceforecast.js) before this function is called — same 13-slot Current..+12
    // shape as demandForecast, so it reuses the same column-generation helper unchanged.
    ...historyForecastCols('Predicted', 'predictedUsage'),

    ['LastReceiptDate',        'lastReceiptDate',        sql.DateTime, toDate],
    ['LastGoodsIssueDate',     'lastGoodsIssueDate',     sql.DateTime, toDate],
    ['LastConsumptionDate',    'lastConsumptionDate',    sql.DateTime, toDate],
    ['LastGoodsMovementDate',  'lastGoodsMovementDate',  sql.DateTime, toDate],

    ['StockTurns',             'stockTurns',             sql.Decimal(15, 4)],
    ['DaysInStock',            'daysInStock',            sql.Decimal(15, 2)],
    ['DailyRequirementValue',  'dailyRequirementValue',  sql.Decimal(18, 4)],
    ['TurnoverCategory',       'turnoverCategory',       sql.VarChar(30), null, 30],
    ['Warning',                'warning',                sql.VarChar(200), null, 200]
  ], dedupeTurnsValClassRows(rows));
}

export function replaceValuationClassCatalog(rows) {
  return replaceTable('dbo.ValuationClassCatalog', [
    ['ValuationClass', 'valuationClass', sql.VarChar(4),  null, 4],
    ['MaterialType',   'materialType',   sql.VarChar(4),  null, 4],
    ['AccountRef',     'accountRef',     sql.VarChar(4),  null, 4],
    ['Description',    'description',    sql.VarChar(40), null, 40]
  ], rows);
}

// ── Forecast accuracy log ───────────────────────────────────────────────────
// Append-only — never truncated (see dbo.ForecastAccuracyLog comment in the SQL script for
// the full design rationale). Called once per sync, after predictedUsage has been attached
// to each row (see performancesync.js).
//
// Forward window (k = 0..12, current month through +12 months): upserts SapDemandQty and
// PredictedQty. Once a month passes out of this window it's simply never touched again by
// this loop on future days, which is what "freezes" the recorded forecast at whatever it
// last was right before the month started — no separate freeze step needed.
//
// Backward window (j = 0..2, current month through 2 months back only): upserts ActualQty
// from consumption history. Deliberately NOT the full 12-month backward window — once a
// month has fully closed, its actual consumption in MVER doesn't change, so there's no
// value in re-writing it every day forever. j=0..2 covers the current (still-accruing)
// month plus a small buffer for any late-posted consumption in the prior couple of months.
// Once a month's ActualQty has been written during this 3-month window, it just stays in
// the table indefinitely afterward (this table is never truncated), so it's still there
// whenever the M-12..M-1 section of the chart asks for it later.
function firstOfMonthUtc(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonthsUtc(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function firstOfDayUtc(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ── Stock valuation history ───────────────────────────────────────────────
// Append-only — never truncated (see dbo.StockValuationHistory comment in the SQL
// script for the full design rationale). Called once per sync, right alongside
// upsertForecastAccuracyLog above and for the same reason: TurnsValClassSnapshot
// itself is TRUNCATE + reinsert on every run (replaceTurnsValClassSnapshot), so
// without a separate append-only table there is no way to see stock quantity or
// value move over time — every day's figures simply overwrite the last.
//
// Deliberately narrow columns (Material, MaterialType, StockQty, StockValue,
// ConsignmentQty only) — kept lightweight on purpose, per the same reasoning as
// the SQL script: storing every TurnsValClassSnapshot column daily would multiply
// the storage cost of this history for no real benefit.
//
// Keyed on SnapshotDate = today at UTC midnight, so re-running the sync again on
// the same day updates today's row in place via upsertBatch rather than creating
// a duplicate — one row per material per plant per calendar day, forever.
export async function upsertStockValuationHistory(rows) {
  const snapshotDate = firstOfDayUtc(new Date());

  const historyRows = rows.map(row => ({
    material:       row.material,
    plant:          row.plant,
    snapshotDate,
    materialType:   row.materialType,
    stockQty:       row.stockQty,
    stockValue:     row.stockValue,
    consignmentQty: row.consignmentQty,
  }));

  const keyColumns = [
    ['Material',     'material',     sql.VarChar(18)],
    ['Plant',        'plant',        sql.VarChar(4)],
    ['SnapshotDate', 'snapshotDate', sql.DateTime],
  ];

  await upsertBatch('dbo.StockValuationHistory', keyColumns, [
    ['MaterialType',   'materialType',   sql.VarChar(4)],
    ['StockQty',       'stockQty',       sql.Decimal(15, 3)],
    ['StockValue',     'stockValue',     sql.Decimal(18, 2)],
    ['ConsignmentQty', 'consignmentQty', sql.Decimal(15, 3)],
  ], historyRows);
}

export async function upsertForecastAccuracyLog(rows) {
  const thisMonth = firstOfMonthUtc(new Date());

  const forecastRows = [];
  const actualRows   = [];

  for (const row of rows) {
    const demandForecast     = Array.isArray(row.demandForecast)     ? row.demandForecast     : [];
    const predictedUsage     = Array.isArray(row.predictedUsage)     ? row.predictedUsage     : [];
    const consumptionHistory = Array.isArray(row.consumptionHistory) ? row.consumptionHistory : [];

    for (let k = 0; k <= 12; k++) {
      forecastRows.push({
        material:     row.material,
        plant:        row.plant,
        targetMonth:  addMonthsUtc(thisMonth, k),
        sapDemandQty: Number(demandForecast[k]) || 0,
        predictedQty: Number(predictedUsage[k]) || 0,
      });
    }

    // consumptionHistory index 12 = current month, index (12-j) = j months back.
    for (let j = 0; j <= 2; j++) {
      const idx = 12 - j;
      if (idx < 0) continue;

      actualRows.push({
        material:    row.material,
        plant:       row.plant,
        targetMonth: addMonthsUtc(thisMonth, -j),
        actualQty:   Number(consumptionHistory[idx]) || 0,
      });
    }
  }

  const keyColumns = [
    ['Material',    'material',    sql.VarChar(18)],
    ['Plant',       'plant',       sql.VarChar(4)],
    ['TargetMonth', 'targetMonth', sql.DateTime],
  ];

  await upsertBatch('dbo.ForecastAccuracyLog', keyColumns, [
    ['SapDemandQty', 'sapDemandQty', sql.Decimal(15, 3)],
    ['PredictedQty', 'predictedQty', sql.Decimal(15, 3)],
  ], forecastRows);

  await upsertBatch('dbo.ForecastAccuracyLog', keyColumns, [
    ['ActualQty', 'actualQty', sql.Decimal(15, 3)],
  ], actualRows);
}

// ── Valuation class change audit ────────────────────────────────────────────
// Append-only — never truncated. One header row per POST, one detail row per
// material in that batch. Called from the /change-valuation-class route, not
// from the daily sync (this only ever has data when a user actually runs it).
export async function logValuationClassChangeBatch({ orderNumber, plant, userId, userName, success, totalValueChange, errorMessage, results }) {
  const pool = await getPool();

  const batchResult = await pool.request()
    .input('order',   sql.VarChar(12),  orderNumber)
    .input('plant',   sql.VarChar(4),   plant || null)
    .input('userId',  sql.Int,          userId || null)
    .input('userName',sql.VarChar(80),  userName || null)
    .input('success',   sql.Bit,          !!success)
    .input('totalChange',sql.Decimal(18, 2), totalValueChange || 0)
    .input('errorMessage', sql.VarChar(4000), errorMessage ? String(errorMessage).slice(0, 4000) : null)
    .query(`INSERT INTO dbo.ValuationClassChangeBatch
              (OrderNumber, Plant, RequestedByUserID, RequestedByName, Success, TotalValueChange, ErrorMessage)
            OUTPUT INSERTED.BatchID
            VALUES (@order, @plant, @userId, @userName, @success, @totalChange, @errorMessage)`);

  const batchId = batchResult.recordset[0].BatchID;

  for (const r of (results || [])) {
    await pool.request()
      .input('batchId',  sql.Int,           batchId)
      .input('material', sql.VarChar(18),   r.material)
      .input('materialText', sql.VarChar(40), r.materialText || null)
      .input('plant',    sql.VarChar(4),    r.plant || null)
      .input('stockQty', sql.Decimal(15, 3), r.stockQty || 0)
      .input('oldValClass', sql.VarChar(4), r.oldValuationClass || null)
      .input('newValClass', sql.VarChar(4), r.newValuationClass || null)
      .input('oldBookValue', sql.Decimal(18, 2), r.oldBookValue || 0)
      .input('newBookValue', sql.Decimal(18, 2), r.newBookValue || 0)
      .input('valueChange',  sql.Decimal(18, 2), r.valueChange  || 0)
      .input('success',      sql.Bit,            !!r.success)
      .input('message',      sql.VarChar(500),   (r.message || '').slice(0, 500))
      .query(`INSERT INTO dbo.ValuationClassChangeDetail
                (BatchID, Material, MaterialText, Plant, StockQty, OldValuationClass, NewValuationClass,
                 OldBookValue, NewBookValue, ValueChange, Success, Message)
              VALUES
                (@batchId, @material, @materialText, @plant, @stockQty, @oldValClass, @newValClass,
                 @oldBookValue, @newBookValue, @valueChange, @success, @message)`);
  }

  return batchId;
}

// ── Refresh log ───────────────────────────────────────────────────────────────

export async function startRefresh(datasetName) {
  const pool = await getPool();
  const result = await pool.request()
    .input('name', sql.VarChar(50), datasetName)
    .query(`INSERT INTO dbo.RefreshLog (DatasetName, StartedAtUtc, Status)
            OUTPUT INSERTED.RunId
            VALUES (@name, GETUTCDATE(), 'Running')`);
  return result.recordset[0].RunId;
}

export async function completeRefresh(runId, totalRows) {
  const pool = await getPool();
  await pool.request()
    .input('runId', sql.Int, runId)
    .input('totalRows', sql.Int, totalRows)
    .query(`UPDATE dbo.RefreshLog
            SET CompletedAtUtc = GETUTCDATE(), totalRows = @totalRows, Status = 'Success'
            WHERE RunId = @runId`);
}

export async function failRefresh(runId, message) {
  const pool = await getPool();
  await pool.request()
    .input('runId', sql.Int, runId)
    .input('message', sql.VarChar(4000), String(message ?? '').slice(0, 4000))
    .query(`UPDATE dbo.RefreshLog
            SET CompletedAtUtc = GETUTCDATE(), Status = 'Failed', ErrorMessage = @message
            WHERE RunId = @runId`);
}

// ── Daily fact table ──────────────────────────────────────────────────────────
// No temp tables and no transactions — both caused cascading failures with SQL Server 2005.
// Instead: SELECT the aggregated values from the snapshot table, then loop over the
// (small) result set doing a simple IF EXISTS UPDATE / ELSE INSERT per row.
// The number of distinct MetricDate+ValueStream combinations is small (hundreds at most),
// so one round-trip per distinct row is perfectly fine here.

export async function recomputeDailyInvoiced() {
  const pool = await getPool();

  const { recordset } = await pool.request().query(`
    SELECT
      CAST(CONVERT(VARCHAR(8), InvoiceDate, 112) AS DATETIME) AS MetricDate,
      ValueStream AS ValueStream,
      SUM(LocalAmount) AS InvoicedValue
    FROM dbo.InvoiceSnapshot
    WHERE InvoiceType <> 'F5'
    GROUP BY CONVERT(VARCHAR(8), InvoiceDate, 112), ValueStream
  `);

  for (const row of recordset) {
    await pool.request()
      .input('d',   sql.DateTime,    row.MetricDate)
      .input('vs',  sql.VarChar(8),  row.ValueStream)
      .input('val', sql.Decimal(18, 2), row.InvoicedValue || 0)
      .query(`
        IF EXISTS (SELECT 1 FROM dbo.DailyPerformance WHERE MetricDate = @d AND ValueStream = @vs)
          UPDATE dbo.DailyPerformance SET InvoicedValue = @val
          WHERE MetricDate = @d AND ValueStream = @vs
        ELSE
          INSERT INTO dbo.DailyPerformance (MetricDate, ValueStream, InvoicedValue)
          VALUES (@d, @vs, @val)
      `);
  }
}

export async function recomputeDailyOtif() {
  const pool = await getPool();

  const { recordset } = await pool.request().query(`
    SELECT
      CAST(CONVERT(VARCHAR(8), DeliveryDate, 112) AS DATETIME) AS MetricDate,
      ValueStream AS ValueStream,
      SUM(CASE WHEN OnTime = 1 THEN 1 ELSE 0 END) AS OtifOnTimeCount,
      COUNT(*) AS OtifTotalCount
    FROM dbo.OtifSnapshot
    GROUP BY CONVERT(VARCHAR(8), DeliveryDate, 112), ValueStream
  `);

  for (const row of recordset) {
    await pool.request()
      .input('d',          sql.DateTime,   row.MetricDate)
      .input('vs',         sql.VarChar(8), row.ValueStream)
      .input('onTime',     sql.Int,        row.OtifOnTimeCount || 0)
      .input('total',      sql.Int,        row.OtifTotalCount  || 0)
      .query(`
        IF EXISTS (SELECT 1 FROM dbo.DailyPerformance WHERE MetricDate = @d AND ValueStream = @vs)
          UPDATE dbo.DailyPerformance
          SET OtifOnTimeCount = @onTime, OtifTotalCount = @total
          WHERE MetricDate = @d AND ValueStream = @vs
        ELSE
          INSERT INTO dbo.DailyPerformance (MetricDate, ValueStream, OtifOnTimeCount, OtifTotalCount)
          VALUES (@d, @vs, @onTime, @total)
      `);
  }
}

// Stock/Picked: point-in-time only — write today's row on each refresh.
export async function upsertTodayStockAndPicked(totalsByValueStream) {
  const pool = await getPool();
  const today = startOfDay(new Date());

  for (const [valueStream, totals] of totalsByValueStream) {
    await pool.request()
      .input('d',      sql.DateTime,    today)
      .input('vs',     sql.VarChar(8),  valueStream)
      .input('stock',  sql.Decimal(18, 2), totals.stockValue  || 0)
      .input('picked', sql.Decimal(18, 2), totals.pickedValue || 0)
      .query(`
        IF EXISTS (SELECT 1 FROM dbo.DailyPerformance WHERE MetricDate = @d AND ValueStream = @vs)
          UPDATE dbo.DailyPerformance SET StockValue = @stock, PickedValue = @picked
          WHERE MetricDate = @d AND ValueStream = @vs
        ELSE
          INSERT INTO dbo.DailyPerformance (MetricDate, ValueStream, StockValue, PickedValue)
          VALUES (@d, @vs, @stock, @picked)
      `);
  }
}

// Orderbook: point-in-time only — write today's row on each refresh.

export async function getOrderBookSummary() {
  const pool = await getPool();

  const { recordset } = await pool.request().query(`
    SELECT
      DATEPART(YEAR, RequestDate)  AS [Year],
      DATEPART(MONTH, RequestDate) AS [Month],
      ValueStream,

      SUM(Amount) AS OrdersValue,

      SUM(
        CASE
          WHEN OrderQty > 0
          THEN DockStockAllocated * (Amount / OrderQty)
          ELSE 0
        END
      ) AS StockValue,

      SUM(
        CASE
          WHEN OrderQty > 0
          THEN PickedStockAllocated * (Amount / OrderQty)
          ELSE 0
        END
      ) AS PickedValue

    FROM dbo.AgreementSnapshot

    WHERE
      RequestDate IS NOT NULL
      AND ValueStream IN ('PTFE','PV')

    GROUP BY
      YEAR(RequestDate),
      MONTH(RequestDate),
      ValueStream

    ORDER BY
      YEAR(RequestDate),
      MONTH(RequestDate),
      ValueStream
  `);

  return recordset;
}

// Full breakdown for the Order Book "Full Breakdown" / "Breakdown for Month
// End" drill-downs — Date > Customer > ReferenceDocument (order) > Material,
// same stock/picked value-allocation logic as getOrderBookSummary
// (proportional to Amount/OrderQty), but also carries the raw quantities and
// the request date itself (rather than collapsing to year/month) since both
// modals need day-level detail: Full Breakdown nests it under Year > Month,
// and Month End Breakdown shows it inline next to each order.
//
// Note: SQL Server 2005 has no DATE type (added in 2008) — CAST(x AS DATE)
// throws "Type DATE is not a defined system type" against this DB. Every
// other date-truncation in this file already works around that via
// CONVERT(VARCHAR(8), x, 112) (yyyymmdd) re-cast to DATETIME — see
// recomputeDailyInvoiced()/recomputeDailyOtif() above — so this reuses the
// same idiom instead of DATE.
export async function getOrderBookBreakdown() {
  const pool = await getPool();

  const { recordset } = await pool.request().query(`
    SELECT
      ValueStream,
      Customer,
      CustomerName,
      ReferenceDocument,
      Material,
      MaterialText,
      CAST(CONVERT(VARCHAR(8), RequestDate, 112) AS DATETIME) AS RequestDate,

      SUM(OrderQty) AS OrderQty,
      SUM(Amount)   AS OrderValue,

      SUM(DockStockAllocated) AS StockQty,
      SUM(
        CASE
          WHEN OrderQty > 0
          THEN DockStockAllocated * (Amount / OrderQty)
          ELSE 0
        END
      ) AS StockValue,

      SUM(PickedStockAllocated) AS PickedQty,
      SUM(
        CASE
          WHEN OrderQty > 0
          THEN PickedStockAllocated * (Amount / OrderQty)
          ELSE 0
        END
      ) AS PickedValue

    FROM dbo.AgreementSnapshot

    WHERE
      RequestDate IS NOT NULL
      AND ValueStream IN ('PTFE','PV')

    GROUP BY
      ValueStream, Customer, CustomerName, ReferenceDocument, Material, MaterialText,
      CONVERT(VARCHAR(8), RequestDate, 112)

    ORDER BY
      CONVERT(VARCHAR(8), RequestDate, 112), CustomerName, ReferenceDocument, MaterialText
  `);

  return recordset;
}

// ── PTFE invoiced value, current calendar month ─────────────────────────────
// Feeds the Dashboard sheet on the order-book Excel export ("Invoiced to
// date" card). Pulled from dbo.DailyPerformance — the daily fact table
// populated by recomputeDailyInvoiced() from real SAP billing documents
// (dbo.InvoiceSnapshot) — NOT from AgreementSnapshot/getOrderBookBreakdown,
// which only covers open order-book lines and has no invoiced figures at all.
// Scoped to PTFE only and to the current month (YEAR/MONTH, not a DATE cast —
// see the SQL Server 2005 note above) per the dashboard's intended scope.
export async function getPtfeInvoicedMonthToDate() {
  const pool = await getPool();

  const { recordset } = await pool.request().query(`
    SELECT SUM(InvoicedValue) AS InvoicedToDate
    FROM dbo.DailyPerformance
    WHERE ValueStream = 'PTFE'
      AND YEAR(MetricDate) = YEAR(GETDATE())
      AND MONTH(MetricDate) = MONTH(GETDATE())
  `);

  return Number(recordset[0]?.InvoicedToDate || 0);
}

// ══════════════════════════════════════════════════════════════════════════
// Vendor master data (MRP Phase 2) — dbo.Vendor / dbo.VendorMaterial
// ══════════════════════════════════════════════════════════════════════════
// Manually-maintained business data (lead time, Incoterms, MOQ), NOT sourced
// from SAP — see sql/migrate_vendor_master_data.sql for why. Plain parameterised
// queries throughout (this is small, hand-edited admin data — a handful of rows
// per call — not the bulk snapshot tables above, so none of the batched
// replaceTable()/upsertBatch() machinery is needed here).

export async function listVendors() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT
      v.VendorId, v.VendorName, v.Incoterms, v.OrderMoqQty, v.OrderMaxQty, v.OrderMoqUom,
      v.DefaultLeadTimeDays, v.TransitTimeDays, v.Notes, v.CreatedAtUtc, v.UpdatedAtUtc,
      (SELECT COUNT(*) FROM dbo.VendorMaterial vm WHERE vm.VendorId = v.VendorId) AS MaterialCount
    FROM dbo.Vendor v
    ORDER BY v.VendorName
  `);
  return recordset;
}

export async function createVendor({ vendorName, incoterms, orderMoqQty, orderMaxQty, orderMoqUom, defaultLeadTimeDays, transitTimeDays, notes }) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('vendorName',          sql.NVarChar(80),  vendorName)
    .input('incoterms',           sql.NVarChar(3),   incoterms || null)
    .input('orderMoqQty',         sql.Decimal(15, 3), orderMoqQty ?? null)
    .input('orderMaxQty',         sql.Decimal(15, 3), orderMaxQty ?? null)
    .input('orderMoqUom',         sql.NVarChar(3),   orderMoqUom || null)
    .input('defaultLeadTimeDays', sql.Decimal(9, 2), defaultLeadTimeDays ?? null)
    .input('transitTimeDays',     sql.Decimal(9, 2), transitTimeDays ?? null)
    .input('notes',               sql.NVarChar(500), notes || null)
    .query(`
      INSERT INTO dbo.Vendor (VendorName, Incoterms, OrderMoqQty, OrderMaxQty, OrderMoqUom, DefaultLeadTimeDays, TransitTimeDays, Notes)
      OUTPUT INSERTED.VendorId
      VALUES (@vendorName, @incoterms, @orderMoqQty, @orderMaxQty, @orderMoqUom, @defaultLeadTimeDays, @transitTimeDays, @notes)
    `);
  return recordset[0].VendorId;
}

export async function updateVendor(vendorId, { vendorName, incoterms, orderMoqQty, orderMaxQty, orderMoqUom, defaultLeadTimeDays, transitTimeDays, notes }) {
  const pool = await getPool();
  await pool.request()
    .input('vendorId',            sql.Int,           vendorId)
    .input('vendorName',          sql.NVarChar(80),  vendorName)
    .input('incoterms',           sql.NVarChar(3),   incoterms || null)
    .input('orderMoqQty',         sql.Decimal(15, 3), orderMoqQty ?? null)
    .input('orderMaxQty',         sql.Decimal(15, 3), orderMaxQty ?? null)
    .input('orderMoqUom',         sql.NVarChar(3),   orderMoqUom || null)
    .input('defaultLeadTimeDays', sql.Decimal(9, 2), defaultLeadTimeDays ?? null)
    .input('transitTimeDays',     sql.Decimal(9, 2), transitTimeDays ?? null)
    .input('notes',               sql.NVarChar(500), notes || null)
    .query(`
      UPDATE dbo.Vendor SET
        VendorName = @vendorName, Incoterms = @incoterms,
        OrderMoqQty = @orderMoqQty, OrderMaxQty = @orderMaxQty, OrderMoqUom = @orderMoqUom,
        DefaultLeadTimeDays = @defaultLeadTimeDays, TransitTimeDays = @transitTimeDays, Notes = @notes,
        UpdatedAtUtc = GETUTCDATE()
      WHERE VendorId = @vendorId
    `);
}

// Deletes the vendor's material assignments first — SQL Server 2005 will
// otherwise reject the delete outright on the FK_VendorMaterial_Vendor
// constraint. Done as two explicit statements (not ON DELETE CASCADE on the
// FK) so this is visible/auditable in one place rather than an implicit DB
// side-effect — same reasoning as the rest of this file's "no transactions,
// explicit steps" approach (see the big comment above replaceTable()).
export async function deleteVendor(vendorId) {
  const pool = await getPool();
  await pool.request().input('vendorId', sql.Int, vendorId)
    .query('DELETE FROM dbo.VendorMaterial WHERE VendorId = @vendorId');
  await pool.request().input('vendorId', sql.Int, vendorId)
    .query('DELETE FROM dbo.Vendor WHERE VendorId = @vendorId');
}

// Joined with TurnsValClassSnapshot so the admin page can show material
// description, MRP controller and SAP's own PLIFZ lead time alongside each
// assignment without a second round-trip. LEFT JOIN, not INNER — a material
// can be assigned to a vendor before/without ever having synced into
// TurnsValClassSnapshot (e.g. newly set up in SAP, not yet in the plant's
// material master pull), and should still show up here rather than vanish.
export async function listVendorMaterials(vendorId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('vendorId', sql.Int, vendorId)
    .query(`
      SELECT
        vm.VendorMaterialId, vm.VendorId, vm.Material, vm.MaterialMoqQty, vm.MaterialMaxQty,
        vm.LeadTimeDaysOverride, vm.MinSafetyStockQty, vm.ScheduleAgreement, vm.SourceHint,
        t.MaterialText, t.MrpController, t.PlannedDeliveryTime AS SapLeadTimeDays, t.SafetyStock AS SapSafetyStock
      FROM dbo.VendorMaterial vm
      LEFT JOIN dbo.TurnsValClassSnapshot t ON t.Material = vm.Material
      WHERE vm.VendorId = @vendorId
      ORDER BY vm.Material
    `);
  return recordset;
}

export async function addVendorMaterial(vendorId, { material, materialMoqQty, materialMaxQty, leadTimeDaysOverride, minSafetyStockQty, scheduleAgreement, sourceHint }) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('vendorId',             sql.Int,            vendorId)
    .input('material',             sql.NVarChar(18),   material)
    .input('materialMoqQty',       sql.Decimal(15, 3), materialMoqQty ?? null)
    .input('materialMaxQty',       sql.Decimal(15, 3), materialMaxQty ?? null)
    .input('leadTimeDaysOverride', sql.Decimal(9, 2),  leadTimeDaysOverride ?? null)
    .input('minSafetyStockQty',    sql.Decimal(15, 3), minSafetyStockQty ?? null)
    .input('scheduleAgreement',    sql.NVarChar(10),   scheduleAgreement || null)
    .input('sourceHint',           sql.NVarChar(40),   sourceHint || null)
    .query(`
      INSERT INTO dbo.VendorMaterial (VendorId, Material, MaterialMoqQty, MaterialMaxQty, LeadTimeDaysOverride, MinSafetyStockQty, ScheduleAgreement, SourceHint)
      OUTPUT INSERTED.VendorMaterialId
      VALUES (@vendorId, @material, @materialMoqQty, @materialMaxQty, @leadTimeDaysOverride, @minSafetyStockQty, @scheduleAgreement, @sourceHint)
    `);
  return recordset[0].VendorMaterialId;
}

export async function updateVendorMaterial(vendorMaterialId, { materialMoqQty, materialMaxQty, leadTimeDaysOverride, minSafetyStockQty, scheduleAgreement }) {
  const pool = await getPool();
  await pool.request()
    .input('vendorMaterialId',     sql.Int,            vendorMaterialId)
    .input('materialMoqQty',       sql.Decimal(15, 3), materialMoqQty ?? null)
    .input('materialMaxQty',       sql.Decimal(15, 3), materialMaxQty ?? null)
    .input('leadTimeDaysOverride', sql.Decimal(9, 2),  leadTimeDaysOverride ?? null)
    .input('minSafetyStockQty',    sql.Decimal(15, 3), minSafetyStockQty ?? null)
    .input('scheduleAgreement',    sql.NVarChar(10),   scheduleAgreement || null)
    .query(`
      UPDATE dbo.VendorMaterial SET
        MaterialMoqQty = @materialMoqQty, MaterialMaxQty = @materialMaxQty,
        LeadTimeDaysOverride = @leadTimeDaysOverride,
        MinSafetyStockQty = @minSafetyStockQty,
        ScheduleAgreement = @scheduleAgreement, UpdatedAtUtc = GETUTCDATE()
      WHERE VendorMaterialId = @vendorMaterialId
    `);
}

export async function deleteVendorMaterial(vendorMaterialId) {
  const pool = await getPool();
  await pool.request().input('vendorMaterialId', sql.Int, vendorMaterialId)
    .query('DELETE FROM dbo.VendorMaterial WHERE VendorMaterialId = @vendorMaterialId');
}

// ── Order suggestions (MRP Phase 2b) ──────────────────────────────────────────────────
// See sql/migrate_order_suggestions.sql for the full design writeup. This
// file only holds the data layer: the live "what needs ordering" computation
// itself lives in routes/performance.js (computeOrderSuggestions), which
// calls listVendorMaterialsForSuggestions()/listOpenIncomingOrders() below and
// does the forecasting math in JS, the same pattern already used by the
// /turns-valclass/history route's weekly stock forecast.

// One row per vendor+material assignment, joined with everything the
// suggestion engine needs from TurnsValClassSnapshot: stock, predicted usage,
// SAP's own lead time (PLIFZ) and safety stock (EISBE) as fallbacks for the
// VendorMaterial-level overrides. LEFT JOIN — a material can be assigned to a
// vendor without (yet) having synced into TurnsValClassSnapshot; those rows
// come back with NULL stock/usage and computeOrderSuggestions skips them
// (nothing to compute without SAP data).
export async function listVendorMaterialsForSuggestions() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT
      vm.VendorMaterialId, vm.VendorId, vm.Material, vm.MaterialMoqQty, vm.MaterialMaxQty,
      vm.LeadTimeDaysOverride, vm.MinSafetyStockQty, vm.ScheduleAgreement,
      v.VendorName, v.Incoterms, v.OrderMoqQty, v.OrderMaxQty, v.OrderMoqUom,
      v.DefaultLeadTimeDays, v.TransitTimeDays,
      t.MaterialText, t.Uom, t.MrpController, t.StockQty, t.ConsignmentQty,
      t.SafetyStock AS SapSafetyStock, t.PlannedDeliveryTime AS SapLeadTimeDays,
      t.PredictedM12, t.PredictedM11, t.PredictedM10, t.PredictedM09, t.PredictedM08, t.PredictedM07,
      t.PredictedM06, t.PredictedM05, t.PredictedM04, t.PredictedM03, t.PredictedM02, t.PredictedM01, t.PredictedM00
    FROM dbo.VendorMaterial vm
    JOIN dbo.Vendor v ON v.VendorId = vm.VendorId
    LEFT JOIN dbo.TurnsValClassSnapshot t ON t.Material = vm.Material
    ORDER BY vm.Material
  `);
  return recordset;
}

// Open (not yet Received/Cancelled) accepted orders — used two ways:
//  - computeOrderSuggestions() calls this with no filter to net "already
//    incoming" quantity off the shortfall so a material already on order
//    doesn't keep getting re-suggested.
//  - the /turns-valclass/history route calls this scoped to the materials
//    already resolved for that request, to bump the weekly stock-forecast
//    chart with expected deliveries.
export async function listOpenIncomingOrders(materials = null) {
  const pool = await getPool();
  const request = pool.request();
  let whereSql = "WHERE Status IN ('Accepted', 'Ordered')";
  if (materials && materials.length) {
    const inClause = materials.map((m, i) => {
      request.input(`im${i}`, sql.NVarChar(18), m);
      return `@im${i}`;
    }).join(',');
    whereSql += ` AND Material IN (${inClause})`;
  }
  const { recordset } = await request.query(`
    SELECT Material, OrderQty, DeliveryDate, Status
    FROM dbo.PurchaseOrderSuggestion
    ${whereSql}
  `);
  return recordset;
}

export async function acceptOrderSuggestion({
  vendorMaterialId, vendorId, material, suggestedQty, orderQty, orderDate,
  leadTimeDaysUsed, deliveryDate, transitTimeDaysUsed, readyToCollectDate, isSpotPo, notes
}) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('vendorMaterialId',      sql.Int,            vendorMaterialId)
    .input('vendorId',              sql.Int,            vendorId)
    .input('material',              sql.NVarChar(18),   material)
    .input('suggestedQty',          sql.Decimal(15, 3), suggestedQty ?? null)
    .input('orderQty',              sql.Decimal(15, 3), orderQty)
    .input('orderDate',             sql.DateTime,       orderDate)
    .input('leadTimeDaysUsed',      sql.Decimal(9, 2),  leadTimeDaysUsed ?? null)
    .input('deliveryDate',          sql.DateTime,       deliveryDate ?? null)
    .input('transitTimeDaysUsed',   sql.Decimal(9, 2),  transitTimeDaysUsed ?? null)
    .input('readyToCollectDate',    sql.DateTime,       readyToCollectDate ?? null)
    .input('isSpotPo',              sql.Bit,            isSpotPo ? 1 : 0)
    .input('notes',                 sql.NVarChar(500),  notes || null)
    .query(`
      INSERT INTO dbo.PurchaseOrderSuggestion
        (VendorId, VendorMaterialId, Material, Status, SuggestedQty, OrderQty, OrderDate,
         LeadTimeDaysUsed, DeliveryDate, TransitTimeDaysUsed, ReadyToCollectDate, IsSpotPo, Notes)
      OUTPUT INSERTED.SuggestionId
      VALUES
        (@vendorId, @vendorMaterialId, @material, 'Accepted', @suggestedQty, @orderQty, @orderDate,
         @leadTimeDaysUsed, @deliveryDate, @transitTimeDaysUsed, @readyToCollectDate, @isSpotPo, @notes)
    `);
  return recordset[0].SuggestionId;
}

// Everything except Cancelled — cancelled rows are kept in the table for
// audit but don't need to clutter the tracker view. Ordered by status stage
// then most-recent order first, so the "needs attention" rows (still
// Accepted, not yet actually raised in SAP) surface at the top.
export async function listOrderSuggestionsTracked() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT
      p.SuggestionId, p.VendorId, v.VendorName, p.VendorMaterialId, p.Material,
      t.MaterialText, p.Status, p.SuggestedQty, p.OrderQty, p.OrderDate,
      p.LeadTimeDaysUsed, p.DeliveryDate, p.TransitTimeDaysUsed, p.ReadyToCollectDate,
      p.IsSpotPo, p.PoNumber, p.Notes, p.SupplierReference,
      p.CreatedAtUtc, p.UpdatedAtUtc, p.ReceivedAtUtc,
      p.ShipmentId, s.ShipmentReference, s.Haulier, s.ModeOfTransport,
      s.TrackingNumber AS ShipmentTrackingNumber, s.ExpectedEta, s.ReceivedAtUtc AS ShipmentReceivedAtUtc
    FROM dbo.PurchaseOrderSuggestion p
    JOIN dbo.Vendor v ON v.VendorId = p.VendorId
    LEFT JOIN dbo.TurnsValClassSnapshot t ON t.Material = p.Material
    LEFT JOIN dbo.PurchaseOrderShipment s ON s.ShipmentId = p.ShipmentId
    WHERE p.Status <> 'Cancelled'
    ORDER BY
      CASE p.Status WHEN 'Accepted' THEN 0 WHEN 'Ordered' THEN 1 WHEN 'Booked' THEN 2 WHEN 'Received' THEN 3 ELSE 4 END,
      p.OrderDate DESC
  `);
  return recordset;
}

// Full-row update (same convention as updateVendor/updateVendorMaterial
// above) — the caller sends the complete current state, not a partial patch,
// so PoNumber/Notes/SupplierReference need to be included even when only
// Status is changing.
// orderQty is optional and only touches the row when supplied (COALESCE) —
// insertManualOrderRow's call into this same function at creation time
// doesn't pass it, and must leave the just-inserted OrderQty alone. When the
// Tracked Orders qty field IS edited, it's applied with no MOQ/lot-size
// re-validation: the order already exists in the real world and the actual
// delivered quantity can land a few kg either side of what was ordered
// (product-dependent), so this is a correction to match reality, not a new
// proposed order that needs to clear the vendor's constraints again.
export async function updateOrderSuggestionStatus(suggestionId, { status, poNumber, notes, supplierReference, orderQty }) {
  const pool = await getPool();
  await pool.request()
    .input('suggestionId',      sql.Int, suggestionId)
    .input('status',            sql.NVarChar(20),  status)
    .input('poNumber',          sql.NVarChar(20),  poNumber || null)
    .input('notes',             sql.NVarChar(500), notes || null)
    .input('supplierReference', sql.NVarChar(50),  supplierReference || null)
    .input('orderQty',          sql.Decimal(15, 3), orderQty != null ? orderQty : null)
    .query(`
      UPDATE dbo.PurchaseOrderSuggestion SET
        Status = @status, PoNumber = @poNumber, Notes = @notes,
        SupplierReference = @supplierReference,
        OrderQty = COALESCE(@orderQty, OrderQty),
        UpdatedAtUtc = GETUTCDATE(),
        ReceivedAtUtc = CASE WHEN @status = 'Received' THEN GETUTCDATE() ELSE ReceivedAtUtc END
      WHERE SuggestionId = @suggestionId
    `);
}

// ── Inbound shipment tracking (haulier / mode of transport / tracking
// number, dispatch date / ETA, B/L & container), and self-delivering-
// supplier reconciliation via SupplierReference above — see
// sql/migrate_order_shipments.sql for why this is a separate, much lighter
// table than Logistics.dbo.ShipmentMain, and for the Booked status this
// section introduces. Mirrors the Open Deliveries pattern: select order
// lines, Create Shipment — so creation and line-assignment happen in one
// call (createOrderShipment), not two.
export async function createOrderShipment({
  dispatchDate, expectedEta, haulier, modeOfTransport, trackingNumber,
  billOfLading, containerNumber, notes, suggestionIds
}) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('dispatchDate',    sql.DateTime,      dispatchDate ?? null)
    .input('expectedEta',     sql.DateTime,      expectedEta ?? null)
    .input('haulier',         sql.NVarChar(100), haulier || null)
    .input('modeOfTransport', sql.NVarChar(20),  modeOfTransport || null)
    .input('trackingNumber',  sql.NVarChar(100), trackingNumber || null)
    .input('billOfLading',    sql.NVarChar(50),  billOfLading || null)
    .input('containerNumber', sql.NVarChar(50),  containerNumber || null)
    .input('notes',           sql.NVarChar(500), notes || null)
    .query(`
      INSERT INTO dbo.PurchaseOrderShipment
        (DispatchDate, ExpectedEta, Haulier, ModeOfTransport, TrackingNumber, BillOfLading, ContainerNumber, Notes)
      OUTPUT INSERTED.ShipmentId
      VALUES (@dispatchDate, @expectedEta, @haulier, @modeOfTransport, @trackingNumber, @billOfLading, @containerNumber, @notes)
    `);
  const shipmentId = recordset[0].ShipmentId;

  // Reference is derived from the identity value, not supplied by the
  // caller — see sql/migrate_order_shipments.sql's header note on
  // ShipmentReference for why this is auto-generated rather than free text.
  const shipmentReference = `INB-${String(shipmentId).padStart(6, '0')}`;
  await pool.request()
    .input('shipmentId',        sql.Int, shipmentId)
    .input('shipmentReference', sql.NVarChar(50), shipmentReference)
    .query('UPDATE dbo.PurchaseOrderShipment SET ShipmentReference = @shipmentReference WHERE ShipmentId = @shipmentId');

  const ids = (suggestionIds || []).map(Number).filter(Boolean);
  if (ids.length) {
    const request = pool.request().input('shipmentId', sql.Int, shipmentId);
    const inClause = ids.map((id, i) => { request.input(`sid${i}`, sql.Int, id); return `@sid${i}`; }).join(',');
    await request.query(`
      UPDATE dbo.PurchaseOrderSuggestion SET ShipmentId = @shipmentId, UpdatedAtUtc = GETUTCDATE()
      WHERE SuggestionId IN (${inClause})
    `);
  }

  return { shipmentId, shipmentReference, orderCount: ids.length };
}

// Ordered most-recent first, with a count of orders currently linked — lets
// the assign-shipment picker show "3 orders already on this load" so a
// second/third material arriving on the same delivery gets linked to the
// existing shipment instead of a duplicate one being created by mistake.
export async function listOrderShipments() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT
      s.ShipmentId, s.ShipmentReference, s.DispatchDate, s.ExpectedEta,
      s.Haulier, s.ModeOfTransport, s.TrackingNumber, s.BillOfLading, s.ContainerNumber,
      s.Notes, s.ReceivedAtUtc, s.ReceivedBy, s.CancelledAtUtc, s.CancelledBy,
      s.CreatedAtUtc, s.UpdatedAtUtc,
      (SELECT COUNT(*) FROM dbo.PurchaseOrderSuggestion p WHERE p.ShipmentId = s.ShipmentId) AS OrderCount
    FROM dbo.PurchaseOrderShipment s
    ORDER BY s.CreatedAtUtc DESC
  `);
  return recordset;
}

// Single shipment plus its linked order lines — the Inbound Log detail view.
// A cancelled shipment will always come back with an empty orders array —
// cancelOrderShipment unlinks every order from it, so there's nothing left
// to join against.
export async function getOrderShipmentWithOrders(shipmentId) {
  const pool = await getPool();
  const { recordset: shipmentRows } = await pool.request()
    .input('shipmentId', sql.Int, shipmentId)
    .query(`
      SELECT ShipmentId, ShipmentReference, DispatchDate, ExpectedEta,
             Haulier, ModeOfTransport, TrackingNumber, BillOfLading, ContainerNumber,
             Notes, ReceivedAtUtc, ReceivedBy, CancelledAtUtc, CancelledBy, CreatedAtUtc, UpdatedAtUtc
      FROM dbo.PurchaseOrderShipment WHERE ShipmentId = @shipmentId
    `);
  const shipment = shipmentRows[0] || null;
  if (!shipment) return null;

  const { recordset: orders } = await pool.request()
    .input('shipmentId', sql.Int, shipmentId)
    .query(`
      SELECT p.SuggestionId, p.Material, t.MaterialText, v.VendorName, p.OrderQty, p.Status, p.SupplierReference
      FROM dbo.PurchaseOrderSuggestion p
      JOIN dbo.Vendor v ON v.VendorId = p.VendorId
      LEFT JOIN dbo.TurnsValClassSnapshot t ON t.Material = p.Material
      WHERE p.ShipmentId = @shipmentId
      ORDER BY p.Material
    `);

  return { ...shipment, orders };
}

// ShipmentReference is intentionally excluded here — it's auto-generated at
// creation and permanent (see createOrderShipment), never user-editable.
export async function updateOrderShipment(shipmentId, {
  dispatchDate, expectedEta, haulier, modeOfTransport, trackingNumber,
  billOfLading, containerNumber, notes
}) {
  const pool = await getPool();
  await pool.request()
    .input('shipmentId',      sql.Int, shipmentId)
    .input('dispatchDate',    sql.DateTime,      dispatchDate ?? null)
    .input('expectedEta',     sql.DateTime,      expectedEta ?? null)
    .input('haulier',         sql.NVarChar(100), haulier || null)
    .input('modeOfTransport', sql.NVarChar(20),  modeOfTransport || null)
    .input('trackingNumber',  sql.NVarChar(100), trackingNumber || null)
    .input('billOfLading',    sql.NVarChar(50),  billOfLading || null)
    .input('containerNumber', sql.NVarChar(50),  containerNumber || null)
    .input('notes',           sql.NVarChar(500), notes || null)
    .query(`
      UPDATE dbo.PurchaseOrderShipment SET
        DispatchDate = @dispatchDate, ExpectedEta = @expectedEta, Haulier = @haulier,
        ModeOfTransport = @modeOfTransport, TrackingNumber = @trackingNumber,
        BillOfLading = @billOfLading, ContainerNumber = @containerNumber, Notes = @notes,
        UpdatedAtUtc = GETUTCDATE()
      WHERE ShipmentId = @shipmentId
    `);
}

// shipmentId may be null to unassign (e.g. an order was linked to the wrong
// load by mistake). Enforced, not hinted: re-checks the target shipment
// isn't cancelled fresh from the DB rather than trusting the caller, same
// convention as the MOQ/max-qty checks elsewhere in this file — a stale
// picker showing a shipment that's since been cancelled must not be able to
// link an order to it.
export async function assignOrderShipment(suggestionId, shipmentId) {
  const pool = await getPool();

  if (shipmentId) {
    const { recordset } = await pool.request()
      .input('shipmentId', sql.Int, shipmentId)
      .query('SELECT CancelledAtUtc FROM dbo.PurchaseOrderShipment WHERE ShipmentId = @shipmentId');
    if (!recordset[0]) { const err = new Error('Shipment not found.'); err.statusCode = 404; throw err; }
    if (recordset[0].CancelledAtUtc) { const err = new Error('This shipment has been cancelled and cannot accept orders.'); err.statusCode = 400; throw err; }
  }

  await pool.request()
    .input('suggestionId', sql.Int, suggestionId)
    .input('shipmentId',   sql.Int, shipmentId || null)
    .query(`
      UPDATE dbo.PurchaseOrderSuggestion SET ShipmentId = @shipmentId, UpdatedAtUtc = GETUTCDATE()
      WHERE SuggestionId = @suggestionId
    `);
}

// Cancels a shipment (Inbound Log's "Cancel Shipment" action) and unlinks
// every order currently on it — the orders themselves are left exactly as
// they were (Status untouched), just no longer pointing at a dead shipment,
// so they're free to be picked up in a new shipment later. Only possible
// before the shipment is received: a received shipment's orders are already
// Booked (see markShipmentReceived), so there'd be nothing sensible left to
// unlink them back to.
export async function cancelOrderShipment(shipmentId, cancelledBy) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('shipmentId', sql.Int, shipmentId)
    .query('SELECT ShipmentId, ReceivedAtUtc, CancelledAtUtc FROM dbo.PurchaseOrderShipment WHERE ShipmentId = @shipmentId');
  const shipment = recordset[0];
  if (!shipment) { const err = new Error('Shipment not found.'); err.statusCode = 404; throw err; }
  if (shipment.CancelledAtUtc) { const err = new Error('This shipment has already been cancelled.'); err.statusCode = 400; throw err; }
  if (shipment.ReceivedAtUtc) { const err = new Error('Cannot cancel a shipment that has already been marked received.'); err.statusCode = 400; throw err; }

  await pool.request()
    .input('shipmentId',   sql.Int, shipmentId)
    .input('cancelledBy',  sql.NVarChar(100), cancelledBy || null)
    .query(`
      UPDATE dbo.PurchaseOrderShipment SET CancelledAtUtc = GETUTCDATE(), CancelledBy = @cancelledBy, UpdatedAtUtc = GETUTCDATE()
      WHERE ShipmentId = @shipmentId
    `);

  const { recordset: unlinked } = await pool.request()
    .input('shipmentId', sql.Int, shipmentId)
    .query(`
      UPDATE dbo.PurchaseOrderSuggestion SET ShipmentId = NULL, UpdatedAtUtc = GETUTCDATE()
      OUTPUT INSERTED.SuggestionId
      WHERE ShipmentId = @shipmentId
    `);

  return { unlinkedCount: unlinked.length };
}

// PLACEHOLDER — real SAP goods-receipt posting (MIGO-equivalent RFC via
// SapServer, matching the pattern used by sap.postChangeValuationClass
// elsewhere in this app) goes here later. Deliberately a no-op stub for
// now: markShipmentReceived below calls this once per order so the future
// implementation has an obvious, already-wired hook, but doesn't yet gate
// the Status='Booked' update on its result — once real posting exists, only
// a successful call should flip an order's status.
async function postGoodsReceiptToSap(order) {
  return { success: true, placeholder: true, suggestionId: order.SuggestionId };
}

// Marks a shipment received (Inbound Log's "Mark Received" action) and
// bulk-flips every non-cancelled order on it to 'Booked' — see
// sql/migrate_order_shipments.sql's STATUS LIFECYCLE ADDITION note for why
// this is a distinct status from 'Received', not a reuse of it.
export async function markShipmentReceived(shipmentId, { receivedBy, receivedAt } = {}) {
  const pool = await getPool();
  const { recordset: shipmentRows } = await pool.request()
    .input('shipmentId', sql.Int, shipmentId)
    .query('SELECT ShipmentId, ReceivedAtUtc FROM dbo.PurchaseOrderShipment WHERE ShipmentId = @shipmentId');
  const shipment = shipmentRows[0];
  if (!shipment) { const err = new Error('Shipment not found.'); err.statusCode = 404; throw err; }
  if (shipment.ReceivedAtUtc) { const err = new Error('This shipment has already been marked received.'); err.statusCode = 400; throw err; }

  const receivedDate = receivedAt ? new Date(receivedAt) : new Date();

  await pool.request()
    .input('shipmentId', sql.Int, shipmentId)
    .input('receivedAt', sql.DateTime, receivedDate)
    .input('receivedBy', sql.NVarChar(100), receivedBy || null)
    .query(`
      UPDATE dbo.PurchaseOrderShipment SET ReceivedAtUtc = @receivedAt, ReceivedBy = @receivedBy, UpdatedAtUtc = GETUTCDATE()
      WHERE ShipmentId = @shipmentId
    `);

  const { recordset: orders } = await pool.request()
    .input('shipmentId', sql.Int, shipmentId)
    .query(`SELECT SuggestionId FROM dbo.PurchaseOrderSuggestion WHERE ShipmentId = @shipmentId AND Status <> 'Cancelled'`);

  for (const order of orders) {
    await postGoodsReceiptToSap(order);
  }

  await pool.request()
    .input('shipmentId', sql.Int, shipmentId)
    .query(`
      UPDATE dbo.PurchaseOrderSuggestion SET Status = 'Booked', UpdatedAtUtc = GETUTCDATE()
      WHERE ShipmentId = @shipmentId AND Status <> 'Cancelled'
    `);

  return { orderCount: orders.length };
}


// Fresh, authoritative lookups used by the accept/accept-batch routes'
// server-side enforcement (routes/performance.js) — deliberately re-read
// from the DB rather than trusting whatever the client submitted, so a
// stale page or a direct API call can't bypass a material's lot size/max or
// a vendor's combined min/max/exact requirement.
export async function getVendorMaterialConstraints(vendorMaterialId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('vendorMaterialId', sql.Int, vendorMaterialId)
    .query('SELECT MaterialMoqQty, MaterialMaxQty FROM dbo.VendorMaterial WHERE VendorMaterialId = @vendorMaterialId');
  return recordset[0] || null;
}

export async function getVendorOrderConstraints(vendorId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('vendorId', sql.Int, vendorId)
    .query('SELECT VendorName, OrderMoqQty, OrderMaxQty, OrderMoqUom FROM dbo.Vendor WHERE VendorId = @vendorId');
  return recordset[0] || null;
}
