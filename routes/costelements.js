import express from 'express';
import sql from 'mssql';
import { sqlConfig } from '../config.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM Logistics.dbo.CostElements');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by ElementID ──
router.get('/id/:elementId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('elementId', sql.BigInt, req.params.elementId)
            .query('SELECT * FROM Logistics.dbo.CostElements WHERE elementID = @elementId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { elementID, elementDescription } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('elementID', sql.BigInt, elementID)
            .input('elementDescription', sql.NVarChar, elementDescription)
            .query(`INSERT INTO Logistics.dbo.CostElements (elementID, elementDescription)
                    VALUES (@elementID, @elementDescription)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
