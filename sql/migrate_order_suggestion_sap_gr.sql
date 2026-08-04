/* ============================================================
   PurchaseOrderSuggestion — SAP goods-receipt outcome columns. Run against
   the kongsberg database. Compatibility: SQL Server 2005+ (matches
   migrate_order_shipments.sql / migrate_order_shipment_received_qty.sql —
   no GO, no CONCAT(), no DATETIME2).

   Added alongside wiring Inbound Log's "Mark Received" up to SapServer's
   real POST /api/purchasing/post-goods-receipt (MB01 BDC), replacing the
   postGoodsReceiptToSap placeholder in routes/performancesql.js. One row
   per order line, stamped after each line's individual GR attempt —
   a single line's SAP failure does not stop the others or block the
   shipment being marked received (see markShipmentReceived's comment).

     SapMaterialDocument — the posted MB01 material document number on
       success (SapServer's BdcResponse.DocumentNumber). NULL until a
       successful post; kept for future individual reversal via SapServer's
       POST /api/purchasing/reverse-goods-receipt (MBST), same pattern
       already used for outbound freight cost lines
       (Logistics.dbo.ShipmentCost.materialDocument).
     SapGrError — the last GR failure message for this line, if any.
       Cleared (set NULL) on a subsequent successful post, so a stale error
       doesn't linger once retried.
     SapGrSkipped — 1 when this line's GR was never attempted, either
       because Mark Received's "skip SAP" checkbox was ticked (testing —
       see markShipmentReceived) or because the order had no SAP PO number
       on file to post against (e.g. a manually-entered order line never
       run through Create PO in SAP). NULL/0 once a real attempt (success
       or failure) has been made.
   ============================================================ */

IF COL_LENGTH('dbo.PurchaseOrderSuggestion', 'SapMaterialDocument') IS NULL
  ALTER TABLE dbo.PurchaseOrderSuggestion ADD SapMaterialDocument NVARCHAR(20) NULL;

IF COL_LENGTH('dbo.PurchaseOrderSuggestion', 'SapGrError') IS NULL
  ALTER TABLE dbo.PurchaseOrderSuggestion ADD SapGrError NVARCHAR(500) NULL;

IF COL_LENGTH('dbo.PurchaseOrderSuggestion', 'SapGrSkipped') IS NULL
  ALTER TABLE dbo.PurchaseOrderSuggestion ADD SapGrSkipped BIT NULL;

PRINT 'dbo.PurchaseOrderSuggestion SAP goods-receipt columns verified/added';
