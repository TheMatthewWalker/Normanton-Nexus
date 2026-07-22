import express from 'express';
import sql from 'mssql';
import { sqlConfig } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

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
// forwarderID doubles as the SAP vendor code (confirmed with the user — no
// separate mapping column), so it's entered manually here rather than left
// to an identity column; the admin UI must ask for it explicitly.
router.post('/', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const { forwarderID, forwarderName, forwarderApproval, forwarderMode } = req.body;
        if (!forwarderID || !String(forwarderName || '').trim()) {
            return res.status(400).json({ error: 'forwarderID and forwarderName are required.' });
        }

        const pool = await getPool();
        await pool.request()
            .input('forwarderID', sql.BigInt, forwarderID)
            .input('forwarderName', sql.NVarChar, forwarderName)
            .input('forwarderApproval', sql.Bit, forwarderApproval ?? 0)
            .input('forwarderMode', sql.NVarChar, forwarderMode || null)
            .query(`INSERT INTO Logistics.dbo.Forwarders (forwarderID, forwarderName, forwarderApproval, forwarderMode)
                    VALUES (@forwarderID, @forwarderName, @forwarderApproval, @forwarderMode)`);

        res.status(201).json({ success: true, message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Update record (name / approval / delivery mode) ──
// forwarderID is the SAP vendor code and the PK — never editable once
// created (same convention as ShipmentReference elsewhere in this app: an
// identifier other data now points at is treated as permanent).
router.put('/:forwarderId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const { forwarderName, forwarderApproval, forwarderMode } = req.body;
        if (!String(forwarderName || '').trim()) {
            return res.status(400).json({ success: false, error: 'forwarderName is required.' });
        }

        const pool = await getPool();
        await pool.request()
            .input('forwarderId', sql.BigInt, req.params.forwarderId)
            .input('forwarderName', sql.NVarChar, forwarderName)
            .input('forwarderApproval', sql.Bit, forwarderApproval ?? 0)
            .input('forwarderMode', sql.NVarChar, forwarderMode || null)
            .query(`UPDATE Logistics.dbo.Forwarders
                    SET forwarderName = @forwarderName,
                        forwarderApproval = @forwarderApproval,
                        forwarderMode = @forwarderMode
                    WHERE forwarderID = @forwarderId`);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
