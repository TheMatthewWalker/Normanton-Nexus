import express from 'express';
import sql from 'mssql';
import axios from 'axios';
import { sqlConfig, sapConfig } from '../server.js';
import { requirePermission } from '../middleware/auth.js';
import { makeSapToken } from './sap.js';

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

// ── Get by dispatch date range ──
router.get('/daterange', async (req, res) => {
    try {
        const { dateFrom, dateTo } = req.query;
        const pool = await getPool();
        const result = await pool.request()
            .input('dateFrom', sql.DateTimeTime, new Date(dateFrom))
            .input('dateTo', sql.DateTimeTime, new Date(dateTo))
            .query('SELECT * FROM Logistics.dbo.DeliveryMain WHERE dispatchDate BETWEEN @dateFrom AND @dateTo');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', requirePermission('LOG_SUPER'), async (req, res) => {
    try {
        const {
            deliveryID, customerID, dispatchDate, deliveryDate, completionDate, completionStatus,
            operatorName, supervisorName, netWeight, grossWeight, palletCount,
            deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority,
            deliveryService, incoterms
        } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('deliveryID', sql.BigInt, deliveryID)
            .input('customerID', sql.BigInt, customerID)
            .input('dispatchDate', sql.DateTimeTime, dispatchDate ? new Date(dispatchDate) : null)
            .input('deliveryDate', sql.DateTime, deliveryDate ? new Date(deliveryDate) : null)
            .input('completionDate', sql.DateTimeTime, completionDate ? new Date(completionDate) : null)
            .input('completionStatus', sql.Bit, completionStatus ?? 0)
            .input('operatorName', sql.NVarChar, operatorName ?? null)
            .input('supervisorName', sql.NVarChar, supervisorName ?? null)
            .input('netWeight', sql.Decimal, netWeight ?? null)
            .input('grossWeight', sql.Decimal, grossWeight ?? null)
            .input('palletCount', sql.Decimal, palletCount ?? null)
            .input('deliveryVolume', sql.Decimal, deliveryVolume ?? null)
            .input('picksheetComment', sql.NVarChar, picksheetComment ?? null)
            .input('deliveryCancelled', sql.Bit, deliveryCancelled ?? 0)
            .input('deliveryPriority', sql.Int, deliveryPriority ?? 0)
            .input('deliveryService', sql.NVarChar, deliveryService ?? null)
            .input('incoterms', sql.NVarChar(3), incoterms ?? null)
            .query(`INSERT INTO Logistics.dbo.DeliveryMain
                (deliveryID, customerID, dispatchDate, deliveryDate, completionDate, completionStatus,
                 operatorName, supervisorName, netWeight, grossWeight, palletCount,
                 deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority,
                 deliveryService, incoterms)
                VALUES
                (@deliveryID, @customerID, @dispatchDate, @deliveryDate, @completionDate, @completionStatus,
                 @operatorName, @supervisorName, @netWeight, @grossWeight, @palletCount,
                 @deliveryVolume, @picksheetComment, @deliveryCancelled, @deliveryPriority,
                 @deliveryService, @incoterms)`);

        res.status(201).json({ success: true, deliveryID });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Open Picksheets — active deliveries with destination name ──
router.get('/open-picksheets', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query(`SELECT dm.deliveryID, dm.customerID, d.destinationName, dm.dispatchDate,
                           dm.deliveryService, dm.picksheetComment, dm.deliveryPriority,
                           dm.incoterms
                    FROM Logistics.dbo.DeliveryMain dm
                    LEFT JOIN Logistics.dbo.Destinations d ON dm.customerID = d.destinationID
                    WHERE dm.completionStatus = 0 AND dm.deliveryCancelled = 0
                    ORDER BY dm.deliveryPriority DESC, dm.dispatchDate ASC`);
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
            .query(`SELECT dm.deliveryID, dm.customerID, dm.dispatchDate, dm.deliveryDate, dm.completionDate,
                           dm.deliveryService, dm.picksheetComment, dm.deliveryPriority,
                           CAST(ISNULL(dm.netWeight, 0) AS decimal(18,3)) AS netWeight,
                           CAST(ISNULL(dm.grossWeight, 0) AS decimal(18,3)) AS grossWeight,
                           CAST(ISNULL(dm.palletCount, 0) AS decimal(18,3)) AS palletCount,
                           CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS deliveryVolume,
                           d.destinationName, d.destinationStreet, d.destinationCity,
                           d.destinationPostCode, d.destinationCountry,
                           d.defaultIncoterms, d.defaultForwarder, dm.incoterms,
                           STUFF((
                               SELECT '; ' + e.address
                               FROM Logistics.dbo.Email e
                               WHERE e.ID = dm.customerID
                               FOR XML PATH('')
                           ), 1, 2, '') AS address
                    FROM Logistics.dbo.DeliveryMain dm
                    LEFT JOIN Logistics.dbo.Destinations d ON dm.customerID = d.destinationID
                    LEFT JOIN Logistics.dbo.ShipmentLink sl ON sl.deliveryID = dm.deliveryID
                    WHERE dm.completionStatus = 1
                      AND ISNULL(dm.deliveryCancelled, 0) = 0
                      AND sl.deliveryID IS NULL
                    ORDER BY dm.deliveryPriority DESC, dm.completionDate DESC, dm.dispatchDate ASC, dm.deliveryID ASC`);
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
            .query(`SELECT dm.deliveryID, dm.customerID, dm.dispatchDate, dm.deliveryDate, dm.completionDate,
                           dm.deliveryService, dm.picksheetComment, dm.incoterms,
                           CAST(ISNULL(dm.netWeight,      0) AS decimal(18,3)) AS netWeight,
                           CAST(ISNULL(dm.grossWeight,    0) AS decimal(18,3)) AS grossWeight,
                           CAST(ISNULL(dm.palletCount,    0) AS decimal(18,3)) AS palletCount,
                           CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS deliveryVolume,
                           d.destinationName, d.defaultIncoterms
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

// ── Mark delivery as complete — rolls up pallet weights/volume/count ──
router.patch('/:deliveryId/complete', async (req, res) => {
    try {
        const pool = await getPool();
        await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`UPDATE Logistics.dbo.DeliveryMain
                    SET completionStatus = 1,
                        completionDate   = GETDATE(),
                        palletCount = (
                            SELECT COUNT(*)
                            FROM Logistics.dbo.PalletMain pm
                            INNER JOIN Logistics.dbo.DeliveryLink dl ON pm.palletID = dl.palletID
                            WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0
                        ),
                        grossWeight = (
                            SELECT ISNULL(SUM(pm.grossWeight), 0)
                            FROM Logistics.dbo.PalletMain pm
                            INNER JOIN Logistics.dbo.DeliveryLink dl ON pm.palletID = dl.palletID
                            WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0
                        ),
                        netWeight = (
                            SELECT ISNULL(SUM(pm.grossWeight - ISNULL(pm.packagingWeight, 0)), 0)
                            FROM Logistics.dbo.PalletMain pm
                            INNER JOIN Logistics.dbo.DeliveryLink dl ON pm.palletID = dl.palletID
                            WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0
                        ),
                        deliveryVolume = (
                            SELECT ISNULL(SUM(pm.palletVolume), 0)
                            FROM Logistics.dbo.PalletMain pm
                            INNER JOIN Logistics.dbo.DeliveryLink dl ON pm.palletID = dl.palletID
                            WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0
                        )
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

// ── Bulk insert picksheets (LOG_SUPER only) ───────────────────────────────────
// Body: { records: [{ deliveryID, customerID, dispatchDate, deliveryService, deliveryPriority, picksheetComment }] }
// Skips records whose deliveryID already exists. Returns { inserted, skipped, errors }.
router.post('/bulk', requirePermission('LOG_SUPER'), async (req, res) => {
    const { records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ success: false, error: 'records array is required and must not be empty' });
    }

    const pool = await getPool();
    let inserted = 0, skipped = 0;
    const errors = [];

    for (const r of records) {
        try {
            const result = await pool.request()
                .input('deliveryID',      sql.BigInt,   r.deliveryID)
                .input('customerID',      sql.BigInt,   r.customerID)
                .input('dispatchDate',    sql.DateTimeTime, r.dispatchDate ? new Date(r.dispatchDate) : null)
                .input('deliveryDate',    sql.DateTime,     r.deliveryDate ? new Date(r.deliveryDate) : null)
                .input('deliveryService', sql.NVarChar,    r.deliveryService  ?? null)
                .input('deliveryPriority',sql.Int,         r.deliveryPriority ?? 0)
                .input('picksheetComment',sql.NVarChar,    r.picksheetComment ?? null)
                .input('incoterms',       sql.NVarChar(3), r.incoterms        ?? null)
                .query(`INSERT INTO Logistics.dbo.DeliveryMain
                            (deliveryID, customerID, dispatchDate, deliveryDate, completionStatus, deliveryCancelled,
                             deliveryService, deliveryPriority, picksheetComment, incoterms)
                        SELECT @deliveryID, @customerID, @dispatchDate, @deliveryDate, 0, 0,
                               @deliveryService, @deliveryPriority, @picksheetComment, @incoterms
                        WHERE NOT EXISTS (
                            SELECT 1 FROM Logistics.dbo.DeliveryMain WHERE deliveryID = @deliveryID
                        )`);
            if (result.rowsAffected[0] > 0) inserted++;
            else skipped++;
        } catch (err) {
            errors.push({ deliveryID: r.deliveryID, error: err.message });
        }
    }

    res.json({ success: true, inserted, skipped, errors });
});

// ── SAP sync — pull open picksheets from SAP server, insert any not already present ──
// Expected response shape: { data: [{ deliveryID, customerID, dispatchDate, deliveryService, deliveryPriority, picksheetComment }] }
router.post('/sap-sync', requirePermission('LOG_SUPER'), async (req, res) => {
    const sapSecret = process.env.SAP_SERVER_SECRET;
    const syncUrl   = `${sapConfig.url}/api/logistics/picksheets/open`;

    try {
        const sapRes = await axios.get(syncUrl, {
            headers:  { Authorization: `Bearer ${makeSapToken()}` },
            timeout:  30000,
        });

        const deliveries = sapRes.data?.data ?? sapRes.data;
        if (!Array.isArray(deliveries)) {
            return res.status(502).json({ success: false, error: 'Unexpected response format from SAP server' });
        }

        const pool = await getPool();

        // Load all destinations once to derive deliveryService and picksheetComment
        const destResult = await pool.request()
            .query('SELECT destinationID, defaultDeliveryService, destinationComment, destinationCountry FROM Logistics.dbo.Destinations');
        const destMap = Object.fromEntries(destResult.recordset.map(d => [String(d.destinationID), d]));

        function parseSapDate(str) {
            if (!str) return null;
            const [day, month, year] = String(str).split('.');
            if (!day || !month || !year) return null;
            const date = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
            return isNaN(date.getTime()) ? null : date;
        }

        let inserted = 0, skipped = 0;
        const errors  = [];
        const missing = []; // customerNumbers not found in Destinations

        for (const d of deliveries) {
            try {
                const deliveryID    = parseInt(d.deliveryNumber, 10);
                const customerID    = parseInt(d.customerNumber, 10);
                const dispatchDate  = parseSapDate(d.dueDate ?? d.dispatchDate);
                const incoterms     = d.incoterms ?? null;

                const dest = destMap[String(customerID)];
                if (!dest) {
                    missing.push({ deliveryNumber: d.deliveryNumber, customerNumber: d.customerNumber });
                    continue;
                }
                const deliveryService = String(incoterms ?? '').trim().toUpperCase() === 'EXW'
                    ? 'Ex Works'
                    : dest?.defaultDeliveryService ||
                      (String(dest?.destinationCountry ?? '').trim().toUpperCase() === 'UK'
                          ? 'Domestic'
                          : 'Groupage');
                const picksheetComment = dest?.destinationComment ?? null;

                const result = await pool.request()
                    .input('deliveryID',       sql.BigInt,      deliveryID)
                    .input('customerID',       sql.BigInt,      customerID)
                    .input('dispatchDate',     sql.DateTimeTime,    dispatchDate)
                    .input('deliveryService',  sql.NVarChar,    deliveryService)
                    .input('deliveryPriority', sql.Int,         0)
                    .input('picksheetComment', sql.NVarChar,    picksheetComment)
                    .input('incoterms',        sql.NVarChar(3), incoterms)
                    .query(`INSERT INTO Logistics.dbo.DeliveryMain
                                (deliveryID, customerID, dispatchDate, completionStatus, deliveryCancelled,
                                 deliveryService, deliveryPriority, picksheetComment, incoterms)
                            SELECT @deliveryID, @customerID, @dispatchDate, 0, 0,
                                   @deliveryService, @deliveryPriority, @picksheetComment, @incoterms
                            WHERE NOT EXISTS (
                                SELECT 1 FROM Logistics.dbo.DeliveryMain WHERE deliveryID = @deliveryID
                            )`);
                if (result.rowsAffected[0] > 0) inserted++;
                else skipped++;
            } catch (err) {
                errors.push({ deliveryNumber: d.deliveryNumber, error: err.message });
            }
        }

        res.json({ success: true, total: deliveries.length, inserted, skipped, errors, missing });

    } catch (err) {
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
            return res.status(503).json({ success: false, error: `SAP server unreachable: ${syncUrl}` });
        }
        if (err.response) {
            return res.status(502).json({ success: false, error: `SAP server error ${err.response.status}: ${err.response.data?.error ?? err.message}` });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Landing page sparkline — on-time shipment rate over last 30 days ──────────
// "On time" = shipment actualCollection date <= delivery dispatchDate
router.get('/landing-sparkline', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT
                CAST(sm.actualCollection AS DATE)  AS shipDate,
                COUNT(*)                           AS total,
                SUM(CASE WHEN CAST(sm.actualCollection AS DATE) <= CAST(dm.dispatchDate AS DATE)
                         THEN 1 ELSE 0 END)        AS onTime
            FROM Logistics.dbo.ShipmentMain sm
            INNER JOIN Logistics.dbo.ShipmentLink sl ON sl.shipmentID = sm.shipmentID
            INNER JOIN Logistics.dbo.DeliveryMain dm  ON dm.deliveryID  = sl.deliveryID
            WHERE sm.collectionStatus = 1
              AND ISNULL(sm.shipmentCancelled, 0) = 0
              AND dm.dispatchDate IS NOT NULL
              AND CAST(sm.actualCollection AS DATE) >= CAST(DATEADD(day, -29, GETDATE()) AS DATE)
            GROUP BY CAST(sm.actualCollection AS DATE)
            ORDER BY shipDate
        `);

        const rows = result.recordset;

        // Per-day on-time percentage (only days with collections)
        const dailyValues = rows.map(r => Math.round((r.onTime / r.total) * 100));

        // Rolling 7-day windows
        const cutoff7  = new Date(); cutoff7.setDate(cutoff7.getDate() - 7);
        const cutoff14 = new Date(); cutoff14.setDate(cutoff14.getDate() - 14);

        const thisWeek = rows.filter(r => new Date(r.shipDate) >= cutoff7);
        const lastWeek = rows.filter(r => new Date(r.shipDate) >= cutoff14 && new Date(r.shipDate) < cutoff7);

        const twTotal  = thisWeek.reduce((s, r) => s + r.total,  0);
        const twOnTime = thisWeek.reduce((s, r) => s + r.onTime, 0);
        const lwTotal  = lastWeek.reduce((s, r) => s + r.total,  0);
        const lwOnTime = lastWeek.reduce((s, r) => s + r.onTime, 0);

        const onTimeRate = twTotal > 0 ? Math.round((twOnTime / twTotal) * 100) : null;
        const lastRate   = lwTotal > 0 ? Math.round((lwOnTime / lwTotal) * 100) : null;
        const pctChange  = onTimeRate !== null && lastRate !== null ? onTimeRate - lastRate : null;

        res.json({ success: true, data: { dailyValues, onTimeRate, pctChange, totalShipments: twTotal } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
