using System.Text.RegularExpressions;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using ZXing;
using ZXing.Common;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Code 39 barcode PNG generation for label previews — port of Node's
/// barcodeBuffer (routes/labels.js), which uses bwip-js. This uses ZXing.Net's
/// BarcodeWriterPixelData (pure managed, no OS-level graphics dependency —
/// unlike System.Drawing.Common, which needs libgdiplus on Linux and is
/// discouraged there post-.NET 6) to get raw BGRA32 pixel bytes, then
/// SixLabors.ImageSharp (also pure managed) to encode those into a real PNG.
/// Both packages are genuinely testable in this sandbox (no SAP NCo/Windows-
/// only dependency the way most of this migration's SAP-facing code has) —
/// LabelBarcodeHelperTests actually decodes the PNG header, not just checks
/// "didn't throw".
/// </summary>
internal static partial class LabelBarcodeHelper
{
    [GeneratedRegex(@"[^A-Z0-9\-\.\$/\+% ]")]
    private static partial Regex DisallowedCharacters();

    /// <summary>
    /// Returns a `data:image/png;base64,...` URI ready to drop straight into
    /// an `&lt;img src&gt;`, matching Node's `bcImg(b64(buf), heightMm)`
    /// convention (base64-embedded, not a separate image endpoint) — or null
    /// when the input has no encodable characters, mirroring Node's own
    /// `barcodeBuffer` returning null for an empty/unencodable value.
    /// </summary>
    internal static string? BuildDataUri(string? text)
    {
        var clean = DisallowedCharacters().Replace((text ?? "").ToUpperInvariant(), "");
        if (clean.Length == 0) return null;

        try
        {
            var writer = new BarcodeWriterPixelData
            {
                Format = BarcodeFormat.CODE_39,
                Options = new EncodingOptions
                {
                    Height = 90,
                    Width = clean.Length * 22 + 60,
                    Margin = 4,
                    PureBarcode = true,
                },
            };
            var pixelData = writer.Write(clean);

            using var image = Image.LoadPixelData<Bgra32>(pixelData.Pixels, pixelData.Width, pixelData.Height);
            using var ms = new MemoryStream();
            image.SaveAsPng(ms);
            return $"data:image/png;base64,{Convert.ToBase64String(ms.ToArray())}";
        }
        catch
        {
            // Matches Node's barcodeBuffer catch { return null; } — a
            // rendering failure must not take down the whole label.
            return null;
        }
    }
}
