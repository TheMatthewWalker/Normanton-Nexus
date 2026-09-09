using NormantonNexus.Helpers.Logistics;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class ShipmentCollectionEmailHelperTests
{
    [Fact]
    public void SplitBase64Lines_returns_the_input_unchanged_when_shorter_than_one_line()
    {
        Assert.Equal("YWJj", ShipmentCollectionEmailHelper.SplitBase64Lines("YWJj"));
    }

    [Fact]
    public void SplitBase64Lines_does_not_split_a_string_exactly_76_characters_long()
    {
        var value = new string('A', 76);

        Assert.Equal(value, ShipmentCollectionEmailHelper.SplitBase64Lines(value));
    }

    [Fact]
    public void SplitBase64Lines_splits_every_76_characters_with_CRLF()
    {
        var value = new string('A', 80);

        var result = ShipmentCollectionEmailHelper.SplitBase64Lines(value);

        Assert.Equal(new string('A', 76) + "\r\n" + new string('A', 4), result);
    }

    [Fact]
    public void SplitBase64Lines_handles_several_full_lines_plus_a_remainder()
    {
        var value = new string('B', 200);

        var result = ShipmentCollectionEmailHelper.SplitBase64Lines(value);
        var lines = result.Split("\r\n");

        Assert.Equal(3, lines.Length);
        Assert.Equal(76, lines[0].Length);
        Assert.Equal(76, lines[1].Length);
        Assert.Equal(48, lines[2].Length);
    }

    [Fact]
    public void BuildCollectionEmailBody_includes_the_shipment_ref_and_uses_CRLF_line_endings()
    {
        var body = ShipmentCollectionEmailHelper.BuildCollectionEmailBody("00000042");

        Assert.Contains("Ref: 00000042", body);
        Assert.DoesNotContain("\r\n\r\n\r\n", body);
        Assert.Equal(body.Count(c => c == '\n'), body.Count(c => c == '\r'));
    }

    [Fact]
    public void BuildMimeMessage_produces_a_well_formed_multipart_message_with_one_PDF_attachment()
    {
        var message = ShipmentCollectionEmailHelper.BuildMimeMessage(
            "logistics@kongsberg.example", ["customer@example.com"], ["cc@example.com"], "Test subject", "Test body",
            [("00000042.pdf", [1, 2, 3, 4])]);

        Assert.Contains("From: logistics@kongsberg.example", message);
        Assert.Contains("To: customer@example.com", message);
        Assert.Contains("Cc: cc@example.com", message);
        Assert.Contains("Subject: Test subject", message);
        Assert.Contains("MIME-Version: 1.0", message);
        Assert.Contains("Content-Type: multipart/mixed; boundary=", message);
        Assert.Contains("Content-Type: application/pdf; name=\"00000042.pdf\"", message);
        Assert.Contains("Content-Disposition: attachment; filename=\"00000042.pdf\"", message);
        Assert.Contains(Convert.ToBase64String([1, 2, 3, 4]), message);
        Assert.Contains("Test body", message);
        Assert.EndsWith("--\r\n", message);
    }

    [Fact]
    public void BuildMimeMessage_omits_the_Cc_header_entirely_when_there_is_no_cc()
    {
        var message = ShipmentCollectionEmailHelper.BuildMimeMessage(
            "from@example.com", ["to@example.com"], [], "Subject", "Body", []);

        Assert.DoesNotContain("Cc:", message);
    }
}
