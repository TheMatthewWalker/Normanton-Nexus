/**
 * routes/productionschedulesql.js
 *
 * DB layer for the "Production Schedule" report — the day-to-day view of
 * open PTFE order lines due in the next 5 working days (2 working-day
 * offset), the Arrears view (everything overdue and still open), planner
 * comments/ETA on each line, and the OTIF (on-time-in-full) tracker that
 * watches dbo.AgreementSnapshot for lines disappearing to infer completion.
 *
 * Data source: dbo.AgreementSnapshot (refreshed every 30 min by the existing
 * cron in server.js — see routes/performancesync.js). This file only reads
 * it; nothing here writes AgreementSnapshot.
 *
 * Kept separate from routes/performancesql.js (which is already very large)
 * — same modularisation this project already uses for other self-contained
 * features (routes/stagingsql.js, routes/performanceallocation.js, etc.).
 *
 * ReferenceDocument/Item below are always sourced from AgreementSnapshot's
 * OriginalDoc/OriginalDocItem columns (aliased AS ReferenceDocument/Item in
 * every query here), not the raw ReferenceDocument/Item columns — those flip
 * from the sales order number to the delivery number the instant SAP creates
 * a delivery against the line (see performanceorderlink.js's header comment).
 * Without this alias, a line picked between visits would silently vanish
 * from dbo.ProductionScheduleComments' key and dbo.OrderFulfillmentTracking's
 * openKeys set below — losing its planner comment/ETA, and (worse) the OTIF
 * tracker would misread the key-change as the order having shipped, logging
 * a false COMPLETED days or weeks before it actually ships. Aliasing at the
 * source means every function in this file — and every column persisted
 * into ProductionScheduleComments/OrderFulfillmentTracking — automatically
 * keys on the stable sales order number without needing its own fix.
 */

import sql from 'mssql';
import { sqlConfig } from '../config.js';

async function getPool() {
  return await sql.connect(sqlConfig);
}

// UTC midnight — see performancesql.js's startOfDay() for why useUTC matters here.
function startOfDay(d) {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

// Steps `date` forward/back by `days` working days (Mon-Fri, no bank-holiday
// calendar). Same idiom as addWorkingDaysUtc() in routes/performance.js
// (vendor lead-time / order-suggestion date math) — duplicated here rather
// than imported since that one isn't exported and this file shouldn't reach
// into an unrelated route module for a five-line helper.
function addWorkingDaysUtc(date, days) {
  const result = new Date(date.getTime());
  const step = days >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.round(days));
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + step);
    const dow = result.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// Production Schedule — next 5 working days, 2 working-day offset. So on a
// Wednesday, the report's first bucket is Friday (today + 2 working days),
// and it runs 5 working days from there (through the Friday after next).
// PTFE only, per the same scoping as the existing Order Book reports
// (getOrderBookBreakdown in performancesql.js).
//
// The offset is a lead-time adjustment, not just a query window: a line
// whose real SAP RequestDate is Friday needs to be FINISHED by Wednesday to
// actually make that Friday date, so the report must show it grouped under
// Wednesday — not Friday — or it reads as due two days later than it really
// is. DisplayDate (= RequestDate shifted back by the same offset) is what
// the frontend groups/labels rows by; RequestDate itself is left on the row
// too, but only DisplayDate should ever be shown to the user.
// ══════════════════════════════════════════════════════════════════════════
const SCHEDULE_OFFSET_WORKING_DAYS = 2;
const SCHEDULE_WINDOW_WORKING_DAYS = 5;

export async function getProductionSchedule() {
  const pool = await getPool();
  const today = startOfDay(new Date());
  const windowStart = addWorkingDaysUtc(today, SCHEDULE_OFFSET_WORKING_DAYS);
  const windowEnd    = addWorkingDaysUtc(windowStart, SCHEDULE_WINDOW_WORKING_DAYS - 1); // inclusive last day

  const { recordset } = await pool.request()
    .input('start', sql.DateTime, windowStart)
    .input('end',   sql.DateTime, windowEnd)
    .query(`
      SELECT
        Customer, CustomerName, OriginalDoc AS ReferenceDocument, OriginalDocItem AS Item, Material, MaterialText,
        CAST(CONVERT(VARCHAR(8), RequestDate, 112) AS DATETIME) AS RequestDate,
        OrderQty, Uom,
        DockStockAllocated   AS StockQty,
        PickedStockAllocated AS PickedQty,
        StandardPrice, Amount, Currency
      FROM dbo.AgreementSnapshot
      WHERE RequestDate IS NOT NULL
        AND ValueStream = 'PTFE'
        AND CONVERT(VARCHAR(8), RequestDate, 112) >= CONVERT(VARCHAR(8), @start, 112)
        AND CONVERT(VARCHAR(8), RequestDate, 112) <= CONVERT(VARCHAR(8), @end, 112)
      ORDER BY RequestDate, CustomerName, ReferenceDocument, Item
    `);

  const rows = recordset.map(r => ({
    ...r,
    DisplayDate: r.RequestDate
      ? addWorkingDaysUtc(new Date(r.RequestDate), -SCHEDULE_OFFSET_WORKING_DAYS)
      : null,
  }));

  return { rows, windowStart, windowEnd };
}

// Every open PTFE line whose RequestDate has already passed. "Still open" is
// implicit — AgreementSnapshot only ever contains what SAP currently
// considers open (see the header comment on replaceAgreementSnapshot in
// performancesql.js).
export async function getProductionArrears() {
  const pool = await getPool();
  const today = startOfDay(new Date());

  const { recordset } = await pool.request()
    .input('today', sql.DateTime, today)
    .query(`
      SELECT
        Customer, CustomerName, OriginalDoc AS ReferenceDocument, OriginalDocItem AS Item, Material, MaterialText,
        CAST(CONVERT(VARCHAR(8), RequestDate, 112) AS DATETIME) AS RequestDate,
        OrderQty, Uom,
        DockStockAllocated   AS StockQty,
        PickedStockAllocated AS PickedQty,
        StandardPrice, Amount, Currency
      FROM dbo.AgreementSnapshot
      WHERE RequestDate IS NOT NULL
        AND ValueStream = 'PTFE'
        AND CONVERT(VARCHAR(8), RequestDate, 112) < CONVERT(VARCHAR(8), @today, 112)
      ORDER BY RequestDate, CustomerName, ReferenceDocument, Item
    `);

  return recordset;
}

// ══════════════════════════════════════════════════════════════════════════
// Comments + ETA — dbo.ProductionScheduleComments, keyed (ReferenceDocument,
// Item). Sales and Production Supervisors both write here (see
// requireAnyPermission(['PROD_SUPERVISOR','SALES_SUPERVISOR']) in
// routes/productionschedule.js). Small, hand-edited volume (a handful of
// rows per Save Selected click) — plain IF EXISTS/UPDATE/ELSE INSERT per
// row, same idiom as sqlSessionStore.js, not the batched upsertBatch()
// machinery performancesql.js uses for bulk snapshot writes.
// ══════════════════════════════════════════════════════════════════════════

export async function listProductionScheduleComments() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT ReferenceDocument, Item, Comment, Eta, LastUpdatedUtc, UpdatedByUsername
    FROM dbo.ProductionScheduleComments
  `);

  const map = new Map();
  recordset.forEach(r => {
    map.set(`${r.ReferenceDocument}||${r.Item}`, {
      comment: r.Comment || '',
      eta:     r.Eta || null,
      lastUpdatedUtc:    r.LastUpdatedUtc,
      updatedByUsername: r.UpdatedByUsername || '',
    });
  });
  return map;
}

export async function upsertProductionScheduleComment({ referenceDocument, item, comment, eta }, username) {
  const pool = await getPool();
  await pool.request()
    .input('ref',     sql.NVarChar(10),  referenceDocument)
    .input('item',    sql.NVarChar(6),   item)
    .input('comment', sql.NVarChar(500), comment || null)
    .input('eta',     sql.DateTime,      eta ? new Date(eta) : null)
    .input('user',    sql.NVarChar(80),  username || null)
    .query(`
      IF EXISTS (SELECT 1 FROM dbo.ProductionScheduleComments WHERE ReferenceDocument = @ref AND Item = @item)
        UPDATE dbo.ProductionScheduleComments
        SET Comment = @comment, Eta = @eta, LastUpdatedUtc = GETUTCDATE(), UpdatedByUsername = @user
        WHERE ReferenceDocument = @ref AND Item = @item
      ELSE
        INSERT INTO dbo.ProductionScheduleComments (ReferenceDocument, Item, Comment, Eta, LastUpdatedUtc, UpdatedByUsername)
        VALUES (@ref, @item, @comment, @eta, GETUTCDATE(), @user)
    `);
}

// ══════════════════════════════════════════════════════════════════════════
// OTIF tracking — dbo.OrderFulfillmentTracking. See
// sql/migrate_production_schedule.sql's header comment for the full design
// rationale. Called once daily from server.js's cron (a dedicated slot,
// separate from the 30-min AgreementSnapshot refresh — see that cron
// comment for why daily, not every 30 min: a transient SAP sync gap
// shouldn't be read as "completed").
// ══════════════════════════════════════════════════════════════════════════

export async function diffProductionScheduleOtif() {
  const pool = await getPool();
  const today = startOfDay(new Date());

  const { recordset: openRows } = await pool.request().query(`
    SELECT
      OriginalDoc AS ReferenceDocument, OriginalDocItem AS Item, Customer, CustomerName, Material, MaterialText,
      ValueStream, OrderQty, Uom,
      CAST(CONVERT(VARCHAR(8), RequestDate, 112) AS DATETIME) AS RequestDate
    FROM dbo.AgreementSnapshot
    WHERE RequestDate IS NOT NULL AND ValueStream = 'PTFE'
  `);
  const openKeys = new Set(openRows.map(r => `${r.ReferenceDocument}||${r.Item}`));

  const { recordset: trackedOpen } = await pool.request().query(`
    SELECT TrackingID, ReferenceDocument, Item, DueDate
    FROM dbo.OrderFulfillmentTracking
    WHERE Status = 'OPEN'
  `);
  const trackedMap = new Map(trackedOpen.map(r => [`${r.ReferenceDocument}||${r.Item}`, r]));

  let inserted = 0, refreshed = 0, completed = 0;

  // New open lines — start tracking.
  for (const r of openRows) {
    const key = `${r.ReferenceDocument}||${r.Item}`;
    if (trackedMap.has(key)) continue;
    await pool.request()
      .input('ref',          sql.NVarChar(10),  r.ReferenceDocument)
      .input('item',         sql.NVarChar(6),   r.Item)
      .input('customer',     sql.NVarChar(10),  r.Customer)
      .input('customerName', sql.NVarChar(35),  r.CustomerName)
      .input('material',     sql.NVarChar(18),  r.Material)
      .input('materialText', sql.NVarChar(40),  r.MaterialText)
      .input('valueStream',  sql.VarChar(8),    r.ValueStream)
      .input('orderQty',     sql.Decimal(15,3), r.OrderQty)
      .input('uom',          sql.VarChar(3),    r.Uom)
      .input('due',          sql.DateTime,      r.RequestDate)
      .query(`
        INSERT INTO dbo.OrderFulfillmentTracking
          (ReferenceDocument, Item, Customer, CustomerName, Material, MaterialText, ValueStream, OrderQty, Uom, DueDate, FirstSeenUtc, LastSeenUtc, Status)
        VALUES
          (@ref, @item, @customer, @customerName, @material, @materialText, @valueStream, @orderQty, @uom, @due, GETUTCDATE(), GETUTCDATE(), 'OPEN')
      `);
    inserted++;
  }

  // Still open — refresh LastSeenUtc and the due date (SAP may have rescheduled it).
  for (const r of openRows) {
    const key = `${r.ReferenceDocument}||${r.Item}`;
    const tracked = trackedMap.get(key);
    if (!tracked) continue;
    await pool.request()
      .input('id',  sql.Int,      tracked.TrackingID)
      .input('due', sql.DateTime, r.RequestDate)
      .query(`UPDATE dbo.OrderFulfillmentTracking SET LastSeenUtc = GETUTCDATE(), DueDate = @due WHERE TrackingID = @id`);
    refreshed++;
  }

  // Disappeared — presumed completed as of today. Late reason (if any)
  // comes from whatever comment was last left on that line.
  const disappeared = trackedOpen.filter(r => !openKeys.has(`${r.ReferenceDocument}||${r.Item}`));
  for (const r of disappeared) {
    const onTime = r.DueDate ? (today.getTime() <= new Date(r.DueDate).getTime()) : null;
    let reason = null;
    if (onTime === false) {
      const c = await pool.request()
        .input('ref',  sql.NVarChar(10), r.ReferenceDocument)
        .input('item', sql.NVarChar(6),  r.Item)
        .query(`SELECT Comment FROM dbo.ProductionScheduleComments WHERE ReferenceDocument = @ref AND Item = @item`);
      reason = c.recordset[0]?.Comment || null;
    }
    await pool.request()
      .input('id',        sql.Int,           r.TrackingID)
      .input('completed', sql.DateTime,      today)
      .input('onTime',    sql.Bit,           onTime)
      .input('reason',    sql.NVarChar(500), reason)
      .query(`
        UPDATE dbo.OrderFulfillmentTracking
        SET Status = 'COMPLETED', CompletedDate = @completed, OnTime = @onTime, Reason = @reason
        WHERE TrackingID = @id
      `);
    completed++;
  }

  return { inserted, refreshed, completed };
}

// Monthly on-time % over time, for the KPI chart.
export async function getOtifKpiHistory() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT
      DATEPART(YEAR, CompletedDate)  AS [Year],
      DATEPART(MONTH, CompletedDate) AS [Month],
      SUM(CASE WHEN OnTime = 1 THEN 1 ELSE 0 END) AS OnTimeCount,
      COUNT(*) AS TotalCount
    FROM dbo.OrderFulfillmentTracking
    WHERE Status = 'COMPLETED' AND CompletedDate IS NOT NULL
    GROUP BY DATEPART(YEAR, CompletedDate), DATEPART(MONTH, CompletedDate)
    ORDER BY [Year], [Month]
  `);
  return recordset;
}

// Drill-down list — most recent completed-late lines, with their reasons.
export async function getOtifLateList() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT TOP 200
      ReferenceDocument, Item, Customer, CustomerName, Material, MaterialText,
      OrderQty, Uom, DueDate, CompletedDate, Reason
    FROM dbo.OrderFulfillmentTracking
    WHERE Status = 'COMPLETED' AND OnTime = 0
    ORDER BY CompletedDate DESC
  `);
  return recordset;
}
