import express from 'express';
import sql    from 'mssql';
import axios  from 'axios';
import https  from 'https';
import jwt    from 'jsonwebtoken';
import fs     from 'fs';
import { sqlConfig, sapConfig, sapServerSecret, getLogisticsPool } from '../config.js';
import { getDecryptedSapCredentials } from '../lib/sapCredentials.js';
import { lookupMaterialGroup } from './materialgroups.js';
import { requireAnyPermission } from '../middleware/auth.js';

const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
    ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
    : null;

// userId is threaded through so SapServer's per-user permission check
// (CostingHelper.FnReadTables) is evaluated against whoever actually
// clicked Post to SAP, not a fixed service account.
function makeSapToken(userId) {
    return jwt.sign({ userId: userId ?? 0 }, sapServerSecret,
        { issuer: 'normanton-nexus', audience: 'sap-server', expiresIn: '60s' });
}

// SapServer's ApiResponse.Fail() puts the generic error under body.error.message
// and the real diagnostic (the SAP RETURN-table messages, e.g. "Vendor 12345 does
// not exist" or "Cost center 4200 is locked for posting") under body.data.poMessages
// — see PurchasingController.CreatePurchaseOrderAndReceipt. Without this, callers
// only ever see the generic "Purchase order creation failed. Transaction rolled
// back." wrapper and never the reason SAP actually gave, which was the whole point
// of returning PoMessages in the first place.
function extractSapErrorMessage(body, fallback) {
    const base = body?.error?.message || body?.error || fallback;
    const poMessages = body?.data?.poMessages;
    if (Array.isArray(poMessages) && poMessages.length > 0) {
        const detail = poMessages
            .filter(m => m?.message)
            .map(m => (m.type ? `[${m.type}] ${m.message}` : m.message))
            .join('; ');
        if (detail) return `${base} ${detail}`;
    }
    return base;
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

// ── Edit an unprocessed cost line's amount (outbound) — mirrors the DELETE
// guard below (blocked once migoStatus=1 — reverse first via
// POST /:costId/reverse, then it drops back to Unprocessed Costs and can be
// edited/reposted). Lets a wrong amount be corrected in place instead of
// deleting and re-adding, which the Associated Costs tile on the Search
// Shipment modal previously had no way to do at all.
router.patch('/:costId', async (req, res) => {
    try {
        const { expectedCost } = req.body;
        const amount = Number(expectedCost);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, error: 'expectedCost must be a positive number.' });
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('costId',       sql.BigInt,         req.params.costId)
            .input('expectedCost', sql.Decimal(18, 2), amount)
            .query(`UPDATE Logistics.dbo.ShipmentCost
                    SET expectedCost = @expectedCost
                    OUTPUT INSERTED.costID
                    WHERE costID = @costId AND ISNULL(migoStatus, 0) = 0`);

        if (!result.recordset.length)
            return res.status(400).json({ success: false, error: 'Line not found, or already posted to SAP.' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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
//
// Validation added for the outbound "+ Add Cost" flow on the Search
// Shipment modal (renderShipmentAssociatedCosts in logistics.js), the first
// caller to hit this with hand-entered form data rather than values the
// server itself computed — shipmentID/costElement/costCenter/expectedCost
// previously went straight into the INSERT with no checks at all.
router.post('/', async (req, res) => {
    try {
        const {
            shipmentID, costType, costElement, costCenter,
            expectedCost, actualCost, migoStatus, materialDocument,
            poShipmentID, modeOfTransport
        } = req.body;

        if (!shipmentID && !poShipmentID) {
            return res.status(400).json({ error: 'shipmentID or poShipmentID is required.' });
        }
        if (!costElement || !String(costElement).trim()) {
            return res.status(400).json({ error: 'costElement is required.' });
        }
        if (!costCenter || !String(costCenter).trim()) {
            return res.status(400).json({ error: 'costCenter is required.' });
        }
        const expectedCostNum = Number(expectedCost);
        if (!Number.isFinite(expectedCostNum) || expectedCostNum <= 0) {
            return res.status(400).json({ error: 'expectedCost must be a positive number.' });
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('shipmentID', sql.BigInt, shipmentID ?? null)
            .input('poShipmentID', sql.Int, poShipmentID ?? null)
            .input('costType', sql.NVarChar, costType)
            .input('costElement', sql.NVarChar, costElement)
            .input('costCenter', sql.NVarChar, costCenter)
            .input('expectedCost', sql.Decimal, expectedCostNum)
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
                RIGHT('00000000' + CONVERT(VARCHAR(12), sm.shipmentID), 8) AS shipmentRef,
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
            INNER JOIN Kongsberg.dbo.PurchaseOrderShipment ps ON ps.ShipmentId = sc.poShipmentID
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
// Both queries below UNION ALL an outbound leg (ShipmentCost.shipmentID ->
// ShipmentMain) with an inbound leg (ShipmentCost.poShipmentID ->
// dbo.PurchaseOrderShipment, see sql/migrate_order_shipments.sql) —
// every one of these previously only INNER JOINed ShipmentMain, so any
// inbound cost line (which has shipmentID NULL and poShipmentID set
// instead — see the post-migo UNION ALL a little further down this file)
// was silently dropped from every report entirely. Inbound's "period"
// date is DispatchDate (falling back to CreatedAtUtc if not yet
// dispatched) since PurchaseOrderShipment has no plannedCollection
// equivalent; "country"/"customer" for inbound come from the origin
// Destinations row (OriginDestinationID) rather than a UK destination.
// Forwarders is NOT one row per forwarderID — a vendor with several
// shipping modes (Road/Sea/Air) gets one row PER MODE, all sharing the same
// forwarderID/forwarderName (see routes/forwarders.js's PUT comment, and
// task #317's dedupeForwardersByName frontend workaround for the same
// shape). A plain LEFT JOIN ... ON f.forwarderID = ... therefore fans out
// every cost line by however many mode-rows that forwarder has — a
// forwarder with 4 modes on file quietly quadrupled every SUM(expectedCost)
// below (totals, byForwarder, byCountry, byMonth, byCostCenter, byCustomer,
// byDirection, byService all inherit from these two subqueries). OUTER
// APPLY ... TOP 1 pins it to exactly one row per cost line, matching the
// already-correct pattern used for the same problem in shipmentmain.js's
// in-transit query (OUTER APPLY (SELECT TOP 1 ...) fa).
const COMBINED_COST_OUTBOUND = `
    SELECT sc.expectedCost, sc.migoStatus, sc.costCenter,
           fa.forwarderName, fa.forwarderMode,
           sm.destinationCountry AS country,
           sm.destinationName    AS customerLabel,
           sm.plannedCollection  AS periodDate,
           'O:' + CONVERT(VARCHAR(20), sm.shipmentID) AS shipmentKey
    FROM Logistics.dbo.ShipmentCost sc
    INNER JOIN Logistics.dbo.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
    OUTER APPLY (
        SELECT TOP 1 f.forwarderName, f.forwarderMode
        FROM Logistics.dbo.Forwarders f
        WHERE f.forwarderID = sm.forwarderID
    ) fa
    WHERE sc.shipmentID IS NOT NULL`;
const COMBINED_COST_INBOUND = `
    SELECT sc.expectedCost, sc.migoStatus, sc.costCenter,
           fa.forwarderName, fa.forwarderMode,
           d.destinationCountry AS country,
           d.destinationName    AS customerLabel,
           ISNULL(ps.DispatchDate, ps.CreatedAtUtc) AS periodDate,
           'I:' + CONVERT(VARCHAR(20), ps.ShipmentId) AS shipmentKey
    FROM Logistics.dbo.ShipmentCost sc
    INNER JOIN dbo.PurchaseOrderShipment ps ON ps.ShipmentId = sc.poShipmentID
    OUTER APPLY (
        SELECT TOP 1 f.forwarderName, f.forwarderMode
        FROM Logistics.dbo.Forwarders f
        WHERE f.forwarderID = ps.ForwarderID
    ) fa
    LEFT  JOIN Logistics.dbo.Destinations d  ON d.destinationID = ps.OriginDestinationID
    WHERE sc.poShipmentID IS NOT NULL`;
const COMBINED_COST = `(${COMBINED_COST_OUTBOUND} UNION ALL ${COMBINED_COST_INBOUND}) cc`;

// Freight Spend Analytics — read-only dashboard, moved into the Logistics
// page's Reports section (see sql/migrate_log_reports_permission.sql).
// Gated on any of LOG_ADMIN/LOG_MRP/LOG_REPORTS: LOG_ADMIN already had this
// (it lived under the old Admin section), LOG_MRP is included so the tile's
// shared Reports section (which Stock Value Overview/by Price also sit in,
// those being LOG_MRP-gated) doesn't show a tile that then 403s on click,
// and LOG_REPORTS is the new report-only path in.
router.get('/analytics', requireAnyPermission(['LOG_ADMIN', 'LOG_MRP', 'LOG_REPORTS']), async (req, res) => {
    try {
        const pool   = await getPool();
        const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 60);

        // By forwarder
        const byForwarder = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT cc.forwarderName,
                           SUM(cc.expectedCost) AS totalCost,
                           COUNT(*)                                      AS records
                    FROM ${COMBINED_COST}
                    WHERE cc.periodDate >= DATEADD(month, -@months, GETDATE())
                    GROUP BY cc.forwarderName
                    ORDER BY totalCost DESC`);

        // By country (destination for outbound, origin for inbound)
        const byCountry = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT cc.country,
                           SUM(cc.expectedCost) AS totalCost,
                           COUNT(*)                                      AS records
                    FROM ${COMBINED_COST}
                    WHERE cc.periodDate >= DATEADD(month, -@months, GETDATE())
                      AND cc.country IS NOT NULL
                    GROUP BY cc.country
                    ORDER BY totalCost DESC`);

        // By month
        const byMonth = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT
                        YEAR(cc.periodDate)  AS yr,
                        MONTH(cc.periodDate) AS mo,
                        SUM(cc.expectedCost) AS totalCost,
                        COUNT(*) AS records
                    FROM ${COMBINED_COST}
                    WHERE cc.periodDate >= DATEADD(month, -@months, GETDATE())
                      AND cc.periodDate IS NOT NULL
                    GROUP BY YEAR(cc.periodDate), MONTH(cc.periodDate)
                    ORDER BY yr ASC, mo ASC`);

        // By direction — now meaningful again now that inbound rows are
        // actually present (previously always all "Outbound", since the
        // old query could never see an inbound-only cost line at all).
        const byDirection = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT
                        CASE WHEN LEFT(cc.shipmentKey, 1) = 'O' THEN 'Outbound' ELSE 'Inbound' END AS direction,
                        SUM(cc.expectedCost) AS totalCost,
                        COUNT(*) AS records
                    FROM ${COMBINED_COST}
                    WHERE cc.periodDate >= DATEADD(month, -@months, GETDATE())
                    GROUP BY CASE WHEN LEFT(cc.shipmentKey, 1) = 'O' THEN 'Outbound' ELSE 'Inbound' END`);

        // By cost center
        const byCostCenter = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT ctr.centerCode AS costCenter,
                           SUM(cc.expectedCost) AS totalCost,
                           COUNT(*) AS records
                    FROM ${COMBINED_COST}
                    LEFT JOIN Logistics.dbo.CostCenters ctr ON ctr.centerCode = cc.costCenter
                    WHERE cc.periodDate >= DATEADD(month, -@months, GETDATE())
                    GROUP BY ctr.centerCode
                    ORDER BY totalCost DESC`);

        // By customer (destination name for outbound, origin name for inbound)
        const byCustomer = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT cc.customerLabel AS customer,
                           SUM(cc.expectedCost) AS totalCost,
                           COUNT(*)             AS records
                    FROM ${COMBINED_COST}
                    WHERE cc.periodDate >= DATEADD(month, -@months, GETDATE())
                      AND cc.customerLabel IS NOT NULL
                    GROUP BY cc.customerLabel
                    ORDER BY totalCost DESC`);

        // By service mode (forwarderMode from Forwarders table)
        const byService = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT ISNULL(cc.forwarderMode, 'Unassigned') AS service,
                           SUM(cc.expectedCost) AS totalCost,
                           COUNT(*)             AS records
                    FROM ${COMBINED_COST}
                    WHERE cc.periodDate >= DATEADD(month, -@months, GETDATE())
                    GROUP BY cc.forwarderMode
                    ORDER BY totalCost DESC`);

        // Totals — DISTINCT is over shipmentKey (direction-tagged), not the
        // raw shipmentID, since outbound shipmentID and inbound poShipmentID
        // are separate identity spaces and can collide numerically.
        const totals = await pool.request()
            .input('months', sql.Int, months)
            .query(`SELECT
                        COUNT(DISTINCT cc.shipmentKey)                       AS shipments,
                        COUNT(*)                                             AS costRecords,
                        SUM(cc.expectedCost)         AS totalSpend,
                        SUM(CASE WHEN ISNULL(cc.migoStatus,0) = 0 THEN cc.expectedCost ELSE 0 END) AS unprocessedSpend,
                        SUM(CASE WHEN cc.migoStatus = 1               THEN cc.expectedCost ELSE 0 END) AS processedSpend
                    FROM ${COMBINED_COST}
                    WHERE cc.periodDate >= DATEADD(month, -@months, GETDATE())`);

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
// GET /unprocessed above for the same UNION), one PO + one goods receipt per
// cost line per shipment group, via SapServer's elevated
// POST /api/purchasing/create-po-and-receipt (task #415). Marks successful
// lines migoStatus=1.
//
// This runs under the CALLING USER's own SAP credentials, not the shared
// service account — the service account doesn't have (and isn't being
// given) rights to create purchase orders. The caller must have already
// saved their SAP username/password via My Account (POST
// /api/profile/sap-credentials, see lib/sapCredentials.js); if not, this
// fails fast with a clear message rather than a confusing SAP logon error.
//
// Vendor = the shipment's forwarderID (forwarderID doubles as the SAP
// vendor number — see routes/forwarders.js). MaterialGroup used to be
// derived as free text from modeOfTransport (e.g. "Road Freight") — that
// wasn't a real SAP material group code and is exactly why PO creation
// kept rolling back (confirmed by testing the real code, ITLG01A, directly
// against SapServer). It's now looked up per line via
// materialgroups.js's lookupMaterialGroup(costElement, modeOfTransport) —
// see sql/migrate_material_group_mapping.sql. GlAccount/CostCenterOrOrder
// come straight from the cost line's costElement/costCenter, same as before.
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
                   RIGHT('00000000' + CONVERT(VARCHAR(12), sm.shipmentID), 8) AS shipmentRef,
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

        // PO creation needs to run as the calling user's own SAP account —
        // the shared service account doesn't have (and isn't being given)
        // rights to create purchase orders. Decrypted here, in memory, just
        // before the call, then sent once over the existing TLS-pinned
        // Node->SapServer connection for this request only — see
        // lib/sapCredentials.js for the full reasoning.
        const callerUserId = req.session?.user?.userID;
        const sapCreds = await getDecryptedSapCredentials(callerUserId);
        if (!sapCreds) {
            return res.status(400).json({
                success: false,
                error: 'You need to save your SAP username and password in My Account before posting costs to SAP.',
                blockedCostIDs,
            });
        }

        const today = new Date().toISOString().slice(0, 10);
        const results = [];

        // One PO + one goods receipt per cost line, per shipment group — via
        // SapServer's elevated POST /api/purchasing/create-po-and-receipt
        // (task #415). Sequential on purpose: the pool only has a handful of
        // elevated slots, and each call already does logon->PO->commit->
        // GR-per-line->logoff as one unit of work, so there's nothing to gain
        // from firing every group at once.
        for (const group of Object.values(groups)) {
            const deliveredDayStr = group.deliveredDate ? new Date(group.deliveredDate).toISOString().slice(0, 10) : today;

            // MaterialGroup is looked up per line (not per group) because
            // costElement/GL account can differ line-to-line within the
            // same shipment group, and the mapping is keyed on GL account
            // (+ mode of transport) — see materialgroups.js. A missing
            // mapping throws with the exact combination that's needed, so
            // it's resolved BEFORE calling SAP: better to fail clearly here
            // than send SapServer another bad code that just rolls back
            // with a confusing SAP-side error.
            let items;
            try {
                items = await Promise.all(group.costLines.map(async line => ({
                    ShortText:              `Freight - ${group.direction} shipment ${group.shipmentReference}`,
                    Quantity:                1,
                    Unit:                    'EA',
                    NetPrice:                line.expectedCost ?? 0,
                    DeliveryDate:            deliveredDayStr,
                    AcctAssCat:              'K',
                    MaterialGroup:           await lookupMaterialGroup(line.costElement, group.modeOfTransport),
                    GlAccount:               line.costElement,
                    CostCenterOrOrder:       line.costCenter,
                    Reference:               group.shipmentReference,
                    TrackingNumber:          group.trackingNumber || '',
                    AddressCode:             group.location,
                    ShipmentCompletionDate:  deliveredDayStr,
                    PostingDate:             today,
                })));
            } catch (lookupErr) {
                for (const costID of group._costIDs) {
                    results.push({
                        shipmentID: group.direction === 'inbound' ? group.poShipmentID : group.shipmentID,
                        direction:  group.direction,
                        costID,
                        success:    false,
                        error:      lookupErr.message,
                    });
                }
                continue;
            }

            try {
                const sapResp = await axios.post(
                    `${sapConfig.url}/api/purchasing/create-po-and-receipt`,
                    {
                        SapUsername: sapCreds.sapUsername,
                        SapPassword: sapCreds.sapPassword,
                        Vendor:      String(group.forwarderID || ''),
                        Currency:    'GBP',
                        DocDate:     today,
                        Items:       items,
                    },
                    { timeout: 90000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken(callerUserId)}` } }
                );

                const sapBody = sapResp.data;
                if (!sapBody.success) throw new Error(extractSapErrorMessage(sapBody, 'SapServer returned success=false'));

                const poResult = sapBody.data || {};

                // group.costLines/_costIDs and items above are all built in
                // the same order, so poResult.lines[i] lines up with
                // group._costIDs[i] positionally.
                for (let i = 0; i < group._costIDs.length; i++) {
                    const costID = group._costIDs[i];
                    const line   = poResult.lines?.[i];

                    if (line?.success && line.documentNumber) {
                        await pool.request()
                            .input('costID',           sql.BigInt,       costID)
                            .input('materialDocument', sql.NVarChar(20), line.documentNumber)
                            .input('purchaseOrder',    sql.NVarChar(20), poResult.purchaseOrder || null)
                            .query(`UPDATE Logistics.dbo.ShipmentCost
                                    SET migoStatus = 1, materialDocument = @materialDocument, purchaseOrder = @purchaseOrder
                                    WHERE costID = @costID`);
                        results.push({
                            shipmentID:    group.direction === 'inbound' ? group.poShipmentID : group.shipmentID,
                            direction:     group.direction,
                            costID,
                            success:       true,
                            purchaseOrder: poResult.purchaseOrder,
                            materialDocument: line.documentNumber,
                        });
                    } else {
                        results.push({
                            shipmentID:    group.direction === 'inbound' ? group.poShipmentID : group.shipmentID,
                            direction:     group.direction,
                            costID,
                            success:       false,
                            purchaseOrder: poResult.purchaseOrder || null,
                            error:         line?.error || (poResult.poSuccess === false ? 'Purchase order creation failed' : 'Goods receipt failed'),
                        });
                    }
                }
            } catch (groupErr) {
                // SapServer returns PO-creation failures as an HTTP 400 (BadRequest),
                // so this is the path that actually catches them — the sapBody.success
                // check above only fires for a 200-with-success:false response, which
                // this endpoint never sends. extractSapErrorMessage pulls in the real
                // SAP RETURN-table text from groupErr.response.data.data.poMessages,
                // not just the generic "Purchase order creation failed. Transaction
                // rolled back." wrapper — that's the fix for the message shown here
                // previously carrying no diagnostic detail at all.
                const message = extractSapErrorMessage(groupErr.response?.data, groupErr.message);
                for (const costID of group._costIDs) {
                    results.push({
                        shipmentID: group.direction === 'inbound' ? group.poShipmentID : group.shipmentID,
                        direction:  group.direction,
                        costID,
                        success:    false,
                        error:      message,
                    });
                }
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
