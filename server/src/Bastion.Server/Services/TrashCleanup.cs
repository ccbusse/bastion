using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Services;

/// <summary>
/// Leert den Papierkorb: Einträge, die länger als TRASH_RETENTION_DAYS gelöscht sind, werden stündlich endgültig entfernt.
/// Je Tenant ein Audit-Eintrag "items.purged_expired" mit Anzahl und IDs (persönliche Tresore ohne Audit, wie beim Löschen).
/// </summary>
public sealed class TrashCleanup(IServiceScopeFactory scopes, AppConfig config, ILogger<TrashCleanup> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        do
        {
            try
            {
                await Run(stop);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogWarning(e, "Leeren des Papierkorbs fehlgeschlagen");
            }
        } while (await timer.WaitForNextTickAsync(stop));
    }

    public async Task<int> Run(CancellationToken stop = default)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BastionDb>();
        var audit = scope.ServiceProvider.GetRequiredService<AuditService>();
        var cutoff = DateTime.UtcNow.AddDays(-config.TrashRetentionDays);
        var expired = await db.Items.AsNoTracking().Where(i => i.DeletedAt != null && i.DeletedAt < cutoff)
            .Select(i => new { i.Id, i.TenantId }).ToListAsync(stop);
        if (expired.Count == 0) return 0;
        var ids = expired.Select(e => e.Id).ToList();
        var count = await db.Items.Where(i => ids.Contains(i.Id) && i.DeletedAt != null && i.DeletedAt < cutoff).ExecuteDeleteAsync(stop);
        foreach (var group in expired.Where(e => e.TenantId != null).GroupBy(e => e.TenantId))
            await audit.Log(new AuditEntry("items.purged_expired", TenantId: group.Key,
                Metadata: new { count = group.Count(), retentionDays = config.TrashRetentionDays, items = group.Select(e => e.Id).ToList() }));
        logger.LogInformation("Papierkorb: {Count} Einträge nach {Days} Tagen endgültig gelöscht", count, config.TrashRetentionDays);
        return count;
    }
}
