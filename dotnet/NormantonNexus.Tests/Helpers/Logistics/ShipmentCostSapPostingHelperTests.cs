using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class ShipmentCostSapPostingHelperTests
{
    [Fact]
    public async Task PostMigoAsync_rejects_an_empty_costIds_list_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostSapPostingHelper.PostMigoAsync(
                db.Object, Mock.Of<INexusDb>(), Mock.Of<ISapServerClient>(), Mock.Of<ISapCredentialCipher>(), [], 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public void Prefix2_returns_empty_for_null_or_blank_input()
    {
        Assert.Equal("", ShipmentCostSapPostingHelper.Prefix2(null));
        Assert.Equal("", ShipmentCostSapPostingHelper.Prefix2(""));
    }

    [Fact]
    public void Prefix2_upper_cases_and_truncates_to_two_characters()
    {
        Assert.Equal("GB", ShipmentCostSapPostingHelper.Prefix2("gb"));
        Assert.Equal("WF", ShipmentCostSapPostingHelper.Prefix2("wf6 1tn"));
    }

    [Fact]
    public void Prefix2_does_not_pad_a_single_character_value()
    {
        Assert.Equal("G", ShipmentCostSapPostingHelper.Prefix2("g"));
    }

    [Fact]
    public void ExtractSapErrorMessage_returns_the_fallback_when_the_exception_has_no_message()
    {
        var ex = new SapProxyException(502, "SAP_ERROR", "");

        Assert.Equal("fallback text", ShipmentCostSapPostingHelper.ExtractSapErrorMessage(ex, "fallback text"));
    }

    [Fact]
    public void ExtractSapErrorMessage_appends_PoMessages_detail_when_present()
    {
        var response = new SapCreatePoAndReceiptResponse("", false, [new SapReturnMessage("E", "Vendor 12345 does not exist")], []);
        var ex = new SapProxyException(400, "INVALID_DATA", "Purchase order creation failed.", response);

        var message = ShipmentCostSapPostingHelper.ExtractSapErrorMessage(ex, "fallback");

        Assert.Equal("Purchase order creation failed. [E] Vendor 12345 does not exist", message);
    }

    [Fact]
    public void ExtractSapErrorMessage_joins_multiple_messages_and_skips_blank_ones()
    {
        var response = new SapCreatePoAndReceiptResponse("", false,
            [new SapReturnMessage("E", "Cost center 4200 is locked"), new SapReturnMessage("", ""), new SapReturnMessage("W", "Second warning")], []);
        var ex = new SapProxyException(400, "INVALID_DATA", "Failed.", response);

        var message = ShipmentCostSapPostingHelper.ExtractSapErrorMessage(ex, "fallback");

        Assert.Equal("Failed. [E] Cost center 4200 is locked; [W] Second warning", message);
    }

    [Fact]
    public void ExtractSapErrorMessage_ignores_ResponseData_of_an_unrelated_type()
    {
        var ex = new SapProxyException(502, "SAP_ERROR", "Something failed.", "not the expected shape");

        Assert.Equal("Something failed.", ShipmentCostSapPostingHelper.ExtractSapErrorMessage(ex, "fallback"));
    }
}
