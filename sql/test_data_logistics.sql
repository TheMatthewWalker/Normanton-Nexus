/* ============================================================
   Logistics test data.
   Run AFTER migrate_logistics_pallets.sql.

   SQL Server 2005 compatible — one VALUES row per INSERT.
   ============================================================ */

USE Logistics;


/* ── PackagingData ───────────────────────────────────────────────────────── */

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'SD')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'SD', N'Drum', N'Small Drum', 3, 50, 50, 33);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'MD')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'MD', N'Drum', N'Medium Drum', 7, 75, 75, 33);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'LD')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'LD', N'Drum', N'Large Drum', 12, 85, 85, 50);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'XL')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'XL', N'Drum', N'Extra Large Drum', 17, 100, 100, 50);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'XXL')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'XXL', N'Drum', N'XXL Drum', 22, NULL, NULL, NULL);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'SB')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'SB', N'Cardboard', N'Small Pallet Box', 1, 120, 80, 25);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'MB')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'MB', N'Cardboard', N'Medium Pallet Box', 1, 120, 80, 65);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'LB')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'LB', N'Cardboard', N'Large Pallet Box', 1, 120, 80, 85);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'XB')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'XB', N'Cardboard', N'Pizza Box', 2, 240, 25, 240);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'CB')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'CB', N'Cardboard', N'Coffin Box', 1, 240, 120, NULL);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'C1')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'C1', N'Cardboard', N'60x60x25cm Box', 0.5, 60, 60, 25);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'C2')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'C2', N'Cardboard', N'30x20x15cm Box', 0.5, 30, 20, 15);

IF NOT EXISTS (SELECT 1 FROM dbo.PackagingData WHERE packID = N'C3')
    INSERT INTO dbo.PackagingData (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
    VALUES (N'C3', N'Cardboard', N'Custom Box', 0.5, NULL, NULL, NULL);


/* ── PalletData ──────────────────────────────────────────────────────────── */

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'PH')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'PH', N'Half Pallet', 10, 80, 60, 15);

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'P8')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'P8', N'800ml Pallet', 10, 80, 80, 15);

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'PE')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'PE', N'Euro Pallet', 20, 120, 80, 15);

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'PS')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'PS', N'Standard Pallet', 15, 120, 100, 15);

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'PC')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'PC', N'Coffin Pallet', 15, 240, 120, 15);

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'ST')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'ST', N'Stillage', 250, 250, 60, 50);

IF NOT EXISTS (SELECT 1 FROM dbo.PalletData WHERE palletID = N'GE')
    INSERT INTO dbo.PalletData (palletID, palletDescription, palletWeight, palletLength, palletWidth, palletHeight)
    VALUES (N'GE', N'Gefco', 35, 120, 80, 60);


/* ── PalletValidation ────────────────────────────────────────────────────── */

/* P8 */
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'P8' AND packagingID = N'SD')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'P8', N'SD');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'P8' AND packagingID = N'MD')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'P8', N'MD');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'P8' AND packagingID = N'LD')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'P8', N'LD');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'P8' AND packagingID = N'C1')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'P8', N'C1');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'P8' AND packagingID = N'C2')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'P8', N'C2');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'P8' AND packagingID = N'C3')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'P8', N'C3');

/* PE */
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'SD')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'SD');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'MD')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'MD');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'LD')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'LD');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'XL')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'XL');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'SB')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'SB');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'MB')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'MB');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'LB')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'LB');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'C1')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'C1');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'C2')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'C2');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PE' AND packagingID = N'C3')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PE', N'C3');

/* PS */
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'SD')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'SD');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'MD')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'MD');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'LD')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'LD');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'XL')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'XL');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'XXL')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'XXL');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'SB')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'SB');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'MB')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'MB');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'LB')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'LB');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'C1')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'C1');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'C2')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'C2');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PS' AND packagingID = N'C3')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PS', N'C3');

/* PC */
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PC' AND packagingID = N'XB')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PC', N'XB');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PC' AND packagingID = N'CB')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PC', N'CB');
IF NOT EXISTS (SELECT 1 FROM dbo.PalletValidation WHERE palletID = N'PC' AND packagingID = N'C3')
    INSERT INTO dbo.PalletValidation (palletID, packagingID) VALUES (N'PC', N'C3');

/* ST and GE — no packaging restrictions defined */


/* ── Destinations ────────────────────────────────────────────────────────── */

IF NOT EXISTS (SELECT 1 FROM dbo.Destinations WHERE destinationID = 1001)
    INSERT INTO dbo.Destinations (destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, defaultIncoterms, destinationComment, destinationZone)
    VALUES (1001, N'Midlands Auto Parts Ltd', N'14 Industrial Way', N'Birmingham', N'B6 4AR', N'GB', N'DDP', N'Standard UK delivery', N'UK1');

IF NOT EXISTS (SELECT 1 FROM dbo.Destinations WHERE destinationID = 1002)
    INSERT INTO dbo.Destinations (destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, defaultIncoterms, destinationComment, destinationZone)
    VALUES (1002, N'Northern Cable Solutions', N'Forge Lane 22', N'Sheffield', N'S9 2TH', N'GB', N'DDP', N'Weekly consolidated', N'UK2');

IF NOT EXISTS (SELECT 1 FROM dbo.Destinations WHERE destinationID = 1003)
    INSERT INTO dbo.Destinations (destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, defaultIncoterms, destinationComment, destinationZone)
    VALUES (1003, N'AutoTech Coventry Ltd', N'Whitley Business Pk', N'Coventry', N'CV3 4LF', N'GB', N'DDP', NULL, N'UK1');

IF NOT EXISTS (SELECT 1 FROM dbo.Destinations WHERE destinationID = 1004)
    INSERT INTO dbo.Destinations (destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, defaultIncoterms, destinationComment, destinationZone)
    VALUES (1004, N'Rheinkabel GmbH', N'Industriestrasse 88', N'Stuttgart', N'70565', N'DE', N'DAP', N'Cross-dock Frankfurt', N'DE1');

IF NOT EXISTS (SELECT 1 FROM dbo.Destinations WHERE destinationID = 1005)
    INSERT INTO dbo.Destinations (destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, defaultIncoterms, destinationComment, destinationZone)
    VALUES (1005, N'Composes Auto SA', N'Zone Industrielle 4', N'Lyon', N'69007', N'FR', N'DAP', NULL, N'FR1');


/* ── DeliveryMain — open picksheets ───────────────────────────────────────── */

IF NOT EXISTS (SELECT 1 FROM dbo.DeliveryMain WHERE deliveryID = 80001)
    INSERT INTO dbo.DeliveryMain (deliveryID, customerID, dueDate, completionStatus, operatorName, supervisorName, netWeight, grossWeight, palletCount, deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority, deliveryService)
    VALUES (80001, 1001, DATEADD(day, -1, CAST(GETDATE() AS date)), 0, N'J. Smith', N'R. Patterson', 245, 312, 4, 2.8, N'Urgent — line stop risk', 0, 1, N'Express 24hr');

IF NOT EXISTS (SELECT 1 FROM dbo.DeliveryMain WHERE deliveryID = 80002)
    INSERT INTO dbo.DeliveryMain (deliveryID, customerID, dueDate, completionStatus, operatorName, supervisorName, netWeight, grossWeight, palletCount, deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority, deliveryService)
    VALUES (80002, 1004, DATEADD(day, -4, CAST(GETDATE() AS date)), 0, N'C. Wilson', N'R. Patterson', 180, 228, 3, 2.1, N'Awaiting packing confirmation', 0, 0, N'Road Freight');

IF NOT EXISTS (SELECT 1 FROM dbo.DeliveryMain WHERE deliveryID = 80003)
    INSERT INTO dbo.DeliveryMain (deliveryID, customerID, dueDate, completionStatus, operatorName, supervisorName, netWeight, grossWeight, palletCount, deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority, deliveryService)
    VALUES (80003, 1002, CAST(GETDATE() AS date), 0, N'M. Evans', N'R. Patterson', 92, 118, 2, 1.4, NULL, 0, 0, N'Standard 48hr');

IF NOT EXISTS (SELECT 1 FROM dbo.DeliveryMain WHERE deliveryID = 80004)
    INSERT INTO dbo.DeliveryMain (deliveryID, customerID, dueDate, completionStatus, operatorName, supervisorName, netWeight, grossWeight, palletCount, deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority, deliveryService)
    VALUES (80004, 1003, DATEADD(day, 2, CAST(GETDATE() AS date)), 0, N'L. Brown', N'R. Patterson', 560, 648, 8, 6.2, N'New customer — label carefully', 0, 0, N'Standard 48hr');

IF NOT EXISTS (SELECT 1 FROM dbo.DeliveryMain WHERE deliveryID = 80005)
    INSERT INTO dbo.DeliveryMain (deliveryID, customerID, dueDate, completionStatus, operatorName, supervisorName, netWeight, grossWeight, palletCount, deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority, deliveryService)
    VALUES (80005, 1005, DATEADD(day, 4, CAST(GETDATE() AS date)), 0, N'J. Smith', N'R. Patterson', 310, 385, 5, 3.7, NULL, 0, 0, N'Road Freight');

IF NOT EXISTS (SELECT 1 FROM dbo.DeliveryMain WHERE deliveryID = 80006)
    INSERT INTO dbo.DeliveryMain (deliveryID, customerID, dueDate, completionStatus, operatorName, supervisorName, netWeight, grossWeight, palletCount, deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority, deliveryService)
    VALUES (80006, 1001, DATEADD(day, 14, CAST(GETDATE() AS date)), 0, N'C. Wilson', N'R. Patterson', 720, 840, 10, 8.1, N'Part 1 of 2 — see 80007', 0, 0, N'Standard 48hr');

IF NOT EXISTS (SELECT 1 FROM dbo.DeliveryMain WHERE deliveryID = 80007)
    INSERT INTO dbo.DeliveryMain (deliveryID, customerID, dueDate, completionStatus, operatorName, supervisorName, netWeight, grossWeight, palletCount, deliveryVolume, picksheetComment, deliveryCancelled, deliveryPriority, deliveryService)
    VALUES (80007, 1001, DATEADD(day, 14, CAST(GETDATE() AS date)), 0, N'C. Wilson', N'R. Patterson', 480, 556, 7, 5.3, N'Part 2 of 2 — see 80006', 0, 0, N'Standard 48hr');


/* ── Verify ──────────────────────────────────────────────────────────────── */

SELECT 'PackagingData'    AS Section, COUNT(*) AS Rows FROM dbo.PackagingData;
SELECT 'PalletData',                  COUNT(*)         FROM dbo.PalletData;
SELECT 'PalletValidation',            COUNT(*)         FROM dbo.PalletValidation;
SELECT 'Destinations',                COUNT(*)         FROM dbo.Destinations;
SELECT 'DeliveryMain (open)',         COUNT(*)
    FROM dbo.DeliveryMain WHERE completionStatus = 0 AND deliveryCancelled = 0;
