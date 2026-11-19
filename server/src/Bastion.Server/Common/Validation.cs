using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;

namespace Bastion.Server.Common;

// Validierung der Request-Bodys über DataAnnotations. Verletzungen ergeben 400 VALIDATION_FAILED mit Feldliste
// (siehe Program.cs, InvalidModelStateResponseFactory). Unbekannte Felder werden beim Einlesen verworfen.

public static partial class Patterns
{
    [GeneratedRegex("^[A-Za-z0-9+/]+={0,2}$")]
    public static partial Regex Base64();

    /// <summary>Im Browser verschlüsselter Wert: v1.&lt;iv&gt;.&lt;chiffretext&gt;</summary>
    [GeneratedRegex(@"^v1\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$")]
    public static partial Regex Encrypted();

    [GeneratedRegex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")]
    public static partial Regex Email();

    [GeneratedRegex("^[0-9a-f]{64}$")]
    public static partial Regex Sha256Hex();
}

/// <summary>Base64 mit Längengrenzen (öffentliche Schlüssel, verpackte Schlüssel, Signaturen, Auth-Hash).</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class B64Attribute(int min, int max) : ValidationAttribute("base64 expected")
{
    public override bool IsValid(object? value) =>
        value is null || (value is string s && s.Length >= min && s.Length <= max && Patterns.Base64().IsMatch(s));
}

/// <summary>Im Browser verschlüsselter Wert (v1.iv.ct) mit Höchstlänge.</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class EncAttribute(int max = 200_000) : ValidationAttribute("encrypted value expected")
{
    public override bool IsValid(object? value) =>
        value is null || (value is string s && s.Length <= max && Patterns.Encrypted().IsMatch(s));
}

/// <summary>E-Mail-Adresse (wird vor der Prüfung getrimmt; Kleinschreibung übernimmt <see cref="Normalize.Email"/>).</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class EmailAddrAttribute() : ValidationAttribute("Invalid email address")
{
    public override bool IsValid(object? value) =>
        value is null || (value is string s && s.Trim().Length <= 254 && Patterns.Email().IsMatch(s.Trim()));
}

/// <summary>Getrimmter Text mit Mindest- und Höchstlänge.</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class TrimmedAttribute(int min, int max) : ValidationAttribute($"text with {min}-{max} characters expected")
{
    public override bool IsValid(object? value) =>
        value is null || (value is string s && s.Trim().Length >= min && s.Trim().Length <= max);
}

/// <summary>Regulärer Ausdruck, der nur geprüft wird, wenn ein Wert vorhanden ist.</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class MatchAttribute(string pattern) : ValidationAttribute("invalid format")
{
    private readonly Regex regex = new(pattern, RegexOptions.CultureInvariant);
    public override bool IsValid(object? value) => value is null || (value is string s && regex.IsMatch(s));
}

/// <summary>Höchstzahl an Elementen einer Liste.</summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class ItemsAttribute(int min, int max) : ValidationAttribute($"between {min} and {max} items expected")
{
    public override bool IsValid(object? value) =>
        value is null || (value is System.Collections.ICollection c && c.Count >= min && c.Count <= max);
}

/// <summary>Validiert auch die Elemente einer Liste von Objekten (DataAnnotations prüfen sonst nur die oberste Ebene).</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class ValidateEachAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is not System.Collections.IEnumerable list) return ValidationResult.Success;
        var index = 0;
        foreach (var item in list)
        {
            if (item is null) return new ValidationResult($"{context.MemberName}.{index}: required");
            var results = new List<ValidationResult>();
            if (!Validator.TryValidateObject(item, new ValidationContext(item), results, validateAllProperties: true))
            {
                var first = results[0];
                return new ValidationResult(first.ErrorMessage, first.MemberNames.Select(n => $"{context.MemberName}.{index}.{n}"));
            }
            index++;
        }
        return ValidationResult.Success;
    }
}

public static class Normalize
{
    public static string Email(string s) => s.Trim().ToLowerInvariant();
}

/// <summary>Mindestwerte der KDF nach RFC 9106 / BSI TR-02102-1 (Argon2id) – gemeinsame Felder mehrerer Requests.</summary>
public interface IKdfParams
{
    string KdfSalt { get; }
    int KdfMemory { get; }
    int KdfIterations { get; }
    int KdfParallelism { get; }
}

public static class Limits
{
    public const int KdfMemoryMin = 65536, KdfMemoryMax = 1048576, KdfIterationsMin = 3, KdfIterationsMax = 20;
    public const string RecoveryVerifier = "^[0-9a-f]{64}$";
}
