/* ============================================================
   Consignment customers — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE, no DATE type —
   matches every other migration in this project).

   dbo.ConsignmentCustomer — one row per customer who holds stock on a
   consignment agreement: we ship to them but don't invoice until they
   consume it. Their AgreementSnapshot/InvoiceSnapshot rows were
   inflating the Month End Order Book export and the Management page's
   invoiced/order-book figures, since neither had any way to tell a
   normal sale from a consignment shipment. Flagging a customer here
   excludes them from:
     - dbo.DailyPerformance's InvoicedValue (recomputeDailyInvoiced,
       routes/performancesql.js) — and therefore every KPI/Dashboard
       card fed from it (Invoiced to date, Invoiced+Picked, Invoiced+
       Expected to Invoice, Final Day Total).
     - getOrderBookBreakdown() / getOrderBookSummary() — the Month End
       Order Book export's Data/Next Month tabs and the Management
       page's order-book pipeline chart.
   Managed from a tile on private/management.html.

   NOT the same concept as the existing SOBKZ=K "consignment stock"
   feature (dbo.TurnsValClassSnapshot.ConsignmentQty) — that's
   vendor-owned stock physically on Kongsberg's site, tracked for MRP.
   This table is the opposite direction: Kongsberg-owned stock sitting
   at a *customer's* site, not yet invoiced. Unrelated tables, kept
   deliberately separate so neither gets confused with the other.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ConsignmentCustomer') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ConsignmentCustomer (
    Customer          NVARCHAR(10)   NOT NULL,  -- matches AgreementSnapshot.Customer / InvoiceSnapshot.Customer (SAP customer number)
    CustomerName      NVARCHAR(35)   NULL,       -- denormalised for display convenience, not authoritative

    LastUpdatedUtc    DATETIME       NOT NULL DEFAULT GETUTCDATE(),
    UpdatedByUsername NVARCHAR(80)   NULL,

    CONSTRAINT PK_ConsignmentCustomer PRIMARY KEY (Customer)
  );

  PRINT 'Created dbo.ConsignmentCustomer';
END
ELSE
  PRINT 'dbo.ConsignmentCustomer already exists — skipped';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS ConsignmentCustomerRows FROM dbo.ConsignmentCustomer;
