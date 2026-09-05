using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Order Lookup + Drumming Ticket data loading — port of the corresponding
/// section of routes/productionnexus.js. See OrderLookupModels.cs's header
/// comment for why this searches log.AgreementSnapshot's OriginalDoc/
/// OriginalDocItem columns rather than the raw ReferenceDocument/Item ones.
/// DrummingTicketHtmlHelper (a separate, pure string-building class, same
/// split LabelHtmlHelper already established for the label-preview page)
/// renders what this Helper loads into the printable HTML page.
/// </summary>
internal static class OrderLookupHelper
{
    private const string AgreementLookupColumns = """
        Customer, CustomerName, OriginalDoc AS ReferenceDocument, OriginalDocItem AS Item, Material, MaterialText,
        CustomerMaterial, ValueStream,
        CAST(CONVERT(VARCHAR(8), RequestDate, 112) AS DATETIME) AS RequestDate,
        OrderQty, Uom,
        DockStockAllocated AS StockQty,
        (OrderQty - DockStockAllocated) AS RequiredQty
        """;

    internal static async Task<IReadOnlyList<AgreementLookupRow>> SearchAsync(INexusOperationsDb db, string? material, string? customer, CancellationToken ct)
    {
        material = material?.Trim();
        customer = customer?.Trim();
        if (string.IsNullOrEmpty(material) && string.IsNullOrEmpty(customer))
        {
            throw new NexusValidationException("Enter a part number or customer number to search.");
        }

        var conditions = new List<string>();
        if (!string.IsNullOrEmpty(material)) conditions.Add("Material LIKE @mat");
        if (!string.IsNullOrEmpty(customer)) conditions.Add("(Customer LIKE @cust OR CustomerName LIKE @custName)");

        var sql = $"""
            SELECT {AgreementLookupColumns}
            FROM log.AgreementSnapshot
            WHERE {string.Join(" AND ", conditions)}
            ORDER BY RequestDate, CustomerName, ReferenceDocument, Item
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<AgreementLookupRow>(new CommandDefinition(sql, new
        {
            mat = string.IsNullOrEmpty(material) ? null : $"%{material}%",
            cust = string.IsNullOrEmpty(customer) ? null : $"%{customer}%",
            custName = string.IsNullOrEmpty(customer) ? null : $"%{customer}%",
        }, cancellationToken: ct));
        return rows.ToArray();
    }

    /// <summary>Every open item on a specific order — backs the Make-to-Order wizard: operator enters an order number first, picks which item they're drumming, and material/customer auto-fill from the selected row.</summary>
    internal static async Task<IReadOnlyList<AgreementLookupRow>> GetByOrderAsync(INexusOperationsDb db, string orderNumber, CancellationToken ct)
    {
        var trimmed = orderNumber.Trim();

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = (await connection.QueryAsync<AgreementLookupRow>(new CommandDefinition($"""
            SELECT {AgreementLookupColumns}
            FROM log.AgreementSnapshot
            WHERE OriginalDoc = @orderNumber
            ORDER BY Item
            """, new { orderNumber = trimmed }, cancellationToken: ct))).ToArray();

        if (rows.Length == 0)
        {
            throw new NexusNotFoundException($"No open items found on order {trimmed}.");
        }
        return rows;
    }

    /// <summary>
    /// Combines the AgreementSnapshot line, the standing log.CustomerStandardInstructions
    /// text for the customer, and a live (deliberately uncached — "process
    /// critical", per the user's own instruction) SAP RFC_READ_TEXT lookup
    /// for the order's special-instructions text via SapServer's
    /// GET api/production/order-text/{salesDocument}/{item}. A SAP failure
    /// here is shown inline on the printed ticket rather than failing the
    /// whole page — mirrors Node's own try/catch around sapGet exactly.
    /// </summary>
    internal static async Task<DrummingTicketData> LoadTicketDataAsync(
        INexusOperationsDb db, ISapServerClient sap, string referenceDocument, string item, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var line = await connection.QuerySingleOrDefaultAsync<AgreementLookupRow>(new CommandDefinition($"""
            SELECT {AgreementLookupColumns}
            FROM log.AgreementSnapshot
            WHERE OriginalDoc = @referenceDocument AND OriginalDocItem = @item
            """, new { referenceDocument, item }, cancellationToken: ct));

        if (line is null)
        {
            throw new NexusNotFoundException($"No open order line found for {referenceDocument} / {item}.");
        }

        var customerStandardInstructions = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT Instructions FROM log.CustomerStandardInstructions WHERE Customer = @customer",
            new { customer = line.Customer }, cancellationToken: ct)) ?? "";

        string sapInstructions;
        try
        {
            sapInstructions = await sap.GetAsync<string>(
                $"api/production/order-text/{Uri.EscapeDataString(referenceDocument)}/{Uri.EscapeDataString(item)}", userId, ct: ct) ?? "";
        }
        catch (Exception err)
        {
            sapInstructions = $"[Could not reach SAP for special instructions: {err.Message}]";
        }

        return new DrummingTicketData(line, customerStandardInstructions, sapInstructions);
    }
}
