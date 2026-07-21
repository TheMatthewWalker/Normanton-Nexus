/* ============================================================
   Logistics migration — packaging-data holding area.

   pendingPackagingData — set when the SAP sync (runSapSync in
     routes/deliverymain.js) finds a delivery Nexus still thinks is
     open (completionStatus = 0) missing from SAP's own open-
     picksheets pull. That's taken to mean it was picked/shipped
     directly in SAP, bypassing the pallet builder entirely, so
     Nexus never captured real pallet/packaging data for it.
     completionStatus is set to 1 (SAP says it's done) but this flag
     stays 1 until someone confirms packaging via the normal pallet
     builder — until then the delivery is excluded from Create
     Shipment (completed-unshipped / available-for-shipment) even
     though completionStatus = 1.
   movedToHoldingAtUtc — when the sync moved it into holding, for
     the "Packaging Holding" tile's display.

   Run connected to the Logistics database.
   ============================================================ */

USE Logistics;

IF COL_LENGTH('dbo.DeliveryMain', 'pendingPackagingData') IS NULL
    ALTER TABLE dbo.DeliveryMain ADD pendingPackagingData BIT NOT NULL
        CONSTRAINT DF_DeliveryMain_PendingPkg DEFAULT 0;

IF COL_LENGTH('dbo.DeliveryMain', 'movedToHoldingAtUtc') IS NULL
    ALTER TABLE dbo.DeliveryMain ADD movedToHoldingAtUtc DATETIME NULL;


/* ── Verify ──────────────────────────────────────────────────────────────── */

SELECT c.name AS ColumnName, TYPE_NAME(c.system_type_id) AS DataType, c.max_length, c.is_nullable
FROM   sys.columns c
JOIN   sys.objects o ON o.object_id = c.object_id
WHERE  o.name = N'DeliveryMain'
  AND  c.name IN (N'pendingPackagingData', N'movedToHoldingAtUtc')
ORDER  BY c.column_id;
