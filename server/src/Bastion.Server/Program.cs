using Bastion.Server;
using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Emergency;
using Bastion.Server.Services;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

// Hilfsbefehle: "migrate" (Schema und Datenbankkonto einrichten, läuft im Migrationsdienst mit dem Eigentümer-Konto)
// und "schema" (SQL des Datenmodells ausgeben, nur für die Entwicklung neuer Migrationen)
if (args.Length > 0 && args[0] is "migrate" or "schema")
    return await Migrator.Run(args[0], Environment.GetEnvironmentVariable);

// Gesundheitsprüfung für Docker (das Laufzeit-Image enthält kein curl)
if (args is ["healthcheck"])
{
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
    try
    {
        var port = Environment.GetEnvironmentVariable("PORT") is { Length: > 0 } p ? p : "3000";
        using var res = await http.GetAsync($"http://127.0.0.1:{port}/api/health");
        return res.IsSuccessStatusCode ? 0 : 1;
    }
    catch (Exception)
    {
        return 1;
    }
}

AppConfig config;
try
{
    config = AppConfig.Load(Environment.GetEnvironmentVariable);
}
catch (InvalidOperationException e)
{
    Console.Error.WriteLine(e.Message);
    return 1;
}

var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = args, WebRootPath = null });
builder.WebHost.ConfigureKestrel(k =>
{
    k.AddServerHeader = false;
    k.Limits.MaxRequestBodySize = Web.MaxBodyBytes;
    k.ListenAnyIP(config.Port);
});
builder.Logging.AddSimpleConsole(o =>
{
    o.SingleLine = true;
    o.TimestampFormat = "yyyy-MM-dd HH:mm:ss ";
});

var services = builder.Services;
services.AddSingleton(config);
services.AddSingleton(TimeProvider.System);
services.AddSingleton<CryptoUtil>();
services.AddSingleton<PasswordService>();
services.AddSingleton<SystemSettingsCache>();
services.AddDbContextFactory<BastionDb>(o => BastionDb.Configure(o, AppConfig.ToNpgsql(config.DatabaseUrl)));
services.AddScoped(sp => sp.GetRequiredService<IDbContextFactory<BastionDb>>().CreateDbContext());
services.AddScoped<SessionService>();
services.AddScoped<DeviceToken>();
services.AddScoped<ILoginThrottleStore, DbLoginThrottleStore>();
services.AddScoped<LoginThrottle>();
services.AddScoped<SettingsService>();
services.AddScoped<AuditService>();
services.AddScoped<MailService>();
services.AddScoped<PermissionService>();
services.AddScoped<OrgService>();
services.AddScoped<AuthService>();
services.AddScoped<SessionGuard>();
services.AddBastionDomainServices();
services.AddEmergencyServices();
services.AddHostedService<SessionCleanup>();
services.AddHostedService<AuditHeadLogger>();
services.AddHostedService<TrashCleanup>();
services.AddHostedService<BootstrapService>();
services.AddBastionRateLimits();
services.AddHttpClient();

if (config.TrustProxy > 0)
{
    services.Configure<ForwardedHeadersOptions>(o =>
    {
        // Wie "trust proxy" in Express: den letzten TRUST_PROXY Stationen vertrauen, unabhängig von ihrer Adresse
        o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
        o.ForwardLimit = config.TrustProxy;
        o.KnownIPNetworks.Clear();
        o.KnownProxies.Clear();
    });
}

services
    .AddControllers(o =>
    {
        o.Filters.AddService<SessionGuard>();
        o.Filters.Add<CreatedStatusFilter>();
        o.ModelBindingMessageProvider.SetValueMustNotBeNullAccessor(_ => "required");
    })
    .AddJsonOptions(o => Json.Configure(o.JsonSerializerOptions))
    .ConfigureApiBehaviorOptions(o => o.InvalidModelStateResponseFactory = Web.ValidationFailed);

var app = builder.Build();
var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Bastion");

if (config.TrustProxy > 0) app.UseForwardedHeaders();
app.UseMiddleware<ErrorHandlingMiddleware>();
app.UseSecurityHeaders(config);
app.UseApiProtection(config);
app.UseSpa(config, log);
app.UseRouting();
app.UseRateLimiter();
app.MapControllers();

log.LogInformation("Bastion {Version} läuft auf Port {Port} (öffentliche URL: {Url})", BuildInfo.Version, config.Port, config.PublicUrl);
await app.RunAsync();
return 0;
