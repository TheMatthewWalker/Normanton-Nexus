import sql from 'mssql';
import { sqlConfig } from '../config.js';


const centreToArea = {
  '2000': 'PTFE',
  '2001': 'PTFE',
  '2002': 'PTFE',
  '2003': 'PTFE',
  '2004': 'PTFE',
  '2005': 'PTFE',
  '2006': 'PTFE',
  '2007': 'PTFE',
  '2008': 'PV',
  '2009': 'PTFE',
  '2010': 'PV',
  '2011': 'PV',
  '2012': 'PTFE',
  '2013': 'PV',
  '2014': 'PV',
  '2015': 'PV',
  '2016': 'PTFE',
  '2017': 'PV',
  '2018': 'PV',
  '2019': 'PV',
  '2021': 'PTFE',
  '2022': 'PTFE',
  '2023': 'PTFE',
  '2024': 'PV',
  '2026': 'PV',
  '2028': 'PV',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveRequestDate(value, row) {
  // ✅ try real SAP date
  let d = toDate(value);
  if (d) return d;

  // ✅ derive from Week (YYYYWW)
  if (row.week && /^\d{6}$/.test(row.week)) {
    const year = Number(row.week.substring(0, 4));
    const week = Number(row.week.substring(4, 6));

    // ISO week → Monday
    const simple = new Date(year, 0, 1 + (week - 1) * 7);
    const dow = simple.getDay();
    const result = new Date(simple);

    if (dow <= 4)
      result.setDate(simple.getDate() - simple.getDay() + 1);
    else
      result.setDate(simple.getDate() + 8 - simple.getDay());

    return result;
  }

  // ✅ fallback to Period (YYYYMM)
  if (row.period && /^\d{6}$/.test(row.period)) {
    const year = row.period.substring(0, 4);
    const month = row.period.substring(4, 6);
    return new Date(`${year}-${month}-01`);
  }

  // ❌ This should NEVER happen now
  console.warn('🚨 NO DATE SOURCE', row);

  return new Date('1900-01-01'); // last resort safety
}

// ✅ helper: define value stream
// PTFE or PV
function mapValueStream(valueStream) {
  if (!valueStream || valueStream === 'UNKNOWN') return null;

  const centre = String(valueStream).substring(0, 4);

  return centreToArea[centre] || null; // null = exclude
}


// ✅ helper: ensure JS date → SQL DateTime
// Handles: SAP format "31.05.26 12:00:00 AM", ISO strings, Date objects, SAP null sentinels.
function toDate(value) {
  if (!value) return null;
  if (
    value === '00000000' ||
    value === '0001-01-01T00:00:00' ||
    value === '0001-01-01'
  ) return null;

  // SAP date format: "31.05.26 12:00:00 AM"
  if (typeof value === 'string' && /^\d{2}\.\d{2}\.\d{2}/.test(value)) {
    const [datePart, timePart] = value.split(' ');
    const [day, month, year] = datePart.split('.');
    const fullYear = Number(year) < 50 ? '20' + year : '19' + year;
    value = `${fullYear}-${month}-${day} ${timePart}`;
  }

  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  if (d < new Date('1753-01-01')) return null;
  return d;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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


  // ✅ filter out unmapped ValueStreams FIRST
  rows = rows.filter(row => {
    if (!row.valueStream) return false;

    const mapped = mapValueStream(row.valueStream);
    if (!mapped) return false;

    row.valueStream = mapped; // ✅ overwrite here
    return true;
  });

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
    ['RequestDate',          'requestDate',        sql.DateTime,      resolveRequestDate],
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
    ['InvoiceDate',    'invoiceDate',    sql.DateTime,     resolveRequestDate],
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
    ['DeliveryDate', 'deliveryDate', sql.DateTime,     resolveRequestDate],
    ['DeliveryQty',  'deliveryQty',  sql.Decimal(15, 3)],
    ['Uom',          'uom',          sql.VarChar(3), null, 3],
    ['TargetDate',   'targetDate',   sql.DateTime,     resolveRequestDate],
    ['TargetQty',    'targetQty',    sql.Decimal(15, 3)],
    ['QtyClass',     'qtyClass',     sql.VarChar(4), null, 4],
    ['DateClass',    'dateClass',    sql.VarChar(4), null, 4],
    ['OnTime',       'onTime',       sql.Bit],
    ['ValueStream',  'valueStream',  sql.VarChar(8), null, 8]
  ], rows);
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