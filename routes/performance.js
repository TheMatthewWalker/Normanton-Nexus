import express from 'express';
import { runFullRefresh, runTurnsValClassRefresh } from '../routes/performancesync.js';
import * as sap from './performancesap.js';
import * as db  from './performancesql.js';
import sql from 'mssql';
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

    if (req.query.materials) {
      const materials = String(req.query.materials).split(',').map(m => m.trim()).filter(Boolean);
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
        ForecastM06, ForecastM05, ForecastM04, ForecastM03, ForecastM02, ForecastM01, ForecastM00
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
      ]
    }));

    res.json({ success: true, data });
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