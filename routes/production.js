/**
 * routes/production.js
 *
 * Parameterised read endpoints for the main production tables.
 * All user-supplied filter values are bound via sql.input() — never
 * interpolated directly into query strings.
 *
 * Mount in server.js:
 *   import productionRoutes from './routes/production.js';
 *   app.use('/api/production', productionRoutes);
 */

import express from 'express';
import sql     from 'mssql';
import { sqlConfig } from '../config.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ─────────────────────────────────────────────────────────────
// BATCHES
// ─────────────────────────────────────────────────────────────

/** GET /api/production/batches — all records (top 500) */
router.get('/batches', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT TOP 500 * FROM dbo.Batches');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/batches/batch/:batch — by Batch identifier */
router.get('/batches/batch/:batch', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('batch', sql.NVarChar(50), req.params.batch)
      .query('SELECT * FROM dbo.Batches WHERE Batch = @batch');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/batches/drum/:drum — by Drum number */
router.get('/batches/drum/:drum', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('drum', sql.NVarChar(8), req.params.drum)
      .query('SELECT * FROM dbo.Batches WHERE Drum = @drum');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/batches/material/:material — by Material number */
router.get('/batches/material/:material', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('material', sql.NVarChar(18), req.params.material)
      .query('SELECT * FROM dbo.Batches WHERE Material = @material');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/batches/customer/:customer — by Customer */
router.get('/batches/customer/:customer', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('customer', sql.NVarChar(50), req.params.customer)
      .query('SELECT * FROM dbo.Batches WHERE Customer = @customer');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// COILS  (child of Batches via Batch → Drum)
// ─────────────────────────────────────────────────────────────

/** GET /api/production/coils/batch/:batch */
router.get('/coils/batch/:batch', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('batch', sql.NVarChar(20), req.params.batch)
      .query('SELECT Coil FROM dbo.Coils WHERE Batch = @batch');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// TRACE  (child of Batches)
// ─────────────────────────────────────────────────────────────

/** GET /api/production/trace/batch/:batch */
router.get('/trace/batch/:batch', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('batch', sql.NVarChar(20), req.params.batch)
      .query('SELECT * FROM dbo.Trace WHERE Batch = @batch');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// WASTE  (child of Batches)
// ─────────────────────────────────────────────────────────────

/** GET /api/production/waste/batch/:batch */
router.get('/waste/batch/:batch', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('batch', sql.NVarChar(20), req.params.batch)
      .query('SELECT Reason, Length, Weight FROM dbo.Waste WHERE Batch = @batch');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// MIXING
// ─────────────────────────────────────────────────────────────

/** GET /api/production/mixing — top 500 */
router.get('/mixing', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT TOP 500 * FROM dbo.Mixing');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/mixing/:mixingId */
router.get('/mixing/:mixingId', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('mixingId', sql.NVarChar(10), req.params.mixingId)
      .query('SELECT * FROM dbo.Mixing WHERE MixingID = @mixingId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/mixing/:mixingId/matdocs */
router.get('/mixing/:mixingId/matdocs', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('mixingId', sql.NVarChar(10), req.params.mixingId)
      .query('SELECT * FROM dbo.MixingMatDocs WHERE MixingBatch = @mixingId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/mixing/:mixingId/waste */
router.get('/mixing/:mixingId/waste', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('mixingId', sql.NVarChar(10), req.params.mixingId)
      .query('SELECT * FROM dbo.MixingWaste WHERE MixingID = @mixingId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// EXTRUSION
// ─────────────────────────────────────────────────────────────

/** GET /api/production/extrusion — top 500 */
router.get('/extrusion', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT TOP 500 * FROM dbo.Extrusion');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/extrusion/:extBatch */
router.get('/extrusion/:extBatch', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('extBatch', sql.NVarChar(11), req.params.extBatch)
      .query('SELECT * FROM dbo.Extrusion WHERE ExtBatch = @extBatch');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/extrusion/:extBatch/trace */
router.get('/extrusion/:extBatch/trace', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('extBatch', sql.NVarChar(11), req.params.extBatch)
      .query('SELECT * FROM dbo.ExtrusionTrace WHERE ExtBatch = @extBatch');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/extrusion/:extBatch/waste */
router.get('/extrusion/:extBatch/waste', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('extBatch', sql.NVarChar(11), req.params.extBatch)
      .query('SELECT * FROM dbo.ExtrusionWaste WHERE ExtBatch = @extBatch');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// CONVO
// ─────────────────────────────────────────────────────────────

/** GET /api/production/convo — top 500 */
router.get('/convo', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT TOP 500 * FROM dbo.Convo');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/convo/:convoId */
router.get('/convo/:convoId', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('convoId', sql.NVarChar(10), req.params.convoId)
      .query('SELECT * FROM dbo.Convo WHERE ConvoID = @convoId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/convo/:convoId/trace */
router.get('/convo/:convoId/trace', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('convoId', sql.NVarChar(10), req.params.convoId)
      .query('SELECT * FROM dbo.ConvoTrace WHERE ConvoID = @convoId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/convo/:convoId/waste */
router.get('/convo/:convoId/waste', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('convoId', sql.NVarChar(10), req.params.convoId)
      .query('SELECT * FROM dbo.ConvoWaste WHERE convobatch = @convoId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// EWALD
// ─────────────────────────────────────────────────────────────

/** GET /api/production/ewald — top 500 */
router.get('/ewald', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT TOP 500 * FROM dbo.Ewald');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/ewald/:ewaldId */
router.get('/ewald/:ewaldId', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('ewaldId', sql.NVarChar(10), req.params.ewaldId)
      .query('SELECT * FROM dbo.Ewald WHERE ID = @ewaldId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/ewald/:ewaldId/boxes */
router.get('/ewald/:ewaldId/boxes', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('ewaldId', sql.NVarChar(10), req.params.ewaldId)
      .query('SELECT * FROM dbo.EwaldBoxes WHERE EwaldID = @ewaldId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/ewald/:ewaldId/waste */
router.get('/ewald/:ewaldId/waste', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('ewaldId', sql.NVarChar(10), req.params.ewaldId)
      .query('SELECT * FROM dbo.EwaldWaste WHERE EwaldID = @ewaldId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/ewald/:ewaldId/scrapdocs */
router.get('/ewald/:ewaldId/scrapdocs', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('ewaldId', sql.NVarChar(10), req.params.ewaldId)
      .query('SELECT * FROM dbo.EwaldScrapDocs WHERE EwaldID = @ewaldId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// FIREWALL
// ─────────────────────────────────────────────────────────────

/** GET /api/production/firewall — top 500 */
router.get('/firewall', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT TOP 500 * FROM dbo.Firewall');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/firewall/sapbatch/:sapBatch */
router.get('/firewall/sapbatch/:sapBatch', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('sapBatch', sql.NVarChar(10), req.params.sapBatch)
      .query('SELECT * FROM dbo.Firewall WHERE SAPBatch = @sapBatch');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/firewall/:sapBatch/messages */
router.get('/firewall/:sapBatch/messages', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('sapBatch', sql.NVarChar(10), req.params.sapBatch)
      .query('SELECT * FROM dbo.FirewallMessages WHERE SAPBatch = @sapBatch');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// STAGING
// ─────────────────────────────────────────────────────────────

/** GET /api/production/staging — top 500 */
router.get('/staging', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT TOP 500 * FROM dbo.Staging');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/staging/:stagingId */
router.get('/staging/:stagingId', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('stagingId', sql.BigInt, req.params.stagingId)
      .query('SELECT * FROM dbo.Staging WHERE StagingID = @stagingId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/production/staging/:stagingId/items */
router.get('/staging/:stagingId/items', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('stagingId', sql.BigInt, req.params.stagingId)
      .query('SELECT * FROM dbo.StagingItems WHERE StagingID = @stagingId');
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
