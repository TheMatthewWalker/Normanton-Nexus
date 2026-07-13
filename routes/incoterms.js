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
            .query('SELECT * FROM Logistics.dbo.Incoterms');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by IncotermsID ──
router.get('/id/:incotermsId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('incotermsId', sql.NVarChar, req.params.incotermsId)
            .query('SELECT * FROM Logistics.dbo.Incoterms WHERE incotermsID = @incotermsId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { incotermsID, incotermsDescription } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('incotermsID', sql.NVarChar, incotermsID)
            .input('incotermsDescription', sql.NVarChar, incotermsDescription)
            .query(`INSERT INTO Logistics.dbo.Incoterms (incotermsID, incotermsDescription)
                    VALUES (@incotermsID, @incotermsDescription)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
