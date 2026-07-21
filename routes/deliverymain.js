import express from 'express';
import sql from 'mssql';
import axios from 'axios';
import { sqlConfig, sapConfig } from '../config.js';
import { requirePermission } from '../middleware/auth.js';
import { makeSapToken, sapAgent } from './sap.js';
import { reverseStagedPackage } from './sapStaging.js';

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
            .input('dateFrom', sql.DateTime, new Date(dateFrom))
            .input('dateTo', sql.DateTime, new Date(dateTo))
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
            .input('dispatchDate', sql.DateTime, dispatchDate ? new Date(dispatchDate) : null)
            .input('deliveryDate', sql.DateTime, deliveryDate ? new Date(deliveryDate) : null)
            .input('completionDate', sql.DateTime, completionDate ? new Date(completionDate) : null)
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

// ── Packaging Holding — deliveries the SAP sync found completed outside
// Nexus (see runSapSync's reconciliation step below), waiting for someone
// to confirm their real packaging data via the normal pallet builder ──
router.get('/packaging-holding', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query(`SELECT dm.deliveryID, dm.customerID, d.destinationName, dm.dispatchDate,
                           dm.deliveryService, dm.picksheetComment, dm.deliveryPriority,
                           dm.incoterms, dm.movedToHoldingAtUtc
                    FROM Logistics.dbo.DeliveryMain dm
                    LEFT JOIN Logistics.dbo.Destinations d ON dm.customerID = d.destinationID
                    WHERE dm.completionStatus = 1
                      AND dm.pendingPackagingData = 1
                      AND ISNULL(dm.deliveryCancelled, 0) = 0
                    ORDER BY dm.movedToHoldingAtUtc DESC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Shared: reverse SAP staging + soft-cancel one held picksheet ─────────
// Factored out so the single-delivery delete and the delete-all route below
// share identical reversal/cancel logic instead of drifting apart.
async function cancelHeldPicksheet(pool, deliveryId) {
    const pkgsRes = await pool.request()
        .input('sapDelivery', sql.NVarChar, String(deliveryId))
        .query(`SELECT palletItemID, sapMaterial, sapBatch, sapDelivery,
                       sapSourceStorageType, sapSourceBin
                FROM   Logistics.dbo.PalletPackages
                WHERE  sapDelivery = @sapDelivery`);

    const failures = [];
    for (const pkg of pkgsRes.recordset) {
        const reversal = await reverseStagedPackage(pkg);
        if (reversal.attempted && !reversal.success) {
            failures.push({ palletItemID: pkg.palletItemID, sapMaterial: pkg.sapMaterial, sapBatch: pkg.sapBatch, error: reversal.error });
        }
    }
    if (failures.length) {
        return { success: false, failures };
    }

    await pool.request()
        .input('deliveryId', sql.BigInt, deliveryId)
        .query(`UPDATE Logistics.dbo.DeliveryMain
                SET deliveryCancelled = 1, pendingPackagingData = 0
                WHERE deliveryID = @deliveryId`);
    return { success: true };
}

// ── Delete a held picksheet instead of confirming its packaging ──────────
// Only allowed while the delivery is genuinely sitting in the packaging
// holding area (pendingPackagingData = 1) — not a general-purpose delivery
// delete. Soft-deletes via deliveryCancelled (same convention as shipment
// cancellation elsewhere in this app) rather than a hard DELETE, so the
// audit trail and any linked pallets stay intact instead of orphaning FK
// references. Reverses any SAP staging first, same defensive reasoning as
// palletmain.js's pallet delete — a partial pallet could exist if the
// delivery was picked in Nexus for a while before it got completed outside
// the app and swept into holding.
router.delete('/:deliveryId/packaging-holding', async (req, res) => {
    try {
        const pool = await getPool();

        const checkRes = await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`SELECT ISNULL(pendingPackagingData, 0) AS pendingPackagingData
                    FROM Logistics.dbo.DeliveryMain WHERE deliveryID = @deliveryId`);
        if (!checkRes.recordset.length) {
            return res.status(404).json({ success: false, error: 'Delivery not found' });
        }
        if (!checkRes.recordset[0].pendingPackagingData) {
            return res.status(409).json({ success: false, error: 'This delivery is not in the packaging holding area.' });
        }

        const result = await cancelHeldPicksheet(pool, req.params.deliveryId);
        if (!result.success) {
            return res.status(422).json({
                success: false,
                error: `Could not reverse SAP staging for ${result.failures.length} package(s) — delivery not deleted.`,
                failures: result.failures,
            });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Delete every held picksheet in one go ─────────────────────────────────
// Same reversal/soft-cancel as the single-delivery route above, applied to
// every delivery currently sitting in the holding area. Best-effort per
// delivery — one failing SAP reversal doesn't block the rest; failures are
// reported back so the caller can see which ones still need attention.
router.delete('/packaging-holding/all', async (req, res) => {
    try {
        const pool = await getPool();
        const idsRes = await pool.request()
            .query(`SELECT deliveryID FROM Logistics.dbo.DeliveryMain
                    WHERE completionStatus = 1 AND pendingPackagingData = 1
                      AND ISNULL(deliveryCancelled, 0) = 0`);

        const deleted = [];
        const failures = [];
        for (const row of idsRes.recordset) {
            const deliveryId = row.deliveryID;
            try {
                const result = await cancelHeldPicksheet(pool, deliveryId);
                if (result.success) {
                    deleted.push(deliveryId);
                } else {
                    failures.push({
                        deliveryId,
                        error: `Could not reverse SAP staging for ${result.failures.length} package(s)`,
                        failures: result.failures,
                    });
                }
            } catch (err) {
                failures.push({ deliveryId, error: err.message });
            }
        }

        res.json({ success: true, deleted, failures });
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
                      AND ISNULL(dm.pendingPackagingData, 0) = 0
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
                      AND ISNULL(dm.pendingPackagingData, 0) = 0
                      AND sl.deliveryID IS NULL
                    ORDER BY dm.deliveryID ASC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Return a completed-but-unshipped picksheet to Open Picksheets ────────
// Right-click action from the Create Shipment list — "uncompletes" a
// delivery so it can be re-picked/re-built before completing again. Any
// pallets already built stay intact (pallet builder doesn't care about
// completionStatus); only the completion rollup itself is reverted, since
// palletCount/grossWeight/netWeight/deliveryVolume are recalculated fresh
// from PalletMain by the /complete route anyway. Restricted to deliveries
// that are actually sitting in Create Shipment (completed, not cancelled,
// not already linked to a shipment, not in the packaging-holding area —
// that one has its own tile/routes since undoing it would fight the next
// SAP sync's reconciliation pass).
router.patch('/:deliveryId/uncomplete', async (req, res) => {
    try {
        const pool = await getPool();

        const checkRes = await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`SELECT dm.completionStatus, ISNULL(dm.deliveryCancelled, 0) AS deliveryCancelled,
                           ISNULL(dm.pendingPackagingData, 0) AS pendingPackagingData,
                           sl.deliveryID AS linkedShipmentDelivery
                    FROM Logistics.dbo.DeliveryMain dm
                    LEFT JOIN Logistics.dbo.ShipmentLink sl ON sl.deliveryID = dm.deliveryID
                    WHERE dm.deliveryID = @deliveryId`);
        if (!checkRes.recordset.length) {
            return res.status(404).json({ success: false, error: 'Delivery not found' });
        }
        const row = checkRes.recordset[0];
        if (!row.completionStatus || row.deliveryCancelled || row.pendingPackagingData) {
            return res.status(409).json({ success: false, error: 'This delivery is not an active completed picksheet.' });
        }
        if (row.linkedShipmentDelivery != null) {
            return res.status(409).json({ success: false, error: 'This delivery is already linked to a shipment — remove it from the shipment first.' });
        }

        await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`UPDATE Logistics.dbo.DeliveryMain
                    SET completionStatus = 0,
                        completionDate   = NULL,
                        palletCount      = NULL,
                        grossWeight      = NULL,
                        netWeight        = NULL,
                        deliveryVolume   = NULL
                    WHERE deliveryID = @deliveryId`);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Cancel a completed-but-unshipped picksheet ────────────────────────────
// Right-click action from the Create Shipment list, for a delivery whose
// order was cancelled after it was already picked/completed. Reuses the
// same reversal + soft-cancel helper as the packaging-holding delete
// (cancelHeldPicksheet, defined above) — reversing each package's SAP
// staging transfer order is exactly what "books the material back into
// stock", so this happens automatically rather than as a separate manual
// step.
router.patch('/:deliveryId/cancel-picksheet', async (req, res) => {
    try {
        const pool = await getPool();

        const checkRes = await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`SELECT dm.completionStatus, ISNULL(dm.deliveryCancelled, 0) AS deliveryCancelled,
                           sl.deliveryID AS linkedShipmentDelivery
                    FROM Logistics.dbo.DeliveryMain dm
                    LEFT JOIN Logistics.dbo.ShipmentLink sl ON sl.deliveryID = dm.deliveryID
                    WHERE dm.deliveryID = @deliveryId`);
        if (!checkRes.recordset.length) {
            return res.status(404).json({ success: false, error: 'Delivery not found' });
        }
        const row = checkRes.recordset[0];
        if (!row.completionStatus || row.deliveryCancelled) {
            return res.status(409).json({ success: false, error: 'This delivery is not an active completed picksheet.' });
        }
        if (row.linkedShipmentDelivery != null) {
            return res.status(409).json({ success: false, error: 'This delivery is already linked to a shipment — remove it from the shipment first.' });
        }

        const result = await cancelHeldPicksheet(pool, req.params.deliveryId);
        if (!result.success) {
            return res.status(422).json({
                success: false,
                error: `Could not reverse SAP staging for ${result.failures.length} package(s) — delivery not cancelled.`,
                failures: result.failures,
            });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// ── Picksheet materials + available stock (SAP-backed) ─────────────────────
// Orchestrates: LIPS (materials required for this delivery) → picksheet-stock
// (LQUA+ZPRODBATCH batches for those materials) → LIKP (customer on any
// delivery a batch is already tagged against). This is the Node-side
// equivalent of the old Excel staging-tab macro (Get_LIPS_sap_rt_2L /
// get_lqua / Z_BATCH_INFO_GET), reusing the existing LIPS/LIKP endpoints
// already proven out by the customs feature. One deliberate deviation from
// the VBA: a batch already allocated to another delivery is excluded by
// directly comparing that delivery's own customer (via LIKP~KUNNR) against
// this picksheet's customer, rather than the VBA's fragile string-position
// hack on a constructed label.
//
// Calls SapServer directly with the service token (same pattern as every
// route in sap.js) rather than looping back through this app's own
// /api/sap/* routes over HTTP — that self-referential fetch() depends on
// this server being able to reach itself via req.protocol/req.get('host'),
// which breaks under some reverse-proxy/TLS setups (observed as a bare
// "fetch failed" with no further detail after a server restart). Calling
// SapServer directly removes that extra, fragile hop entirely.
router.get('/:deliveryId/picksheet-materials', async (req, res) => {
    try {
        const deliveryId = req.params.deliveryId;
        const pool = await getPool();

        const dmRes = await pool.request()
            .input('deliveryId', sql.BigInt, deliveryId)
            .query('SELECT customerID FROM Logistics.dbo.DeliveryMain WHERE deliveryID = @deliveryId');
        const customerId = dmRes.recordset[0]?.customerID != null ? String(dmRes.recordset[0].customerID) : null;

        // Direct SapServer call — mirrors the /api/sap/* routes in sap.js
        // (same auth header, same httpsAgent, same success-flag handling)
        // instead of proxying back through this app's own HTTP layer.
        const sapPost = async (path, body) => {
            const response = await axios.post(
                `${sapConfig.url}${path}`,
                body,
                { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
            );
            return response.data;
        };
        const unwrap  = body => Array.isArray(body) ? body : (body?.success && Array.isArray(body.data) ? body.data : []);
        // SAP returns delivery numbers zero-padded to 10 digits (VBELN); the
        // portal stores/sends them unpadded — strip leading zeros so the two
        // can be compared directly.
        const norm = v => String(v || '').trim().replace(/^0+(?=\d)/, '');
        // SAP returns quantities (LFIMG, GESME, VERME) in German/European
        // number format — '.' as thousands separator, ',' as decimal
        // separator, e.g. "10.875,000" means 10875, not 10.875. Plain
        // Number() on a string with a comma returns NaN, which every
        // `|| 0` fallback downstream then silently displays as 0 — that's
        // why required quantities and batch quantities were showing 0 even
        // when SAP had real figures. Mirrors parseSapQty() in warehouse.js.
        const parseSapNum = v => {
            const str = String(v ?? '').trim();
            if (!str) return 0;
            const normalized = str.includes(',')
                ? str.replace(/\./g, '').replace(',', '.')
                : str.replace(/\./g, '');
            const num = Number(normalized);
            return Number.isFinite(num) ? num : 0;
        };

        // 1. What material(s) and quantity does this delivery need? Uses a
        //    picksheet-specific LIPS query (LFIMG, not the customs feature's
        //    KCMENG) since this delivery hasn't been picked/confirmed yet —
        //    see PicksheetHelpers.LipsColumns in SapServer for why.
        const lipsBody = await sapPost('/api/warehouse/picksheet-materials', { deliveries: [String(deliveryId)] });
        if (lipsBody?.success === false) throw new Error(lipsBody.error || 'SAP LIPS query failed');
        const lipsRows = unwrap(lipsBody);

        const materials = [...new Set(lipsRows.map(r => String(r.materialNumber || '').trim()).filter(Boolean))];
        if (!materials.length) {
            return res.json({ success: true, data: { customerId, materials: [] } });
        }

        // 2. Where is that material physically sitting, and is any of it
        //    already tagged against another delivery (ZPRODBATCH~VBELN)?
        const stockBody = await sapPost('/api/warehouse/picksheet-stock', { materials });
        if (stockBody?.success === false) throw new Error(stockBody.error || 'SAP stock query failed');
        const batchRows = unwrap(stockBody);

        // 2b. Profit centre per material (MARC~PRCTR), via SapServer's
        //     existing GET /api/production/check-profit-centre — the same
        //     lookup productionnexus.js's assertProfitCentre already uses to
        //     gate production postings, called once per required material.
        //     Materials on profit centre 2007 are packed differently: each
        //     batch sits inside a C2 box, and the pallet itself is one MB
        //     (medium pallet box) holding all of those C2s — see
        //     CONTAINER_PROFIT_CENTRE below and its use in addPackage()'s
        //     equivalent packing logic on the frontend.
        const CONTAINER_PROFIT_CENTRE = '2007';
        const sapGet = async (path, body) => {
            const response = await axios.request({
                method: 'get',
                url: `${sapConfig.url}${path}`,
                data: body,
                timeout: 30000,
                httpsAgent: sapAgent,
                headers: { Authorization: `Bearer ${makeSapToken()}`, 'Content-Type': 'application/json' },
            });
            return response.data;
        };
        const profitCentreByMaterial = {};
        await Promise.all(materials.map(async mat => {
            try {
                const raw = await sapGet('/api/production/check-profit-centre', { Material: mat });
                if (raw?.success === false) return;
                profitCentreByMaterial[mat] = String(raw?.data ?? '').trim().replace(/^0+(?=\d)/, '');
            } catch {
                // Profit centre couldn't be confirmed for this material — leave
                // it undetermined rather than failing the whole picksheet load;
                // it just won't get the container-packing treatment below.
            }
        }));

        // 3. For any batch allocated elsewhere, whose customer is that delivery?
        //    A batch sitting in storage type 916 (the picksheet-staging area —
        //    see PicksheetHelpers.StagingStorageType in SapServer) is allocated
        //    to whichever delivery its bin is named after: the bin IS that
        //    delivery's own number, zero-padded to 10 digits (see the
        //    /:deliveryId/stage-batch route below). That's a live signal the
        //    transfer order itself produces, unlike ZPRODBATCH~VBELN below
        //    (an older tagging field the transfer order never touches) — so
        //    prefer the bin-derived delivery when the batch is actually
        //    sitting in a 916 bin, otherwise fall back to ZPRODBATCH~VBELN.
        const STAGING_STORAGE_TYPE = '916';
        const deriveAllocDelivery = b => {
            const bin = String(b.storageType || '').trim() === STAGING_STORAGE_TYPE
                ? String(b.bin || '').trim() : '';
            return bin && /^\d+$/.test(bin) ? norm(bin) : norm(b.allocatedDelivery);
        };

        const conflictDeliveries = [...new Set(
            batchRows.map(deriveAllocDelivery).filter(v => v && v !== norm(deliveryId))
        )];

        const customerByDelivery = {};
        if (conflictDeliveries.length) {
            const likpBody = await sapPost('/api/customs/likp', { deliveries: conflictDeliveries });
            if (likpBody?.success !== false) {
                unwrap(likpBody).forEach(r => { customerByDelivery[norm(r.deliveryNumber)] = norm(r.consigneeCode); });
            }
        }

        // 4. Assemble: one entry per required material, with its found
        //    batches flagged allowed/restricted.
        const byMaterial = {};
        lipsRows.forEach(r => {
            const mat = String(r.materialNumber || '').trim();
            if (!mat) return;
            if (!byMaterial[mat]) byMaterial[mat] = { material: mat, requiredQty: 0, deliveryItem: r.itemNumber || null, batches: [] };
            byMaterial[mat].requiredQty += parseSapNum(r.quantity);
        });

        // SAP's LIPS open quantity isn't reduced by picking/packing — it only
        // drops at goods issue, which happens well after the pallet(s) are
        // built. So on its own, requiredQty here is "not yet at all
        // dispatched", not "not yet picked" — every material would show its
        // full original requirement again on every new pallet, ignoring
        // whatever was already boxed onto this delivery's OTHER pallets.
        // Subtract what's already in dbo.PalletPackages for this delivery
        // (every pallet, not just whichever one is currently open) so the
        // panel reflects what's actually still left to pick.
        const pickedRes = await pool.request()
            .input('sapDelivery', sql.NVarChar, String(deliveryId))
            .query(`SELECT sapMaterial, SUM(sapQuantity) AS pickedQty
                    FROM   Logistics.dbo.PalletPackages
                    WHERE  sapDelivery = @sapDelivery AND sapMaterial IS NOT NULL
                    GROUP  BY sapMaterial`);
        pickedRes.recordset.forEach(row => {
            const mat = String(row.sapMaterial || '').trim();
            if (!mat || !byMaterial[mat]) return;
            byMaterial[mat].requiredQty = Math.max(0, byMaterial[mat].requiredQty - Number(row.pickedQty || 0));
        });

        // Packaging instruction (ZPRODBATCH~PALL_MATNR) encodes the customer
        // it was built for as its middle underscore-delimited segment, e.g.
        // "IB_363660_C2" -> customer 363660. A batch built for a DIFFERENT
        // customer than this delivery's is still shown (so the operator can
        // see the stock exists) but grouped and locked out like the existing
        // allocation-conflict "restricted" batches, just under its own
        // "wrongCustomer" group/reason — it's a different kind of block
        // (wrong packaging for this customer, not "someone else has dibs").
        // A blank/unparseable instruction (no customer segment found) isn't
        // a mismatch — there's nothing to check against — so it stays
        // addable, just grouped separately ("unassigned") for visibility
        // rather than mixed in with confirmed matches.
        const PACKAGING_INSTRUCTION_RE = /^[^_]*_(\d+)_/;
        const packagingInstructionCustomer = b => {
            const match = String(b.packagingMaterial || '').match(PACKAGING_INSTRUCTION_RE);
            return match ? norm(match[1]) : null;
        };

        batchRows.forEach(b => {
            const mat = String(b.material || '').trim();
            if (!mat) return;
            if (!byMaterial[mat]) byMaterial[mat] = { material: mat, requiredQty: 0, deliveryItem: null, batches: [] };

            const allocDelivery        = deriveAllocDelivery(b);
            const stagedViaBin         = String(b.storageType || '').trim() === STAGING_STORAGE_TYPE
                                          && !!allocDelivery && norm(b.bin) === allocDelivery;
            const isOwnOrUnassigned    = !allocDelivery || allocDelivery === norm(deliveryId);
            const allocCustomer        = allocDelivery ? customerByDelivery[allocDelivery] : null;
            const sameCustomer         = !allocCustomer || allocCustomer === norm(customerId);
            const allocationAllowed    = isOwnOrUnassigned || sameCustomer;

            const packagingCustomer        = packagingInstructionCustomer(b);
            const packagingMismatch        = packagingCustomer !== null && packagingCustomer !== norm(customerId);
            const packagingCustomerUnknown = packagingCustomer === null;
            const allowed                  = allocationAllowed && !packagingMismatch;

            // Precedence: wrong-customer packaging blocks first (strongest
            // reason), then existing allocation conflicts, then "we simply
            // don't know" — anything else is a normal, available batch.
            let group = 'available';
            let reason = null;
            if (packagingMismatch) {
                group = 'wrongCustomer';
                reason = `Packaged for customer ${packagingCustomer}, not ${norm(customerId) || 'this delivery'}`;
            } else if (!allocationAllowed) {
                group = 'restricted';
                reason = stagedViaBin
                    ? `Already staged to delivery ${allocDelivery}'s bin${allocCustomer ? ` (customer ${allocCustomer})` : ''}`
                    : `Already allocated to delivery ${allocDelivery}${allocCustomer ? ` (customer ${allocCustomer})` : ''}`;
            } else if (packagingCustomerUnknown) {
                group = 'unassigned';
            }

            byMaterial[mat].batches.push({
                batch:              (b.batch || '').trim(),
                storageType:        b.storageType,
                bin:                b.bin,
                totalQty:           parseSapNum(b.totalQty),
                availableQty:       parseSapNum(b.availableQty),
                stockCategory:      b.stockCategory,
                packagingMaterial:  b.packagingMaterial,
                allocatedDelivery:  isOwnOrUnassigned ? null : allocDelivery,
                allowed,
                group,
                reason,
            });
        });

        Object.values(byMaterial).forEach(m => {
            m.profitCentre = profitCentreByMaterial[m.material] || null;
            m.usesContainerPacking = m.profitCentre === CONTAINER_PROFIT_CENTRE;
        });

        res.json({ success: true, data: { customerId, materials: Object.values(byMaterial) } });
    } catch (err) {
        res.status(err.statusCode || 500).json({ success: false, error: err.message });
    }
});

// ── Stage a batch to this picksheet's bin (SAP transfer order) ─────────────
// Called whenever the operator adds a batch to a pallet on this picksheet.
// Moves the batch's full on-hand quantity into a bin named after the
// picksheet's own delivery number (zero-padded to 10 digits, storage type
// 916) via SapServer's /api/warehouse/picksheet-stage-batch, which itself
// checks whether that bin already exists in SAP and creates it first if not
// (ported from the wm_lt01.xltm macro's create_LS01 — "sometimes the
// picksheet BIN will not have been created yet"). That bin becomes the
// visible indicator to anyone else in the warehouse that this stock is
// allocated to this delivery.
//
// Deliberately fails closed: if SAP rejects the bin creation or the transfer
// order, this returns success:false and the caller (warehouse.js) must NOT
// add the package locally — an app-side "added" pallet package that was
// never actually moved in SAP would be exactly the kind of mismatch this
// bin-allocation feature exists to prevent.
router.post('/:deliveryId/stage-batch', async (req, res) => {
    try {
        const deliveryId = req.params.deliveryId;
        const { material, batch } = req.body || {};
        if (!material || !batch) {
            return res.status(400).json({ success: false, error: 'material and batch are required' });
        }

        const response = await axios.post(
            `${sapConfig.url}/api/warehouse/picksheet-stage-batch`,
            { material: String(material), batch: String(batch), deliveryNumber: String(deliveryId) },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        ).catch(err => {
            // SapServer returns 422 (with a normal ApiResponse body) for
            // business-level staging failures — surface that body rather
            // than treating it as a transport error.
            if (err.response?.data) return { data: err.response.data };
            throw err;
        });

        const body = response.data;
        if (!body?.success) {
            return res.status(422).json({ success: false, error: body?.error?.message || body?.data?.error || 'SAP staging failed' });
        }

        res.json({ success: true, data: body.data });
    } catch (err) {
        res.status(err.statusCode || 500).json({ success: false, error: err.message });
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

// ── ZDELFLAG/ZDELPACK maintenance (transaction ZPIL9) ───────────────────────
//
// Confirms all materials/packaging assigned to a delivery in SAP's own
// ZDELFLAG/ZDELPACK tables via the custom BAPI Z_MAINT_ZDELFLAG_ZDELPACK
// (ported from the uploaded zpil9_code.bas macro's maint_delflag_pack — see
// SapServer's ZdelflagHelpers.cs for the full field-by-field mapping
// rationale). Runs after the ZDEL weight update when a delivery is marked
// complete, and again unchanged from the reprocess endpoint below.
//
// Only PalletPackages rows with a real sapMaterial are actual SAP batches —
// the outer box/container shells the MB/C2 packing flow creates (packagingID
// set, sapMaterial null) aren't batches and don't get their own row. Every
// real batch must have sapBatch recorded (there's no path in this app to add
// one without a batch) — a missing one here is treated as a hard stop, same
// as the user's own "add the hard-stop in case there is a bug" instruction.
//
// One row per package (VHART "SMBX") plus one combined header row per pallet
// (VHART "PALL", PACKID = palletID*1000, package rows +1/+2/... from there).
// PALLET is "G" unless the pallet has no palletType set, in which case "S".
// Weights (NTGEW/BRGEW) are only populated on the header row, from that
// pallet's own gross/net weight — package rows default to 0. T_DELPACK gets
// one row per (package, ZBOM_INFO~IDNRK) pair for that package's packaging
// instruction, MENGE always 1, TAREWEI from dbo.PackagingData.
//
// Never throws — always resolves to { status, messages } and writes exactly
// one row to dbo.DeliveryZdelflagRun, so a SAP-side failure here can be
// surfaced as a warning (with a reprocess option) rather than blocking
// whatever called it.
async function runZdelflagMaintenance(pool, deliveryId, userId) {
    const sapGet = async (path) => {
        const response = await axios.get(`${sapConfig.url}${path}`, {
            timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` },
        });
        return response.data;
    };
    const sapPost = async (path, body) => {
        const response = await axios.post(`${sapConfig.url}${path}`, body, {
            timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` },
        });
        return response.data;
    };

    const recordRun = async (status, messages) => {
        await pool.request()
            .input('deliveryId',   sql.NVarChar(10),  String(deliveryId))
            .input('status',       sql.NVarChar(10),  status)
            .input('messages',     sql.NVarChar(sql.MAX), JSON.stringify(messages || []))
            .input('ranByUserID',  sql.Int,           userId ?? null)
            .query(`INSERT INTO Logistics.dbo.DeliveryZdelflagRun (deliveryID, status, messages, ranByUserID)
                    VALUES (@deliveryId, @status, @messages, @ranByUserID)`);
        return { status, messages: messages || [] };
    };

    try {
        // 1. Delivery + pallet + package data already sitting in our own DB.
        const dmRes = await pool.request()
            .input('deliveryId', sql.BigInt, deliveryId)
            .query('SELECT customerID FROM Logistics.dbo.DeliveryMain WHERE deliveryID = @deliveryId');
        const customerId = dmRes.recordset[0]?.customerID != null ? String(dmRes.recordset[0].customerID) : '';

        const palletsRes = await pool.request()
            .input('deliveryId', sql.BigInt, deliveryId)
            .query(`SELECT pm.palletID, pm.palletType, pm.grossWeight, pm.packagingWeight
                    FROM Logistics.dbo.PalletMain pm
                    INNER JOIN Logistics.dbo.DeliveryLink dl ON pm.palletID = dl.palletID
                    WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0
                    ORDER BY pm.palletID ASC`);
        const pallets = palletsRes.recordset;
        if (!pallets.length) {
            return await recordRun('Failed', [{ type: 'E', message: 'No pallets found for this delivery.' }]);
        }

        const packagesRes = await pool.request()
            .input('sapDelivery', sql.NVarChar, String(deliveryId))
            .query(`SELECT palletID, sapMaterial, sapQuantity, sapBatch, sapDeliveryItem, sapPackagingInstruction
                    FROM Logistics.dbo.PalletPackages
                    WHERE sapDelivery = @sapDelivery
                    ORDER BY palletID ASC, palletItemID ASC`);

        const missingBatch = packagesRes.recordset.find(p => p.sapMaterial && !p.sapBatch);
        if (missingBatch) {
            const msg = `Package for material ${missingBatch.sapMaterial} on pallet ${missingBatch.palletID} has no batch recorded — cannot maintain ZDELFLAG/ZDELPACK.`;
            return await recordRun('Failed', [{ type: 'E', message: msg }]);
        }

        const packagesByPallet = {};
        packagesRes.recordset
            .filter(p => p.sapMaterial)
            .forEach(p => { (packagesByPallet[p.palletID] ||= []).push(p); });

        // 2. SAP lookups Node needs to fill in the rows.
        const abladRes = await sapGet(`/api/warehouse/zdelflag/likp-ablad/${encodeURIComponent(deliveryId)}`);
        const empst = abladRes?.success !== false ? (abladRes?.data || '') : '';

        const lipsRes = await sapGet(`/api/warehouse/zdelflag/lips-items/${encodeURIComponent(deliveryId)}`);
        const lipsByPosnr = {};
        (lipsRes?.success !== false ? (lipsRes?.data || []) : []).forEach(r => {
            lipsByPosnr[String(r.itemNumber || '').trim()] = r;
        });

        const eiktoRes = customerId
            ? await sapGet(`/api/warehouse/zdelflag/eikto/${encodeURIComponent(customerId)}`)
            : null;
        const eikto = eiktoRes?.success !== false ? (eiktoRes?.data || '') : '';

        const instructions = [...new Set(
            packagesRes.recordset.map(p => String(p.sapPackagingInstruction || '').trim()).filter(Boolean)
        )];
        const zbomRes = instructions.length
            ? await sapPost('/api/warehouse/zdelflag/zbom-info', { packagingInstructions: instructions })
            : { data: [] };
        const idnrksByInstruction = {};
        (zbomRes?.success !== false ? (zbomRes?.data || []) : []).forEach(r => {
            (idnrksByInstruction[r.packagingInstruction] ||= []).push(r.componentMaterial);
        });

        // 3. Packaging component weights (T_DELPACK~TAREWEI), keyed by
        // packMaterial (the SAP material number, same as ZBOM_INFO~IDNRK).
        const allIdnrks = [...new Set(Object.values(idnrksByInstruction).flat())];
        const weightByIdnrk = {};
        if (allIdnrks.length) {
            const pdRes = await pool.request()
                .query(`SELECT packMaterial, packWeight FROM Logistics.dbo.PackagingData WHERE packMaterial IS NOT NULL`);
            pdRes.recordset.forEach(r => { weightByIdnrk[String(r.packMaterial).trim()] = Number(r.packWeight || 0); });
        }

        // 4. Build T_DELFLAG / T_DELPACK rows.
        const budat = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // yyyyMMdd
        const delflagRows = [];
        const delpackRows = [];

        pallets.forEach(pallet => {
            const packages     = packagesByPallet[pallet.palletID] || [];
            const hasType      = pallet.palletType != null && String(pallet.palletType).trim() !== '';
            const palletFlag   = hasType ? 'G' : 'S';
            const headerPackid = pallet.palletID * 1000;
            const netWeight    = Number(pallet.grossWeight || 0) - Number(pallet.packagingWeight || 0);

            delflagRows.push({
                vbeln: String(deliveryId), posnr: '', charg: '',
                kunnr: customerId, empst, werks: '3012',
                ntgew: netWeight, brgew: Number(pallet.grossWeight || 0),
                kdmat: '', lfimg: 0, eikto, arktx: '', matnr: '',
                budat, packid: String(headerPackid), boxes: String(packages.length),
                pallet: palletFlag, vhart: 'PALL',
                smbxMatnr: (packages.find(p => p.sapPackagingInstruction)?.sapPackagingInstruction) || '',
                pallMatnr: 'PALLET', mtart: '', smbxhu: '', done: 'X',
                printPalletLabel: true, printBoxLabel: false,
            });

            packages.forEach((pkg, idx) => {
                const packid  = String(headerPackid + idx + 1);
                const posnr   = String(pkg.sapDeliveryItem || '').trim();
                const lipsRow = lipsByPosnr[posnr];
                const instr   = String(pkg.sapPackagingInstruction || '').trim();

                delflagRows.push({
                    vbeln: String(deliveryId), posnr, charg: pkg.sapBatch,
                    kunnr: customerId, empst, werks: '3012',
                    ntgew: 0, brgew: 0,
                    kdmat: lipsRow?.customerMaterial || '', lfimg: Number(pkg.sapQuantity || 0),
                    eikto, arktx: lipsRow?.description || '', matnr: pkg.sapMaterial,
                    budat, packid, boxes: '1', pallet: palletFlag, vhart: 'SMBX',
                    smbxMatnr: instr, pallMatnr: 'PALLET',
                    mtart: '', smbxhu: packid, done: 'X',
                    printPalletLabel: false, printBoxLabel: false,
                });

                (idnrksByInstruction[instr] || []).forEach(idnrk => {
                    delpackRows.push({
                        packid, pallMatnr: idnrk, menge: 1, meins: 'EA',
                        tarewei: weightByIdnrk[idnrk] || 0, gewei: 'KG',
                    });
                });
            });
        });

        // 5. Call the BAPI.
        const maintainRes = await sapPost('/api/warehouse/zdelflag/maintain', { delflagRows, delpackRows });

        if (maintainRes?.success === false) {
            const msg = maintainRes?.error?.message || 'SAP rejected the ZDELFLAG/ZDELPACK maintenance call.';
            return await recordRun('Failed', [{ type: 'E', message: msg }]);
        }

        const messages   = maintainRes?.data?.messages || [];
        const hasBlocker = messages.some(m => m.type === 'E' || m.type === 'A');
        if (hasBlocker)     return await recordRun('Failed', messages);
        if (messages.length) return await recordRun('Warning', messages);
        return await recordRun('Success', []);
    } catch (err) {
        return await recordRun('Failed', [{ type: 'E', message: err.message }]);
    }
}

// ── Mark delivery as complete — rolls up pallet weights/volume/count ──
//
// After the rollup, pushes the same actual gross/net weight and pallet count
// out to SAP via transaction ZDEL (LIKP-BTGEW/NTGEW/GEWEI/ANZPK), so the
// delivery in SAP reflects what was really picked and packed rather than
// whatever placeholder figures it had before. Net weight is gross minus
// packaging, same subtraction the rollup itself just did. Best-effort: the
// delivery is already correctly marked complete in the portal by the time
// this runs, so a SAP-side failure here is surfaced as a warning rather than
// failing the whole completion — the operator doesn't lose their finished
// pallets over a SAP hiccup, but does get told to fix LIKP by hand.
//
// After ZDEL, also runs the ZDELFLAG/ZDELPACK maintenance step (see
// runZdelflagMaintenance above) — same best-effort treatment, surfaced as
// its own zdelflagWarning rather than blocking completion.
//
// If this delivery was sitting in the packaging holding area
// (pendingPackagingData = 1 — the SAP sync found it already completed in
// SAP outside Nexus, see runSapSync's reconciliation step), SAP already
// considers it closed. Pushing ZDEL/ZDELFLAG again for a delivery SAP has
// already finished isn't just redundant, it's likely to be rejected — so
// both SAP calls are skipped entirely for this path. Completing here just
// records the real packaging data locally (from whatever pallets were just
// built) and clears pendingPackagingData, releasing it into Create Shipment.
router.patch('/:deliveryId/complete', async (req, res) => {
    try {
        const pool = await getPool();

        const pendingRes = await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`SELECT ISNULL(pendingPackagingData, 0) AS pendingPackagingData
                    FROM Logistics.dbo.DeliveryMain WHERE deliveryID = @deliveryId`);
        const wasHeldForPackaging = !!pendingRes.recordset[0]?.pendingPackagingData;

        await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`UPDATE Logistics.dbo.DeliveryMain
                    SET completionStatus = 1,
                        completionDate   = GETDATE(),
                        pendingPackagingData = 0,
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

        const rolledUp = await pool.request()
            .input('deliveryId', sql.BigInt, req.params.deliveryId)
            .query(`SELECT palletCount, grossWeight, netWeight
                    FROM Logistics.dbo.DeliveryMain
                    WHERE deliveryID = @deliveryId`);
        const totals = rolledUp.recordset[0] || {};

        let sapWarning = null;
        let zdelflagWarning = null;
        let note = null;

        if (wasHeldForPackaging) {
            note = 'This delivery was already completed in SAP outside Nexus — packaging data has been recorded locally and it\'s now available for shipment creation. ZDEL and ZDELFLAG/ZDELPACK were not re-sent to SAP.';
        } else {
            try {
                const response = await axios.post(
                    `${sapConfig.url}/api/warehouse/set-delivery-weight`,
                    {
                        deliveryNumber: String(req.params.deliveryId),
                        grossWeight: Number(totals.grossWeight || 0),
                        netWeight:   Number(totals.netWeight || 0),
                        palletCount: Number(totals.palletCount || 0),
                    },
                    { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
                );
                if (!response.data?.success) {
                    sapWarning = response.data?.error?.message || 'SAP rejected the ZDEL weight update.';
                }
            } catch (sapErr) {
                sapWarning = `Could not update SAP (ZDEL) with the actual weights/pallet count: ${sapErr.message}. Update LIKP manually.`;
            }

            const zdelflagResult = await runZdelflagMaintenance(pool, req.params.deliveryId, null);
            if (zdelflagResult.status !== 'Success') {
                zdelflagWarning = zdelflagResult.messages.map(m => m.message).filter(Boolean).join('; ')
                    || `ZDELFLAG/ZDELPACK maintenance did not complete successfully (${zdelflagResult.status}).`;
            }
        }

        res.json({ success: true, data: { ...totals, sapWarning, zdelflagWarning, note, wasHeldForPackaging } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── ZDELFLAG/ZDELPACK warning log — deliveries whose latest maintenance run
// was Failed or Warning, for the warehouse warning-log UI ──
router.get('/zdelflag/warnings', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query(`SELECT r.deliveryID, r.status, r.messages, r.ranAtUtc
                    FROM Logistics.dbo.DeliveryZdelflagRun r
                    INNER JOIN (
                        SELECT deliveryID, MAX(ranAtUtc) AS latestRun
                        FROM Logistics.dbo.DeliveryZdelflagRun
                        GROUP BY deliveryID
                    ) latest ON latest.deliveryID = r.deliveryID AND latest.latestRun = r.ranAtUtc
                    WHERE r.status IN ('Failed', 'Warning')
                    ORDER BY r.ranAtUtc DESC`);
        res.json({
            success: true,
            data: result.recordset.map(r => ({
                deliveryID: r.deliveryID,
                status: r.status,
                messages: JSON.parse(r.messages || '[]'),
                ranAtUtc: r.ranAtUtc,
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Latest ZDELFLAG/ZDELPACK run status for one delivery ──
router.get('/:deliveryId/zdelflag/status', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('deliveryId', sql.NVarChar(10), String(req.params.deliveryId))
            .query(`SELECT TOP 1 status, messages, ranAtUtc
                    FROM Logistics.dbo.DeliveryZdelflagRun
                    WHERE deliveryID = @deliveryId
                    ORDER BY ranAtUtc DESC`);
        const row = result.recordset[0];
        res.json({
            success: true,
            data: row
                ? { status: row.status, messages: JSON.parse(row.messages || '[]'), ranAtUtc: row.ranAtUtc }
                : { status: null, messages: [], ranAtUtc: null },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Reprocess ZDELFLAG/ZDELPACK maintenance for one delivery ──
// Only allowed while the latest run is missing, Failed, or Warning — once a
// VBELN has a Success run recorded, it can't be reprocessed without a future
// reversal feature (not implemented yet), per the user's explicit "if it is
// successful, it cannot be used again for the same VBELN, unless it is
// reversed" instruction.
router.post('/:deliveryId/zdelflag/reprocess', async (req, res) => {
    try {
        const pool = await getPool();
        const latestRes = await pool.request()
            .input('deliveryId', sql.NVarChar(10), String(req.params.deliveryId))
            .query(`SELECT TOP 1 status
                    FROM Logistics.dbo.DeliveryZdelflagRun
                    WHERE deliveryID = @deliveryId
                    ORDER BY ranAtUtc DESC`);
        const latestStatus = latestRes.recordset[0]?.status;
        if (latestStatus === 'Success') {
            return res.status(409).json({
                success: false,
                error: 'This delivery already has a successful ZDELFLAG/ZDELPACK run and cannot be reprocessed.',
            });
        }

        const result = await runZdelflagMaintenance(pool, req.params.deliveryId, null);
        res.json({ success: true, data: result });
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
                .input('dispatchDate',    sql.DateTime, r.dispatchDate ? new Date(r.dispatchDate) : null)
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
//
// Extracted into a standalone function (rather than living only inside the
// route handler) so it can be called both from the manual "/sap-sync" button
// (LOG_SUPER only) and from server.js's hourly xx:55 cron job — cron has no
// req/res to hand a permission-gated route handler, so the actual sync logic
// can't depend on either. Returns a plain result object instead of writing
// to `res` directly; the route handler below maps that onto the HTTP
// response, and the cron caller in server.js just logs it.
async function runSapSync() {
    const syncUrl = `${sapConfig.url}/api/logistics/picksheets/open`;

    try {
        const sapRes = await axios.get(syncUrl, {
            headers:  { Authorization: `Bearer ${makeSapToken()}` },
            timeout:  30000,
        });

        const deliveries = sapRes.data?.data ?? sapRes.data;
        if (!Array.isArray(deliveries)) {
            return { success: false, status: 502, error: 'Unexpected response format from SAP server' };
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

        // ── Auto-create Destinations rows for customers SAP knows but we don't ──
        // Rather than just flagging a brand-new customer as "missing" and requiring
        // someone to add it by hand before the picksheet can sync, pull whatever
        // KNA1 (customer master) has — name, address, transportation zone — and
        // create the Destinations row automatically. Fields KNA1 doesn't carry
        // (incoterms, comment, forwarder, delivery service, email) are left null
        // for someone to fill in later. A KNA1 failure (SAP unreachable, customer
        // genuinely doesn't exist in SAP either) just falls back to the old
        // behaviour of reporting it under `missing`.
        const autoCreated = [];
        let kna1Error = null; // surfaced in the response so a silent failure is diagnosable
        const missingCustomerIds = [...new Set(
            deliveries
                .map(d => parseInt(d.customerNumber, 10))
                .filter(id => Number.isFinite(id) && !destMap[String(id)])
        )];

        if (missingCustomerIds.length) {
            try {
                const kna1Res = await axios.post(
                    `${sapConfig.url}/api/customs/kna1`,
                    { customers: missingCustomerIds.map(String) },
                    { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
                );
                const kna1Body = kna1Res.data;
                if (kna1Body?.success === false) kna1Error = kna1Body.error || 'SapServer returned success=false';
                const kna1Rows = kna1Body?.success === false ? [] : (kna1Body?.data ?? []);

                for (const row of kna1Rows) {
                    const custId = parseInt(row.customerCode, 10);
                    if (!Number.isFinite(custId) || destMap[String(custId)]) continue;

                    const name       = String(row.name ?? '').trim() || `Customer ${custId}`;
                    const street     = String(row.street ?? '').trim() || null;
                    const city       = String(row.city ?? '').trim() || null;
                    const postCode   = String(row.postCode ?? '').trim() || null;
                    const country    = String(row.destinationCountry ?? '').trim() || null;
                    const zone       = String(row.transportZone ?? '').trim() || null;
                    // From KNVV (customer master sales data), joined in by SapServer's
                    // /api/customs/kna1 response alongside the KNA1 fields above.
                    const incoterms  = String(row.incoterms ?? '').trim() || null;

                    try {
                        await pool.request()
                            .input('destinationID',          sql.BigInt,   custId)
                            .input('destinationName',        sql.NVarChar, name)
                            .input('destinationStreet',      sql.NVarChar, street)
                            .input('destinationCity',        sql.NVarChar, city)
                            .input('destinationPostCode',    sql.NVarChar, postCode)
                            .input('destinationCountry',     sql.NVarChar, country)
                            .input('defaultIncoterms',       sql.NVarChar, incoterms)
                            .input('destinationComment',     sql.NVarChar, null)
                            .input('destinationZone',        sql.NVarChar, zone)
                            .input('defaultDeliveryService', sql.NVarChar, null)
                            .input('defaultForwarder',       sql.NVarChar, null)
                            .query(`INSERT INTO Logistics.dbo.Destinations
                                        (destinationID, destinationName, destinationStreet, destinationCity,
                                         destinationPostCode, destinationCountry, defaultIncoterms,
                                         destinationComment, destinationZone,
                                         defaultDeliveryService, defaultForwarder)
                                    SELECT @destinationID, @destinationName, @destinationStreet, @destinationCity,
                                           @destinationPostCode, @destinationCountry, @defaultIncoterms,
                                           @destinationComment, @destinationZone,
                                           @defaultDeliveryService, @defaultForwarder
                                    WHERE NOT EXISTS (
                                        SELECT 1 FROM Logistics.dbo.Destinations WHERE destinationID = @destinationID
                                    )`);

                        // Feed straight back into destMap so this sync run picks the
                        // delivery up immediately instead of needing a second sync.
                        destMap[String(custId)] = {
                            destinationID:          custId,
                            defaultDeliveryService: null,
                            defaultIncoterms:       incoterms,
                            destinationComment:     null,
                            destinationCountry:     country,
                        };
                        autoCreated.push({ customerNumber: String(custId), destinationName: name, needsReview: !street || !city || !postCode || !country });
                    } catch (err) {
                        // Leave it unset — falls through to `missing` below like before
                        console.error(`[sap-sync] Failed to auto-create Destinations row for customer ${custId}:`, err.message);
                        kna1Error = kna1Error || `Insert failed for customer ${custId}: ${err.message}`;
                    }
                }
            } catch (err) {
                // KNA1 lookup itself failed (SAP unreachable, bad field list, etc.) — every
                // one of these customers just falls through to `missing` in the loop below,
                // same as pre-auto-create behaviour, but now the reason is visible instead
                // of being silently swallowed.
                kna1Error = err.response?.data?.error ?? err.message;
                console.error('[sap-sync] KNA1 auto-create lookup failed:', kna1Error);
            }
        }

        let inserted = 0, skipped = 0;
        const errors  = [];
        const missing = []; // customerNumbers still not found in Destinations after the KNA1 auto-create attempt above

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
                    .input('dispatchDate',     sql.DateTime,    dispatchDate)
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

        // ── Reconcile: pick up deliveries completed outside Nexus ──────────
        // Anything Nexus still thinks is open (completionStatus = 0, not
        // cancelled) but that this SAP pull did NOT return is assumed to
        // have been picked/shipped directly in SAP, bypassing the pallet
        // builder entirely — Nexus never captured real pallet/packaging
        // data for it. Move it out of Open Picksheets into the packaging
        // holding area (completionStatus = 1 so it drops off Open
        // Picksheets, pendingPackagingData = 1 so it's also excluded from
        // Create Shipment) until someone confirms its packaging via the
        // normal pallet builder — see the /:deliveryId/complete route's
        // pendingPackagingData handling and the "Packaging Holding" tile.
        //
        // Note this trusts SAP's open-picksheets pull to be a complete,
        // accurate list of everything genuinely still open — a transient
        // SAP-side hiccup that returns an incomplete list would incorrectly
        // sweep real open picksheets into holding. There's no independent
        // signal available here to tell the two cases apart, so this is a
        // direct implementation of the requested rule, not a hedged one.
        const sapOpenDeliveryIds = new Set(
            deliveries
                .map(d => parseInt(d.deliveryNumber, 10))
                .filter(Number.isFinite)
        );
        const openInNexusRes = await pool.request()
            .query(`SELECT deliveryID FROM Logistics.dbo.DeliveryMain
                    WHERE completionStatus = 0 AND ISNULL(deliveryCancelled, 0) = 0`);
        const movedToHolding = [];
        for (const row of openInNexusRes.recordset) {
            const id = Number(row.deliveryID);
            if (sapOpenDeliveryIds.has(id)) continue;
            await pool.request()
                .input('deliveryId', sql.BigInt, id)
                .query(`UPDATE Logistics.dbo.DeliveryMain
                        SET completionStatus = 1, pendingPackagingData = 1, movedToHoldingAtUtc = GETUTCDATE()
                        WHERE deliveryID = @deliveryId`);
            movedToHolding.push(id);
        }

        return { success: true, status: 200, total: deliveries.length, inserted, skipped, errors, missing, autoCreated, kna1Error, movedToHolding };

    } catch (err) {
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
            return { success: false, status: 503, error: `SAP server unreachable: ${syncUrl}` };
        }
        if (err.response) {
            return { success: false, status: 502, error: `SAP server error ${err.response.status}: ${err.response.data?.error ?? err.message}` };
        }
        return { success: false, status: 500, error: err.message };
    }
}

router.post('/sap-sync', requirePermission('LOG_SUPER'), async (req, res) => {
    const { status, ...body } = await runSapSync();
    res.status(status).json(body);
});

// ── Landing page sparkline — on-time shipment rate over last 30 days ──────────
// "On time" = shipment actualCollection date <= delivery dispatchDate
router.get('/landing-sparkline', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            WITH DailyShipments AS (
                SELECT
                    DATEADD(day, DATEDIFF(day, 0, sm.actualCollection), 0) AS shipDate,
                    CASE
                        WHEN DATEADD(day, DATEDIFF(day, 0, sm.actualCollection), 0)
                          <= DATEADD(day, DATEDIFF(day, 0, dm.dispatchDate), 0)
                        THEN 1 ELSE 0
                    END AS isOnTime
                FROM Logistics.dbo.ShipmentMain sm
                INNER JOIN Logistics.dbo.ShipmentLink sl ON sl.shipmentID = sm.shipmentID
                INNER JOIN Logistics.dbo.DeliveryMain dm  ON dm.deliveryID  = sl.deliveryID
                WHERE sm.collectionStatus = 1
                  AND ISNULL(sm.shipmentCancelled, 0) = 0
                  AND sm.actualCollection IS NOT NULL
                  AND dm.dispatchDate IS NOT NULL
                  AND sm.actualCollection >= DATEADD(day, -29, DATEADD(day, DATEDIFF(day, 0, GETDATE()), 0))
            )
            SELECT
                shipDate,
                COUNT(*)     AS total,
                SUM(isOnTime) AS onTime
            FROM DailyShipments
            GROUP BY shipDate
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

export { runSapSync };
export default router;
