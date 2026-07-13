USE Logistics;
GO

CREATE TABLE dbo.ShipmentEvents (
    EventID          INT            IDENTITY(1,1) NOT NULL,
    shipmentID       BIGINT         NOT NULL,
    eventCategory    NVARCHAR(50)   NOT NULL,
    eventDescription NVARCHAR(500)  NOT NULL,
    timeStamp        DATETIME       NOT NULL CONSTRAINT DF_ShipmentEvents_timeStamp DEFAULT GETDATE(),
    CONSTRAINT PK_ShipmentEvents PRIMARY KEY CLUSTERED (EventID ASC)
);
GO

CREATE NONCLUSTERED INDEX IX_ShipmentEvents_shipmentID
    ON dbo.ShipmentEvents (shipmentID ASC);
GO
