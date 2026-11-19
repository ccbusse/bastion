using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server;

/// <summary>
/// Ersteinrichtung: Existiert noch kein Benutzer, wird ein System-Admin mit Initialpasswort angelegt.
/// Das Initialpasswort wird einmalig im Container-Log ausgegeben (oder per INITIAL_ADMIN_PASSWORD gesetzt)
/// und muss bei der ersten Anmeldung durch ein eigenes Masterpasswort ersetzt werden.
/// </summary>
public sealed class BootstrapService(IServiceScopeFactory scopes, AppConfig config, PasswordService passwords, ILogger<BootstrapService> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BastionDb>();
        var audit = scope.ServiceProvider.GetRequiredService<AuditService>();

        var users = await db.Users.CountAsync(ct);
        var pending = await db.Users.FirstOrDefaultAsync(u => u.Status == UserStatus.SETUP_REQUIRED, ct);
        if (users > 0 && pending is null) return;

        var fromEnv = config.InitialAdminPassword is not null;
        var password = config.InitialAdminPassword ?? CryptoUtil.RandomReadablePassword(24);
        var setupPasswordHash = await passwords.Hash(password);

        if (pending is not null)
        {
            pending.SetupPasswordHash = setupPasswordHash;
            pending.FailedLogins = 0;
            pending.LockedUntil = null;
            await db.SaveChangesAsync(ct);
        }
        else
        {
            var admin = new User { Email = "admin", Name = "Administrator", SystemRole = SystemRole.SYSTEM_ADMIN, Status = UserStatus.SETUP_REQUIRED, SetupPasswordHash = setupPasswordHash };
            db.Users.Add(admin);
            await db.SaveChangesAsync(ct);
            await audit.Log(new AuditEntry("system.initialized", Actor: Actor.Of(admin)));
        }

        var line = new string('═', 64);
        logger.LogWarning("{Banner}", string.Join('\n',
            "",
            line,
            "  BASTION – ERSTEINRICHTUNG / INITIAL SETUP",
            $"  URL:       {config.PublicUrl}/setup",
            "  Benutzer:  admin",
            fromEnv ? "  Passwort:  (aus INITIAL_ADMIN_PASSWORD)" : $"  Passwort:  {password}",
            "  Das Passwort muss bei der ersten Anmeldung geändert werden.",
            "  Bei jedem Neustart vor Abschluss der Einrichtung wird ein neues erzeugt.",
            line));
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
