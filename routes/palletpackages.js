import express from 'express';
import sql from 'mssql';
import { sqlConfig } from '../server.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

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
            .input('palletItemId', sql.BigInt, req.params.palletItemId)
            .query('SELECT * FROM Logistics.dbo.PalletPackages WHERE palletItemID = @palletItemId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PalletID — joined with PackagingData for descriptions ──
router.get('/pallet/:palletId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('palletId', sql.BigInt, req.params.palletId)
            .query(`SELECT pp.palletItemID, pp.palletID, pp.packagingID, pp.palletLayer,
                           pp.sapMaterial, pp.sapQuantity, pp.sapBatch,
                           pp.sapDelivery, pp.sapDeliveryItem,
                           pp.sapCustomer, pp.sapCustomerMaterial, pp.scanTime,
                           pd.packDescription, pd.packMaterial, pd.packWeight
                    FROM   Logistics.dbo.PalletPackages pp
                    LEFT JOIN Logistics.dbo.PackagingData pd
                           ON CAST(pd.packID AS NVARCHAR(4)) = CAST(pp.packagingID AS NVARCHAR(4))
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

// ── Create new record ──
// palletItemID is an IDENTITY column — SQL Server assigns it automatically.
// Do not include it in the INSERT; use SCOPE_IDENTITY() to read it back.
router.post('/', async (req, res) => {
    try {
        const {
            palletID, packagingID, palletLayer, sapMaterial,
            sapQuantity, sapBatch, sapDelivery, sapDeliveryItem,
            sapCustomer, sapCustomerMaterial, scanTime
        } = req.body;

        const pool = await getPool();
        const result = await pool.request()
            .input('palletID', sql.BigInt, palletID)
            .input('packagingID', sql.NVarChar(4), String(packagingID ?? ''))
            .input('palletLayer', sql.Int, palletLayer)
            .input('sapMaterial', sql.NVarChar, sapMaterial)
            .input('sapQuantity', sql.Decimal, sapQuantity)
            .input('sapBatch', sql.NVarChar, sapBatch)
            .input('sapDelivery', sql.NVarChar, sapDelivery)
            .input('sapDeliveryItem', sql.NVarChar, sapDeliveryItem)
            .input('sapCustomer', sql.NVarChar, sapCustomer)
            .input('sapCustomerMaterial', sql.NVarChar, sapCustomerMaterial)
            .input('scanTime', sql.DateTime, scanTime ? new Date(scanTime) : null)
            .query(`INSERT INTO Logistics.dbo.PalletPackages
                (palletID, packagingID, palletLayer, sapMaterial,
                 sapQuantity, sapBatch, sapDelivery, sapDeliveryItem,
                 sapCustomer, sapCustomerMaterial, scanTime)
                VALUES
                (@palletID, @packagingID, @palletLayer, @sapMaterial,
                 @sapQuantity, @sapBatch, @sapDelivery, @sapDeliveryItem,
                 @sapCustomer, @sapCustomerMaterial, @scanTime);
                SELECT SCOPE_IDENTITY() AS palletItemID;`);

        const newId = result.recordset[0].palletItemID;
        res.status(201).json({ success: true, palletItemID: newId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Delete a single package ──
router.delete('/:palletItemId', async (req, res) => {
    try {
        const pool = await getPool();
        await pool.request()
            .input('palletItemId', sql.BigInt, req.params.palletItemId)
            .query('DELETE FROM Logistics.dbo.PalletPackages WHERE palletItemID = @palletItemId');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
