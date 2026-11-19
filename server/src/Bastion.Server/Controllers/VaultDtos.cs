using System.ComponentModel.DataAnnotations;
using System.Net;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

// Request-Bodys für Einträge und Schlüsselverteilung.

public static class ItemTypes
{
    public static readonly string[] All = ["LOGIN", "NOTE", "CARD", "BANK_ACCOUNT", "SSH_KEY", "API_KEY"];
    public static ItemType Parse(string s) => Enum.Parse<ItemType>(s);
}

public class ItemBodyDto
{
    [AllowedValues("LOGIN", "NOTE", "CARD", "BANK_ACCOUNT", "SSH_KEY", "API_KEY")] public required string Type { get; init; }
    /// <summary>Pflichtfeld; null = persönlicher Tresor.</summary>
    public required Guid? FolderId { get; init; }
    [Enc(20_000)] public required string Overview { get; init; }
    [Enc(200_000)] public required string Secret { get; init; }
}

public sealed class ItemInputDto : ItemBodyDto
{
    public required Guid Id { get; init; }
}

public sealed class ItemUpdateDto : ItemBodyDto
{
    public required int Revision { get; init; }
}

public sealed class BulkItemsDto
{
    [Items(1, 2000)] public required List<ItemInputDto> Items { get; init; }
}

public sealed class ExportEventDto
{
    [Range(1, 1_000_000)] public required int Count { get; init; }
    [Items(0, 5000)] public required List<Guid> Folders { get; init; }
}

public sealed class ItemEventDto
{
    [AllowedValues("reveal", "copy")] public required string Event { get; init; }
    [StringLength(40)] public string? Field { get; init; }
}

public sealed class FolderKeyGrantDto
{
    public required Guid FolderId { get; init; }
    public required Guid UserId { get; init; }
    [B64(500, 1000)] public string? WrappedKey { get; init; }
    [B64(500, 1000)] public string? WrappedSecretKey { get; init; }
    /// <summary>Herkunftsnachweis des Absenders über beide Schlüsselpakete (siehe FolderKeyProof).</summary>
    [B64(684, 684)] public string? Signature { get; init; }
}

public sealed class FolderKeyGrantsDto
{
    [Items(1, 5000)] public required List<FolderKeyGrantDto> Grants { get; init; }
}

public sealed class FolderKeyAttestationDto
{
    public required Guid FolderId { get; init; }
    [B64(684, 684)] public required string Signature { get; init; }
}

/// <summary>Einmalige Übernahme der eigenen Ordnerschlüssel aus der Zeit vor dem Herkunftsnachweis.</summary>
public sealed class FolderKeyAttestDto
{
    [Items(0, 20_000)] public required List<FolderKeyAttestationDto> Attestations { get; init; }
    /// <summary>Vertrauensanker mit dem Vermerk, dass die Übernahme erfolgt ist (verschlüsselt mit dem AccountKey).</summary>
    [Enc(8192)] public required string Anchor { get; init; }
}

public sealed class RecoveryGrantDto
{
    public required Guid UserId { get; init; }
    [B64(500, 1000)] public required string WrappedKey { get; init; }
}

public sealed class RecoveryGrantsDto
{
    [Items(1, 500)] public required List<RecoveryGrantDto> Grants { get; init; }
}

public sealed class RecoveryAccountKeyDto
{
    [B64(500, 1000)] public required string RecoveryAccountKey { get; init; }
}

public sealed class RecoveryVerifierDto
{
    [Match(Limits.RecoveryVerifier)] public required string RecoveryVerifier { get; init; }
}

public sealed class TenantInitDto
{
    [B64(300, 1200)] public required string RecoveryPublicKey { get; init; }
    [Enc(8192)] public required string ProtectedRecoveryPrivateKey { get; init; }
    [B64(500, 1000)] public required string WrappedKey { get; init; }
    [B64(500, 1000)] public required string RecoveryAccountKey { get; init; }
    [B64(80, 140)] public required string SigningPublicKey { get; init; }
    [Enc(2048)] public required string ProtectedSigningPrivateKey { get; init; }
    [B64(86, 90)] public required string Endorsement { get; init; }
    [Enc(8192)] public required string TrustAnchor { get; init; }
}

public sealed class EndorsementInputDto
{
    public required Guid UserId { get; init; }
    [B64(86, 90)] public required string Signature { get; init; }
}

public sealed class TenantSigningDto
{
    [B64(80, 140)] public required string SigningPublicKey { get; init; }
    [Enc(2048)] public required string ProtectedSigningPrivateKey { get; init; }
    [Items(1, 10_000)] public required List<EndorsementInputDto> Endorsements { get; init; }
    [Enc(8192)] public required string TrustAnchor { get; init; }
}

public sealed class AnchorDto
{
    [Enc(8192)] public required string Data { get; init; }
}

/// <summary>INSERT … ON CONFLICT DO NOTHING (wie createMany mit skipDuplicates); liefert die Zahl der neu angelegten Zeilen.</summary>
internal static class InsertIgnore
{
    public static async Task<int> Item(BastionDb db, Guid id, ItemType type, Guid? tenantId, Guid? folderId, Guid? ownerId, string overview, string secret, Guid actorId)
    {
        var now = DateTime.UtcNow;
        var t = type.ToString();
        return await db.Database.ExecuteSqlAsync($"""
            INSERT INTO items (id, type, tenant_id, folder_id, owner_id, overview, secret, revision, created_by_id, updated_by_id, created_at, updated_at)
            VALUES ({id}, {t}, {tenantId}, {folderId}, {ownerId}, {overview}, {secret}, 1, {actorId}, {actorId}, {now}, {now})
            ON CONFLICT DO NOTHING
            """);
    }

    public static async Task<int> FolderKey(BastionDb db, Data.FolderKey k)
    {
        return await db.Database.ExecuteSqlAsync($"""
            INSERT INTO folder_keys (id, folder_id, user_id, wrapped_key, wrapped_secret_key, created_by_id, created_at,
              signer_id, signer_public_key, signer_endorsement, signature, stripped_secret_hash)
            VALUES ({k.Id}, {k.FolderId}, {k.UserId}, {k.WrappedKey}, {k.WrappedSecretKey}, {k.CreatedById}, {k.CreatedAt},
              {k.SignerId}, {k.SignerPublicKey}, {k.SignerEndorsement}, {k.Signature}, {k.StrippedSecretHash})
            ON CONFLICT DO NOTHING
            """);
    }

    public static async Task<int> RecoveryGrant(BastionDb db, Guid tenantId, Guid userId, string wrappedKey)
    {
        var now = DateTime.UtcNow;
        var id = Guid.NewGuid();
        return await db.Database.ExecuteSqlAsync($"""
            INSERT INTO recovery_grants (id, tenant_id, user_id, wrapped_key, created_at)
            VALUES ({id}, {tenantId}, {userId}, {wrappedKey}, {now})
            ON CONFLICT DO NOTHING
            """);
    }

    public static async Task<int> Endorsement(BastionDb db, Guid tenantId, Guid userId, string signature, Guid signedById)
    {
        var now = DateTime.UtcNow;
        var id = Guid.NewGuid();
        return await db.Database.ExecuteSqlAsync($"""
            INSERT INTO key_endorsements (id, tenant_id, user_id, signature, signed_by_id, created_at)
            VALUES ({id}, {tenantId}, {userId}, {signature}, {signedById}, {now})
            ON CONFLICT DO NOTHING
            """);
    }

    public static async Task<int> TrustAnchor(BastionDb db, Guid userId, Guid tenantId, string data)
    {
        var now = DateTime.UtcNow;
        var id = Guid.NewGuid();
        return await db.Database.ExecuteSqlAsync($"""
            INSERT INTO trust_anchors (id, user_id, tenant_id, data, created_at)
            VALUES ({id}, {userId}, {tenantId}, {data}, {now})
            ON CONFLICT DO NOTHING
            """);
    }

    /// <summary>Vertrauensanker anlegen oder ersetzen (upsert).</summary>
    public static async Task UpsertTrustAnchor(BastionDb db, Guid userId, Guid tenantId, string data)
    {
        var now = DateTime.UtcNow;
        var id = Guid.NewGuid();
        await db.Database.ExecuteSqlAsync($"""
            INSERT INTO trust_anchors (id, user_id, tenant_id, data, created_at)
            VALUES ({id}, {userId}, {tenantId}, {data}, {now})
            ON CONFLICT (user_id, tenant_id) DO UPDATE SET data = EXCLUDED.data
            """);
    }
}

/// <summary>Validierungsfehler für Query-Parameter im selben Format wie bei Request-Bodys.</summary>
internal static class QueryValidation
{
    public static ApiException Failed(string path, string message) =>
        new(HttpStatusCode.BadRequest, "VALIDATION_FAILED", new[] { new { path, message } });
}
