using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Bastion.Server.Common;

namespace Bastion.Server.Tests;

/// <summary>
/// Server-Kryptografie. Die Referenzwerte stammen aus der früheren Node.js-Implementierung (crypto.hkdfSync, createHmac,
/// AES-256-GCM): Ableitung und Formate sind damit unverändert.
/// </summary>
public class CryptoTests
{
    internal const string Secret = "unit-test-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789";

    internal static AppConfig Config(string secret = Secret) => AppConfig.Load(key => key switch
    {
        "DATABASE_URL" => "postgresql://u:p@localhost:5432/db",
        "APP_SECRET" => secret,
        "PUBLIC_URL" => "https://vault.example.test",
        _ => null,
    });

    private static readonly CryptoUtil Crypto = new(Config());

    [Fact]
    public void TokenHash_matches_reference() =>
        Assert.Equal("3539a6325eacbc21923a54da62512e163816ca8b7ba682609bb0933a92f1194d", Crypto.TokenHash("token-123"));

    [Fact]
    public void AuditMac_matches_reference() =>
        Assert.Equal("7074579ad7e6b9ae98a2340128db8909d47c8c881d2c1fd15eb4abee3d07234d", Crypto.AuditMac("chain-data"));

    [Fact]
    public void HmacBytes_matches_reference() =>
        Assert.Equal("aLr7cDrc7nEf3WQS+2qQNQ==", Convert.ToBase64String(Crypto.HmacBytes("prelogin", "a@b.test", 16)));

    [Fact]
    public void ServerDecrypt_reads_reference_ciphertext() =>
        Assert.Equal("geheim äöü", Crypto.ServerDecrypt("s1.BwcHBwcHBwcHBwcH.RYL7gcaGuy5+Hbq59Q==.SccWDIMmbmocYNsLdFDwVQ=="));

    [Fact]
    public void ServerEncrypt_roundtrip_uses_fresh_iv()
    {
        var a = Crypto.ServerEncrypt("smtp-passwort");
        var b = Crypto.ServerEncrypt("smtp-passwort");
        Assert.NotEqual(a, b);
        Assert.StartsWith("s1.", a);
        Assert.Equal("smtp-passwort", Crypto.ServerDecrypt(a));
    }

    [Fact]
    public void ServerDecrypt_rejects_tampering_and_other_keys()
    {
        var value = Crypto.ServerEncrypt("x");
        var parts = value.Split('.');
        var ct = Convert.FromBase64String(parts[2]);
        ct[0] ^= 1;
        var tampered = string.Join('.', parts[0], parts[1], Convert.ToBase64String(ct), parts[3]);
        Assert.ThrowsAny<CryptographicException>(() => Crypto.ServerDecrypt(tampered));

        var other = new CryptoUtil(Config("other-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789"));
        Assert.ThrowsAny<CryptographicException>(() => other.ServerDecrypt(value));
        Assert.ThrowsAny<CryptographicException>(() => Crypto.ServerDecrypt("v2.a.b.c"));
    }

    [Fact]
    public void Fingerprint_has_eight_groups()
    {
        var fp = CryptoUtil.PublicKeyFingerprint(Convert.ToBase64String(new byte[] { 1, 2, 3 }));
        Assert.Matches("^([0-9A-F]{4}-){7}[0-9A-F]{4}$", fp);
    }

    [Fact]
    public void Random_values_use_only_the_alphabet()
    {
        var s = CryptoUtil.RandomFromAlphabet("abc", 500);
        Assert.Equal(500, s.Length);
        Assert.All(s, c => Assert.Contains(c, "abc"));
        Assert.DoesNotContain('=', CryptoUtil.RandomToken());
        Assert.Equal(43, CryptoUtil.RandomToken(32).Length);
    }

    [Fact]
    public void SafeEqual_compares_content()
    {
        Assert.True(CryptoUtil.SafeEqual("abc", "abc"));
        Assert.False(CryptoUtil.SafeEqual("abc", "abd"));
        Assert.False(CryptoUtil.SafeEqual("abc", "abcd"));
    }

    [Fact]
    public void Stable_json_matches_reference_and_ignores_key_order()
    {
        var a = JsonNode.Parse("""{ "z": 1, "a": [true, null, "x\"y"], "m": { "b": 2.5, "a": "ü" } }""");
        var b = JsonNode.Parse("""{ "m": { "a": "ü", "b": 2.5 }, "a": [true, null, "x\"y"], "z": 1 }""");
        Assert.Equal("""{"a":[true,null,"x\"y"],"m":{"a":"ü","b":2.5},"z":1}""", Json.Stable(a));
        Assert.Equal(Json.Stable(a), Json.Stable(b));
        Assert.Equal("null", Json.Stable(null));
    }

    [Fact]
    public void FolderKeyProof_binds_folder_recipient_signer_and_both_packages()
    {
        var (tenant, folder, recipient, signer) = (Guid.Parse("11111111-1111-4111-8111-111111111111"), Guid.Parse("22222222-2222-4222-8222-222222222222"),
            Guid.Parse("33333333-3333-4333-8333-333333333333"), Guid.Parse("44444444-4444-4444-8444-444444444444"));
        var key = Convert.ToBase64String("wrapped-folder-key"u8.ToArray());
        var secret = Convert.ToBase64String("wrapped-secret-key"u8.ToArray());
        // Format wie in web/src/lib/crypto/trust.ts (folderKeyMessage)
        Assert.Equal(
            $"bastion:folder-key:v1|{tenant}|{folder}|{recipient}|{signer}|{CryptoUtil.Sha256Hex("wrapped-folder-key"u8.ToArray())}|-",
            Services.FolderKeyProof.Message(tenant, folder, recipient, signer, Services.FolderKeyProof.HashOf(key), null));

        using var rsa = RSA.Create(2048);
        var publicKey = Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo());
        string Sign(string? s) => Convert.ToBase64String(rsa.SignData(
            System.Text.Encoding.UTF8.GetBytes(Services.FolderKeyProof.Message(tenant, folder, recipient, signer, Services.FolderKeyProof.HashOf(key), s is null ? null : Services.FolderKeyProof.HashOf(s))),
            HashAlgorithmName.SHA256, RSASignaturePadding.Pss));

        var both = Sign(secret);
        Assert.True(Services.FolderKeyProof.Verify(publicKey, tenant, folder, recipient, signer, key, secret, both));
        Assert.False(Services.FolderKeyProof.Verify(publicKey, tenant, folder, recipient, signer, key, null, both));
        Assert.False(Services.FolderKeyProof.Verify(publicKey, tenant, folder, recipient, signer, secret, secret, both));
        Assert.False(Services.FolderKeyProof.Verify(publicKey, tenant, Guid.NewGuid(), recipient, signer, key, secret, both));
        Assert.False(Services.FolderKeyProof.Verify(publicKey, tenant, folder, Guid.NewGuid(), signer, key, secret, both));
        Assert.False(Services.FolderKeyProof.Verify(publicKey, tenant, folder, recipient, Guid.NewGuid(), key, secret, both));
        Assert.True(Services.FolderKeyProof.Verify(publicKey, tenant, folder, recipient, signer, key, null, Sign(null)));
        // Fehlende oder unbrauchbare Angaben gelten als ungültig, nicht als Fehler
        Assert.False(Services.FolderKeyProof.Verify(publicKey, tenant, folder, recipient, signer, key, secret, null));
        Assert.False(Services.FolderKeyProof.Verify(null, tenant, folder, recipient, signer, key, secret, both));
        Assert.False(Services.FolderKeyProof.Verify("kein-schluessel", tenant, folder, recipient, signer, key, secret, both));
    }

    [Theory]
    [InlineData("short")]
    [InlineData("CHANGE_ME-CHANGE_ME-CHANGE_ME-CHANGE_ME-1234")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void Config_rejects_weak_secrets(string secret) =>
        Assert.Throws<InvalidOperationException>(() => Config(secret));

    [Fact]
    public void Config_derives_origin_and_cookie_names()
    {
        var c = Config();
        Assert.Equal("https://vault.example.test", c.PublicOrigin);
        Assert.Contains("https://vault.example.test", c.AllowedOrigins);
        Assert.Equal("__Host-bastion_sid", c.SessionCookie);
        Assert.Contains("Host=localhost", AppConfig.ToNpgsql(c.DatabaseUrl));
    }
}
