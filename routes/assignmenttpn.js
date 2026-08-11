import express from 'express';
import sql from 'mssql';
import { getNexusOperationsPool } from '../config.js';

const router = express.Router();
const getPool = getNexusOperationsPool;

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM log.AssignmentTPN');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PostalZone ──
router.get('/zone/:postalZone', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('postalZone', sql.NVarChar, req.params.postalZone)
            .query('SELECT * FROM log.AssignmentTPN WHERE postalZone = @postalZone');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PostalCode ──
router.get('/postalcode/:postalCode', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('postalCode', sql.NVarChar, req.params.postalCode)
            .query('SELECT * FROM log.AssignmentTPN WHERE postalCode = @postalCode');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { postalZone, postalCode } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('postalZone', sql.NVarChar, postalZone)
            .input('postalCode', sql.NVarChar, postalCode)
            .query(`INSERT INTO log.AssignmentTPN (postalZone, postalCode)
                    VALUES (@postalZone, @postalCode)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
