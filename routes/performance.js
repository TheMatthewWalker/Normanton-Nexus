import express from 'express';
import { runFullRefresh } from '../routes/performancesync.js';
import sql from 'mssql';
import { sqlConfig } from '../config.js';

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


export default router;