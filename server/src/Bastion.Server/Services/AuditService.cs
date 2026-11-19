using System.Globalization;
using System.Text.Json.Nodes;
using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Services;

public sealed record Actor(Guid Id, string Email)
{
    public static Actor Of(User u) => new(u.Id, u.Email);
}

public sealed record AuditEntry(
    string Action,
    Guid? TenantId = null,
    Actor? Actor = null,
    string? TargetType = null,
    string? TargetId = null,
    object? Metadata = null,
    RequestMeta? Meta = null);

public sealed record AuditHead(string Id, string Hash, string At);

public sealed record ChainResult(
    bool Ok,
    int Checked,
    int LegacyEntries,
    string? BrokenAt,
    string? Reason,
    AuditHead? Head,
    bool? AnchorOk);

/// <summary>
/// Manipulationssicheres Audit-Log: Jeder Eintrag enthält den HMAC seines Vorgängers (Hash-Kette, Schlüssel aus APP_SECRET).
/// Zusätzlich verhindert ein Datenbank-Trigger UPDATE/DELETE/TRUNCATE, und das Datenbankkonto der Anwendung darf nur anhängen.
/// </summary>
public sealed class AuditService(IDbContextFactory<BastionDb> dbFactory, CryptoUtil crypto, ILogger<AuditService> logger) : IAsyncDisposable, IDisposable
{
    // Eigener Datenbankkontext: Ein Audit-Eintrag speichert nie versehentlich offene Änderungen des Aufrufers mit
    private BastionDb? ownDb;
    private BastionDb db => ownDb ??= dbFactory.CreateDbContext();

    public ValueTask DisposeAsync() => ownDb?.DisposeAsync() ?? ValueTask.CompletedTask;
    public void Dispose() => ownDb?.Dispose();

    public const string Genesis = "0000000000000000000000000000000000000000000000000000000000000000";
    private const long AuditLockId = 7_420_001;
    /// <summary>Ab Version h1: HMAC mit Schlüssel aus APP_SECRET über alle Felder.</summary>
    public const string HmacPrefix = "h1:";
    public const string BaselineKey = "audit.baseline";

    public static string Iso(DateTime t) => t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>Auf Millisekunden gekürzt, damit der aus der Datenbank gelesene Zeitpunkt denselben Hash ergibt.</summary>
    public static DateTime TruncateMs(DateTime t) => new(t.Ticks - t.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);

    public string EntryHash(string prevHash, AuditLog e)
    {
        var fields = new JsonArray(
            prevHash,
            Iso(e.CreatedAt),
            e.TenantId?.ToString() ?? "",
            e.ActorId?.ToString() ?? "",
            e.Action,
            e.TargetType ?? "",
            e.TargetId ?? "",
            Json.Stable(Json.Parse(e.Metadata)),
            e.Ip ?? "",
            e.ActorEmail ?? "",
            e.UserAgent ?? "");
        return HmacPrefix + crypto.AuditMac(Json.Stable(fields));
    }

    public async Task Log(AuditEntry entry)
    {
        try
        {
            await using var tx = await db.Database.BeginTransactionAsync();
            await db.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({AuditLockId})");
            var prevHash = await db.AuditLogs.OrderByDescending(a => a.Id).Select(a => a.Hash).FirstOrDefaultAsync() ?? Genesis;
            // Über JSON normalisiert, damit der Hash genau dem gespeicherten (und später gelesenen) JSONB-Wert entspricht
            var metadata = entry.Metadata is null ? null : Json.Stable(Json.Parse(Json.SerializeCompact(entry.Metadata)));
            var row = new AuditLog
            {
                CreatedAt = TruncateMs(DateTime.UtcNow),
                TenantId = entry.TenantId,
                ActorId = entry.Actor?.Id,
                ActorEmail = entry.Actor?.Email,
                Action = entry.Action,
                TargetType = entry.TargetType,
                TargetId = entry.TargetId,
                Metadata = metadata == "null" ? null : metadata,
                Ip = entry.Meta?.Ip,
                UserAgent = entry.Meta?.UserAgent,
                PrevHash = prevHash,
            };
            row.Hash = EntryHash(prevHash, row);
            db.AuditLogs.Add(row);
            await db.SaveChangesAsync();
            await tx.CommitAsync();
            db.Entry(row).State = EntityState.Detached;
        }
        catch (Exception e)
        {
            // Audit-Fehler dürfen nicht unbemerkt bleiben
            logger.LogError(e, "Audit-Eintrag konnte nicht geschrieben werden: {Action}", entry.Action);
            throw;
        }
    }

    /// <summary>Letzter Eintrag der Kette (Nummer, Hash, Zeitpunkt); dient als externer Anker (Server-Log, Notfall-Backup, Notiz).</summary>
    public async Task<AuditHead?> Head()
    {
        var row = await db.AuditLogs.AsNoTracking().OrderByDescending(a => a.Id).Select(a => new { a.Id, a.Hash, a.CreatedAt }).FirstOrDefaultAsync();
        return row is null ? null : new AuditHead(row.Id.ToString(CultureInfo.InvariantCulture), row.Hash, Iso(row.CreatedAt));
    }

    /// <summary>
    /// Grundlinie der ungeschlüsselten Alt-Einträge, einmalig festgehalten und mit APP_SECRET signiert. In einer neu
    /// angelegten Datenbank ist sie 0: Wer mit Datenbankzugriff Einträge ohne HMAC einschleust, überschreitet sie.
    /// </summary>
    public async Task EnsureBaseline()
    {
        if (await db.SystemSettings.AnyAsync(s => s.Key == BaselineKey)) return;
        var legacyMax = await db.AuditLogs.CountAsync(a => !a.Hash.StartsWith(HmacPrefix));
        db.SystemSettings.Add(new SystemSetting
        {
            Key = BaselineKey,
            Value = Json.Serialize(new { legacyMax, mac = crypto.AuditMac($"bastion:audit-baseline:v1:{legacyMax}") }),
        });
        try { await db.SaveChangesAsync(); } catch (DbUpdateException) { /* parallel angelegt */ }
    }

    private async Task<(int LegacyMax, bool Valid)?> Baseline()
    {
        var row = await db.SystemSettings.AsNoTracking().FirstOrDefaultAsync(s => s.Key == BaselineKey);
        if (Json.Parse(row?.Value) is not JsonObject v) return null;
        if (v["legacyMax"] is not JsonValue lm || !lm.TryGetValue<int>(out var legacyMax)) return null;
        if (v["mac"] is not JsonValue mv || !mv.TryGetValue<string>(out var mac)) return null;
        return (legacyMax, CryptoUtil.SafeEqual(mac, crypto.AuditMac($"bastion:audit-baseline:v1:{legacyMax}")));
    }

    /// <summary>
    /// Prüft die Kette. Einträge ohne HMAC sind nur bis zur festgehaltenen Grundlinie zulässig. Mit <paramref name="anchor"/>
    /// (z. B. aus einem Notfall-Backup oder dem Server-Log) wird zusätzlich geprüft, dass dieser frühere Kettenkopf
    /// unverändert enthalten ist – so fällt auch ein Abschneiden am Ende auf.
    /// </summary>
    public async Task<ChainResult> VerifyChain(string? anchorId = null, string? anchorHash = null)
    {
        var (ok, chk, legacy, brokenAt) = await WalkChain();
        var head = await Head();
        if (!ok) return new ChainResult(false, chk, legacy, brokenAt, "CHAIN_BROKEN", head, null);
        var b = await Baseline();
        if (b is { Valid: false }) return new ChainResult(false, chk, legacy, null, "BASELINE_INVALID", head, null);
        if (b is { } bb && legacy > bb.LegacyMax) return new ChainResult(false, chk, legacy, null, "LEGACY_ABOVE_BASELINE", head, null);
        if (anchorId is not null && anchorHash is not null)
        {
            string? hash = null;
            if (anchorId.Length is > 0 and < 19 && anchorId.All(char.IsAsciiDigit))
            {
                var id = long.Parse(anchorId, CultureInfo.InvariantCulture);
                hash = await db.AuditLogs.Where(a => a.Id == id).Select(a => a.Hash).FirstOrDefaultAsync();
            }
            var anchorOk = hash is not null && hash == anchorHash;
            return anchorOk
                ? new ChainResult(true, chk, legacy, null, null, head, true)
                : new ChainResult(false, chk, legacy, null, "ANCHOR_MISMATCH", head, false);
        }
        return new ChainResult(true, chk, legacy, null, null, head, null);
    }

    private async Task<(bool Ok, int Checked, int Legacy, string? BrokenAt)> WalkChain()
    {
        var prev = Genesis;
        var chk = 0;
        var legacy = 0;
        var keyed = false;
        long cursor = 0;
        while (true)
        {
            var batch = await db.AuditLogs.AsNoTracking().Where(a => a.Id > cursor).OrderBy(a => a.Id).Take(1000).ToListAsync();
            if (batch.Count == 0) break;
            foreach (var row in batch)
            {
                var isKeyed = row.Hash.StartsWith(HmacPrefix, StringComparison.Ordinal);
                // Einträge ohne HMAC lassen sich nicht prüfen; sie zählen gegen die Grundlinie und dürfen nur am Anfang stehen
                var hashOk = !isKeyed || row.Hash == EntryHash(prev, row);
                if (row.PrevHash != prev || !hashOk || (keyed && !isKeyed))
                    return (false, chk, legacy, row.Id.ToString(CultureInfo.InvariantCulture));
                keyed |= isKeyed;
                if (!isKeyed) legacy++;
                prev = row.Hash;
                chk++;
            }
            cursor = batch[^1].Id;
        }
        return (true, chk, legacy, null);
    }

    public async Task<List<object>> List(Guid? tenantId, bool filterTenant, string? action, string? before, int? limit)
    {
        var q = db.AuditLogs.AsNoTracking().AsQueryable();
        if (filterTenant) q = q.Where(a => a.TenantId == tenantId);
        if (!string.IsNullOrEmpty(action)) q = q.Where(a => a.Action.StartsWith(action));
        if (!string.IsNullOrEmpty(before))
        {
            if (!long.TryParse(before, NumberStyles.None, CultureInfo.InvariantCulture, out var b)) throw ApiException.BadRequest("VALIDATION_FAILED");
            q = q.Where(a => a.Id < b);
        }
        var rows = await q.OrderByDescending(a => a.Id).Take(Math.Min(limit ?? 50, 200)).ToListAsync();
        return rows.Select(ToDto).ToList();
    }

    public static object ToDto(AuditLog r) => new
    {
        id = r.Id.ToString(CultureInfo.InvariantCulture),
        tenantId = r.TenantId,
        actorId = r.ActorId,
        actorEmail = r.ActorEmail,
        action = r.Action,
        targetType = r.TargetType,
        targetId = r.TargetId,
        metadata = Json.Parse(r.Metadata),
        ip = r.Ip,
        userAgent = r.UserAgent,
        createdAt = r.CreatedAt,
        prevHash = r.PrevHash,
        hash = r.Hash,
    };
}

/// <summary>Setzt beim Start die Audit-Grundlinie und schreibt den Kettenkopf stündlich ins Server-Log (externer Anker).</summary>
public sealed class AuditHeadLogger(IServiceScopeFactory scopes, ILogger<AuditHeadLogger> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using (var scope = scopes.CreateScope())
        {
            try { await scope.ServiceProvider.GetRequiredService<AuditService>().EnsureBaseline(); }
            catch (Exception e) { logger.LogError("Audit-Grundlinie konnte nicht gesetzt werden: {Message}", e.Message); }
        }
        await LogHead();
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        while (await timer.WaitForNextTickAsync(stop)) await LogHead();
    }

    private async Task LogHead()
    {
        try
        {
            using var scope = scopes.CreateScope();
            var h = await scope.ServiceProvider.GetRequiredService<AuditService>().Head();
            if (h is not null) logger.LogInformation("Audit-Kettenkopf: Eintrag {Id}, {Hash}", h.Id, h.Hash);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning("Audit-Kettenkopf nicht lesbar: {Message}", e.Message);
        }
    }
}
