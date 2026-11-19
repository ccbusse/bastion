using System.Text.Json;
using Bastion.Server.Common;
using Bastion.Server.Services;

namespace Bastion.Server.Tests;

/// <summary>Bewertung des vom Backup-Dienst gemeldeten Stands (Anzeige für System-Admins und Checkliste).</summary>
public class DbBackupStatusTests
{
    private static readonly DateTime Now = new(2026, 11, 18, 12, 0, 0, DateTimeKind.Utc);

    private static DbBackupReport Report(bool? configured = true, DateTime? success = null, DateTime? attempt = null, string? error = null) =>
        new(configured, "02:30", "Europe/Berlin", 14, 3, attempt, success, "bastion-x.dump.age", 12, error, Now);

    [Fact]
    public void No_report_is_unknown() => Assert.Equal("unknown", DbBackupStatus.State(null, Now));

    [Fact]
    public void Missing_recipients_is_not_configured() => Assert.Equal("notConfigured", DbBackupStatus.State(Report(configured: false), Now));

    [Fact]
    public void Recent_success_is_ok() => Assert.Equal("ok", DbBackupStatus.State(Report(success: Now.AddHours(-25), attempt: Now.AddHours(-25)), Now));

    [Fact]
    public void Old_or_missing_success_is_stale()
    {
        Assert.Equal("stale", DbBackupStatus.State(Report(success: Now.AddHours(-27)), Now));
        Assert.Equal("stale", DbBackupStatus.State(Report(), Now));
    }

    [Fact]
    public void Failure_after_last_success_is_failing()
    {
        Assert.Equal("failing", DbBackupStatus.State(Report(success: Now.AddHours(-2), attempt: Now.AddHours(-1), error: "pg_dump"), Now));
        // Ein älterer Fehler vor dem letzten Erfolg zählt nicht
        Assert.Equal("ok", DbBackupStatus.State(Report(success: Now.AddHours(-1), attempt: Now.AddHours(-2), error: "alt"), Now));
    }

    [Fact]
    public void Report_written_by_the_backup_script_is_read()
    {
        // So schreibt bastion-backup.sh die Meldung (jsonb_build_object, Zeitstempel als ISO-Text)
        const string json = """{"configured": true, "schedule": "02:30", "timezone": "Europe/Berlin", "keep": 14, "count": 2, "lastAttemptAt": "2026-11-18T11:00:00Z", "lastSuccessAt": "2026-11-18T11:00:00Z", "lastFile": "bastion-20261118T110000Z.dump.age", "lastSizeKiB": 812, "lastError": null, "reportedAt": "2026-11-18T11:00:00Z"}""";
        var report = JsonSerializer.Deserialize<DbBackupReport>(json, Json.Options)!;
        Assert.Equal(new DateTime(2026, 11, 18, 11, 0, 0, DateTimeKind.Utc), report.LastSuccessAt);
        Assert.Equal(812, report.LastSizeKiB);
        Assert.Equal("ok", DbBackupStatus.State(report, Now));
    }
}
