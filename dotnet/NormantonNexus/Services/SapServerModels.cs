namespace NormantonNexus.Services;

public sealed class SapServerOptions
{
    public const string SectionName = "SapServer";

    public string Url { get; set; } = "";
    public string JwtSecret { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 30;
    public int LongRunningTimeoutSeconds { get; set; } = 120;
}

/// <summary>Wire shape of SapServer's own ApiResponse&lt;T&gt; envelope — see SapServer's Models/ApiResponse.cs.</summary>
public sealed record SapApiEnvelope<T>(bool Success, T? Data, SapApiErrorBody? Error);

public sealed record SapApiErrorBody(string Code, string Message);
