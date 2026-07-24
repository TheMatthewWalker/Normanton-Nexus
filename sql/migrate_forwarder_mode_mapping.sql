/* ============================================================
   Forwarder Type -> Mode of Transport lookup — run against the kongsberg
   database.
   Compatibility : SQL Server 2005+ (matches create_performance_turnsvalclass_database.sql
   — no GO, no CONCAT(), no DATETIME2).

   Why this exists: Forwarders.forwarderMode holds the forwarder's own
   delivery mode/type (e.g. "Road", "Sea", "Air" — see routes/forwarders.js
   GET /modes and the OS_TRANSPORT_MODES list in private/js/logistics.js),
   but that value was never being carried through to
   ShipmentCost.modeOfTransport when cost lines are created at booking time
   (routes/shipmentmain.js's mark-booked route) — the freight/customs
   INSERTs there never included a modeOfTransport column at all, so every
   outbound cost line (manual and SAP-driven shipments alike) ended up with
   NULL modeOfTransport. That in turn means lookupMaterialGroup
   (routes/materialgroups.js) can only ever use a GL account's
   mode-independent default row, never a mode-specific override.

   In practice a forwarder's mode string won't always equal the canonical
   ModeOfTransport value used elsewhere (ShipmentCost.modeOfTransport,
   MaterialGroupMapping.ModeOfTransport) — e.g. a forwarder type like
   "Groupage" or "Express Air" needs translating to "Road"/"Air" — so this
   is a proper lookup table (mirroring dbo.MaterialGroupMapping) rather than
   assuming the two vocabularies always line up. Maintained via the
   Forwarder Mode Mapping admin tile in Logistics.

   Keyed uniquely on ForwarderMode (routes/forwardermodemapping.js's
   lookupModeOfTransport looks up by exact ForwarderMode match; if no row
   exists it falls back to using the raw forwarderMode value as-is — this
   is best-effort shipment metadata, not a hard SAP requirement like
   Material Group, so a missing mapping should never block booking).
   ============================================================ */


IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ForwarderModeMapping') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ForwarderModeMapping (
    MappingId       INT           NOT NULL IDENTITY(1,1),

    -- Matches Forwarders.forwarderMode (the forwarder's own delivery
    -- mode/type, e.g. "Road", "Sea", "Air", or a business-specific type).
    ForwarderMode   NVARCHAR(20)  NOT NULL,

    -- One of OS_TRANSPORT_MODES (Road/Sea/Air/Rail/Courier/Other) —
    -- what actually gets stored on ShipmentCost.modeOfTransport and used
    -- by MaterialGroupMapping's mode-specific lookup.
    ModeOfTransport NVARCHAR(20)  NOT NULL,

    Description     NVARCHAR(200) NULL,
    CreatedBy       NVARCHAR(100) NULL,
    CreatedAtUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAtUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_ForwarderModeMapping PRIMARY KEY (MappingId),
    CONSTRAINT UQ_ForwarderModeMapping_ForwarderMode UNIQUE (ForwarderMode)
  );

  PRINT 'Created dbo.ForwarderModeMapping';
END
ELSE
  PRINT 'dbo.ForwarderModeMapping already exists — skipped';


/* ── Seed identity mappings for the standard OS_TRANSPORT_MODES set, since
   forwarderMode is picked from that same list on the Update Forwarders
   admin tile — these are the common case and just pass the value through
   unchanged. Admin can edit/add rows on the Forwarder Mode Mapping tile
   for any forwarder type that needs translating to something different. */
IF NOT EXISTS (SELECT 1 FROM dbo.ForwarderModeMapping WHERE ForwarderMode = 'Road')
  INSERT INTO dbo.ForwarderModeMapping (ForwarderMode, ModeOfTransport, Description, CreatedBy)
  VALUES ('Road', 'Road', 'Default identity mapping — migration seed', 'migration seed');

IF NOT EXISTS (SELECT 1 FROM dbo.ForwarderModeMapping WHERE ForwarderMode = 'Sea')
  INSERT INTO dbo.ForwarderModeMapping (ForwarderMode, ModeOfTransport, Description, CreatedBy)
  VALUES ('Sea', 'Sea', 'Default identity mapping — migration seed', 'migration seed');

IF NOT EXISTS (SELECT 1 FROM dbo.ForwarderModeMapping WHERE ForwarderMode = 'Air')
  INSERT INTO dbo.ForwarderModeMapping (ForwarderMode, ModeOfTransport, Description, CreatedBy)
  VALUES ('Air', 'Air', 'Default identity mapping — migration seed', 'migration seed');

IF NOT EXISTS (SELECT 1 FROM dbo.ForwarderModeMapping WHERE ForwarderMode = 'Rail')
  INSERT INTO dbo.ForwarderModeMapping (ForwarderMode, ModeOfTransport, Description, CreatedBy)
  VALUES ('Rail', 'Rail', 'Default identity mapping — migration seed', 'migration seed');

IF NOT EXISTS (SELECT 1 FROM dbo.ForwarderModeMapping WHERE ForwarderMode = 'Courier')
  INSERT INTO dbo.ForwarderModeMapping (ForwarderMode, ModeOfTransport, Description, CreatedBy)
  VALUES ('Courier', 'Courier', 'Default identity mapping — migration seed', 'migration seed');

IF NOT EXISTS (SELECT 1 FROM dbo.ForwarderModeMapping WHERE ForwarderMode = 'Other')
  INSERT INTO dbo.ForwarderModeMapping (ForwarderMode, ModeOfTransport, Description, CreatedBy)
  VALUES ('Other', 'Other', 'Default identity mapping — migration seed', 'migration seed');


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS ForwarderModeMappingRows FROM dbo.ForwarderModeMapping;
