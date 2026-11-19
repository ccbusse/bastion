using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

[Route("api/auth")]
public sealed class AuthController(AuthService auth, SessionService sessions, BastionDb db, AuditService audit, AppConfig config) : BastionController
{
    // Je IP-Adresse und Minute. Bewusst großzügig: Hinter einer gemeinsamen Büro-Adresse (NAT, Proxy) melden sich morgens
    // viele Personen gleichzeitig an. Das Raten von Passwörtern begrenzen die Sperren je Konto (siehe LoginThrottle),
    // die Serverlast die begrenzte Zahl gleichzeitiger Hash-Berechnungen (siehe PasswordService).
    private const int LoginLimit = 60;
    private const int SetupLimit = 10;

    /// <summary>Browser-Erweiterung erhält ein Token im Body, die Web-App ein Cookie.</summary>
    private SessionTarget TargetFor(string? label = null)
    {
        if (Request.Headers[HttpContextAuthExtensions.ExtensionClientHeader] != "extension") return new SessionTarget.Web(Response);
        var l = label?.Trim();
        if (l is { Length: > 100 }) l = l[..100];
        return new SessionTarget.Extension(string.IsNullOrEmpty(l) ? null : l);
    }

    [Public, HttpGet("status")]
    public Task<object> Status() => auth.Status();

    [Public, Throttle(LoginLimit), Ok200, HttpPost("prelogin")]
    public Task<object> Prelogin(EmailDto body) => auth.Prelogin(Normalize.Email(body.Email));

    [Public, Throttle(SetupLimit), Ok200, HttpPost("setup/login")]
    public async Task<object> SetupLogin(SetupLoginDto body)
    {
        await auth.SetupLogin(Response, body.Password, Meta);
        return OkResult;
    }

    [Scopes(SessionScope.SETUP), Ok200, HttpPost("setup/complete")]
    public async Task<object> CompleteSetup(CompleteSetupDto body)
    {
        await auth.CompleteSetup(Response, Auth, body, Meta);
        return OkResult;
    }

    [Public, Throttle(LoginLimit), Ok200, HttpPost("login")]
    public async Task<object> Login(LoginDto body)
    {
        var (mfaRequired, token) = await auth.Login(TargetFor(body.DeviceLabel), Normalize.Email(body.Email), body.AuthHash, Meta, Request.Cookies[config.DeviceCookie]);
        return new { mfaRequired, token };
    }

    [Scopes(SessionScope.MFA), AllowExtension, Throttle(LoginLimit), Ok200, HttpPost("login/mfa")]
    public async Task<object> LoginMfa(MfaCodeDto body)
    {
        // Die vollständige Sitzung entsteht in derselben Art wie die MFA-Sitzung
        SessionTarget target = Auth.Session.Client == SessionClient.EXTENSION ? new SessionTarget.Extension(Auth.Session.Label) : new SessionTarget.Web(Response);
        var token = await auth.VerifyMfa(target, Auth, body.Code, Meta, Request.Cookies[config.DeviceCookie]);
        return new { ok = true, token };
    }

    [Public, Ok200, HttpPost("logout")]
    public async Task<object> Logout()
    {
        var token = Request.BearerToken() ?? Request.Cookies[config.SessionCookie];
        if (!string.IsNullOrEmpty(token) && await sessions.Validate(token) is { } session) await sessions.Revoke(session.Id);
        sessions.ClearCookie(Response);
        return OkResult;
    }

    [AllowRestricted, AllowExtension, HttpGet("session")]
    public Task<object> Session() => auth.SessionInfo(Auth);

    [AllowRestricted, Ok200, HttpPost("change-password")]
    public async Task<object> ChangePassword(ChangePasswordDto body)
    {
        await auth.ChangePassword(Auth, body, Meta);
        return OkResult;
    }

    [AllowRestricted, Ok200, HttpPost("locale")]
    public async Task<object> SetLocale(LocaleDto body)
    {
        await db.Users.Where(u => u.Id == Auth.User.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.Locale, body.Locale));
        return OkResult;
    }

    [HttpGet("sessions")]
    public async Task<object> ListSessions()
    {
        var current = Auth.Session.Id;
        return await db.Sessions.AsNoTracking()
            .Where(s => s.UserId == Auth.User.Id && s.Scope == SessionScope.FULL)
            .OrderByDescending(s => s.LastSeenAt)
            .Select(s => new { s.Id, s.CreatedAt, s.LastSeenAt, s.Ip, s.UserAgent, s.Client, s.Label, Current = s.Id == current })
            .ToListAsync();
    }

    [HttpDelete("sessions/{id}")]
    public async Task<object> RevokeSession(Guid id)
    {
        var s = await db.Sessions.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id);
        if (s is null || s.UserId != Auth.User.Id) throw ApiException.Forbidden();
        await sessions.Revoke(id);
        await audit.Log(new AuditEntry("auth.session_revoked", TenantId: Auth.User.TenantId, Actor: Actor.Of(Auth.User), TargetType: "session", TargetId: id.ToString(), Meta: Meta));
        return OkResult;
    }

    /// <summary>
    /// Erneute Eingabe des Masterpassworts. Gibt kritische Aktionen dieser Sitzung für kurze Zeit frei
    /// (siehe <see cref="RequireRecentAuthAttribute"/>).
    /// </summary>
    [Ok200, HttpPost("verify")]
    public async Task<object> Verify(AuthHashDto body)
    {
        await auth.VerifyAuthHash(Auth.User, body.AuthHash, Meta);
        var now = DateTime.UtcNow;
        await db.Sessions.Where(s => s.Id == Auth.Session.Id).ExecuteUpdateAsync(u => u.SetProperty(s => s.ReauthAt, now));
        await audit.Log(new AuditEntry("auth.reauthenticated", TenantId: Auth.User.TenantId, Actor: Actor.Of(Auth.User), Meta: Meta));
        return new { ok = true, validUntil = now + RequireRecentAuthAttribute.Window };
    }
}
