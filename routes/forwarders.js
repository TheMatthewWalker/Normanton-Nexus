import express from 'express';
import sql from 'mssql';
import { getNexusOperationsPool } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

const router = express.Router();
const getPool = getNexusOperationsPool;

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM log.Forwarders');
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
            .query('SELECT * FROM log.Forwarders WHERE forwarderID = @forwarderId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get approved forwarders only ──
// forwarderMode included (not just id/name) so callers that need to offer a
// choice of transport mode per haulier — the same haulier name can have
// several Forwarders rows, one per mode (Road/Groupage/Air/etc) — can group
// by name and still tell the rows apart. Existing callers that only ever
// used forwarderID/forwarderName are unaffected by the extra field.
router.get('/approved', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT forwarderID, forwarderName, forwarderMode FROM log.Forwarders WHERE forwarderApproval = 1 ORDER BY forwarderName, forwarderMode');
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
            .query('SELECT DISTINCT forwarderMode FROM log.Forwarders WHERE forwarderApproval = 1 AND forwarderMode IS NOT NULL ORDER BY forwarderMode');
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
            .query(`INSERT INTO log.Forwarders (forwarderID, forwarderName, forwarderApproval, forwarderMode)
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
//
// forwarderID is NOT unique on its own: a vendor with several shipping
// modes (Road/Sea/Air) gets one row PER MODE, all sharing the same
// forwarderID/forwarderName (that's the duplication the user pointed out
// in the haulier dropdowns — see dedupeForwardersByName in logistics.js).
// Scoping the UPDATE by forwarderID alone would silently overwrite every
// sibling mode-row for that vendor with whatever mode was just chosen, so
// the request must also pass the row's CURRENT forwarderMode
// (originalMode) to pin down exactly one row.
router.put('/:forwarderId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const { forwarderName, forwarderApproval, forwarderMode, originalMode } = req.body;
        if (!String(forwarderName || '').trim()) {
            return res.status(400).json({ success: false, error: 'forwarderName is required.' });
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('forwarderId', sql.BigInt, req.params.forwarderId)
            .input('forwarderName', sql.NVarChar, forwarderName)
            .input('forwarderApproval', sql.Bit, forwarderApproval ?? 0)
            .input('forwarderMode', sql.NVarChar, forwarderMode || null)
            .input('originalMode', sql.NVarChar, originalMode || null)
            .query(`UPDATE log.Forwarders
                    SET forwarderName = @forwarderName,
                        forwarderApproval = @forwarderApproval,
                        forwarderMode = @forwarderMode
                    WHERE forwarderID = @forwarderId
                      AND (forwarderMode = @originalMode OR (forwarderMode IS NULL AND @originalMode IS NULL));
                    SELECT @@ROWCOUNT AS rowsAffected;`);

        const rowsAffected = result.recordset[0]?.rowsAffected ?? 0;
        if (rowsAffected === 0) {
            return res.status(404).json({ success: false, error: 'Row not found — it may have been changed by someone else. Reload and try again.' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
