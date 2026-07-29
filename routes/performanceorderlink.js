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
// VBFA, and stores the result in row.originalDoc/row.originalDocItem — a
// new pair of columns, separate from referenceDocument/item. So Order Book
// notes/risk flags (dbo.OrderBookLineNotes, keyed on OriginalDoc+Material —
// see getOrderBookBreakdown) stay attached to the same line whether SAP is
// currently calling it an order or a delivery. Without this, a genuinely
// at-risk line's Risk/Won't Get flag silently stops matching the moment
// it's picked, making the line look "fine" again and inflating Expected to
// Invoice on the Month End Dashboard by that line's value.
//
// Deliberately does NOT touch row.referenceDocument/row.item — those are
// left exactly as SAP returned them (order while open, delivery once
// picked), because allocateStock()'s stagingBin() match for
// PickedStockAllocated keys off the *raw* delivery number Z_STOCK_REQ_LIST
// returned (that IS the real staging bin name for a picked line), and other
// features (e.g. the Drumming Order Lookup) still expect the raw value too.
// originalDoc/originalDocItem are purely additive — every row gets them
// set (pass-through for non-delivery-shaped rows, VBFA-resolved for
// deliveries), so getOrderBookBreakdown and everything built on it
// (Month End Excel Data/Next Month tabs, the notes join, the at-risk list)
// can key off the stable sales order number without losing the raw
// delivery number anywhere else.
//
// Mutates `rows` in place. Must run AFTER allocateStock() (for the same
// staging-bin reason above) and BEFORE db.replaceAgreementSnapshot() (so
// OriginalDoc/OriginalDocItem are populated before the snapshot write).
export async function resolveDeliveryReferenceDocuments(rows, req) {
  // Pass-through default for every row — candidates below overwrite this
  // with the VBFA-resolved order number/item where one was found.
  rows.forEach(r => {
    r.originalDoc = r.referenceDocument;
    r.originalDocItem = r.item;
  });

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
      row.originalDoc = link.orderNumber;
      row.originalDocItem = link.orderItem;
    } else {
      // No VBFA link found for this exact item — originalDoc/originalDocItem
      // stay at the pass-through default set above (the raw delivery
      // number/item). Notes/risk flags for this line key off the delivery
      // number until SAP creates the VBFA record, same behaviour as before
      // this fix existed.
      unresolvedCount++;
    }
  }

  if (unresolvedCount) {
    console.warn(`[resolveDeliveryReferenceDocuments] ${unresolvedCount} of ${candidates.length} delivery-shaped ReferenceDocument row(s) had no VBFA order link (left as delivery numbers).`);
  }
}
