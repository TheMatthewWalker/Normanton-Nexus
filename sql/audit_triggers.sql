-- ============================================================
-- DataChangeLog — SQL audit triggers for all mutating operations
-- SQL Server 2005 compatible
-- Run entire script as-is; it is idempotent (drops + recreates).
-- ============================================================

USE kongsberg;
GO

-- ── 1. DataChangeLog table ────────────────────────────────────────────────────
IF OBJECT_ID('kongsberg.dbo.DataChangeLog', 'U') IS NULL
BEGIN
  CREATE TABLE kongsberg.dbo.DataChangeLog (
    LogID       BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    TableName   NVARCHAR(100)  NOT NULL,
    Operation   NCHAR(6)       NOT NULL,   -- INSERT / UPDATE / DELETE
    RecordKey   NVARCHAR(100)  NULL,       -- Primary key value(s)
    Detail      NVARCHAR(2000) NULL,       -- Before→after summary
    ChangedAt   DATETIME       NOT NULL DEFAULT GETDATE(),
    DBUser      NVARCHAR(128)  NULL        -- SQL Server login (app user)
  );
END
GO


-- ============================================================
-- Logistics.dbo triggers
-- ============================================================

-- ── ShipmentMain ──────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_ShipmentMain_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ShipmentMain_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_ShipmentMain_INS ON Logistics.dbo.ShipmentMain AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT
    'ShipmentMain', 'INSERT',
    CAST(i.shipmentID AS NVARCHAR(20)),
    'ref=' + ISNULL(i.shipmentRef, 'null')
    + ' | forwarder=' + ISNULL(CAST(i.forwarderID AS NVARCHAR(20)), 'null')
    + ' | dest=' + ISNULL(CAST(i.destinationID AS NVARCHAR(20)), 'null')
    + ' | customsReq=' + CAST(ISNULL(i.customsRequired, 0) AS NVARCHAR(1)),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_ShipmentMain_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ShipmentMain_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_ShipmentMain_UPD ON Logistics.dbo.ShipmentMain AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT
    'ShipmentMain', 'UPDATE',
    CAST(i.shipmentID AS NVARCHAR(20)),
    -- Detect and report only the fields that actually changed
    CASE WHEN ISNULL(CAST(i.customsComplete  AS INT),0) != ISNULL(CAST(d.customsComplete  AS INT),0)
         THEN 'customsComplete: '   + CAST(ISNULL(d.customsComplete,0)  AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.customsComplete,0)  AS NVARCHAR(1)) + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CAST(i.customsRequired  AS INT),0) != ISNULL(CAST(d.customsRequired  AS INT),0)
         THEN 'customsRequired: '   + CAST(ISNULL(d.customsRequired,0)  AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.customsRequired,0)  AS NVARCHAR(1)) + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CAST(i.shipmentCancelled AS INT),0) != ISNULL(CAST(d.shipmentCancelled AS INT),0)
         THEN 'shipmentCancelled: ' + CAST(ISNULL(d.shipmentCancelled,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.shipmentCancelled,0) AS NVARCHAR(1)) + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.forwarderID, -1) != ISNULL(d.forwarderID, -1)
         THEN 'forwarderID: '   + ISNULL(CAST(d.forwarderID AS NVARCHAR(20)),'null') + N'→' + ISNULL(CAST(i.forwarderID AS NVARCHAR(20)),'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.destinationID, -1) != ISNULL(d.destinationID, -1)
         THEN 'destinationID: ' + ISNULL(CAST(d.destinationID AS NVARCHAR(20)),'null') + N'→' + ISNULL(CAST(i.destinationID AS NVARCHAR(20)),'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.serviceModeID, -1) != ISNULL(d.serviceModeID, -1)
         THEN 'serviceModeID: ' + ISNULL(CAST(d.serviceModeID AS NVARCHAR(20)),'null') + N'→' + ISNULL(CAST(i.serviceModeID AS NVARCHAR(20)),'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CONVERT(NVARCHAR(20), d.plannedCollection, 120),'') != ISNULL(CONVERT(NVARCHAR(20), i.plannedCollection, 120),'')
         THEN 'plannedCollection: ' + ISNULL(CONVERT(NVARCHAR(20),d.plannedCollection,120),'null') + N'→' + ISNULL(CONVERT(NVARCHAR(20),i.plannedCollection,120),'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CONVERT(NVARCHAR(20), d.plannedDelivery, 120),'') != ISNULL(CONVERT(NVARCHAR(20), i.plannedDelivery, 120),'')
         THEN 'plannedDelivery: ' + ISNULL(CONVERT(NVARCHAR(20),d.plannedDelivery,120),'null') + N'→' + ISNULL(CONVERT(NVARCHAR(20),i.plannedDelivery,120),'null') + ' | ' ELSE '' END,
    SYSTEM_USER
  FROM INSERTED i
  JOIN DELETED d ON i.shipmentID = d.shipmentID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_ShipmentMain_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ShipmentMain_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_ShipmentMain_DEL ON Logistics.dbo.ShipmentMain AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ShipmentMain', 'DELETE', CAST(d.shipmentID AS NVARCHAR(20)),
    'ref=' + ISNULL(d.shipmentRef,'null'), SYSTEM_USER
  FROM DELETED d;
END
GO

-- ── ShipmentLink ──────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_ShipmentLink_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ShipmentLink_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_ShipmentLink_INS ON Logistics.dbo.ShipmentLink AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ShipmentLink', 'INSERT',
    'S' + CAST(i.shipmentID AS NVARCHAR(20)) + '/D' + CAST(i.deliveryID AS NVARCHAR(20)),
    'shipmentID=' + CAST(i.shipmentID AS NVARCHAR(20)) + ' | deliveryID=' + CAST(i.deliveryID AS NVARCHAR(20)),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_ShipmentLink_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ShipmentLink_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_ShipmentLink_DEL ON Logistics.dbo.ShipmentLink AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ShipmentLink', 'DELETE',
    'S' + CAST(d.shipmentID AS NVARCHAR(20)) + '/D' + CAST(d.deliveryID AS NVARCHAR(20)),
    'shipmentID=' + CAST(d.shipmentID AS NVARCHAR(20)) + ' | deliveryID=' + CAST(d.deliveryID AS NVARCHAR(20)),
    SYSTEM_USER
  FROM DELETED d;
END
GO

-- ── ShipmentCost ──────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_ShipmentCost_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ShipmentCost_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_ShipmentCost_INS ON Logistics.dbo.ShipmentCost AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ShipmentCost', 'INSERT',
    CAST(i.shipmentCostID AS NVARCHAR(20)),
    'shipmentID=' + CAST(i.shipmentID AS NVARCHAR(20))
    + ' | costTypeID=' + ISNULL(CAST(i.costTypeID AS NVARCHAR(20)),'null')
    + ' | amount=' + ISNULL(CAST(i.amount AS NVARCHAR(20)),'null'),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_ShipmentCost_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ShipmentCost_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_ShipmentCost_UPD ON Logistics.dbo.ShipmentCost AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ShipmentCost', 'UPDATE', CAST(i.shipmentCostID AS NVARCHAR(20)),
    'amount: ' + ISNULL(CAST(d.amount AS NVARCHAR(20)),'null') + N'→' + ISNULL(CAST(i.amount AS NVARCHAR(20)),'null'),
    SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.shipmentCostID = d.shipmentCostID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_ShipmentCost_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ShipmentCost_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_ShipmentCost_DEL ON Logistics.dbo.ShipmentCost AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ShipmentCost', 'DELETE', CAST(d.shipmentCostID AS NVARCHAR(20)),
    'shipmentID=' + CAST(d.shipmentID AS NVARCHAR(20)) + ' | amount=' + ISNULL(CAST(d.amount AS NVARCHAR(20)),'null'),
    SYSTEM_USER
  FROM DELETED d;
END
GO

-- ── DeliveryMain ──────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_DeliveryMain_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_DeliveryMain_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_DeliveryMain_INS ON Logistics.dbo.DeliveryMain AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'DeliveryMain', 'INSERT', CAST(i.deliveryID AS NVARCHAR(20)),
    'customerID=' + ISNULL(CAST(i.customerID AS NVARCHAR(20)),'null')
    + ' | grossWeight=' + ISNULL(CAST(i.grossWeight AS NVARCHAR(20)),'null'),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_DeliveryMain_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_DeliveryMain_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_DeliveryMain_UPD ON Logistics.dbo.DeliveryMain AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'DeliveryMain', 'UPDATE', CAST(i.deliveryID AS NVARCHAR(20)),
    CASE WHEN ISNULL(i.grossWeight,-1) != ISNULL(d.grossWeight,-1)
         THEN 'grossWeight: ' + ISNULL(CAST(d.grossWeight AS NVARCHAR(20)),'null') + N'→' + ISNULL(CAST(i.grossWeight AS NVARCHAR(20)),'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.deliveryService,'') != ISNULL(d.deliveryService,'')
         THEN 'deliveryService: ' + ISNULL(d.deliveryService,'null') + N'→' + ISNULL(i.deliveryService,'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CAST(i.pickComplete AS INT),0) != ISNULL(CAST(d.pickComplete AS INT),0)
         THEN 'pickComplete: ' + CAST(ISNULL(d.pickComplete,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.pickComplete,0) AS NVARCHAR(1)) + ' | ' ELSE '' END,
    SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.deliveryID = d.deliveryID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_DeliveryMain_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_DeliveryMain_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_DeliveryMain_DEL ON Logistics.dbo.DeliveryMain AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'DeliveryMain', 'DELETE', CAST(d.deliveryID AS NVARCHAR(20)),
    'customerID=' + ISNULL(CAST(d.customerID AS NVARCHAR(20)),'null'), SYSTEM_USER
  FROM DELETED d;
END
GO

-- ── DeliveryLink ──────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_DeliveryLink_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_DeliveryLink_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_DeliveryLink_INS ON Logistics.dbo.DeliveryLink AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'DeliveryLink', 'INSERT',
    'D' + CAST(i.deliveryID AS NVARCHAR(20)) + '/P' + CAST(i.palletID AS NVARCHAR(20)),
    'deliveryID=' + CAST(i.deliveryID AS NVARCHAR(20)) + ' | palletID=' + CAST(i.palletID AS NVARCHAR(20)),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_DeliveryLink_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_DeliveryLink_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_DeliveryLink_DEL ON Logistics.dbo.DeliveryLink AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'DeliveryLink', 'DELETE',
    'D' + CAST(d.deliveryID AS NVARCHAR(20)) + '/P' + CAST(d.palletID AS NVARCHAR(20)),
    'deliveryID=' + CAST(d.deliveryID AS NVARCHAR(20)) + ' | palletID=' + CAST(d.palletID AS NVARCHAR(20)),
    SYSTEM_USER
  FROM DELETED d;
END
GO

-- ── PalletMain ────────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_PalletMain_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PalletMain_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_PalletMain_INS ON Logistics.dbo.PalletMain AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'PalletMain', 'INSERT', CAST(i.palletID AS NVARCHAR(20)),
    'type=' + ISNULL(i.palletType,'null')
    + ' | gross=' + ISNULL(CAST(i.grossWeight AS NVARCHAR(20)),'null')
    + ' | finish=' + ISNULL(CAST(i.palletFinish AS NVARCHAR(1)),'null'),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_PalletMain_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PalletMain_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_PalletMain_UPD ON Logistics.dbo.PalletMain AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'PalletMain', 'UPDATE', CAST(i.palletID AS NVARCHAR(20)),
    CASE WHEN ISNULL(CAST(i.palletFinish AS INT),0) != ISNULL(CAST(d.palletFinish AS INT),0)
         THEN 'palletFinish: ' + CAST(ISNULL(d.palletFinish,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.palletFinish,0) AS NVARCHAR(1)) + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CAST(i.palletRemoved AS INT),0) != ISNULL(CAST(d.palletRemoved AS INT),0)
         THEN 'palletRemoved: ' + CAST(ISNULL(d.palletRemoved,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.palletRemoved,0) AS NVARCHAR(1)) + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.grossWeight,-1) != ISNULL(d.grossWeight,-1)
         THEN 'grossWeight: ' + ISNULL(CAST(d.grossWeight AS NVARCHAR(20)),'null') + N'→' + ISNULL(CAST(i.grossWeight AS NVARCHAR(20)),'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.palletLocation,'') != ISNULL(d.palletLocation,'')
         THEN 'location: ' + ISNULL(d.palletLocation,'null') + N'→' + ISNULL(i.palletLocation,'null') + ' | ' ELSE '' END,
    SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.palletID = d.palletID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_PalletMain_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PalletMain_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_PalletMain_DEL ON Logistics.dbo.PalletMain AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'PalletMain', 'DELETE', CAST(d.palletID AS NVARCHAR(20)),
    'type=' + ISNULL(d.palletType,'null') + ' | gross=' + ISNULL(CAST(d.grossWeight AS NVARCHAR(20)),'null'),
    SYSTEM_USER
  FROM DELETED d;
END
GO

-- ── PalletPackages ────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_PalletPackages_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PalletPackages_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_PalletPackages_INS ON Logistics.dbo.PalletPackages AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'PalletPackages', 'INSERT', CAST(i.palletItemID AS NVARCHAR(20)),
    'palletID=' + CAST(i.palletID AS NVARCHAR(20)) + ' | packagingID=' + ISNULL(CAST(i.packagingID AS NVARCHAR(20)),'null'),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_PalletPackages_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PalletPackages_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_PalletPackages_DEL ON Logistics.dbo.PalletPackages AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'PalletPackages', 'DELETE', CAST(d.palletItemID AS NVARCHAR(20)),
    'palletID=' + CAST(d.palletID AS NVARCHAR(20)) + ' | packagingID=' + ISNULL(CAST(d.packagingID AS NVARCHAR(20)),'null'),
    SYSTEM_USER
  FROM DELETED d;
END
GO

-- ── Destinations ──────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_Destinations_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_Destinations_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_Destinations_INS ON Logistics.dbo.Destinations AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'Destinations', 'INSERT', CAST(i.destinationID AS NVARCHAR(20)),
    'name=' + ISNULL(i.destinationName,'null') + ' | country=' + ISNULL(i.destinationCountry,'null'), SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_Destinations_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_Destinations_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_Destinations_UPD ON Logistics.dbo.Destinations AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'Destinations', 'UPDATE', CAST(i.destinationID AS NVARCHAR(20)),
    CASE WHEN ISNULL(i.destinationName,'') != ISNULL(d.destinationName,'')
         THEN 'name: ' + ISNULL(d.destinationName,'null') + N'→' + ISNULL(i.destinationName,'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.destinationCountry,'') != ISNULL(d.destinationCountry,'')
         THEN 'country: ' + ISNULL(d.destinationCountry,'null') + N'→' + ISNULL(i.destinationCountry,'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.defaultIncoterms,'') != ISNULL(d.defaultIncoterms,'')
         THEN 'incoterms: ' + ISNULL(d.defaultIncoterms,'null') + N'→' + ISNULL(i.defaultIncoterms,'null') + ' | ' ELSE '' END,
    SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.destinationID = d.destinationID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_Destinations_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_Destinations_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_Destinations_DEL ON Logistics.dbo.Destinations AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'Destinations', 'DELETE', CAST(d.destinationID AS NVARCHAR(20)),
    'name=' + ISNULL(d.destinationName,'null'), SYSTEM_USER
  FROM DELETED d;
END
GO

-- ── Forwarders ────────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_Forwarders_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_Forwarders_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_Forwarders_INS ON Logistics.dbo.Forwarders AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'Forwarders', 'INSERT', CAST(i.forwarderID AS NVARCHAR(20)),
    'name=' + ISNULL(i.forwarderName,'null') + ' | approval=' + CAST(ISNULL(i.forwarderApproval,0) AS NVARCHAR(1)),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_Forwarders_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_Forwarders_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_Forwarders_UPD ON Logistics.dbo.Forwarders AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'Forwarders', 'UPDATE', CAST(i.forwarderID AS NVARCHAR(20)),
    CASE WHEN ISNULL(i.forwarderName,'') != ISNULL(d.forwarderName,'')
         THEN 'name: ' + ISNULL(d.forwarderName,'null') + N'→' + ISNULL(i.forwarderName,'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CAST(i.forwarderApproval AS INT),0) != ISNULL(CAST(d.forwarderApproval AS INT),0)
         THEN 'approval: ' + CAST(ISNULL(d.forwarderApproval,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.forwarderApproval,0) AS NVARCHAR(1)) + ' | ' ELSE '' END,
    SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.forwarderID = d.forwarderID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_Forwarders_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_Forwarders_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_Forwarders_DEL ON Logistics.dbo.Forwarders AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'Forwarders', 'DELETE', CAST(d.forwarderID AS NVARCHAR(20)),
    'name=' + ISNULL(d.forwarderName,'null'), SYSTEM_USER
  FROM DELETED d;
END
GO

-- ── ForwarderApproval ─────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_ForwarderApproval_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ForwarderApproval_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_ForwarderApproval_INS ON Logistics.dbo.ForwarderApproval AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ForwarderApproval', 'INSERT', CAST(i.approvalID AS NVARCHAR(20)),
    'forwarderID=' + ISNULL(CAST(i.forwarderID AS NVARCHAR(20)),'null')
    + ' | shipmentID=' + ISNULL(CAST(i.shipmentID AS NVARCHAR(20)),'null'),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_ForwarderApproval_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ForwarderApproval_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_ForwarderApproval_UPD ON Logistics.dbo.ForwarderApproval AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ForwarderApproval', 'UPDATE', CAST(i.approvalID AS NVARCHAR(20)),
    'updated (key fields changed)', SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.approvalID = d.approvalID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_ForwarderApproval_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_ForwarderApproval_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_ForwarderApproval_DEL ON Logistics.dbo.ForwarderApproval AFTER DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ForwarderApproval', 'DELETE', CAST(d.approvalID AS NVARCHAR(20)), '', SYSTEM_USER FROM DELETED d;
END
GO

-- ── RatesKN ───────────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_RatesKN_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_RatesKN_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_RatesKN_INS ON Logistics.dbo.RatesKN AFTER INSERT AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'RatesKN', 'INSERT', CAST(i.rateKNID AS NVARCHAR(20)), 'row inserted', SYSTEM_USER FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_RatesKN_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_RatesKN_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_RatesKN_UPD ON Logistics.dbo.RatesKN AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'RatesKN', 'UPDATE', CAST(i.rateKNID AS NVARCHAR(20)), 'row updated', SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.rateKNID = d.rateKNID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_RatesKN_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_RatesKN_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_RatesKN_DEL ON Logistics.dbo.RatesKN AFTER DELETE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'RatesKN', 'DELETE', CAST(d.rateKNID AS NVARCHAR(20)), 'row deleted', SYSTEM_USER FROM DELETED d;
END
GO

-- ── RatesTPN ──────────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_RatesTPN_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_RatesTPN_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_RatesTPN_INS ON Logistics.dbo.RatesTPN AFTER INSERT AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'RatesTPN', 'INSERT', CAST(i.rateTPNID AS NVARCHAR(20)), 'row inserted', SYSTEM_USER FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_RatesTPN_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_RatesTPN_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_RatesTPN_UPD ON Logistics.dbo.RatesTPN AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'RatesTPN', 'UPDATE', CAST(i.rateTPNID AS NVARCHAR(20)), 'row updated', SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.rateTPNID = d.rateTPNID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_RatesTPN_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_RatesTPN_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_RatesTPN_DEL ON Logistics.dbo.RatesTPN AFTER DELETE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'RatesTPN', 'DELETE', CAST(d.rateTPNID AS NVARCHAR(20)), 'row deleted', SYSTEM_USER FROM DELETED d;
END
GO

-- ── AssignmentTPN ─────────────────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_AssignmentTPN_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_AssignmentTPN_INS;
GO
CREATE TRIGGER Logistics.dbo.trg_AssignmentTPN_INS ON Logistics.dbo.AssignmentTPN AFTER INSERT AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'AssignmentTPN', 'INSERT', CAST(i.assignmentTPNID AS NVARCHAR(20)), 'row inserted', SYSTEM_USER FROM INSERTED i;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_AssignmentTPN_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_AssignmentTPN_UPD;
GO
CREATE TRIGGER Logistics.dbo.trg_AssignmentTPN_UPD ON Logistics.dbo.AssignmentTPN AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'AssignmentTPN', 'UPDATE', CAST(i.assignmentTPNID AS NVARCHAR(20)), 'row updated', SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.assignmentTPNID = d.assignmentTPNID;
END
GO

IF OBJECT_ID('Logistics.dbo.trg_AssignmentTPN_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_AssignmentTPN_DEL;
GO
CREATE TRIGGER Logistics.dbo.trg_AssignmentTPN_DEL ON Logistics.dbo.AssignmentTPN AFTER DELETE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'AssignmentTPN', 'DELETE', CAST(d.assignmentTPNID AS NVARCHAR(20)), 'row deleted', SYSTEM_USER FROM DELETED d;
END
GO

-- ── CostTypes / CostElements / CostCenters / Incoterms ───────────────────────
-- These are reference/lookup tables — log insert/update/delete with generic detail.

IF OBJECT_ID('Logistics.dbo.trg_CostTypes_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_CostTypes_INS; GO
CREATE TRIGGER Logistics.dbo.trg_CostTypes_INS ON Logistics.dbo.CostTypes AFTER INSERT AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'CostTypes','INSERT',CAST(i.costTypeID AS NVARCHAR(20)),ISNULL(i.costTypeName,''),SYSTEM_USER FROM INSERTED i; END
GO
IF OBJECT_ID('Logistics.dbo.trg_CostTypes_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_CostTypes_UPD; GO
CREATE TRIGGER Logistics.dbo.trg_CostTypes_UPD ON Logistics.dbo.CostTypes AFTER UPDATE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'CostTypes','UPDATE',CAST(i.costTypeID AS NVARCHAR(20)),'name: '+ISNULL(d.costTypeName,'null')+N'→'+ISNULL(i.costTypeName,'null'),SYSTEM_USER FROM INSERTED i JOIN DELETED d ON i.costTypeID=d.costTypeID; END
GO
IF OBJECT_ID('Logistics.dbo.trg_CostTypes_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_CostTypes_DEL; GO
CREATE TRIGGER Logistics.dbo.trg_CostTypes_DEL ON Logistics.dbo.CostTypes AFTER DELETE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'CostTypes','DELETE',CAST(d.costTypeID AS NVARCHAR(20)),ISNULL(d.costTypeName,''),SYSTEM_USER FROM DELETED d; END
GO

IF OBJECT_ID('Logistics.dbo.trg_CostElements_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_CostElements_INS; GO
CREATE TRIGGER Logistics.dbo.trg_CostElements_INS ON Logistics.dbo.CostElements AFTER INSERT AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'CostElements','INSERT',CAST(i.costElementID AS NVARCHAR(20)),ISNULL(i.costElementName,''),SYSTEM_USER FROM INSERTED i; END
GO
IF OBJECT_ID('Logistics.dbo.trg_CostElements_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_CostElements_UPD; GO
CREATE TRIGGER Logistics.dbo.trg_CostElements_UPD ON Logistics.dbo.CostElements AFTER UPDATE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'CostElements','UPDATE',CAST(i.costElementID AS NVARCHAR(20)),'name: '+ISNULL(d.costElementName,'null')+N'→'+ISNULL(i.costElementName,'null'),SYSTEM_USER FROM INSERTED i JOIN DELETED d ON i.costElementID=d.costElementID; END
GO
IF OBJECT_ID('Logistics.dbo.trg_CostElements_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_CostElements_DEL; GO
CREATE TRIGGER Logistics.dbo.trg_CostElements_DEL ON Logistics.dbo.CostElements AFTER DELETE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'CostElements','DELETE',CAST(d.costElementID AS NVARCHAR(20)),ISNULL(d.costElementName,''),SYSTEM_USER FROM DELETED d; END
GO

IF OBJECT_ID('Logistics.dbo.trg_CostCenters_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_CostCenters_INS; GO
CREATE TRIGGER Logistics.dbo.trg_CostCenters_INS ON Logistics.dbo.CostCenters AFTER INSERT AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'CostCenters','INSERT',CAST(i.costCenterID AS NVARCHAR(20)),ISNULL(i.costCenterName,''),SYSTEM_USER FROM INSERTED i; END
GO
IF OBJECT_ID('Logistics.dbo.trg_CostCenters_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_CostCenters_UPD; GO
CREATE TRIGGER Logistics.dbo.trg_CostCenters_UPD ON Logistics.dbo.CostCenters AFTER UPDATE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'CostCenters','UPDATE',CAST(i.costCenterID AS NVARCHAR(20)),'row updated',SYSTEM_USER FROM INSERTED i JOIN DELETED d ON i.costCenterID=d.costCenterID; END
GO
IF OBJECT_ID('Logistics.dbo.trg_CostCenters_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_CostCenters_DEL; GO
CREATE TRIGGER Logistics.dbo.trg_CostCenters_DEL ON Logistics.dbo.CostCenters AFTER DELETE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'CostCenters','DELETE',CAST(d.costCenterID AS NVARCHAR(20)),ISNULL(d.costCenterName,''),SYSTEM_USER FROM DELETED d; END
GO

IF OBJECT_ID('Logistics.dbo.trg_Incoterms_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_Incoterms_INS; GO
CREATE TRIGGER Logistics.dbo.trg_Incoterms_INS ON Logistics.dbo.Incoterms AFTER INSERT AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'Incoterms','INSERT',CAST(i.incotermsID AS NVARCHAR(20)),ISNULL(i.incotermsCode,''),SYSTEM_USER FROM INSERTED i; END
GO
IF OBJECT_ID('Logistics.dbo.trg_Incoterms_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_Incoterms_UPD; GO
CREATE TRIGGER Logistics.dbo.trg_Incoterms_UPD ON Logistics.dbo.Incoterms AFTER UPDATE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'Incoterms','UPDATE',CAST(i.incotermsID AS NVARCHAR(20)),'row updated',SYSTEM_USER FROM INSERTED i JOIN DELETED d ON i.incotermsID=d.incotermsID; END
GO
IF OBJECT_ID('Logistics.dbo.trg_Incoterms_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_Incoterms_DEL; GO
CREATE TRIGGER Logistics.dbo.trg_Incoterms_DEL ON Logistics.dbo.Incoterms AFTER DELETE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'Incoterms','DELETE',CAST(d.incotermsID AS NVARCHAR(20)),ISNULL(d.incotermsCode,''),SYSTEM_USER FROM DELETED d; END
GO

-- ── PalletData / PackagingData ─────────────────────────────────────────────────

IF OBJECT_ID('Logistics.dbo.trg_PalletData_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PalletData_INS; GO
CREATE TRIGGER Logistics.dbo.trg_PalletData_INS ON Logistics.dbo.PalletData AFTER INSERT AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'PalletData','INSERT',CAST(i.palletID AS NVARCHAR(20)),'row inserted',SYSTEM_USER FROM INSERTED i; END
GO
IF OBJECT_ID('Logistics.dbo.trg_PalletData_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PalletData_UPD; GO
CREATE TRIGGER Logistics.dbo.trg_PalletData_UPD ON Logistics.dbo.PalletData AFTER UPDATE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'PalletData','UPDATE',CAST(i.palletID AS NVARCHAR(20)),'row updated',SYSTEM_USER FROM INSERTED i JOIN DELETED d ON i.palletID=d.palletID; END
GO
IF OBJECT_ID('Logistics.dbo.trg_PalletData_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PalletData_DEL; GO
CREATE TRIGGER Logistics.dbo.trg_PalletData_DEL ON Logistics.dbo.PalletData AFTER DELETE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'PalletData','DELETE',CAST(d.palletID AS NVARCHAR(20)),'row deleted',SYSTEM_USER FROM DELETED d; END
GO

IF OBJECT_ID('Logistics.dbo.trg_PackagingData_INS', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PackagingData_INS; GO
CREATE TRIGGER Logistics.dbo.trg_PackagingData_INS ON Logistics.dbo.PackagingData AFTER INSERT AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'PackagingData','INSERT',ISNULL(i.packID,'?'),'row inserted',SYSTEM_USER FROM INSERTED i; END
GO
IF OBJECT_ID('Logistics.dbo.trg_PackagingData_UPD', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PackagingData_UPD; GO
CREATE TRIGGER Logistics.dbo.trg_PackagingData_UPD ON Logistics.dbo.PackagingData AFTER UPDATE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'PackagingData','UPDATE',ISNULL(i.packID,'?'),'row updated',SYSTEM_USER FROM INSERTED i JOIN DELETED d ON i.packID=d.packID; END
GO
IF OBJECT_ID('Logistics.dbo.trg_PackagingData_DEL', 'TR') IS NOT NULL DROP TRIGGER Logistics.dbo.trg_PackagingData_DEL; GO
CREATE TRIGGER Logistics.dbo.trg_PackagingData_DEL ON Logistics.dbo.PackagingData AFTER DELETE AS
BEGIN SET NOCOUNT ON; IF @@ROWCOUNT=0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog(TableName,Operation,RecordKey,Detail,DBUser)
  SELECT 'PackagingData','DELETE',ISNULL(d.packID,'?'),'row deleted',SYSTEM_USER FROM DELETED d; END
GO


-- ============================================================
-- kongsberg.dbo triggers  (run while in kongsberg database)
-- ============================================================

-- ── PortalUsers ───────────────────────────────────────────────────────────────

IF OBJECT_ID('kongsberg.dbo.trg_PortalUsers_INS', 'TR') IS NOT NULL DROP TRIGGER dbo.trg_PortalUsers_INS;
GO
CREATE TRIGGER dbo.trg_PortalUsers_INS ON dbo.PortalUsers AFTER INSERT AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'PortalUsers', 'INSERT', CAST(i.UserID AS NVARCHAR(20)),
    'username=' + ISNULL(i.Username,'null') + ' | role=' + ISNULL(i.Role,'null') + ' | active=' + CAST(ISNULL(i.IsActive,0) AS NVARCHAR(1)),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('kongsberg.dbo.trg_PortalUsers_UPD', 'TR') IS NOT NULL DROP TRIGGER dbo.trg_PortalUsers_UPD;
GO
CREATE TRIGGER dbo.trg_PortalUsers_UPD ON dbo.PortalUsers AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'PortalUsers', 'UPDATE', CAST(i.UserID AS NVARCHAR(20)),
    CASE WHEN ISNULL(i.Role,'') != ISNULL(d.Role,'')
         THEN 'role: ' + ISNULL(d.Role,'null') + N'→' + ISNULL(i.Role,'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CAST(i.IsActive AS INT),0) != ISNULL(CAST(d.IsActive AS INT),0)
         THEN 'isActive: ' + CAST(ISNULL(d.IsActive,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.IsActive,0) AS NVARCHAR(1)) + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CAST(i.IsLocked AS INT),0) != ISNULL(CAST(d.IsLocked AS INT),0)
         THEN 'isLocked: ' + CAST(ISNULL(d.IsLocked,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.IsLocked,0) AS NVARCHAR(1)) + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.Status,'') != ISNULL(d.Status,'')
         THEN 'status: ' + ISNULL(d.Status,'null') + N'→' + ISNULL(i.Status,'null') + ' | ' ELSE '' END,
    SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.UserID = d.UserID;
END
GO

-- ── PortalUserDepartments ─────────────────────────────────────────────────────

IF OBJECT_ID('kongsberg.dbo.trg_PortalUserDepts_INS', 'TR') IS NOT NULL DROP TRIGGER dbo.trg_PortalUserDepts_INS;
GO
CREATE TRIGGER dbo.trg_PortalUserDepts_INS ON dbo.PortalUserDepartments AFTER INSERT AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'PortalUserDepartments', 'INSERT',
    CAST(i.UserID AS NVARCHAR(20)) + '/' + ISNULL(i.Department,'?'),
    'userID=' + CAST(i.UserID AS NVARCHAR(20)) + ' | dept=' + ISNULL(i.Department,'null') + ' | grantedBy=' + ISNULL(i.GrantedBy,'null'),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('kongsberg.dbo.trg_PortalUserDepts_DEL', 'TR') IS NOT NULL DROP TRIGGER dbo.trg_PortalUserDepts_DEL;
GO
CREATE TRIGGER dbo.trg_PortalUserDepts_DEL ON dbo.PortalUserDepartments AFTER DELETE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'PortalUserDepartments', 'DELETE',
    CAST(d.UserID AS NVARCHAR(20)) + '/' + ISNULL(d.Department,'?'),
    'userID=' + CAST(d.UserID AS NVARCHAR(20)) + ' | dept=' + ISNULL(d.Department,'null'),
    SYSTEM_USER
  FROM DELETED d;
END
GO


-- ============================================================
-- Production database triggers
-- Switch to Production database before running this section.
-- ============================================================

USE Production;
GO

-- ── prod.SAPPostings ──────────────────────────────────────────────────────────

IF OBJECT_ID('prod.trg_SAPPostings_INS', 'TR') IS NOT NULL DROP TRIGGER prod.trg_SAPPostings_INS;
GO
CREATE TRIGGER prod.trg_SAPPostings_INS ON prod.SAPPostings AFTER INSERT AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'SAPPostings', 'INSERT', CAST(i.SAPPostingID AS NVARCHAR(20)),
    i.ProcessCode + '/' + CAST(i.ProcessRecordID AS NVARCHAR(20))
    + ' | type=' + ISNULL(i.PostingType,'null')
    + ' | doc=' + ISNULL(i.MaterialDocumentSAP,'null')
    + ' | ok=' + CAST(ISNULL(i.IsSuccess,0) AS NVARCHAR(1)),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('prod.trg_SAPPostings_UPD', 'TR') IS NOT NULL DROP TRIGGER prod.trg_SAPPostings_UPD;
GO
CREATE TRIGGER prod.trg_SAPPostings_UPD ON prod.SAPPostings AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'SAPPostings', 'UPDATE', CAST(i.SAPPostingID AS NVARCHAR(20)),
    CASE WHEN ISNULL(CAST(i.IsReversed AS INT),0) != ISNULL(CAST(d.IsReversed AS INT),0)
         THEN 'IsReversed: ' + CAST(ISNULL(d.IsReversed,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.IsReversed,0) AS NVARCHAR(1))
              + ' | reversalDoc=' + ISNULL(i.ReversalDocumentSAP,'null') + ' | ' ELSE '' END
  + CASE WHEN ISNULL(i.MaterialDocumentSAP,'') != ISNULL(d.MaterialDocumentSAP,'')
         THEN 'matDoc: ' + ISNULL(d.MaterialDocumentSAP,'null') + N'→' + ISNULL(i.MaterialDocumentSAP,'null') + ' | ' ELSE '' END,
    SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.SAPPostingID = d.SAPPostingID;
END
GO

-- ── prod.ScrapEntries ─────────────────────────────────────────────────────────

IF OBJECT_ID('prod.trg_ScrapEntries_INS', 'TR') IS NOT NULL DROP TRIGGER prod.trg_ScrapEntries_INS;
GO
CREATE TRIGGER prod.trg_ScrapEntries_INS ON prod.ScrapEntries AFTER INSERT AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ScrapEntries', 'INSERT', CAST(i.ScrapID AS NVARCHAR(20)),
    i.ProcessCode + '/' + CAST(i.ProcessRecordID AS NVARCHAR(20))
    + ' | qty=' + ISNULL(CAST(i.Quantity AS NVARCHAR(20)),'null')
    + ' | uom=' + ISNULL(i.UnitOfMeasure,'null'),
    SYSTEM_USER
  FROM INSERTED i;
END
GO

IF OBJECT_ID('prod.trg_ScrapEntries_UPD', 'TR') IS NOT NULL DROP TRIGGER prod.trg_ScrapEntries_UPD;
GO
CREATE TRIGGER prod.trg_ScrapEntries_UPD ON prod.ScrapEntries AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON; IF @@ROWCOUNT = 0 RETURN;
  INSERT INTO kongsberg.dbo.DataChangeLog (TableName, Operation, RecordKey, Detail, DBUser)
  SELECT 'ScrapEntries', 'UPDATE', CAST(i.ScrapID AS NVARCHAR(20)),
    CASE WHEN ISNULL(CAST(i.IsApproved AS INT),0) != ISNULL(CAST(d.IsApproved AS INT),0)
         THEN 'IsApproved: ' + CAST(ISNULL(d.IsApproved,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.IsApproved,0) AS NVARCHAR(1)) + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CAST(i.SAPPosted AS INT),0) != ISNULL(CAST(d.SAPPosted AS INT),0)
         THEN 'SAPPosted: ' + CAST(ISNULL(d.SAPPosted,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.SAPPosted,0) AS NVARCHAR(1)) + ' | ' ELSE '' END
  + CASE WHEN ISNULL(CAST(i.IsVoided AS INT),0) != ISNULL(CAST(d.IsVoided AS INT),0)
         THEN 'IsVoided: ' + CAST(ISNULL(d.IsVoided,0) AS NVARCHAR(1)) + N'→' + CAST(ISNULL(i.IsVoided,0) AS NVARCHAR(1)) + ' | ' ELSE '' END,
    SYSTEM_USER
  FROM INSERTED i JOIN DELETED d ON i.ScrapID = d.ScrapID;
END
GO

-- Switch back
USE kongsberg;
GO

-- ============================================================
-- Done. Verify with:
--   SELECT TOP 50 * FROM kongsberg.dbo.DataChangeLog ORDER BY LogID DESC
-- ============================================================
