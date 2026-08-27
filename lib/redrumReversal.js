/**
 * lib/redrumReversal.js
 *
 * Re-drum reversal — automatic side effect of a batch-managed product being
 * RETURNED to SA/PTFE via ANY transfer-order path (Staging Post deliveries,
 * the warehouse Stock Transfer tool, and any future caller that lands stock
 * there). Shared rather than duplicated per-file like the trivial
 * sapAgent/makeSapToken/audit boilerplate — this is real business logic
 * touching SAP financial postings, warehouse management and production
 * traceability, so it needs exactly one implementation.
 *
 * If the batch being moved has an original backflush (movement 131) in SAP,
 * the transfer isn't a fresh material request — it's a batch-managed product
 * coming back (e.g. a rejected drum returning for re-drumming). In that case:
 *   1. reverse the original backflush via MF41
 *   2. tidy up WM — MF41 posts outside WM, so move the stock the transfer
 *      just placed at SA/PTFE into the outside-WM holding bin: type 901,
 *      bin = the material's cost collector (production order) number,
 *      zero-padded/truncated to 10 characters (see findCostCollectorBin)
 *   3. if that batch was produced by this system's Drumming feature, mark
 *      the job reversed (comment only — scrap already happened and stands,
 *      deliberately untouched)
 * A batch with no matching 131 movement is just a normal transfer — no-op.
 *
 * Usage:
 *   import { maybeReverseBatchManagedReturn } from '../lib/redrumReversal.js';
 *
 *   const redrum = await maybeReverseBatchManagedReturn({
 *     batch, destinationStorageType, destinationBin, storageLocation,
 *     audit, actorUsername, req,
 *   });
 *   // redrum is null for a normal (non-redrum) transfer, or
 *   // { status: 'reversed'|'failed', materialDocument, reversalDocument,
 *   //   transferOrderNumber, drummingID, warning } when it did something.
 */

import axios from 'axios';
import https from 'https';
import fs    from 'fs';
import jwt   from 'jsonwebtoken';
import sql   from 'mssql';
import { sapConfig, sapServerSecret, getNexusOperationsPool } from '../config.js';

const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
  ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
  : null;

function makeSapToken() {
  return jwt.sign(
    { userId: 0 },
    sapServerSecret,
    { issuer: 'normanton-nexus', audience: 'sap-server', expiresIn: '60s' }
  );
}

async function sapPost(path, body, timeout = 30000) {
  const response = await axios.post(`${sapConfig.url}${path}`, body, {
    timeout, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  return response.data;
}

// SapServer's find-cost-collector endpoint is declared [HttpGet] (matching
// the existing check-profit-centre precedent) despite taking a JSON body —
// axios needs to be told explicitly to send a body on a GET.
async function sapGetWithBody(path, body, timeout = 30000) {
  const response = await axios({
    method: 'get',
    url: `${sapConfig.url}${path}`,
    data: body,
    timeout, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  return response.data;
}

async function createSapTransferOrder(body) {
  const response = await sapPost('/api/warehouse/transfer-order', body, 60000);
  if (!response.success) throw new Error((typeof response.error === 'string' ? response.error : response.error?.message) ?? 'SapServer returned success=false');
  return response.data;
}

const WM_OUTSIDE_TYPE = '901';

// Mirrors the existing get_CC() VB helper exactly: table AFKO, filtered on
// PLNBEZ = the padded material, returns AUFNR (the cost collector / repetitive
// manufacturing production order number), then Right(x, 10) — take the last
// 10 characters if longer. Per the user's explicit instruction, values under
// 10 characters are zero-padded on the left (VB's Right() has no analogue for
// that direction, so this is a Node-side addition, not a literal VB mirror).
function padCostCollectorBin(costCollector) {
  const raw = String(costCollector ?? '').trim();
  if (raw.length > 10) return raw.slice(-10);
  return raw.padStart(10, '0');
}

async function findCostCollectorBin(material) {
  const raw = await sapGetWithBody('/api/production/find-cost-collector', { Material: material });
  const costCollector = raw?.data ?? raw;
  if (!costCollector) throw new Error('SapServer returned no cost collector');
  return padCostCollectorBin(costCollector);
}

// Posts an MF41 reversal for one material document and interprets SAP's
// response — shared by the drum's own backflush reversal below and, per
// document, by the braid-component backflush reversal loop further down
// (a drum can have zero, one or several of those). Never throws; the
// caller decides what a failure here should mean for the rest of the
// reversal.
async function reverseSapMaterialDocument(materialDocument) {
  let mf41;
  try {
    const raw = await sapPost('/api/production/reverse-backflush', { MaterialDocument: materialDocument });
    mf41 = raw?.data ?? raw;
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const { type, messageClass, messageNumber, documentNumber: reversalDocument, message } = mf41 || {};
  const alreadyReversed = type === 'E' && messageClass === 'RM' && messageNumber === '210';
  const ok = (type === 'S' && messageClass === 'RM' && messageNumber === '196') || alreadyReversed;

  if (!ok) return { ok: false, error: message || `SAP rejected the reversal: ${type} ${messageClass} ${messageNumber}` };
  return { ok: true, alreadyReversed, reversalDocument: reversalDocument || null };
}

export async function maybeReverseBatchManagedReturn({
  batch, destinationStorageType, destinationBin, storageLocation, audit, actorUsername, req,
}) {
  if (!batch) return null;
  if (destinationStorageType !== 'SA' || destinationBin !== 'PTFE') return null;

  let doc;
  try {
    const found = await sapPost('/api/production/find-backflush-document', { Batch: batch });
    doc = found?.data ?? found;
  } catch (err) {
    // 400 from SapServer means "no 131 movement for this batch" — the normal,
    // non-redrum case for the vast majority of transfers. Anything else is
    // worth a note, but must never block the transfer that already happened.
    if (err.response?.status !== 400) {
      await audit('REDRUM_LOOKUP_ERROR', actorUsername, `Batch '${batch}' — ${err.message}`, req);
    }
    return null;
  }
  if (!doc?.materialDocument) return null;

  const materialDocument = doc.materialDocument;

  const mainReversal = await reverseSapMaterialDocument(materialDocument);
  if (!mainReversal.ok) {
    await audit('REDRUM_REVERSAL_ERROR', actorUsername, `Batch '${batch}' MatDoc ${materialDocument} — ${mainReversal.error}`, req);
    return { status: 'failed', materialDocument, error: mainReversal.error };
  }
  const { alreadyReversed, reversalDocument } = mainReversal;

  await audit('REDRUM_REVERSED', actorUsername, `Batch '${batch}' MatDoc ${materialDocument} reversed${alreadyReversed ? ' (was already reversed)' : ''}`, req);

  // WM tidy-up — move the returned stock out of SA/PTFE into the
  // outside-WM holding bin now the backflush behind it has been reversed.
  // Destination bin is the material's cost collector (production order)
  // number, zero-padded/truncated to 10 characters — not a fixed bin.
  let transferOrderNumber = null;
  let warning = null;
  let destinationBinNumber = null;
  try {
    destinationBinNumber = await findCostCollectorBin(doc.material);
  } catch (err) {
    warning = `Reversed in SAP, but could not find the cost collector for material '${doc.material}' — ${err.message}. Move the stock manually to bin type ${WM_OUTSIDE_TYPE}.`;
    await audit('REDRUM_WM_TIDYUP_ERROR', actorUsername, `Batch '${batch}' MatDoc ${materialDocument} — cost collector lookup failed: ${err.message}`, req);
  }

  if (destinationBinNumber) {
    try {
      const to = await createSapTransferOrder({
        StorageLocation: doc.storageLocation || storageLocation,
        Material: doc.material,
        Quantity: doc.quantity,
        Batch: batch,
        SourceType: 'SA',
        SourceBin: 'PTFE',
        DestinationType: WM_OUTSIDE_TYPE,
        DestinationBin: destinationBinNumber,
      });
      transferOrderNumber = to.transferOrderNumber || null;
    } catch (err) {
      warning = `Reversed in SAP, but the warehouse tidy-up (SA/PTFE -> ${WM_OUTSIDE_TYPE}/${destinationBinNumber}) failed: ${err.message}. Move the stock manually.`;
      await audit('REDRUM_WM_TIDYUP_ERROR', actorUsername, `Batch '${batch}' MatDoc ${materialDocument} — ${err.message}`, req);
    }
  }

  // Mark the job reversed if it was made by this system's Drumming feature.
  // Deliberately does NOT touch scrap — the scrap already happened and stands.
  let drummingID = null;
  try {
    const pool = await getNexusOperationsPool();
    const postingRow = await pool.request()
      .input('doc', sql.NVarChar(10), String(materialDocument))
      .query(`SELECT TOP 1 ProcessRecordID FROM prod.SAPPostings
              WHERE MaterialDocumentSAP=@doc AND ProcessCode='DR' AND IsSuccess=1`);

    if (postingRow.recordset.length) {
      drummingID = postingRow.recordset[0].ProcessRecordID;
      const uid = req.session?.user?.userID ?? 0;

      // IsReversed=0 guard makes this update — and everything gated on its
      // affected-row count below — a one-shot: if this function somehow runs
      // twice for the same drum (e.g. SAP had already reversed it and a
      // second transfer lands here), the second call updates nothing and
      // skips the stock correction rather than double-counting it.
      const upd = await pool.request()
        .input('id',  sql.Int, drummingID)
        .input('uid', sql.Int, uid)
        .input('cmt', sql.NVarChar(sql.MAX), 'reversed to re-drum')
        .query(`UPDATE prod.Drumming SET
                  IsReversed = 1, ReversedAt = GETDATE(), ReversedByUserID = @uid,
                  Notes = CASE WHEN Notes IS NULL OR Notes = '' THEN @cmt ELSE Notes + CHAR(13)+CHAR(10) + @cmt END
                OUTPUT INSERTED.EntryType, INSERTED.SalesOrderSAP, INSERTED.OrderItem, INSERTED.LengthMetres
                WHERE DrummingID = @id AND IsReversed = 0`);

      // The original backflush added its metres to the order's
      // DockStockAllocated (see submitDrumming in routes/productionnexus.js)
      // — undo that here so the order-schedule figure doesn't stay inflated
      // by stock that's actually just come back for re-drumming. Only
      // customer-order drums touched that figure in the first place; stock
      // drums never did, so there's nothing to reverse for those.
      // log.AgreementSnapshot lives in the same NexusOperations database as
      // prod.* now (both were split across separate databases pre-restructure,
      // hence the original increment's own separate connection) — reuse the
      // same pool above instead of a second connection.
      const drum = upd.recordset?.[0];
      if (drum && drum.EntryType === 'customer' && drum.SalesOrderSAP && drum.OrderItem) {
        try {
          await pool.request()
            .input('ref',  sql.NVarChar(10),  drum.SalesOrderSAP)
            .input('item', sql.NVarChar(6),   drum.OrderItem)
            .input('qty',  sql.Decimal(15,3), drum.LengthMetres)
            .query(`
              UPDATE log.AgreementSnapshot
              SET DockStockAllocated = ISNULL(DockStockAllocated,0) - @qty
              WHERE ReferenceDocument = @ref AND Item = @item`);
        } catch (err) {
          warning = (warning ? warning + ' ' : '') + `Reversed, but the live order-schedule figure could not be corrected immediately (it will catch up on the next sync): ${err.message}`;
        }
      }

      // Reverse any braided-component backflushes this drum triggered (see
      // backflushBraidedComponents in routes/productionnexus.js) — those
      // consumed real SAP stock against the braid batch's own reference,
      // same as the drum's own backflush just reversed above, so leaving
      // them in place would understate what's actually still in stock (a
      // genuine consistency bug otherwise). Gated on `drum` only, not the
      // customer-order check above — applies to both customer and stock
      // drums, since braid consumption doesn't care which kind of drum
      // consumed it. prod.ProductionTrace.MaterialDocumentSAP (set
      // alongside QuantityConsumed at braid-backflush time) is a direct
      // pointer to which document to reverse, so this doesn't need to
      // guess even if several drums drew down the same braid batch.
      if (drum) {
        try {
          const braidDocs = await pool.request()
            .input('cc', sql.NVarChar(5), 'DR').input('cr', sql.Int, drummingID)
            .input('pc', sql.NVarChar(5), 'BR')
            .query(`SELECT ParentRecordID, MaterialDocumentSAP FROM prod.ProductionTrace
                    WHERE ChildProcessCode=@cc AND ChildRecordID=@cr AND ParentProcessCode=@pc
                      AND MaterialDocumentSAP IS NOT NULL`);

          for (const row of braidDocs.recordset) {
            const braidDoc       = row.MaterialDocumentSAP;
            const braidingID     = row.ParentRecordID;
            const braidReversal  = await reverseSapMaterialDocument(braidDoc);

            if (!braidReversal.ok) {
              warning = (warning ? warning + ' ' : '') + `Braid component backflush ${braidDoc} could not be reversed: ${braidReversal.error}.`;
              await audit('REDRUM_REVERSAL_ERROR', actorUsername, `Braid batch #${braidingID} MatDoc ${braidDoc} — ${braidReversal.error}`, req);
              continue;
            }

            await pool.request()
              .input('doc',  sql.NVarChar(10), braidDoc)
              .input('rdoc', sql.NVarChar(10), braidReversal.reversalDocument)
              .input('uid',  sql.Int, uid)
              .query(`UPDATE prod.SAPPostings SET
                        IsReversed = 1, ReversalDocumentSAP = @rdoc, ReversedAt = GETDATE(), ReversedByUserID = @uid
                      WHERE ProcessCode='BR' AND MaterialDocumentSAP=@doc AND IsSuccess=1 AND IsReversed=0`);

            await audit('REDRUM_REVERSED', actorUsername,
              `Braid batch #${braidingID} MatDoc ${braidDoc} reversed${braidReversal.alreadyReversed ? ' (was already reversed)' : ''} (consumed by drum #${drummingID})`, req);
          }
        } catch (err) {
          warning = (warning ? warning + ' ' : '') + `Could not reverse braid component backflush(es): ${err.message}`;
        }
      }
    }
  } catch (err) {
    warning = (warning ? warning + ' ' : '') + `Could not update the Drumming record: ${err.message}`;
  }

  return { status: 'reversed', materialDocument, reversalDocument: reversalDocument || null, transferOrderNumber, drummingID, warning };
}
