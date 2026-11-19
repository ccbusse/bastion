using Sodium;

namespace Bastion.Server.Auth;

/// <summary>
/// Serverseitiges Hashing. Der Client sendet nie das Masterpasswort, sondern einen per HKDF aus dem Argon2id-Masterkey
/// abgeleiteten 256-Bit-Auth-Hash. Dieser wird hier erneut mit Argon2id gehasht (libsodium, PHC-Format), damit ein
/// Datenbank-Leck keinen direkt verwendbaren Anmeldewert liefert. Parameter: 19 MiB, 3 Durchläufe, 1 Thread (über der OWASP-Empfehlung von 19 MiB und 2 Durchläufen;
/// libsodium verlangt mindestens 3).
/// </summary>
public sealed class PasswordService
{
    private const int MemLimit = 19456 * 1024;
    private const long OpsLimit = 3;
    private readonly Lazy<string> dummyHash;

    /// <summary>
    /// Höchstzahl gleichzeitiger Berechnungen. Jede belegt 19 MiB und einen Prozessorkern; ohne Grenze könnten viele
    /// gleichzeitige Anmeldeversuche Arbeitsspeicher und Prozessor erschöpfen. Weitere Anfragen warten, bis ein Platz frei ist.
    /// </summary>
    private static readonly int MaxParallel = Math.Clamp(Environment.ProcessorCount * 2, 4, 16);
    private readonly SemaphoreSlim slots = new(MaxParallel, MaxParallel);

    public PasswordService()
    {
        SodiumCore.Init();
        dummyHash = new Lazy<string>(() => HashSync("bastion-dummy-value"));
    }

    private static string HashSync(string value) =>
        PasswordHash.ArgonHashString(value, OpsLimit, MemLimit).TrimEnd('\0');

    private async Task<T> Limited<T>(Func<T> work)
    {
        await slots.WaitAsync();
        try
        {
            return await Task.Run(work);
        }
        finally
        {
            slots.Release();
        }
    }

    public Task<string> Hash(string value) => Limited(() => HashSync(value));

    public Task<bool> Verify(string? hashed, string value) => Limited(() =>
    {
        if (string.IsNullOrEmpty(hashed))
        {
            // Gleiche Laufzeit wie bei existierenden Konten (Schutz vor User-Enumeration)
            try { PasswordHash.ArgonHashStringVerify(dummyHash.Value, value); } catch { /* egal */ }
            return false;
        }
        try
        {
            return PasswordHash.ArgonHashStringVerify(hashed, value);
        }
        catch
        {
            return false;
        }
    });
}
