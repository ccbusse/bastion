using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding.Validation;

namespace Bastion.Server.Emergency;

/// <summary>Nur aktive System-Admins (Notfallschlüssel, Export, Exportziele).</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class RequireActiveSystemAdminAttribute : Attribute, IAuthorizationFilter
{
    public void OnAuthorization(AuthorizationFilterContext ctx)
    {
        var user = ctx.HttpContext.Auth().User;
        if (user.SystemRole != SystemRole.SYSTEM_ADMIN || user.Status != UserStatus.ACTIVE) throw ApiException.Forbidden();
    }
}

public sealed class CreateEmergencyKeyDto
{
    [B64(43, 44)] public required string AuthHash { get; init; }
    public Guid? ReplaceKeyId { get; init; }
    public required Guid Id { get; init; }
    [B64(700, 1000)] public required string PublicKey { get; init; }
    [Enc(8192)] public required string ProtectedPrivateKey { get; init; }

    // Mindestparameter für die Argon2id-Ableitung aus der Passphrase (deutlich über denen des Masterpassworts)
    [B64(22, 88)] public required string KdfSalt { get; init; }
    [Range(262144, 4194304)] public required int KdfMemory { get; init; }
    [Range(4, 50)] public required int KdfIterations { get; init; }
    [Range(1, 16)] public required int KdfParallelism { get; init; }
    [Enc(8192)] public required string Anchor { get; init; }
}

public sealed class EmergencyAnchorDto
{
    public required Guid KeyId { get; init; }
    [Enc(8192)] public required string Data { get; init; }
}

public sealed class EmergencyApproveDto
{
    public required Guid KeyId { get; init; }
    [B64(86, 90)] public required string Signature { get; init; }
}

public sealed class FolderWrapDto
{
    public required Guid FolderId { get; init; }
    [B64(500, 1000)] public required string WrappedKey { get; init; }
    [B64(500, 1000)] public string? WrappedSecretKey { get; init; }
}

public sealed class EmergencyWrapsDto
{
    public required Guid KeyId { get; init; }
    [Items(0, 5000)] public List<FolderWrapDto> Folders { get; init; } = [];
    [B64(500, 1000)] public string? Personal { get; init; }
}

public sealed class TargetInputDto
{
    [Trimmed(1, 100)] public required string Name { get; init; }
    public required EmergencyTargetType Type { get; init; }
    public bool Enabled { get; init; } = true;
    [Range(0, 10_000)] public int Keep { get; init; } = 30;
    [ValidateNever] public required JsonObject Config { get; init; }
    /// <summary>Leere oder fehlende Werte: bisherige Zugangsdaten behalten</summary>
    [ValidateNever] public Dictionary<string, string>? Secrets { get; init; }
}

public sealed class TestTargetDto
{
    public Guid? Id { get; init; }
    [StringLength(100)] public string Name { get; init; } = "Test";
    public required EmergencyTargetType Type { get; init; }
    public bool Enabled { get; init; } = true;
    [Range(0, 10_000)] public int Keep { get; init; } = 30;
    [ValidateNever] public required JsonObject Config { get; init; }
    [ValidateNever] public Dictionary<string, string>? Secrets { get; init; }
}

public sealed class RunExportDto
{
    public Guid? TargetId { get; init; }
}

/// <summary>Zeitplan des automatischen Exports (Tabelle system_settings, Schlüssel emergency.auto).</summary>
public sealed class AutoSettings : IValidatableObject
{
    public bool Enabled { get; init; }
    /// <summary>Ruhezeit nach der letzten Änderung, bevor exportiert wird</summary>
    [Range(1, 1440)] public int DebounceMinutes { get; init; } = 5;
    /// <summary>Täglicher Export unabhängig von Änderungen ("HH:MM"), null = aus</summary>
    [Match("^([01][0-9]|2[0-3]):[0-5][0-9]$")] public string? DailyTime { get; init; } = "02:00";
    [StringLength(64)] public string Timezone { get; init; } = "Europe/Berlin";
    /// <summary>Warn-Mail an alle System-Admins, wenn ein Ziel mehrmals hintereinander fehlschlägt</summary>
    public bool AlertMail { get; init; } = true;

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        if (!TimeZoneInfo.TryFindSystemTimeZoneById(Timezone, out _)) yield return new ValidationResult("invalid time zone", [nameof(Timezone)]);
    }
}
