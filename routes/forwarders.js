import express from 'express';
import sql from 'mssql';
import { sqlConfig } from '../server.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM Logistics.dbo.Forwarders');
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
            .query('SELECT * FROM Logistics.dbo.Forwarders WHERE forwarderID = @forwarderId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get approved forwarders only ──
router.get('/approved', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT forwarderID, forwarderName FROM Logistics.dbo.Forwarders WHERE forwarderApproval = 1 ORDER BY forwarderName');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get distinct delivery modes from approved forwarders ──
router.get('/modes', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT DISTINCT forwarderMode FROM Logistics.dbo.Forwarders WHERE forwarderApproval = 1 AND forwarderMode IS NOT NULL ORDER BY forwarderMode');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { forwarderID, forwarderName, forwarderApproval } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('forwarderID', sql.BigInt, forwarderID)
            .input('forwarderName', sql.NVarChar, forwarderName)
            .input('forwarderApproval', sql.Bit, forwarderApproval)
            .query(`INSERT INTO Logistics.dbo.Forwarders (forwarderID, forwarderName, forwarderApproval)
                    VALUES (@forwarderID, @forwarderName, @forwarderApproval)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
