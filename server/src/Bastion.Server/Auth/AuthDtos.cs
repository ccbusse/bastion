using System.ComponentModel.DataAnnotations;
using Bastion.Server.Common;

namespace Bastion.Server.Auth;

// Request-Bodys der Anmeldung, Ersteinrichtung und Einladung. Pflichtfelder sind "required"; fehlende oder falsch
// typisierte Felder ergeben 400 VALIDATION_FAILED.

/// <summary>Parameter der Schlüsselableitung (Argon2id) im Browser – Mindestwerte nach RFC 9106 / BSI TR-02102-1.</summary>
public class KdfDto
{
    [B64(22, 88)] public required string KdfSalt { get; init; }
    [Range(Limits.KdfMemoryMin, Limits.KdfMemoryMax)] public required int KdfMemory { get; init; }
    [Range(Limits.KdfIterationsMin, Limits.KdfIterationsMax)] public required int KdfIterations { get; init; }
    [Range(1, 16)] public required int KdfParallelism { get; init; }
}

/// <summary>Vollständiges Schlüsselpaket eines Kontos (bei Ersteinrichtung und Annahme einer Einladung).</summary>
public class AccountKeysDto : KdfDto
{
    [B64(43, 44)] public required string AuthHash { get; init; }
    [Enc(512)] public required string ProtectedAccountKey { get; init; }
    [Enc(512)] public required string ProtectedPersonalKey { get; init; }
    [B64(300, 1200)] public required string PublicKey { get; init; }
    [Enc(8192)] public required string ProtectedPrivateKey { get; init; }
}

public sealed class EmailDto
{
    [EmailAddr] public required string Email { get; init; }
}

public sealed class SetupLoginDto
{
    [AllowedValues("admin")] public required string Username { get; init; }
    [StringLength(200, MinimumLength = 1)] public required string Password { get; init; }
}

public sealed class CompleteSetupDto : AccountKeysDto
{
    [EmailAddr] public required string Email { get; init; }
    [Trimmed(1, 120)] public required string Name { get; init; }
}

public sealed class LoginDto
{
    [EmailAddr] public required string Email { get; init; }
    [B64(43, 44)] public required string AuthHash { get; init; }
    [StringLength(100)] public string? DeviceLabel { get; init; }
}

public sealed class MfaCodeDto
{
    [StringLength(20, MinimumLength = 6)] public required string Code { get; init; }
}

public sealed class TotpCodeDto
{
    [Match("^[0-9]{6}$")] public required string Code { get; init; }
}

public sealed class AuthHashDto
{
    [B64(43, 44)] public required string AuthHash { get; init; }
}

public sealed class ChangePasswordDto : KdfDto
{
    [B64(43, 44)] public required string CurrentAuthHash { get; init; }
    [B64(43, 44)] public required string AuthHash { get; init; }
    [Enc(512)] public required string ProtectedAccountKey { get; init; }
    [Enc(512)] public required string ProtectedPersonalKey { get; init; }
}

public sealed class LocaleDto
{
    [AllowedValues("de", "en")] public required string Locale { get; init; }
}

public sealed class InvitationTokenDto
{
    [Match("^[A-Za-z0-9_-]{40,64}$")] public required string Token { get; init; }
}

public sealed class AcceptInvitationDto : AccountKeysDto
{
    [Match("^[A-Za-z0-9_-]{40,64}$")] public required string Token { get; init; }
    [Trimmed(1, 120)] public required string Name { get; init; }
    [B64(500, 1000)] public string? RecoveryAccountKey { get; init; }
    [Match(Limits.RecoveryVerifier)] public required string RecoveryVerifier { get; init; }
    [Enc(8192)] public string? TrustAnchor { get; init; }
}
