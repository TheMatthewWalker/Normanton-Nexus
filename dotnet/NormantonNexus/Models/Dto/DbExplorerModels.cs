namespace NormantonNexus.Models.Dto;

// ── Phase 9: Admin — DB Explorer (superadmin-only SSMS-lite schema browser) ──
// Port of routes/dbexplorer.js. Every route is gated superadmin-only
// (stricter than api/admin's blanket Role:admin), and the row-preview route
// is additionally audited, matching Node exactly — see DbExplorerHelper's
// own header comment for the SQL-injection-safety design (verify every
// identifier against sys.* before it's ever interpolated).

public sealed record DatabaseInfoRow(string Name, int DatabaseId, DateTime CreateDate, string StateDesc, string RecoveryModelDesc, int CompatibilityLevel);

public sealed record TableInfoRow(string SchemaName, string TableName, long? ApproxRowCount);

public sealed record ColumnInfoRow(int ColumnId, string ColumnName, string DataType, short MaxLength, byte Precision, byte Scale, bool IsNullable, bool IsIdentity, string? DefaultValue, bool IsPrimaryKey);

public sealed record KeyConstraintRow(string ConstraintName, string ConstraintType, string? Columns);

public sealed record ForeignKeyOutRow(string ConstraintName, string ColumnName, string ReferencedSchema, string ReferencedTable, string ReferencedColumn, string OnDelete, string OnUpdate);

public sealed record ForeignKeyInRow(string ConstraintName, string SourceSchema, string SourceTable, string SourceColumn, string ColumnName);

public sealed record CheckConstraintRow(string ConstraintName, string? Definition, bool IsDisabled);

public sealed record IndexInfoRow(string IndexName, string IndexType, bool IsUnique, bool IsPrimaryKey, string? Columns);

public sealed record TableConstraintsResult(
    IReadOnlyList<KeyConstraintRow> Keys, IReadOnlyList<ForeignKeyOutRow> ForeignKeysOut, IReadOnlyList<ForeignKeyInRow> ForeignKeysIn,
    IReadOnlyList<CheckConstraintRow> CheckConstraints, IReadOnlyList<IndexInfoRow> Indexes);
