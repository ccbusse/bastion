using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;
using System.Text.RegularExpressions;

namespace Bastion.Server.Auth;

/// <summary>Zählerstand eines Schlüssels der Login-Drossel.</summary>
public sealed record ThrottleRow(int Failed, DateTimeOffset WindowStart, DateTimeOffset Touched, DateTimeOffset? BlockedUntil);

/// <summary>Ablage der Zähler (Datenbank im Betrieb, Arbeitsspeicher in Unit-Tests). Jede Operation ist für sich atomar.</summary>
public interface ILoginThrottleStore
{
    Task<ThrottleRow?> Get(string key);
    /// <summary>
    /// Erhöht den Zähler und liefert den neuen Stand. Liegt der Bezugszeitpunkt des vorhandenen Eintrags vor
    /// <paramref name="resetBefore"/>, beginnt die Zählung bei 1. Bezugszeitpunkt ist der Beginn des Zeitfensters
    /// bzw. bei <paramref name="sliding"/> der letzte Fehlversuch.
    /// </summary>
    Task<int> Increment(string key, DateTimeOffset now, DateTimeOffset resetBefore, bool sliding);
    Task Block(string key, DateTimeOffset until);
    Task Remove(string key);
    /// <summary>Entfernt Einträge ohne Wirkung (letzter Fehlversuch vor <paramref name="before"/>, keine laufende Sperre).</summary>
    Task<int> Prune(DateTimeOffset now, DateTimeOffset before);
}

/// <summary>Zähler in der Tabelle login_throttle: gelten für alle Instanzen und überstehen einen Neustart.</summary>
public sealed class DbLoginThrottleStore(BastionDb db) : ILoginThrottleStore
{
    /// <summary>Zeile für SqlQuery (Spaltennamen über die snake_case-Konvention)</summary>
    private sealed class Row
    {
        public int Failed { get; set; }
        public DateTimeOffset WindowStart { get; set; }
        public DateTimeOffset Touched { get; set; }
        public DateTimeOffset? BlockedUntil { get; set; }
    }

    public async Task<ThrottleRow?> Get(string key) =>
        (await db.Database.SqlQuery<Row>($"SELECT failed, window_start, touched, blocked_until FROM login_throttle WHERE key = {key}").ToListAsync())
            .Select(r => new ThrottleRow(r.Failed, r.WindowStart, r.Touched, r.BlockedUntil)).FirstOrDefault();

    public async Task<int> Increment(string key, DateTimeOffset now, DateTimeOffset resetBefore, bool sliding)
    {
        var n = now.UtcDateTime;
        var cutoff = resetBefore.UtcDateTime;
        return (await db.Database.SqlQuery<int>($"""
            INSERT INTO login_throttle AS t (key, failed, window_start, touched)
            VALUES ({key}, 1, {n}, {n})
            ON CONFLICT (key) DO UPDATE SET
              failed = CASE WHEN (CASE WHEN {sliding} THEN t.touched ELSE t.window_start END) < {cutoff} THEN 1 ELSE t.failed + 1 END,
              window_start = CASE WHEN (CASE WHEN {sliding} THEN t.touched ELSE t.window_start END) < {cutoff} THEN {n} ELSE t.window_start END,
              blocked_until = CASE WHEN (CASE WHEN {sliding} THEN t.touched ELSE t.window_start END) < {cutoff} THEN NULL ELSE t.blocked_until END,
              touched = {n}
            RETURNING failed AS "Value"
            """).ToListAsync()).First();
    }

    public async Task Block(string key, DateTimeOffset until)
    {
        var u = until.UtcDateTime;
        await db.Database.ExecuteSqlAsync($"UPDATE login_throttle SET blocked_until = GREATEST(blocked_until, {u}) WHERE key = {key}");
    }

    public async Task Remove(string key) =>
        await db.Database.ExecuteSqlAsync($"DELETE FROM login_throttle WHERE key = {key}");

    public Task<int> Prune(DateTimeOffset now, DateTimeOffset before)
    {
        var n = now.UtcDateTime;
        var b = before.UtcDateTime;
        return db.Database.ExecuteSqlAsync($"DELETE FROM login_throttle WHERE touched < {b} AND (blocked_until IS NULL OR blocked_until < {n})");
    }
}

/// <summary>Zähler im Arbeitsspeicher (Unit-Tests).</summary>
public sealed class MemoryLoginThrottleStore : ILoginThrottleStore
{
    private readonly Dictionary<string, ThrottleRow> rows = [];
    private readonly Lock gate = new();

    public Task<ThrottleRow?> Get(string key)
    {
        lock (gate) return Task.FromResult(rows.GetValueOrDefault(key));
    }

    public Task<int> Increment(string key, DateTimeOffset now, DateTimeOffset resetBefore, bool sliding)
    {
        lock (gate)
        {
            var r = rows.GetValueOrDefault(key);
            if (r is null || (sliding ? r.Touched : r.WindowStart) < resetBefore) r = new ThrottleRow(0, now, now, null);
            rows[key] = r = r with { Failed = r.Failed + 1, Touched = now };
            return Task.FromResult(r.Failed);
        }
    }

    public Task Block(string key, DateTimeOffset until)
    {
        lock (gate)
            if (rows.TryGetValue(key, out var r) && (r.BlockedUntil is null || r.BlockedUntil < until)) rows[key] = r with { BlockedUntil = until };
        return Task.CompletedTask;
    }

    public Task Remove(string key)
    {
        lock (gate) rows.Remove(key);
        return Task.CompletedTask;
    }

    public Task<int> Prune(DateTimeOffset now, DateTimeOffset before)
    {
        lock (gate)
        {
            var old = rows.Where(kv => kv.Value.Touched < before && (kv.Value.BlockedUntil is null || kv.Value.BlockedUntil < now)).Select(kv => kv.Key).ToList();
            foreach (var k in old) rows.Remove(k);
            return Task.FromResult(old.Count);
        }
    }
}

/// <summary>
/// Begrenzung der Passwortversuche.
/// <list type="number">
/// <item>Je Schlüssel – (Konto, IP-Adresse) bzw. (Konto, bekanntes Gerät): nach 5 Fehlversuchen 15 Minuten Sperre, danach
/// steigend bis 24 h. Bekannte Geräte (signiertes Gerätecookie nach erfolgreicher Anmeldung) haben einen eigenen Zähler:
/// Ein Angreifer hinter derselben IP-Adresse (NAT, Proxy, Docker) kann sie daher nicht aussperren.</item>
/// <item>Je Konto für unbekannte Geräte: höchstens 20 Fehlversuche pro Stunde, unabhängig von der IP-Adresse.
/// Bekannte Geräte bleiben davon ausgenommen, der Inhaber kann sich also weiter anmelden.</item>
/// </list>
/// Unbekannte und bekannte Adressen werden gleich behandelt (keine User-Enumeration über die Sperre).
/// Die Zähler liegen in der Datenbank (<see cref="DbLoginThrottleStore"/>): Sie überstehen einen Neustart und gelten für
/// alle Instanzen. Abgelegt werden nur HMAC-Werte der Schlüssel, keine E-Mail- oder IP-Adressen.
/// </summary>
public sealed class LoginThrottle(ILoginThrottleStore store, CryptoUtil crypto, TimeProvider time)
{
    private const int MaxFailed = 5;
    private static readonly TimeSpan BaseBlock = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan MaxBlock = TimeSpan.FromHours(24);

    /// <summary>Kontoweites Limit für Anmeldungen von unbekannten Geräten (verteiltes Raten über viele IP-Adressen).</summary>
    public const int AccountLimit = 20;
    private static readonly TimeSpan AccountWindow = TimeSpan.FromHours(1);

    /// <summary>Audit-Einträge für Fehlversuche mit unbekannten oder inaktiven Adressen: höchstens so viele je IP-Adresse und Stunde.</summary>
    public const int UnknownAuditLimit = 20;

    /// <summary>Einträge ohne Fehlversuch seit so langer Zeit und ohne laufende Sperre werden entfernt.</summary>
    public static readonly TimeSpan Retention = MaxBlock;

    private string Key(char kind, string raw) => $"{kind}:{Convert.ToHexStringLower(crypto.HmacBytes("bastion:throttle:v1", raw, 16))}";

    public async Task AssertAllowed(string key)
    {
        var row = await store.Get(Key('k', key));
        if (row?.BlockedUntil > time.GetUtcNow()) throw ApiException.TooManyRequests();
    }

    public async Task Fail(string key)
    {
        var now = time.GetUtcNow();
        var k = Key('k', key);
        // Ohne Fehlversuch seit 24 h beginnt die Zählung neu (eine Sperre ist dann ohnehin abgelaufen)
        var failed = await store.Increment(k, now, now - Retention, sliding: true);
        if (failed >= MaxFailed)
        {
            var block = BaseBlock * Math.Pow(2, Math.Min(failed - MaxFailed, 20));
            await store.Block(k, now + (block < MaxBlock ? block : MaxBlock));
        }
    }

    public Task Reset(string key) => store.Remove(Key('k', key));

    /// <summary>Kontoweites Limit für unbekannte Geräte.</summary>
    public async Task AssertAccountAllowed(string account)
    {
        var now = time.GetUtcNow();
        var row = await store.Get(Key('a', account));
        if (row is not null && row.WindowStart >= now - AccountWindow && row.Failed >= AccountLimit) throw ApiException.TooManyRequests();
    }

    /// <summary>Verbucht einen Fehlversuch eines unbekannten Geräts; liefert die Zahl im aktuellen Zeitfenster.</summary>
    public Task<int> AccountFail(string account)
    {
        var now = time.GetUtcNow();
        return store.Increment(Key('a', account), now, now - AccountWindow, sliding: false);
    }

    /// <summary>
    /// Zählt einen Fehlversuch mit unbekannter oder inaktiver Adresse je IP-Adresse (Zeitfenster eine Stunde) und liefert die Zahl.
    /// Bis <see cref="UnknownAuditLimit"/> wird jeder Versuch im Audit-Log festgehalten, danach nicht mehr: Das Audit-Log
    /// lässt sich nicht löschen und könnte sonst ohne Anmeldung mit frei erfundenen Adressen gefüllt werden.
    /// </summary>
    public Task<int> UnknownFail(string? ip)
    {
        var now = time.GetUtcNow();
        return store.Increment(Key('u', ip ?? ""), now, now - AccountWindow, sliding: false);
    }

    /// <summary>Abgelaufene Einträge entfernen (regelmäßig aus <see cref="SessionCleanup"/>).</summary>
    public Task<int> Prune()
    {
        var now = time.GetUtcNow();
        return store.Prune(now, now - Retention);
    }
}

/// <summary>
/// Gerätecookie für bekannte Browser (OWASP „Device Cookies“): Nach einer erfolgreichen Anmeldung erhält der Browser ein
/// mit APP_SECRET signiertes Token, gebunden an die E-Mail-Adresse. Mit gültigem Token zählen Fehlversuche getrennt von
/// der IP-Adresse; Dritte hinter derselben IP-Adresse können das Konto auf diesem Gerät daher nicht aussperren.
/// Das Cookie berechtigt zu nichts außer diesem eigenen Zähler.
/// </summary>
public sealed partial class DeviceToken(CryptoUtil crypto, AppConfig config, SessionService sessions)
{
    private static readonly TimeSpan MaxAge = TimeSpan.FromDays(180);

    [GeneratedRegex("^[A-Za-z0-9_-]{16,64}$")]
    private static partial Regex NoncePattern();

    private string Sign(string email, string nonce) => CryptoUtil.Base64Url(crypto.HmacBytes("bastion:device:v1", $"{email}|{nonce}", 16));

    /// <summary>Liefert die Gerätekennung, wenn das Token für diese E-Mail-Adresse gültig ist.</summary>
    public string? Verify(string email, string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 100) return null;
        var parts = token.Split('.');
        if (parts.Length < 2 || parts[0].Length == 0 || parts[1].Length == 0 || !NoncePattern().IsMatch(parts[0])) return null;
        return CryptoUtil.SafeEqual(parts[1], Sign(email, parts[0])) ? parts[0] : null;
    }

    public void SetCookie(HttpResponse res, string email)
    {
        var nonce = CryptoUtil.RandomToken(16);
        res.Cookies.Append(config.DeviceCookie, $"{nonce}.{Sign(email, nonce)}", sessions.CookieOptions(MaxAge));
    }
}
