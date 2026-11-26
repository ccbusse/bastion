using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;
using Bastion.Server.Common;

namespace Bastion.Server.Controllers;

// Request-Bodys der System-Administration.

public sealed partial class CreateTenantDto : IValidatableObject
{
    [Trimmed(1, 120)] public required string Name { get; init; }
    /// <summary>Wird getrimmt und kleingeschrieben geprüft (siehe <see cref="NormalizedSlug"/>).</summary>
    [Required(AllowEmptyStrings = true)] public required string Slug { get; init; }
    public bool RequireMfa { get; init; }
    public bool AddSelfAsAdmin { get; init; }
    [EmailAddr] public string? AdminEmail { get; init; }
    [Trimmed(0, 120)] public string? AdminName { get; init; }

    public string NormalizedSlug => Slug.Trim().ToLowerInvariant();

    [GeneratedRegex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")]
    private static partial Regex SlugPattern();

    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        var slug = NormalizedSlug;
        if (slug.Length is < 2 or > 40 || !SlugPattern().IsMatch(slug))
            yield return new ValidationResult("invalid slug", [nameof(Slug)]);
        if (!AddSelfAsAdmin && string.IsNullOrEmpty(AdminEmail))
            yield return new ValidationResult("adminEmail or addSelfAsAdmin required", [nameof(AdminEmail)]);
    }
}

public sealed class UpdateTenantDto
{
    [Trimmed(1, 120)] public string? Name { get; init; }
    public bool? RequireMfa { get; init; }
}

public sealed class InviteAdminDto
{
    [EmailAddr] public required string Email { get; init; }
    [Trimmed(0, 120)] public string? Name { get; init; }
}

public sealed class SystemSettingsDto
{
    public bool? RequireMfaForSystemAdmins { get; init; }
    [Range(1, 240)] public int? AutoLockMinutes { get; init; }
    [Range(1, 480)] public int? ExtensionAutoLockMinutes { get; init; }
}

public sealed class SmtpDto
{
    [Required(AllowEmptyStrings = true), MaxLength(255)] public required string Host { get; init; }
    [Range(1, 65535)] public required int Port { get; init; }
    [AllowedValues("tls", "starttls", "none")] public required string Security { get; init; }
    [Required(AllowEmptyStrings = true), MaxLength(255)] public string Username { get; init; } = "";
    [MaxLength(500)]
    public string? Password
    {
        get => password;
        init { password = value; PasswordProvided = true; }
    }
    private readonly string? password;
    /// <summary>Feld war im Request vorhanden (auch mit null): Passwort ändern bzw. löschen.</summary>
    [System.Text.Json.Serialization.JsonIgnore] public bool PasswordProvided { get; private init; }
    [EmailAddr] public required string FromAddress { get; init; }
    [Trimmed(0, 120)] public string FromName { get; init; } = "Bastion";
}

public sealed class SmtpTestDto
{
    [EmailAddr] public required string To { get; init; }
}
