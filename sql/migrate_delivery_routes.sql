-- Migration: DeliveryRoutes table
-- Transit time lookup: country code + optional postcode prefix → transit days
-- Postcode prefix = first 2 characters of destination postcode (e.g. 'LS' for LS12 4AA)
-- NULL postcodePrefix acts as a country-level fallback when no prefix match is found.

CREATE TABLE Logistics.dbo.DeliveryRoutes (
    routeID        INT           IDENTITY(1,1) PRIMARY KEY,
    countryCode    NVARCHAR(10)  NOT NULL,
    postcodePrefix NVARCHAR(5)   NULL,        -- NULL = country-wide fallback
    transitDays    INT           NOT NULL,
    CONSTRAINT UQ_DeliveryRoutes UNIQUE (countryCode, postcodePrefix)
);

-- Example seed data (adjust to match actual transit times)
-- INSERT INTO Logistics.dbo.DeliveryRoutes (countryCode, postcodePrefix, transitDays) VALUES
--   ('UK', NULL, 1),       -- UK default: next day
--   ('UK', 'BT', 2),       -- Northern Ireland: 2 days
--   ('DE', NULL, 3),       -- Germany: 3 days
--   ('FR', NULL, 4),       -- France: 4 days
--   ('ES', NULL, 5);       -- Spain: 5 days
