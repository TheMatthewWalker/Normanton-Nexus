using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// The shared metre-process (EX/CO/BR/CL/TW) Data tile — filterable
/// historical record listing, one Razor Page parameterized by process code
/// (`@page "{code}"`), same pattern as MetreEntry.cshtml. Distinct from
/// Open Entries, which is deliberately NOT given a standalone page — Open
/// Entries only exists in Node as the picker step of the draft→complete
/// two-step wizard (Complete Run), which is out of scope until Sub-phase
/// 6c; a standalone "view open entries" list with nothing to do once you
/// see one would be a page to nowhere. Data, by contrast, is a genuinely
/// self-contained filterable report in Node too (runMeterProcessData),
/// independent of the completion workflow — real, buildable scope now.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class MetreProcessDataModel : PageModel
{
    private static readonly Dictionary<string, string> Labels = new(StringComparer.OrdinalIgnoreCase)
    {
        ["EX"] = "Extrusion",
        ["CO"] = "Convoluting",
        ["BR"] = "Braiding",
        ["CL"] = "Coverline",
        ["TW"] = "Tape Wrap",
    };

    public string Code { get; private set; } = "";
    public string ProcessLabel { get; private set; } = "";

    public IActionResult OnGet(string code)
    {
        if (!Labels.TryGetValue(code, out var label))
        {
            return NotFound();
        }
        Code = code.ToUpperInvariant();
        ProcessLabel = label;
        return Page();
    }
}
