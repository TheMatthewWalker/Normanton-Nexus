/* ============================================================
   Vendor Consignment Tracker — calculated expiry (2026-08-01).

   dbo.ConsignmentDelivery.ExpiryDate has always been a manual-entry-only
   field (see migrate_consignment_tracker.sql's column comment) because SAP
   has no reliably-populated expiry field at goods receipt for this
   material. In practice nobody was filling it in by hand for most
   deliveries, so the FEFO allocation proposal and the Expiry Warnings list
   were both silently starved of data for any line where ExpiryDate was
   never manually set.

   Matthew's correction: expiry doesn't need to come from SAP or be typed in
   per delivery — it can be calculated as a fixed number of calendar days
   after the goods-receipt DocumentDate, and that number is a per-vendor
   policy (Raaj's material has a different shelf life than Chemours/FCF's),
   so it belongs on dbo.ConsignmentVendorConfig, not hardcoded.

   ExpiryDays is used as a FALLBACK only — routes/consignmentsql.js's
   listConsignmentDeliveries and getDeclaration now compute:
     effective ExpiryDate = ISNULL(ConsignmentDelivery.ExpiryDate,
                                    DocumentDate + ConsignmentVendorConfig.ExpiryDays)
   so a manually-entered ExpiryDate (e.g. from the supplier's actual
   shipment certificate, when someone has it and wants to override the
   calculated default) always wins; the calculated value only fills the gap
   when nobody has typed one in. NULL (unset) behaves exactly as before —
   no expiry calculated, same as a vendor who's never configured it.

   Run against the kongsberg database. SQL Server 2005 compatible (no GO,
   no CONCAT()).
   ============================================================ */

IF COL_LENGTH('dbo.ConsignmentVendorConfig', 'ExpiryDays') IS NULL
  ALTER TABLE dbo.ConsignmentVendorConfig ADD ExpiryDays INT NULL;

PRINT 'dbo.ConsignmentVendorConfig.ExpiryDays verified/added';

/* ── Verify ───────────────────────────────────────────────────────────── */

SELECT VendorId, TrackExpiry, ExpiryWarningDays, ExpiryDays
FROM dbo.ConsignmentVendorConfig
ORDER BY VendorId;
