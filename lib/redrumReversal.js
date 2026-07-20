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
 *      just placed at SA/PTFE into the outside-WM holding bin, 921/RESTR
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
import { sapConfig, sapServerSecret, getProductionPool } from '../config.js';

const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
  ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
  : null;

function makeSapToken() {
  return jwt.sign(
    { userId: 0 },
    sapServerSecret,
    { issuer: 'sql2005-bridge', audience: 'sap-server', expiresIn: '60s' }
  );
}

async function sapPost(path, body, timeout = 30000) {
  const response = await axios.post(`${sapConfig.url}${path}`, body, {
    timeout, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  return response.data;
}

async function createSapTransferOrder(body) {
  const response = await sapPost('/api/warehouse/transfer-order', body, 60000);
  if (!response.success) throw new Error(response.error ?? 'SapServer returned success=false');
  return response.data;
}

const WM_RESTRICTED_TYPE = '921';
const WM_RESTRICTED_BIN  = 'RESTR';

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

  let mf41;
  try {
    const raw = await sapPost('/api/production/reverse-backflush', { MaterialDocument: materialDocument });
    mf41 = raw?.data ?? raw;
  } catch (err) {
    await audit('REDRUM_REVERSAL_ERROR', actorUsername, `Batch '${batch}' MatDoc ${materialDocument} — ${err.message}`, req);
    return { status: 'failed', materialDocument, error: err.message };
  }

  const { type, messageClass, messageNumber, documentNumber: reversalDocument, message } = mf41 || {};
  const alreadyReversed = type === 'E' && messageClass === 'RM' && messageNumber === '210';
  const reversedOk      = (type === 'S' && messageClass === 'RM' && messageNumber === '196') || alreadyReversed;

  if (!reversedOk) {
    const errMsg = message || `SAP rejected the reversal: ${type} ${messageClass} ${messageNumber}`;
    await audit('REDRUM_REVERSAL_ERROR', actorUsername, `Batch '${batch}' MatDoc ${materialDocument} — ${errMsg}`, req);
    return { status: 'failed', materialDocument, error: errMsg };
  }

  await audit('REDRUM_REVERSED', actorUsername, `Batch '${batch}' MatDoc ${materialDocument} reversed${alreadyReversed ? ' (was already reversed)' : ''}`, req);

  // WM tidy-up — move the returned stock out of SA/PTFE into the
  // outside-WM holding bin now the backflush behind it has been reversed.
  let transferOrderNumber = null;
  let warning = null;
  try {
    const to = await createSapTransferOrder({
      StorageLocation: doc.storageLocation || storageLocation,
      Material: doc.material,
      Quantity: doc.quantity,
      Batch: batch,
      SourceType: 'SA',
      SourceBin: 'PTFE',
      DestinationType: WM_RESTRICTED_TYPE,
      DestinationBin: WM_RESTRICTED_BIN,
    });
    transferOrderNumber = to.transferOrderNumber || null;
  } catch (err) {
    warning = `Reversed in SAP, but the warehouse tidy-up (SA/PTFE -> ${WM_RESTRICTED_TYPE}/${WM_RESTRICTED_BIN}) failed: ${err.message}. Move the stock manually.`;
    await audit('REDRUM_WM_TIDYUP_ERROR', actorUsername, `Batch '${batch}' MatDoc ${materialDocument} — ${err.message}`, req);
  }

  // Mark the job reversed if it was made by this system's Drumming feature.
  // Deliberately does NOT touch scrap — the scrap already happened and stands.
  let drummingID = null;
  try {
    const pool = await getProductionPool();
    const postingRow = await pool.request()
      .input('doc', sql.NVarChar(10), String(materialDocument))
      .query(`SELECT TOP 1 ProcessRecordID FROM prod.SAPPostings
              WHERE MaterialDocumentSAP=@doc AND ProcessCode='DR' AND IsSuccess=1`);

    if (postingRow.recordset.length) {
      drummingID = postingRow.recordset[0].ProcessRecordID;
      const uid = req.session?.user?.userID ?? 0;
      await pool.request()
        .input('id',  sql.Int, drummingID)
        .input('uid', sql.Int, uid)
        .input('cmt', sql.NVarChar(sql.MAX), 'reversed to re-drum')
        .query(`UPDATE prod.Drumming SET
                  IsReversed = 1, ReversedAt = GETDATE(), ReversedByUserID = @uid,
                  Notes = CASE WHEN Notes IS NULL OR Notes = '' THEN @cmt ELSE Notes + CHAR(13)+CHAR(10) + @cmt END
                WHERE DrummingID = @id`);
    }
  } catch (err) {
    warning = (warning ? warning + ' ' : '') + `Could not update the Drumming record: ${err.message}`;
  }

  return { status: 'reversed', materialDocument, reversalDocument: reversalDocument || null, transferOrderNumber, drummingID, warning };
}
