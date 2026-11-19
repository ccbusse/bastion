using System.Text.Json;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Services;

/// <summary>
/// Stand des Datenbank-Backups (Dienst "backup"), wie ihn der Dienst selbst in system_settings ("backup.database") meldet.
/// Bastion sieht die Backup-Dateien nicht; die Meldung ist nur eine Anzeige für System-Admins und enthält keine Geheimnisse.
/// </summary>
public sealed record DbBackupReport(
    bool? Configured,
    string? Schedule,
    string? Timezone,
    int? Keep,
    int? Count,
    DateTime? LastAttemptAt,
    DateTime? LastSuccessAt,
    string? LastFile,
    long? LastSizeKiB,
    string? LastError,
    DateTime? ReportedAt);

public static class DbBackupStatus
{
    public const string SettingsKey = "backup.database";

    /// <summary>Wie der Healthcheck des Dienstes: ein erfolgreiches Backup muss jünger als 26 Stunden sein.</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(26);

    public static async Task<DbBackupReport?> Read(BastionDb db)
    {
        var json = await db.SystemSettings.AsNoTracking().Where(s => s.Key == SettingsKey).Select(s => s.Value).FirstOrDefaultAsync();
        if (json is null) return null;
        try { return JsonSerializer.Deserialize<DbBackupReport>(json, Json.Options); }
        catch (JsonException) { return null; }
    }

    /// <summary>
    /// unknown: der Dienst hat sich nie gemeldet (nicht gestartet oder ältere Installation) ·
    /// notConfigured: läuft, aber ohne öffentlichen Schlüssel (sichert nichts) ·
    /// failing: der letzte Versuch ist fehlgeschlagen · stale: letztes erfolgreiches Backup zu alt · ok
    /// </summary>
    public static string State(DbBackupReport? r, DateTime now)
    {
        if (r is null) return "unknown";
        if (r.Configured != true) return "notConfigured";
        if (r.LastAttemptAt is { } attempt && r.LastError is not null && (r.LastSuccessAt is null || attempt > r.LastSuccessAt)) return "failing";
        if (r.LastSuccessAt is not { } success || now - success > MaxAge) return "stale";
        return "ok";
    }
}
