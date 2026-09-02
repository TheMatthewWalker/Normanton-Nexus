using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using NormantonNexus.Data;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorPages();

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

builder.Services.AddAuthentication(NexusAuthScheme.Name)
    .AddCookie(NexusAuthScheme.Name, options =>
    {
        options.Cookie.Name = "nnx_session";
        options.Cookie.HttpOnly = true;
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
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
});

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
}

app.UseRouting();

app.UseRateLimiter();

app.UseAuthentication();
app.UseAuthorization();

app.MapStaticAssets();
app.MapRazorPages()
   .WithStaticAssets();

// C# port of GET /logout in routes/auth.js: destroy the ticket (removes the
// PortalSessions row via PortalSessionStore.RemoveAsync), audit it, redirect home.
app.MapGet("/Logout", async (HttpContext httpContext, IAuditLogger auditLogger) =>
{
    var username = httpContext.User.Identity?.Name;
    await httpContext.SignOutAsync(NexusAuthScheme.Name);
    await auditLogger.LogAsync("LOGOUT", username, null, httpContext.Connection.RemoteIpAddress?.ToString());
    return Results.Redirect("/");
});

app.Run();
