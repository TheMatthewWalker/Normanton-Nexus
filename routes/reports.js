/**
 * routes/reports.js
 *
 * Aggregate report endpoint — returns grouped summary data for charts.
 *
 * POST /api/reports
 * Body: { report, dateFrom, dateTo }
 *   report   — one of the keys in REPORTS below
 *   dateFrom — ISO date string e.g. "2024-01-01"  (from the date picker)
 *   dateTo   — ISO date string e.g. "2024-12-31"
 *
 * Returns: { success, rows: [{ label, value }], meta: { title, valueLabel } }
 *
 * ── Date handling note ──────────────────────────────────────────────────────
 * All date/datetime columns in this database are stored as nvarchar strings
 * in "dd.mm.yy hh:mm:ss" format (SQL Server format code 4 for the date part).
 *
 * To filter by date range we wrap each column in:
 *   CONVERT(datetime, col, 4)
 * which parses the string and strips the time, giving a proper date value
 * that can be compared against our @dateFrom / @dateTo parameters
 * (which arrive as YYYY-MM-DD and are cast to date with CONVERT(date, @p)).
 *
 * For the Staging lead-time calculation we need a datetime, so we use:
 *   CONVERT(datetime, col, 4)
 * which preserves the time component and allows DATEDIFF(minute, ...).
 *
 * Mount in server.js:
 *   import reportRoutes from './routes/reports.js';
 *   app.use('/api/reports', requireLogin, reportRoutes);
 */

import express from 'express';
import sql     from 'mssql';
import { sqlConfig } from '../config.js';

const router = express.Router();

// ── Report definitions ────────────────────────────────────────────────────────
// WHERE clause pattern for every report (except Staging):
//
//   CONVERT(datetime, <dateCol>, 4) >= CONVERT(date, @dateFrom)
//   CONVERT(datetime, <dateCol>, 4) <= CONVERT(date, @dateTo)
//
// Format code 4 = dd.mm.yy — matches the stored string format.
// CONVERT(date, @dateFrom) parses our YYYY-MM-DD picker value to a date.
// Using <= dateTo (inclusive) rather than < dateTo+1 keeps the SQL simpler.

const REPORTS = {

  Batches: {
  type:  'quad-chart',
  title: 'Overview',
  charts: [
    { label: 'Total Length by Material',    valueLabel: 'Metres',   sql: `SELECT TOP 10 Material AS label, SUM(TotalLength) AS value FROM dbo.Batches       
                                                                            WHERE CONVERT(datetime, LEFT(CreationDate, 8), 4) >= CONVERT(datetime, @dateFrom)
                                                                              AND CONVERT(datetime, LEFT(CreationDate, 8), 4) <= CONVERT(datetime, @dateTo)
                                                                            GROUP BY Material ORDER BY value DESC` },
    { label: 'Count of Drums by Material',  valueLabel: 'Drums',    sql: `SELECT TOP 10 Material AS label, COUNT(*) AS value FROM dbo.Batches 
                                                                            WHERE CONVERT(datetime, LEFT(CreationDate, 8), 4) >= CONVERT(datetime, @dateFrom)
                                                                              AND CONVERT(datetime, LEFT(CreationDate, 8), 4) <= CONVERT(datetime, @dateTo)
                                                                            GROUP BY Material ORDER BY value DESC` },
    { label: 'Meters Drummed per Day', chartType: 'line', valueLabel: 'Meters',   sql: `SELECT
                                                                            CONVERT(varchar(8), CONVERT(datetime, LEFT(CreationDate, 8), 4), 3) AS label,
                                                                            SUM(TotalLength) AS value
                                                                          FROM dbo.Batches
                                                                          WHERE CONVERT(datetime, LEFT(CreationDate, 8), 4) >= CONVERT(datetime, @dateFrom)
                                                                            AND CONVERT(datetime, LEFT(CreationDate, 8), 4) <= CONVERT(datetime, @dateTo)
                                                                          GROUP BY CONVERT(datetime, LEFT(CreationDate, 8), 4)
                                                                          ORDER BY CONVERT(datetime, LEFT(CreationDate, 8), 4) ASC` },
    { label: 'Meters per Operator',         valueLabel: 'Meters',   sql: `SELECT TOP 10 Operator AS label, SUM(TotalLength) AS value FROM dbo.Batches 
                                                                            WHERE CONVERT(datetime, LEFT(CreationDate, 8), 4) >= CONVERT(datetime, @dateFrom)
                                                                              AND CONVERT(datetime, LEFT(CreationDate, 8), 4) <= CONVERT(datetime, @dateTo)
                                                                             GROUP BY Operator ORDER BY value DESC` },
  ],
},


  Ewald: {
    title:      'Total Quantity per Material',
    valueLabel: 'Total Qty',
    sql: `
      SELECT
        Material          AS label,
        SUM(TotalQty)     AS value
      FROM dbo.Ewald
      CROSS APPLY (
        SELECT
          SUBSTRING(CreationDate, 7, 4) + '-' + SUBSTRING(CreationDate, 4, 2) + '-' + SUBSTRING(CreationDate, 1, 2) AS CreationIso
      ) d
      WHERE ISDATE(d.CreationIso) = 1
        AND d.CreationIso >= @dateFrom
        AND d.CreationIso <= @dateTo
      GROUP BY Material
      ORDER BY value DESC
    `,
  },

  Mixing: {
    title:      'Total Weight per Mix Code',
    valueLabel: 'Total Weight (kg)',
    sql: `
      SELECT
        MixCode           AS label,
        SUM(CAST(REPLACE(TotalWeight, ',', '.') AS decimal(18,4)))  AS value
      FROM dbo.Mixing
      CROSS APPLY (
        SELECT
          SUBSTRING(CreationDate, 7, 4) + '-' + SUBSTRING(CreationDate, 4, 2) + '-' + SUBSTRING(CreationDate, 1, 2) AS CreationIso
      ) d
      WHERE ISDATE(d.CreationIso) = 1
        AND d.CreationIso >= @dateFrom
        AND d.CreationIso <= @dateTo
      GROUP BY MixCode
      ORDER BY value DESC
    `,
  },

  Extrusion: {
    title:      'Metres per Material',
    valueLabel: 'Metres (m)',
    sql: `
      SELECT
        Material      AS label,
        SUM(Meters)   AS value
      FROM dbo.Extrusion
      CROSS APPLY (
        SELECT
          SUBSTRING(StartDate, 7, 4) + '-' + SUBSTRING(StartDate, 4, 2) + '-' + SUBSTRING(StartDate, 1, 2) AS CreationIso
      ) d
      WHERE ISDATE(d.CreationIso) = 1
        AND d.CreationIso >= @dateFrom
        AND d.CreationIso <= @dateTo
      GROUP BY Material
      ORDER BY value DESC
    `,
  },

  Convo: {
    title:          'Metres per Material',
    type:           'chart-filterable-table',
    valueLabel:     'Meters (M)',
    columns:        ['Material', 'Meters'],
    filterColumns:  ['Material'],
    chartGroupBy:   'Material',   // which column to group bars by
    chartAggregate: 'Meters',     // which column to SUM for bar height
    sql: `
      SELECT
        Material      ,
        SUM(Meters)   AS Meters
      FROM dbo.Convo
      CROSS APPLY (
        SELECT
          SUBSTRING(RunDate, 7, 4) + '-' + SUBSTRING(RunDate, 4, 2) + '-' + SUBSTRING(RunDate, 1, 2) AS CreationIso
      ) d
      WHERE ISDATE(d.CreationIso) = 1
        AND d.CreationIso >= @dateFrom
        AND d.CreationIso <= @dateTo
      GROUP BY Material
      ORDER BY Meters DESC
    `,
  },

  // ── Firewall reports ────────────────────────────────────────────────────────
  // type: 'table' — returns raw rows with all columns listed in `columns`.
  // Add new Firewall_* entries here as needed.

  Firewall_FailedByBatch: {
    title:         'Failed Qty by Batch & Reason',
    type:          'filterable-table',
    columns:       ['Material', 'Batch', 'Reason', 'Total', 'Failed', 'Date'],
    filterColumns: ['Material', 'Batch', 'Reason'],
    sql: `
      SELECT
        g.Material,
        g.Batch,
        g.Reason,
        CAST(g.Total AS float) / COUNT(*) OVER (PARTITION BY g.Batch) AS Total,
        g.Failed,
        g.Date
      FROM (
        SELECT
          a.Material                AS Material,
          a.sapbatch                AS Batch,
          a.reasoncode              AS Reason,
          MAX(d.total)              AS Total,
          SUM(a.failedqty)          AS Failed,
          MAX(e.CreationIso)        AS Date
        FROM dbo.firewall a
        JOIN (
          SELECT
            b.sapbatch          AS sap,
            MAX(b.pieces)       AS total,
            MAX(c.creationdate) AS qdate
          FROM dbo.ewaldboxes b
          JOIN dbo.ewald c ON b.ewaldid = c.id
          GROUP BY b.sapbatch
        ) AS d ON a.sapbatch = d.sap
        CROSS APPLY (
          SELECT
            SUBSTRING(d.qdate, 7, 4) + '-' + SUBSTRING(d.qdate, 4, 2) + '-' + SUBSTRING(d.qdate, 1, 2) AS CreationIso
        ) e
        WHERE ISDATE(e.CreationIso) = 1
          AND e.CreationIso >= @dateFrom
          AND e.CreationIso <= @dateTo
          AND (a.failedqty > 0 OR a.failedqty IS NULL)
        GROUP BY a.Material, a.sapbatch, a.reasoncode
      ) g
      ORDER BY g.Date DESC, g.Material
    `,
  },

  Firewall_FailedByMaterial: {
    type:  'double-chart',
    title: 'Overview',
    charts: [
      { label: 'Material Failure % (TOP 10)',    valueLabel: 'Percentage',   sql: `SELECT TOP 10
                                                                                    r.Material                            AS label,
                                                                                    SUM(r.Failed) * 100.0 / SUM(r.Total) AS value
                                                                                  FROM (
                                                                                    SELECT
                                                                                      a.Material                            AS Material,
                                                                                      SUM(d.total)                          AS Total,
                                                                                      SUM(a.failedqty)                      AS Failed,
                                                                                      MAX(e.CreationIso)                    AS Date
                                                                                    FROM dbo.firewall a
                                                                                    JOIN (
                                                                                      SELECT
                                                                                        b.sapbatch      AS sap,
                                                                                        MAX(b.pieces)   AS total,
                                                                                        MAX(c.creationdate)  AS qdate
                                                                                      FROM dbo.ewaldboxes b
                                                                                      JOIN dbo.ewald c ON b.ewaldid = c.id
                                                                                      GROUP BY b.sapbatch
                                                                                    ) AS d 
                                                                                      ON a.sapbatch = d.sap 
                                                                                    CROSS APPLY (
                                                                                      SELECT
                                                                                        SUBSTRING(d.qdate, 7, 4) + '-' + SUBSTRING(d.qdate, 4, 2) + '-' + SUBSTRING(d.qdate, 1, 2) AS CreationIso
                                                                                    ) e
                                                                                    WHERE ISDATE(e.CreationIso) = 1
                                                                                      AND e.CreationIso >= @dateFrom
                                                                                      AND e.CreationIso <= @dateTo
                                                                                    GROUP BY a.Material
                                                                                    ) r
                                                                                  GROUP BY Material
                                                                                  ORDER BY value DESC` },
      { label: 'Overall Contribution % (TOP 10)',  valueLabel: 'Percentage',    sql: `SELECT TOP 10
                                                                                        r.Material                            AS label,
                                                                                        SUM(r.Failed) * 100.0 / SUM(SUM(r.Total)) OVER () AS value
                                                                                      FROM (
                                                                                        SELECT
                                                                                          a.Material                            AS Material,
                                                                                          SUM(d.total)                          AS Total,
                                                                                          SUM(a.failedqty)                      AS Failed,
                                                                                          MAX(e.CreationIso)                    AS Date
                                                                                        FROM dbo.firewall a
                                                                                        JOIN (
                                                                                          SELECT
                                                                                            b.sapbatch      AS sap,
                                                                                            MAX(b.pieces)   AS total,
                                                                                            MAX(c.creationdate)  AS qdate
                                                                                          FROM dbo.ewaldboxes b
                                                                                          JOIN dbo.ewald c ON b.ewaldid = c.id
                                                                                          GROUP BY b.sapbatch
                                                                                        ) AS d 
                                                                                          ON a.sapbatch = d.sap 
                                                                                        CROSS APPLY (
                                                                                          SELECT
                                                                                            SUBSTRING(d.qdate, 7, 4) + '-' + SUBSTRING(d.qdate, 4, 2) + '-' + SUBSTRING(d.qdate, 1, 2) AS CreationIso
                                                                                        ) e
                                                                                        WHERE ISDATE(e.CreationIso) = 1
                                                                                          AND e.CreationIso >= @dateFrom
                                                                                          AND e.CreationIso <= @dateTo
                                                                                        GROUP BY a.Material
                                                                                        ) r
                                                                                      GROUP BY Material
                                                                                      ORDER BY value DESC` },
    ],
  },

  Firewall_FailedByReason: {
    title:   'Failed Amount by Reason',
    type:       'chart-table', 
    AggregateLabel: 'Reason',
    valueLabel: 'Failed Units',
    sql: `
      SELECT
        s.ReasonDescription                 AS label,
        SUM(r.Failed)                       AS value
      FROM (
        SELECT
          a.Material                            AS Material,
          a.sapbatch                            AS Batch,
          a.reasoncode                          AS Reason,
          MAX(d.total) / COUNT(a.sapbatch)      AS Total,
          SUM(a.failedqty)                      AS Failed,
          MAX(e.CreationIso)                    AS Date
        FROM dbo.firewall a
        JOIN (
          SELECT
            b.sapbatch      AS sap,
            MAX(b.pieces)   AS total,
            c.creationdate  AS qdate
          FROM dbo.ewaldboxes b
          JOIN dbo.ewald c ON b.ewaldid = c.id
          GROUP BY b.sapbatch, c.creationdate
        ) AS d ON a.sapbatch = d.sap 
        CROSS APPLY (
          SELECT
            SUBSTRING(d.qdate, 7, 4) + '-' + SUBSTRING(d.qdate, 4, 2) + '-' + SUBSTRING(d.qdate, 1, 2) AS CreationIso
        ) e
        WHERE ISDATE(e.CreationIso) = 1
          AND e.CreationIso >= @dateFrom
          AND e.CreationIso <= @dateTo
        GROUP BY a.Material, a.sapbatch, a.reasoncode
        ) r
      JOIN dbo.ScrapReasons s
        ON r.Reason = s.ReasonCode
      GROUP BY s.ReasonDescription
      ORDER BY value DESC
    `,
  },

  Staging: {
    title:      'Average Lead Time (Creation to Delivery)',
    type:       'chart-table',
    valueLabel: 'Avg Hours',
    // For Staging we need datetime arithmetic, so we use CONVERT(datetime, col, 4)
    // which parses "dd.mm.yy hh:mm:ss" into a proper datetime value.
    // We group by year-month so the line chart shows a readable time series.
    sql: `
      SELECT
        CONVERT(varchar(4), DATEPART(year,  CONVERT(datetime, LEFT(CreationTime, 8), 4)))
        + '-' +
        RIGHT('0' + CONVERT(varchar(2), DATEPART(month, CONVERT(datetime, LEFT(CreationTime, 8), 4))), 2)
                                    AS label,
        AVG(CAST(
          DATEDIFF(
            minute,
            CONVERT(datetime, LEFT(CreationTime, 8), 4),
            CONVERT(datetime, LEFT(DeliveryTime, 8), 4)
          ) AS float
        ) / 60.0)                   AS value
      FROM dbo.Staging
      WHERE CONVERT(datetime, LEFT(CreationTime, 8), 4) >= CONVERT(datetime, @dateFrom)
        AND CONVERT(datetime, LEFT(CreationTime, 8), 4) <= CONVERT(datetime, @dateTo)
        AND LEFT(DeliveryTime, 8) IS NOT NULL
        AND LEFT(DeliveryTime, 8) <> ''
        AND CONVERT(datetime, LEFT(DeliveryTime, 8), 4) > CONVERT(datetime, LEFT(CreationTime, 8), 4)
      GROUP BY
        DATEPART(year,  CONVERT(datetime, LEFT(CreationTime, 8), 4)),
        DATEPART(month, CONVERT(datetime, LEFT(CreationTime, 8), 4))
      ORDER BY
        DATEPART(year,  CONVERT(datetime, LEFT(CreationTime, 8), 4)),
        DATEPART(month, CONVERT(datetime, LEFT(CreationTime, 8), 4))
    `,
  },
};

// ── Allowed report keys ───────────────────────────────────────────────────────
const ALLOWED = new Set(Object.keys(REPORTS));

// ── Date format validation — picker always sends YYYY-MM-DD ──────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── POST /api/reports ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { report, dateFrom, dateTo } = req.body;

  if (!report || !ALLOWED.has(report)) {
    return res.status(400).json({ success: false, error: `Unknown report: ${report}` });
  }
  if (!dateFrom || !DATE_RE.test(dateFrom) || !dateTo || !DATE_RE.test(dateTo)) {
    return res.status(400).json({ success: false, error: 'dateFrom and dateTo must be YYYY-MM-DD' });
  }
  if (dateFrom > dateTo) {
    return res.status(400).json({ success: false, error: 'dateFrom must not be after dateTo' });
  }

  const def = REPORTS[report];

  try {
    const pool = await sql.connect(sqlConfig);

  switch (def.type) {
    case 'quad-chart':
    case 'double-chart':
      const results = await Promise.all(def.charts.map(c =>
      pool.request()
        .input('dateFrom', sql.NVarChar(20), dateFrom)
        .input('dateTo',   sql.NVarChar(20), dateTo)
        .query(c.sql)
      ));
      var raw = results.recordset || [];
      const chartData = results.map((r, i) => ({
          label:      def.charts[i].label,
          valueLabel: def.charts[i].valueLabel,
          chartType:  def.charts[i].chartType || 'bar',
          rows:       (r.recordset || []).map(row => ({
            label: row.label != null ? String(row.label) : '(blank)',
            value: row.value != null ? Number(row.value) : 0,
          })),
        }));
        if (def.type === 'quad-chart')
          return res.json({ success: true, chartData, meta: { type: 'quad-chart', title: def.title } });
        if (def.type === 'double-chart')
          return res.json({ success: true, chartData, meta: { type: 'double-chart', title: def.title } });
    break;

    default:
      const result = await pool.request()
        .input('dateFrom', sql.NVarChar(20), dateFrom)
        .input('dateTo',   sql.NVarChar(20), dateTo)
        .query(def.sql);

      var raw = result.recordset || [];

      switch (def.type) {
  
        case 'chart-filterable-table': 
          // Aggregate raw rows into chart data using the definition's groupBy/aggregate fields
          const groupBy   = def.chartGroupBy;
          const aggCol    = def.chartAggregate;
          const grouped   = {};
          for (const row of raw) {
            const label = row[groupBy] != null ? String(row[groupBy]) : '(blank)';
            grouped[label] = (grouped[label] || 0) + (Number(row[aggCol]) || 0);
          }
          const chartRows = Object.entries(grouped)
            .map(([label, value]) => ({ label, value }))
            .sort((a, b) => b.value - a.value);

          res.json({
            success: true,
            rows: raw,
            chartRows,
            meta: {
              type:          'chart-filterable-table',
              title:         def.title,
              valueLabel:    def.valueLabel,
              columns:       def.columns,
              filterColumns: def.filterColumns || [],
            },
          });
        break;
        

        case 'filterable-table':
          res.json({
            success: true,
            rows: raw,
            meta: {
              type:          'filterable-table',
              title:         def.title,
              columns:       def.columns,
              filterColumns: def.filterColumns || [],
            },
          });
        break;

        case 'table':
          // Return all columns as-is; consumer decides how to render
          res.json({
            success: true,
            rows: raw,
            meta: {
              type:    'table',
              title:   def.title,
              columns: def.columns,
            },
          });
        break;

        case 'chart-table':
          // Default: chart — map to { label, value }
          const rows = raw.map(r => ({
            label: r.label != null ? String(r.label) : '(blank)',
            value: r.value != null ? Number(r.value)  : 0,
          }));
          res.json({
            success: true,
            rows,
            meta: {
              type:       'chart',
              title:      def.title,
              valueLabel: def.valueLabel,
              AggregateLabel: def.AggregateLabel || '',
            },
          });
        break;
      }
    break;
  }


    

  } catch (err) {
    console.error('[reports]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;