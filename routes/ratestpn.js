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
            .query('SELECT * FROM Logistics.dbo.RatesTPN');
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
            .query('SELECT * FROM Logistics.dbo.RatesTPN WHERE postalZone = @postalZone');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PalletCategory ──
router.get('/category/:palletCategory', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('palletCategory', sql.NVarChar, req.params.palletCategory)
            .query('SELECT * FROM Logistics.dbo.RatesTPN WHERE palletCategory = @palletCategory');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { postalZone, palletCategory, serviceLevel, agreedRate } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('postalZone', sql.NVarChar, postalZone)
            .input('palletCategory', sql.NVarChar, palletCategory)
            .input('serviceLevel', sql.NVarChar, serviceLevel)
            .input('agreedRate', sql.Decimal, agreedRate)
            .query(`INSERT INTO Logistics.dbo.RatesTPN (postalZone, palletCategory, serviceLevel, agreedRate)
                    VALUES (@postalZone, @palletCategory, @serviceLevel, @agreedRate)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
