import * as db from './performancesql.js';
import { getVbfaOrderLink } from './performancesap.js';

// Z_STOCK_REQ_LIST's ReferenceDocument (SRC03) holds the sales order number
// while an order is open, but flips to the delivery number the instant SAP
// creates a delivery against it — see AgreementRow's class comment on the
// SapServer side. Delivery numbers in this SAP system start '008'; order
// numbers don't, so this prefix check is how a "delivery-shaped"
// ReferenceDocument is recognised.
const DELIVERY_NUMBER_PREFIX = '008';

function isDeliveryShaped(referenceDocument) {
  return typeof referenceDocument === 'string' && referenceDocument.trim().startsWith(DELIVERY_NUMBER_PREFIX);
}

const linkKey = (doc, item) => `${doc}||${item}`;

// Resolves any row whose referenceDocument is actually a delivery number
// back to the real sales order number/item, via SAP's document flow table
// VBFA — so Order Book notes/risk flags (dbo.OrderBookLineNotes, keyed on
// ReferenceDocument+Material) stay attached to the same line whether SAP is
// currently calling it an order or a delivery. Without this, a genuinely
// at-risk line's Risk/Won't Get flag silently stops matching the moment
// it's picked, making the line look "fine" again and inflating Expected to
// Invoice on the Month End Dashboard by that line's value.
//
// Mutates `rows` in place. Must run AFTER allocateStock() and BEFORE
// db.replaceAgreementSnapshot() — allocateStock()'s stagingBin() match for
// PickedStockAllocated keys off the *raw* delivery number Z_STOCK_REQ_LIST
// returned (that IS the real staging bin name for a picked line), so
// resolving before that would break picked-stock matching for exactly the
// lines that just became deliveries. Once AgreementSnapshot is written,
// though, ReferenceDocument should always be the stable sales order number
// — every downstream consumer (getOrderBookBreakdown, getOrderBookSummary,
// the notes join, the Month End Excel export) keys off it as-is.
export async function resolveDeliveryReferenceDocuments(rows, req) {
  const candidates = rows.filter(r => isDeliveryShaped(r.referenceDocument));
  if (!candidates.length) return;

  const deliveryNumbers = [...new Set(candidates.map(r => String(r.referenceDocument).trim()))];

  const linkMap = await db.getCachedDeliveryOrderLinks(deliveryNumbers);
  const cachedDeliveries = new Set([...linkMap.keys()].map(k => k.split('||')[0]));
  const uncached = deliveryNumbers.filter(d => !cachedDeliveries.has(d));

  if (uncached.length) {
    // Modest concurrency, not a single Promise.all — this can run for
    // dozens of newly-picked deliveries in one sync cycle and each is its
    // own RFC round-trip; unbounded concurrency here would hammer the SAP
    // connection pool same as the RFC IN-list issues noted elsewhere in
    // this file's history.
    const CONCURRENCY = 5;
    const newRows = [];

    for (let i = 0; i < uncached.length; i += CONCURRENCY) {
      const batch = uncached.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(d => getVbfaOrderLink(req, d)));

      results.forEach((result, idx) => {
        const delivery = batch[idx];
        if (result.status === 'fulfilled') {
          result.value.forEach(link => {
            newRows.push({
              deliveryNumber: delivery,
              deliveryItem:   link.deliveryItem,
              orderNumber:    link.orderNumber,
              orderItem:      link.orderItem,
            });
          });
        } else {
          console.error(`[resolveDeliveryReferenceDocuments] VBFA lookup failed for delivery ${delivery}:`, result.reason?.message);
        }
      });
    }

    if (newRows.length) {
      await db.insertDeliveryOrderLinksIfMissing(newRows);
      newRows.forEach(r => linkMap.set(linkKey(r.deliveryNumber, r.deliveryItem), { orderNumber: r.orderNumber, orderItem: r.orderItem }));
    }
    // Note: a delivery with genuinely no VBFA 'J' link (e.g. manually
    // created in SAP with no source order) gets nothing added here, so
    // it'll be retried as "uncached" on every future sync — a known, minor
    // inefficiency, not worth a negative-result cache entry for what should
    // be a rare case.
  }

  let unresolvedCount = 0;
  for (const row of candidates) {
    const delivery = String(row.referenceDocument).trim();
    const item = String(row.item ?? '').trim();
    const link = linkMap.get(linkKey(delivery, item));

    if (link) {
      row.referenceDocument = link.orderNumber;
      row.item = link.orderItem;
    } else {
      // No VBFA link found for this exact item — leave the raw delivery
      // number in place. Notes/risk flags for this line key off the
      // delivery number until SAP creates the VBFA record, same behaviour
      // as before this fix existed.
      unresolvedCount++;
    }
  }

  if (unresolvedCount) {
    console.warn(`[resolveDeliveryReferenceDocuments] ${unresolvedCount} of ${candidates.length} delivery-shaped ReferenceDocument row(s) had no VBFA order link (left as delivery numbers).`);
  }
}
