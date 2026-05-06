import express from 'express';
import sql     from 'mssql';
import { sqlConfig } from '../server.js';

const router   = express.Router();
const getPool  = async () => await sql.connect(sqlConfig);

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM Logistics.dbo.PalletPackages');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PalletItemID ──
router.get('/id/:palletItemId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('palletItemId', sql.Int, req.params.palletItemId)
            .query('SELECT * FROM Logistics.dbo.PalletPackages WHERE palletItemID = @palletItemId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PalletID — joined with PackagingData for descriptions ──
// packagingID is NVARCHAR(2) matching PackagingData.packID
router.get('/pallet/:palletId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('palletId', sql.Int, req.params.palletId)
            .query(`SELECT pp.palletItemID, pp.palletID, pp.packagingID, pp.palletLayer,
                           pp.sapMaterial, pp.sapQuantity, pp.sapBatch,
                           pp.sapDelivery, pp.sapDeliveryItem,
                           pp.sapCustomer, pp.sapCustomerMaterial, pp.scanTime,
                           pd.packDescription, pd.packMaterial, pd.packWeight
                    FROM   Logistics.dbo.PalletPackages pp
                    LEFT JOIN Logistics.dbo.PackagingData pd ON pd.packID = pp.packagingID
                    WHERE  pp.palletID = @palletId
                    ORDER  BY pp.palletLayer, pp.palletItemID`);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Get by SAP Delivery ──
router.get('/sapdelivery/:sapDelivery', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('sapDelivery', sql.NVarChar, req.params.sapDelivery)
            .query('SELECT * FROM Logistics.dbo.PalletPackages WHERE sapDelivery = @sapDelivery');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by SAP Material ──
router.get('/sapmaterial/:sapMaterial', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('sapMaterial', sql.NVarChar, req.params.sapMaterial)
            .query('SELECT * FROM Logistics.dbo.PalletPackages WHERE sapMaterial = @sapMaterial');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new package ──
// palletItemID is IDENTITY — SQL Server assigns it automatically.
// packagingID is NVARCHAR(2) referencing PackagingData.packID.
router.post('/', async (req, res) => {
    try {
        const {
            palletID, packagingID, palletLayer, sapMaterial,
            sapQuantity, sapBatch, sapDelivery, sapDeliveryItem,
            sapCustomer, sapCustomerMaterial, scanTime
        } = req.body;

        const pool   = await getPool();
        const result = await pool.request()
            .input('palletID',            sql.Int,          palletID)
            .input('packagingID',         sql.NVarChar(3),  packagingID ?? null)
            .input('palletLayer',         sql.Int,          palletLayer ?? null)
            .input('sapMaterial',         sql.NVarChar(18), sapMaterial ?? null)
            .input('sapQuantity',         sql.Decimal(18,3),sapQuantity ?? null)
            .input('sapBatch',            sql.NVarChar(10), sapBatch ?? null)
            .input('sapDelivery',         sql.NVarChar(10), sapDelivery ?? null)
            .input('sapDeliveryItem',     sql.NVarChar(6),  sapDeliveryItem ?? null)
            .input('sapCustomer',         sql.NVarChar(10), sapCustomer ?? null)
            .input('sapCustomerMaterial', sql.NVarChar(18), sapCustomerMaterial ?? null)
            .input('scanTime',            sql.DateTime,     scanTime ? new Date(scanTime) : null)
            .query(`INSERT INTO Logistics.dbo.PalletPackages
                        (palletID, packagingID, palletLayer, sapMaterial,
                         sapQuantity, sapBatch, sapDelivery, sapDeliveryItem,
                         sapCustomer, sapCustomerMaterial, scanTime)
                    VALUES
                        (@palletID, @packagingID, @palletLayer, @sapMaterial,
                         @sapQuantity, @sapBatch, @sapDelivery, @sapDeliveryItem,
                         @sapCustomer, @sapCustomerMaterial, @scanTime);
                    SELECT SCOPE_IDENTITY() AS palletItemID;`);

        res.status(201).json({ success: true, palletItemID: result.recordset[0].palletItemID });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Delete a single package ──
router.delete('/:palletItemId', async (req, res) => {
    try {
        const pool = await getPool();
        await pool.request()
            .input('palletItemId', sql.Int, req.params.palletItemId)
            .query('DELETE FROM Logistics.dbo.PalletPackages WHERE palletItemID = @palletItemId');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
