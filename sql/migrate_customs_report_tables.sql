/* ============================================================
   Customs Report reference/fallback tables — run against the kongsberg
   database. Compatibility: SQL Server 2005+ (no GO, no MERGE — matches
   every other migration in this project).

   Backs the French VAT / DDP Customs Report tile (Logistics,
   routes/customsreport.js + routes/customsreportadmin.js). Both tables
   are small, admin-maintained "gap fillers" — the report tries live SAP
   data first (KNA1-STCEG for the VAT registration number, live on every
   customer-lookup call) and only falls back to CustomsVatNumberOverrides
   when SAP has nothing for that consignee. SAP has no live source at all
   for the HS/commodity code description text, so CustomsHsCodeDescriptions
   is the only source for that column.

   UNIQUE on the natural key (not just the IDENTITY PK) matches the
   MaterialGroupMapping precedent (sql/migrate_material_group_mapping.sql)
   — prevents an admin creating two conflicting rows for the same
   consignee/commodity code and the lookup silently picking one
   nondeterministically.

   Deliberately NOT seeded in bulk from the old AT_Customs.xlsm workbook's
   VAT sheet (~16,632 rows) — per the "SAP live first" decision, this
   table should start empty and only grow as real gaps are found in live
   SAP data, so it never carries forward a stale VAT number SAP itself has
   since corrected. CustomsHsCodeDescriptions IS seeded once, separately,
   from the workbook's HS Code sheet (scripts/seed-customs-hs-codes.js,
   run once locally, not part of this migration) since SAP has no live
   equivalent to ever correct it against.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.CustomsVatNumberOverrides') AND type = 'U')
BEGIN
  CREATE TABLE dbo.CustomsVatNumberOverrides (
    OverrideId     INT           NOT NULL IDENTITY(1,1),
    ConsigneeCode  NVARCHAR(10)  NOT NULL,   -- KNA1-KUNNR, as typed by an admin (not zero-padded)
    VatNumber      NVARCHAR(20)  NOT NULL,   -- fallback for KNA1-STCEG when SAP has nothing
    Notes          NVARCHAR(200) NULL,
    CreatedBy      NVARCHAR(100) NULL,
    CreatedAtUtc   DATETIME      NOT NULL DEFAULT (GETUTCDATE()),
    UpdatedAtUtc   DATETIME      NULL,

    CONSTRAINT PK_CustomsVatNumberOverrides PRIMARY KEY (OverrideId),
    CONSTRAINT UQ_CustomsVatNumberOverrides_Consignee UNIQUE (ConsigneeCode)
  );

  PRINT 'Created dbo.CustomsVatNumberOverrides';
END
ELSE
  PRINT 'dbo.CustomsVatNumberOverrides already exists — skipped';


IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.CustomsHsCodeDescriptions') AND type = 'U')
BEGIN
  CREATE TABLE dbo.CustomsHsCodeDescriptions (
    HsCodeId       INT           NOT NULL IDENTITY(1,1),
    CommodityCode  NVARCHAR(10)  NOT NULL,   -- MARC-STAWN
    Description    NVARCHAR(400) NOT NULL,
    CreatedBy      NVARCHAR(100) NULL,
    CreatedAtUtc   DATETIME      NOT NULL DEFAULT (GETUTCDATE()),
    UpdatedAtUtc   DATETIME      NULL,

    CONSTRAINT PK_CustomsHsCodeDescriptions PRIMARY KEY (HsCodeId),
    CONSTRAINT UQ_CustomsHsCodeDescriptions_Code UNIQUE (CommodityCode)
  );

  PRINT 'Created dbo.CustomsHsCodeDescriptions';
END
ELSE
  PRINT 'dbo.CustomsHsCodeDescriptions already exists — skipped';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS CustomsVatNumberOverrideRows FROM dbo.CustomsVatNumberOverrides;
SELECT COUNT(*) AS CustomsHsCodeDescriptionRows FROM dbo.CustomsHsCodeDescriptions;
