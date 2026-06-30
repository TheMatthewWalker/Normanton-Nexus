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
            .query('SELECT * FROM Logistics.dbo.PackagingData');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PackID ──
router.get('/id/:packId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('packId', sql.NVarChar, req.params.packId)
            .query('SELECT * FROM Logistics.dbo.PackagingData WHERE packID = @packId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('packID', sql.NVarChar, packID)
            .input('packMaterial', sql.NVarChar, packMaterial)
            .input('packDescription', sql.NVarChar, packDescription)
            .input('packWeight', sql.Decimal, packWeight)
            .input('packLength', sql.Int, packLength)
            .input('packWidth', sql.Int, packWidth)
            .input('packHeight', sql.Int, packHeight)
            .query(`INSERT INTO Logistics.dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
                    VALUES (@packID, @packMaterial, @packDescription, @packWeight, @packLength, @packWidth, @packHeight)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Update record ──
router.put('/:packId', requirePermission('LOG_ADMIN'), async (req, res) => {
    try {
        const { packDescription, packMaterial, packWeight, packLength, packWidth, packHeight } = req.body;
        const pool = await getPool();
        await pool.request()
            .input('packId',          sql.NVarChar,  req.params.packId)
            .input('packDescription', sql.NVarChar,  packDescription)
            .input('packMaterial',    sql.NVarChar,  packMaterial)
            .input('packWeight',      sql.Decimal,   packWeight)
            .input('packLength',      sql.Int,        packLength)
            .input('packWidth',       sql.Int,        packWidth)
            .input('packHeight',      sql.Int,        packHeight)
            .query(`UPDATE Logistics.dbo.PackagingData
                    SET packDescription = @packDescription,
                        packMaterial    = @packMaterial,
                        packWeight      = @packWeight,
                        packLength      = @packLength,
                        packWidth       = @packWidth,
                        packHeight      = @packHeight
                    WHERE packID = @packId`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
