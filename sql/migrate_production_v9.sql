 /* What changed:

  Frontend (private/js/production-nexus.js):
  - Replaced the old 6-phase wizard with a new type-selection-first flow
  - Phase 0: Card selection — Make-to-Stock or Make-to-Order
  - Make-to-Stock: 5 phases (Details → Traceability → Coil Lengths → Scrap → Review)
  - Make-to-Order: 6 phases (Customer → Details → Traceability → Coil Lengths → Scrap → Review)
  - Details phase: Material, Operator (read-only from session), Shift (auto-detected from time), Packaging (live
  dropdown from Logistics.dbo.PackagingData), Weight (KG)
  - Submits to /api/productionnexus/drumming/stock or /drumming/customer depending on type

  Backend (routes/productionnexus.js):
  - Added submitDrumming(req, res, entryType) shared helper
  - Added POST /drumming/stock and POST /drumming/customer endpoints
  - SAP is called at /drumming/stock or /drumming/customer on the SAP server
  - Old /drumming/entry is unchanged (still needed by the failed backflush retry queue)

  ---
  Database migrations required before this will work: */

  ALTER TABLE prod.Drumming ADD WeightKG DECIMAL(12,3) NULL;
  ALTER TABLE prod.Drumming ADD EntryType NVARCHAR(10) NULL DEFAULT 'stock';
  ALTER TABLE prod.Drumming ALTER COLUMN PackagingType NVARCHAR(10) NULL;

  /* The PackagingType column widening is needed if packID values from PackagingData are longer than 3 characters. */