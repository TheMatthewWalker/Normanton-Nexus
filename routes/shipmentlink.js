import express from 'express';
import sql from 'mssql';
import { getNexusOperationsPool } from '../config.js';

const router = express.Router();
const getPool = getNexusOperationsPool;

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM log.ShipmentLink');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by ShipmentID ──
router.get('/shipment/:shipmentId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('shipmentId', sql.BigInt, req.params.shipmentId)
            .query('SELECT * FROM log.ShipmentLink WHERE shipmentID = @shipmentId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by DeliveryID ──
router.get('/delivery/:deliveryId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query('SELECT * FROM log.ShipmentLink WHERE deliveryID = @deliveryId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { shipmentID, deliveryID } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('shipmentID', sql.BigInt, shipmentID)
            .input('deliveryID', sql.BigInt, deliveryID)
            .query(`INSERT INTO log.ShipmentLink (shipmentID, deliveryID)
                    VALUES (@shipmentID, @deliveryID)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
