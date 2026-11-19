using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Emergency;

public sealed record BackupStats(int Tenants, int Folders, int Users, int Items);

/// <summary>Backup-Datei (Format bastion-emergency-backup, Version 1) und ihre Kennzahlen.</summary>
public sealed record BackupResult(BackupStats Stats, string CreatedAt, object File);

/// <summary>
/// Baut die Backup-Datei des Notfall-Backups (manueller und automatischer Export).
/// Enthält nur Daten, für die ein Notfall-Schlüsselpaket vorliegt, und ist außen komplett für den Notfallschlüssel
/// verschlüsselt. Der Server entschlüsselt nichts.
/// </summary>
public sealed class EmergencyBackupService(BastionDb db, AuditService audit)
{
    public Task<EmergencyKey?> ActiveKey() =>
        db.EmergencyKeys.AsNoTracking().OrderByDescending(k => k.CreatedAt).FirstOrDefaultAsync();

    public async Task<BackupResult> Build(EmergencyKey key)
    {
        var createdAt = AuditService.Iso(DateTime.UtcNow);
        var tenantIds = await db.EmergencyApprovals.Where(a => a.KeyId == key.Id).Select(a => a.TenantId).ToListAsync();
        var folderWraps = await db.EmergencyFolderKeys.AsNoTracking().Where(w => w.KeyId == key.Id)
            .Select(w => new { w.FolderId, w.WrappedKey, w.WrappedSecretKey, w.Folder.SecretKeyed }).ToListAsync();
        var personalWraps = await db.EmergencyPersonalKeys.AsNoTracking().Where(w => w.KeyId == key.Id)
            .Select(w => new { w.UserId, w.WrappedKey, w.User.Email, w.User.Name, w.User.TenantId, w.User.SystemRole }).ToListAsync();

        // Unvollständige Pakete (Geheim-Schlüssel fehlt) bleiben außen vor
        var usable = folderWraps.Where(w => !w.SecretKeyed || w.WrappedSecretKey is not null).ToList();
        var folderIds = usable.Select(w => w.FolderId).ToList();
        var userIds = personalWraps.Select(w => w.UserId).ToList();

        var tenants = await db.Tenants.AsNoTracking().Where(t => tenantIds.Contains(t.Id)).Select(t => new { id = t.Id, name = t.Name, slug = t.Slug }).ToListAsync();
        var departments = await db.Departments.AsNoTracking().Where(d => tenantIds.Contains(d.TenantId)).Select(d => new { id = d.Id, tenantId = d.TenantId, name = d.Name }).ToListAsync();
        var folders = await db.Folders.AsNoTracking().Where(f => tenantIds.Contains(f.TenantId))
            .Select(f => new { f.Id, f.TenantId, f.DepartmentId, f.ParentId, f.Name, f.SecretKeyed }).ToListAsync();
        var items = await db.Items.AsNoTracking()
            // Papierkorb nicht exportieren: Das Notfall-Backup zeigt den Tresor, wie ihn die Benutzer sehen
            .Where(i => i.DeletedAt == null && ((i.FolderId != null && folderIds.Contains(i.FolderId.Value)) || (i.OwnerId != null && userIds.Contains(i.OwnerId.Value))))
            .Select(i => new { id = i.Id, type = i.Type, folderId = i.FolderId, ownerId = i.OwnerId, overview = i.Overview, secret = i.Secret, createdAt = i.CreatedAt, updatedAt = i.UpdatedAt })
            .ToListAsync();

        var wrapByFolder = usable.ToDictionary(w => w.FolderId);
        var payload = new
        {
            createdAt,
            bastionVersion = BuildInfo.Version,
            tenants,
            departments,
            folders = folders.Select(f => new
            {
                id = f.Id,
                tenantId = f.TenantId,
                departmentId = f.DepartmentId,
                parentId = f.ParentId,
                name = f.Name,
                secretKeyed = f.SecretKeyed,
                key = wrapByFolder.TryGetValue(f.Id, out var w) ? new { wrappedKey = w.WrappedKey, wrappedSecretKey = w.WrappedSecretKey } : null,
            }),
            users = personalWraps.Select(w => new
            {
                id = w.UserId,
                email = w.Email,
                name = w.Name,
                tenantId = w.TenantId,
                systemAdmin = w.SystemRole == SystemRole.SYSTEM_ADMIN,
                wrappedKey = w.WrappedKey,
            }),
            items,
        };
        var stats = new BackupStats(tenants.Count, folderIds.Count, userIds.Count, items.Count);
        // Kettenkopf des Audit-Logs als externer Anker: Mit der (offline verwahrten) Datei lässt sich später prüfen, dass die
        // Kette bis hierhin unverändert ist (System → Audit-Log → Prüfen mit Anker). Ein HMAC-Wert, ohne Inhalt.
        var head = await audit.Head();
        var file = new
        {
            format = "bastion-emergency-backup",
            version = 1,
            createdAt,
            keyId = key.Id,
            auditHead = head,
            fingerprint = CryptoUtil.PublicKeyFingerprint(key.PublicKey),
            stats,
            keyProtection = new
            {
                protectedPrivateKey = key.ProtectedPrivateKey,
                publicKey = key.PublicKey,
                kdfSalt = key.KdfSalt,
                kdfMemory = key.KdfMemory,
                kdfIterations = key.KdfIterations,
                kdfParallelism = key.KdfParallelism,
            },
            envelope = EmergencyCrypto.SealBackup(key.PublicKey, EmergencyCrypto.BackupAad(key.Id, createdAt), Json.Serialize(payload)),
        };
        return new BackupResult(stats, createdAt, file);
    }

    /// <summary>Dateiname mit Zeitstempel (UTC), sortierbar: bastion-notfall-backup-2026-11-05T09-30-00Z.json</summary>
    public static string FileName(string createdAt) => $"bastion-notfall-backup-{createdAt[..19].Replace(':', '-')}Z.json";

    /// <summary>Kennzahlen als Felder für Audit-Metadaten (entspricht ...stats).</summary>
    public static Dictionary<string, object?> StatsFields(BackupStats s) => new()
    {
        ["tenants"] = s.Tenants,
        ["folders"] = s.Folders,
        ["users"] = s.Users,
        ["items"] = s.Items,
    };
}
