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

// userId is threaded through so SapServer's per-user permission check
// (CostingHelper.FnReadTables) is evaluated against whoever actually
// clicked Post to SAP, not a fixed service account.
function makeSapToken(userId) {
    return jwt.sign({ userId: userId ?? 0 }, sapServerSecret,
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
            expectedCost, actualCost, migoStatus, materialDocument,
            poShipmentID, modeOfTransport
        } = req.body;

        const pool = await getPool();
        const result = await pool.request()
            .input('shipmentID', sql.BigInt, shipmentID ?? null)
            .input('poShipmentID', sql.Int, poShipmentID ?? null)
            .input('costType', sql.NVarChar, costType)
            .input('costElement', sql.NVarChar, costElement)
            .input('costCenter', sql.NVarChar, costCenter)
            .input('expectedCost', sql.Decimal, expectedCost)
            .input('actualCost', sql.Decimal, actualCost)
            .input('migoStatus', sql.Bit, migoStatus ?? 0)
            .input('materialDocument', sql.NVarChar, materialDocument)
            .input('modeOfTransport', sql.NVarChar(20), modeOfTransport || null)
            .query(`INSERT INTO Logistics.dbo.ShipmentCost
                (shipmentID, poShipmentID, costType, costElement, costCenter,
                 expectedCost, actualCost, migoStatus, materialDocument, modeOfTransport)
                VALUES
                (@shipmentID, @poShipmentID, @costType, @costElement, @costCenter,
                 @expectedCost, @actualCost, @migoStatus, @materialDocument, @modeOfTransport);
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
// Unified outbound + inbound — a single UNION ALL rather than two separate
// tiles/endpoints, per the user: inbound cost lines (Logistics.dbo.
// ShipmentCost.poShipmentID set, from routes/inboundcosts.js) belong in the
// exact same log as outbound (shipmentID set), and post through the same
// POST /post-migo below. `direction` distinguishes the two in the UI;
// `shipmentRef` is a display-ready reference for both (outbound has no
// text reference of its own, so it's the zero-padded shipmentID, matching
// the frontend's existing formatting).
router.get('/unprocessed', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query(`SELECT
                sc.costID,
                'outbound' AS direction,
                sm.shipmentID,
                RIGHT('000000' + CONVERT(VARCHAR(12), sm.shipmentID), 6) AS shipmentRef,
                sm.forwarderID,
                sm.plannedCollection,
                sm.actualCollection,
                f.forwarderName,
                cc.centerCode  AS costCenter,
                ce.elementCode AS costElement,
                sc.expectedCost,
                sc.actualCost,
                sc.costType,
                sc.modeOfTransport,
                sm.destinationCountry,
                sm.destinationPostCode,
                sm.trackingNumber
            FROM Logistics.dbo.ShipmentCost sc
            INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
            LEFT  JOIN Logistics.dbo.Forwarders   f  ON f.forwarderID  = sm.forwarderID
            LEFT  JOIN Logistics.dbo.CostCenters  cc ON cc.centerCode  = sc.costCenter
            LEFT  JOIN Logistics.dbo.CostElements ce ON ce.elementCode = sc.costElement
            WHERE ISNULL(sc.migoStatus, 0) = 0 AND sc.shipmentID IS NOT NULL

            UNION ALL

            SELECT
                sc.costID,
                'inbound' AS direction,
                NULL AS shipmentID,
                ps.ShipmentReference AS shipmentRef,
                ps.ForwarderID AS forwarderID,
                ps.DispatchDate AS plannedCollection,
                NULL AS actualCollection,
                f.forwarderName,
                cc.centerCode  AS costCenter,
                ce.elementCode AS costElement,
                sc.expectedCost,
                sc.actualCost,
                sc.costType,
                sc.modeOfTransport,
                NULL AS destinationCountry,
                NULL AS destinationPostCode,
                ps.TrackingNumber AS trackingNumber
            FROM Logistics.dbo.ShipmentCost sc
            INNER JOIN dbo.PurchaseOrderShipment ps ON ps.ShipmentId = sc.poShipmentID
            LEFT  JOIN Logistics.dbo.Forwarders   f  ON f.forwarderID  = ps.ForwarderID
            LEFT  JOIN Logistics.dbo.CostCenters  cc ON cc.centerCode  = sc.costCenter
            LEFT  JOIN Logistics.dbo.CostElements ce ON ce.elementCode = sc.costElement
            WHERE ISNULL(sc.migoStatus, 0) = 0 AND sc.poShipmentID IS NOT NULL

            ORDER BY plannedCollection ASC, shipmentID ASC`);
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

// ── Post selected costs to SAP ───────────────────────────────────────────────
// Body: { costIDs: [1, 2, 3, ...] }
// Unified outbound + inbound (see GET /unprocessed above) — one call to
// SapServer's BAPI_ACC_DOCUMENT_POST per cost line via the real, working
// /api/costing/freight-posting endpoint. NOT the old grouped-by-shipment
// design this route used to have: that assumed a SapServer endpoint
// (/api/logistics/post-freight) that could take several GL lines in one
// call and post them as a single document — that endpoint never existed in
// SapServer (confirmed via grep), so this route never actually worked.
// freight-posting only accepts one GL line per call, so each cost line
// becomes its own accounting document; results are still shaped as
// [{shipmentID, success, materialDocument?, error?, costIDs:[costID]}] (one
// entry per line, costIDs always length 1) to keep the existing frontend
// unchanged — it only reads result.costIDs to find which rows to update.
router.post('/post-migo', async (req, res) => {
    const { costIDs } = req.body;
    if (!Array.isArray(costIDs) || !costIDs.length)
        return res.status(400).json({ success: false, error: 'costIDs array is required.' });

    try {
        const pool = await getPool();

        const req2 = pool.request();
        costIDs.forEach((id, i) => req2.input(`id${i}`, sql.BigInt, Number(id)));
        const inClause = costIDs.map((_, i) => `@id${i}`).join(',');

        const fetched = await req2.query(`
            SELECT sc.costID, sc.costCenter, sc.costElement, sc.expectedCost,
                   'outbound' AS direction, sm.shipmentID AS refID,
                   RIGHT('000000' + CONVERT(VARCHAR(12), sm.shipmentID), 6) AS shipmentRef,
                   sm.forwarderID
            FROM Logistics.dbo.ShipmentCost sc
            INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
            WHERE sc.costID IN (${inClause}) AND ISNULL(sc.migoStatus, 0) = 0

            UNION ALL

            SELECT sc.costID, sc.costCenter, sc.costElement, sc.expectedCost,
                   'inbound' AS direction, ps.ShipmentId AS refID,
                   ps.ShipmentReference AS shipmentRef,
                   ps.ForwarderID AS forwarderID
            FROM Logistics.dbo.ShipmentCost sc
            INNER JOIN dbo.PurchaseOrderShipment ps ON ps.ShipmentId = sc.poShipmentID
            WHERE sc.costID IN (${inClause}) AND ISNULL(sc.migoStatus, 0) = 0`);

        if (!fetched.recordset.length)
            return res.status(404).json({ success: false, error: 'No unprocessed records found for the given IDs.' });

        const docDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const token   = makeSapToken(req.session?.user?.userID);
        const results = [];

        for (const r of fetched.recordset) {
            if (!r.forwarderID) {
                results.push({ shipmentID: r.refID, success: false, error: 'No haulier/forwarder set on this shipment — vendor is required to post.', costIDs: [r.costID] });
                continue;
            }
            if (!r.costElement || !r.costCenter) {
                results.push({ shipmentID: r.refID, success: false, error: 'Cost line is missing a GL element or cost centre.', costIDs: [r.costID] });
                continue;
            }
            try {
                const sapResp = await axios.post(
                    `${sapConfig.url}/api/costing/freight-posting`,
                    {
                        docDate,
                        vendor:       String(r.forwarderID),
                        amount:       Number(r.expectedCost),
                        currency:     'GBP',
                        glAccount:    r.costElement,
                        profitCenter: r.costCenter,
                        shipment:     r.shipmentRef,
                        information:  `${r.direction === 'inbound' ? 'Inbound' : 'Outbound'} freight — ${r.shipmentRef}`,
                    },
                    { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
                );
                const body = sapResp.data;
                const accountingNumber = body?.data?.accountingNumber;
                if (!body?.success || !accountingNumber) {
                    results.push({ shipmentID: r.refID, success: false, error: body?.error?.message || 'Posting failed.', costIDs: [r.costID] });
                    continue;
                }
                await pool.request()
                    .input('costID', sql.BigInt, r.costID)
                    .input('materialDocument', sql.NVarChar(20), accountingNumber)
                    .query(`UPDATE Logistics.dbo.ShipmentCost SET migoStatus = 1, materialDocument = @materialDocument WHERE costID = @costID`);
                results.push({ shipmentID: r.refID, success: true, materialDocument: accountingNumber, costIDs: [r.costID] });
            } catch (err) {
                results.push({ shipmentID: r.refID, success: false, error: err.message, costIDs: [r.costID] });
            }
        }

        res.json({ success: true, results });
    } catch (err) {
        const message = err.response?.data?.error ?? err.message;
        res.status(500).json({ success: false, error: message });
    }
});

export default router;
