namespace NormantonNexus.Services;

public sealed class SapServerOptions
{
    public const string SectionName = "SapServer";

    public string Url { get; set; } = "";
    public string JwtSecret { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 30;

    /// <summary>Node's own equivalents use 3-10 minute timeouts for its heaviest individual SAP
    /// pulls (vendor GR history, the plant-wide MKOL stock scan) — this single shared value was
    /// left at a much shorter 120s "flagged, not silently widened" pending live confirmation
    /// (see dotnet/CLAUDE.md's Sub-phase 8e.2/8b.6 notes). Confirmed live: MrpAnalysisHistory's
    /// refresh (multi-year consumption/goods-receipt history across every ROH material) failed
    /// with "Timed out waiting for SapServer" at 120s while TurnsValClass's own SAP call (the
    /// larger of the two by row count) completed comfortably inside it — so this genuinely needs
    /// to be minutes, not a TurnsValClass-shaped call being unusually slow. Raised to 600s.</summary>
    public int LongRunningTimeoutSeconds { get; set; } = 600;
}

/// <summary>Wire shape of SapServer's own ApiResponse&lt;T&gt; envelope — see SapServer's Models/ApiResponse.cs.</summary>
public sealed record SapApiEnvelope<T>(bool Success, T? Data, SapApiErrorBody? Error);

public sealed record SapApiErrorBody(string Code, string Message);
