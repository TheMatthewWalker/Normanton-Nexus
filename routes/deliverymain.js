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
            .query('SELECT * FROM Logistics.dbo.DeliveryMain');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by DeliveryID ──
router.get('/id/:deliveryId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query('SELECT * FROM Logistics.dbo.DeliveryMain WHERE deliveryID = @deliveryId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by CustomerID ──
router.get('/customer/:customerId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('customerId', sql.BigInt, req.params.customerId)
            .query('SELECT * FROM Logistics.dbo.DeliveryMain WHERE customerID = @customerId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by Operator ──
router.get('/operator/:operatorName', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('operatorName', sql.NVarChar, req.params.operatorName)
            .query('SELECT * FROM Logistics.dbo.DeliveryMain WHERE operatorName = @operatorName');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by due date range ──
router.get('/daterange', async (req, res) => {
    try {
        const { dateFrom, dateTo } = req.query;
        const pool = await getPool();
        const result = await pool.request()
            .input('dateFrom', sql.DateTime, new Date(dateFrom))
            .input('dateTo', sql.DateTime, new Date(dateTo))
            .query('SELECT * FROM Logistics.dbo.DeliveryMain WHERE dueDate BETWEEN @dateFrom AND @dateTo');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const {
            deliveryID, customerID, dueDate, completionDate, completionStatus,
            operatorName, supervisorName, netWeight, grossWeight, palletCount,
            deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority
        } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('deliveryID', sql.BigInt, deliveryID)
            .input('customerID', sql.BigInt, customerID)
            .input('dueDate', sql.DateTime, dueDate ? new Date(dueDate) : null)
            .input('completionDate', sql.DateTime, completionDate ? new Date(completionDate) : null)
            .input('completionStatus', sql.Bit, completionStatus)
            .input('operatorName', sql.NVarChar, operatorName)
            .input('supervisorName', sql.NVarChar, supervisorName)
            .input('netWeight', sql.Decimal, netWeight)
            .input('grossWeight', sql.Decimal, grossWeight)
            .input('palletCount', sql.Decimal, palletCount)
            .input('deliveryVolume', sql.Decimal, deliveryVolume)
            .input('picksheetComment', sql.NVarChar, picksheetComment)
            .input('deliveryCancelled', sql.Bit, deliveryCancelled)
            .input('deliveryPriority', sql.Int, deliveryPriority)
            .query(`INSERT INTO Logistics.dbo.DeliveryMain
                (deliveryID, customerID, dueDate, completionDate, completionStatus,
                 operatorName, supervisorName, netWeight, grossWeight, palletCount,
                 deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority)
                VALUES
                (@deliveryID, @customerID, @dueDate, @completionDate, @completionStatus,
                 @operatorName, @supervisorName, @netWeight, @grossWeight, @palletCount,
                 @deliveryVolume, @picksheetComment, @deliveryCancelled, @deliveryPriority)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Open Picksheets — active deliveries with destination name ──
router.get('/open-picksheets', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query(`SELECT dm.deliveryID, dm.customerID, d.destinationName, dm.dueDate,
                           dm.deliveryService, dm.picksheetComment, dm.deliveryPriority
                    FROM Logistics.dbo.DeliveryMain dm
                    LEFT JOIN Logistics.dbo.Destinations d ON dm.customerID = d.destinationID
                    WHERE dm.completionStatus = 0 AND dm.deliveryCancelled = 0
                    ORDER BY dm.deliveryPriority DESC, dm.dueDate ASC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Completed deliveries available for shipment creation ──
router.get('/completed-unshipped', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query(`SELECT dm.deliveryID, dm.customerID, dm.dueDate, dm.completionDate,
                           dm.deliveryService, dm.picksheetComment, dm.deliveryPriority,
                           CAST(ISNULL(dm.netWeight, 0) AS decimal(18,3)) AS netWeight,
                           CAST(ISNULL(dm.grossWeight, 0) AS decimal(18,3)) AS grossWeight,
                           CAST(ISNULL(dm.palletCount, 0) AS decimal(18,3)) AS palletCount,
                           CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS deliveryVolume,
                           d.destinationName, d.destinationStreet, d.destinationCity,
                           d.destinationPostCode, d.destinationCountry, e.address,
                           d.defaultIncoterms
                    FROM Logistics.dbo.DeliveryMain dm
                    LEFT JOIN Logistics.dbo.Destinations d ON dm.customerID = d.destinationID
                    LEFT JOIN Logistics.dbo.ShipmentLink sl ON sl.deliveryID = dm.deliveryID
                    LEFT JOIN Logistics.dbo.Email e ON e.ID = dm.customerID
                    WHERE dm.completionStatus = 1
                      AND ISNULL(dm.deliveryCancelled, 0) = 0
                      AND sl.deliveryID IS NULL
                    ORDER BY dm.deliveryPriority DESC, dm.completionDate DESC, dm.dueDate ASC, dm.deliveryID ASC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Available unshipped deliveries for a specific customer (add-to-shipment picker) ──
router.get('/available-for-shipment/:customerId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('customerId', sql.BigInt, req.params.customerId)
            .query(`SELECT dm.deliveryID, dm.customerID, dm.dueDate, dm.completionDate,
                           dm.deliveryService, dm.picksheetComment,
                           CAST(ISNULL(dm.netWeight,      0) AS decimal(18,3)) AS netWeight,
                           CAST(ISNULL(dm.grossWeight,    0) AS decimal(18,3)) AS grossWeight,
                           CAST(ISNULL(dm.palletCount,    0) AS decimal(18,3)) AS palletCount,
                           CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS deliveryVolume,
                           d.destinationName
                    FROM Logistics.dbo.DeliveryMain dm
                    LEFT JOIN Logistics.dbo.Destinations  d  ON d.destinationID  = dm.customerID
                    LEFT JOIN Logistics.dbo.ShipmentLink  sl ON sl.deliveryID    = dm.deliveryID
                    WHERE dm.customerID = @customerId
                      AND dm.completionStatus = 1
                      AND ISNULL(dm.deliveryCancelled, 0) = 0
                      AND sl.deliveryID IS NULL
                    ORDER BY dm.deliveryID ASC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// ── Pallets picked for a delivery (includes palletID for builder) ──
router.get('/:deliveryId/pallets', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`SELECT pm.palletID, pm.palletType, pm.palletFinish,
                           pm.palletLength, pm.palletWidth, pm.palletHeight,
                           pm.grossWeight, pm.packagingWeight, pm.palletVolume,
                           pm.palletLocation, pm.palletCategory, pm.palletCreationDate
                    FROM Logistics.dbo.PalletMain pm
                    INNER JOIN Logistics.dbo.DeliveryLink dl ON pm.palletID = dl.palletID
                    WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0
                    ORDER BY pm.palletCreationDate ASC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Mark delivery as complete ──
router.patch('/:deliveryId/complete', async (req, res) => {
    try {
        const pool = await getPool();
        await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`UPDATE Logistics.dbo.DeliveryMain
                    SET completionStatus = 1, completionDate = GETDATE()
                    WHERE deliveryID = @deliveryId`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Link an existing pallet to a delivery ──
router.post('/:deliveryId/pallets', async (req, res) => {
    const { palletId } = req.body;
    if (!palletId) return res.status(400).json({ success: false, error: 'palletId required' });
    try {
        const pool = await getPool();
        await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .input('palletId',   sql.Int,    palletId)
            .query(`INSERT INTO Logistics.dbo.DeliveryLink (deliveryID, palletID)
                    VALUES (@deliveryId, @palletId)`);
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
