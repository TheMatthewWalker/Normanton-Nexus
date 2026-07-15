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
            .query('SELECT * FROM Logistics.dbo.CostCenters');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by CenterID ──
router.get('/id/:centerId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('centerId', sql.BigInt, req.params.centerId)
            .query('SELECT * FROM Logistics.dbo.CostCenters WHERE centerID = @centerId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { centerID, centerDescription } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('centerID', sql.BigInt, centerID)
            .input('centerDescription', sql.NVarChar, centerDescription)
            .query(`INSERT INTO Logistics.dbo.CostCenters (centerID, centerDescription)
                    VALUES (@centerID, @centerDescription)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
