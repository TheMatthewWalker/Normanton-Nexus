/* ============================================================
   Delivery -> order link cache — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE, no DATE type — matches
   every other migration in this project).

   WHY THIS TABLE EXISTS:
   SAP's Z_STOCK_REQ_LIST report (routes/performancesync.js's Agreements
   pull) returns a "ReferenceDocument" field that holds the sales order
   number while an order is open, but silently flips to the delivery number
   the instant SAP creates a delivery against it (see AgreementRow's class
   comment in SapServer/Models/Bapi/PerformanceModels.cs). Anything keyed on
   ReferenceDocument — most importantly dbo.OrderBookLineNotes, which
   remembers a planner's Risk/Won't Get/Reason flags — breaks the moment
   that happens: a genuinely at-risk line's note silently stops matching,
   the line looks "fine" again, and Expected to Invoice on the Month End
   Dashboard gets inflated by exactly that line's value.

   The fix (routes/performanceorderlink.js's resolveDeliveryReferenceDocuments,
   called from routes/performancesync.js between allocateStock() and
   replaceAgreementSnapshot()) detects a delivery-shaped ReferenceDocument
   (starts '008') and resolves it back to the real sales order number/item
   via SAP table VBFA (document flow). IMPORTANT: it does NOT overwrite
   ReferenceDocument/Item — those are left exactly as SAP returned them,
   since allocateStock()'s staging-bin match and other features (e.g. the
   Drumming Order Lookup) still need the raw value. Instead the resolved
   sales order number/item are written to two new columns on
   dbo.AgreementSnapshot, OriginalDoc/OriginalDocItem (added below), which
   getOrderBookBreakdown/OrderBookLineNotes/the Month End export key off
   instead — see performancesql.js.

   This table is the permanent cache for the VBFA lookup itself — a
   delivery-item's originating order never changes once SAP creates the
   delivery, so each (DeliveryNumber, DeliveryItem) pair only ever needs
   resolving once. It's also intended for reuse by the warehouse Open
   Picksheets feature to find the sales order behind a delivery's stock
   allocation (per the user's request) — not wired up yet, but the table is
   ready for it.
   ============================================================ */


IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.DeliveryOrderLink') AND type = 'U')
BEGIN
  CREATE TABLE dbo.DeliveryOrderLink (
    DeliveryNumber NVARCHAR(10) NOT NULL,  -- VBFA~VBELN
    DeliveryItem   NVARCHAR(6)  NOT NULL,  -- VBFA~POSNN

    OrderNumber    NVARCHAR(10) NOT NULL,  -- VBFA~VBELV
    OrderItem      NVARCHAR(6)  NOT NULL,  -- VBFA~POSNV

    ResolvedAtUtc  DATETIME     NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_DeliveryOrderLink PRIMARY KEY (DeliveryNumber, DeliveryItem)
  );

  CREATE INDEX IX_DeliveryOrderLink_Order ON dbo.DeliveryOrderLink (OrderNumber);

  PRINT 'Created dbo.DeliveryOrderLink';
END
ELSE
  PRINT 'dbo.DeliveryOrderLink already exists — skipped';


/* ── AgreementSnapshot.OriginalDoc / OriginalDocItem ─────────────────────────
   The stable sales order number/item — always populated (pass-through for
   rows that were never delivery-shaped, VBFA-resolved for rows that were),
   never overwritten. See performanceorderlink.js / performancesql.js. */
IF COL_LENGTH('dbo.AgreementSnapshot', 'OriginalDoc') IS NULL
BEGIN
  ALTER TABLE dbo.AgreementSnapshot ADD OriginalDoc NVARCHAR(10) NULL;
  PRINT 'Added dbo.AgreementSnapshot.OriginalDoc';
END
ELSE
  PRINT 'dbo.AgreementSnapshot.OriginalDoc already exists — skipped';

IF COL_LENGTH('dbo.AgreementSnapshot', 'OriginalDocItem') IS NULL
BEGIN
  ALTER TABLE dbo.AgreementSnapshot ADD OriginalDocItem NVARCHAR(6) NULL;
  PRINT 'Added dbo.AgreementSnapshot.OriginalDocItem';
END
ELSE
  PRINT 'dbo.AgreementSnapshot.OriginalDocItem already exists — skipped';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS DeliveryOrderLinkRows FROM dbo.DeliveryOrderLink;
