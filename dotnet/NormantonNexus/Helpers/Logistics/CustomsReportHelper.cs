using System.Globalization;
using ClosedXML.Excel;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// French VAT / DDP Customs Report — Logistics Sub-phase 8c.2. Port of
/// routes/customsreport.js in full: the user uploads a Shipments-style
/// extract (delivery/picksheet number, shipment ref, collection date,
/// weight — the only data that isn't already in SAP), this enriches every
/// delivery line via SapServer's api/customs/* endpoints (same shapes
/// SapCustomsDataHelper/8a.5c already established, extended here with
/// VBRK + the consignment-price fallback), apportions the manually-entered
/// weight across delivery lines exactly like the source workbook's own
/// SUMIFS/ROUND formula did, resolves VAT number/HS description fallbacks
/// via CustomsAdminHelper (Sub-phase 8c.1), and builds a finished
/// CUSTOMS-format .xlsx.
///
/// Single POST /generate request, stateless — nothing from an upload is
/// persisted. Partial/missing SAP data degrades a line to blank fields
/// rather than aborting the whole run (this report is reviewed by a human
/// before being sent on) — the one true hard-failure case is zero LIPS
/// rows returned for the whole uploaded batch, since there's nothing at
/// all to build a report from.
///
/// Unlike SapCustomsDataHelper's ClearPort use case (Sub-phase 8a.5c),
/// which genuinely can't proceed with partial data, every SAP round here
/// collects a warning and keeps going rather than throwing.
/// </summary>
internal static class CustomsReportHelper
{
    private static readonly string[] RequiredHeaders = ["PicksheetNumber", "ShipmentRef", "ActualCollectionDate", "TotalWeight"];

    // ── Pure helpers ──────────────────────────────────────────────────

    /// <summary>
    /// Strips SAP's zero-padding from a purely-numeric ID string (delivery
    /// number, item number, invoice number, consignee/customer code) so the
    /// report reads the same way the old workbook's macro output did
    /// ("82892007", not "0082892007") and so IDs from different SAP tables
    /// (differently padded on the way out of RFC_READ_TABLE) can be matched
    /// against each other and against the uploaded upload's own unpadded
    /// values.
    /// </summary>
    internal static string Digits(string? v)
    {
        var s = (v ?? "").Trim();
        if (s.Length == 0 || !s.All(char.IsDigit)) return s;
        var stripped = s.TrimStart('0');
        return stripped.Length == 0 ? "0" : stripped;
    }

    /// <summary>SAP date, in either format RFC_READ_TABLE hands back depending on the field and how it's read — DD.MM.YYYY (the calling session's display format) or the raw internal YYYYMMDD (a fallback in case a different field/call ever returns that instead) — or null.</summary>
    internal static DateTime? ParseSapDate(string? s)
    {
        var str = (s ?? "").Trim();
        if (str.Length == 0) return null;

        int year, month, day;
        if (str.Length == 10 && str[2] == '.' && str[5] == '.'
            && int.TryParse(str[..2], out day) && int.TryParse(str[3..5], out month) && int.TryParse(str[6..], out year))
        {
            // matched DD.MM.YYYY above
        }
        else if (str.Length == 8 && str.All(char.IsDigit))
        {
            year = int.Parse(str[..4]);
            month = int.Parse(str[4..6]);
            day = int.Parse(str[6..8]);
        }
        else
        {
            return null;
        }

        if (year == 0 || month == 0 || day == 0) return null;
        try { return new DateTime(year, month, day); }
        catch (ArgumentOutOfRangeException) { return null; }
    }

    /// <summary>
    /// SAP's RFC_READ_TABLE returns numeric fields (KCMENG, RFWRT, KBETR,
    /// KPEIN, ...) as character strings in the calling session's display
    /// format — European-style grouping, e.g. "2.748,000" for 2748 — not
    /// plain machine-parseable numbers. Strips "." thousands separators,
    /// then swaps the "," decimal separator for a ".".
    ///
    /// This is a faithful port of Node's own parseSapNumber, including its
    /// known limitation: it always assumes European grouping, so a plain
    /// invariant-culture value with no thousands separator at all (e.g.
    /// "1234.56") would be mis-parsed — see SapServer/CLAUDE.md's own
    /// decimal-parsing bug writeup for the general shape of this issue, and
    /// ClearPortShipmentPayloadHelper.ParseEuropeanDecimal for the same
    /// faithful-port precedent already used elsewhere in this exact
    /// department. Not "fixed" here to stay consistent with that precedent
    /// and because this method's real-world inputs (RFC_READ_TABLE's own
    /// character-format numeric columns) are confirmed European-grouped in
    /// practice for this SAP system.
    /// </summary>
    internal static decimal ParseSapNumber(string? s)
    {
        var str = (s ?? "").Trim();
        if (str.Length == 0) return 0m;
        var normalized = str.Replace(".", "").Replace(',', '.');
        return decimal.TryParse(normalized, NumberStyles.Number, CultureInfo.InvariantCulture, out var n) ? n : 0m;
    }

    // ── 1. Parse the uploaded Shipments-sheet columns A:D ────────────

    internal static IReadOnlyList<CustomsShipmentUploadRow> ParseShipmentsUpload(byte[] fileBytes)
    {
        using var stream = new MemoryStream(fileBytes);
        using var wb = new XLWorkbook(stream);

        var ws = wb.Worksheets.TryGetWorksheet("Shipments", out var namedWs) ? namedWs : wb.Worksheets.FirstOrDefault();
        if (ws is null)
            throw new NexusValidationException("The uploaded file has no worksheets.");

        var headerMap = BuildHeaderMap(ws.Row(1));
        var missing = RequiredHeaders.Where(h => !headerMap.ContainsKey(h)).ToList();
        if (missing.Count > 0)
            throw new NexusValidationException(
                $"Missing expected column(s): {string.Join(", ", missing)}. Expected columns A:D = {string.Join(", ", RequiredHeaders)}, same layout as the Shipments tab of the old AT_Customs workbook.");

        var rows = new List<CustomsShipmentUploadRow>();
        var lastRow = ws.LastRowUsed()?.RowNumber() ?? 1;
        for (var rowNumber = 2; rowNumber <= lastRow; rowNumber++)
        {
            var row = ws.Row(rowNumber);
            var picksheetNumber = ReadCellText(row, headerMap["PicksheetNumber"]);
            if (picksheetNumber.Length == 0) continue;

            rows.Add(new CustomsShipmentUploadRow(
                picksheetNumber,
                ReadCellText(row, headerMap["ShipmentRef"]),
                ReadCellDate(row, headerMap["ActualCollectionDate"]),
                ReadCellNumber(row, headerMap["TotalWeight"])));
        }

        return rows;
    }

    private static Dictionary<string, int> BuildHeaderMap(IXLRow headerRow)
    {
        var map = new Dictionary<string, int>();
        foreach (var cell in headerRow.CellsUsed())
        {
            var text = cell.GetString().Trim();
            if (text.Length > 0) map[text] = cell.Address.ColumnNumber;
        }
        return map;
    }

    private static string ReadCellText(IXLRow row, int colNumber)
    {
        if (colNumber <= 0) return "";
        var cell = row.Cell(colNumber);
        if (cell.IsEmpty()) return "";
        if (cell.DataType == XLDataType.DateTime) return cell.GetDateTime().ToString("yyyy-MM-dd");
        return cell.GetString().Trim();
    }

    private static decimal ReadCellNumber(IXLRow row, int colNumber)
    {
        if (colNumber <= 0) return 0m;
        var cell = row.Cell(colNumber);
        if (cell.IsEmpty()) return 0m;
        if (cell.DataType == XLDataType.Number) return (decimal)cell.GetDouble();
        return decimal.TryParse(cell.GetString().Trim(), NumberStyles.Number, CultureInfo.InvariantCulture, out var n) ? n : 0m;
    }

    private static DateTime? ReadCellDate(IXLRow row, int colNumber)
    {
        if (colNumber <= 0) return null;
        var cell = row.Cell(colNumber);
        if (cell.IsEmpty()) return null;
        if (cell.DataType == XLDataType.DateTime) return cell.GetDateTime();
        var s = cell.GetString().Trim();
        if (s.Length == 0) return null;
        return DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;
    }

    // ── 2. SAP enrichment (3 rounds) ──────────────────────────────────

    internal static async Task<CustomsReportSapData> FetchSapDataAsync(ISapServerClient sap, IReadOnlyList<string> deliveryNumbers, int userId, CancellationToken ct)
    {
        var warnings = new List<string>();

        // Round 1 — parallel: LIPS (line items) + LIKP (header: incoterms, consignee).
        var lipsTask = SapPostArray<LipsRow>(sap, "api/customs/lips", new { deliveries = deliveryNumbers }, "LIPS", userId, warnings, ct);
        var likpTask = SapPostArray<LikpRow>(sap, "api/customs/likp", new { deliveries = deliveryNumbers }, "LIKP", userId, warnings, ct);
        await Task.WhenAll(lipsTask, likpTask);
        var lipsData = lipsTask.Result;
        var likpData = likpTask.Result;

        if (lipsData.Count == 0)
        {
            var reason = warnings.Count > 0 ? $" ({string.Join("; ", warnings)})" : "";
            throw new NexusUnprocessableEntityException(
                $"SAP returned no delivery line items (LIPS) for any of the uploaded delivery numbers{reason}. Verify the delivery numbers exist in SAP with plant 3012 and quantity > 0.");
        }

        // Round 2 — parallel: VBFA (invoice/stat value/date) + MARC (commodity/origin) + KNA1 (name/country/VAT).
        var lineItems = lipsData.Select(r => new { delivery = r.DeliveryNumber, item = r.ItemNumber }).ToList();
        var materials = lipsData.Select(r => (r.MaterialNumber ?? "").Trim()).Where(m => m.Length > 0).Distinct().ToList();
        var customers = likpData.Select(r => (r.ConsigneeCode ?? "").Trim()).Where(c => c.Length > 0).Distinct().ToList();

        var vbfaTask = SapPostArray<VbfaRow>(sap, "api/customs/vbfa", new { lines = lineItems }, "VBFA", userId, warnings, ct);
        var marcTask = materials.Count > 0 ? SapPostArray<MarcRow>(sap, "api/customs/marc", new { materials }, "MARC", userId, warnings, ct) : Task.FromResult<List<MarcRow>>([]);
        var kna1Task = customers.Count > 0 ? SapPostArray<Kna1Row>(sap, "api/customs/kna1", new { customers }, "KNA1", userId, warnings, ct) : Task.FromResult<List<Kna1Row>>([]);
        await Task.WhenAll(vbfaTask, marcTask, kna1Task);
        var vbfaData = vbfaTask.Result;

        // Round 3 — VBRK (currency), keyed by invoice numbers found in round 2. Invoice
        // Date comes from VBFA.invoiceDate (ERDAT) in round 2 instead — that's the field
        // the source workbook macro's own VBFA_Lookup routine actually reads for it.
        var invoices = vbfaData.Select(r => Digits(r.InvoiceNumber)).Where(i => i.Length > 0).Distinct().ToList();
        var vbrkData = invoices.Count > 0 ? await SapPostArray<VbrkRow>(sap, "api/customs/vbrk", new { invoices }, "VBRK", userId, warnings, ct) : [];

        return new CustomsReportSapData(lipsData, likpData, vbfaData, marcTask.Result, kna1Task.Result, vbrkData, warnings);
    }

    /// <summary>
    /// Never throws — a failed round (network error, non-2xx, or a
    /// body-level failure) becomes a pushed warning and an empty array
    /// instead, matching Node's own sapPostArray exactly: callers decide
    /// what "nothing came back" means for that round.
    /// </summary>
    private static async Task<List<T>> SapPostArray<T>(ISapServerClient sap, string path, object body, string label, int userId, List<string> warnings, CancellationToken ct)
    {
        try
        {
            var result = await sap.PostAsync<List<T>>(path, body, userId, ct: ct);
            return result ?? [];
        }
        catch (Exception ex)
        {
            warnings.Add($"{label} query failed: {ex.Message}");
            return [];
        }
    }

    /// <summary>
    /// Consignment-customer fallback: for report lines with no VBFA invoice
    /// (goods shipped without a commercial invoice), look up a customs
    /// sales price via SAP's pricing-condition tables instead. Failures
    /// here are silent by design (an empty list) — this is itself a
    /// fallback within a fallback; a hard failure of the whole request over
    /// this one lookup would be disproportionate.
    /// </summary>
    private static async Task<List<ConsignmentPriceRow>> FetchConsignmentPricesAsync(ISapServerClient sap, IReadOnlyList<(string ConsigneeCode, string Material)> pairs, int userId, CancellationToken ct)
    {
        if (pairs.Count == 0) return [];
        try
        {
            var lines = pairs.Select(p => new { customer = p.ConsigneeCode, material = p.Material }).ToList();
            return await sap.PostAsync<List<ConsignmentPriceRow>>("api/customs/consignment-price", new { lines }, userId, ct: ct) ?? [];
        }
        catch
        {
            return [];
        }
    }

    // ── 3. Assemble CUSTOMS-shaped rows ───────────────────────────────

    internal static async Task<CustomsReportResult> BuildReportRowsAsync(INexusOperationsDb db, ISapServerClient sap, IReadOnlyList<CustomsShipmentUploadRow> shipmentRows, CustomsReportSapData sapData, int userId, CancellationToken ct)
    {
        var warnings = new List<string>(sapData.Warnings);

        var likpByDelivery = sapData.LikpData.ToDictionary(r => Digits(r.DeliveryNumber), r => r, StringComparer.Ordinal);
        var marcByMaterial = sapData.MarcData.ToDictionary(r => (r.MaterialNumber ?? "").Trim(), r => r, StringComparer.Ordinal);
        var kna1ByCustomer = sapData.Kna1Data.ToDictionary(r => Digits(r.CustomerCode), r => r, StringComparer.Ordinal);
        var vbrkByInvoice = sapData.VbrkData.ToDictionary(r => Digits(r.InvoiceNumber), r => r, StringComparer.Ordinal);
        var vbfaByLine = sapData.VbfaData.ToDictionary(r => $"{Digits(r.DeliveryNumber)}||{Digits(r.ItemNumber)}", r => r, StringComparer.Ordinal);

        // Sum TotalWeight per delivery (matches Excel SUMIFS semantics if the same
        // PicksheetNumber legitimately appears more than once in the upload); keep the
        // first ShipmentRef/ActualCollectionDate seen for that delivery.
        var shipmentByDelivery = new Dictionary<string, (string ShipmentRef, DateTime? ActualCollectionDate, decimal TotalWeight)>(StringComparer.Ordinal);
        foreach (var s in shipmentRows)
        {
            var key = Digits(s.PicksheetNumber);
            if (shipmentByDelivery.TryGetValue(key, out var existing))
                shipmentByDelivery[key] = existing with { TotalWeight = existing.TotalWeight + s.TotalWeight };
            else
                shipmentByDelivery[key] = (s.ShipmentRef, s.ActualCollectionDate, s.TotalWeight);
        }

        var foundDeliveries = sapData.LipsData.Select(r => Digits(r.DeliveryNumber)).ToHashSet(StringComparer.Ordinal);
        foreach (var s in shipmentRows)
        {
            if (!foundDeliveries.Contains(Digits(s.PicksheetNumber)))
                warnings.Add($"Delivery {s.PicksheetNumber}: no line items found in SAP (LIPS) — check the delivery number and plant.");
        }

        var rows = sapData.LipsData.Select(lipsRow =>
        {
            var deliveryKey = Digits(lipsRow.DeliveryNumber);
            var itemKey = Digits(lipsRow.ItemNumber);
            likpByDelivery.TryGetValue(deliveryKey, out var likpRow);
            vbfaByLine.TryGetValue($"{deliveryKey}||{itemKey}", out var vbfaRow);
            marcByMaterial.TryGetValue((lipsRow.MaterialNumber ?? "").Trim(), out var marcRow);
            var consigneeKey = likpRow is not null ? Digits(likpRow.ConsigneeCode) : "";
            Kna1Row? kna1Row = consigneeKey.Length > 0 && kna1ByCustomer.TryGetValue(consigneeKey, out var k) ? k : null;
            var invoiceKey = vbfaRow is not null ? Digits(vbfaRow.InvoiceNumber) : null;
            VbrkRow? vbrkRow = invoiceKey is { Length: > 0 } && vbrkByInvoice.TryGetValue(invoiceKey, out var vb) ? vb : null;
            shipmentByDelivery.TryGetValue(deliveryKey, out var shipment);

            return new CustomsReportRow
            {
                DeliveryNumber = deliveryKey,
                ItemNumber = itemKey,
                Material = (lipsRow.MaterialNumber ?? "").Trim(),
                Quantity = ParseSapNumber(lipsRow.Quantity),
                InvoiceNumber = vbfaRow is not null ? Digits(vbfaRow.InvoiceNumber) : "",
                Currency = vbrkRow?.Currency?.Trim() ?? "",
                SalesValue = vbfaRow is not null ? ParseSapNumber(vbfaRow.StatisticalValue) : null,
                CommodityCode = marcRow?.CommodityCode?.Trim() ?? "",
                CountryOfOrigin = marcRow?.CountryOfOrigin?.Trim() ?? "",
                Incoterms = likpRow?.Incoterms?.Trim() ?? "",
                ConsigneeCode = consigneeKey,
                Name = kna1Row?.Name?.Trim() ?? "",
                VatNumber = kna1Row?.VatNumber?.Trim() ?? "", // override fallback resolved below
                ShipmentRef = shipment.ShipmentRef ?? "",
                InvoiceDate = vbfaRow is not null ? ParseSapDate(vbfaRow.InvoiceDate) : null,
                ShipmentDate = shipment.ActualCollectionDate,
            };
        }).ToList();

        // Consignment fallback — any row with no invoice at all (VBFA had nothing) gets
        // a customs sales price from SAP's pricing-condition tables instead, keyed by
        // (consignee, material).
        var consignmentCandidates = rows.Where(r => r.InvoiceNumber.Length == 0 && r.ConsigneeCode.Length > 0 && r.Material.Length > 0).ToList();
        if (consignmentCandidates.Count > 0)
        {
            var uniquePairs = consignmentCandidates
                .Select(r => (r.ConsigneeCode, r.Material))
                .Distinct()
                .ToList();
            var priceRows = await FetchConsignmentPricesAsync(sap, uniquePairs, userId, ct);
            var priceByPair = priceRows.ToDictionary(p => $"{Digits(p.CustomerCode)}||{(p.MaterialNumber ?? "").Trim()}", p => p, StringComparer.Ordinal);

            foreach (var row in consignmentCandidates)
            {
                // No real invoice exists for a consignment shipment — the delivery number
                // itself is used as the placeholder Invoice Number regardless of whether a
                // customs price is found below, matching the workbook macro's own behavior.
                // Invoice Date falls back to the delivery's own goods issue date
                // (LIKP-WADAT_IST) instead — there's no VBFA billing document (and so no
                // ERDAT) for a consignment shipment to source a date from otherwise.
                row.InvoiceNumber = row.DeliveryNumber;
                likpByDelivery.TryGetValue(row.DeliveryNumber, out var likpRow);
                row.InvoiceDate = likpRow is not null ? ParseSapDate(likpRow.GoodsIssueDate) : null;

                if (priceByPair.TryGetValue($"{row.ConsigneeCode}||{row.Material}", out var price))
                {
                    var rate = ParseSapNumber(price.Rate);
                    var pricingUnit = ParseSapNumber(price.PricingUnit) is var pu && pu != 0 ? pu : 1m;
                    row.Currency = price.Currency?.Trim() ?? "";
                    row.SalesValue = Math.Round(rate / pricingUnit * row.Quantity, 2);
                }
                else
                {
                    warnings.Add($"Delivery {row.DeliveryNumber} / Material {row.Material}: no invoice and no consignment price found in SAP.");
                }
            }
        }

        // VAT number / HS description fallbacks — SAP-first, override-table-second.
        // Cached per key so a repeated consignee/commodity code across many lines only
        // costs one DB lookup.
        var vatCache = new Dictionary<string, string?>(StringComparer.Ordinal);
        var hsCache = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            if (row.VatNumber.Length == 0 && row.ConsigneeCode.Length > 0)
            {
                if (!vatCache.TryGetValue(row.ConsigneeCode, out var vat))
                {
                    vat = await CustomsAdminHelper.LookupVatOverrideAsync(db, row.ConsigneeCode, ct);
                    vatCache[row.ConsigneeCode] = vat;
                }
                row.VatNumber = vat ?? "";
            }
            if (row.CommodityCode.Length > 0)
            {
                if (!hsCache.TryGetValue(row.CommodityCode, out var hs))
                {
                    hs = await CustomsAdminHelper.LookupHsDescriptionAsync(db, row.CommodityCode, ct);
                    hsCache[row.CommodityCode] = hs;
                }
                row.HsDescription = hs ?? "";
            }
        }

        return new CustomsReportResult(rows, warnings);
    }

    // ── 4. Weight apportionment ────────────────────────────────────────
    // Replicates the workbook's exact formula:
    //   ROUND(SUMIFS(Shipments!TotalWeight, Shipments!PicksheetNumber, thisDelivery)
    //         / SUMIFS(CUSTOMS!Quantity, CUSTOMS!DeliveryNumber, thisDelivery)
    //         * thisLineQuantity, 2)

    internal static void ApportionWeights(IReadOnlyList<CustomsReportRow> reportLines, IReadOnlyDictionary<string, decimal> weightByDelivery)
    {
        var byDelivery = reportLines.GroupBy(l => l.DeliveryNumber, StringComparer.Ordinal);
        foreach (var group in byDelivery)
        {
            var lines = group.ToList();
            var totalWeight = weightByDelivery.GetValueOrDefault(group.Key);
            var totalQty = lines.Sum(l => l.Quantity);
            foreach (var line in lines)
                line.Weight = totalQty > 0 ? Math.Round(totalWeight / totalQty * line.Quantity, 2) : null;
        }
    }

    // ── 5. Build the .xlsx ─────────────────────────────────────────────

    private static readonly (string Header, Func<CustomsReportRow, object?> Value)[] ReportColumns =
    [
        ("Delivery Number", r => r.DeliveryNumber),
        ("Delivery Item", r => r.ItemNumber),
        ("Material", r => r.Material),
        ("Quantity", r => r.Quantity),
        ("Invoice Number", r => r.InvoiceNumber),
        ("Currency", r => r.Currency),
        ("Sales Value", r => r.SalesValue),
        ("Commodity Code", r => r.CommodityCode),
        ("Country of Origin", r => r.CountryOfOrigin),
        ("Incoterms", r => r.Incoterms),
        ("Consignee Code", r => r.ConsigneeCode),
        ("Name", r => r.Name),
        ("HS Description", r => r.HsDescription),
        ("VAT No.", r => r.VatNumber),
        ("Shipment Ref", r => r.ShipmentRef),
        ("Invoice Date", r => r.InvoiceDate),
        ("Shipment Date", r => r.ShipmentDate),
        ("Weight", r => r.Weight),
    ];

    internal static byte[] BuildWorkbook(IReadOnlyList<CustomsReportRow> rows, IReadOnlyList<string> warnings)
    {
        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("CUSTOMS");

        for (var i = 0; i < ReportColumns.Length; i++)
        {
            var cell = ws.Cell(1, i + 1);
            cell.Value = ReportColumns[i].Header;
            StyleHeaderCell(cell);
        }
        ws.Row(1).Height = 22;

        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            var rowNumber = i + 2;
            for (var c = 0; c < ReportColumns.Length; c++)
            {
                var cell = ws.Cell(rowNumber, c + 1);
                var value = ReportColumns[c].Value(row);
                switch (value)
                {
                    case DateTime dt: cell.Value = dt; break;
                    case decimal dec: cell.Value = dec; break;
                    case null: cell.Value = ""; break;
                    default: cell.Value = value.ToString(); break;
                }
                StyleDataCell(cell, i);
            }
        }

        ws.Columns(1, ReportColumns.Length).AdjustToContents(1, rows.Count + 1);
        foreach (var col in ws.Columns(1, ReportColumns.Length))
            if (col.Width > 52) col.Width = 52;

        ws.SheetView.FreezeRows(1);
        ws.RangeUsed()?.SetAutoFilter();

        if (warnings.Count > 0)
        {
            var warnWs = wb.Worksheets.Add("Warnings");
            var headerCell = warnWs.Cell(1, 1);
            headerCell.Value = "Warning";
            StyleHeaderCell(headerCell);
            for (var i = 0; i < warnings.Count; i++)
            {
                var cell = warnWs.Cell(i + 2, 1);
                cell.Value = warnings[i];
                StyleDataCell(cell, i);
            }
            warnWs.Column(1).Width = 100;
        }

        using var stream = new MemoryStream();
        wb.SaveAs(stream);
        return stream.ToArray();
    }

    private static void StyleHeaderCell(IXLCell cell)
    {
        cell.Style.Fill.BackgroundColor = XLColor.FromArgb(0x1F, 0x38, 0x64);
        cell.Style.Font.FontColor = XLColor.White;
        cell.Style.Font.Bold = true;
        cell.Style.Font.FontName = "Arial";
        cell.Style.Font.FontSize = 10;
        cell.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
        cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Left;
        cell.Style.Border.OutsideBorder = XLBorderStyleValues.Thin;
    }

    private static void StyleDataCell(IXLCell cell, int index)
    {
        cell.Style.Fill.BackgroundColor = index % 2 == 0 ? XLColor.FromArgb(0xE9, 0xEE, 0xF4) : XLColor.White;
        cell.Style.Font.FontName = "Arial";
        cell.Style.Font.FontSize = 10;
        cell.Style.Border.OutsideBorder = XLBorderStyleValues.Thin;
    }
}
