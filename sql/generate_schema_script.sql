/* ============================================================
   Schema Extraction Script -- generates CREATE-TABLE-equivalent DDL
   from the live Kongsberg and Logistics databases, for reconstructing
   them elsewhere (a fresh test/migration SQL Server instance).

   Compatibility : SQL Server 2005+. Entirely read-only -- every
   statement below only SELECTs from system catalog views, never
   touches user data or objects. Safe to run against production.

   HOW TO RUN
   ----------
   This is written to run as ONE paste into the Raw SQL Console
   (private/rawsql.html -> /sql/query), which now shows every SELECT
   in a semicolon-separated batch as its own result set. Paste this
   entire file into the console's query box and click Run once.

   The console's default connection is the Kongsberg database
   (config.json's sqlConfig.database), so every statement below that
   needs Logistics instead qualifies its tables with a three-part name
   (`Logistics.sys.tables` etc.) rather than switching database
   context -- no separate connection or USE statement needed, and the
   whole thing runs as a single batch.

   Copy the full result (every "Result N" table, in order) back
   verbatim, including which section each one came from -- each
   section is preceded by its own one-row "----- N. SECTION -----"
   marker result so the boundaries stay unambiguous even out of
   context.

   WHAT THIS DOES NOT CAPTURE (known simplifications -- flagged here so
   nothing is silently assumed correct):
     - Explicit column-level COLLATE clauses (assumes target DB default
       collation matches -- fine for a fresh SQL Server instance created
       with the same default collation, worth double-checking otherwise)
     - Filegroups / partitioning (assumes everything lives on PRIMARY)
     - Extended properties / MS_Description metadata
     - Permissions/role grants (out of scope -- this app manages its own
       auth via dbo.PortalUsers etc., not SQL Server logins per user)
     - Full-text indexes, XML schema collections (not used anywhere in
       this codebase as far as the app code shows, but flagging in case)

   Order matches how a target server needs it applied:
     1. Row counts, both DBs combined (context -- helps spot which
        tables are reference/lookup data worth seeding vs. transactional)
     2. CREATE TABLE statements (columns, identity, nullability) with
        PRIMARY KEY inline -- Kongsberg, then Logistics
     3. DEFAULT constraints (separate ALTER TABLE ADD CONSTRAINT, easier
        to diff/re-run than inlining) -- Kongsberg, then Logistics
     4. UNIQUE constraints -- Kongsberg, then Logistics
     5. CHECK constraints -- Kongsberg, then Logistics
     6. Non-PK/non-unique indexes -- Kongsberg, then Logistics
     7. FOREIGN KEY constraints (deliberately last -- tables must all
        exist first) -- Kongsberg, then Logistics
     8. VIEW / PROCEDURE / TRIGGER definitions (verbatim via
        OBJECT_DEFINITION(), byte-for-byte what's on the server now)
        -- Kongsberg, then Logistics
   ============================================================ */

SELECT '----- 1. ROW COUNTS (both databases) -----' AS Section;

SELECT N'Kongsberg' AS DatabaseName, s.name + N'.' + t.name AS TableName, SUM(p.rows) AS ApproxRowCount
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY s.name, t.name
UNION ALL
SELECT N'Logistics', s.name + N'.' + t.name, SUM(p.rows)
FROM Logistics.sys.tables t
JOIN Logistics.sys.schemas s ON s.schema_id = t.schema_id
JOIN Logistics.sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY s.name, t.name
ORDER BY ApproxRowCount ASC, DatabaseName, TableName;

/* ------------------------------------------------------------
   2. CREATE TABLE statements
   ------------------------------------------------------------ */
SELECT '----- 2a. CREATE TABLE (Kongsberg) -----' AS Section;

SELECT
    s.name AS SchemaName,
    t.name AS TableName,
    N'IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N''' + s.name + N'.' + t.name + N''') AND type = ''U'')' + CHAR(13) + CHAR(10) +
    N'CREATE TABLE ' + s.name + N'.' + t.name + N' (' + CHAR(13) + CHAR(10) +
    STUFF((
        SELECT
            N',    ' + c.name + N' ' +
            UPPER(ty.name) +
            CASE
                WHEN ty.name IN ('varchar','char','varbinary','binary')
                    THEN N'(' + CASE WHEN c.max_length = -1 THEN N'MAX' ELSE CAST(c.max_length AS NVARCHAR(10)) END + N')'
                WHEN ty.name IN ('nvarchar','nchar')
                    THEN N'(' + CASE WHEN c.max_length = -1 THEN N'MAX' ELSE CAST(c.max_length / 2 AS NVARCHAR(10)) END + N')'
                WHEN ty.name IN ('decimal','numeric')
                    THEN N'(' + CAST(c.precision AS NVARCHAR(10)) + N',' + CAST(c.scale AS NVARCHAR(10)) + N')'
                WHEN ty.name IN ('datetime2','datetimeoffset','time')
                    THEN N'(' + CAST(c.scale AS NVARCHAR(10)) + N')'
                ELSE N''
            END +
            CASE WHEN c.is_identity = 1
                THEN N' IDENTITY(' + CAST(ISNULL(idc.seed_value, 1) AS NVARCHAR(20)) + N',' + CAST(ISNULL(idc.increment_value, 1) AS NVARCHAR(20)) + N')'
                ELSE N''
            END +
            CASE WHEN c.is_nullable = 0 THEN N' NOT NULL' ELSE N' NULL' END +
            CHAR(13) + CHAR(10)
        FROM sys.columns c
        JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        LEFT JOIN sys.identity_columns idc ON idc.object_id = c.object_id AND idc.column_id = c.column_id
        WHERE c.object_id = t.object_id
        ORDER BY c.column_id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 5, N'    ') +
    ISNULL((
        SELECT N',' + CHAR(13) + CHAR(10) + N'    CONSTRAINT ' + i.name + N' PRIMARY KEY (' +
            STUFF((
                SELECT N', ' + col.name + CASE WHEN ic2.is_descending_key = 1 THEN N' DESC' ELSE N'' END
                FROM sys.index_columns ic2
                JOIN sys.columns col ON col.object_id = ic2.object_id AND col.column_id = ic2.column_id
                WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
                ORDER BY ic2.key_ordinal
                FOR XML PATH(''), TYPE
            ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
        N')'
        FROM sys.indexes i
        WHERE i.object_id = t.object_id AND i.is_primary_key = 1
    ), N'') +
    CHAR(13) + CHAR(10) + N')' AS Ddl
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name;

SELECT '----- 2b. CREATE TABLE (Logistics) -----' AS Section;

SELECT
    s.name AS SchemaName,
    t.name AS TableName,
    N'IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N''' + s.name + N'.' + t.name + N''') AND type = ''U'')' + CHAR(13) + CHAR(10) +
    N'CREATE TABLE ' + s.name + N'.' + t.name + N' (' + CHAR(13) + CHAR(10) +
    STUFF((
        SELECT
            N',    ' + c.name + N' ' +
            UPPER(ty.name) +
            CASE
                WHEN ty.name IN ('varchar','char','varbinary','binary')
                    THEN N'(' + CASE WHEN c.max_length = -1 THEN N'MAX' ELSE CAST(c.max_length AS NVARCHAR(10)) END + N')'
                WHEN ty.name IN ('nvarchar','nchar')
                    THEN N'(' + CASE WHEN c.max_length = -1 THEN N'MAX' ELSE CAST(c.max_length / 2 AS NVARCHAR(10)) END + N')'
                WHEN ty.name IN ('decimal','numeric')
                    THEN N'(' + CAST(c.precision AS NVARCHAR(10)) + N',' + CAST(c.scale AS NVARCHAR(10)) + N')'
                WHEN ty.name IN ('datetime2','datetimeoffset','time')
                    THEN N'(' + CAST(c.scale AS NVARCHAR(10)) + N')'
                ELSE N''
            END +
            CASE WHEN c.is_identity = 1
                THEN N' IDENTITY(' + CAST(ISNULL(idc.seed_value, 1) AS NVARCHAR(20)) + N',' + CAST(ISNULL(idc.increment_value, 1) AS NVARCHAR(20)) + N')'
                ELSE N''
            END +
            CASE WHEN c.is_nullable = 0 THEN N' NOT NULL' ELSE N' NULL' END +
            CHAR(13) + CHAR(10)
        FROM Logistics.sys.columns c
        JOIN Logistics.sys.types ty ON ty.user_type_id = c.user_type_id
        LEFT JOIN Logistics.sys.identity_columns idc ON idc.object_id = c.object_id AND idc.column_id = c.column_id
        WHERE c.object_id = t.object_id
        ORDER BY c.column_id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 5, N'    ') +
    ISNULL((
        SELECT N',' + CHAR(13) + CHAR(10) + N'    CONSTRAINT ' + i.name + N' PRIMARY KEY (' +
            STUFF((
                SELECT N', ' + col.name + CASE WHEN ic2.is_descending_key = 1 THEN N' DESC' ELSE N'' END
                FROM Logistics.sys.index_columns ic2
                JOIN Logistics.sys.columns col ON col.object_id = ic2.object_id AND col.column_id = ic2.column_id
                WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
                ORDER BY ic2.key_ordinal
                FOR XML PATH(''), TYPE
            ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
        N')'
        FROM Logistics.sys.indexes i
        WHERE i.object_id = t.object_id AND i.is_primary_key = 1
    ), N'') +
    CHAR(13) + CHAR(10) + N')' AS Ddl
FROM Logistics.sys.tables t
JOIN Logistics.sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name;

/* ------------------------------------------------------------
   3. DEFAULT constraints
   ------------------------------------------------------------ */
SELECT '----- 3a. DEFAULT CONSTRAINTS (Kongsberg) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + dc.name + N' DEFAULT ' + dc.definition + N' FOR ' + c.name AS Ddl
FROM sys.default_constraints dc
JOIN sys.tables t ON t.object_id = dc.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
ORDER BY s.name, t.name, c.column_id;

SELECT '----- 3b. DEFAULT CONSTRAINTS (Logistics) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + dc.name + N' DEFAULT ' + dc.definition + N' FOR ' + c.name AS Ddl
FROM Logistics.sys.default_constraints dc
JOIN Logistics.sys.tables t ON t.object_id = dc.parent_object_id
JOIN Logistics.sys.schemas s ON s.schema_id = t.schema_id
JOIN Logistics.sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
ORDER BY s.name, t.name, c.column_id;

/* ------------------------------------------------------------
   4. UNIQUE constraints
   ------------------------------------------------------------ */
SELECT '----- 4a. UNIQUE CONSTRAINTS (Kongsberg) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + i.name + N' UNIQUE (' +
    STUFF((
        SELECT N', ' + col.name
        FROM sys.index_columns ic
        JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
        ORDER BY ic.key_ordinal
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')' AS Ddl
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE i.is_unique_constraint = 1
ORDER BY s.name, t.name, i.name;

SELECT '----- 4b. UNIQUE CONSTRAINTS (Logistics) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + i.name + N' UNIQUE (' +
    STUFF((
        SELECT N', ' + col.name
        FROM Logistics.sys.index_columns ic
        JOIN Logistics.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
        ORDER BY ic.key_ordinal
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')' AS Ddl
FROM Logistics.sys.indexes i
JOIN Logistics.sys.tables t ON t.object_id = i.object_id
JOIN Logistics.sys.schemas s ON s.schema_id = t.schema_id
WHERE i.is_unique_constraint = 1
ORDER BY s.name, t.name, i.name;

/* ------------------------------------------------------------
   5. CHECK constraints
   ------------------------------------------------------------ */
SELECT '----- 5a. CHECK CONSTRAINTS (Kongsberg) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + cc.name + N' CHECK ' + cc.definition AS Ddl
FROM sys.check_constraints cc
JOIN sys.tables t ON t.object_id = cc.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name, cc.name;

SELECT '----- 5b. CHECK CONSTRAINTS (Logistics) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + cc.name + N' CHECK ' + cc.definition AS Ddl
FROM Logistics.sys.check_constraints cc
JOIN Logistics.sys.tables t ON t.object_id = cc.parent_object_id
JOIN Logistics.sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name, cc.name;

/* ------------------------------------------------------------
   6. Non-PK / non-unique indexes
   ------------------------------------------------------------ */
SELECT '----- 6a. INDEXES (Kongsberg) -----' AS Section;

SELECT
    N'CREATE ' + CASE WHEN i.is_unique = 1 THEN N'UNIQUE ' ELSE N'' END +
    CASE WHEN i.type = 1 THEN N'CLUSTERED ' ELSE N'NONCLUSTERED ' END +
    N'INDEX ' + i.name + N' ON ' + s.name + N'.' + t.name + N' (' +
    STUFF((
        SELECT N', ' + col.name + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N'' END
        FROM sys.index_columns ic
        JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
        ORDER BY ic.key_ordinal
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')' +
    ISNULL(N' INCLUDE (' +
        STUFF((
            SELECT N', ' + col.name
            FROM sys.index_columns ic
            JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
            WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
            ORDER BY col.column_id
            FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')', N'') AS Ddl
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.type IN (1, 2) AND i.name IS NOT NULL
ORDER BY s.name, t.name, i.name;

SELECT '----- 6b. INDEXES (Logistics) -----' AS Section;

SELECT
    N'CREATE ' + CASE WHEN i.is_unique = 1 THEN N'UNIQUE ' ELSE N'' END +
    CASE WHEN i.type = 1 THEN N'CLUSTERED ' ELSE N'NONCLUSTERED ' END +
    N'INDEX ' + i.name + N' ON ' + s.name + N'.' + t.name + N' (' +
    STUFF((
        SELECT N', ' + col.name + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N'' END
        FROM Logistics.sys.index_columns ic
        JOIN Logistics.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
        ORDER BY ic.key_ordinal
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')' +
    ISNULL(N' INCLUDE (' +
        STUFF((
            SELECT N', ' + col.name
            FROM Logistics.sys.index_columns ic
            JOIN Logistics.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
            WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
            ORDER BY col.column_id
            FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')', N'') AS Ddl
FROM Logistics.sys.indexes i
JOIN Logistics.sys.tables t ON t.object_id = i.object_id
JOIN Logistics.sys.schemas s ON s.schema_id = t.schema_id
WHERE i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.type IN (1, 2) AND i.name IS NOT NULL
ORDER BY s.name, t.name, i.name;

/* ------------------------------------------------------------
   7. FOREIGN KEY constraints (last -- run after all tables exist)
   ------------------------------------------------------------ */
SELECT '----- 7a. FOREIGN KEYS (Kongsberg) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + fk.name + N' FOREIGN KEY (' +
    STUFF((
        SELECT N', ' + col.name
        FROM sys.foreign_key_columns fkc
        JOIN sys.columns col ON col.object_id = fkc.parent_object_id AND col.column_id = fkc.parent_column_id
        WHERE fkc.constraint_object_id = fk.object_id
        ORDER BY fkc.constraint_column_id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N') REFERENCES ' + rs.name + N'.' + rt.name + N' (' +
    STUFF((
        SELECT N', ' + rcol.name
        FROM sys.foreign_key_columns fkc
        JOIN sys.columns rcol ON rcol.object_id = fkc.referenced_object_id AND rcol.column_id = fkc.referenced_column_id
        WHERE fkc.constraint_object_id = fk.object_id
        ORDER BY fkc.constraint_column_id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')' +
    CASE fk.delete_referential_action WHEN 1 THEN N' ON DELETE CASCADE' WHEN 2 THEN N' ON DELETE SET NULL' WHEN 3 THEN N' ON DELETE SET DEFAULT' ELSE N'' END +
    CASE fk.update_referential_action WHEN 1 THEN N' ON UPDATE CASCADE' WHEN 2 THEN N' ON UPDATE SET NULL' WHEN 3 THEN N' ON UPDATE SET DEFAULT' ELSE N'' END AS Ddl
FROM sys.foreign_keys fk
JOIN sys.tables t ON t.object_id = fk.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
ORDER BY s.name, t.name, fk.name;

SELECT '----- 7b. FOREIGN KEYS (Logistics) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + fk.name + N' FOREIGN KEY (' +
    STUFF((
        SELECT N', ' + col.name
        FROM Logistics.sys.foreign_key_columns fkc
        JOIN Logistics.sys.columns col ON col.object_id = fkc.parent_object_id AND col.column_id = fkc.parent_column_id
        WHERE fkc.constraint_object_id = fk.object_id
        ORDER BY fkc.constraint_column_id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N') REFERENCES ' + rs.name + N'.' + rt.name + N' (' +
    STUFF((
        SELECT N', ' + rcol.name
        FROM Logistics.sys.foreign_key_columns fkc
        JOIN Logistics.sys.columns rcol ON rcol.object_id = fkc.referenced_object_id AND rcol.column_id = fkc.referenced_column_id
        WHERE fkc.constraint_object_id = fk.object_id
        ORDER BY fkc.constraint_column_id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')' +
    CASE fk.delete_referential_action WHEN 1 THEN N' ON DELETE CASCADE' WHEN 2 THEN N' ON DELETE SET NULL' WHEN 3 THEN N' ON DELETE SET DEFAULT' ELSE N'' END +
    CASE fk.update_referential_action WHEN 1 THEN N' ON UPDATE CASCADE' WHEN 2 THEN N' ON UPDATE SET NULL' WHEN 3 THEN N' ON UPDATE SET DEFAULT' ELSE N'' END AS Ddl
FROM Logistics.sys.foreign_keys fk
JOIN Logistics.sys.tables t ON t.object_id = fk.parent_object_id
JOIN Logistics.sys.schemas s ON s.schema_id = t.schema_id
JOIN Logistics.sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN Logistics.sys.schemas rs ON rs.schema_id = rt.schema_id
ORDER BY s.name, t.name, fk.name;

/* ------------------------------------------------------------
   8. Views / Stored Procedures / Triggers -- verbatim definitions
   ------------------------------------------------------------ */
SELECT '----- 8a. VIEWS (Kongsberg) -----' AS Section;

SELECT s.name AS SchemaName, v.name AS ViewName, OBJECT_DEFINITION(v.object_id) AS Ddl
FROM sys.views v
JOIN sys.schemas s ON s.schema_id = v.schema_id
ORDER BY s.name, v.name;

SELECT '----- 8b. VIEWS (Logistics) -----' AS Section;

SELECT s.name AS SchemaName, v.name AS ViewName, OBJECT_DEFINITION(v.object_id) AS Ddl
FROM Logistics.sys.views v
JOIN Logistics.sys.schemas s ON s.schema_id = v.schema_id
ORDER BY s.name, v.name;

SELECT '----- 8c. STORED PROCEDURES (Kongsberg) -----' AS Section;

SELECT s.name AS SchemaName, p.name AS ProcName, OBJECT_DEFINITION(p.object_id) AS Ddl
FROM sys.procedures p
JOIN sys.schemas s ON s.schema_id = p.schema_id
ORDER BY s.name, p.name;

SELECT '----- 8d. STORED PROCEDURES (Logistics) -----' AS Section;

SELECT s.name AS SchemaName, p.name AS ProcName, OBJECT_DEFINITION(p.object_id) AS Ddl
FROM Logistics.sys.procedures p
JOIN Logistics.sys.schemas s ON s.schema_id = p.schema_id
ORDER BY s.name, p.name;

SELECT '----- 8e. TRIGGERS (Kongsberg) -----' AS Section;

SELECT s.name AS SchemaName, t.name AS TableName, tr.name AS TriggerName, OBJECT_DEFINITION(tr.object_id) AS Ddl
FROM sys.triggers tr
JOIN sys.tables t ON t.object_id = tr.parent_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name, tr.name;

SELECT '----- 8f. TRIGGERS (Logistics) -----' AS Section;

SELECT s.name AS SchemaName, t.name AS TableName, tr.name AS TriggerName, OBJECT_DEFINITION(tr.object_id) AS Ddl
FROM Logistics.sys.triggers tr
JOIN Logistics.sys.tables t ON t.object_id = tr.parent_id
JOIN Logistics.sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name, tr.name;
