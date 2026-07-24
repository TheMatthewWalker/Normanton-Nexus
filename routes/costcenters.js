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
// centerID is a legacy identity-style column — every existing seed row
// (sql/migrate_shipment_costing.sql) was inserted without supplying it, so
// it's left to the database rather than asked for here. centerCode is the
// actual SAP cost centre code (what ShipmentCost.costCenter and the
// booking/manual-inbound cost centre dropdowns actually use).
router.post('/', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const { centerCode, centerDescription } = req.body;
        if (!centerCode || !String(centerCode).trim()) {
            return res.status(400).json({ success: false, error: { message: 'centerCode is required.' } });
        }
        if (!centerDescription || !String(centerDescription).trim()) {
            return res.status(400).json({ success: false, error: { message: 'centerDescription is required.' } });
        }

        const pool = await getPool();
        const { recordset } = await pool.request()
            .input('centerCode',        sql.NVarChar(10), String(centerCode).trim())
            .input('centerDescription', sql.NVarChar(200), String(centerDescription).trim())
            .query(`INSERT INTO Logistics.dbo.CostCenters (centerCode, centerDescription)
                    OUTPUT INSERTED.centerID
                    VALUES (@centerCode, @centerDescription)`);

        res.status(201).json({ success: true, data: { centerID: recordset[0]?.centerID ?? null } });
    } catch (err) {
        res.status(500).json({ success: false, error: { message: err.message } });
    }
});

// ── Update record (centerCode / centerDescription) ──
router.put('/:centerId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const { centerCode, centerDescription } = req.body;
        if (!centerCode || !String(centerCode).trim()) {
            return res.status(400).json({ success: false, error: { message: 'centerCode is required.' } });
        }
        if (!centerDescription || !String(centerDescription).trim()) {
            return res.status(400).json({ success: false, error: { message: 'centerDescription is required.' } });
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('centerId',          sql.BigInt,        req.params.centerId)
            .input('centerCode',        sql.NVarChar(10),  String(centerCode).trim())
            .input('centerDescription', sql.NVarChar(200), String(centerDescription).trim())
            .query(`UPDATE Logistics.dbo.CostCenters
                    SET centerCode = @centerCode, centerDescription = @centerDescription
                    WHERE centerID = @centerId;
                    SELECT @@ROWCOUNT AS rowsAffected;`);

        if (!result.recordset[0]?.rowsAffected) {
            return res.status(404).json({ success: false, error: { message: 'Cost centre not found.' } });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: { message: err.message } });
    }
});

// ── Delete record ──
router.delete('/:centerId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const pool = await getPool();
        await pool.request().input('centerId', sql.BigInt, req.params.centerId)
            .query('DELETE FROM Logistics.dbo.CostCenters WHERE centerID = @centerId');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: { message: err.message } });
    }
});

export default router;
