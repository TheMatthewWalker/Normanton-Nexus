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
            .query('SELECT * FROM Logistics.dbo.ForwarderApproval');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by ForwarderID ──
router.get('/id/:forwarderId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('forwarderId', sql.BigInt, req.params.forwarderId)
            .query('SELECT * FROM Logistics.dbo.ForwarderApproval WHERE forwarderID = @forwarderId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { forwarderID, ratesAgreed, usageAgreed } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('forwarderID', sql.BigInt, forwarderID)
            .input('ratesAgreed', sql.Bit, ratesAgreed)
            .input('usageAgreed', sql.Bit, usageAgreed)
            .query(`INSERT INTO Logistics.dbo.ForwarderApproval (forwarderID, ratesAgreed, usageAgreed)
                    VALUES (@forwarderID, @ratesAgreed, @usageAgreed)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
