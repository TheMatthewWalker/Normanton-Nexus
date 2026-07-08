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
    ['Amount',               'amount',             sql.Decimal(15, 2)],
    ['Currency',             'currency',           sql.VarChar(5), null, 5],
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
    ['StockValue',             'stockValue',             sql.Decimal(18, 2)],
    ['UnitPrice',              'unitPrice',              sql.Decimal(15, 4)],
    ['BookValue',              'bookValue',              sql.Decimal(18, 2)],

    ...historyForecastCols('History', 'consumptionHistory'),
    ...historyForecastCols('Forecast', 'demandForecast'),

    ['LastReceiptDate',        'lastReceiptDate',        sql.DateTime, toDate],
    ['LastGoodsIssueDate',     'lastGoodsIssueDate',     sql.DateTime, toDate],
    ['LastConsumptionDate',    'lastConsumptionDate',    sql.DateTime, toDate],
    ['LastGoodsMovementDate',  'lastGoodsMovementDate',  sql.DateTime, toDate],

    ['StockTurns',             'stockTurns',             sql.Decimal(15, 4)],
    ['DaysInStock',            'daysInStock',            sql.Decimal(15, 2)],
    ['DailyRequirementValue',  'dailyRequirementValue',  sql.Decimal(18, 4)],
    ['TurnoverCategory',       'turnoverCategory',       sql.VarChar(30), null, 30],
    ['Warning',                'warning',                sql.VarChar(200), null, 200]
  ], rows);
}

export function replaceValuationClassCatalog(rows) {
  return replaceTable('dbo.ValuationClassCatalog', [
    ['ValuationClass', 'valuationClass', sql.VarChar(4),  null, 4],
    ['MaterialType',   'materialType',   sql.VarChar(4),  null, 4],
    ['AccountRef',     'accountRef',     sql.VarChar(4),  null, 4],
    ['Description',    'description',    sql.VarChar(40), null, 40]
  ], rows);
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