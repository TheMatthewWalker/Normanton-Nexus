import express from 'express';
import sql from 'mssql';
import { sqlConfig } from '../server.js';
import { requirePermission } from '../middleware/auth.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ── Lookup transit days for a destination ──
// Query: ?country=UK&postcode=LS12
// Prefers specific country+prefix match over country-only fallback.
router.get('/lookup', async (req, res) => {
    const country = String(req.query.country || '').trim().toUpperCase();
    const prefix  = String(req.query.postcode || '').slice(0, 2).toUpperCase() || null;
    if (!country) return res.status(400).json({ success: false, error: 'country is required' });
    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('country', sql.NVarChar, country)
            .input('prefix',  sql.NVarChar, prefix)
            .query(`SELECT TOP 1 transitDays
                    FROM Logistics.dbo.DeliveryRoutes
                    WHERE countryCode = @country
                      AND (postcodePrefix = @prefix OR postcodePrefix IS NULL)
                    ORDER BY CASE WHEN postcodePrefix = @prefix THEN 0 ELSE 1 END ASC`);
        res.json({ success: true, transitDays: result.recordset[0]?.transitDays ?? null });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Get all routes ──
router.get('/', async (req, res) => {
    try {
        const pool   = await getPool();
        const result = await pool.request()
            .query(`SELECT * FROM Logistics.dbo.DeliveryRoutes
                    ORDER BY countryCode ASC, ISNULL(postcodePrefix, 'ZZZZZ') ASC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Create route ──
router.post('/', requirePermission('LOG_ADMIN'), async (req, res) => {
    const { countryCode, postcodePrefix, transitDays } = req.body;
    if (!countryCode || transitDays == null) return res.status(400).json({ success: false, error: 'countryCode and transitDays are required' });
    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('countryCode',    sql.NVarChar, String(countryCode).toUpperCase())
            .input('postcodePrefix', sql.NVarChar, postcodePrefix ? String(postcodePrefix).toUpperCase() : null)
            .input('transitDays',    sql.Int,      parseInt(transitDays, 10))
            .query(`INSERT INTO Logistics.dbo.DeliveryRoutes (countryCode, postcodePrefix, transitDays)
                    VALUES (@countryCode, @postcodePrefix, @transitDays);
                    SELECT SCOPE_IDENTITY() AS routeID`);
        res.status(201).json({ success: true, routeID: result.recordset[0].routeID });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Update route ──
router.put('/:routeId', requirePermission('LOG_ADMIN'), async (req, res) => {
    const { countryCode, postcodePrefix, transitDays } = req.body;
    try {
        const pool = await getPool();
        await pool.request()
            .input('routeId',        sql.Int,      req.params.routeId)
            .input('countryCode',    sql.NVarChar, String(countryCode).toUpperCase())
            .input('postcodePrefix', sql.NVarChar, postcodePrefix ? String(postcodePrefix).toUpperCase() : null)
            .input('transitDays',    sql.Int,      parseInt(transitDays, 10))
            .query(`UPDATE Logistics.dbo.DeliveryRoutes
                    SET countryCode = @countryCode, postcodePrefix = @postcodePrefix, transitDays = @transitDays
                    WHERE routeID = @routeId`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Delete route ──
router.delete('/:routeId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const pool = await getPool();
        await pool.request()
            .input('routeId', sql.Int, req.params.routeId)
            .query('DELETE FROM Logistics.dbo.DeliveryRoutes WHERE routeID = @routeId');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;
