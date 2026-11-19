using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Bastion.Server.Auth;

/// <summary>
/// Prüft vor jedem Controller-Aufruf die Sitzung (global registriert, Ausnahmen per <see cref="PublicAttribute"/>).
/// Web-App: HttpOnly-Cookie. Browser-Erweiterung: Bearer-Token. Die beiden Arten sind nicht austauschbar.
/// </summary>
public sealed class SessionGuard(SessionService sessions, SettingsService settings, AppConfig config) : IAsyncAuthorizationFilter
{
    public async Task OnAuthorizationAsync(AuthorizationFilterContext ctx)
    {
        var metadata = ctx.ActionDescriptor.EndpointMetadata;
        if (metadata.OfType<PublicAttribute>().Any()) return;

        var req = ctx.HttpContext.Request;
        var bearer = req.BearerToken();
        var token = bearer ?? req.Cookies[config.SessionCookie];
        if (string.IsNullOrEmpty(token)) throw ApiException.Unauthorized("NOT_AUTHENTICATED");

        var session = await sessions.Validate(token) ?? throw ApiException.Unauthorized("SESSION_EXPIRED");
        if ((session.Client == SessionClient.EXTENSION) != (bearer is not null)) throw ApiException.Unauthorized("NOT_AUTHENTICATED");
        // Die Erweiterung darf nur ausdrücklich freigegebene (lesende) Endpunkte aufrufen
        if (session.Client == SessionClient.EXTENSION && !metadata.OfType<AllowExtensionAttribute>().Any()) throw ApiException.Forbidden("EXTENSION_NOT_ALLOWED");

        // Die Markierung an der Methode hat Vorrang vor der an der Klasse (zuletzt eingetragen)
        var scopes = metadata.OfType<ScopesAttribute>().LastOrDefault()?.Scopes ?? [SessionScope.FULL];
        if (!scopes.Contains(session.Scope)) throw ApiException.Unauthorized("NOT_AUTHENTICATED");

        var user = session.User;
        var allowed = session.Scope == SessionScope.SETUP
            ? user.Status == UserStatus.SETUP_REQUIRED
            : user.Status is UserStatus.ACTIVE or UserStatus.PENDING_CONFIRMATION;
        if (!allowed)
        {
            await sessions.Revoke(session.Id);
            throw ApiException.Unauthorized("NOT_AUTHENTICATED");
        }

        var mfaRequired = user.Tenant?.RequireMfa ?? false;
        if (user.SystemRole == SystemRole.SYSTEM_ADMIN) mfaRequired |= (await settings.GetSystem()).RequireMfaForSystemAdmins;
        var restrictions = new Restrictions(user.ForcePasswordChange, user.Status == UserStatus.PENDING_CONFIRMATION, mfaRequired && !user.TotpEnabled);
        ctx.HttpContext.SetAuth(new AuthContext(session, user, restrictions));

        if (session.Scope == SessionScope.FULL && restrictions.Any && !metadata.OfType<AllowRestrictedAttribute>().Any())
            throw ApiException.Forbidden("ACCOUNT_RESTRICTED");
    }
}
