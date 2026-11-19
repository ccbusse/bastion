using System.ComponentModel.DataAnnotations;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

// Request-Bodys der Organisationsverwaltung (Benutzer, Struktur, Rollen, Tenant).

public sealed class ScopeAssignmentDto
{
    public required Guid RoleId { get; init; }
    public required ScopeType ScopeType { get; init; }
    public Guid? DepartmentId { get; init; }
    public Guid? FolderId { get; init; }
}

public sealed class InviteUserDto
{
    [EmailAddr] public required string Email { get; init; }
    [StringLength(120)] public string? Name { get; init; }
    [Items(0, 50)] public List<ScopeAssignmentDto>? Assignments { get; init; }
}

public sealed class UserNameDto
{
    [Trimmed(1, 120)] public required string Name { get; init; }
}

public sealed class FingerprintDto
{
    [StringLength(64, MinimumLength = 10)] public required string Fingerprint { get; init; }
}

public sealed class SignatureDto
{
    [B64(86, 90)] public required string Signature { get; init; }
}

public sealed class RecoverDto : Auth.KdfDto
{
    [B64(43, 44)] public required string AuthHash { get; init; }
    [Enc(512)] public required string ProtectedAccountKey { get; init; }
    [Enc(512)] public required string ProtectedPersonalKey { get; init; }
    [B64(43, 44)] public required string RecoveryProof { get; init; }
}

public sealed class DepartmentCreateDto
{
    [Trimmed(1, 100)] public required string Name { get; init; }
    [StringLength(500)] public string? Description { get; init; }
}

public sealed class DepartmentUpdateDto
{
    [Trimmed(1, 100)] public string? Name { get; init; }
    [StringLength(500)] public string? Description { get; init; }
}

public sealed class FolderKeyDto
{
    public required Guid UserId { get; init; }
    [B64(500, 1000)] public required string WrappedKey { get; init; }
    [B64(500, 1000)] public string? WrappedSecretKey { get; init; }
    /// <summary>Herkunftsnachweis des Absenders über beide Schlüsselpakete (siehe FolderKeyProof).</summary>
    [B64(684, 684)] public string? Signature { get; init; }
}

public sealed class FolderCreateDto
{
    /// <summary>Vom Client vergebene Kennung: Die Herkunftsnachweise der Schlüssel sind an sie gebunden.</summary>
    public Guid? Id { get; init; }
    public required Guid DepartmentId { get; init; }
    public Guid? ParentId { get; init; }
    [Trimmed(1, 100)] public required string Name { get; init; }
    [StringLength(500)] public string? Description { get; init; }
    public bool? InheritPermissions { get; init; }
    // WrappedSecretKey: Schlüssel für die Geheimteile, nur für Empfänger mit "reveal"
    [Items(1, 5000)] public required List<FolderKeyDto> Keys { get; init; }
}

public sealed class FolderUpdateDto
{
    [Trimmed(1, 100)] public string? Name { get; init; }
    [StringLength(500)] public string? Description { get; init; }
    public bool? InheritPermissions { get; init; }
}

public sealed class SecretItemDto
{
    public required Guid Id { get; init; }
    public required int Revision { get; init; }
    [Enc(200_000)] public required string Secret { get; init; }
}

public sealed class SecretKeyUpgradeDto
{
    [B64(500, 1000)] public required string WrappedSecretKey { get; init; }
    /// <summary>Eigener Herkunftsnachweis über den (unveränderten) Ordnerschlüssel und den neuen Geheim-Schlüssel.</summary>
    [B64(684, 684)] public string? Signature { get; init; }
    [Items(0, 20_000)] public required List<SecretItemDto> Items { get; init; }
}

public sealed class RotatedItemDto
{
    public required Guid Id { get; init; }
    public required int Revision { get; init; }
    [Enc(20_000)] public required string Overview { get; init; }
    [Enc(200_000)] public required string Secret { get; init; }
}

public sealed class RotateKeyDto
{
    [Items(1, 5000)] public required List<FolderKeyDto> Keys { get; init; }
    [Items(0, 20_000)] public required List<RotatedItemDto> Items { get; init; }
    /// <summary>Einträge, die der Browser nicht entschlüsseln konnte und nach Bestätigung unverändert übernimmt (nur fürs Audit-Log).</summary>
    [Items(0, 20_000)] public List<Guid>? KeptUnreadable { get; init; }
}

public sealed class RoleCreateDto
{
    [Trimmed(1, 80)] public required string Name { get; init; }
    [StringLength(300)] public string? Description { get; init; }
    public required List<string> Permissions { get; init; }
}

public sealed class RoleUpdateDto
{
    [Trimmed(1, 80)] public string? Name { get; init; }
    [StringLength(300)] public string? Description { get; init; }
    public List<string>? Permissions { get; init; }
}

public sealed class AssignDto
{
    public required Guid UserId { get; init; }
    public required Guid RoleId { get; init; }
    public required ScopeType ScopeType { get; init; }
    public Guid? DepartmentId { get; init; }
    public Guid? FolderId { get; init; }
}

public sealed class TenantUpdateDto
{
    public bool? RequireMfa { get; init; }
    public bool? RequireJoinApproval { get; init; }
    [Trimmed(1, 120)] public string? Name { get; init; }
}

internal static class OrgHelpers
{
    /// <summary>Verletzung eines Eindeutigkeitsindex (z. B. gleicher Name auf derselben Ebene).</summary>
    public static bool IsUniqueViolation(DbUpdateException e) => e.InnerException is Npgsql.PostgresException { SqlState: "23505" };

    public static ApiException Invalid(string path, string message) =>
        new(System.Net.HttpStatusCode.BadRequest, "VALIDATION_FAILED", new[] { new { path, message } });

    /// <summary>Getrimmter Text oder null (optionale Felder).</summary>
    public static string? Trim(string? s) => s?.Trim();
}
