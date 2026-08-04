/* ============================================================
   Seed Data Extraction Script -- pulls the actual rows out of a
   deliberately small set of reference/lookup tables (config, master
   data, and login accounts) so they can be carried over to a fresh
   migrated database, on top of the schema-only migrations already
   built. NOT a full data migration -- transactional/historical tables
   are intentionally excluded, see migrations/README.md for the exact
   table list and the reasoning per table.

   Compatibility : SQL Server 2005+. Entirely read-only.

   HOW TO RUN
   ----------
   Same workflow as the schema extraction scripts: paste this whole
   file into the SQL Console section of private/admin.html (-> /sql/query)
   and click Run once. Export every result block to CSV into a NEW
   folder (not reused from a previous batch, to avoid sql-result<N>
   filename collisions) -- e.g. SqlMigrations\seed\.

   DATETIME columns are explicitly CONVERTed to a fixed-format string
   (style 121, 'yyyy-mm-dd hh:mi:ss.mmm') in every SELECT below, rather
   than left as native datetime -- the CSV export path round-trips a
   plain string cleanly, but would otherwise stringify a JS Date object
   via its locale-dependent toString(), which isn't SQL-parseable.

   Order matches FK dependency order within each database (parent
   tables before any child table that references them by ID) -- see
   migrations/README.md for the specific dependencies.
   ============================================================ */

/* ------------------------------------------------------------
   Kongsberg
   ------------------------------------------------------------ */
SELECT '----- SEED: dbo.FinanceGlGroups -----' AS Section;

SELECT
    GroupID,
    GroupLabel,
    SortOrder,
    CONVERT(VARCHAR(23), CreatedAt, 121) AS CreatedAt
FROM dbo.FinanceGlGroups;

SELECT '----- SEED: dbo.ForwarderModeMapping -----' AS Section;

SELECT
    MappingId,
    ForwarderMode,
    ModeOfTransport,
    Description,
    CreatedBy,
    CONVERT(VARCHAR(23), CreatedAtUtc, 121) AS CreatedAtUtc,
    CONVERT(VARCHAR(23), UpdatedAtUtc, 121) AS UpdatedAtUtc
FROM dbo.ForwarderModeMapping;

SELECT '----- SEED: dbo.MaterialGroupMapping -----' AS Section;

SELECT
    MappingId,
    CostElement,
    ModeOfTransport,
    ModeKey,
    MaterialGroup,
    Description,
    CreatedBy,
    CONVERT(VARCHAR(23), CreatedAtUtc, 121) AS CreatedAtUtc,
    CONVERT(VARCHAR(23), UpdatedAtUtc, 121) AS UpdatedAtUtc
FROM dbo.MaterialGroupMapping;

SELECT '----- SEED: dbo.ValuationClassCatalog -----' AS Section;

SELECT
    ValuationClass,
    MaterialType,
    AccountRef,
    Description
FROM dbo.ValuationClassCatalog;

SELECT '----- SEED: dbo.ScrapReasons -----' AS Section;

SELECT
    ReasonCode,
    ReasonDescription
FROM dbo.ScrapReasons;

SELECT '----- SEED: dbo.PortalPermissions -----' AS Section;

SELECT
    PermissionCode,
    PermissionName,
    Description,
    Category,
    CONVERT(VARCHAR(23), CreatedAt, 121) AS CreatedAt
FROM dbo.PortalPermissions;

SELECT '----- SEED: dbo.Vendor -----' AS Section;

SELECT
    VendorId,
    VendorName,
    Incoterms,
    OrderMoqQty,
    OrderMoqUom,
    DefaultLeadTimeDays,
    Notes,
    CONVERT(VARCHAR(23), CreatedAtUtc, 121) AS CreatedAtUtc,
    CONVERT(VARCHAR(23), UpdatedAtUtc, 121) AS UpdatedAtUtc,
    TransitTimeDays,
    OrderMaxQty,
    SapVendorNumber,
    Currency
FROM dbo.Vendor;

SELECT '----- SEED: dbo.ConsignmentCustomer -----' AS Section;

SELECT
    Customer,
    CustomerName,
    CONVERT(VARCHAR(23), LastUpdatedUtc, 121) AS LastUpdatedUtc,
    UpdatedByUsername
FROM dbo.ConsignmentCustomer;

SELECT '----- SEED: dbo.CustomerStandardInstructions -----' AS Section;

SELECT
    Customer,
    CustomerName,
    Instructions,
    CONVERT(VARCHAR(23), LastUpdatedUtc, 121) AS LastUpdatedUtc,
    UpdatedByUsername
FROM dbo.CustomerStandardInstructions;

SELECT '----- SEED: dbo.PortalUsers -----' AS Section;

SELECT
    UserID,
    Username,
    Email,
    PasswordHash,
    Role,
    IsActive,
    IsLocked,
    FailedLogins,
    CONVERT(VARCHAR(23), CreatedAt, 121) AS CreatedAt,
    CONVERT(VARCHAR(23), LastLogin, 121) AS LastLogin,
    ApprovedBy,
    CONVERT(VARCHAR(23), ApprovedAt, 121) AS ApprovedAt,
    Notes,
    FirstName,
    LastName,
    DefaultPrinterID,
    ShortIdleTimeout,
    reset_token,
    CONVERT(VARCHAR(23), reset_token_expires, 121) AS reset_token_expires,
    SapUsername,
    SapPasswordEncrypted,
    CONVERT(VARCHAR(23), SapCredentialUpdatedAt, 121) AS SapCredentialUpdatedAt
FROM dbo.PortalUsers;

SELECT '----- SEED: dbo.FinanceGlGroupAccounts -----' AS Section;

SELECT
    AccountID,
    GroupID,
    GlAccount,
    SortOrder
FROM dbo.FinanceGlGroupAccounts;

SELECT '----- SEED: dbo.ConsignmentVendorConfig -----' AS Section;

SELECT
    VendorId,
    TrackExpiry,
    ExpiryWarningDays,
    DefaultAllocationMethod,
    Active,
    Notes,
    CONVERT(VARCHAR(23), UpdatedAtUtc, 121) AS UpdatedAtUtc,
    UpdatedByUsername,
    ExpiryDays
FROM dbo.ConsignmentVendorConfig;

SELECT '----- SEED: dbo.VendorMaterial -----' AS Section;

SELECT
    VendorMaterialId,
    VendorId,
    Material,
    MaterialMoqQty,
    LeadTimeDaysOverride,
    ScheduleAgreement,
    SourceHint,
    CONVERT(VARCHAR(23), CreatedAtUtc, 121) AS CreatedAtUtc,
    CONVERT(VARCHAR(23), UpdatedAtUtc, 121) AS UpdatedAtUtc,
    MinSafetyStockQty,
    MaterialMaxQty
FROM dbo.VendorMaterial;

SELECT '----- SEED: dbo.PortalUserDepartments -----' AS Section;

SELECT
    ID,
    UserID,
    Department,
    GrantedBy,
    CONVERT(VARCHAR(23), GrantedAt, 121) AS GrantedAt
FROM dbo.PortalUserDepartments;

SELECT '----- SEED: dbo.PortalUserPermissions -----' AS Section;

SELECT
    UserPermissionID,
    UserID,
    PermissionCode,
    CONVERT(VARCHAR(23), GrantedAt, 121) AS GrantedAt,
    GrantedByUserID
FROM dbo.PortalUserPermissions;

/* ------------------------------------------------------------
   Logistics
   ------------------------------------------------------------ */
SELECT '----- SEED: Logistics.dbo.CostTypes -----' AS Section;

SELECT
    typeID,
    typeDescription
FROM Logistics.dbo.CostTypes;

SELECT '----- SEED: Logistics.dbo.CostElements -----' AS Section;

SELECT
    elementID,
    elementDescription,
    elementCode,
    direction,
    tier
FROM Logistics.dbo.CostElements;

SELECT '----- SEED: Logistics.dbo.CostCenters -----' AS Section;

SELECT
    centerID,
    centerDescription,
    centerCode
FROM Logistics.dbo.CostCenters;

SELECT '----- SEED: Logistics.dbo.Incoterms -----' AS Section;

SELECT
    incotermsID,
    incotermsDescription
FROM Logistics.dbo.Incoterms;

SELECT '----- SEED: Logistics.dbo.PackagingData -----' AS Section;

SELECT
    packID,
    packMaterial,
    packDescription,
    packWeight,
    packLength,
    packWidth,
    packHeight
FROM Logistics.dbo.PackagingData;

SELECT '----- SEED: Logistics.dbo.PalletData -----' AS Section;

SELECT
    palletID,
    palletDescription,
    palletWeight,
    palletLength,
    palletWidth,
    palletHeight
FROM Logistics.dbo.PalletData;

SELECT '----- SEED: Logistics.dbo.DeliveryRoutes -----' AS Section;

SELECT
    routeID,
    countryCode,
    postcodePrefix,
    transitDays
FROM Logistics.dbo.DeliveryRoutes;

SELECT '----- SEED: Logistics.dbo.Destinations -----' AS Section;

SELECT
    destinationID,
    destinationName,
    destinationStreet,
    destinationCity,
    destinationPostCode,
    destinationCountry,
    defaultIncoterms,
    destinationComment,
    destinationZone,
    defaultDeliveryService,
    defaultForwarder
FROM Logistics.dbo.Destinations;

SELECT '----- SEED: Logistics.dbo.Forwarders -----' AS Section;

SELECT
    forwarderID,
    forwarderName,
    forwarderApproval,
    forwarderMode
FROM Logistics.dbo.Forwarders;

SELECT '----- SEED: Logistics.dbo.RatesKN -----' AS Section;

SELECT
    countryCode,
    postalCode,
    minWeight,
    maxWeight,
    agreedRate,
    transitTime,
    minimumCharge
FROM Logistics.dbo.RatesKN;

SELECT '----- SEED: Logistics.dbo.RatesTPN -----' AS Section;

SELECT
    postalZone,
    palletCategory,
    serviceLevel,
    agreedRate
FROM Logistics.dbo.RatesTPN;

/* ------------------------------------------------------------
   Production
   ------------------------------------------------------------ */
SELECT '----- SEED: Production.prod.StatusCodes -----' AS Section;

SELECT
    StatusID,
    StatusName
FROM Production.prod.StatusCodes;

SELECT '----- SEED: Production.prod.WorkCentres -----' AS Section;

SELECT
    WorkCentreID,
    ProcessCode,
    WorkCentreName,
    SAPWorkCentre,
    IsActive,
    Notes,
    CONVERT(VARCHAR(23), CreatedAt, 121) AS CreatedAt
FROM Production.prod.WorkCentres;

SELECT '----- SEED: Production.prod.Machines -----' AS Section;

SELECT
    MachineID,
    WorkCentreID,
    MachineCode,
    MachineName,
    IdealOutputPerHour,
    PlannedHoursPerShift,
    IsActive,
    Notes,
    CONVERT(VARCHAR(23), CreatedAt, 121) AS CreatedAt
FROM Production.prod.Machines;

SELECT '----- SEED: Production.prod.Shifts -----' AS Section;

SELECT
    ShiftID,
    ShiftName,
    StartTime,
    EndTime,
    SpansMidnight,
    IsActive
FROM Production.prod.Shifts;

SELECT '----- SEED: Production.prod.ScrapReasons -----' AS Section;

SELECT
    ReasonID,
    ReasonCode,
    ReasonDescription,
    AppliesTo,
    IsActive
FROM Production.prod.ScrapReasons;

