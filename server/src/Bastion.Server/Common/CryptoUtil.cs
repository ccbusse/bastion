using System.Security.Cryptography;
using System.Text;

namespace Bastion.Server.Common;

/// <summary>
/// Server-seitige Kryptografie. Alle Schlüssel werden per HKDF aus APP_SECRET abgeleitet, getrennt nach Zweck.
/// Tresorinhalte verschlüsselt der Server nie – nur Betriebsgeheimnisse (TOTP-Secrets, SMTP- und Exportziel-Zugangsdaten).
/// </summary>
public sealed class CryptoUtil
{
    private readonly byte[] encKey;
    private readonly byte[] macKey;
    private readonly byte[] auditKey;

    public CryptoUtil(AppConfig config)
    {
        encKey = DeriveServerKey(config.AppSecret, "bastion:server-encryption:v1");
        macKey = DeriveServerKey(config.AppSecret, "bastion:server-mac:v1");
        auditKey = DeriveServerKey(config.AppSecret, "bastion:audit-chain:v1");
    }

    private static byte[] DeriveServerKey(string secret, string label) =>
        HKDF.DeriveKey(HashAlgorithmName.SHA256, Encoding.UTF8.GetBytes(secret), 32, Encoding.UTF8.GetBytes("bastion-server"), Encoding.UTF8.GetBytes(label));

    /// <summary>HMAC für die Audit-Hash-Kette: ohne APP_SECRET lässt sich die Kette nach einer Manipulation nicht neu berechnen.</summary>
    public string AuditMac(string data) => Convert.ToHexStringLower(HMACSHA256.HashData(auditKey, Encoding.UTF8.GetBytes(data)));

    /// <summary>Token-Hash für die Ablage in der Datenbank (Sitzungen, Einladungen): HMAC, damit ein DB-Leck allein nicht reicht.</summary>
    public string TokenHash(string token) => Convert.ToHexStringLower(HMACSHA256.HashData(macKey, Encoding.UTF8.GetBytes(token)));

    public byte[] HmacBytes(string label, string data, int length = 16)
    {
        var mac = HMACSHA256.HashData(macKey, Encoding.UTF8.GetBytes(label + "\0" + data));
        return mac[..length];
    }

    /// <summary>AES-256-GCM für Betriebsgeheimnisse. Format: s1.&lt;iv&gt;.&lt;chiffretext&gt;.&lt;tag&gt; (Base64).</summary>
    public string ServerEncrypt(string plaintext)
    {
        var iv = RandomNumberGenerator.GetBytes(12);
        var pt = Encoding.UTF8.GetBytes(plaintext);
        var ct = new byte[pt.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(encKey, 16);
        aes.Encrypt(iv, pt, ct, tag);
        return string.Join('.', "s1", Convert.ToBase64String(iv), Convert.ToBase64String(ct), Convert.ToBase64String(tag));
    }

    public string ServerDecrypt(string value)
    {
        var parts = value.Split('.');
        if (parts.Length != 4 || parts[0] != "s1") throw new CryptographicException("Invalid ciphertext format");
        var iv = Convert.FromBase64String(parts[1]);
        var ct = Convert.FromBase64String(parts[2]);
        var tag = Convert.FromBase64String(parts[3]);
        var pt = new byte[ct.Length];
        using var aes = new AesGcm(encKey, 16);
        aes.Decrypt(iv, ct, tag, pt);
        return Encoding.UTF8.GetString(pt);
    }

    // ---------- zustandslose Hilfsfunktionen ----------

    public static string Sha256Hex(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
    public static string Sha256Hex(string data) => Sha256Hex(Encoding.UTF8.GetBytes(data));

    /// <summary>Zufallstoken (Standard 256 Bit), Base64url ohne Auffüllung.</summary>
    public static string RandomToken(int bytes = 32) => Base64Url(RandomNumberGenerator.GetBytes(bytes));

    public static string Base64Url(byte[] data) => Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Vergleich in konstanter Zeit.</summary>
    public static bool SafeEqual(string a, string b)
    {
        var ab = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        return ab.Length == bb.Length && CryptographicOperations.FixedTimeEquals(ab, bb);
    }

    /// <summary>Fingerprint eines öffentlichen Schlüssels: SHA-256 über SPKI, 128 Bit in 8 Gruppen à 4 Hex-Zeichen.</summary>
    public static string PublicKeyFingerprint(string publicKeyB64)
    {
        var hex = Sha256Hex(Convert.FromBase64String(publicKeyB64))[..32].ToUpperInvariant();
        return string.Join('-', Enumerable.Range(0, 8).Select(i => hex.Substring(i * 4, 4)));
    }

    /// <summary>Gut lesbares Zufallspasswort ohne verwechselbare Zeichen (gleichverteilt per Rejection Sampling).</summary>
    public static string RandomReadablePassword(int length = 24) => RandomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789", length);

    public static string RandomFromAlphabet(string alphabet, int length)
    {
        var sb = new StringBuilder(length);
        while (sb.Length < length)
        {
            var b = RandomNumberGenerator.GetBytes(1)[0];
            if (b < 256 - (256 % alphabet.Length)) sb.Append(alphabet[b % alphabet.Length]);
        }
        return sb.ToString();
    }
}
