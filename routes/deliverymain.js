import express from 'express';
import sql from 'mssql';
import axios from 'axios';
import { sqlConfig, sapConfig } from '../config.js';
import { requirePermission } from '../middleware/auth.js';
import { makeSapToken, sapAgent } from './sap.js';

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

        return { success: true, status: 200, total: deliveries.length, inserted, skipped, errors, missing, autoCreated, kna1Error };

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
