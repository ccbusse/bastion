using System.Security.Cryptography;
using System.Text;
using Bastion.Server.Common;
using Bastion.Server.Data;

namespace Bastion.Server.Services;

public static class UserView
{
    /// <summary>
    /// Sicht auf ein Konto für die Benutzerverwaltung. Erwartet geladene <c>Assignments</c> (mit Rolle), sofern
    /// <paramref name="withAssignments"/>; <paramref name="endorsed"/> nur, wenn die Beglaubigung abgefragt wurde.
    /// </summary>
    public static object Of(User u, bool withAssignments = false, bool? endorsed = null) => new
    {
        id = u.Id,
        email = u.Email,
        name = u.Name,
        status = u.Status,
        systemRole = u.SystemRole,
        totpEnabled = u.TotpEnabled,
        hasRecoveryKey = u.RecoveryAccountKey is not null,
        fingerprint = u.PublicKey is not null ? CryptoUtil.PublicKeyFingerprint(u.PublicKey) : null,
        // Öffentlicher Schlüssel: Der Admin-Client berechnet den Fingerprint selbst und signiert den Schlüssel bei der Beglaubigung
        publicKey = u.PublicKey,
        endorsed,
        lockedUntil = u.LockedUntil,
        lastLoginAt = u.LastLoginAt,
        confirmedAt = u.ConfirmedAt,
        createdAt = u.CreatedAt,
        isTenantAdmin = withAssignments && u.Assignments.Any(a => a.ScopeType == ScopeType.TENANT && a.Role.Permissions.Contains(P.TenantAdmin)),
        assignments = withAssignments
            ? u.Assignments.Select(a => new
            {
                id = a.Id,
                roleId = a.RoleId,
                roleName = a.Role.Name,
                roleKey = a.Role.Key,
                scopeType = a.ScopeType,
                departmentId = a.DepartmentId,
                folderId = a.FolderId,
            }).ToList()
            : null,
    };
}

/// <summary>
/// Beglaubigung eines öffentlichen Schlüssels: Signatur des Tenant-Signaturschlüssels (ECDSA P-256, SHA-256, IEEE P1363)
/// über Tenant, Benutzer und SHA-256 des SPKI. Identisch zu web/src/lib/crypto/trust.ts.
/// Maßgeblich ist die Prüfung im Client; der Server prüft nur zusätzlich, um fehlerhafte Daten früh abzuweisen.
/// </summary>
public static class Endorsement
{
    public static string Message(Guid tenantId, Guid userId, string publicKeyB64) =>
        $"bastion:endorse:v1|{tenantId}|{userId}|{CryptoUtil.Sha256Hex(Convert.FromBase64String(publicKeyB64))}";

    public static bool Verify(string signingPublicKeyB64, Guid tenantId, Guid userId, string publicKeyB64, string signatureB64) =>
        VerifyEcdsa(signingPublicKeyB64, Message(tenantId, userId, publicKeyB64), signatureB64);

    /// <summary>ECDSA P-256 / SHA-256 mit Signatur im IEEE-P1363-Format (wie WebCrypto).</summary>
    public static bool VerifyEcdsa(string spkiB64, string message, string signatureB64)
    {
        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(spkiB64), out _);
            return key.VerifyData(Encoding.UTF8.GetBytes(message), Convert.FromBase64String(signatureB64), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return false;
        }
    }
}

/// <summary>
/// Herkunftsnachweis eines verpackten Ordnerschlüssels: Signatur des Absenders (RSA-PSS, SHA-256, Salt 32 Byte, mit
/// seinem Kontoschlüssel) über Tenant, Ordner, Empfänger, Absender und die SHA-256-Werte der beiden Schlüsselpakete.
/// Identisch zu web/src/lib/crypto/trust.ts. Maßgeblich ist die Prüfung im Browser des Empfängers (gegen seinen
/// Vertrauensanker); der Server prüft nur zusätzlich, um fehlerhafte Daten früh abzuweisen.
/// </summary>
public static class FolderKeyProof
{
    public static string HashOf(string wrappedB64) => CryptoUtil.Sha256Hex(Convert.FromBase64String(wrappedB64));

    /// <param name="secretHash">SHA-256 des verpackten Geheim-Schlüssels; null, wenn keiner signiert wurde.</param>
    public static string Message(Guid tenantId, Guid folderId, Guid recipientId, Guid signerId, string keyHash, string? secretHash) =>
        $"bastion:folder-key:v1|{tenantId}|{folderId}|{recipientId}|{signerId}|{keyHash}|{secretHash ?? "-"}";

    public static bool Verify(string? signerPublicKeyB64, Guid tenantId, Guid folderId, Guid recipientId, Guid signerId, string wrappedKey, string? wrappedSecretKey, string? signatureB64)
    {
        if (signerPublicKeyB64 is null || signatureB64 is null) return false;
        try
        {
            var message = Message(tenantId, folderId, recipientId, signerId, HashOf(wrappedKey), wrappedSecretKey is null ? null : HashOf(wrappedSecretKey));
            using var rsa = RSA.Create();
            rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(signerPublicKeyB64), out _);
            return rsa.VerifyData(Encoding.UTF8.GetBytes(message), Convert.FromBase64String(signatureB64), HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return false;
        }
    }
}
