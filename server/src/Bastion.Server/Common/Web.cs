using System.Text.RegularExpressions;
using System.Threading.RateLimiting;
using Bastion.Server.Auth;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace Bastion.Server.Common;

/// <summary>Eigenes Anfragelimit je Client-Adresse und Endpunkt (Standard: 600 pro Minute).</summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class ThrottleAttribute(int limit, int seconds = 60) : Attribute
{
    public int Limit { get; } = limit;
    public TimeSpan Window { get; } = TimeSpan.FromSeconds(seconds);
}

public static partial class Web
{
    public const int MaxBodyBytes = 5 * 1024 * 1024;

    // ---------- Sicherheitsheader ----------

    /// <summary>Sicherheitsheader für alle Antworten (CSP, HSTS, Isolation, keine Einbettung in fremde Seiten).</summary>
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app, AppConfig config)
    {
        var csp = string.Join(';',
            "default-src 'self'",
            // 'wasm-unsafe-eval' wird für Argon2id (WebAssembly) im Browser benötigt
            "script-src 'self' 'wasm-unsafe-eval'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "worker-src 'self' blob:") + (config.CookieSecure ? ";upgrade-insecure-requests" : "");
        return app.Use(async (ctx, next) =>
        {
            var h = ctx.Response.Headers;
            h.ContentSecurityPolicy = csp;
            h["Cross-Origin-Opener-Policy"] = "same-origin";
            h["Cross-Origin-Resource-Policy"] = "same-origin";
            h["Origin-Agent-Cluster"] = "?1";
            h["Referrer-Policy"] = "no-referrer";
            if (config.CookieSecure) h.StrictTransportSecurity = "max-age=63072000; includeSubDomains";
            h.XContentTypeOptions = "nosniff";
            h["X-DNS-Prefetch-Control"] = "off";
            h["X-Download-Options"] = "noopen";
            h.XFrameOptions = "SAMEORIGIN";
            h["X-Permitted-Cross-Domain-Policies"] = "none";
            h.XXSSProtection = "0";
            h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()";
            await next();
        });
    }

    // ---------- CSRF ----------

    [GeneratedRegex("^(chrome|moz)-extension://")]
    private static partial Regex ExtensionOrigin();

    /// <summary>
    /// CSRF-Schutz für zustandsändernde API-Anfragen: SameSite=Strict-Cookie + eigener Header + Prüfung der Herkunft.
    /// API-Antworten werden zudem nie zwischengespeichert.
    /// </summary>
    public static IApplicationBuilder UseApiProtection(this IApplicationBuilder app, AppConfig config) => app.Use(async (ctx, next) =>
    {
        if (!ctx.Request.Path.StartsWithSegments("/api")) { await next(); return; }
        ctx.Response.Headers.CacheControl = "no-store";
        var req = ctx.Request;
        if (HttpMethods.IsGet(req.Method) || HttpMethods.IsHead(req.Method) || HttpMethods.IsOptions(req.Method)) { await next(); return; }
        if (req.Headers["x-requested-with"] != "bastion") { await Plain403(ctx, "CSRF_CHECK_FAILED"); return; }
        var hasCookie = req.Headers.Cookie.Count > 0;
        // Browser-Erweiterung: Bearer-Token statt Cookie, daher kein CSRF-Risiko; ihre Herkunft (chrome-extension://…) ist nicht vorab bekannt
        if (req.BearerToken() is not null && !hasCookie) { await next(); return; }
        var origin = req.Headers.Origin.ToString();
        // Anmeldung der Erweiterung (noch ohne Token): nur von Erweiterungs-Herkunft, nie mit Cookie
        if (req.Headers[HttpContextAuthExtensions.ExtensionClientHeader] == "extension" && ExtensionOrigin().IsMatch(origin) && !hasCookie) { await next(); return; }
        if (origin.Length > 0 && !config.AllowedOrigins.Contains(origin)) { await Plain403(ctx, "ORIGIN_NOT_ALLOWED"); return; }
        await next();
    });

    private static Task Plain403(HttpContext ctx, string message)
    {
        ctx.Response.StatusCode = 403;
        return ctx.Response.WriteAsJsonAsync(new { statusCode = 403, message }, Json.Options);
    }

    // ---------- Anfragelimits ----------

    public static IServiceCollection AddBastionRateLimits(this IServiceCollection services) => services.AddRateLimiter(o =>
    {
        o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
        {
            var endpoint = ctx.GetEndpoint();
            if (endpoint is null || !ctx.Request.Path.StartsWithSegments("/api")) return RateLimitPartition.GetNoLimiter("none");
            var t = endpoint.Metadata.GetMetadata<ThrottleAttribute>() ?? new ThrottleAttribute(600);
            var key = $"{ctx.ClientIp()}|{endpoint.DisplayName}";
            return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = t.Limit,
                Window = t.Window,
                QueueLimit = 0,
                AutoReplenishment = true,
            });
        });
        o.OnRejected = async (c, ct) =>
        {
            c.HttpContext.Response.StatusCode = 429;
            if (c.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retry)) c.HttpContext.Response.Headers.RetryAfter = ((int)Math.Ceiling(retry.TotalSeconds)).ToString(System.Globalization.CultureInfo.InvariantCulture);
            await c.HttpContext.Response.WriteAsJsonAsync(ErrorResponses.Body(429, "TOO_MANY_REQUESTS"), Json.Options, ct);
        };
    });

    // ---------- Validierung ----------

    /// <summary>Ungültige Eingaben: 400 VALIDATION_FAILED mit Feldliste (Pfad in camelCase).</summary>
    public static IActionResult ValidationFailed(ActionContext ctx)
    {
        var issues = ctx.ModelState
            .Where(kv => kv.Value is { ValidationState: ModelValidationState.Invalid })
            .SelectMany(kv => kv.Value!.Errors.Select(e => new { path = CamelPath(kv.Key), message = e.ErrorMessage.Length > 0 ? e.ErrorMessage : "invalid" }))
            .ToList();
        return new ObjectResult(ErrorResponses.Body(400, "VALIDATION_FAILED", issues)) { StatusCode = 400 };
    }

    private static string CamelPath(string key)
    {
        var path = key.StartsWith("$.", StringComparison.Ordinal) ? key[2..] : key.TrimStart('$');
        return string.Join('.', path.Split('.').Select(p => p.Length > 0 ? char.ToLowerInvariant(p[0]) + p[1..] : p));
    }

    // ---------- Web-Client ----------

    /// <summary>Liefert den Web-Client (SPA) aus; unbekannte Pfade außerhalb von /api erhalten index.html.</summary>
    public static void UseSpa(this WebApplication app, AppConfig config, ILogger logger)
    {
        if (!Directory.Exists(config.WebDist))
        {
            logger.LogWarning("Web-Client nicht gefunden unter {Path} – nur API aktiv", config.WebDist);
            app.MapFallback(NotFound);
            return;
        }
        var files = new PhysicalFileProvider(Path.GetFullPath(config.WebDist));
        var types = new FileExtensionContentTypeProvider();
        types.Mappings[".webmanifest"] = "application/manifest+json";
        types.Mappings[".wasm"] = "application/wasm";
        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = files,
            ContentTypeProvider = types,
            OnPrepareResponse = f =>
            {
                var path = f.Context.Request.Path.Value ?? "";
                f.Context.Response.Headers.CacheControl = path.StartsWith("/assets/", StringComparison.Ordinal) ? "public, max-age=31536000, immutable" : "no-cache";
                // Erweiterungspakete immer als Download ausliefern
                if (DownloadZip().IsMatch(path)) f.Context.Response.Headers.ContentDisposition = "attachment";
            },
        });
        var index = files.GetFileInfo("index.html");
        app.MapFallback(async ctx =>
        {
            if (ctx.Request.Path.StartsWithSegments("/api") || !HttpMethods.IsGet(ctx.Request.Method) || !index.Exists)
            {
                await NotFound(ctx);
                return;
            }
            ctx.Response.Headers.CacheControl = "no-cache";
            ctx.Response.ContentType = "text/html; charset=utf-8";
            await ctx.Response.SendFileAsync(index);
        });
    }

    [GeneratedRegex("^/downloads/[^/]+\\.zip$")]
    private static partial Regex DownloadZip();

    public static Task NotFound(HttpContext ctx) =>
        ErrorResponses.Write(ctx, 404, $"Cannot {ctx.Request.Method} {ctx.Request.Path}");
}

/// <summary>POST antwortet mit 201 Created, sofern der Endpunkt nicht mit <see cref="Ok200Attribute"/> markiert ist (wie bisher).</summary>
public sealed class CreatedStatusFilter : IAlwaysRunResultFilter
{
    public void OnResultExecuting(ResultExecutingContext ctx)
    {
        if (!HttpMethods.IsPost(ctx.HttpContext.Request.Method) || ctx.ActionDescriptor.EndpointMetadata.OfType<Ok200Attribute>().Any()) return;
        switch (ctx.Result)
        {
            case ObjectResult { StatusCode: null or 200 } o: o.StatusCode = 201; break;
            case StatusCodeResult { StatusCode: 200 }: ctx.Result = new StatusCodeResult(201); break;
            case EmptyResult: ctx.Result = new StatusCodeResult(201); break;
        }
    }

    public void OnResultExecuted(ResultExecutedContext ctx) { }
}
