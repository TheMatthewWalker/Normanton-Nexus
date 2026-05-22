USE Logistics;
GO

-- Rename dueDate → dispatchDate
-- sp_rename requires schema.table.column (no database prefix) when run in DB context.
EXEC sp_rename 'dbo.DeliveryMain.dueDate', 'dispatchDate', 'COLUMN';
GO

-- Add deliveryDate: when the goods should arrive at the customer.
-- dispatchDate = when it leaves us; deliveryDate = when it should land.
ALTER TABLE dbo.DeliveryMain
ADD deliveryDate DATETIME NULL;
GO
