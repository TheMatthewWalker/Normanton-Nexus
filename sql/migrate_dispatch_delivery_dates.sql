-- Rename dueDate → dispatchDate
-- dueDate was the planned date a delivery should leave the site.
-- Renaming to dispatchDate makes the intent explicit.
EXEC sp_rename 'Logistics.dbo.DeliveryMain.dueDate', 'dispatchDate', 'COLUMN';
GO

-- Add deliveryDate: when the goods should arrive at the customer.
-- dispatchDate = when it leaves us; deliveryDate = when it should land.
-- Derived from dispatchDate + customer transit time (managed at application level).
ALTER TABLE Logistics.dbo.DeliveryMain
ADD deliveryDate DATE NULL;
GO
