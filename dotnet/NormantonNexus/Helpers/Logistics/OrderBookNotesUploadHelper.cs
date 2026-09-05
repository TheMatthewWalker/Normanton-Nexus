using System.Globalization;
using ClosedXML.Excel;
using NormantonNexus.Models;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Month End Breakdown Excel macro's comments upload — Logistics Sub-phase
/// 8b.6. Port of routes/performance.js's POST /orderbook-breakdown/upload-notes
/// + its performancesql.js backing upsertOrderBookLineNotes. Reached either
/// from the logged-in web page or the standalone Excel macro (no cookie jar
/// of its own) via OrderbookBearerScheme — see the controller action's own
/// [Authorize] and Services/Auth/OrderbookTokenService.cs.
///
/// Matched by header text (not column position), same precedent as
/// MrpForecastHelper's Sales Forecast Template upload, so this survives a
/// reordered/re-saved copy of the export. The "Data" sheet supplies
/// Reason/Won't Get/Last Day/Last Day Time/Expected to Invoice Qty; the
/// "Next Month" sheet supplies only the Bring Forward confirm flag (Stock
/// Qty/Value and Bring Forward Value on that tab are live formulas, not
/// planner input) — a row there may have no matching Data-sheet row at all
/// (Next Month is scoped to next month; Data is scoped to this month or
/// earlier), in which case a new note entry is created for it.
/// </summary>
internal static class OrderBookNotesUploadHelper
{
    private static string ReadCellText(IXLRow row, int colNumber)
    {
        if (colNumber <= 0) return "";
        var cell = row.Cell(colNumber);
        if (cell.IsEmpty()) return "";
        if (cell.DataType == XLDataType.DateTime) return cell.GetDateTime().ToString("yyyy-MM-dd");
        return cell.GetString().Trim();
    }

    private static Dictionary<string, int> BuildHeaderMap(IXLWorksheet ws)
    {
        var map = new Dictionary<string, int>();
        foreach (var cell in ws.Row(1).CellsUsed())
        {
            var text = cell.GetString().Trim();
            if (text.Length > 0) map[text] = cell.Address.ColumnNumber;
        }
        return map;
    }

    private static string? NullIfEmpty(string s) => s.Length == 0 ? null : s;

    internal sealed record NoteRow(string ReferenceDocument, string Material, string? Reason, string? WontGet, string? LastDay, string? LastDayTime, string? BringForward, string? PlannedProductionQtyText);

    /// <summary>
    /// Pure parse — no DB, no audit — split out specifically so the header-matching/merge
    /// logic (a Data-sheet row's notes merged with a Next Month row's Bring Forward flag,
    /// keyed by (ReferenceDocument, Material)) is unit-testable without a DB mock, the same
    /// "expose pure logic as internal for testing" precedent used everywhere else in this
    /// migration.
    /// </summary>
    internal static IReadOnlyList<NoteRow> ParseWorkbook(byte[] fileBytes)
    {
        if (fileBytes.Length == 0) throw new NexusValidationException("No file content received.");

        using var stream = new MemoryStream(fileBytes);
        using var wb = new XLWorkbook(stream);
        if (!wb.TryGetWorksheet("Data", out var dataWs))
            throw new NexusValidationException("This file has no \"Data\" sheet — is it a Month End Breakdown export?");

        var dataHeaderMap = BuildHeaderMap(dataWs);
        var notesByKey = new Dictionary<string, NoteRow>();

        var lastDataRow = dataWs.LastRowUsed()?.RowNumber() ?? 1;
        for (var rowNumber = 2; rowNumber <= lastDataRow; rowNumber++)
        {
            var row = dataWs.Row(rowNumber);
            var referenceDocument = ReadCellText(row, dataHeaderMap.GetValueOrDefault("Order"));
            var material = ReadCellText(row, dataHeaderMap.GetValueOrDefault("Material"));
            if (referenceDocument.Length == 0 || material.Length == 0) continue;

            notesByKey[$"{referenceDocument}||{material}"] = new NoteRow(
                referenceDocument, material,
                Reason: NullIfEmpty(ReadCellText(row, dataHeaderMap.GetValueOrDefault("Reason"))),
                WontGet: NullIfEmpty(ReadCellText(row, dataHeaderMap.GetValueOrDefault("Won't Get"))),
                LastDay: NullIfEmpty(ReadCellText(row, dataHeaderMap.GetValueOrDefault("Last Day"))),
                LastDayTime: NullIfEmpty(ReadCellText(row, dataHeaderMap.GetValueOrDefault("Last Day Time"))),
                BringForward: null,
                PlannedProductionQtyText: NullIfEmpty(ReadCellText(row, dataHeaderMap.GetValueOrDefault("Expected to Invoice Qty"))));
        }

        if (wb.TryGetWorksheet("Next Month", out var nextMonthWs))
        {
            var nextMonthHeaderMap = BuildHeaderMap(nextMonthWs);
            var confirmCol = nextMonthHeaderMap.GetValueOrDefault("Bring Forward");

            var lastNextMonthRow = nextMonthWs.LastRowUsed()?.RowNumber() ?? 1;
            for (var rowNumber = 2; rowNumber <= lastNextMonthRow; rowNumber++)
            {
                var row = nextMonthWs.Row(rowNumber);
                var referenceDocument = ReadCellText(row, nextMonthHeaderMap.GetValueOrDefault("Order"));
                var material = ReadCellText(row, nextMonthHeaderMap.GetValueOrDefault("Material"));
                if (referenceDocument.Length == 0 || material.Length == 0) continue;

                var bringForwardFlag = NullIfEmpty(ReadCellText(row, confirmCol));
                var key = $"{referenceDocument}||{material}";

                notesByKey[key] = notesByKey.TryGetValue(key, out var existing)
                    ? existing with { BringForward = bringForwardFlag }
                    : new NoteRow(referenceDocument, material, null, null, null, null, bringForwardFlag, null);
            }
        }

        return notesByKey.Values.ToList();
    }

    /// <summary>Parses the uploaded workbook and upserts every line's notes. Returns the number of (ReferenceDocument, Material) lines updated.</summary>
    internal static async Task<int> UploadNotesAsync(INexusOperationsDb db, IAuditLogger audit, byte[] fileBytes, string? username, string? ipAddress, CancellationToken ct)
    {
        var noteRows = ParseWorkbook(fileBytes);
        await UpsertNotesAsync(db, noteRows, username, ct);

        await audit.LogAsync("ORDERBOOK_NOTES_UPLOAD", username, $"Uploaded Month End Breakdown comments for {noteRows.Count} line(s)", ipAddress, ct);

        return noteRows.Count;
    }

    /// <summary>Risk is always written null — it's calculated fresh on the Data sheet on every export now, no longer round-tripped from an uploaded flag (see log.OrderBookLineNotes.Risk's own comment).</summary>
    private static async Task UpsertNotesAsync(INexusOperationsDb db, IReadOnlyList<NoteRow> rows, string? username, CancellationToken ct)
    {
        if (rows.Count == 0) return;

        using var connection = await db.CreateConnectionAsync(ct);

        IReadOnlyList<SnapshotTableWriter.Column<NoteRow>> keyColumns =
        [
            new("ReferenceDocument", r => r.ReferenceDocument, 10),
            new("Material", r => r.Material, 18),
        ];
        IReadOnlyList<SnapshotTableWriter.Column<NoteRow>> columns =
        [
            new("Risk", _ => null, 1),
            new("Reason", r => r.Reason, 500),
            new("WontGet", r => r.WontGet, 1),
            new("LastDay", r => r.LastDay, 1),
            new("LastDayTime", r => r.LastDayTime, 20),
            new("BringForward", r => r.BringForward, 1),
            new("PlannedProductionQty", r => r.PlannedProductionQtyText is not null && decimal.TryParse(r.PlannedProductionQtyText, NumberStyles.Number, CultureInfo.InvariantCulture, out var qty) ? qty : null),
            new("UpdatedByUsername", _ => username, 80),
        ];

        await SnapshotTableWriter.UpsertAsync(connection, "log.OrderBookLineNotes", keyColumns, columns, rows, ct);
    }
}
