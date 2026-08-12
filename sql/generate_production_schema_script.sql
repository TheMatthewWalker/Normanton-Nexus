/* ============================================================
   Schema Extraction Script -- generates CREATE-TABLE-equivalent DDL
   from the live Production database, for reconstructing it elsewhere
   (a fresh test/migration SQL Server instance). Companion to
   generate_schema_script.sql (Kongsberg + Logistics) -- see that
   file's header for the full rationale; this one just targets the
   one remaining database, Production.

   Compatibility : SQL Server 2005+. Entirely read-only -- every
   statement below only SELECTs from system catalog views, never
   touches user data or objects. Safe to run against production.

   HOW TO RUN
   ----------
   This is written to run as ONE paste into the SQL Console section of
   private/admin.html (-> /sql/query), which shows every SELECT in a
   semicolon-separated batch as its own result set. Paste this entire
   file into the console's query box and click Run once.

   The console's default connection is the Kongsberg database
   (config.json's sqlConfig.database), so every statement below
   qualifies its tables with a three-part name (`Production.sys.tables`
   etc.) rather than switching database context -- no separate
   connection or USE statement needed, and the whole thing runs as a
   single batch.

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

   FIXED 2026-08-12: section 2's column generator previously built every
   column from sys.columns/sys.types alone and never checked
   sys.computed_columns, so it silently emitted a plain nullable column for
   ANY computed column (e.g. prod.Braiding.BraidRef, and the equivalent
   *Ref column on every other process table -- all meant to be `AS (...)
   PERSISTED` formulas derived from the table's own identity column). That
   dropped formula meant the column stopped auto-populating on new rows.
   Now checks c.is_computed and, when set, emits the real
   sys.computed_columns.definition (+ PERSISTED when applicable) instead of
   a type/nullability-based definition -- see
   migrations/nexus_operations/20260812180000_fix_ref_computed_columns.cjs
   for the live-database corrective fix this generator bug necessitated.

   Order matches how a target server needs it applied:
     1. Row counts (context -- helps spot which tables are reference/
        lookup data worth seeding vs. transactional)
     2. CREATE TABLE statements (columns, identity, nullability) with
        PRIMARY KEY inline
     3. DEFAULT constraints (separate ALTER TABLE ADD CONSTRAINT, easier
        to diff/re-run than inlining)
     4. UNIQUE constraints
     5. CHECK constraints
     6. Non-PK/non-unique indexes
     7. FOREIGN KEY constraints (deliberately last -- tables must all
        exist first)
     8. VIEW / PROCEDURE / TRIGGER definitions (verbatim via
        OBJECT_DEFINITION(), byte-for-byte what's on the server now)
   ============================================================ */

SELECT '----- 1. ROW COUNTS (Production) -----' AS Section;

SELECT N'Production' AS DatabaseName, s.name + N'.' + t.name AS TableName, SUM(p.rows) AS ApproxRowCount
FROM Production.sys.tables t
JOIN Production.sys.schemas s ON s.schema_id = t.schema_id
JOIN Production.sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY s.name, t.name
ORDER BY ApproxRowCount ASC, TableName;

/* ------------------------------------------------------------
   2. CREATE TABLE statements
   ------------------------------------------------------------ */
SELECT '----- 2. CREATE TABLE (Production) -----' AS Section;

SELECT
    s.name AS SchemaName,
    t.name AS TableName,
    N'IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N''' + s.name + N'.' + t.name + N''') AND type = ''U'')' + CHAR(13) + CHAR(10) +
    N'CREATE TABLE ' + s.name + N'.' + t.name + N' (' + CHAR(13) + CHAR(10) +
    STUFF((
        SELECT
            N',    ' + c.name + N' ' +
            CASE WHEN c.is_computed = 1
                THEN N'AS ' + cc.definition + CASE WHEN cc.is_persisted = 1 THEN N' PERSISTED' ELSE N'' END
                ELSE
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
                    CASE WHEN c.is_nullable = 0 THEN N' NOT NULL' ELSE N' NULL' END
            END +
            CHAR(13) + CHAR(10)
        FROM Production.sys.columns c
        JOIN Production.sys.types ty ON ty.user_type_id = c.user_type_id
        LEFT JOIN Production.sys.identity_columns idc ON idc.object_id = c.object_id AND idc.column_id = c.column_id
        LEFT JOIN Production.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
        WHERE c.object_id = t.object_id
        ORDER BY c.column_id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 5, N'    ') +
    ISNULL((
        SELECT N',' + CHAR(13) + CHAR(10) + N'    CONSTRAINT ' + i.name + N' PRIMARY KEY (' +
            STUFF((
                SELECT N', ' + col.name + CASE WHEN ic2.is_descending_key = 1 THEN N' DESC' ELSE N'' END
                FROM Production.sys.index_columns ic2
                JOIN Production.sys.columns col ON col.object_id = ic2.object_id AND col.column_id = ic2.column_id
                WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
                ORDER BY ic2.key_ordinal
                FOR XML PATH(''), TYPE
            ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
        N')'
        FROM Production.sys.indexes i
        WHERE i.object_id = t.object_id AND i.is_primary_key = 1
    ), N'') +
    CHAR(13) + CHAR(10) + N')' AS Ddl
FROM Production.sys.tables t
JOIN Production.sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name;

/* ------------------------------------------------------------
   3. DEFAULT constraints
   ------------------------------------------------------------ */
SELECT '----- 3. DEFAULT CONSTRAINTS (Production) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + dc.name + N' DEFAULT ' + dc.definition + N' FOR ' + c.name AS Ddl
FROM Production.sys.default_constraints dc
JOIN Production.sys.tables t ON t.object_id = dc.parent_object_id
JOIN Production.sys.schemas s ON s.schema_id = t.schema_id
JOIN Production.sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
ORDER BY s.name, t.name, c.column_id;

/* ------------------------------------------------------------
   4. UNIQUE constraints
   ------------------------------------------------------------ */
SELECT '----- 4. UNIQUE CONSTRAINTS (Production) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + i.name + N' UNIQUE (' +
    STUFF((
        SELECT N', ' + col.name
        FROM Production.sys.index_columns ic
        JOIN Production.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
        ORDER BY ic.key_ordinal
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')' AS Ddl
FROM Production.sys.indexes i
JOIN Production.sys.tables t ON t.object_id = i.object_id
JOIN Production.sys.schemas s ON s.schema_id = t.schema_id
WHERE i.is_unique_constraint = 1
ORDER BY s.name, t.name, i.name;

/* ------------------------------------------------------------
   5. CHECK constraints
   ------------------------------------------------------------ */
SELECT '----- 5. CHECK CONSTRAINTS (Production) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + cc.name + N' CHECK ' + cc.definition AS Ddl
FROM Production.sys.check_constraints cc
JOIN Production.sys.tables t ON t.object_id = cc.parent_object_id
JOIN Production.sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name, cc.name;

/* ------------------------------------------------------------
   6. Non-PK / non-unique indexes
   ------------------------------------------------------------ */
SELECT '----- 6. INDEXES (Production) -----' AS Section;

SELECT
    N'CREATE ' + CASE WHEN i.is_unique = 1 THEN N'UNIQUE ' ELSE N'' END +
    CASE WHEN i.type = 1 THEN N'CLUSTERED ' ELSE N'NONCLUSTERED ' END +
    N'INDEX ' + i.name + N' ON ' + s.name + N'.' + t.name + N' (' +
    STUFF((
        SELECT N', ' + col.name + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N'' END
        FROM Production.sys.index_columns ic
        JOIN Production.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
        ORDER BY ic.key_ordinal
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')' +
    ISNULL(N' INCLUDE (' +
        STUFF((
            SELECT N', ' + col.name
            FROM Production.sys.index_columns ic
            JOIN Production.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
            WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
            ORDER BY col.column_id
            FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')', N'') AS Ddl
FROM Production.sys.indexes i
JOIN Production.sys.tables t ON t.object_id = i.object_id
JOIN Production.sys.schemas s ON s.schema_id = t.schema_id
WHERE i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.type IN (1, 2) AND i.name IS NOT NULL
ORDER BY s.name, t.name, i.name;

/* ------------------------------------------------------------
   7. FOREIGN KEY constraints (last -- run after all tables exist)
   ------------------------------------------------------------ */
SELECT '----- 7. FOREIGN KEYS (Production) -----' AS Section;

SELECT
    N'ALTER TABLE ' + s.name + N'.' + t.name +
    N' ADD CONSTRAINT ' + fk.name + N' FOREIGN KEY (' +
    STUFF((
        SELECT N', ' + col.name
        FROM Production.sys.foreign_key_columns fkc
        JOIN Production.sys.columns col ON col.object_id = fkc.parent_object_id AND col.column_id = fkc.parent_column_id
        WHERE fkc.constraint_object_id = fk.object_id
        ORDER BY fkc.constraint_column_id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N') REFERENCES ' + rs.name + N'.' + rt.name + N' (' +
    STUFF((
        SELECT N', ' + rcol.name
        FROM Production.sys.foreign_key_columns fkc
        JOIN Production.sys.columns rcol ON rcol.object_id = fkc.referenced_object_id AND rcol.column_id = fkc.referenced_column_id
        WHERE fkc.constraint_object_id = fk.object_id
        ORDER BY fkc.constraint_column_id
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') +
    N')' +
    CASE fk.delete_referential_action WHEN 1 THEN N' ON DELETE CASCADE' WHEN 2 THEN N' ON DELETE SET NULL' WHEN 3 THEN N' ON DELETE SET DEFAULT' ELSE N'' END +
    CASE fk.update_referential_action WHEN 1 THEN N' ON UPDATE CASCADE' WHEN 2 THEN N' ON UPDATE SET NULL' WHEN 3 THEN N' ON UPDATE SET DEFAULT' ELSE N'' END AS Ddl
FROM Production.sys.foreign_keys fk
JOIN Production.sys.tables t ON t.object_id = fk.parent_object_id
JOIN Production.sys.schemas s ON s.schema_id = t.schema_id
JOIN Production.sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN Production.sys.schemas rs ON rs.schema_id = rt.schema_id
ORDER BY s.name, t.name, fk.name;

/* ------------------------------------------------------------
   8. Views / Stored Procedures / Triggers -- verbatim definitions
   ------------------------------------------------------------ */
SELECT '----- 8a. VIEWS (Production) -----' AS Section;

SELECT s.name AS SchemaName, v.name AS ViewName, OBJECT_DEFINITION(v.object_id) AS Ddl
FROM Production.sys.views v
JOIN Production.sys.schemas s ON s.schema_id = v.schema_id
ORDER BY s.name, v.name;

SELECT '----- 8b. STORED PROCEDURES (Production) -----' AS Section;

SELECT s.name AS SchemaName, p.name AS ProcName, OBJECT_DEFINITION(p.object_id) AS Ddl
FROM Production.sys.procedures p
JOIN Production.sys.schemas s ON s.schema_id = p.schema_id
ORDER BY s.name, p.name;

SELECT '----- 8c. TRIGGERS (Production) -----' AS Section;

SELECT s.name AS SchemaName, t.name AS TableName, tr.name AS TriggerName, OBJECT_DEFINITION(tr.object_id) AS Ddl
FROM Production.sys.triggers tr
JOIN Production.sys.tables t ON t.object_id = tr.parent_id
JOIN Production.sys.schemas s ON s.schema_id = t.schema_id
ORDER BY s.name, t.name, tr.name;
