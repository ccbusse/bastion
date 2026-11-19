using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

public sealed class BreachRangeDto
{
    [Match("^[0-9A-Fa-f]{5}$")] public required string Prefix { get; init; }
}

[Route("api")]
public sealed partial class MiscController(BastionDb db, AppConfig config, IHttpClientFactory httpFactory) : BastionController
{
    private sealed record Package(string Browser, string File, string Url, long Size, string Sha256);

    private static readonly ConcurrentDictionary<string, (string Body, DateTime At)> RangeCache = new();
    // Der Endpunkt ist ohne Anmeldung erreichbar: Zwischenspeicher und Antwortgröße sind begrenzt, damit er sich nicht
    // zum Aufblähen des Arbeitsspeichers missbrauchen lässt (eine Antwort ist rund 40 KB groß).
    private const int RangeCacheMax = 256;
    private const int RangeBodyMax = 256 * 1024;
    private static readonly TimeSpan RangeCacheTtl = TimeSpan.FromHours(1);
    private static List<Package>? packagesCache;
    private static readonly Lock PackagesGate = new();

    [GeneratedRegex(@"^bastion-extension-(chromium|firefox)-[\d.]+\.zip$")]
    private static partial Regex PackageName();

    /// <summary>Liest die beim Build erzeugten Pakete aus public/downloads (einmalig, Ergebnis wird zwischengespeichert).</summary>
    private List<Package> ExtensionPackages()
    {
        lock (PackagesGate)
        {
            if (packagesCache is not null) return packagesCache;
            var dir = Path.Combine(config.WebDist, "downloads");
            packagesCache = Directory.Exists(dir)
                ? Directory.GetFiles(dir)
                    .Select(Path.GetFileName)
                    .Where(f => f is not null && PackageName().IsMatch(f))
                    .Order(StringComparer.Ordinal)
                    .Select(file =>
                    {
                        var data = System.IO.File.ReadAllBytes(Path.Combine(dir, file!));
                        return new Package(file!.Contains("-firefox-", StringComparison.Ordinal) ? "firefox" : "chromium", file, $"/downloads/{file}", data.Length,
                            Convert.ToHexStringLower(SHA256.HashData(data)));
                    })
                    .ToList()
                : [];
            return packagesCache;
        }
    }

    [Public, HttpGet("health")]
    public async Task<object> Health()
    {
        await db.Database.ExecuteSqlRawAsync("SELECT 1");
        return new { status = "ok", version = BuildInfo.Version };
    }

    /// <summary>Verfügbare Pakete der Browser-Erweiterung (Dateiname, Größe, SHA-256 zur Prüfung nach dem Download).</summary>
    [HttpGet("extension")]
    public object Extension() => new
    {
        version = BuildInfo.Version,
        packages = ExtensionPackages().Select(p => new { browser = p.Browser, file = p.File, url = p.Url, size = p.Size, sha256 = p.Sha256 }).ToList(),
    };

    /// <summary>
    /// Proxy für die HaveIBeenPwned-Range-API (k-Anonymity): Der Client sendet nur die ersten 5 Zeichen des SHA-1-Hashes.
    /// Der Proxy hält die CSP strikt und funktioniert hinter Firmen-Firewalls. Öffentlich, da auch bei Ersteinrichtung und
    /// Einladung (ohne Sitzung) benötigt. Das Präfix steht im Body statt in der URL: So landet es nicht in Zugriffsprotokollen
    /// des Reverse-Proxys, wo es zusammen mit IP und Uhrzeit einen Angriff auf Masterpasswörter erleichtern würde.
    /// </summary>
    [Public, Ok200, Throttle(120), HttpPost("breach/range")]
    public async Task<IActionResult> Range(BreachRangeDto body)
    {
        if (!config.HibpEnabled) throw ApiException.NotFound("HIBP_DISABLED");
        var p = body.Prefix.ToUpperInvariant();
        if (RangeCache.TryGetValue(p, out var hit) && DateTime.UtcNow - hit.At < RangeCacheTtl) return Text(hit.Body);
        try
        {
            using var http = httpFactory.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(8);
            http.MaxResponseContentBufferSize = RangeBodyMax;
            using var req = new HttpRequestMessage(HttpMethod.Get, $"https://api.pwnedpasswords.com/range/{p}");
            req.Headers.TryAddWithoutValidation("Add-Padding", "true");
            req.Headers.TryAddWithoutValidation("User-Agent", "Bastion-Password-Vault");
            using var res = await http.SendAsync(req);
            res.EnsureSuccessStatusCode();
            var text = await res.Content.ReadAsStringAsync();
            RememberRange(p, text);
            return Text(text);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            throw ApiException.ServiceUnavailable("HIBP_UNAVAILABLE");
        }
    }

    /// <summary>Antwort zwischenspeichern; ist der Speicher voll, zuerst abgelaufene, dann die ältesten Einträge verwerfen.</summary>
    private static void RememberRange(string prefix, string body)
    {
        var now = DateTime.UtcNow;
        if (RangeCache.Count >= RangeCacheMax)
        {
            foreach (var (k, v) in RangeCache)
                if (now - v.At >= RangeCacheTtl) RangeCache.TryRemove(k, out _);
            if (RangeCache.Count >= RangeCacheMax)
                foreach (var k in RangeCache.OrderBy(kv => kv.Value.At).Take(RangeCacheMax / 4).Select(kv => kv.Key).ToList()) RangeCache.TryRemove(k, out _);
        }
        RangeCache[prefix] = (body, now);
    }

    private static ContentResult Text(string body) => new() { Content = body, ContentType = "text/plain; charset=utf-8", StatusCode = 200 };
}
