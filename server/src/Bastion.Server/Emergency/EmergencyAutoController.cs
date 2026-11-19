using Bastion.Server.Auth;
using System.Text.Json;
using System.Text.Json.Nodes;
using Bastion.Server.Common;
using Bastion.Server.Controllers;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Emergency;

/// <summary>Automatischer Export des Notfall-Backups: Ziele, Zeitplan, Verbindungstest (nur System-Admins).</summary>
[Route("api/emergency/auto")]
[RequireActiveSystemAdmin]
public sealed class EmergencyAutoController(BastionDb db, EmergencyAutoService auto, AuditService audit, CryptoUtil crypto, AppConfig config, OrgService org) : BastionController
{
    /// <summary>Änderungen an Exportzielen allen anderen System-Admins melden (Zugangsdaten und Ziel bestimmen, wohin Backups gehen).</summary>
    private Task NotifyOthers(string de, string en) =>
        org.NotifySystemAdmins(new MailEvent($"Der System-Admin {Auth.User.Email} {de}", $"System admin {Auth.User.Email} {en}"), Auth.User.Id);

    private Dictionary<string, string> StoredSecrets(EmergencyTarget t)
    {
        if (t.SecretsEnc is null) return [];
        try { return JsonSerializer.Deserialize<Dictionary<string, string>>(crypto.ServerDecrypt(t.SecretsEnc)) ?? []; }
        catch (Exception) { return []; }
    }

    /// <summary>Sicht auf ein Ziel ohne Zugangsdaten; <c>secrets</c> zeigt nur, welche hinterlegt sind.</summary>
    private object View(EmergencyTarget t) => new
    {
        id = t.Id,
        name = t.Name,
        type = t.Type,
        enabled = t.Enabled,
        config = Json.Parse(t.Config),
        keep = t.Keep,
        lastRunAt = t.LastRunAt,
        lastSuccessAt = t.LastSuccessAt,
        lastFile = t.LastFile,
        lastError = t.LastError,
        failures = t.Failures,
        createdById = t.CreatedById,
        createdAt = t.CreatedAt,
        updatedAt = t.UpdatedAt,
        secrets = StoredSecrets(t).ToDictionary(kv => kv.Key, kv => kv.Value.Length > 0),
    };

    [HttpGet("")]
    public async Task<object> Status()
    {
        var settings = await EmergencyAutoService.GetSettings(db);
        var state = await EmergencyAutoService.GetState(db);
        var targets = await db.EmergencyTargets.AsNoTracking().OrderBy(t => t.Name).ToListAsync();
        var signature = await EmergencyAutoService.Signature(db);
        return new
        {
            settings,
            lastRunAt = state.LastRunAt,
            // Änderungen seit dem letzten automatischen Export (wartet auf Ruhezeit)
            pendingChanges = state.ExportedSignature is not null && state.ExportedSignature != signature,
            folderBase = config.EmergencyBackupDir,
            targets = targets.Select(View).ToList(),
        };
    }

    [RequireRecentAuth, HttpPut("settings")]
    public async Task<object> Settings(AutoSettings input)
    {
        await EmergencyAutoService.SetSettings(db, input);
        await audit.Log(new AuditEntry("emergency.auto_settings", Actor: Actor.Of(Auth.User), Metadata: input, Meta: Meta));
        return input;
    }

    /// <summary>
    /// Eingaben prüfen und Zugangsdaten mit den gespeicherten zusammenführen.
    /// Gespeicherte Zugangsdaten gelten nur für dasselbe Ziel: Ändert sich eines der Zielfelder (Server, Adresse, Benutzer …),
    /// müssen sie neu eingegeben werden. Sonst ließen sie sich an einen fremden Server umleiten.
    /// </summary>
    private (TargetConfig Cfg, Dictionary<string, string> Secrets) Resolve(EmergencyTargetType type, JsonObject? rawConfig, Dictionary<string, string>? rawSecrets, EmergencyTarget? existing = null)
    {
        var cfg = TargetSchemas.ParseConfig(type, rawConfig);
        var given = (rawSecrets ?? []).Where(kv => kv.Value != "").ToDictionary(kv => kv.Key, kv => kv.Value);
        var sameDestination = existing is not null && existing.Type == type && TargetSchemas.SameDestination(type, existing.Config, cfg);
        if (existing?.SecretsEnc is not null && !sameDestination && given.Count == 0) throw ApiException.BadRequest("SECRETS_REQUIRED_FOR_NEW_DESTINATION");
        var stored = sameDestination ? StoredSecrets(existing!) : [];
        var secrets = TargetSchemas.ParseSecrets(type, given.Count > 0 ? given : stored);
        if (type == EmergencyTargetType.SFTP && string.IsNullOrEmpty(secrets.GetValueOrDefault("password")) && string.IsNullOrEmpty(secrets.GetValueOrDefault("privateKey")))
            throw ApiException.BadRequest("SFTP_CREDENTIALS_REQUIRED");
        return (cfg, secrets);
    }

    /// <summary>Interne Adressen (Bastion-Server und seine Docker-Netze) sind als Ziel nicht zulässig (SSRF-Schutz).</summary>
    private static async Task AssertAllowed(TargetConfig cfg)
    {
        try
        {
            await EmergencyTargets.AssertTargetAllowed(cfg);
        }
        catch (TargetException e)
        {
            throw ApiException.BadRequest(e.Status == "HTTPS_REQUIRED" ? "WEBDAV_HTTPS_REQUIRED" : "TARGET_NOT_ALLOWED");
        }
    }

    private void Apply(EmergencyTarget t, TargetInputDto input, TargetConfig cfg, Dictionary<string, string> secrets)
    {
        if (cfg is SftpTargetConfig { HostKey: null }) throw ApiException.BadRequest("SFTP_HOST_KEY_REQUIRED");
        t.Name = input.Name.Trim();
        t.Type = input.Type;
        t.Enabled = input.Enabled;
        t.Keep = input.Keep;
        t.Config = cfg.ToJson().ToJsonString();
        t.SecretsEnc = secrets.Values.Any(v => v.Length > 0) ? crypto.ServerEncrypt(JsonSerializer.Serialize(secrets)) : null;
    }

    [RequireRecentAuth, HttpPost("targets")]
    public async Task<object> Create(TargetInputDto input)
    {
        var (cfg, secrets) = Resolve(input.Type, input.Config, input.Secrets);
        await AssertAllowed(cfg);
        var t = new EmergencyTarget { CreatedById = Auth.User.Id };
        Apply(t, input, cfg, secrets);
        db.EmergencyTargets.Add(t);
        await db.SaveChangesAsync();
        await audit.Log(new AuditEntry("emergency.target_created", Actor: Actor.Of(Auth.User), TargetType: "emergency_target", TargetId: t.Id.ToString(),
            Metadata: new { name = t.Name, type = t.Type.ToString(), config = cfg.ToJson() }, Meta: Meta));
        await NotifyOthers($"hat das Notfall-Backup-Ziel „{t.Name}“ ({t.Type}) angelegt.", $"created the emergency backup target \"{t.Name}\" ({t.Type}).");
        return View(t);
    }

    [RequireRecentAuth, HttpPut("targets/{id}")]
    public async Task<object> Update(Guid id, TargetInputDto input)
    {
        var existing = await db.EmergencyTargets.FirstOrDefaultAsync(t => t.Id == id) ?? throw ApiException.NotFound("TARGET_NOT_FOUND");
        var (cfg, secrets) = Resolve(input.Type, input.Config, input.Secrets, existing);
        await AssertAllowed(cfg);
        Apply(existing, input, cfg, secrets);
        existing.Failures = 0;
        existing.LastError = null;
        await db.SaveChangesAsync();
        await audit.Log(new AuditEntry("emergency.target_updated", Actor: Actor.Of(Auth.User), TargetType: "emergency_target", TargetId: existing.Id.ToString(),
            Metadata: new { name = existing.Name, type = existing.Type.ToString(), config = cfg.ToJson(), enabled = existing.Enabled }, Meta: Meta));
        await NotifyOthers($"hat das Notfall-Backup-Ziel „{existing.Name}“ ({existing.Type}) geändert.", $"changed the emergency backup target \"{existing.Name}\" ({existing.Type}).");
        return View(existing);
    }

    [RequireRecentAuth, Ok200, HttpPost("targets/{id}/delete")]
    public async Task<object> Remove(Guid id)
    {
        var t = await db.EmergencyTargets.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id) ?? throw ApiException.NotFound("TARGET_NOT_FOUND");
        await db.EmergencyTargets.Where(x => x.Id == t.Id).ExecuteDeleteAsync();
        await audit.Log(new AuditEntry("emergency.target_deleted", Actor: Actor.Of(Auth.User), TargetType: "emergency_target", TargetId: t.Id.ToString(),
            Metadata: new { name = t.Name, type = t.Type.ToString() }, Meta: Meta));
        await NotifyOthers($"hat das Notfall-Backup-Ziel „{t.Name}“ ({t.Type}) gelöscht.", $"deleted the emergency backup target \"{t.Name}\" ({t.Type}).");
        return OkResult;
    }

    /// <summary>Verbindungstest mit den eingegebenen (oder gespeicherten) Zugangsdaten. Liefert bei SFTP den Host-Schlüssel zur Bestätigung.</summary>
    [RequireRecentAuth, Ok200, HttpPost("test")]
    public async Task<object> Test(TestTargetDto input)
    {
        var existing = input.Id is { } id ? await db.EmergencyTargets.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id) : null;
        var (cfg, secrets) = Resolve(input.Type, input.Config, input.Secrets, existing);
        // SFTP: Server-Kennung beim ersten Verbinden merken (wie ssh); die Oberfläche speichert sie mit dem Ziel
        var options = new OpenOptions { TrustOnFirstUse = true };
        object result;
        bool ok;
        try
        {
            var backupCount = await EmergencyTargets.Test(cfg, secrets, config.EmergencyBackupDir, options);
            result = new { ok = true, backups = backupCount, hostKey = options.LearnedHostKey };
            ok = true;
        }
        catch (Exception e)
        {
            var message = e.Message.Length > 500 ? e.Message[..500] : e.Message;
            result = new { ok = false, error = message, hostKey = (e as TargetException)?.HostKey };
            ok = false;
        }
        // Jeder Verbindungstest wird protokolliert (Ziel ohne Zugangsdaten, ob gespeicherte Zugangsdaten verwendet wurden)
        await audit.Log(new AuditEntry("emergency.target_tested",
            Actor: Actor.Of(Auth.User),
            TargetType: "emergency_target",
            TargetId: existing?.Id.ToString(),
            Metadata: new
            {
                type = input.Type.ToString(),
                destination = TargetSchemas.DestinationOf(input.Type, cfg),
                storedSecretsUsed = existing?.SecretsEnc is not null && !(input.Secrets ?? []).Values.Any(v => v.Length > 0),
                ok,
            },
            Meta: Meta));
        return result;
    }

    /// <summary>Export sofort ausführen (alle aktiven Ziele oder ein bestimmtes).</summary>
    [Ok200, HttpPost("run")]
    public async Task<object> Run(RunExportDto body)
    {
        if (!await db.EmergencyKeys.AnyAsync()) throw ApiException.BadRequest("NO_EMERGENCY_KEY");
        var results = await auto.Run("manual", body.TargetId, Actor.Of(Auth.User));
        return new
        {
            results = results.Select(r => new { id = r.Id, name = r.Name, ok = r.Ok, file = r.File, deleted = r.Deleted, error = r.Error }),
        };
    }
}
