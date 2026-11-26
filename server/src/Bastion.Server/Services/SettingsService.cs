using System.Text.Json;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Services;

/// <param name="ExtensionAutoLockMinutes">Sperrzeit der Browser-Erweiterung (eigener Wert: sie wird oft und nur kurz geöffnet)</param>
public sealed record SystemSettings(bool RequireMfaForSystemAdmins = false, int AutoLockMinutes = 15, int ExtensionAutoLockMinutes = 60);

public sealed record SmtpSettings(string Host, int Port, string Security, string Username, string? PasswordEnc, string FromAddress, string FromName);

public sealed record SmtpInput(string Host, int Port, string Security, string Username, string FromAddress, string FromName, Optional<string?> Password);

/// <summary>Kennzeichnet, ob ein Feld im Request überhaupt vorhanden war (undefined vs. null in JSON).</summary>
public readonly record struct Optional<T>(bool HasValue, T Value)
{
    public static Optional<T> None => default;
    public static Optional<T> Of(T value) => new(true, value);
}

/// <summary>Systemweite Einstellungen (Tabelle system_setting, Werte als JSON).</summary>
public sealed class SettingsService(BastionDb db, CryptoUtil crypto, SystemSettingsCache cache)
{
    private async Task<T?> Get<T>(string key) where T : class
    {
        var row = await db.SystemSettings.AsNoTracking().FirstOrDefaultAsync(s => s.Key == key);
        return row is null ? null : JsonSerializer.Deserialize<T>(row.Value, Json.Options);
    }

    private async Task Set(string key, object value)
    {
        var json = Json.Serialize(value);
        var row = await db.SystemSettings.FirstOrDefaultAsync(s => s.Key == key);
        if (row is null) db.SystemSettings.Add(new SystemSetting { Key = key, Value = json });
        else row.Value = json;
        await db.SaveChangesAsync();
    }

    public async Task<SystemSettings> GetSystem()
    {
        if (cache.TryGet(out var cached)) return cached;
        var value = await Get<SystemSettings>("system") ?? new SystemSettings();
        cache.Set(value);
        return value;
    }

    public async Task<SystemSettings> SetSystem(bool? requireMfaForSystemAdmins, int? autoLockMinutes, int? extensionAutoLockMinutes = null)
    {
        var current = await GetSystem();
        var value = new SystemSettings(
            requireMfaForSystemAdmins ?? current.RequireMfaForSystemAdmins,
            autoLockMinutes ?? current.AutoLockMinutes,
            extensionAutoLockMinutes ?? current.ExtensionAutoLockMinutes);
        await Set("system", value);
        cache.Clear();
        return value;
    }

    public Task<SmtpSettings?> GetSmtp() => Get<SmtpSettings>("smtp");

    /// <summary>Öffentliche Sicht ohne Passwort.</summary>
    public async Task<object?> GetSmtpPublic()
    {
        var s = await GetSmtp();
        if (s is null) return null;
        return new { s.Host, s.Port, s.Security, s.Username, s.FromAddress, s.FromName, HasPassword = s.PasswordEnc is not null };
    }

    public async Task SetSmtp(SmtpInput input)
    {
        var current = await GetSmtp();
        var passwordEnc = current?.PasswordEnc;
        // Das gespeicherte Passwort gilt nur für denselben Server und Benutzer: sonst ließe es sich an einen fremden Server umleiten
        var destinationChanged = current is null || current.Host != input.Host || current.Port != input.Port || current.Username != input.Username;
        if (!input.Password.HasValue && passwordEnc is not null && destinationChanged)
        {
            // Ohne Benutzer findet keine Anmeldung statt: altes Passwort verwerfen statt umzuleiten
            if (input.Username.Length == 0) passwordEnc = null;
            else throw ApiException.BadRequest("SMTP_PASSWORD_REQUIRED");
        }
        if (input.Password.HasValue)
            passwordEnc = string.IsNullOrEmpty(input.Password.Value) ? null : crypto.ServerEncrypt(input.Password.Value);
        await Set("smtp", new SmtpSettings(input.Host, input.Port, input.Security, input.Username, passwordEnc, input.FromAddress, input.FromName));
    }

    public string? SmtpPassword(SmtpSettings s) => s.PasswordEnc is null ? null : crypto.ServerDecrypt(s.PasswordEnc);
}

/// <summary>Zwischenspeicher der Systemeinstellungen (30 s), wird bei jeder Anfrage im SessionGuard gebraucht.</summary>
public sealed class SystemSettingsCache(TimeProvider time)
{
    private (SystemSettings Value, DateTimeOffset At)? entry;
    private readonly Lock gate = new();

    public bool TryGet(out SystemSettings value)
    {
        lock (gate)
        {
            if (entry is { } e && time.GetUtcNow() - e.At < TimeSpan.FromSeconds(30)) { value = e.Value; return true; }
            value = null!;
            return false;
        }
    }

    public void Set(SystemSettings value) { lock (gate) entry = (value, time.GetUtcNow()); }
    public void Clear() { lock (gate) entry = null; }
}
