namespace NormantonNexus.Services.Auth;

/// <summary>JWT bearer authentication scheme name for the Month End Breakdown Excel macro's upload token — shared between Program.cs (registration) and every controller action that needs to accept it alongside the normal cookie session.</summary>
public static class OrderbookBearerScheme
{
    public const string Name = "OrderbookBearer";
}
