using Bastion.Server.Auth;
using Bastion.Server.Data;
using Bastion.Server.Emergency;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

public sealed class OnboardingDto
{
    /// <summary>true: Tour gesehen bzw. übersprungen · false: beim nächsten Öffnen erneut zeigen</summary>
    public bool? TourCompleted { get; init; }
    /// <summary>true: Checkliste "Erste Schritte" ausblenden · false: wieder einblenden</summary>
    public bool? ChecklistHidden { get; init; }
}

/// <summary>
/// Einführung für neue Benutzer: Checkliste "Erste Schritte" je Rolle und der Merker, ob die Kurztour schon gezeigt wurde.
/// Jeder Schritt wird aus dem tatsächlichen Zustand abgeleitet (nicht abgehakt), damit die Liste zugleich zeigt,
/// ob die Installation vollständig eingerichtet ist. Sichtbar ist nur, was zur eigenen Rolle gehört.
/// </summary>
[Route("api/onboarding")]
public sealed class OnboardingController(BastionDb db, PermissionService perms, SettingsService settings) : BastionController
{
    private sealed record Step(string Id, string State);

    private sealed record Group(string Id, List<Step> Steps);

    private static Step S(string id, bool done) => new(id, done ? "done" : "open");

    [HttpGet("checklist")]
    public async Task<object> Checklist()
    {
        var user = Auth.User;
        var ctx = await perms.ForUser(user);
        var isSystemAdmin = user.SystemRole == SystemRole.SYSTEM_ADMIN;
        var groups = new List<Group>();

        // Für alle: eigenes Konto absichern und Bastion kennenlernen
        var basics = new List<Step>
        {
            S("mfa", user.TotpEnabled),
            S("firstItem", await db.Items.AnyAsync(i => i.CreatedById == user.Id)),
            S("extension", await db.Sessions.AnyAsync(s => s.UserId == user.Id && s.Client == SessionClient.EXTENSION)),
        };
        groups.Add(new Group("basics", basics));

        // Tenant-Admins: Organisation aufbauen
        if (user.Tenant is { } tenant && ctx.IsTenantAdmin)
        {
            var emergencyKey = await db.EmergencyKeys.AsNoTracking().OrderByDescending(k => k.CreatedAt).Select(k => (Guid?)k.Id).FirstOrDefaultAsync();
            var approved = emergencyKey is { } kid && await db.EmergencyApprovals.AnyAsync(a => a.KeyId == kid && a.TenantId == tenant.Id);
            groups.Add(new Group("tenantAdmin",
            [
                S("structure", await db.Folders.AnyAsync(f => f.TenantId == tenant.Id)),
                S("invite", await PermissionService.TenantMembers(db.Users, tenant.Id).CountAsync() > 1),
                S("tenantMfa", tenant.RequireMfa),
                // Ohne Notfallschlüssel kann der Tenant-Admin nichts tun: Er wartet auf einen System-Admin
                new Step("emergencyApproval", approved ? "done" : emergencyKey is null ? "waiting" : "open"),
            ]));
        }

        // System-Admins: Installation absichern
        if (isSystemAdmin)
        {
            var system = await settings.GetSystem();
            var activeAdmins = await db.Users.CountAsync(u => u.SystemRole == SystemRole.SYSTEM_ADMIN && u.Status == UserStatus.ACTIVE);
            var emergencyKey = await db.EmergencyKeys.AnyAsync();
            var auto = await EmergencyAutoService.GetSettings(db);
            var autoWorks = auto.Enabled && await db.EmergencyTargets.AnyAsync(t => t.Enabled && t.LastSuccessAt != null);
            var backup = DbBackupStatus.State(await DbBackupStatus.Read(db), DateTime.UtcNow);
            groups.Add(new Group("systemAdmin",
            [
                S("secondAdmin", activeAdmins >= 2),
                S("systemMfa", system.RequireMfaForSystemAdmins),
                S("smtp", await settings.GetSmtp() is not null),
                S("tenant", await db.Tenants.AnyAsync()),
                S("emergencyKey", emergencyKey),
                S("emergencyAuto", autoWorks),
                S("dbBackup", backup == "ok"),
            ]));
        }

        return new { groups, hiddenAt = user.ChecklistHiddenAt };
    }

    [Ok200, HttpPost("")]
    public async Task<object> Update(OnboardingDto body)
    {
        var now = DateTime.UtcNow;
        var id = Auth.User.Id;
        if (body.TourCompleted is { } tour)
            await db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(u => u.SetProperty(x => x.TourCompletedAt, tour ? now : null));
        if (body.ChecklistHidden is { } hidden)
            await db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(u => u.SetProperty(x => x.ChecklistHiddenAt, hidden ? now : null));
        return OkResult;
    }
}

/// <summary>Stand des Datenbank-Backups für System-Admins (gemeldet vom Dienst "backup").</summary>
[Route("api/system/db-backup")]
[SystemAdminOnly]
public sealed class DbBackupController(BastionDb db) : BastionController
{
    [HttpGet("")]
    public async Task<object> Status()
    {
        var report = await DbBackupStatus.Read(db);
        return new { state = DbBackupStatus.State(report, DateTime.UtcNow), report };
    }
}
