using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Emergency;

/// <summary>Zustand des automatischen Exports (Tabelle system_settings, Schlüssel emergency.autoState).</summary>
public sealed class AutoState
{
    /// <summary>Zuletzt gesehener Datenstand und Zeitpunkt seiner Änderung</summary>
    public string? Signature { get; set; }
    public string? ChangedAt { get; set; }
    /// <summary>Datenstand des letzten erfolgreichen automatischen Exports</summary>
    public string? ExportedSignature { get; set; }
    /// <summary>Datum (in der eingestellten Zeitzone) des letzten täglichen Exports</summary>
    public string? DailyDate { get; set; }
    public string? LastRunAt { get; set; }
}

public sealed class TargetResult
{
    public required Guid Id { get; init; }
    public required string Name { get; init; }
    public bool Ok { get; set; }
    public string? File { get; set; }
    public int? Deleted { get; set; }
    public string? Error { get; set; }
}

/// <summary>
/// Automatischer Export des Notfall-Backups an die konfigurierten Ziele.
/// Auslöser: Änderung am Datenstand (nach Ruhezeit) und täglich zur eingestellten Uhrzeit.
/// Der Server verschickt nur die bereits verschlüsselte Datei; zum Entschlüsseln sind weiterhin Schlüsselblatt und Passphrase nötig.
/// </summary>
public sealed class EmergencyAutoService(IServiceScopeFactory scopes, AppConfig config, ILogger<EmergencyAutoService> logger) : BackgroundService
{
    private const string SettingsKey = "emergency.auto";
    private const string StateKey = "emergency.autoState";
    private const int AlertAfter = 3;

    private readonly Lock gate = new();
    private Task<List<TargetResult>>? running;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (await timer.WaitForNextTickAsync(stop))
        {
            try { await Tick(DateTime.UtcNow); }
            catch (Exception e) when (e is not OperationCanceledException) { logger.LogError("Prüfung fehlgeschlagen: {Message}", e.Message); }
        }
    }

    // ---------- Einstellungen und Zustand ----------

    private static async Task<string?> GetSetting(BastionDb db, string key) =>
        await db.SystemSettings.AsNoTracking().Where(s => s.Key == key).Select(s => s.Value).FirstOrDefaultAsync();

    private static async Task SetSetting(BastionDb db, string key, string json)
    {
        var row = await db.SystemSettings.FirstOrDefaultAsync(s => s.Key == key);
        if (row is null) db.SystemSettings.Add(new SystemSetting { Key = key, Value = json });
        else row.Value = json;
        await db.SaveChangesAsync();
    }

    public static async Task<AutoSettings> GetSettings(BastionDb db)
    {
        var json = await GetSetting(db, SettingsKey);
        AutoSettings? s = null;
        try { s = json is null ? null : JsonSerializer.Deserialize<AutoSettings>(json, Json.Options); }
        catch (JsonException) { /* ungültig: Standardwerte */ }
        if (s is null || !Validator.TryValidateObject(s, new ValidationContext(s), null, validateAllProperties: true)) return new AutoSettings();
        return s;
    }

    public static Task SetSettings(BastionDb db, AutoSettings value) => SetSetting(db, SettingsKey, Json.Serialize(value));

    public static async Task<AutoState> GetState(BastionDb db)
    {
        var json = await GetSetting(db, StateKey);
        try { return (json is null ? null : JsonSerializer.Deserialize<AutoState>(json, Json.Options)) ?? new AutoState(); }
        catch (JsonException) { return new AutoState(); }
    }

    private static Task SetState(BastionDb db, AutoState state) => SetSetting(db, StateKey, Json.SerializeCompact(state));

    /// <summary>Kompakter Fingerabdruck des Datenstands: ändert sich bei neuen, geänderten oder gelöschten Einträgen, Ordnern und Schlüsselpaketen.</summary>
    public static async Task<string> Signature(BastionDb db) =>
        (await db.Database.SqlQueryRaw<string>("""
            SELECT concat_ws('|',
              (SELECT id::text FROM emergency_keys ORDER BY created_at DESC LIMIT 1),
              (SELECT count(*) FROM items), (SELECT max(updated_at) FROM items),
              (SELECT count(*) FROM folders), (SELECT max(updated_at) FROM folders),
              (SELECT count(*) FROM emergency_approvals),
              (SELECT count(*) FROM emergency_folder_keys), (SELECT count(*) FROM emergency_folder_keys WHERE wrapped_secret_key IS NOT NULL),
              (SELECT count(*) FROM emergency_personal_keys)
            ) AS "Value"
            """).ToListAsync()).FirstOrDefault() ?? "";

    /// <summary>Datum und Uhrzeit in der eingestellten Zeitzone</summary>
    private static (string Date, string Time) LocalNow(string timezone, DateTime nowUtc)
    {
        var tz = TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out var z) ? z : TimeZoneInfo.Utc;
        var local = TimeZoneInfo.ConvertTimeFromUtc(nowUtc, tz);
        return (local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), local.ToString("HH:mm", CultureInfo.InvariantCulture));
    }

    // ---------- Takt ----------

    public async Task Tick(DateTime nowUtc)
    {
        lock (gate) if (running is not null) return;
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BastionDb>();
        var settings = await GetSettings(db);
        if (!settings.Enabled) return;
        if (!await db.EmergencyTargets.AnyAsync(t => t.Enabled)) return;
        if (!await db.EmergencyKeys.AnyAsync()) return;

        var state = await GetState(db);
        var sig = await Signature(db);
        if (sig != state.Signature)
        {
            state.Signature = sig;
            state.ChangedAt = AuditService.Iso(nowUtc);
            await SetState(db, state);
        }
        var local = LocalNow(settings.Timezone, nowUtc);
        var dailyDue = settings.DailyTime is not null && string.CompareOrdinal(local.Time, settings.DailyTime) >= 0 && state.DailyDate != local.Date;
        var changeDue = sig != state.ExportedSignature && state.ChangedAt is not null
            && nowUtc - DateTime.Parse(state.ChangedAt, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal) >= TimeSpan.FromMinutes(settings.DebounceMinutes);
        if (!dailyDue && !changeDue) return;

        var results = await Run(dailyDue ? "daily" : "change");
        var fresh = await GetState(db);
        // Täglicher Lauf zählt auch bei Fehlern als erledigt (Warnung kommt über die Fehlerzählung), Änderungen nur bei vollem Erfolg
        if (dailyDue) fresh.DailyDate = local.Date;
        if (results.Count > 0 && results.All(r => r.Ok)) fresh.ExportedSignature = sig;
        await SetState(db, fresh);
    }

    // ---------- Export ----------

    /// <summary>Export an alle aktiven Ziele (oder ein bestimmtes). Läuft nie parallel.</summary>
    public Task<List<TargetResult>> Run(string trigger, Guid? targetId = null, Actor? actor = null)
    {
        lock (gate)
        {
            if (running is not null) return running;
            running = DoRun(trigger, targetId, actor);
            _ = running.ContinueWith(_ => { lock (gate) running = null; }, TaskScheduler.Default);
            return running;
        }
    }

    private async Task<List<TargetResult>> DoRun(string trigger, Guid? targetId, Actor? actor)
    {
        await Task.Yield();
        using var scope = scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<BastionDb>();
        var backups = sp.GetRequiredService<EmergencyBackupService>();
        var key = await backups.ActiveKey();
        if (key is null) return [];
        var targets = await db.EmergencyTargets.AsNoTracking()
            .Where(t => targetId != null ? t.Id == targetId : t.Enabled)
            .OrderBy(t => t.Name)
            .ToListAsync();
        if (targets.Count == 0) return [];
        var backup = await backups.Build(key);
        var name = EmergencyBackupService.FileName(backup.CreatedAt);
        var data = Encoding.UTF8.GetBytes(Json.Serialize(backup.File));
        var toolPath = Path.Combine(config.WebDist, "tools", EmergencyTargets.ToolFile);
        var tool = File.Exists(toolPath) ? await File.ReadAllBytesAsync(toolPath) : null;

        var crypto = sp.GetRequiredService<CryptoUtil>();
        var results = new List<TargetResult>();
        foreach (var t in targets) results.Add(await ExportTo(db, crypto, sp.GetRequiredService<MailService>(), t, name, data, tool));

        var failed = results.Where(r => !r.Ok).ToList();
        var metadata = new Dictionary<string, object?> { ["trigger"] = trigger, ["file"] = name };
        foreach (var (k, v) in EmergencyBackupService.StatsFields(backup.Stats)) metadata[k] = v;
        metadata["targets"] = results.Select(r => new { name = r.Name, ok = r.Ok, deleted = r.Deleted, error = r.Error }).ToList();
        await sp.GetRequiredService<AuditService>().Log(new AuditEntry(
            failed.Count > 0 ? "emergency.auto_failed" : "emergency.auto_exported",
            Actor: actor,
            TargetType: "emergency_key",
            TargetId: key.Id.ToString(),
            Metadata: metadata));
        var state = await GetState(db);
        state.LastRunAt = AuditService.Iso(DateTime.UtcNow);
        await SetState(db, state);
        if (failed.Count > 0) logger.LogWarning("Export teilweise fehlgeschlagen: {Errors}", string.Join("; ", failed.Select(f => $"{f.Name}: {f.Error}")));
        else logger.LogInformation("Notfall-Backup {File} an {Count} Ziel(e) exportiert ({Trigger})", name, results.Count, trigger);
        return results;
    }

    private async Task<TargetResult> ExportTo(BastionDb db, CryptoUtil crypto, MailService mail, EmergencyTarget t, string name, byte[] data, byte[]? tool)
    {
        var result = new TargetResult { Id = t.Id, Name = t.Name };
        try
        {
            var cfg = TargetSchemas.ParseConfig(t.Type, JsonNode.Parse(t.Config));
            var stored = t.SecretsEnc is null ? [] : JsonSerializer.Deserialize<Dictionary<string, string>>(crypto.ServerDecrypt(t.SecretsEnc)) ?? [];
            var secrets = TargetSchemas.ParseSecrets(t.Type, stored);
            await using (var driver = await EmergencyTargets.Open(cfg, secrets, config.EmergencyBackupDir))
            {
                await driver.Put(name, data);
                if (tool is not null) await driver.Put(EmergencyTargets.ToolFile, tool);
                result.Deleted = 0;
                if (t.Keep > 0)
                {
                    var old = (await driver.List())
                        .Where(f => EmergencyTargets.BackupFile().IsMatch(f))
                        .Order(StringComparer.Ordinal)
                        .Reverse()
                        .Skip(t.Keep)
                        .ToList();
                    foreach (var f in old)
                    {
                        try
                        {
                            await driver.Remove(f);
                            result.Deleted++;
                        }
                        catch (Exception)
                        {
                            // z. B. Löschschutz auf dem Ziel: Löschen nicht erlaubt – kein Fehler des Exports
                        }
                    }
                }
            }
            result.Ok = true;
            result.File = name;
            var now = DateTime.UtcNow;
            await db.EmergencyTargets.Where(x => x.Id == t.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.LastRunAt, now).SetProperty(x => x.LastSuccessAt, now).SetProperty(x => x.LastFile, name)
                .SetProperty(x => x.LastError, (string?)null).SetProperty(x => x.Failures, 0).SetProperty(x => x.UpdatedAt, now));
        }
        catch (Exception e)
        {
            var message = e is ApiException ? "Ungültige Einstellungen des Ziels" : e.Message;
            result.Error = message.Length > 500 ? message[..500] : message;
            var now = DateTime.UtcNow;
            await db.EmergencyTargets.Where(x => x.Id == t.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.LastRunAt, now).SetProperty(x => x.LastError, result.Error)
                .SetProperty(x => x.Failures, x => x.Failures + 1).SetProperty(x => x.UpdatedAt, now));
            var failures = await db.EmergencyTargets.Where(x => x.Id == t.Id).Select(x => x.Failures).FirstOrDefaultAsync();
            if (failures == AlertAfter)
            {
                try { await Alert(db, mail, t.Name, result.Error); }
                catch (Exception) { /* Warnung ist nur ein Zusatz */ }
            }
        }
        return result;
    }

    /// <summary>Warn-Mail an alle aktiven System-Admins (einmal pro Fehlerserie).</summary>
    private async Task Alert(BastionDb db, MailService mail, string targetName, string? lastError)
    {
        if (!(await GetSettings(db)).AlertMail) return;
        var admins = await db.Users.Where(u => u.SystemRole == SystemRole.SYSTEM_ADMIN && u.Status == UserStatus.ACTIVE).Select(u => u.Email).ToListAsync();
        var text =
            $"Der automatische Export des Bastion-Notfall-Backups an das Ziel „{targetName}“ ist {AlertAfter}-mal hintereinander fehlgeschlagen.\n\n" +
            $"Letzter Fehler: {lastError ?? "–"}\n\nBitte prüfen Sie das Ziel unter System → Notfall-Backup ({config.PublicUrl}/system/emergency).\n\n" +
            $"The automatic export of the Bastion emergency backup to \"{targetName}\" failed {AlertAfter} times in a row.";
        var html = $"<p>{WebUtility.HtmlEncode(text).Replace("\n", "<br>")}</p>";
        foreach (var email in admins)
            await mail.Send(email, "Bastion: Notfall-Backup-Export fehlgeschlagen / Emergency backup export failed", text, html);
    }
}
