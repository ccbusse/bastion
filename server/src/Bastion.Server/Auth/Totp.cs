using System.Security.Cryptography;
using System.Text;

namespace Bastion.Server.Auth;

/// <summary>TOTP nach RFC 6238: SHA-1, 6 Ziffern, 30 s, ±1 Zeitschritt Toleranz.</summary>
public static class Totp
{
    private const int StepSeconds = 30;
    private const string Base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /// <summary>Neues Base32-Secret mit 160 Bit.</summary>
    public static string NewSecret() => Base32Encode(RandomNumberGenerator.GetBytes(20));

    public static string Uri(string label, string secret) =>
        $"otpauth://totp/{System.Uri.EscapeDataString("Bastion")}:{System.Uri.EscapeDataString(label)}?secret={secret}&period={StepSeconds}&digits=6&algorithm=SHA1&issuer=Bastion";

    /// <summary>
    /// Prüft einen Code und liefert den Zeitschritt, zu dem er gehört (null = ungültig).
    /// <paramref name="afterStep"/>: zuletzt akzeptierter Zeitschritt; ältere oder gleiche Codes werden abgelehnt (keine Wiederverwendung).
    /// </summary>
    public static long? Check(string token, string secret, long? afterStep = null, DateTimeOffset? now = null)
    {
        if (token.Length != 6 || !token.All(char.IsAsciiDigit)) return null;
        byte[] key;
        try { key = Base32Decode(secret); } catch (FormatException) { return null; }
        var current = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds() / StepSeconds;
        long? match = null;
        for (var step = current - 1; step <= current + 1; step++)
        {
            if (afterStep is { } after && step <= after) continue;
            var expected = Encoding.ASCII.GetBytes(Code(key, step));
            if (CryptographicOperations.FixedTimeEquals(expected, Encoding.ASCII.GetBytes(token))) match ??= step;
        }
        return match;
    }

    public static string Code(byte[] key, long step)
    {
        Span<byte> counter = stackalloc byte[8];
        System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(counter, step);
        var mac = HMACSHA1.HashData(key, counter);
        var offset = mac[^1] & 0x0f;
        var bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
        return (bin % 1_000_000).ToString("D6");
    }

    public static string Base32Encode(byte[] data)
    {
        var sb = new StringBuilder((data.Length * 8 + 4) / 5);
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(Base32Alphabet[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) sb.Append(Base32Alphabet[(buffer << (5 - bits)) & 31]);
        return sb.ToString();
    }

    public static byte[] Base32Decode(string s)
    {
        var clean = s.TrimEnd('=').ToUpperInvariant();
        var output = new List<byte>(clean.Length * 5 / 8);
        int buffer = 0, bits = 0;
        foreach (var c in clean)
        {
            var v = Base32Alphabet.IndexOf(c);
            if (v < 0) throw new FormatException("Ungültiges Base32");
            buffer = (buffer << 5) | v;
            bits += 5;
            if (bits >= 8)
            {
                output.Add((byte)((buffer >> (bits - 8)) & 0xff));
                bits -= 8;
            }
        }
        return [.. output];
    }
}
