import express from 'express';
import sql from 'mssql';
import { sqlConfig } from '../server.js';
import { requirePermission } from '../middleware/auth.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM Logistics.dbo.Destinations');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by DestinationID ──
router.get('/id/:destinationId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('destinationId', sql.BigInt, req.params.destinationId)
            .query('SELECT * FROM Logistics.dbo.Destinations WHERE destinationID = @destinationId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by Country ──
router.get('/country/:country', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('country', sql.NVarChar, req.params.country)
            .query('SELECT * FROM Logistics.dbo.Destinations WHERE destinationCountry = @country');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by Zone ──
router.get('/zone/:zone', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('zone', sql.NVarChar, req.params.zone)
            .query('SELECT * FROM Logistics.dbo.Destinations WHERE destinationZone = @zone');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const {
            destinationID, destinationName, destinationStreet, destinationCity,
            destinationPostCode, destinationCountry, defaultIncoterms,
            destinationComment, destinationEmail, destinationZone,
            defaultDeliveryService
        } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('destinationID', sql.BigInt, destinationID)
            .input('destinationName', sql.NVarChar, destinationName)
            .input('destinationStreet', sql.NVarChar, destinationStreet)
            .input('destinationCity', sql.NVarChar, destinationCity)
            .input('destinationPostCode', sql.NVarChar, destinationPostCode)
            .input('destinationCountry', sql.NVarChar, destinationCountry)
            .input('defaultIncoterms', sql.NVarChar, defaultIncoterms)
            .input('destinationComment', sql.NVarChar, destinationComment)
            .input('destinationEmail', sql.NVarChar, destinationEmail)
            .input('destinationZone', sql.NVarChar, destinationZone)
            .input('defaultDeliveryService', sql.NVarChar, defaultDeliveryService ?? null)
            .query(`INSERT INTO Logistics.dbo.Destinations
                (destinationID, destinationName, destinationStreet, destinationCity,
                 destinationPostCode, destinationCountry, defaultIncoterms,
                 destinationComment, destinationEmail, destinationZone,
                 defaultDeliveryService)
                VALUES
                (@destinationID, @destinationName, @destinationStreet, @destinationCity,
                 @destinationPostCode, @destinationCountry, @defaultIncoterms,
                 @destinationComment, @destinationEmail, @destinationZone,
                 @defaultDeliveryService)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Update record ──
router.put('/:destinationId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const {
            destinationName, destinationStreet, destinationCity,
            destinationPostCode, destinationCountry, defaultIncoterms,
            destinationComment, destinationEmail, destinationZone,
            defaultDeliveryService
        } = req.body;
        const pool = await getPool();
        await pool.request()
            .input('destinationId',        sql.BigInt,   req.params.destinationId)
            .input('destinationName',      sql.NVarChar, destinationName)
            .input('destinationStreet',    sql.NVarChar, destinationStreet     ?? null)
            .input('destinationCity',      sql.NVarChar, destinationCity       ?? null)
            .input('destinationPostCode',  sql.NVarChar, destinationPostCode   ?? null)
            .input('destinationCountry',   sql.NVarChar, destinationCountry    ?? null)
            .input('defaultIncoterms',     sql.NVarChar, defaultIncoterms      ?? null)
            .input('destinationComment',   sql.NVarChar, destinationComment    ?? null)
            .input('destinationEmail',     sql.NVarChar, destinationEmail      ?? null)
            .input('destinationZone',      sql.NVarChar, destinationZone       ?? null)
            .input('defaultDeliveryService', sql.NVarChar, defaultDeliveryService ?? null)
            .query(`UPDATE Logistics.dbo.Destinations
                    SET destinationName        = @destinationName,
                        destinationStreet      = @destinationStreet,
                        destinationCity        = @destinationCity,
                        destinationPostCode    = @destinationPostCode,
                        destinationCountry     = @destinationCountry,
                        defaultIncoterms       = @defaultIncoterms,
                        destinationComment     = @destinationComment,
                        destinationEmail       = @destinationEmail,
                        destinationZone        = @destinationZone,
                        defaultDeliveryService = @defaultDeliveryService
                    WHERE destinationID = @destinationId`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
