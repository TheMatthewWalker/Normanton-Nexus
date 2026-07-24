-- ============================================================================
-- migrate_shipmentcost_purchase_order.sql
--
-- Adds a purchaseOrder column to Logistics.dbo.ShipmentCost so the SAP PO
-- number created by the new elevated create-po-and-receipt flow (task #415,
-- SapServer POST /api/purchasing/create-po-and-receipt) is stored per cost
-- line, alongside the existing materialDocument column that already stores
-- the goods-receipt material document. Purely for traceability/debugging and
-- so a support query can find "which PO did this cost post to" without
-- going back to SAP — nothing currently reads this column back out.
--
-- SQL Server 2005 compatible: COL_LENGTH guard, no GO, no CONCAT(), PRINT
-- status, verify SELECT at the end.
-- ============================================================================

IF COL_LENGTH('Logistics.dbo.ShipmentCost', 'purchaseOrder') IS NULL
BEGIN
    ALTER TABLE Logistics.dbo.ShipmentCost ADD purchaseOrder NVARCHAR(20) NULL;
    PRINT 'Added Logistics.dbo.ShipmentCost.purchaseOrder';
END
ELSE
BEGIN
    PRINT 'Logistics.dbo.ShipmentCost.purchaseOrder already exists — skipped';
END

SELECT COUNT(*) AS ShipmentCostRowsWithPurchaseOrder
FROM Logistics.dbo.ShipmentCost
WHERE purchaseOrder IS NOT NULL;
