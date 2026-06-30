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
            .query('SELECT * FROM Logistics.dbo.PalletValidation');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PalletID — returns allowed packaging with full PackagingData detail ──
// packagingID in PalletValidation = NVARCHAR(2) = PackagingData.packID
router.get('/pallet/:palletId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('palletId', sql.NVarChar, req.params.palletId)
            .query(`SELECT pv.palletID, pv.packagingID,
                           pd.packMaterial, pd.packDescription,
                           pd.packWeight, pd.packLength, pd.packWidth, pd.packHeight
                    FROM   Logistics.dbo.PalletValidation pv
                    LEFT JOIN Logistics.dbo.PackagingData pd ON pd.packID = pv.packagingID
                    WHERE  pv.palletID = @palletId`);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Get by PackagingID ──
router.get('/packaging/:packagingId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('packagingId', sql.NVarChar, req.params.packagingId)
            .query('SELECT * FROM Logistics.dbo.PalletValidation WHERE packagingID = @packagingId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { palletID, packagingID } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('palletID', sql.NVarChar, palletID)
            .input('packagingID', sql.NVarChar, packagingID)
            .query(`INSERT INTO Logistics.dbo.PalletValidation (palletID, packagingID)
                    VALUES (@palletID, @packagingID)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
