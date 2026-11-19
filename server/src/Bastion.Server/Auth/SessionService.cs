using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Auth;

/// <summary>Ziel einer neuen Sitzung: Web-App (HttpOnly-Cookie) oder Browser-Erweiterung (Bearer-Token im Antwort-Body).</summary>
public abstract record SessionTarget
{
    public sealed record Web(HttpResponse Response) : SessionTarget;
    public sealed record Extension(string? Label) : SessionTarget;

    public SessionClient Client => this is Extension ? SessionClient.EXTENSION : SessionClient.WEB;
}

public sealed class SessionService(BastionDb db, AppConfig config, CryptoUtil crypto)
{
    private static TimeSpan? ShortLived(SessionScope scope) => scope switch
    {
        SessionScope.SETUP => TimeSpan.FromMinutes(30),
        SessionScope.MFA => TimeSpan.FromMinutes(5),
        _ => null,
    };

    /// <summary>Legt eine Sitzung an. Für die Erweiterung wird das Token zurückgegeben, für die Web-App als Cookie gesetzt.</summary>
    public async Task<string?> Create(SessionTarget target, Guid userId, SessionScope scope, RequestMeta meta)
    {
        var token = CryptoUtil.RandomToken(32);
        var ttl = ShortLived(scope) ?? TimeSpan.FromHours(config.SessionMaxHours);
        db.Sessions.Add(new Session
        {
            UserId = userId,
            Scope = scope,
            Client = target.Client,
            Label = target is SessionTarget.Extension e ? e.Label : null,
            TokenHash = crypto.TokenHash(token),
            ExpiresAt = DateTime.UtcNow + ttl,
            Ip = meta.Ip,
            UserAgent = meta.UserAgent,
        });
        await db.SaveChangesAsync();
        if (target is SessionTarget.Web web)
        {
            web.Response.Cookies.Append(config.SessionCookie, token, CookieOptions(ttl));
            return null;
        }
        return token;
    }

    public CookieOptions CookieOptions(TimeSpan? maxAge) => new()
    {
        HttpOnly = true,
        Secure = config.CookieSecure,
        SameSite = SameSiteMode.Strict,
        Path = "/",
        MaxAge = maxAge,
        Expires = maxAge is { } m ? DateTimeOffset.UtcNow + m : null,
    };

    public void ClearCookie(HttpResponse res) => res.Cookies.Delete(config.SessionCookie, CookieOptions(null));

    /// <summary>Prüft Token, Ablauf und Leerlauf-Timeout.</summary>
    public async Task<Session?> Validate(string token)
    {
        var hash = crypto.TokenHash(token);
        var session = await db.Sessions.Include(s => s.User).ThenInclude(u => u.Tenant).FirstOrDefaultAsync(s => s.TokenHash == hash);
        if (session is null) return null;
        var now = DateTime.UtcNow;
        var idle = session.Scope == SessionScope.FULL ? TimeSpan.FromMinutes(config.SessionIdleMinutes) : TimeSpan.MaxValue;
        if (session.ExpiresAt < now || now - session.LastSeenAt > idle)
        {
            await db.Sessions.Where(s => s.Id == session.Id).ExecuteDeleteAsync();
            return null;
        }
        if (now - session.LastSeenAt > TimeSpan.FromSeconds(60))
        {
            await db.Sessions.Where(s => s.Id == session.Id).ExecuteUpdateAsync(u => u.SetProperty(s => s.LastSeenAt, now));
            session.LastSeenAt = now;
        }
        return session;
    }

    public Task Revoke(Guid sessionId) => db.Sessions.Where(s => s.Id == sessionId).ExecuteDeleteAsync();

    public Task RevokeAllForUser(Guid userId, Guid? exceptSessionId = null) =>
        db.Sessions.Where(s => s.UserId == userId && (exceptSessionId == null || s.Id != exceptSessionId)).ExecuteDeleteAsync();
}

/// <summary>Entfernt alle zehn Minuten abgelaufene und inaktive Sitzungen.</summary>
public sealed class SessionCleanup(IServiceScopeFactory scopes, AppConfig config, ILogger<SessionCleanup> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(10));
        while (await timer.WaitForNextTickAsync(stop))
        {
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<BastionDb>();
                var now = DateTime.UtcNow;
                var idleCutoff = now.AddMinutes(-config.SessionIdleMinutes);
                var count = await db.Sessions
                    .Where(s => s.ExpiresAt < now || (s.Scope == SessionScope.FULL && s.LastSeenAt < idleCutoff))
                    .ExecuteDeleteAsync(stop);
                if (count > 0) logger.LogDebug("{Count} abgelaufene Sitzungen entfernt", count);
                await scope.ServiceProvider.GetRequiredService<LoginThrottle>().Prune();
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogWarning(e, "Aufräumen der Sitzungen fehlgeschlagen");
            }
        }
    }
}
