/* ============================================================
   PurchaseOrderSuggestion.ReceivedQty — run against the kongsberg
   database. Compatibility: SQL Server 2005+ (matches
   migrate_order_shipments.sql — no GO, no CONCAT(), no DATETIME2).

   Confirmed-received quantity per order line, captured when the
   shipment carrying it is marked received (Inbound Log's "Mark
   Received" action, routes/performancesql.js's markShipmentReceived).
   Distinct from OrderQty (what was ordered): lets an operator record
   a short or over delivery per line instead of the bulk-received
   status implying every order arrived in full, so the eventual real
   SAP goods-receipt posting (postGoodsReceiptToSap) books against
   what was actually received rather than blindly the ordered qty.
   NULL until the order's shipment is received; Cancelled orders on a
   received shipment are skipped by markShipmentReceived and so stay
   NULL too.
   ============================================================ */

IF COL_LENGTH('dbo.PurchaseOrderSuggestion', 'ReceivedQty') IS NULL
  ALTER TABLE dbo.PurchaseOrderSuggestion ADD ReceivedQty DECIMAL(15,3) NULL;

PRINT 'dbo.PurchaseOrderSuggestion ReceivedQty column verified/added';
