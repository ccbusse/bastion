using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

/// <summary>
/// Schlüsselverteilung (Zero-Knowledge):
/// Der Server kennt keine Ordnerschlüssel. Berechtigte Schlüsselhalter (Tenant-Admins und Manager)
/// verschlüsseln den Ordnerschlüssel im Browser mit dem öffentlichen Schlüssel neuer Berechtigter.
/// GET /keys/pending liefert dafür die offenen Aufgaben.
/// <para>
/// Empfänger müssen beglaubigt sein: Ein Tenant-Admin hat ihren öffentlichen Schlüssel nach Fingerprint-Abgleich
/// mit dem Tenant-Signaturschlüssel signiert. Die Clients prüfen diese Signatur gegen ihren eigenen Vertrauensanker,
/// bevor sie etwas verschlüsseln. Ein Server, der fremde Schlüssel einschleust, erhält dadurch nichts.
/// </para>
/// </summary>
[Route("api/keys")]
public sealed class KeysController(BastionDb db, PermissionService perms, AuditService audit) : BastionController
{
    [AllowExtension, HttpGet("folders")]
    public async Task<object> MyFolderKeys()
    {
        var userId = Auth.User.Id;
        var rows = await db.FolderKeys.AsNoTracking()
            .Where(k => k.UserId == userId)
            .Select(k => new { k.FolderId, k.WrappedKey, k.WrappedSecretKey, k.Folder.SecretKeyed, k.Folder.TenantId, k.SignerId, k.SignerPublicKey, k.SignerEndorsement, k.Signature, k.StrippedSecretHash })
            .ToListAsync();
        // Absender, die beim Verpacken noch nicht beglaubigt waren: ihre inzwischen erteilte Beglaubigung nachreichen
        var late = rows.Where(r => r.SignerId is not null && r.SignerId != userId && r.SignerEndorsement is null).Select(r => r.SignerId!.Value).Distinct().ToList();
        var current = late.Count == 0
            ? []
            : (await db.KeyEndorsements.AsNoTracking().Where(e => late.Contains(e.UserId)).Select(e => new { e.TenantId, e.UserId, e.Signature }).ToListAsync())
                .GroupBy(e => (e.TenantId, e.UserId)).ToDictionary(g => g.Key, g => g.First().Signature);
        // Die Felder ab "signature" sind der Herkunftsnachweis (siehe FolderKeyProof); ältere Clients ignorieren sie
        return rows.Select(r => new
        {
            folderId = r.FolderId,
            wrappedKey = r.WrappedKey,
            wrappedSecretKey = r.WrappedSecretKey,
            secretKeyed = r.SecretKeyed,
            tenantId = r.TenantId,
            signature = r.Signature,
            signer = r.SignerId is { } sid
                ? new { userId = sid, publicKey = r.SignerPublicKey, endorsement = r.SignerEndorsement ?? current.GetValueOrDefault((r.TenantId, sid)) }
                : null,
            strippedSecretHash = r.StrippedSecretHash,
        }).ToList();
    }

    /// <summary>
    /// Einmalige Übernahme der eigenen Ordnerschlüssel aus der Zeit vor dem Herkunftsnachweis: Der Browser bestätigt die
    /// bereits gehaltenen Schlüssel mit einer eigenen Signatur und vermerkt das in seinem Vertrauensanker. Danach verwendet
    /// er nur noch Schlüssel mit gültigem Nachweis. Betrifft ausschließlich eigene Schlüssel ohne Nachweis.
    /// </summary>
    [Ok200, HttpPost("folders/attest")]
    public async Task<object> AttestFolderKeys(FolderKeyAttestDto body)
    {
        var user = Auth.User;
        var tenant = user.Tenant;
        if (tenant?.SigningPublicKey is null) throw ApiException.BadRequest("TENANT_KEYS_NOT_INITIALIZED");
        var folderIds = body.Attestations.Select(a => a.FolderId).Distinct().ToList();
        var rows = await db.FolderKeys.AsNoTracking()
            .Where(k => k.UserId == user.Id && k.Signature == null && folderIds.Contains(k.FolderId) && k.Folder.TenantId == tenant.Id)
            .Select(k => new { k.Id, k.FolderId, k.WrappedKey, k.WrappedSecretKey })
            .ToListAsync();
        var byFolder = rows.ToDictionary(r => r.FolderId);
        var count = 0;
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            foreach (var a in body.Attestations)
            {
                if (!byFolder.TryGetValue(a.FolderId, out var row)) continue;
                if (!FolderKeyProof.Verify(user.PublicKey, tenant.Id, row.FolderId, user.Id, user.Id, row.WrappedKey, row.WrappedSecretKey, a.Signature))
                    throw ApiException.BadRequest("INVALID_KEY_SIGNATURE");
                count += await db.FolderKeys.Where(k => k.Id == row.Id && k.Signature == null).ExecuteUpdateAsync(u => u
                    .SetProperty(k => k.SignerId, user.Id)
                    .SetProperty(k => k.SignerPublicKey, user.PublicKey)
                    .SetProperty(k => k.SignerEndorsement, (string?)null)
                    .SetProperty(k => k.Signature, a.Signature));
            }
            await InsertIgnore.UpsertTrustAnchor(db, user.Id, tenant.Id, body.Anchor);
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("keys.folder_keys_attested", TenantId: tenant.Id, Actor: Actor.Of(user), Metadata: new { count }, Meta: Meta));
        return new { attested = count };
    }

    /// <summary>Beglaubigungen des Tenants (userId → Signatur).</summary>
    private Task<Dictionary<Guid, string>> Endorsements(Guid tenantId) =>
        db.KeyEndorsements.AsNoTracking().Where(e => e.TenantId == tenantId).ToDictionaryAsync(e => e.UserId, e => e.Signature);

    private Task<bool> HasRecoveryGrant(Guid tenantId, Guid userId) =>
        db.RecoveryGrants.AnyAsync(g => g.TenantId == tenantId && g.UserId == userId);

    [HttpGet("pending")]
    public async Task<object> Pending()
    {
        var user = Auth.User;
        var empty = new { folders = Array.Empty<object>(), recovery = Array.Empty<object>() };
        if (user.TenantId is not { } tenantId || user.Tenant?.SigningPublicKey is null) return empty;
        var ctx = await perms.ForUser(user);
        var myKeys = await db.FolderKeys.AsNoTracking().Include(k => k.Folder).Where(k => k.UserId == user.Id && k.Folder.TenantId == tenantId).ToListAsync();
        var shareable = myKeys.Where(k => ctx.CanFolder(PermissionService.Ref(k.Folder), P.VaultManage)).ToList();
        if (shareable.Count == 0 && !ctx.IsTenantAdmin) return empty;

        var contexts = await perms.TenantContexts(tenantId);
        var endorsed = await Endorsements(tenantId);
        var shareableIds = shareable.Select(k => k.FolderId).ToList();
        var holders = await db.FolderKeys.AsNoTracking().Where(k => shareableIds.Contains(k.FolderId))
            .Select(k => new { k.FolderId, k.UserId, k.WrappedSecretKey }).ToListAsync();
        var holderByKey = holders.ToDictionary(h => (h.FolderId, h.UserId));

        var folders = shareable
            .Select(k =>
            {
                var folderRef = PermissionService.Ref(k.Folder);
                return new
                {
                    folderId = k.FolderId,
                    folderName = k.Folder.Name,
                    recipients = contexts
                        .Where(c => endorsed.ContainsKey(c.User.Id))
                        .Select(c =>
                        {
                            var held = holderByKey.GetValueOrDefault((k.FolderId, c.User.Id));
                            var needsKey = held is null && c.Ctx.CanFolder(folderRef, P.VaultView);
                            // Den Geheim-Schlüssel kann nur weitergeben, wer ihn selbst besitzt
                            var needsSecret = k.Folder.SecretKeyed && k.WrappedSecretKey is not null && held?.WrappedSecretKey is null && c.Ctx.CanFolder(folderRef, P.VaultReveal);
                            return new { userId = c.User.Id, name = c.User.Name, email = c.User.Email, publicKey = c.User.PublicKey, endorsement = endorsed[c.User.Id], needsKey, needsSecret };
                        })
                        .Where(r => r.needsKey || r.needsSecret)
                        .ToList(),
                };
            })
            .Where(f => f.recipients.Count > 0)
            .ToList();

        var recovery = new List<object>();
        if (ctx.IsTenantAdmin && await HasRecoveryGrant(tenantId, user.Id))
        {
            var grants = (await db.RecoveryGrants.AsNoTracking().Where(g => g.TenantId == tenantId).Select(g => g.UserId).ToListAsync()).ToHashSet();
            recovery = contexts
                .Where(c => c.Ctx.IsTenantAdmin && !grants.Contains(c.User.Id) && endorsed.ContainsKey(c.User.Id))
                .Select(c => (object)new { userId = c.User.Id, name = c.User.Name, email = c.User.Email, publicKey = c.User.PublicKey, endorsement = endorsed[c.User.Id] })
                .ToList();
        }
        return new { folders, recovery };
    }

    [Ok200, HttpPost("folders")]
    public async Task<object> ShareFolderKeys(FolderKeyGrantsDto body)
    {
        var user = Auth.User;
        var tenantId = user.TenantId ?? throw ApiException.Forbidden();
        var ctx = await perms.ForUser(user);
        var folderIds = body.Grants.Select(g => g.FolderId).Distinct().ToList();
        var myKeys = await db.FolderKeys.AsNoTracking().Include(k => k.Folder)
            .Where(k => k.UserId == user.Id && folderIds.Contains(k.FolderId) && k.Folder.TenantId == tenantId).ToListAsync();
        var mineByFolder = myKeys.ToDictionary(k => k.FolderId);
        foreach (var id in folderIds)
            if (!mineByFolder.TryGetValue(id, out var k) || !ctx.CanFolder(PermissionService.Ref(k.Folder), P.VaultManage)) throw ApiException.Forbidden();

        var contexts = (await perms.TenantContexts(tenantId)).ToDictionary(c => c.User.Id, c => c.Ctx);
        var endorsed = await Endorsements(tenantId);
        var existing = await db.FolderKeys.AsNoTracking().Where(k => folderIds.Contains(k.FolderId))
            .Select(k => new { k.Id, k.FolderId, k.UserId, k.WrappedSecretKey }).ToListAsync();
        var existingByKey = existing.ToDictionary(e => (e.FolderId, e.UserId));

        // Jedes Paket trägt den Herkunftsnachweis des Absenders. Wer den Geheim-Schlüssel nachreicht, verpackt beide
        // Schlüssel neu und ersetzt den Datensatz, damit ein Nachweis immer das ganze Paket abdeckt.
        var created = new List<FolderKey>();
        var replaced = new List<FolderKey>();
        foreach (var g in body.Grants)
        {
            if (!contexts.TryGetValue(g.UserId, out var c) || !endorsed.ContainsKey(g.UserId)) continue;
            var mine = mineByFolder[g.FolderId];
            var folderRef = PermissionService.Ref(mine.Folder);
            if (g.WrappedKey is null || !c.CanFolder(folderRef, P.VaultView)) continue;
            var secretAllowed = g.WrappedSecretKey is not null && mine.Folder.SecretKeyed && mine.WrappedSecretKey is not null && c.CanFolder(folderRef, P.VaultReveal);
            var held = existingByKey.GetValueOrDefault((g.FolderId, g.UserId));
            if (held is not null && !(held.WrappedSecretKey is null && secretAllowed)) continue;
            if (!FolderKeyProof.Verify(user.PublicKey, tenantId, g.FolderId, g.UserId, user.Id, g.WrappedKey, g.WrappedSecretKey, g.Signature))
                throw ApiException.BadRequest("INVALID_KEY_SIGNATURE");
            var row = new FolderKey
            {
                FolderId = g.FolderId,
                UserId = g.UserId,
                WrappedKey = g.WrappedKey,
                WrappedSecretKey = secretAllowed ? g.WrappedSecretKey : null,
                CreatedById = user.Id,
                SignerId = user.Id,
                SignerPublicKey = user.PublicKey,
                SignerEndorsement = endorsed.GetValueOrDefault(user.Id),
                Signature = g.Signature,
                // Signiert, aber nicht übernommen (Empfänger darf Geheimteile nicht sehen): Prüfwert für die Signatur behalten
                StrippedSecretHash = !secretAllowed && g.WrappedSecretKey is not null ? FolderKeyProof.HashOf(g.WrappedSecretKey) : null,
            };
            if (held is null) created.Add(row);
            else
            {
                row.Id = held.Id;
                replaced.Add(row);
            }
        }
        if (created.Count == 0 && replaced.Count == 0) return new { created = 0 };
        var count = 0;
        var secretUpdates = 0;
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            foreach (var g in created) count += await InsertIgnore.FolderKey(db, g);
            // Nur ersetzen, falls der Geheim-Schlüssel noch fehlt (parallele Verteilung durch mehrere Schlüsselhalter)
            foreach (var r in replaced)
            {
                secretUpdates += await db.FolderKeys.Where(k => k.Id == r.Id && k.WrappedSecretKey == null).ExecuteUpdateAsync(u => u
                    .SetProperty(k => k.WrappedKey, r.WrappedKey)
                    .SetProperty(k => k.WrappedSecretKey, r.WrappedSecretKey)
                    .SetProperty(k => k.SignerId, r.SignerId)
                    .SetProperty(k => k.SignerPublicKey, r.SignerPublicKey)
                    .SetProperty(k => k.SignerEndorsement, r.SignerEndorsement)
                    .SetProperty(k => k.Signature, r.Signature)
                    .SetProperty(k => k.StrippedSecretHash, (string?)null));
            }
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("keys.folder_shared",
            TenantId: tenantId,
            Actor: Actor.Of(user),
            Metadata: new
            {
                grants = created.Select(g => new { folderId = g.FolderId, userId = g.UserId, secret = g.WrappedSecretKey is not null }).ToList(),
                secretGrants = secretUpdates,
            },
            Meta: Meta));
        return new { created = count + secretUpdates };
    }

    [Ok200, HttpPost("recovery")]
    public async Task<object> ShareRecovery(RecoveryGrantsDto body)
    {
        var user = Auth.User;
        var tenantId = user.TenantId ?? throw ApiException.Forbidden();
        var ctx = await perms.ForUser(user);
        if (!ctx.IsTenantAdmin) throw ApiException.Forbidden();
        if (!await HasRecoveryGrant(tenantId, user.Id)) throw ApiException.Forbidden();
        var contexts = (await perms.TenantContexts(tenantId)).ToDictionary(c => c.User.Id, c => c.Ctx);
        var endorsed = await Endorsements(tenantId);
        var valid = body.Grants.Where(g => (contexts.GetValueOrDefault(g.UserId)?.IsTenantAdmin ?? false) && endorsed.ContainsKey(g.UserId)).ToList();
        var count = 0;
        foreach (var g in valid) count += await InsertIgnore.RecoveryGrant(db, tenantId, g.UserId, g.WrappedKey);
        if (count > 0)
            await audit.Log(new AuditEntry("keys.recovery_shared", TenantId: tenantId, Actor: Actor.Of(user), Metadata: new { users = valid.Select(g => g.UserId).ToList() }, Meta: Meta));
        return new { created = count };
    }

    /// <summary>Nachträgliches Hinterlegen des eigenen AccountKeys für die Admin-Wiederherstellung.</summary>
    [AllowRestricted, HttpPut("recovery-account")]
    public async Task<object> SetRecoveryAccountKey(RecoveryAccountKeyDto body)
    {
        var user = Auth.User;
        if (user.Tenant?.RecoveryPublicKey is null) throw ApiException.BadRequest("TENANT_KEYS_NOT_INITIALIZED");
        // System-Admins können mehreren Tenants angehören und sind daher von der Tenant-Wiederherstellung ausgenommen
        if (user.SystemRole == SystemRole.SYSTEM_ADMIN) throw ApiException.BadRequest("SYSADMIN_NO_RECOVERY");
        if (user.RecoveryAccountKey is not null) throw ApiException.BadRequest("ALREADY_SET");
        var now = DateTime.UtcNow;
        await db.Users.Where(u => u.Id == user.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.RecoveryAccountKey, body.RecoveryAccountKey).SetProperty(x => x.UpdatedAt, now));
        await audit.Log(new AuditEntry("keys.recovery_enrolled", TenantId: user.TenantId, Actor: Actor.Of(user), Meta: Meta));
        return OkResult;
    }

    /// <summary>Nachweis-Prüfwert für die Admin-Wiederherstellung (für Konten aus der Zeit vor dieser Funktion).</summary>
    [AllowRestricted, HttpPut("recovery-verifier")]
    public async Task<object> SetRecoveryVerifier(RecoveryVerifierDto body)
    {
        if (Auth.User.RecoveryVerifier is not null) throw ApiException.Conflict("ALREADY_SET");
        var now = DateTime.UtcNow;
        await db.Users.Where(u => u.Id == Auth.User.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.RecoveryVerifier, body.RecoveryVerifier).SetProperty(x => x.UpdatedAt, now));
        return OkResult;
    }

    /// <summary>Initialisierung der Tenant-Schlüssel (Recovery und Signatur) durch den ersten Tenant-Admin.</summary>
    [Ok200, HttpPost("tenant-init")]
    public async Task<object> InitTenant(TenantInitDto body)
    {
        var user = Auth.User;
        var tenant = user.Tenant ?? throw ApiException.Forbidden();
        var ctx = await perms.ForUser(user);
        if (!ctx.IsTenantAdmin) throw ApiException.Forbidden();
        if (tenant.RecoveryPublicKey is not null) throw ApiException.BadRequest("ALREADY_INITIALIZED");
        if (user.PublicKey is null || !Endorsement.Verify(body.SigningPublicKey, tenant.Id, user.Id, user.PublicKey, body.Endorsement))
            throw ApiException.BadRequest("INVALID_ENDORSEMENT");
        var now = DateTime.UtcNow;
        var updated = await db.Tenants.Where(t => t.Id == tenant.Id && t.RecoveryPublicKey == null).ExecuteUpdateAsync(u => u
            .SetProperty(t => t.RecoveryPublicKey, body.RecoveryPublicKey)
            .SetProperty(t => t.ProtectedRecoveryPrivateKey, body.ProtectedRecoveryPrivateKey)
            .SetProperty(t => t.SigningPublicKey, body.SigningPublicKey)
            .SetProperty(t => t.ProtectedSigningPrivateKey, body.ProtectedSigningPrivateKey)
            .SetProperty(t => t.UpdatedAt, now));
        if (updated == 0) throw ApiException.BadRequest("ALREADY_INITIALIZED");
        // System-Admins sind von der Tenant-Wiederherstellung ausgenommen
        string? recoveryAccountKey = user.SystemRole == SystemRole.SYSTEM_ADMIN ? null : body.RecoveryAccountKey;
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            db.RecoveryGrants.Add(new RecoveryGrant { TenantId = tenant.Id, UserId = user.Id, WrappedKey = body.WrappedKey });
            db.KeyEndorsements.Add(new KeyEndorsement { TenantId = tenant.Id, UserId = user.Id, Signature = body.Endorsement, SignedById = user.Id });
            await db.SaveChangesAsync();
            await db.Users.Where(u => u.Id == user.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.RecoveryAccountKey, recoveryAccountKey).SetProperty(x => x.UpdatedAt, now));
            await InsertIgnore.UpsertTrustAnchor(db, user.Id, tenant.Id, body.TrustAnchor);
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("tenant.keys_initialized", TenantId: tenant.Id, Actor: Actor.Of(user), Meta: Meta));
        return OkResult;
    }

    /// <summary>
    /// Nachrüsten des Signaturschlüssels für Tenants aus der Zeit vor der Beglaubigung.
    /// Ein Tenant-Admin mit Recovery-Zugang erzeugt das Schlüsselpaar und beglaubigt dabei einmalig die bisherigen Mitglieder.
    /// </summary>
    [Ok200, HttpPost("tenant-signing")]
    public async Task<object> InitSigning(TenantSigningDto body)
    {
        var user = Auth.User;
        var tenant = user.Tenant;
        if (tenant?.RecoveryPublicKey is null) throw ApiException.BadRequest("TENANT_KEYS_NOT_INITIALIZED");
        if (tenant.SigningPublicKey is not null) throw ApiException.BadRequest("ALREADY_INITIALIZED");
        var ctx = await perms.ForUser(user);
        if (!ctx.IsTenantAdmin) throw ApiException.Forbidden();
        if (!await HasRecoveryGrant(tenant.Id, user.Id)) throw ApiException.Forbidden();
        var members = (await perms.TenantContexts(tenant.Id)).ToDictionary(c => c.User.Id, c => c.User);
        var valid = body.Endorsements.Where(e =>
            members.TryGetValue(e.UserId, out var u) && u.PublicKey is not null
            && Endorsement.Verify(body.SigningPublicKey, tenant.Id, e.UserId, u.PublicKey, e.Signature)).ToList();
        if (!valid.Any(e => e.UserId == user.Id)) throw ApiException.BadRequest("INVALID_ENDORSEMENT");
        var now = DateTime.UtcNow;
        var updated = await db.Tenants.Where(t => t.Id == tenant.Id && t.SigningPublicKey == null).ExecuteUpdateAsync(u => u
            .SetProperty(t => t.SigningPublicKey, body.SigningPublicKey)
            .SetProperty(t => t.ProtectedSigningPrivateKey, body.ProtectedSigningPrivateKey)
            .SetProperty(t => t.UpdatedAt, now));
        if (updated == 0) throw ApiException.BadRequest("ALREADY_INITIALIZED");
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            foreach (var e in valid) await InsertIgnore.Endorsement(db, tenant.Id, e.UserId, e.Signature, user.Id);
            await InsertIgnore.UpsertTrustAnchor(db, user.Id, tenant.Id, body.TrustAnchor);
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("tenant.signing_key_initialized", TenantId: tenant.Id, Actor: Actor.Of(user), Metadata: new { endorsed = valid.Select(e => e.UserId).ToList() }, Meta: Meta));
        return new { ok = true, endorsed = valid.Count };
    }

    [HttpGet("tenant-recovery")]
    public async Task<object> TenantRecovery()
    {
        var user = Auth.User;
        var tenant = user.Tenant;
        if (tenant?.RecoveryPublicKey is null) throw ApiException.BadRequest("TENANT_KEYS_NOT_INITIALIZED");
        var ctx = await perms.ForUser(user);
        if (!ctx.IsTenantAdmin) throw ApiException.Forbidden();
        var wrappedKey = await db.RecoveryGrants.Where(g => g.TenantId == tenant.Id && g.UserId == user.Id).Select(g => g.WrappedKey).FirstOrDefaultAsync();
        return new
        {
            recoveryPublicKey = tenant.RecoveryPublicKey,
            protectedRecoveryPrivateKey = tenant.ProtectedRecoveryPrivateKey,
            signingPublicKey = tenant.SigningPublicKey,
            protectedSigningPrivateKey = tenant.ProtectedSigningPrivateKey,
            wrappedKey,
        };
    }

    /// <summary>Vertrauensanker des Benutzers für den aktiven Tenant sowie die aktuell vom Server gemeldeten Tenant-Schlüssel.</summary>
    [AllowRestricted, AllowExtension, HttpGet("anchor")]
    public async Task<object> Anchor()
    {
        var user = Auth.User;
        if (user.Tenant is not { } tenant) return new { anchor = (string?)null, signingPublicKey = (string?)null, recoveryPublicKey = (string?)null };
        var data = await db.TrustAnchors.Where(a => a.UserId == user.Id && a.TenantId == tenant.Id).Select(a => a.Data).FirstOrDefaultAsync();
        return new { anchor = data, signingPublicKey = tenant.SigningPublicKey, recoveryPublicKey = tenant.RecoveryPublicKey };
    }

    /// <summary>Vertrauensanker festlegen (nur, solange keiner existiert; ein bestehender Anker wird nie überschrieben).</summary>
    [AllowRestricted, HttpPut("anchor")]
    public async Task<object> SetAnchor(AnchorDto body)
    {
        var user = Auth.User;
        var tenant = user.Tenant;
        if (tenant?.SigningPublicKey is null) throw ApiException.BadRequest("TENANT_KEYS_NOT_INITIALIZED");
        var count = await InsertIgnore.TrustAnchor(db, user.Id, tenant.Id, body.Data);
        if (count == 0) throw ApiException.Conflict("ALREADY_SET");
        await audit.Log(new AuditEntry("keys.anchor_pinned", TenantId: tenant.Id, Actor: Actor.Of(user), Meta: Meta));
        return OkResult;
    }
}
