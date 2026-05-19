-- ── Shipment costing schema changes ──────────────────────────────────────────
-- Run AFTER existing migrations.

-- 1. RatesKN: add minimum charge column
ALTER TABLE Logistics.dbo.RatesKN ADD minimumCharge DECIMAL(18,2) NULL;

-- 2. CostElements: add direction/tier/code columns for DB-driven lookups
ALTER TABLE Logistics.dbo.CostElements
    ADD elementCode NVARCHAR(6)  NULL,
        direction   NVARCHAR(10) NULL,   -- 'inbound' | 'outbound'
        tier        NVARCHAR(10) NULL;   -- 'standard' | 'premium'

-- 3. CostCenters: add SAP cost centre code (stored in ShipmentCost.costCenter)
ALTER TABLE Logistics.dbo.CostCenters ADD centerCode NVARCHAR(20) NULL;

-- 4. Seed CostTypes (typeID stored as string in ShipmentCost.costType)
INSERT INTO Logistics.dbo.CostTypes (typeID, typeDescription)
VALUES (1, 'General Freight');

-- 5. Seed CostElements — edit these rows to change SAP codes without touching code
INSERT INTO Logistics.dbo.CostElements (elementCode, direction, tier, elementDescription)
VALUES
    ('601200', 'outbound', 'standard', 'Outbound Standard Freight'),
    ('601300', 'outbound', 'premium',  'Outbound Premium Freight'),
    ('602100', 'inbound',  'premium',  'Inbound Premium Freight'),
    ('602200', 'inbound',  'standard', 'Inbound Standard Freight');

-- 6. Seed CostCenters — default centre; add department-specific rows as needed
INSERT INTO Logistics.dbo.CostCenters (centerCode, centerDescription)
VALUES ('0000002004', 'General Freight');
-- Examples of additional centres (uncomment and edit as needed):
-- INSERT INTO Logistics.dbo.CostCenters (centerCode, centerDescription) VALUES ('632-36GBNO', 'Sales');
-- INSERT INTO Logistics.dbo.CostCenters (centerCode, centerDescription) VALUES ('632-36GBQY', 'Quality');
-- INSERT INTO Logistics.dbo.CostCenters (centerCode, centerDescription) VALUES ('632-36GBHR', 'HR');
