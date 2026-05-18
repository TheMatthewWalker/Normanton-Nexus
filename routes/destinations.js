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
            defaultDeliveryService, defaultForwarder
        } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('destinationID',        sql.BigInt,   destinationID)
            .input('destinationName',      sql.NVarChar, destinationName)
            .input('destinationStreet',    sql.NVarChar, destinationStreet)
            .input('destinationCity',      sql.NVarChar, destinationCity)
            .input('destinationPostCode',  sql.NVarChar, destinationPostCode)
            .input('destinationCountry',   sql.NVarChar, destinationCountry)
            .input('defaultIncoterms',     sql.NVarChar, defaultIncoterms)
            .input('destinationComment',   sql.NVarChar, destinationComment)
            .input('destinationEmail',     sql.NVarChar, destinationEmail)
            .input('destinationZone',      sql.NVarChar, destinationZone)
            .input('defaultDeliveryService', sql.NVarChar, defaultDeliveryService ?? null)
            .input('defaultForwarder',       sql.NVarChar, defaultForwarder       ?? null)
            .query(`INSERT INTO Logistics.dbo.Destinations
                (destinationID, destinationName, destinationStreet, destinationCity,
                 destinationPostCode, destinationCountry, defaultIncoterms,
                 destinationComment, destinationEmail, destinationZone,
                 defaultDeliveryService, defaultForwarder)
                VALUES
                (@destinationID, @destinationName, @destinationStreet, @destinationCity,
                 @destinationPostCode, @destinationCountry, @defaultIncoterms,
                 @destinationComment, @destinationEmail, @destinationZone,
                 @defaultDeliveryService, @defaultForwarder)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Bulk delete ──
router.delete('/bulk', requirePermission('LOG_ADMIN'), async (req, res) => {
    const ids = (req.body.ids || []).map(Number).filter(n => n > 0);
    if (!ids.length) return res.status(400).json({ success: false, error: 'No IDs provided' });
    try {
        const pool    = await getPool();
        const request = pool.request();
        const inClause = ids.map((id, i) => { request.input(`id${i}`, sql.BigInt, id); return `@id${i}`; }).join(',');
        await request.query(`DELETE FROM Logistics.dbo.Destinations WHERE destinationID IN (${inClause})`);
        res.json({ success: true, deleted: ids.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Bulk field update (whitelist: defaultForwarder, defaultDeliveryService, destinationZone) ──
const BULK_FIELDS = {
    defaultForwarder:       'defaultForwarder',
    defaultDeliveryService: 'defaultDeliveryService',
    destinationZone:        'destinationZone',
};

router.patch('/bulk', requirePermission('LOG_ADMIN'), async (req, res) => {
    const { ids, field, value } = req.body;
    const col = BULK_FIELDS[field];
    if (!col) return res.status(400).json({ success: false, error: `Field '${field}' is not permitted for bulk update` });
    const idList = (ids || []).map(Number).filter(n => n > 0);
    if (!idList.length) return res.status(400).json({ success: false, error: 'No IDs provided' });
    try {
        const pool    = await getPool();
        const request = pool.request();
        request.input('value', sql.NVarChar, value ?? null);
        const inClause = idList.map((id, i) => { request.input(`id${i}`, sql.BigInt, id); return `@id${i}`; }).join(',');
        await request.query(`UPDATE Logistics.dbo.Destinations SET ${col} = @value WHERE destinationID IN (${inClause})`);
        res.json({ success: true, updated: idList.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Update record ──
router.put('/:destinationId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const {
            destinationName, destinationStreet, destinationCity,
            destinationPostCode, destinationCountry, defaultIncoterms,
            destinationComment, destinationZone,
            defaultDeliveryService, defaultForwarder
        } = req.body;
        const pool = await getPool();
        await pool.request()
            .input('destinationId',          sql.BigInt,   req.params.destinationId)
            .input('destinationName',        sql.NVarChar, destinationName)
            .input('destinationStreet',      sql.NVarChar, destinationStreet      ?? null)
            .input('destinationCity',        sql.NVarChar, destinationCity        ?? null)
            .input('destinationPostCode',    sql.NVarChar, destinationPostCode    ?? null)
            .input('destinationCountry',     sql.NVarChar, destinationCountry     ?? null)
            .input('defaultIncoterms',       sql.NVarChar, defaultIncoterms       ?? null)
            .input('destinationComment',     sql.NVarChar, destinationComment     ?? null)
            .input('destinationZone',        sql.NVarChar, destinationZone        ?? null)
            .input('defaultDeliveryService', sql.NVarChar, defaultDeliveryService ?? null)
            .input('defaultForwarder',       sql.NVarChar, defaultForwarder       ?? null)
            .query(`UPDATE Logistics.dbo.Destinations
                    SET destinationName        = @destinationName,
                        destinationStreet      = @destinationStreet,
                        destinationCity        = @destinationCity,
                        destinationPostCode    = @destinationPostCode,
                        destinationCountry     = @destinationCountry,
                        defaultIncoterms       = @defaultIncoterms,
                        destinationComment     = @destinationComment,
                        destinationZone        = @destinationZone,
                        defaultDeliveryService = @defaultDeliveryService,
                        defaultForwarder       = @defaultForwarder
                    WHERE destinationID = @destinationId`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Get email addresses for a destination ──
router.get('/:destinationId/emails', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('destinationId', sql.BigInt, req.params.destinationId)
            .query('SELECT address FROM Logistics.dbo.Email WHERE ID = @destinationId ORDER BY address');
        res.json({ success: true, addresses: result.recordset.map(r => r.address) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Replace all email addresses for a destination ──
// Body: { addresses: [string] }
router.put('/:destinationId/emails', requirePermission('LOG_ADMIN'), async (req, res) => {
    const addresses = (req.body.addresses || [])
        .map(a => String(a).trim())
        .filter(Boolean);
    try {
        const pool = await getPool();
        await pool.request()
            .input('destinationId', sql.BigInt, req.params.destinationId)
            .query('DELETE FROM Logistics.dbo.Email WHERE ID = @destinationId');
        for (const address of addresses) {
            await pool.request()
                .input('destinationId', sql.BigInt, req.params.destinationId)
                .input('address', sql.NVarChar, address)
                .query('INSERT INTO Logistics.dbo.Email (ID, address) VALUES (@destinationId, @address)');
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
