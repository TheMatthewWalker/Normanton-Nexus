/* ============================================================
   Portal Users — add FirstName and LastName columns
   Run connected to the kongsberg database (not Production).
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.PortalUsers') AND name = N'FirstName')
    ALTER TABLE dbo.PortalUsers ADD FirstName NVARCHAR(80) NULL

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.PortalUsers') AND name = N'LastName')
    ALTER TABLE dbo.PortalUsers ADD LastName NVARCHAR(80) NULL

/* Backfill existing accounts: split Username on '.' if it looks like firstname.lastname,
   otherwise copy the whole Username into FirstName as a best-effort.             */
UPDATE dbo.PortalUsers
SET
    FirstName = CASE
        WHEN Username LIKE '%.%'
        THEN LEFT(Username, CHARINDEX('.', Username) - 1)
        ELSE Username
    END,
    LastName  = CASE
        WHEN Username LIKE '%.%'
        THEN SUBSTRING(Username, CHARINDEX('.', Username) + 1, LEN(Username))
        ELSE NULL
    END
WHERE FirstName IS NULL
