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
            .query('SELECT * FROM log.CostElements');
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
            .query('SELECT * FROM log.CostElements WHERE elementID = @elementId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
// elementID is a legacy identity-style column — every existing seed row
// (sql/migrate_shipment_costing.sql) was inserted without supplying it, so
// it's left to the database rather than asked for here. elementCode is the
// real SAP GL account short code (what ShipmentCost.costElement and
// Material Group Mapping's CostElement column actually hold — see
// routes/materialgroups.js).
router.post('/', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const { elementCode, elementDescription, direction, tier } = req.body;
        if (!elementCode || !String(elementCode).trim()) {
            return res.status(400).json({ success: false, error: { message: 'elementCode is required.' } });
        }
        if (!elementDescription || !String(elementDescription).trim()) {
            return res.status(400).json({ success: false, error: { message: 'elementDescription is required.' } });
        }

        const pool = await getPool();
        const { recordset } = await pool.request()
            .input('elementCode',        sql.NVarChar(6),   String(elementCode).trim())
            .input('elementDescription', sql.NVarChar(200), String(elementDescription).trim())
            .input('direction',          sql.NVarChar(10),  direction || null)
            .input('tier',               sql.NVarChar(10),  tier || null)
            .query(`INSERT INTO log.CostElements (elementCode, elementDescription, direction, tier)
                    OUTPUT INSERTED.elementID
                    VALUES (@elementCode, @elementDescription, @direction, @tier)`);

        res.status(201).json({ success: true, data: { elementID: recordset[0]?.elementID ?? null } });
    } catch (err) {
        res.status(500).json({ success: false, error: { message: err.message } });
    }
});

// ── Update record (elementCode / elementDescription / direction / tier) ──
router.put('/:elementId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const { elementCode, elementDescription, direction, tier } = req.body;
        if (!elementCode || !String(elementCode).trim()) {
            return res.status(400).json({ success: false, error: { message: 'elementCode is required.' } });
        }
        if (!elementDescription || !String(elementDescription).trim()) {
            return res.status(400).json({ success: false, error: { message: 'elementDescription is required.' } });
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('elementId',          sql.BigInt,        req.params.elementId)
            .input('elementCode',        sql.NVarChar(6),   String(elementCode).trim())
            .input('elementDescription', sql.NVarChar(200), String(elementDescription).trim())
            .input('direction',          sql.NVarChar(10),  direction || null)
            .input('tier',               sql.NVarChar(10),  tier || null)
            .query(`UPDATE log.CostElements
                    SET elementCode = @elementCode, elementDescription = @elementDescription,
                        direction = @direction, tier = @tier
                    WHERE elementID = @elementId;
                    SELECT @@ROWCOUNT AS rowsAffected;`);

        if (!result.recordset[0]?.rowsAffected) {
            return res.status(404).json({ success: false, error: { message: 'GL account not found.' } });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: { message: err.message } });
    }
});

// ── Delete record ──
router.delete('/:elementId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const pool = await getPool();
        await pool.request().input('elementId', sql.BigInt, req.params.elementId)
            .query('DELETE FROM log.CostElements WHERE elementID = @elementId');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: { message: err.message } });
    }
});

export default router;
