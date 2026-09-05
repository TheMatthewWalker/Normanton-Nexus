using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// The shared metre-process (EX/CO/BR/CL/TW) entry tile — one Razor Page
/// parameterized by process code (`@page "{code}"`) rather than 5 near-
/// duplicate page files, mirroring Node's own single runMeterProcessEntry()
/// engine backing all 5 tiles. SCOPE NOTE: only the direct one-step entry
/// is built here — Data (MetreProcessData.cshtml) is a separate later
/// slice. Open Entries has no standalone frontend at all, deliberately —
/// it only exists in Node as the picker step of the draft→complete
/// two-step wizard (Complete Run), out of scope until Sub-phase 6c — see
/// dotnet/CLAUDE.md's Phase 6 notes.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class MetreEntryModel : PageModel
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
