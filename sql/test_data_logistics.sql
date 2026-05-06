/* ============================================================
   Logistics test data — fictitious records for pallet builder
   and picksheet testing.

   Run connected to the Logistics database.
   All inserts are guarded with IF NOT EXISTS so re-running
   this script is safe.
   ============================================================ */

USE Logistics;


/* ── 1. Destinations ─────────────────────────────────────────────────────── */

IF NOT EXISTS (SELECT 1 FROM dbo.Destinations WHERE destinationID = 1001)
    INSERT INTO dbo.Destinations
        (destinationID, destinationName, destinationStreet, destinationCity,
         destinationPostCode, destinationCountry, defaultIncoterms,
         destinationComment, destinationZone)
    VALUES
        (1001, N'Midlands Auto Parts Ltd',    N'14 Industrial Way',    N'Birmingham',    N'B6 4AR',  N'GB', N'DDP', N'Standard UK delivery', N'UK1'),
        (1002, N'Northern Cable Solutions',   N'Forge Lane 22',        N'Sheffield',     N'S9 2TH',  N'GB', N'DDP', N'Weekly consolidated',  N'UK2'),
        (1003, N'AutoTech Coventry Ltd',      N'Whitley Business Pk',  N'Coventry',      N'CV3 4LF', N'GB', N'DDP', NULL,                    N'UK1'),
        (1004, N'Rheinkabel GmbH',            N'Industriestrasse 88',  N'Stuttgart',     N'70565',   N'DE', N'DAP', N'Cross-dock Frankfurt',  N'DE1'),
        (1005, N'Composes Auto SA',           N'Zone Industrielle 4',  N'Lyon',          N'69007',   N'FR', N'DAP', NULL,                    N'FR1');


/* ── 2. PalletData — pallet type definitions ─────────────────────────────── */

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'EU')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'EU', N'Euro Pallet', 25, 1200, 800, 144);

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'CP')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'CP', N'Chemical Pallet', 27, 1200, 1000, 150);

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'HW')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'HW', N'Half-Width Euro', 15, 1200, 600, 144);

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'IS')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'IS', N'Industrial Steel', 38, 1200, 1000, 160);


/* ── 3. PackagingData — packaging type definitions ───────────────────────── */
/* packMaterial = SAP material number for the packaging item itself           */

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'B1')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'B1', N'PKG-BOX-S', N'Cardboard Box Small', 1, 400, 300, 250);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'B2')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'B2', N'PKG-BOX-M', N'Cardboard Box Medium', 2, 600, 400, 300);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'B3')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'B3', N'PKG-BOX-L', N'Cardboard Box Large', 3, 800, 600, 400);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'CR')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'CR', N'PKG-CRAT',  N'Wooden Crate', 12, 1000, 800, 600);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'DR')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'DR', N'PKG-DRUM',  N'Fibre Drum 200L', 8, 580, 580, 890);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'BG')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'BG', N'PKG-BAG',   N'Heavy-Duty Sack', 0, 700, 500, 100);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'TU')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'TU', N'PKG-TUBE',  N'Cardboard Tube / Reel', 1, 1200, 200, 200);


/* ── 4. PalletValidation — allowed packaging per pallet type ─────────────── */

/* EU Pallet: boxes, bags, tubes */
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'EU' AND packagingID = N'B1')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'EU', N'B1');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'EU' AND packagingID = N'B2')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'EU', N'B2');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'EU' AND packagingID = N'B3')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'EU', N'B3');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'EU' AND packagingID = N'BG')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'EU', N'BG');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'EU' AND packagingID = N'TU')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'EU', N'TU');

/* Chemical Pallet: boxes, drums, crates */
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'CP' AND packagingID = N'B1')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'CP', N'B1');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'CP' AND packagingID = N'B2')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'CP', N'B2');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'CP' AND packagingID = N'DR')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'CP', N'DR');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'CP' AND packagingID = N'CR')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'CP', N'CR');

/* Half-Width: small and medium boxes, bags */
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'HW' AND packagingID = N'B1')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'HW', N'B1');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'HW' AND packagingID = N'B2')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'HW', N'B2');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'HW' AND packagingID = N'BG')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'HW', N'BG');

/* Industrial Steel: heavy items only */
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'IS' AND packagingID = N'B3')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'IS', N'B3');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'IS' AND packagingID = N'CR')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'IS', N'CR');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'IS' AND packagingID = N'DR')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'IS', N'DR');


/* ── 5. DeliveryMain — open picksheets ───────────────────────────────────── */
/* Covers all date buckets: overdue (backlog), today, this week, this month   */

IF NOT EXISTS (SELECT 1 FROM dbo.DeliveryMain WHERE deliveryID = 80001)
    INSERT INTO dbo.DeliveryMain
        (deliveryID, customerID, dueDate, completionStatus, operatorName, supervisorName,
         netWeight, grossWeight, palletCount, deliveryVolume,
         picksheetComment, deliveryCancelled, deliveryPriority, deliveryService)
    VALUES
        /* PRIORITY — due yesterday, high priority */
        (80001, 1001, DATEADD(day,-1, CAST(GETDATE() AS date)), 0,
         N'J. Smith', N'R. Patterson', 245, 312, 4, 2.8,
         N'Urgent — line stop risk', 0, 1, N'Express 24hr'),

        /* BACKLOG — 4 days overdue */
        (80002, 1004, DATEADD(day,-4, CAST(GETDATE() AS date)), 0,
         N'C. Wilson', N'R. Patterson', 180, 228, 3, 2.1,
         N'Awaiting packing confirmation', 0, 0, N'Road Freight'),

        /* TODAY */
        (80003, 1002, CAST(GETDATE() AS date), 0,
         N'M. Evans', N'R. Patterson', 92, 118, 2, 1.4,
         NULL, 0, 0, N'Standard 48hr'),

        /* THIS WEEK — 2 days from now */
        (80004, 1003, DATEADD(day, 2, CAST(GETDATE() AS date)), 0,
         N'L. Brown', N'R. Patterson', 560, 648, 8, 6.2,
         N'New customer — label carefully', 0, 0, N'Standard 48hr'),

        /* THIS WEEK */
        (80005, 1005, DATEADD(day, 4, CAST(GETDATE() AS date)), 0,
         N'J. Smith', N'R. Patterson', 310, 385, 5, 3.7,
         NULL, 0, 0, N'Road Freight'),

        /* THIS MONTH */
        (80006, 1001, DATEADD(day,14, CAST(GETDATE() AS date)), 0,
         N'C. Wilson', N'R. Patterson', 720, 840, 10, 8.1,
         N'Part 1 of 2 — see DEL-80007', 0, 0, N'Standard 48hr'),

        (80007, 1001, DATEADD(day,14, CAST(GETDATE() AS date)), 0,
         N'C. Wilson', N'R. Patterson', 480, 556, 7, 5.3,
         N'Part 2 of 2 — see DEL-80006', 0, 0, N'Standard 48hr');


/* ── 6. Example pallets — one finished, one in progress ──────────────────── */
/* Uses variables since palletID is IDENTITY                                   */

DECLARE @palletA BIGINT, @palletB BIGINT;

/* Finished pallet — already on delivery 80003 */
IF NOT EXISTS (
    SELECT 1 FROM dbo.DeliveryLink dl
    JOIN dbo.PalletMain pm ON pm.palletID = dl.palletID
    WHERE dl.deliveryID = 80003 AND pm.palletFinish = 1
)
BEGIN
    INSERT INTO dbo.PalletMain
        (palletType, palletFinish, packagingWeight, grossWeight,
         palletVolume, palletLength, palletWidth, palletHeight,
         palletRemoved, palletCategory, palletLocation,
         palletCreationDate, palletFinishDate)
    VALUES
        (N'EU', 1, 6, 83, 0.346, 1200, 800, 480,
         0, N'A1', N'WH-BAY-04',
         DATEADD(hour,-3, GETDATE()), DATEADD(hour,-1, GETDATE()));

    SET @palletA = SCOPE_IDENTITY();

    INSERT INTO dbo.DeliveryLink (deliveryID, palletID) VALUES (80003, @palletA);

    INSERT INTO dbo.PalletPackages
        (palletID, packagingID, palletLayer, sapMaterial, sapQuantity,
         sapBatch, sapDelivery, sapDeliveryItem, sapCustomer,
         sapCustomerMaterial, scanTime)
    VALUES
        (@palletA, N'B2', 1, N'TCEV9-5B01', 12, N'2026-0042', N'80003', N'000010', N'1002', N'NC-0042-B', DATEADD(minute,-90, GETDATE())),
        (@palletA, N'B2', 1, N'TCEV9-5B02', 8,  N'2026-0043', N'80003', N'000020', N'1002', N'NC-0043-B', DATEADD(minute,-85, GETDATE())),
        (@palletA, N'B1', 2, N'TCEV6-3A01', 24, N'2026-0044', N'80003', N'000030', N'1002', N'NC-0044-A', DATEADD(minute,-80, GETDATE()));
END;

/* In-progress pallet — partially built on delivery 80001 */
IF NOT EXISTS (
    SELECT 1 FROM dbo.DeliveryLink dl
    JOIN dbo.PalletMain pm ON pm.palletID = dl.palletID
    WHERE dl.deliveryID = 80001 AND pm.palletFinish = 0
)
BEGIN
    INSERT INTO dbo.PalletMain
        (palletType, palletFinish, packagingWeight, grossWeight,
         palletVolume, palletLength, palletWidth, palletHeight,
         palletRemoved, palletCategory, palletLocation,
         palletCreationDate, palletFinishDate)
    VALUES
        (N'EU', 0, 4, 54, 0, 1200, 800, 144,
         0, N'A1', N'WH-BAY-01',
         DATEADD(hour,-1, GETDATE()), NULL);

    SET @palletB = SCOPE_IDENTITY();

    INSERT INTO dbo.DeliveryLink (deliveryID, palletID) VALUES (80001, @palletB);

    INSERT INTO dbo.PalletPackages
        (palletID, packagingID, palletLayer, sapMaterial, sapQuantity,
         sapBatch, sapDelivery, sapDeliveryItem, sapCustomer,
         sapCustomerMaterial, scanTime)
    VALUES
        (@palletB, N'B3', 1, N'KABS-7701A', 6, N'2026-0051', N'80001', N'000010', N'1001', N'MAP-A-7701', DATEADD(minute,-50, GETDATE())),
        (@palletB, N'B3', 1, N'KABS-7701B', 6, N'2026-0051', N'80001', N'000020', N'1001', N'MAP-A-7701', DATEADD(minute,-45, GETDATE()));
END;


/* ── Verify ──────────────────────────────────────────────────────────────── */
SELECT 'PalletData'      AS Section, COUNT(*) AS Rows FROM dbo.PalletData
UNION ALL
SELECT 'PackagingData',              COUNT(*)         FROM dbo.PackagingData
UNION ALL
SELECT 'PalletValidation',           COUNT(*)         FROM dbo.PalletValidation
UNION ALL
SELECT 'Destinations',               COUNT(*)         FROM dbo.Destinations
UNION ALL
SELECT 'DeliveryMain (open)',        COUNT(*)         FROM dbo.DeliveryMain WHERE completionStatus = 0 AND deliveryCancelled = 0
UNION ALL
SELECT 'PalletMain',                 COUNT(*)         FROM dbo.PalletMain
UNION ALL
SELECT 'PalletPackages',             COUNT(*)         FROM dbo.PalletPackages
UNION ALL
SELECT 'DeliveryLink',               COUNT(*)         FROM dbo.DeliveryLink;
