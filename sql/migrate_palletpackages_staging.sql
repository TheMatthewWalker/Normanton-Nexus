/* ============================================================
   Logistics migration — track where a staged batch came from, so a
   picksheet-stage-batch transfer order can be reversed when the package
   is deleted from the pallet.

   sapSourceStorageType / sapSourceBin  — the batch's LGTYP/LGPLA at the
     moment it was staged (before the transfer order moved it into the
     picksheet's 916 bin). Needed to move it back on delete.
   sapStageTransferOrder — the SAP transfer order number created when the
     batch was staged, kept for audit/troubleshooting only (not used by
     the reversal logic itself, which re-queries LQUA fresh).

   Run connected to the Logistics database.
   ============================================================ */

USE Logistics;

IF COL_LENGTH('dbo.PalletPackages', 'sapSourceStorageType') IS NULL
    ALTER TABLE dbo.PalletPackages ADD sapSourceStorageType NVARCHAR(3) NULL;

IF COL_LENGTH('dbo.PalletPackages', 'sapSourceBin') IS NULL
    ALTER TABLE dbo.PalletPackages ADD sapSourceBin NVARCHAR(10) NULL;

IF COL_LENGTH('dbo.PalletPackages', 'sapStageTransferOrder') IS NULL
    ALTER TABLE dbo.PalletPackages ADD sapStageTransferOrder NVARCHAR(10) NULL;


/* ── Verify ──────────────────────────────────────────────────────────────── */

SELECT c.name AS ColumnName, TYPE_NAME(c.system_type_id) AS DataType, c.max_length, c.is_nullable
FROM   sys.columns c
JOIN   sys.objects o ON o.object_id = c.object_id
WHERE  o.name = N'PalletPackages'
ORDER  BY c.column_id;
