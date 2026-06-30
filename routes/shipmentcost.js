import express from 'express';
import sql    from 'mssql';
import axios  from 'axios';
import https  from 'https';
import jwt    from 'jsonwebtoken';
import fs     from 'fs';
import { sqlConfig, sapConfig, sapServerSecret } from '../config.js';

const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
    ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
    : null;

function makeSapToken() {
    return jwt.sign({ userId: 0 }, sapServerSecret,
        { issuer: 'sql2005-bridge', audience: 'sap-server', expiresIn: '60s' });
}

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM Logistics.dbo.ShipmentCost');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by CostID ──
router.get('/id/:costId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('costId', sql.BigInt, req.params.costId)
            .query('SELECT * FROM Logistics.dbo.ShipmentCost WHERE costID = @costId');
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
            .query('SELECT * FROM Logistics.dbo.ShipmentCost WHERE shipmentID = @shipmentId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by CostType ──
router.get('/costtype/:costType', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('costType', sql.NVarChar, req.params.costType)
            .query('SELECT * FROM Logistics.dbo.ShipmentCost WHERE costType = @costType');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
// costID is an IDENTITY column — SQL Server assigns it automatically.
// Do not include it in the INSERT; use SCOPE_IDENTITY() to read it back.
router.post('/', async (req, res) => {
    try {
        const {
            shipmentID, costType, costElement, costCenter,
            expectedCost, actualCost, migoStatus, materialDocument
        } = req.body;

        const pool = await getPool();
        const result = await pool.request()
            .input('shipmentID', sql.BigInt, shipmentID)
            .input('costType', sql.NVarChar, costType)
            .input('costElement', sql.NVarChar, costElement)
            .input('costCenter', sql.NVarChar, costCenter)
            .input('expectedCost', sql.Decimal, expectedCost)
            .input('actualCost', sql.Decimal, actualCost)
            .input('migoStatus', sql.Bit, migoStatus ?? 0)
            .input('materialDocument', sql.NVarChar, materialDocument)
            .query(`INSERT INTO Logistics.dbo.ShipmentCost
                (shipmentID, costType, costElement, costCenter,
                 expectedCost, actualCost, migoStatus, materialDocument)
                VALUES
                (@shipmentID, @costType, @costElement, @costCenter,
                 @expectedCost, @actualCost, @migoStatus, @materialDocument);
                SELECT SCOPE_IDENTITY() AS costID;`);

        const newId = result.recordset[0].costID;
        res.status(201).json({ message: 'Record created successfully', costID: newId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Cost estimate for a shipment — used by booking modal ──────────────────────
// Returns: isKN, isKennethHowley, direction, tier, elementCode,
//          chargeableWeight, expectedCost (KN only), rateFound
router.get('/estimate/:shipmentId', async (req, res) => {
    try {
        const pool       = await getPool();
        const shipmentId = Number(req.params.shipmentId);

        const smResult = await pool.request()
            .input('shipmentId', sql.BigInt, shipmentId)
            .query(`SELECT sm.shipmentID, sm.grossWeight, sm.shipmentVolume,
                           sm.destinationCountry, sm.destinationPostCode,
                           sm.originID, sm.destinationID, sm.incoTerms,
                           f.forwarderName, f.forwarderMode
                    FROM Logistics.dbo.ShipmentMain sm
                    LEFT JOIN Logistics.dbo.Forwarders f ON f.forwarderID = sm.forwarderID
                    WHERE sm.shipmentID = @shipmentId`);

        if (!smResult.recordset.length)
            return res.status(404).json({ success: false, error: 'Shipment not found' });

        const s       = smResult.recordset[0];
        const fwdNorm = (s.forwarderName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const isKN    = fwdNorm.includes('kuehnenagel') || fwdNorm.includes('kuehneandnagel');
        const isKH    = fwdNorm.includes('howley') || fwdNorm.includes('kennethhowley');

        // Direction: originID=0 → outbound (Kongsberg is shipping out)
        // Use loose coercion: mssql may return BigInt cols as string '0'
        const direction = (s.originID == null || Number(s.originID) === 0) ? 'outbound' : 'inbound';

        // Tier: Premium if forwarder mode contains 'premium'
        const tier = (s.forwarderMode || '').toLowerCase().includes('premium') ? 'premium' : 'standard';

        // Look up the SAP cost element code
        const elemResult = await pool.request()
            .input('direction', sql.NVarChar, direction)
            .input('tier',      sql.NVarChar, tier)
            .query(`SELECT TOP 1 elementCode FROM Logistics.dbo.CostElements
                    WHERE direction = @direction AND tier = @tier`);
        const elementCode = elemResult.recordset[0]?.elementCode ?? null;

        // Customs cost (KN only): DDP = £50, DAP = £0
        const incoNorm    = (s.incoTerms || '').toUpperCase().replace(/\s/g, '');
        const customsCost = isKN ? (incoNorm === 'DDP' ? 50 : 0) : null;

        if (!isKN) {
            return res.json({ success: true, data: { isKN, isKennethHowley: isKH, direction, tier, elementCode } });
        }

        // KN auto-calculation
        const grossWeight      = Number(s.grossWeight      || 0);
        const volumetricWeight = Number(s.shipmentVolume   || 0) * 333;
        const chargeableWeight = Math.ceil(Math.max(grossWeight, volumetricWeight));
        const postcodePrefix   = (s.destinationPostCode || '').slice(0, 2).toUpperCase();

        const rateResult = await pool.request()
            .input('country', sql.NVarChar, (s.destinationCountry || '').toUpperCase())
            .input('prefix',  sql.NVarChar, postcodePrefix)
            .input('weight',  sql.Decimal,  chargeableWeight)
            .query(`SELECT TOP 1 agreedRate, minimumCharge
                    FROM Logistics.dbo.RatesKN
                    WHERE countryCode = @country
                      AND postalCode  = @prefix
                      AND @weight     >= minWeight
                      AND @weight     <= maxWeight`);

        if (!rateResult.recordset.length) {
            return res.json({ success: true, data: {
                isKN, isKennethHowley: false, direction, tier, elementCode,
                rateFound: false, chargeableWeight, grossWeight, volumetricWeight,
                customsCost, incoTerms: s.incoTerms,
                message: `No KN rate found for ${s.destinationCountry} / postcode prefix ${postcodePrefix} at ${chargeableWeight} kg`,
            }});
        }

        const rate         = rateResult.recordset[0];
        const rawCost      = Number(rate.agreedRate) * chargeableWeight;
        const minCharge    = Number(rate.minimumCharge || 0);
        const expectedCost = Math.round(Math.max(rawCost, minCharge) * 100) / 100;

        res.json({ success: true, data: {
            isKN, isKennethHowley: false, direction, tier, elementCode,
            rateFound: true, chargeableWeight, grossWeight, volumetricWeight,
            agreedRate: rate.agreedRate, minimumCharge: rate.minimumCharge, expectedCost,
            customsCost, incoTerms: s.incoTerms,
        }});
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Unprocessed costs (migoStatus = 0) ───────────────────────────────────────
router.get('/unprocessed', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query(`SELECT
                sc.costID,
                sm.shipmentID,
                sm.forwarderID,
                sm.plannedCollection,
                sm.actualCollection,
                f.forwarderName,
                cc.centerCode  AS costCenter,
                ce.elementCode AS costElement,
                sc.expectedCost,
                sc.actualCost,
                sc.costType,
                sm.destinationCountry,
                sm.destinationPostCode,
                sm.trackingNumber
            FROM Logistics.dbo.ShipmentCost sc
            INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
            LEFT  JOIN Logistics.dbo.Forwarders   f  ON f.forwarderID  = sm.forwarderID
            LEFT  JOIN Logistics.dbo.CostCenters  cc ON cc.centerCode  = sc.costCenter
            LEFT  JOIN Logistics.dbo.CostElements ce ON ce.elementCode = sc.costElement
            WHERE ISNULL(sc.migoStatus, 0) = 0
            ORDER BY sm.plannedCollection ASC, sm.shipmentID ASC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Freight spend analytics ───────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
    try {
        const pool   = await getPool();
        const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 60);

        // By forwarder
        const byForwarder = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT f.forwarderName,
                           SUM(sc.expectedCost) AS totalCost,
                           COUNT(*)                                      AS records
                    FROM Logistics.dbo.ShipmentCost sc
                    INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
                    LEFT  JOIN Logistics.dbo.Forwarders   f  ON f.forwarderID  = sm.forwarderID
                    WHERE sm.plannedCollection >= DATEADD(month, -@months, GETDATE())
                    GROUP BY f.forwarderName
                    ORDER BY totalCost DESC`);

        // By destination country
        const byCountry = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT sm.destinationCountry AS country,
                           SUM(sc.expectedCost) AS totalCost,
                           COUNT(*)                                      AS records
                    FROM Logistics.dbo.ShipmentCost sc
                    INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
                    WHERE sm.plannedCollection >= DATEADD(month, -@months, GETDATE())
                      AND sm.destinationCountry IS NOT NULL
                    GROUP BY sm.destinationCountry
                    ORDER BY totalCost DESC`);

        // By month
        const byMonth = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT
                        YEAR(sm.plannedCollection)  AS yr,
                        MONTH(sm.plannedCollection) AS mo,
                        SUM(sc.expectedCost) AS totalCost,
                        COUNT(*) AS records
                    FROM Logistics.dbo.ShipmentCost sc
                    INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
                    WHERE sm.plannedCollection >= DATEADD(month, -@months, GETDATE())
                      AND sm.plannedCollection IS NOT NULL
                    GROUP BY YEAR(sm.plannedCollection), MONTH(sm.plannedCollection)
                    ORDER BY yr ASC, mo ASC`);

        // By direction
        const byDirection = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT
                        CASE WHEN sm.originID = 0 OR sm.originID IS NULL THEN 'Outbound' ELSE 'Inbound' END AS direction,
                        SUM(sc.expectedCost) AS totalCost,
                        COUNT(*) AS records
                    FROM Logistics.dbo.ShipmentCost sc
                    INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
                    WHERE sm.plannedCollection >= DATEADD(month, -@months, GETDATE())
                    GROUP BY CASE WHEN sm.originID = 0 OR sm.originID IS NULL THEN 'Outbound' ELSE 'Inbound' END`);

        // By cost center
        const byCostCenter = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT cc.centerCode AS costCenter,
                           SUM(sc.expectedCost) AS totalCost,
                           COUNT(*) AS records
                    FROM Logistics.dbo.ShipmentCost sc
                    INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
                    LEFT  JOIN Logistics.dbo.CostCenters  cc ON cc.centerCode = sc.costCenter
                    WHERE sm.plannedCollection >= DATEADD(month, -@months, GETDATE())
                    GROUP BY cc.centerCode
                    ORDER BY totalCost DESC`);

        // By customer (destination name)
        const byCustomer = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT sm.destinationName AS customer,
                           SUM(sc.expectedCost) AS totalCost,
                           COUNT(*)             AS records
                    FROM Logistics.dbo.ShipmentCost sc
                    INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
                    WHERE sm.plannedCollection >= DATEADD(month, -@months, GETDATE())
                      AND sm.destinationName IS NOT NULL
                    GROUP BY sm.destinationName
                    ORDER BY totalCost DESC`);

        // By service mode (forwarderMode from Forwarders table)
        const byService = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT ISNULL(f.forwarderMode, 'Unassigned') AS service,
                           SUM(sc.expectedCost) AS totalCost,
                           COUNT(*)             AS records
                    FROM Logistics.dbo.ShipmentCost sc
                    INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
                    LEFT  JOIN Logistics.dbo.Forwarders   f  ON f.forwarderID  = sm.forwarderID
                    WHERE sm.plannedCollection >= DATEADD(month, -@months, GETDATE())
                    GROUP BY f.forwarderMode
                    ORDER BY totalCost DESC`);

        // Totals
        const totals = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT
                        COUNT(DISTINCT sc.shipmentID)                       AS shipments,
                        COUNT(*)                                             AS costRecords,
                        SUM(sc.expectedCost)         AS totalSpend,
                        SUM(CASE WHEN ISNULL(sc.migoStatus,0) = 0 THEN sc.expectedCost ELSE 0 END) AS unprocessedSpend,
                        SUM(CASE WHEN sc.migoStatus = 1               THEN sc.expectedCost ELSE 0 END) AS processedSpend
                    FROM Logistics.dbo.ShipmentCost sc
                    INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
                    WHERE sm.plannedCollection >= DATEADD(month, -@months, GETDATE())`);

        res.json({
            success: true,
            months,
            data: {
                totals:      totals.recordset[0],
                byForwarder: byForwarder.recordset,
                byCountry:   byCountry.recordset,
                byMonth:     byMonth.recordset,
                byDirection:  byDirection.recordset,
                byCostCenter: byCostCenter.recordset,
                byCustomer:   byCustomer.recordset,
                byService:    byService.recordset,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Post selected costs to SAP (MIGO) ────────────────────────────────────────
// Body: { costIDs: [1, 2, 3, ...] }
// Groups by shipmentID, sends to SapServer, marks successful lines migoStatus=1.
router.post('/post-migo', async (req, res) => {
    const { costIDs } = req.body;
    if (!Array.isArray(costIDs) || !costIDs.length)
        return res.status(400).json({ success: false, error: 'costIDs array is required.' });

    try {
        const pool = await getPool();

        // Build parameterised IN clause
        const req2 = pool.request();
        costIDs.forEach((id, i) => req2.input(`id${i}`, sql.BigInt, Number(id)));
        const inClause = costIDs.map((_, i) => `@id${i}`).join(',');

        const fetched = await req2.query(`
            SELECT sc.costID, sc.costCenter, sc.costElement, sc.expectedCost,
                   sm.shipmentID, sm.forwarderID, sm.actualCollection, sm.trackingNumber,
                   sm.destinationCountry, sm.destinationPostCode
            FROM Logistics.dbo.ShipmentCost sc
            INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
            WHERE sc.costID IN (${inClause})
              AND ISNULL(sc.migoStatus, 0) = 0`);

        if (!fetched.recordset.length)
            return res.status(404).json({ success: false, error: 'No unprocessed records found for the given IDs.' });

        // Group cost lines by shipmentID
        const groups = {};
        for (const r of fetched.recordset) {
            const key = String(r.shipmentID);
            if (!groups[key]) {
                groups[key] = {
                    shipmentID:           r.shipmentID,
                    actualCollectionDate: r.actualCollection,
                    forwarderID:          r.forwarderID,
                    location:             `${(r.destinationCountry  || '').slice(0, 2).toUpperCase()}` +
                                          `${(r.destinationPostCode || '').slice(0, 2).toUpperCase()}`,
                    trackingNumber:       r.trackingNumber || null,
                    costLines:            [],
                    _costIDs:             [],
                };
            }
            groups[key].costLines.push({
                costCenter:   r.costCenter   || null,
                costElement:  r.costElement  || null,
                expectedCost: r.expectedCost != null ? Number(r.expectedCost) : null,
            });
            groups[key]._costIDs.push(r.costID);
        }

        const payload = Object.values(groups).map(({ _costIDs, ...g }) => g);

        // Call SapServer
        const sapResp = await axios.post(
            `${sapConfig.url}/api/logistics/post-freight`,
            { shipments: payload },
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        );

        const sapBody = sapResp.data;
        if (!sapBody.success) throw new Error(sapBody.error ?? 'SapServer returned success=false');

        const sapResults = Array.isArray(sapBody.data) ? sapBody.data : [];
        const results    = [];

        for (const sr of sapResults) {
            const group = groups[String(sr.shipmentID)];
            if (!group) continue;

            if (sr.success && sr.materialDocument) {
                for (const costID of group._costIDs) {
                    await pool.request()
                        .input('costID',           sql.BigInt,     costID)
                        .input('materialDocument', sql.NVarChar(20), sr.materialDocument)
                        .query(`UPDATE Logistics.dbo.ShipmentCost
                                SET migoStatus = 1, materialDocument = @materialDocument
                                WHERE costID = @costID`);
                }
                results.push({ shipmentID: sr.shipmentID, success: true,  materialDocument: sr.materialDocument, costIDs: group._costIDs });
            } else {
                results.push({ shipmentID: sr.shipmentID, success: false, error: sr.error || 'No material document returned', costIDs: group._costIDs });
            }
        }

        res.json({ success: true, results });
    } catch (err) {
        const message = err.response?.data?.error ?? err.message;
        res.status(500).json({ success: false, error: message });
    }
});

export default router;
