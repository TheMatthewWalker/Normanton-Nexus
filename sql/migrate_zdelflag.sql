/* ============================================================
   Logistics migration — ZDELFLAG/ZDELPACK maintenance support.

   sapPackagingInstruction — the batch's SAP packaging instruction
     (ZPRODBATCH~PALL_MATNR, e.g. "IB_363660_MB"), captured on the
     PalletPackages row at the moment the batch is added/staged.
     Needed later (at delivery-complete) to look up ZBOM_INFO~IDNRK
     for that instruction, which becomes the T_DELPACK packaging
     material rows for this package.

   dbo.DeliveryZdelflagRun — tracks, per SAP delivery (VBELN), the
     outcome of the last Z_MAINT_ZDELFLAG_ZDELPACK maintenance run
     fired when the delivery is marked complete. Supports:
       - a warning log listing deliveries that failed/warned, so
         someone can investigate before the delivery ships
       - a "reprocess" action, but ONLY while status is
         Failed/Warning — once Success, a VBELN cannot be run again
         without a future reversal feature (not implemented yet)
     Status: 'Success' | 'Failed' | 'Warning'.
     Warning = the RFC call itself succeeded but returned one or
     more non-error return-table messages worth flagging (e.g. type
     'W'); Failed = the RFC call errored, was rejected, or a
     precondition (e.g. missing batch) blocked it before the call.

   Run connected to the Logistics database.
   ============================================================ */

USE Logistics;

IF COL_LENGTH('dbo.PalletPackages', 'sapPackagingInstruction') IS NULL
    ALTER TABLE dbo.PalletPackages ADD sapPackagingInstruction NVARCHAR(40) NULL;


IF OBJECT_ID(N'dbo.DeliveryZdelflagRun', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.DeliveryZdelflagRun (
        runID        INT           NOT NULL IDENTITY(1,1),
        deliveryID   NVARCHAR(10)  NOT NULL,   -- VBELN, unpadded
        status       NVARCHAR(10)  NOT NULL,   -- Success | Failed | Warning
        messages     NVARCHAR(MAX) NULL,       -- JSON array of {type, message}
        ranAtUtc     DATETIME      NOT NULL CONSTRAINT DF_DelZdelflagRun_RanAt DEFAULT GETUTCDATE(),
        ranByUserID  INT           NULL,
        CONSTRAINT PK_DeliveryZdelflagRun PRIMARY KEY (runID)
    );

    CREATE INDEX IX_DeliveryZdelflagRun_Delivery ON dbo.DeliveryZdelflagRun (deliveryID, ranAtUtc DESC);
END;


/* ── Verify ──────────────────────────────────────────────────────────────── */

SELECT c.name AS ColumnName, TYPE_NAME(c.system_type_id) AS DataType, c.max_length, c.is_nullable
FROM   sys.columns c
JOIN   sys.objects o ON o.object_id = c.object_id
WHERE  o.name = N'PalletPackages'
ORDER  BY c.column_id;

SELECT c.name AS ColumnName, TYPE_NAME(c.system_type_id) AS DataType, c.max_length, c.is_nullable
FROM   sys.columns c
JOIN   sys.objects o ON o.object_id = c.object_id
WHERE  o.name = N'DeliveryZdelflagRun'
ORDER  BY c.column_id;
