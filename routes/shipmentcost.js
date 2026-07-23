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

// ── Delete an unprocessed cost line (outbound) — mirrors routes/inboundcosts.js's
// DELETE for the inbound side; used by the Associated Costs tile on the
// Search Shipment modal. Blocked once migoStatus=1 (already posted — use
// POST /:costId/reverse instead).
router.delete('/:costId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('costId', sql.BigInt, req.params.costId)
            .query(`DELETE FROM Logistics.dbo.ShipmentCost
                    OUTPUT DELETED.costID
                    WHERE costID = @costId AND ISNULL(migoStatus, 0) = 0`);
        if (!result.recordset.length)
            return res.status(400).json({ success: false, error: 'Line not found, or already posted to SAP.' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Get by ShipmentID — used by the Search Shipment modal's Associated
// Costs tile. Now returns elementDescription/tier like the inbound
// equivalent (routes/inboundcosts.js GET /shipment/:poShipmentId), wrapped
// in {success,data} — no existing caller depended on the old raw-array shape.
router.get('/shipment/:shipmentId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('shipmentId', sql.BigInt, req.params.shipmentId)
            .query(`
                SELECT sc.costID, sc.shipmentID, sc.costType, sc.costElement, sc.costCenter,
                       sc.expectedCost, sc.actualCost, sc.migoStatus, sc.materialDocument, sc.modeOfTransport,
                       ce.elementDescription, ce.tier
                FROM Logistics.dbo.ShipmentCost sc
                LEFT JOIN Logistics.dbo.CostElements ce ON ce.elementCode = sc.costElement AND ce.direction = 'outbound'
                WHERE sc.shipmentID = @shipmentId
                ORDER BY sc.costID DESC
            `);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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
                sm.ActualDelivery AS deliveredDate,
                (SELECT TOP 1 forwarderName FROM Logistics.dbo.Forwarders WHERE forwarderID = sm.forwarderID) AS forwarderName,
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
                ps.ReceivedAtUtc AS deliveredDate,
                (SELECT TOP 1 forwarderName FROM Logistics.dbo.Forwarders WHERE forwarderID = ps.ForwarderID) AS forwarderName,
                cc.centerCode  AS costCenter,
                ce.elementCode AS costElement,
                sc.expectedCost,
                sc.actualCost,
                sc.costType,
                sc.modeOfTransport,
                -- Inbound has no destination of its own (goods always come IN
                -- to Kongsberg) -- "location" here is the shipment's ORIGIN
                -- instead, resolved via OriginDestinationID. Only Manual
                -- Inbound Shipments currently set this; regular
                -- order-suggestion-derived shipments have no origin captured
                -- yet, so this is '-' for those until that's addressed.
                d.destinationCountry,
                d.destinationPostCode,
                ps.TrackingNumber AS trackingNumber
            FROM Logistics.dbo.ShipmentCost sc
            INNER JOIN dbo.PurchaseOrderShipment ps ON ps.ShipmentId = sc.poShipmentID
            LEFT  JOIN Logistics.dbo.CostCenters   cc ON cc.centerCode  = sc.costCenter
            LEFT  JOIN Logistics.dbo.CostElements  ce ON ce.elementCode = sc.costElement
            LEFT  JOIN Logistics.dbo.Destinations  d  ON d.destinationID = ps.OriginDestinationID
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

// ── Post selected costs to SAP (MIGO) ────────────────────────────────────────
// Body: { costIDs: [1, 2, 3, ...] }
// Groups by shipment (outbound shipmentID or inbound poShipmentID — see
// GET /unprocessed above for the same UNION), sends to SapServer, marks
// successful lines migoStatus=1. Deliberately calls
// /api/logistics/post-freight, NOT SapServer's BAPI_ACC_DOCUMENT_POST
// (/api/costing/freight-posting) — per the user, this needs to go through
// post-migo and whatever real MIGO/PO mechanism they build there
// themselves (material group per the modeOfTransport on each line factors
// into that), not a straight FI/AP document posting. post-freight doesn't
// exist in SapServer yet, so this will fail until that's built — known and
// expected, do not "fix" it by substituting a different SAP call.
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
            SELECT sc.costID, sc.costCenter, sc.costElement, sc.expectedCost, sc.modeOfTransport,
                   'outbound' AS direction, sm.shipmentID AS refID,
                   RIGHT('000000' + CONVERT(VARCHAR(12), sm.shipmentID), 6) AS shipmentRef,
                   sm.forwarderID, sm.actualCollection, sm.ActualDelivery AS deliveredDate, sm.trackingNumber,
                   sm.destinationCountry, sm.destinationPostCode
            FROM Logistics.dbo.ShipmentCost sc
            INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
            WHERE sc.costID IN (${inClause}) AND ISNULL(sc.migoStatus, 0) = 0

            UNION ALL

            SELECT sc.costID, sc.costCenter, sc.costElement, sc.expectedCost, sc.modeOfTransport,
                   'inbound' AS direction, ps.ShipmentId AS refID,
                   ps.ShipmentReference AS shipmentRef,
                   ps.ForwarderID AS forwarderID, ps.DispatchDate AS actualCollection, ps.ReceivedAtUtc AS deliveredDate, ps.TrackingNumber AS trackingNumber,
                   d.destinationCountry, d.destinationPostCode
            FROM Logistics.dbo.ShipmentCost sc
            INNER JOIN dbo.PurchaseOrderShipment ps ON ps.ShipmentId = sc.poShipmentID
            LEFT  JOIN Logistics.dbo.Destinations d ON d.destinationID = ps.OriginDestinationID
            WHERE sc.costID IN (${inClause}) AND ISNULL(sc.migoStatus, 0) = 0`);

        if (!fetched.recordset.length)
            return res.status(404).json({ success: false, error: 'No unprocessed records found for the given IDs.' });

        // Nothing posts to SAP until the shipment has actually been
        // delivered/received — marked from the in-transit section
        // (outbound, ShipmentMain.ActualDelivery) or the Inbound Log's Mark
        // Received action (inbound, PurchaseOrderShipment.ReceivedAtUtc).
        // This stops costs going to SAP before the service is fully
        // tendered, in case a price adjustment is still needed. Rows
        // missing this are dropped from processing and reported back
        // rather than silently posted or silently ignored.
        const blockedCostIDs = fetched.recordset.filter(r => !r.deliveredDate).map(r => r.costID);
        const deliverable    = fetched.recordset.filter(r => r.deliveredDate);

        if (!deliverable.length) {
            return res.status(400).json({
                success: false,
                error: 'None of the selected lines have been delivered/received yet — nothing to post.',
                blockedCostIDs,
            });
        }

        // Group cost lines by direction+shipment — direction is part of the
        // key because outbound shipmentID and inbound poShipmentID are
        // separate identity spaces and can collide numerically.
        const groups = {};
        for (const r of deliverable) {
            const key = `${r.direction}:${r.refID}`;
            if (!groups[key]) {
                groups[key] = {
                    direction:            r.direction,
                    shipmentID:           r.direction === 'outbound' ? r.refID : null,
                    poShipmentID:         r.direction === 'inbound'  ? r.refID : null,
                    shipmentReference:    r.shipmentRef,
                    actualCollectionDate: r.actualCollection,
                    deliveredDate:        r.deliveredDate,
                    forwarderID:          r.forwarderID,
                    modeOfTransport:      r.modeOfTransport,
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
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken(req.session?.user?.userID)}` } }
        );

        const sapBody = sapResp.data;
        if (!sapBody.success) throw new Error(sapBody.error ?? 'SapServer returned success=false');

        const sapResults = Array.isArray(sapBody.data) ? sapBody.data : [];
        const results    = [];

        for (const sr of sapResults) {
            const group = groups[`${sr.direction || 'outbound'}:${sr.direction === 'inbound' ? sr.poShipmentID : sr.shipmentID}`];
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

        res.json({ success: true, results, blockedCostIDs });
    } catch (err) {
        const message = err.response?.data?.error ?? err.message;
        res.status(500).json({ success: false, error: message });
    }
});

// ── Reverse a posted cost line (MB01 goods receipt) ──────────────────────────
// Works for both directions — costID is the same table/key either way.
// Calls SapServer's POST /api/purchasing/reverse-goods-receipt, which reuses
// the existing MBST BDC (see PurchasingController.cs). On a successful
// reversal (SAP message type "S"), clears migoStatus/materialDocument so the
// line drops back into Unprocessed Costs for correction and re-posting.
router.post('/:costId/reverse', async (req, res) => {
    try {
        const pool = await getPool();
        const costId = Number(req.params.costId);

        const { recordset } = await pool.request()
            .input('costId', sql.BigInt, costId)
            .query(`SELECT costID, migoStatus, materialDocument FROM Logistics.dbo.ShipmentCost WHERE costID = @costId`);

        const row = recordset[0];
        if (!row) return res.status(404).json({ success: false, error: 'Cost line not found.' });
        if (!row.migoStatus || !row.materialDocument)
            return res.status(400).json({ success: false, error: 'This line has not been posted to SAP yet — nothing to reverse.' });

        const sapResp = await axios.post(
            `${sapConfig.url}/api/purchasing/reverse-goods-receipt`,
            { materialDocument: row.materialDocument },
            { timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken(req.session?.user?.userID)}` } }
        );

        const sapBody = sapResp.data;
        if (!sapBody.success) throw new Error(sapBody.error ?? 'SapServer returned success=false');

        const bdc = sapBody.data || {};
        const reversed = bdc.type === 'S';

        if (reversed) {
            await pool.request()
                .input('costId', sql.BigInt, costId)
                .query(`UPDATE Logistics.dbo.ShipmentCost
                        SET migoStatus = 0, materialDocument = NULL
                        WHERE costID = @costId`);
        }

        res.json({ success: reversed, message: bdc.message || bdc.rawMessage || '', raw: bdc });
    } catch (err) {
        const message = err.response?.data?.error ?? err.message;
        res.status(500).json({ success: false, error: message });
    }
});

export default router;
