using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Bastion.Server.Auth;

public sealed record Restrictions(bool ForcePasswordChange, bool PendingConfirmation, bool MfaSetupRequired)
{
    [System.Text.Json.Serialization.JsonIgnore]
    public bool Any => ForcePasswordChange || PendingConfirmation || MfaSetupRequired;
}

/// <summary>Angemeldeter Benutzer der aktuellen Anfrage (vom <see cref="SessionGuard"/> gesetzt).</summary>
public sealed record AuthContext(Session Session, User User, Restrictions Restrictions);

/// <summary>Herkunft einer Anfrage für Audit-Log und Sitzungsliste.</summary>
public sealed record RequestMeta(string? Ip, string? UserAgent);

// ---------- Endpunkt-Markierungen (ausgewertet vom SessionGuard) ----------

/// <summary>Kein Login erforderlich.</summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class PublicAttribute : Attribute;

/// <summary>Erlaubte Sitzungsarten (Standard: FULL).</summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class ScopesAttribute(params SessionScope[] scopes) : Attribute
{
    public SessionScope[] Scopes { get; } = scopes;
}

/// <summary>Endpunkt auch bei eingeschränktem Konto erreichbar (Passwortwechsel-Pflicht, MFA-Einrichtung, Bestätigung ausstehend).</summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class AllowRestrictedAttribute : Attribute;

/// <summary>Endpunkt für Sitzungen der Browser-Erweiterung freigegeben (Positivliste, nur lesende Zugriffe).</summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class AllowExtensionAttribute : Attribute;

/// <summary>
/// Kritische Aktion: nur kurz nach einer erneuten Eingabe des Masterpassworts in dieser Sitzung (<c>POST /auth/verify</c>).
/// Eine übernommene Sitzung allein reicht dafür nicht. Sonst 403 <c>REAUTH_REQUIRED</c>; der Web-Client fragt dann das
/// Passwort ab und wiederholt die Anfrage. Läuft nach dem globalen SessionGuard.
/// </summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class RequireRecentAuthAttribute : Attribute, IAuthorizationFilter
{
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    public static bool IsRecent(Session session) => session.ReauthAt is { } at && DateTime.UtcNow - at <= Window;

    public static void Assert(AuthContext auth)
    {
        if (!IsRecent(auth.Session)) throw ApiException.Forbidden("REAUTH_REQUIRED");
    }

    public void OnAuthorization(AuthorizationFilterContext ctx) => Assert(ctx.HttpContext.Auth());
}

/// <summary>POST-Endpunkt antwortet mit 200 statt 201 (Aktionen, die nichts anlegen).</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class Ok200Attribute : Attribute;

public static class HttpContextAuthExtensions
{
    private const string Key = "bastion.auth";

    /// <summary>Header, mit dem sich die Browser-Erweiterung bei der Anmeldung zu erkennen gibt.</summary>
    public const string ExtensionClientHeader = "x-bastion-client";

    public static AuthContext Auth(this HttpContext ctx) =>
        ctx.Items[Key] as AuthContext ?? throw new InvalidOperationException("Kein Auth-Kontext (Endpunkt ist öffentlich?)");

    internal static void SetAuth(this HttpContext ctx, AuthContext auth) => ctx.Items[Key] = auth;

    public static RequestMeta Meta(this HttpContext ctx)
    {
        var ua = ctx.Request.Headers.UserAgent.ToString();
        if (ua.Length > 300) ua = ua[..300];
        return new RequestMeta(ClientIp(ctx), ua.Length > 0 ? ua : null);
    }

    /// <summary>Client-Adresse (nach Auswertung von X-Forwarded-For durch die vertrauenswürdigen Proxys).</summary>
    public static string? ClientIp(this HttpContext ctx)
    {
        var ip = ctx.Connection.RemoteIpAddress;
        if (ip is null) return null;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        return ip.ToString();
    }

    /// <summary>Token aus dem Authorization-Header (nur Browser-Erweiterung).</summary>
    public static string? BearerToken(this HttpRequest req)
    {
        var h = req.Headers.Authorization.ToString();
        if (!h.StartsWith("Bearer ", StringComparison.Ordinal)) return null;
        var t = h[7..].Trim();
        return t.Length > 0 ? t : null;
    }
}
