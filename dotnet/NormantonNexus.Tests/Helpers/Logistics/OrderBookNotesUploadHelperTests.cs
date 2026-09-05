using ClosedXML.Excel;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class OrderBookNotesUploadHelperTests
{
    private static readonly string[] DataHeaders =
        ["Order", "Material", "Reason", "Won't Get", "Last Day", "Last Day Time", "Expected to Invoice Qty"];

    private static byte[] BuildWorkbook(
        (string Order, string Material, string Reason, string WontGet, string LastDay, string LastDayTime, string Qty)[] dataRows,
        (string Order, string Material, string BringForward)[]? nextMonthRows = null)
    {
        using var wb = new XLWorkbook();
        var dataWs = wb.Worksheets.Add("Data");
        for (var i = 0; i < DataHeaders.Length; i++) dataWs.Cell(1, i + 1).Value = DataHeaders[i];
        for (var i = 0; i < dataRows.Length; i++)
        {
            var r = dataRows[i];
            var row = i + 2;
            dataWs.Cell(row, 1).Value = r.Order;
            dataWs.Cell(row, 2).Value = r.Material;
            dataWs.Cell(row, 3).Value = r.Reason;
            dataWs.Cell(row, 4).Value = r.WontGet;
            dataWs.Cell(row, 5).Value = r.LastDay;
            dataWs.Cell(row, 6).Value = r.LastDayTime;
            dataWs.Cell(row, 7).Value = r.Qty;
        }

        if (nextMonthRows is not null)
        {
            var nmWs = wb.Worksheets.Add("Next Month");
            nmWs.Cell(1, 1).Value = "Order";
            nmWs.Cell(1, 2).Value = "Material";
            nmWs.Cell(1, 3).Value = "Bring Forward";
            for (var i = 0; i < nextMonthRows.Length; i++)
            {
                var r = nextMonthRows[i];
                var row = i + 2;
                nmWs.Cell(row, 1).Value = r.Order;
                nmWs.Cell(row, 2).Value = r.Material;
                nmWs.Cell(row, 3).Value = r.BringForward;
            }
        }

        using var stream = new MemoryStream();
        wb.SaveAs(stream);
        return stream.ToArray();
    }

    [Fact]
    public void ParseWorkbook_rejects_empty_file_content()
    {
        Assert.Throws<NexusValidationException>(() => OrderBookNotesUploadHelper.ParseWorkbook([]));
    }

    [Fact]
    public void ParseWorkbook_rejects_a_workbook_with_no_Data_sheet()
    {
        using var wb = new XLWorkbook();
        wb.Worksheets.Add("Sheet1");
        using var stream = new MemoryStream();
        wb.SaveAs(stream);

        Assert.Throws<NexusValidationException>(() => OrderBookNotesUploadHelper.ParseWorkbook(stream.ToArray()));
    }

    [Fact]
    public void ParseWorkbook_parses_a_Data_row_into_a_note_keyed_by_order_and_material()
    {
        var bytes = BuildWorkbook([("SO1", "M1", "Late delivery", "", "x", "15:00", "42")]);

        var rows = OrderBookNotesUploadHelper.ParseWorkbook(bytes);

        var note = Assert.Single(rows);
        Assert.Equal("SO1", note.ReferenceDocument);
        Assert.Equal("M1", note.Material);
        Assert.Equal("Late delivery", note.Reason);
        Assert.Null(note.WontGet);
        Assert.Equal("x", note.LastDay);
        Assert.Equal("15:00", note.LastDayTime);
        Assert.Equal("42", note.PlannedProductionQtyText);
        Assert.Null(note.BringForward);
    }

    [Fact]
    public void ParseWorkbook_skips_a_row_missing_Order_or_Material()
    {
        var bytes = BuildWorkbook([("", "M1", "x", "", "", "", ""), ("SO1", "", "x", "", "", "", "")]);

        var rows = OrderBookNotesUploadHelper.ParseWorkbook(bytes);

        Assert.Empty(rows);
    }

    [Fact]
    public void ParseWorkbook_treats_blank_cells_as_null_not_empty_string()
    {
        var bytes = BuildWorkbook([("SO1", "M1", "", "", "", "", "")]);

        var note = Assert.Single(OrderBookNotesUploadHelper.ParseWorkbook(bytes));

        Assert.Null(note.Reason);
        Assert.Null(note.WontGet);
        Assert.Null(note.LastDay);
        Assert.Null(note.LastDayTime);
        Assert.Null(note.PlannedProductionQtyText);
    }

    [Fact]
    public void ParseWorkbook_merges_a_NextMonth_BringForward_flag_into_an_existing_Data_row()
    {
        var bytes = BuildWorkbook(
            [("SO1", "M1", "Late delivery", "", "", "", "")],
            [("SO1", "M1", "x")]);

        var note = Assert.Single(OrderBookNotesUploadHelper.ParseWorkbook(bytes));

        Assert.Equal("x", note.BringForward);
        Assert.Equal("Late delivery", note.Reason); // untouched by the merge
    }

    [Fact]
    public void ParseWorkbook_creates_a_new_note_for_a_NextMonth_row_with_no_matching_Data_row()
    {
        var bytes = BuildWorkbook([], [("SO2", "M2", "x")]);

        var note = Assert.Single(OrderBookNotesUploadHelper.ParseWorkbook(bytes));

        Assert.Equal("SO2", note.ReferenceDocument);
        Assert.Equal("M2", note.Material);
        Assert.Equal("x", note.BringForward);
        Assert.Null(note.Reason);
    }

    [Fact]
    public void ParseWorkbook_ignores_a_missing_NextMonth_sheet()
    {
        var bytes = BuildWorkbook([("SO1", "M1", "x", "", "", "", "")]);

        var rows = OrderBookNotesUploadHelper.ParseWorkbook(bytes);

        Assert.Single(rows);
    }
}
