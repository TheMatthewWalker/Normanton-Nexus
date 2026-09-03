using NormantonNexus.Helpers.Production;
using SixLabors.ImageSharp;

namespace NormantonNexus.Tests.Helpers.Production;

// Unlike almost everything else touching SAP or SQL Server in this
// migration, barcode generation is pure managed code (ZXing.Net +
// SixLabors.ImageSharp, no OS-level graphics dependency) — genuinely
// testable for real in this sandbox, not just "compiles". These tests
// actually decode the produced PNG, not just check the call didn't throw.
public class LabelBarcodeHelperTests
{
    [Fact]
    public void BuildDataUri_produces_a_decodable_PNG_data_URI_for_a_real_batch_ref()
    {
        var uri = LabelBarcodeHelper.BuildDataUri("EX00000123");

        Assert.NotNull(uri);
        Assert.StartsWith("data:image/png;base64,", uri);

        var bytes = Convert.FromBase64String(uri!["data:image/png;base64,".Length..]);
        using var image = Image.Load(bytes);
        Assert.True(image.Width > 0);
        Assert.True(image.Height > 0);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void BuildDataUri_returns_null_for_empty_input(string? text)
    {
        Assert.Null(LabelBarcodeHelper.BuildDataUri(text));
    }

    [Fact]
    public void BuildDataUri_does_not_treat_whitespace_only_input_as_empty()
    {
        // Space is itself a valid Code 39 character (in both Node's regex
        // and this port's), so "   " isn't stripped down to nothing the way
        // punctuation-only input would be — it encodes as a real (if
        // useless) barcode, matching Node's real behavior exactly.
        Assert.NotNull(LabelBarcodeHelper.BuildDataUri("   "));
    }

    [Fact]
    public void BuildDataUri_strips_characters_Code39_cannot_encode_rather_than_throwing()
    {
        // Lowercase + punctuation Code 39 can't represent — mirrors Node's
        // barcodeBuffer regex (uppercases first, then strips), so a material
        // number like "k-nbr/70" still produces a real barcode of "K-NBR/70".
        var uri = LabelBarcodeHelper.BuildDataUri("k-nbr/70 (batch#1)");
        Assert.NotNull(uri);
    }
}
