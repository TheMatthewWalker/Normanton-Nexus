/* ============================================================
   Logistics migration — Goods Issue posting (BAPI_DELIVERYPROCESSING_EXEC).

   dbo.DeliveryGoodsIssueRun — tracks, per SAP delivery (VBELN), the
     outcome of each Goods Issue posting attempt. Fired automatically,
     right after a delivery's ZDELFLAG/ZDELPACK maintenance run
     (dbo.DeliveryZdelflagRun) records 'Success' — no manual step.
     Supports:
       - a warning log listing deliveries whose GI posting failed, so
         someone can investigate
       - a "reprocess" action, but ONLY while status is Failed (or no
         run exists yet) — once Success, a VBELN cannot be run again
         without a future reversal feature (not implemented yet),
         same precedent as dbo.DeliveryZdelflagRun's reprocess guard
     Status: 'Success' | 'Failed'. No 'Warning' bucket — SAP's RETURN
     table here is a standard BAPIRET2 (real per-message severity), so
     there's no synthetic third status needed the way ZDELFLAG's flat
     ET_MESSAGE table required.

   Run connected to the Logistics database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE).
   ============================================================ */

USE Logistics;

IF OBJECT_ID(N'dbo.DeliveryGoodsIssueRun', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.DeliveryGoodsIssueRun (
        runID        INT           NOT NULL IDENTITY(1,1),
        deliveryID   NVARCHAR(10)  NOT NULL,   -- VBELN, unpadded
        status       NVARCHAR(10)  NOT NULL,   -- Success | Failed
        messages     NVARCHAR(MAX) NULL,       -- JSON array of {type, message}
        ranAtUtc     DATETIME      NOT NULL CONSTRAINT DF_DelGoodsIssueRun_RanAt DEFAULT GETUTCDATE(),
        ranByUserID  INT           NULL,       -- always null — automatic run, same as DeliveryZdelflagRun's
        CONSTRAINT PK_DeliveryGoodsIssueRun PRIMARY KEY (runID)
    );

    CREATE INDEX IX_DeliveryGoodsIssueRun_Delivery ON dbo.DeliveryGoodsIssueRun (deliveryID, ranAtUtc DESC);
END;


/* ── Verify ──────────────────────────────────────────────────────────────── */

SELECT c.name AS ColumnName, TYPE_NAME(c.system_type_id) AS DataType, c.max_length, c.is_nullable
FROM   sys.columns c
JOIN   sys.objects o ON o.object_id = c.object_id
WHERE  o.name = N'DeliveryGoodsIssueRun'
ORDER  BY c.column_id;
