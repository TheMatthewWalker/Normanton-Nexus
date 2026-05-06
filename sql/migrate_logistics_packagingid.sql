/* ============================================================
   Logistics migration — add IDENTITY to PackagingData.packagingID
   (or create it if the column does not yet exist).

   PackagingData.packID  NVARCHAR(2) = human-readable type code
   PackagingData.packagingID BIGINT IDENTITY = record identifier
     referenced by PalletPackages.packagingID

   SQL Server cannot alter an existing column to IDENTITY directly.
   The safe approach is:
     1. Create a new table with the identity column
     2. Copy the existing data (SQL Server assigns the new IDs)
     3. Fix the foreign-key side (PalletPackages) via a mapping table
     4. Drop the old table and rename the new one

   Run connected to the Logistics database.
   ============================================================ */

USE Logistics;


/* ── Step 0: check current state ────────────────────────────────────────── */

-- If packagingID already exists as an IDENTITY column, this script is a no-op.
IF EXISTS (
    SELECT 1
    FROM   sys.columns c
    JOIN   sys.objects o ON o.object_id = c.object_id
    WHERE  o.name = N'PackagingData'
      AND  c.name = N'packagingID'
      AND  c.is_identity = 1
)
BEGIN
    PRINT 'packagingID already exists as IDENTITY on PackagingData — nothing to do.';
    RETURN;
END


/* ── Step 1: create the replacement table ───────────────────────────────── */

IF OBJECT_ID(N'dbo.PackagingData_new', N'U') IS NOT NULL
    DROP TABLE dbo.PackagingData_new;

CREATE TABLE dbo.PackagingData_new (
    packagingID   BIGINT        NOT NULL IDENTITY(1,1),  -- auto-increment PK
    packID        NVARCHAR(2)   NOT NULL,                 -- type code (used by PalletValidation)
    packMaterial  NVARCHAR(50)  NULL,
    packDescription NVARCHAR(50) NULL,
    packWeight    DECIMAL(18,0) NULL,
    packLength    INT           NULL,
    packWidth     INT           NULL,
    packHeight    INT           NULL,
    CONSTRAINT PK_PackagingData_new PRIMARY KEY (packagingID),
    CONSTRAINT UQ_PackagingData_packID UNIQUE (packID)
);


/* ── Step 2: copy existing rows; SQL Server assigns new IDENTITY values ─── */

-- Preserve the packID code as-is; SQL Server allocates packagingID automatically.
INSERT INTO dbo.PackagingData_new
    (packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight)
SELECT
    packID, packMaterial, packDescription, packWeight, packLength, packWidth, packHeight
FROM dbo.PackagingData;


/* ── Step 3: build a code→new-ID mapping for fixing PalletPackages ───────── */
-- Only needed if PalletPackages already has rows with old packagingID values.

IF OBJECT_ID(N'dbo.#PackagingIDMap', N'U') IS NOT NULL
    DROP TABLE dbo.#PackagingIDMap;

-- Map: old packID code → new BIGINT packagingID
SELECT o.packID, n.packagingID AS newPackagingID
INTO   dbo.#PackagingIDMap
FROM   dbo.PackagingData     o
JOIN   dbo.PackagingData_new n ON n.packID = o.packID;


/* ── Step 4: update PalletPackages to use the new BIGINT IDs ─────────────── */
-- Only rows where packagingID currently stores a value that can be matched
-- back to a packaging type (e.g. if the column was previously populated
-- with string-cast codes or old numeric IDs).

-- If the column was never correctly populated (all NULLs or zeroes),
-- this UPDATE is a no-op and that is fine — operators will use the
-- builder going forward.

UPDATE pp
SET    pp.packagingID = m.newPackagingID
FROM   dbo.PalletPackages pp
JOIN   dbo.PackagingData  old ON CAST(old.packID AS NVARCHAR(4)) = CAST(pp.packagingID AS NVARCHAR(4))
JOIN   dbo.#PackagingIDMap m  ON m.packID = old.packID
WHERE  pp.packagingID IS NOT NULL;


/* ── Step 5: swap the tables ────────────────────────────────────────────── */

-- Drop the old table (no FK constraints expected from PackagingData itself)
DROP TABLE dbo.PackagingData;

-- Rename the new table into place
EXEC sp_rename N'dbo.PackagingData_new', N'PackagingData';

-- Rename the primary key constraint to the canonical name
EXEC sp_rename N'dbo.PK_PackagingData_new', N'PK_PackagingData', N'OBJECT';


/* ── Step 6: tidy up ────────────────────────────────────────────────────── */

DROP TABLE dbo.#PackagingIDMap;


/* ── Verify ──────────────────────────────────────────────────────────────── */

SELECT c.name AS Column_Name,
       TYPE_NAME(c.system_type_id) AS Data_Type,
       c.max_length, c.is_nullable, c.is_identity
FROM   sys.columns c
JOIN   sys.objects o ON o.object_id = c.object_id
WHERE  o.name = N'PackagingData'
ORDER  BY c.column_id;

SELECT packagingID, packID, packDescription, packWeight
FROM   dbo.PackagingData
ORDER  BY packagingID;
