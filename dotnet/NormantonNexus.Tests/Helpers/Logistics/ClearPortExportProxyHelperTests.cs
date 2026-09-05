using System.Text.Json;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class ClearPortExportProxyHelperTests
{
    private static JsonElement Parse(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    [Fact]
    public void ValidatePayload_accepts_a_payload_with_at_least_one_item_and_an_exporter()
    {
        var payload = Parse("""{"items":[{"description":"Widget"}],"exporter":{"name":"Kongsberg"}}""");

        var ex = Record.Exception(() => ClearPortExportProxyHelper.ValidatePayload(payload));

        Assert.Null(ex);
    }

    [Fact]
    public void ValidatePayload_rejects_a_non_object_body()
    {
        var payload = Parse("""["not","an","object"]""");

        var ex = Assert.Throws<NexusValidationException>(() => ClearPortExportProxyHelper.ValidatePayload(payload));
        Assert.Contains("JSON object", ex.Message);
    }

    [Fact]
    public void ValidatePayload_rejects_a_missing_items_array()
    {
        var payload = Parse("""{"exporter":{"name":"Kongsberg"}}""");

        var ex = Assert.Throws<NexusValidationException>(() => ClearPortExportProxyHelper.ValidatePayload(payload));
        Assert.Contains("at least one item", ex.Message);
    }

    [Fact]
    public void ValidatePayload_rejects_an_empty_items_array()
    {
        var payload = Parse("""{"items":[],"exporter":{"name":"Kongsberg"}}""");

        Assert.Throws<NexusValidationException>(() => ClearPortExportProxyHelper.ValidatePayload(payload));
    }

    [Fact]
    public void ValidatePayload_rejects_items_that_is_not_an_array()
    {
        var payload = Parse("""{"items":"not-an-array","exporter":{"name":"Kongsberg"}}""");

        Assert.Throws<NexusValidationException>(() => ClearPortExportProxyHelper.ValidatePayload(payload));
    }

    [Fact]
    public void ValidatePayload_rejects_a_missing_exporter()
    {
        var payload = Parse("""{"items":[{"description":"Widget"}]}""");

        var ex = Assert.Throws<NexusValidationException>(() => ClearPortExportProxyHelper.ValidatePayload(payload));
        Assert.Contains("exporter", ex.Message);
    }

    [Fact]
    public void ValidatePayload_rejects_a_null_exporter()
    {
        var payload = Parse("""{"items":[{"description":"Widget"}],"exporter":null}""");

        Assert.Throws<NexusValidationException>(() => ClearPortExportProxyHelper.ValidatePayload(payload));
    }
}
