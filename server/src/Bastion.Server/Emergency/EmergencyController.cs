using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Controllers;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Emergency;

/// <summary>
/// Notfall-Backup (Zero-Knowledge):
/// <list type="bullet">
/// <item>Ein System-Admin erzeugt im Browser den Notfallschlüssel. Auf dem Server liegen nur der öffentliche Schlüssel und der
/// mit Schlüsselblatt und Passphrase verschlüsselte private Schlüssel.</item>
/// <item>Tenant-Admins geben den Schlüssel je Tenant nach Fingerprint-Abgleich frei (Signatur mit dem Tenant-Signaturschlüssel).</item>
/// <item>Die Browser der Schlüsselhalter verpacken danach Ordnerschlüssel und persönliche Schlüssel zusätzlich für den Notfallschlüssel.</item>
/// <item>Der Export bündelt nur Chiffretexte und wird außen noch einmal für den Notfallschlüssel verschlüsselt.
/// Der Server entschlüsselt dabei nichts.</item>
/// </list>
/// </summary>
[Route("api/emergency")]
public sealed class EmergencyController(BastionDb db, PermissionService perms, AuditService audit, AuthService auth, EmergencyBackupService backups) : BastionController
{
    private Task<EmergencyKey?> ActiveKey() => backups.ActiveKey();

    private static string Fp(string publicKey) => CryptoUtil.PublicKeyFingerprint(publicKey);

    // ---------- System-Admins ----------

    [RequireActiveSystemAdmin, HttpGet("status")]
    public async Task<object> Status()
    {
        var key = await ActiveKey();
        if (key is null) return new { key = (object?)null, anchor = (string?)null, coverage = (object?)null, lastExport = (object?)null };
        var creator = key.CreatedById is { } cid ? await db.Users.Where(u => u.Id == cid).Select(u => u.Email).FirstOrDefaultAsync() : null;
        var anchor = await db.EmergencyAnchors.Where(a => a.KeyId == key.Id && a.UserId == Auth.User.Id).Select(a => a.Data).FirstOrDefaultAsync();
        var lastExport = await db.AuditLogs.Where(a => a.Action == "emergency.exported").OrderByDescending(a => a.Id)
            .Select(a => new { createdAt = a.CreatedAt, actorEmail = a.ActorEmail }).FirstOrDefaultAsync();
        return new
        {
            key = new
            {
                id = key.Id,
                publicKey = key.PublicKey,
                fingerprint = Fp(key.PublicKey),
                protectedPrivateKey = key.ProtectedPrivateKey,
                kdfSalt = key.KdfSalt,
                kdfMemory = key.KdfMemory,
                kdfIterations = key.KdfIterations,
                kdfParallelism = key.KdfParallelism,
                createdAt = key.CreatedAt,
                createdBy = creator,
            },
            anchor,
            coverage = await Coverage(key.Id),
            lastExport,
        };
    }

    private sealed record PersonalCoverage(int Users, int CoveredUsers, int Items, int CoveredItems, int DisabledItems);

    private sealed record TenantCoverage(
        Guid Id, string Name, bool Approved, DateTime? ApprovedAt, string? ApprovedBy,
        int Folders, int CoveredFolders, int Items, int CoveredItems, PersonalCoverage Personal);

    private sealed record CoverageResult(List<TenantCoverage> Tenants, PersonalCoverage SystemAdmins);

    /// <summary>Abdeckung je Tenant: freigegeben?, Ordner/Einträge mit Notfall-Schlüsselpaket, persönliche Tresore.</summary>
    private async Task<CoverageResult> Coverage(Guid keyId)
    {
        var tenants = await db.Tenants.AsNoTracking().OrderBy(t => t.Name).Select(t => new { t.Id, t.Name }).ToListAsync();
        var approvals = await db.EmergencyApprovals.AsNoTracking().Where(a => a.KeyId == keyId).Select(a => new { a.TenantId, a.CreatedAt, a.ApprovedById }).ToListAsync();
        var folders = await db.Folders.AsNoTracking().Select(f => new { f.Id, f.TenantId, f.SecretKeyed }).ToListAsync();
        var folderWraps = await db.EmergencyFolderKeys.AsNoTracking().Where(w => w.KeyId == keyId).Select(w => new { w.FolderId, w.WrappedSecretKey }).ToListAsync();
        var itemCount = await db.Items.Where(i => i.FolderId != null && i.DeletedAt == null).GroupBy(i => i.FolderId!.Value).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count);
        var users = await db.Users.AsNoTracking().Where(u => u.Status == UserStatus.ACTIVE || u.Status == UserStatus.DISABLED)
            .Select(u => new { u.Id, u.TenantId, u.SystemRole, u.Status }).ToListAsync();
        var wrappedUsers = (await db.EmergencyPersonalKeys.Where(p => p.KeyId == keyId).Select(p => p.UserId).ToListAsync()).ToHashSet();
        var personalCount = await db.Items.Where(i => i.OwnerId != null && i.DeletedAt == null).GroupBy(i => i.OwnerId!.Value).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count);

        var approverIds = approvals.Where(a => a.ApprovedById != null).Select(a => a.ApprovedById!.Value).ToList();
        var approverEmail = await db.Users.Where(u => approverIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.Email);
        var approvalByTenant = approvals.ToDictionary(a => a.TenantId);
        var wrapByFolder = folderWraps.ToDictionary(w => w.FolderId);

        bool Covered(Guid folderId, bool secretKeyed) => wrapByFolder.TryGetValue(folderId, out var w) && (!secretKeyed || w.WrappedSecretKey is not null);
        int Count(Dictionary<Guid, int> m, Guid id) => m.GetValueOrDefault(id);

        PersonalCoverage Personal(IEnumerable<(Guid Id, UserStatus Status)> all)
        {
            var allList = all.ToList();
            var list = allList.Where(u => u.Status == UserStatus.ACTIVE).ToList();
            return new PersonalCoverage(
                list.Count,
                list.Count(u => wrappedUsers.Contains(u.Id)),
                list.Sum(u => Count(personalCount, u.Id)),
                list.Where(u => wrappedUsers.Contains(u.Id)).Sum(u => Count(personalCount, u.Id)),
                // Deaktivierte Konten können ihren Tresor nicht mehr selbst verpacken: nur als Lücke ausweisen
                allList.Where(u => u.Status == UserStatus.DISABLED && !wrappedUsers.Contains(u.Id)).Sum(u => Count(personalCount, u.Id)));
        }

        var result = tenants.Select(t =>
        {
            var fs = folders.Where(f => f.TenantId == t.Id).ToList();
            var covered = fs.Where(f => Covered(f.Id, f.SecretKeyed)).ToList();
            approvalByTenant.TryGetValue(t.Id, out var a);
            return new TenantCoverage(
                t.Id,
                t.Name,
                a is not null,
                a?.CreatedAt,
                a?.ApprovedById is { } aid ? approverEmail.GetValueOrDefault(aid) : null,
                fs.Count,
                covered.Count,
                fs.Sum(f => Count(itemCount, f.Id)),
                covered.Sum(f => Count(itemCount, f.Id)),
                Personal(users.Where(u => u.SystemRole != SystemRole.SYSTEM_ADMIN && u.TenantId == t.Id).Select(u => (u.Id, u.Status))));
        }).ToList();
        return new CoverageResult(result, Personal(users.Where(u => u.SystemRole == SystemRole.SYSTEM_ADMIN).Select(u => (u.Id, u.Status))));
    }

    /// <summary>Notfallschlüssel anlegen bzw. ersetzen. Beim Ersetzen werden alle Freigaben und Schlüsselpakete verworfen.</summary>
    [RequireActiveSystemAdmin, Ok200, HttpPost("key")]
    public async Task<object> CreateKey(CreateEmergencyKeyDto input)
    {
        await auth.VerifyAuthHash(Auth.User, input.AuthHash, Meta);
        if (!EmergencyCrypto.IsRsa4096(input.PublicKey)) throw ApiException.BadRequest("INVALID_PUBLIC_KEY");
        var current = await ActiveKey();
        // Ersetzen nur mit Angabe des bisherigen Schlüssels (verhindert versehentliches Überschreiben durch parallele Einrichtung)
        if (current?.Id != input.ReplaceKeyId) throw ApiException.Conflict("EMERGENCY_KEY_CHANGED");
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            await db.EmergencyKeys.ExecuteDeleteAsync();
            db.EmergencyKeys.Add(new EmergencyKey
            {
                Id = input.Id,
                PublicKey = input.PublicKey,
                ProtectedPrivateKey = input.ProtectedPrivateKey,
                KdfSalt = input.KdfSalt,
                KdfMemory = input.KdfMemory,
                KdfIterations = input.KdfIterations,
                KdfParallelism = input.KdfParallelism,
                CreatedById = Auth.User.Id,
            });
            db.EmergencyAnchors.Add(new EmergencyAnchor { KeyId = input.Id, UserId = Auth.User.Id, Data = input.Anchor });
            await db.SaveChangesAsync();
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry(current is not null ? "emergency.key_replaced" : "emergency.key_created",
            Actor: Actor.Of(Auth.User),
            TargetType: "emergency_key",
            TargetId: input.Id.ToString(),
            Metadata: new { fingerprint = Fp(input.PublicKey), previous = current is not null ? Fp(current.PublicKey) : null },
            Meta: Meta));
        return OkResult;
    }

    [RequireActiveSystemAdmin, Ok200, HttpPost("key/delete")]
    public async Task<object> DeleteKey(AuthHashDto body)
    {
        await auth.VerifyAuthHash(Auth.User, body.AuthHash, Meta);
        var current = await ActiveKey() ?? throw ApiException.NotFound("NO_EMERGENCY_KEY");
        await db.EmergencyKeys.ExecuteDeleteAsync();
        await audit.Log(new AuditEntry("emergency.key_deleted", Actor: Actor.Of(Auth.User), TargetType: "emergency_key", TargetId: current.Id.ToString(),
            Metadata: new { fingerprint = Fp(current.PublicKey) }, Meta: Meta));
        return OkResult;
    }

    /// <summary>Bestätigung des Fingerprints durch einen weiteren System-Admin (für dessen persönlichen Tresor).</summary>
    [RequireActiveSystemAdmin, HttpPut("anchor")]
    public async Task<object> SetAnchor(EmergencyAnchorDto body)
    {
        var key = await ActiveKey();
        if (key is null || key.Id != body.KeyId) throw ApiException.Conflict("EMERGENCY_KEY_CHANGED");
        var userId = Auth.User.Id;
        var count = await db.Database.ExecuteSqlAsync($"""
            INSERT INTO emergency_anchors (id, key_id, user_id, data, created_at)
            VALUES ({Guid.NewGuid()}, {body.KeyId}, {userId}, {body.Data}, {DateTime.UtcNow})
            ON CONFLICT (key_id, user_id) DO NOTHING
            """);
        if (count > 0) await audit.Log(new AuditEntry("emergency.key_confirmed", Actor: Actor.Of(Auth.User), TargetType: "emergency_key", TargetId: body.KeyId.ToString(), Meta: Meta));
        return OkResult;
    }

    /// <summary>
    /// Backup-Datei erzeugen. Enthält nur Daten, für die ein Notfall-Schlüsselpaket vorliegt, und ist außen komplett
    /// für den Notfallschlüssel verschlüsselt. Der Server entschlüsselt nichts.
    /// </summary>
    [RequireActiveSystemAdmin, Ok200, HttpPost("export")]
    public async Task<object> Export(AuthHashDto body)
    {
        await auth.VerifyAuthHash(Auth.User, body.AuthHash, Meta);
        var key = await ActiveKey() ?? throw ApiException.NotFound("NO_EMERGENCY_KEY");
        var backup = await backups.Build(key);
        var metadata = new Dictionary<string, object?> { ["fingerprint"] = Fp(key.PublicKey) };
        foreach (var (k, v) in EmergencyBackupService.StatsFields(backup.Stats)) metadata[k] = v;
        await audit.Log(new AuditEntry("emergency.exported", Actor: Actor.Of(Auth.User), TargetType: "emergency_key", TargetId: key.Id.ToString(), Metadata: metadata, Meta: Meta));
        return backup.File;
    }

    // ---------- Tenant-Admins ----------

    private async Task<Tenant> TenantAdmin()
    {
        var tenant = Auth.User.Tenant ?? throw ApiException.Forbidden();
        var ctx = await perms.ForUser(Auth.User);
        if (!ctx.IsTenantAdmin) throw ApiException.Forbidden();
        return tenant;
    }

    [HttpGet("tenant")]
    public async Task<object> TenantStatus()
    {
        var tenant = await TenantAdmin();
        var key = await ActiveKey();
        if (key is null) return new { key = (object?)null, approval = (object?)null, coverage = (object?)null };
        var approval = await db.EmergencyApprovals.AsNoTracking().FirstOrDefaultAsync(a => a.KeyId == key.Id && a.TenantId == tenant.Id);
        var approver = approval?.ApprovedById is { } aid ? await db.Users.Where(u => u.Id == aid).Select(u => u.Email).FirstOrDefaultAsync() : null;
        var coverage = (await Coverage(key.Id)).Tenants.FirstOrDefault(t => t.Id == tenant.Id);
        return new
        {
            key = new { id = key.Id, publicKey = key.PublicKey, fingerprint = Fp(key.PublicKey), createdAt = key.CreatedAt },
            approval = approval is not null ? new { approvedAt = approval.CreatedAt, approvedBy = approver } : null,
            coverage,
        };
    }

    [Ok200, HttpPost("tenant/approve")]
    public async Task<object> Approve(EmergencyApproveDto body)
    {
        var tenant = await TenantAdmin();
        var key = await ActiveKey();
        if (key is null || key.Id != body.KeyId) throw ApiException.Conflict("EMERGENCY_KEY_CHANGED");
        if (tenant.SigningPublicKey is null || !EmergencyCrypto.VerifyApproval(tenant.SigningPublicKey, tenant.Id, key.Id, key.PublicKey, body.Signature))
            throw ApiException.BadRequest("INVALID_SIGNATURE");
        var userId = Auth.User.Id;
        var count = await db.Database.ExecuteSqlAsync($"""
            INSERT INTO emergency_approvals (id, key_id, tenant_id, signature, approved_by_id, created_at)
            VALUES ({Guid.NewGuid()}, {body.KeyId}, {tenant.Id}, {body.Signature}, {userId}, {DateTime.UtcNow})
            ON CONFLICT (key_id, tenant_id) DO NOTHING
            """);
        if (count > 0)
            await audit.Log(new AuditEntry("emergency.tenant_approved", TenantId: tenant.Id, Actor: Actor.Of(Auth.User), TargetType: "emergency_key", TargetId: body.KeyId.ToString(),
                Metadata: new { fingerprint = Fp(key.PublicKey) }, Meta: Meta));
        return OkResult;
    }

    /// <summary>Freigabe zurückziehen: alle Schlüsselpakete des Tenants (Ordner und persönliche Tresore der Mitglieder) werden gelöscht.</summary>
    [Ok200, HttpPost("tenant/revoke")]
    public async Task<object> Revoke()
    {
        var tenant = await TenantAdmin();
        var key = await ActiveKey() ?? throw ApiException.NotFound("NO_EMERGENCY_KEY");
        int approvals;
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            approvals = await db.EmergencyApprovals.Where(a => a.KeyId == key.Id && a.TenantId == tenant.Id).ExecuteDeleteAsync();
            await db.EmergencyFolderKeys.Where(w => w.KeyId == key.Id && w.Folder.TenantId == tenant.Id).ExecuteDeleteAsync();
            // System-Admins gehören keinem Tenant fest an; ihr persönlicher Tresor hängt an ihrer eigenen Bestätigung
            await db.EmergencyPersonalKeys.Where(p => p.KeyId == key.Id && p.User.TenantId == tenant.Id && p.User.SystemRole == SystemRole.USER).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        if (approvals > 0)
            await audit.Log(new AuditEntry("emergency.tenant_revoked", TenantId: tenant.Id, Actor: Actor.Of(Auth.User), TargetType: "emergency_key", TargetId: key.Id.ToString(), Meta: Meta));
        return OkResult;
    }

    /// <summary>
    /// Vor dem Deaktivieren: Würde der persönliche Tresor dieses Benutzers dauerhaft im Notfall-Backup fehlen?
    /// (Notfallschlüssel aktiv, Tenant freigegeben, noch kein Schlüsselpaket, persönliche Einträge vorhanden.)
    /// Liefert nur ein Ja/Nein, keine Details über den Tresor.
    /// </summary>
    [HttpGet("user/{id}/disable-check")]
    public async Task<object> DisableCheck(Guid id)
    {
        var tenantId = Auth.User.TenantId ?? throw ApiException.Forbidden();
        var ctx = await perms.ForUser(Auth.User);
        if (!ctx.Has(P.UsersManage)) throw ApiException.Forbidden();
        if (!await db.Users.AnyAsync(u => u.Id == id && u.TenantId == tenantId)) throw ApiException.NotFound("USER_NOT_FOUND");
        var key = await ActiveKey();
        if (key is null) return new { personalNotInBackup = false };
        var approved = await db.EmergencyApprovals.AnyAsync(a => a.KeyId == key.Id && a.TenantId == tenantId);
        var wrapped = await db.EmergencyPersonalKeys.AnyAsync(p => p.KeyId == key.Id && p.UserId == id);
        var items = await db.Items.CountAsync(i => i.OwnerId == id);
        return new { personalNotInBackup = approved && !wrapped && items > 0 };
    }

    // ---------- Alle Benutzer: Schlüsselpakete erstellen ----------

    private sealed record FolderTask(Guid FolderId, bool SecretKeyed);

    private sealed record TasksResult(object? Key, object? Approval, string? Anchor, List<FolderTask> Folders, bool Personal, Guid? KeyId);

    private async Task<TasksResult> ComputeTasks()
    {
        var none = new TasksResult(null, null, null, [], false, null);
        var key = await ActiveKey();
        var user = Auth.User;
        if (key is null || user.Status != UserStatus.ACTIVE) return none;
        var tenantId = user.TenantId;
        var isSystemAdmin = user.SystemRole == SystemRole.SYSTEM_ADMIN;
        var approval = tenantId is { } tid ? await db.EmergencyApprovals.AsNoTracking().FirstOrDefaultAsync(a => a.KeyId == key.Id && a.TenantId == tid) : null;
        var anchor = isSystemAdmin ? await db.EmergencyAnchors.Where(a => a.KeyId == key.Id && a.UserId == user.Id).Select(a => a.Data).FirstOrDefaultAsync() : null;
        var personalWrapped = await db.EmergencyPersonalKeys.AnyAsync(p => p.KeyId == key.Id && p.UserId == user.Id);
        if (approval is null && anchor is null) return none;

        var folders = new List<FolderTask>();
        if (approval is not null && tenantId is { } t)
        {
            var ctx = await perms.ForUser(user);
            var mine = await db.FolderKeys.AsNoTracking().Include(k => k.Folder).Where(k => k.UserId == user.Id && k.Folder.TenantId == t).ToListAsync();
            var wrapped = await db.EmergencyFolderKeys.AsNoTracking().Where(w => w.KeyId == key.Id && w.Folder.TenantId == t)
                .Select(w => new { w.FolderId, w.WrappedSecretKey }).ToDictionaryAsync(w => w.FolderId);
            folders = mine
                .Where(k => ctx.CanFolder(PermissionService.Ref(k.Folder), P.VaultManage) && (!k.Folder.SecretKeyed || k.WrappedSecretKey is not null))
                .Where(k => !wrapped.TryGetValue(k.FolderId, out var w) || (k.Folder.SecretKeyed && w.WrappedSecretKey is null))
                .Select(k => new FolderTask(k.FolderId, k.Folder.SecretKeyed))
                .ToList();
        }
        return new TasksResult(
            new { id = key.Id, publicKey = key.PublicKey },
            approval is not null && tenantId is not null ? new { tenantId, signature = approval.Signature } : null,
            anchor,
            folders,
            // Persönliche Tresore: regulär über die Tenant-Freigabe, bei System-Admins über die eigene Bestätigung
            !personalWrapped && (anchor is not null || (approval is not null && !isSystemAdmin)),
            key.Id);
    }

    /// <summary>
    /// Offene Aufgaben für den eigenen Browser: Ordner, deren Schlüssel er besitzt und verwaltet, sowie der eigene persönliche Tresor.
    /// Der Client prüft Freigabe bzw. eigene Bestätigung kryptografisch, bevor er etwas verpackt.
    /// </summary>
    [HttpGet("tasks")]
    public async Task<object> Tasks()
    {
        var t = await ComputeTasks();
        return new
        {
            key = t.Key,
            approval = t.Approval,
            anchor = t.Anchor,
            folders = t.Folders.Select(f => new { folderId = f.FolderId, secretKeyed = f.SecretKeyed }),
            personal = t.Personal,
        };
    }

    [Ok200, HttpPost("wraps")]
    public async Task<object> Wraps(EmergencyWrapsDto input)
    {
        var tasks = await ComputeTasks();
        if (tasks.KeyId is null || tasks.KeyId != input.KeyId) throw ApiException.Conflict("EMERGENCY_KEY_CHANGED");
        var allowed = tasks.Folders.ToDictionary(f => f.FolderId);
        var folderRows = input.Folders.Where(f => allowed.TryGetValue(f.FolderId, out var task) && (!task.SecretKeyed || f.WrappedSecretKey is not null)).ToList();
        var userId = Auth.User.Id;
        var created = 0;
        if (folderRows.Count > 0)
        {
            var ids = folderRows.Select(f => f.FolderId).ToList();
            var existing = (await db.EmergencyFolderKeys.Where(w => w.KeyId == input.KeyId && ids.Contains(w.FolderId)).Select(w => w.FolderId).ToListAsync()).ToHashSet();
            await using var tx = await db.Database.BeginTransactionAsync();
            foreach (var f in folderRows.Where(f => !existing.Contains(f.FolderId)))
            {
                created += await db.Database.ExecuteSqlAsync($"""
                    INSERT INTO emergency_folder_keys (id, key_id, folder_id, wrapped_key, wrapped_secret_key, created_by_id, created_at)
                    VALUES ({Guid.NewGuid()}, {input.KeyId}, {f.FolderId}, {f.WrappedKey}, {f.WrappedSecretKey}, {userId}, {DateTime.UtcNow})
                    ON CONFLICT (key_id, folder_id) DO NOTHING
                    """);
            }
            // Paket ohne Geheim-Schlüssel ergänzen (nur falls noch leer)
            foreach (var f in folderRows.Where(f => existing.Contains(f.FolderId) && f.WrappedSecretKey is not null))
            {
                created += await db.EmergencyFolderKeys
                    .Where(w => w.KeyId == input.KeyId && w.FolderId == f.FolderId && w.WrappedSecretKey == null)
                    .ExecuteUpdateAsync(u => u.SetProperty(w => w.WrappedKey, f.WrappedKey).SetProperty(w => w.WrappedSecretKey, f.WrappedSecretKey).SetProperty(w => w.CreatedById, userId));
            }
            await tx.CommitAsync();
        }
        var personal = false;
        if (input.Personal is not null && tasks.Personal)
        {
            personal = await db.Database.ExecuteSqlAsync($"""
                INSERT INTO emergency_personal_keys (id, key_id, user_id, wrapped_key, created_at)
                VALUES ({Guid.NewGuid()}, {input.KeyId}, {userId}, {input.Personal}, {DateTime.UtcNow})
                ON CONFLICT (key_id, user_id) DO NOTHING
                """) > 0;
        }
        if (created > 0 || personal)
        {
            await audit.Log(new AuditEntry("emergency.keys_wrapped",
                TenantId: Auth.User.TenantId,
                Actor: Actor.Of(Auth.User),
                TargetType: "emergency_key",
                TargetId: input.KeyId.ToString(),
                Metadata: new { folders = folderRows.Select(f => f.FolderId).ToList(), personal },
                Meta: Meta));
        }
        return new { folders = created, personal };
    }
}
