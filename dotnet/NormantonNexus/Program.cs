using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using NormantonNexus.Data;
using NormantonNexus.Middleware;
using NormantonNexus.Services;
using NormantonNexus.Services.Admin;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Notifications;
using NormantonNexus.Services.Sql;

// Required since QuestPDF 2023's licensing change, or Document.GeneratePdf()
// throws — see Helpers/Production/LabelPdfHelper.cs / NormantonNexus.csproj's
// QuestPDF comment. Community is free for this app's use case.
QuestPDF.Settings.License = QuestPDF.Infrastructure.LicenseType.Community;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorPages()
    .AddMvcOptions(options => options.Filters.Add<MustChangePasswordPageFilter>());
builder.Services.AddControllers();

builder.Services.Configure<AuthOptions>(builder.Configuration.GetSection(AuthOptions.SectionName));

// Migration tooling only — see Data/NexusMigrationContext.cs. Runtime queries
// (below) go through Dapper against the same three databases.
builder.Services.AddDbContext<NexusMigrationContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Nexus")));

// Stateless connection factories (just a captured connection string — see
// Services/Sql/SqlConnectionFactory.cs), safe as singletons; also lets the
// cookie-auth ticket store (configured below, itself a singleton) depend on
// INexusDb directly without needing a per-call DI scope.
builder.Services.AddSingleton<INexusDb, NexusDb>();
builder.Services.AddSingleton<INexusOperationsDb, NexusOperationsDb>();
builder.Services.AddSingleton<INexusArchiveDb, NexusArchiveDb>();

builder.Services.AddSingleton<IIdleTimeoutPolicy, IdleTimeoutPolicy>();
builder.Services.AddSingleton<ITicketStore, PortalSessionStore>();

builder.Services.AddScoped<IPermissionResolver, PermissionResolver>();
builder.Services.AddScoped<IAuditLogger, AuditLogger>();
builder.Services.AddScoped<IAuthService, AuthService>();
builder.Services.AddScoped<IPermissionGroupAdminService, PermissionGroupAdminService>();
builder.Services.AddScoped<INotificationService, NotificationService>();
builder.Services.AddScoped<IDataChangeLogService, DataChangeLogService>();
builder.Services.AddSingleton<IOrderbookTokenService, OrderbookTokenService>();

builder.Services.Configure<SapServerOptions>(builder.Configuration.GetSection(SapServerOptions.SectionName));
builder.Services.Configure<LogisticsOptions>(builder.Configuration.GetSection(LogisticsOptions.SectionName));
builder.Services.AddHttpClient<ISapServerClient, SapServerClient>();

builder.Services.Configure<ClearPortOptions>(builder.Configuration.GetSection(ClearPortOptions.SectionName));
builder.Services.AddHttpClient<IClearPortClient, ClearPortClient>();

builder.Services.Configure<LabelPrinterOptions>(builder.Configuration.GetSection(LabelPrinterOptions.SectionName));

builder.Services.Configure<SapCredentialOptions>(builder.Configuration.GetSection(SapCredentialOptions.SectionName));
builder.Services.AddSingleton<ISapCredentialCipher, SapCredentialCipher>();

builder.Services.AddAuthentication(NexusAuthScheme.Name)
    .AddCookie(NexusAuthScheme.Name, options =>
    {
        options.Cookie.Name = "nnx_session";
        options.Cookie.HttpOnly = true;
        // Always in Production (real deployment is behind IIS/HTTPS, and this
        // is session-authentication state — no reason to ever allow it over
        // plain HTTP there). SameAsRequest in every other environment so a
        // plain `dotnet run` + http://localhost smoke test (this app's own
        // launchSettings.json only defines an "http" profile) actually gets
        // the cookie back on the next request instead of silently never
        // persisting a session — Always would set the Secure flag even over
        // HTTP, and browsers refuse to send it back on a non-HTTPS request.
        options.Cookie.SecurePolicy = builder.Environment.IsProduction()
            ? CookieSecurePolicy.Always
            : CookieSecurePolicy.SameAsRequest;
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.LoginPath = "/Login";
        options.AccessDeniedPath = "/AccessDenied";

        // The real, per-user expiry is set on every request by
        // IdleTimeoutValidation.OnValidatePrincipal below (30 min default /
        // 5 min ShortIdleTimeout, matching config.js's idleTimeoutMsFor) —
        // this ExpireTimeSpan is only the fallback used before the first
        // validation ever runs. SlidingExpiration is off because we do our
        // own unconditional per-request extension instead of the framework's
        // "renew after half the window has elapsed" default, matching
        // server.js's middleware resetting cookie.maxAge on every request.
        options.ExpireTimeSpan = TimeSpan.FromMinutes(30);
        options.SlidingExpiration = false;

        options.Events.OnValidatePrincipal = IdleTimeoutValidation.OnValidatePrincipal;
    })
    // Second scheme, checked only where a controller action explicitly opts in via
    // [Authorize(AuthenticationSchemes = $"{NexusAuthScheme.Name},{OrderbookBearerScheme.Name}")]
    // (multiple schemes on one [Authorize] is an OR in ASP.NET Core — either succeeding
    // authenticates the request) — the C# equivalent of middleware/auth.js's
    // requireSessionOrApiToken (session cookie OR this bearer token), backing the Month
    // End Breakdown Excel macro's upload route (PerformanceController.UploadOrderBookLineNotes,
    // Sub-phase 8b.6). Deliberately narrow: this scheme is registered but never added to
    // the default challenge/forbid scheme, so it has zero effect on every other route in
    // the app unless a controller action names it explicitly.
    .AddJwtBearer(OrderbookBearerScheme.Name, options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidIssuer = OrderbookTokenService.Issuer,
            ValidAudience = OrderbookTokenService.Audience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(
                builder.Configuration.GetSection(SapServerOptions.SectionName)[nameof(SapServerOptions.JwtSecret)] ?? "")),
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });

// SessionStore must be wired via a post-configure so it can come from DI
// (ITicketStore is registered above) rather than being constructed inline
// during AddCookie's own options delegate.
builder.Services.AddOptions<CookieAuthenticationOptions>(NexusAuthScheme.Name)
    .Configure<ITicketStore>((options, store) => options.SessionStore = store);

builder.Services.AddSingleton<IAuthorizationPolicyProvider, NexusPolicyProvider>();
builder.Services.AddSingleton<IAuthorizationHandler, MinimumRoleHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, DepartmentHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, PermissionHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, AnyDepartmentHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, AnyPermissionHandler>();
builder.Services.AddAuthorization();

// Matches routes/auth.js's express-rate-limit config exactly: 10 attempts /
// 15 min, partitioned per client IP (not global) — see RateLimitPolicies.Login.
builder.Services.AddRateLimiter(options =>
{
    options.AddPolicy(RateLimitPolicies.Login, httpContext => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 10,
            Window = TimeSpan.FromMinutes(15),
            QueueLimit = 0,
        }));

    // Same 10/15min/IP shape, but a genuinely separate counter bucket — matches
    // routes/auth.js registering its own independent rateLimit() instance for
    // POST /api/auth/orderbook-token rather than reusing /login's.
    options.AddPolicy(RateLimitPolicies.OrderbookToken, httpContext => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 10,
            Window = TimeSpan.FromMinutes(15),
            QueueLimit = 0,
        }));
});

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
}

app.UseRouting();

app.UseApiExceptionHandling();
app.UseRateLimiter();

app.UseAuthentication();
app.UseAuthorization();

app.MapStaticAssets();
app.MapRazorPages()
   .WithStaticAssets();
app.MapControllers();

// Deliberately unauthenticated liveness check for external monitoring and
// IIS Application Initialization warm-up (see dotnet/CLAUDE.md's "Hosting"
// section — startMode=AlwaysRunning + preloadEnabled needs a real
// unauthenticated route to hit, same reasoning as SapServer's own
// HealthController). No DB/SapServer dependency — this only proves the app
// itself is up, not its dependencies.
app.MapGet("/health", () => Results.Ok(new { status = "ok", timestampUtc = DateTime.UtcNow }))
   .AllowAnonymous();

// C# port of GET /logout in routes/auth.js: destroy the ticket (removes the
// PortalSessions row via PortalSessionStore.RemoveAsync), audit it, redirect home.
app.MapGet("/Logout", async (HttpContext httpContext, IAuditLogger auditLogger) =>
{
    var username = httpContext.User.Identity?.Name;
    await httpContext.SignOutAsync(NexusAuthScheme.Name);
    await auditLogger.LogAsync("LOGOUT", username, null, httpContext.Connection.RemoteIpAddress?.ToString());
    return Results.Redirect("/");
});

// C# port of POST /api/auth/orderbook-token in routes/auth.js — the Month End Breakdown
// Excel macro's credential exchange (see Services/Auth/OrderbookTokenService.cs and
// middleware/auth.js's requireSessionOrApiToken). Deliberately separate from the real
// /Login page: a single stateless JSON request/response, no session/ticket issued at all.
app.MapPost("/api/auth/orderbook-token", async (OrderbookTokenRequest body, IAuthService authService, IOrderbookTokenService tokenService, HttpContext httpContext) =>
{
    if (string.IsNullOrEmpty(body.Username) || string.IsNullOrEmpty(body.Password))
        return Results.Json(new { success = false, error = "Username and password are required." }, statusCode: 400);

    var ip = httpContext.Connection.RemoteIpAddress?.ToString();
    var result = await authService.VerifyOrderbookCredentialsAsync(body.Username, body.Password, ip, httpContext.RequestAborted);

    if (result is OrderbookCredentialResult.Failure failure)
    {
        var message = failure.Reason == OrderbookCredentialFailureReason.AccountUnavailable
            ? "Account is not available for login."
            : "Invalid username or password.";
        return Results.Json(new { success = false, error = message }, statusCode: 401);
    }

    var success = (OrderbookCredentialResult.Success)result;
    var token = tokenService.CreateToken(success.UserId, success.Username);
    return Results.Json(new { success = true, token, expiresInMinutes = 20 });
})
.RequireRateLimiting(RateLimitPolicies.OrderbookToken)
.AllowAnonymous();

app.Run();

internal sealed record OrderbookTokenRequest(string? Username, string? Password);
