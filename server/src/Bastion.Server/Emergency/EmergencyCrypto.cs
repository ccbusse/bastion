using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Bastion.Server.Common;
using Bastion.Server.Services;

namespace Bastion.Server.Emergency;

public sealed record SealedEnvelope(string WrappedKey, string Iv, string Ciphertext);

public static class EmergencyCrypto
{
    /// <summary>
    /// Freigabe des Notfallschlüssels durch einen Tenant: Signatur des Tenant-Signaturschlüssels (ECDSA P-256, SHA-256,
    /// IEEE P1363) über Tenant, Schlüssel-ID und SHA-256 des SPKI. Identisch zu web/src/lib/crypto/emergency.ts.
    /// Maßgeblich ist die Prüfung im Client; der Server prüft zusätzlich, um fehlerhafte Daten früh abzuweisen.
    /// </summary>
    public static string ApprovalMessage(Guid tenantId, Guid keyId, string publicKeyB64) =>
        $"bastion:emergency-approve:v1|{tenantId}|{keyId}|{CryptoUtil.Sha256Hex(Convert.FromBase64String(publicKeyB64))}";

    public static bool VerifyApproval(string signingPublicKeyB64, Guid tenantId, Guid keyId, string publicKeyB64, string signatureB64)
    {
        try
        {
            return Endorsement.VerifyEcdsa(signingPublicKeyB64, ApprovalMessage(tenantId, keyId, publicKeyB64), signatureB64);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    /// <summary>Prüft, ob ein SPKI ein RSA-Schlüssel mit 4096 Bit ist.</summary>
    public static bool IsRsa4096(string publicKeyB64)
    {
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKeyB64), out _);
            return rsa.KeySize == 4096;
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return false;
        }
    }

    public static string BackupAad(Guid keyId, string createdAt) => $"bastion:emergency-backup:v1:{keyId}:{createdAt}";

    /// <summary>
    /// Äußere Hülle der Backup-Datei: zufälliger AES-256-GCM-Schlüssel, RSA-OAEP(SHA-256)-verschlüsselt für den Notfallschlüssel.
    /// So bleiben auch Metadaten (Tenant-, Ordnernamen, E-Mail-Adressen) ohne Notfallschlüssel unlesbar.
    /// Der Inhalt ist vor dem Verschlüsseln gzip-komprimiert. Ciphertext = Daten ‖ 128-Bit-Tag (WebCrypto-Format).
    /// </summary>
    public static SealedEnvelope SealBackup(string publicKeyB64, string aad, string payloadJson)
    {
        var dek = RandomNumberGenerator.GetBytes(32);
        var iv = RandomNumberGenerator.GetBytes(12);
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKeyB64), out _);
            var wrappedKey = rsa.Encrypt(dek, RSAEncryptionPadding.OaepSHA256);

            byte[] compressed;
            using (var ms = new MemoryStream())
            {
                using (var gz = new GZipStream(ms, CompressionLevel.Optimal, leaveOpen: true))
                    gz.Write(Encoding.UTF8.GetBytes(payloadJson));
                compressed = ms.ToArray();
            }
            var output = new byte[compressed.Length + 16];
            using (var aes = new AesGcm(dek, 16))
                aes.Encrypt(iv, compressed, output.AsSpan(0, compressed.Length), output.AsSpan(compressed.Length), Encoding.UTF8.GetBytes(aad));
            return new SealedEnvelope(Convert.ToBase64String(wrappedKey), Convert.ToBase64String(iv), Convert.ToBase64String(output));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(dek);
        }
    }
}
