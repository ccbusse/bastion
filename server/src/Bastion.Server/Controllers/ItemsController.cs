using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

/// <summary>Tresoreinträge. Der Server sieht nur Chiffretext (Übersicht und Geheimteil getrennt verschlüsselt).</summary>
[Route("api/items")]
public sealed class ItemsController(BastionDb db, PermissionService perms, AuditService audit, AppConfig config) : BastionController
{
    private static object View(Item item, bool canReveal, bool canEdit) => new
    {
        id = item.Id,
        type = item.Type,
        folderId = item.FolderId,
        personal = item.OwnerId is not null,
        overview = item.Overview,
        // Ohne "reveal" verlässt der Geheimteil den Server nicht
        secret = canReveal ? item.Secret : null,
        revision = item.Revision,
        createdAt = item.CreatedAt,
        updatedAt = item.UpdatedAt,
        canReveal,
        canEdit,
    };

    private static object TrashView(Item item, bool canReveal, bool canEdit, DateTime purgeAt) => new
    {
        id = item.Id,
        type = item.Type,
        folderId = item.FolderId,
        personal = item.OwnerId is not null,
        overview = item.Overview,
        secret = canReveal ? item.Secret : null,
        revision = item.Revision,
        createdAt = item.CreatedAt,
        updatedAt = item.UpdatedAt,
        deletedAt = item.DeletedAt,
        purgeAt,
        canReveal,
        canEdit,
    };

    /// <summary>Prüft Schreibzugriff auf einen Zielort (persönlich oder Ordner).</summary>
    private async Task<Folder?> AssertWritable(AccessContext ctx, Guid? folderId)
    {
        if (folderId is not { } fid) return null;
        var tenantId = Auth.User.TenantId;
        var folder = await db.Folders.AsNoTracking().FirstOrDefaultAsync(f => f.Id == fid && tenantId != null && f.TenantId == tenantId)
            ?? throw ApiException.NotFound("FOLDER_NOT_FOUND");
        if (!ctx.CanFolder(PermissionService.Ref(folder), P.VaultEdit)) throw ApiException.Forbidden();
        var userId = Auth.User.Id;
        if (!await db.FolderKeys.AnyAsync(k => k.FolderId == fid && k.UserId == userId)) throw ApiException.Forbidden("FOLDER_KEY_MISSING");
        return folder;
    }

    /// <summary>Lädt einen Eintrag mit den Rechten des Benutzers. Einträge im Papierkorb nur mit <paramref name="inTrash"/> = true, aktive nur mit false.</summary>
    private async Task<(Item Item, AccessContext Ctx, bool CanEdit, bool CanReveal)> Load(Guid id, bool inTrash = false)
    {
        var item = await db.Items.AsNoTracking().Include(i => i.Folder).FirstOrDefaultAsync(i => i.Id == id && (i.DeletedAt != null) == inTrash)
            ?? throw ApiException.NotFound("ITEM_NOT_FOUND");
        var ctx = await perms.ForUser(Auth.User);
        if (item.OwnerId is not null)
        {
            if (item.OwnerId != Auth.User.Id) throw ApiException.NotFound("ITEM_NOT_FOUND");
            return (item, ctx, true, true);
        }
        if (item.Folder is null || item.Folder.TenantId != Auth.User.TenantId) throw ApiException.NotFound("ITEM_NOT_FOUND");
        var fp = ctx.FolderVault(PermissionService.Ref(item.Folder));
        if (!fp.Contains(P.VaultView)) throw ApiException.NotFound("ITEM_NOT_FOUND");
        return (item, ctx, fp.Contains(P.VaultEdit), fp.Contains(P.VaultReveal));
    }

    /// <summary>
    /// Alle zugänglichen Einträge (persönlich + Ordner mit Lesezugriff und vorhandenem Schlüssel).
    /// Der erste Abruf je Sitzung wird protokolliert (items.listed): So wird sichtbar, wann ein neues Gerät oder die
    /// Browser-Erweiterung den Tresor vollständig geladen hat. Weitere Abrufe derselben Sitzung (Neuladen) nicht.
    /// </summary>
    /// <summary>Lesbare Ordner des Benutzers (Lesezugriff und vorhandener Schlüssel) mit seinen Rechten darauf.</summary>
    private async Task<Dictionary<Guid, HashSet<string>>> ReadableFolders(User user, AccessContext ctx)
    {
        if (user.TenantId is not { } tenantId) return [];
        var folders = await db.FolderKeys.AsNoTracking()
            .Where(k => k.UserId == user.Id && k.Folder.TenantId == tenantId)
            .Select(k => k.Folder)
            .ToListAsync();
        return folders
            .Select(f => (f.Id, Perms: ctx.FolderVault(PermissionService.Ref(f))))
            .Where(f => f.Perms.Contains(P.VaultView))
            .ToDictionary(f => f.Id, f => f.Perms);
    }

    [AllowExtension, HttpGet]
    public async Task<object> List()
    {
        var user = Auth.User;
        var ctx = await perms.ForUser(user);
        var personal = await db.Items.AsNoTracking().Where(i => i.OwnerId == user.Id && i.DeletedAt == null).ToListAsync();
        var output = personal.Select(i => View(i, true, true)).ToList();
        var permsById = await ReadableFolders(user, ctx);
        var ids = permsById.Keys.ToList();
        var folderCount = ids.Count;
        if (ids.Count > 0)
        {
            var items = await db.Items.AsNoTracking().Where(i => i.FolderId != null && ids.Contains(i.FolderId.Value) && i.DeletedAt == null).ToListAsync();
            foreach (var i in items)
            {
                var fp = permsById[i.FolderId!.Value];
                output.Add(View(i, fp.Contains(P.VaultReveal), fp.Contains(P.VaultEdit)));
            }
        }
        // Atomar: bei parallelen Abrufen derselben Sitzung genau ein Eintrag
        var now = DateTime.UtcNow;
        var first = await db.Sessions.Where(s => s.Id == Auth.Session.Id && s.ItemsListedAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.ItemsListedAt, now)) == 1;
        if (first)
            await audit.Log(new AuditEntry("items.listed", TenantId: user.TenantId, Actor: Actor.Of(user),
                Metadata: new { items = output.Count, personal = personal.Count, folders = folderCount, client = Auth.Session.Client.ToString() }, Meta: Meta));
        return output;
    }

    [HttpPost]
    public async Task<object> Create(ItemInputDto body)
    {
        var user = Auth.User;
        var ctx = await perms.ForUser(user);
        var folder = await AssertWritable(ctx, body.FolderId);
        if (await db.Items.AnyAsync(i => i.Id == body.Id)) throw ApiException.Conflict("ITEM_EXISTS");
        var item = new Item
        {
            Id = body.Id,
            Type = ItemTypes.Parse(body.Type),
            Overview = body.Overview,
            Secret = body.Secret,
            FolderId = folder?.Id,
            TenantId = folder?.TenantId,
            OwnerId = folder is null ? user.Id : null,
            CreatedById = user.Id,
            UpdatedById = user.Id,
        };
        db.Items.Add(item);
        await db.SaveChangesAsync();
        if (folder is not null)
            await audit.Log(new AuditEntry("item.created", TenantId: folder.TenantId, Actor: Actor.Of(user), TargetType: "item", TargetId: item.Id.ToString(),
                Metadata: new { folderId = folder.Id, type = item.Type.ToString() }, Meta: Meta));
        return View(item, true, true);
    }

    [Ok200, HttpPost("bulk")]
    public async Task<object> Bulk(BulkItemsDto body)
    {
        var user = Auth.User;
        var ctx = await perms.ForUser(user);
        // Reihenfolge der Ordner wie im Request (für das Audit-Log)
        var folders = new Dictionary<string, Folder?>();
        var folderOrder = new List<Guid?>();
        foreach (var fid in body.Items.Select(i => i.FolderId).Distinct())
        {
            folderOrder.Add(fid);
            folders[fid?.ToString() ?? ""] = await AssertWritable(ctx, fid);
        }
        var count = 0;
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            foreach (var i in body.Items)
            {
                var folder = folders[i.FolderId?.ToString() ?? ""];
                count += await InsertIgnore.Item(db, i.Id, ItemTypes.Parse(i.Type), folder?.TenantId, folder?.Id, folder is null ? user.Id : null, i.Overview, i.Secret, user.Id);
            }
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("item.imported",
            TenantId: user.TenantId,
            Actor: Actor.Of(user),
            Metadata: new { count, folders = folderOrder.Select(f => f?.ToString() ?? "personal").ToList() },
            Meta: Meta));
        return new { created = count };
    }

    [HttpPut("{id}")]
    public async Task<object> Update(Guid id, ItemUpdateDto body)
    {
        var (item, ctx, canEdit, _) = await Load(id);
        if (!canEdit) throw ApiException.Forbidden();
        var user = Auth.User;
        var target = await AssertWritable(ctx, body.FolderId);
        // Unternehmensdaten dürfen nicht in den persönlichen Tresor verschoben werden
        if (item.FolderId is not null && target is null) throw ApiException.Forbidden("CANNOT_MOVE_TO_PERSONAL");
        var moved = target?.Id != item.FolderId;
        var type = ItemTypes.Parse(body.Type);
        var now = DateTime.UtcNow;
        Guid? targetId = target?.Id, targetTenant = target?.TenantId, ownerId = target is null ? user.Id : null;
        // Optimistisches Locking gegen parallele Änderungen
        var count = await db.Items.Where(i => i.Id == item.Id && i.Revision == body.Revision).ExecuteUpdateAsync(u => u
            .SetProperty(i => i.Type, type)
            .SetProperty(i => i.Overview, body.Overview)
            .SetProperty(i => i.Secret, body.Secret)
            .SetProperty(i => i.FolderId, targetId)
            .SetProperty(i => i.TenantId, targetTenant)
            .SetProperty(i => i.OwnerId, ownerId)
            .SetProperty(i => i.Revision, i => i.Revision + 1)
            .SetProperty(i => i.UpdatedById, user.Id)
            .SetProperty(i => i.UpdatedAt, now));
        if (count == 0) throw ApiException.Conflict("REVISION_CONFLICT");
        var tenantId = item.Folder?.TenantId ?? target?.TenantId;
        if (tenantId is not null)
        {
            await audit.Log(new AuditEntry(moved ? "item.moved" : "item.updated",
                TenantId: tenantId,
                Actor: Actor.Of(user),
                TargetType: "item",
                TargetId: item.Id.ToString(),
                Metadata: new { from = item.FolderId?.ToString() ?? "personal", to = target?.Id.ToString() ?? "personal" },
                Meta: Meta));
        }
        var updated = await db.Items.AsNoTracking().FirstAsync(i => i.Id == item.Id);
        return View(updated, true, true);
    }

    /// <summary>
    /// Löschen verschiebt in den Papierkorb (Chiffretext bleibt unverändert erhalten). Die Revision steigt, damit eine parallel
    /// geöffnete Bearbeitung nicht unbemerkt einen gelöschten Eintrag überschreibt.
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<object> Remove(Guid id)
    {
        var (item, _, canEdit, _) = await Load(id);
        if (!canEdit) throw ApiException.Forbidden();
        var now = DateTime.UtcNow;
        var me = Auth.User.Id;
        await db.Items.Where(i => i.Id == item.Id && i.DeletedAt == null).ExecuteUpdateAsync(u => u
            .SetProperty(i => i.DeletedAt, now)
            .SetProperty(i => i.DeletedById, me)
            .SetProperty(i => i.Revision, i => i.Revision + 1));
        if (item.Folder is not null)
            await audit.Log(new AuditEntry("item.deleted", TenantId: item.Folder.TenantId, Actor: Actor.Of(Auth.User), TargetType: "item", TargetId: item.Id.ToString(),
                Metadata: new { folderId = item.FolderId, trash = true }, Meta: Meta));
        return OkResult;
    }

    /// <summary>Papierkorb: gelöschte Einträge, die der Benutzer sehen darf (gleiche Regeln wie die Liste).</summary>
    [HttpGet("trash")]
    public async Task<object> Trash()
    {
        var user = Auth.User;
        var ctx = await perms.ForUser(user);
        var retention = TimeSpan.FromDays(config.TrashRetentionDays);
        var output = (await db.Items.AsNoTracking().Where(i => i.OwnerId == user.Id && i.DeletedAt != null).ToListAsync())
            .Select(i => TrashView(i, true, true, i.DeletedAt!.Value + retention)).ToList();
        var permsById = await ReadableFolders(user, ctx);
        var ids = permsById.Keys.ToList();
        if (ids.Count > 0)
        {
            var items = await db.Items.AsNoTracking().Where(i => i.FolderId != null && ids.Contains(i.FolderId.Value) && i.DeletedAt != null).ToListAsync();
            foreach (var i in items)
            {
                var fp = permsById[i.FolderId!.Value];
                output.Add(TrashView(i, fp.Contains(P.VaultReveal), fp.Contains(P.VaultEdit), i.DeletedAt!.Value + retention));
            }
        }
        return output;
    }

    /// <summary>Eintrag aus dem Papierkorb zurückholen. Braucht dieselben Rechte wie das Löschen (Bearbeiten und Ordnerschlüssel).</summary>
    [Ok200, HttpPost("{id}/restore")]
    public async Task<object> Restore(Guid id)
    {
        var (item, ctx, canEdit, _) = await Load(id, inTrash: true);
        if (!canEdit) throw ApiException.Forbidden();
        if (item.FolderId is not null) await AssertWritable(ctx, item.FolderId);
        var count = await db.Items.Where(i => i.Id == item.Id && i.DeletedAt != null).ExecuteUpdateAsync(u => u
            .SetProperty(i => i.DeletedAt, (DateTime?)null)
            .SetProperty(i => i.DeletedById, (Guid?)null)
            .SetProperty(i => i.Revision, i => i.Revision + 1));
        if (count == 0) throw ApiException.NotFound("ITEM_NOT_FOUND");
        if (item.Folder is not null)
            await audit.Log(new AuditEntry("item.restored", TenantId: item.Folder.TenantId, Actor: Actor.Of(Auth.User), TargetType: "item", TargetId: item.Id.ToString(),
                Metadata: new { folderId = item.FolderId }, Meta: Meta));
        return OkResult;
    }

    /// <summary>Endgültig löschen – nur aus dem Papierkorb heraus (zweistufig gegen versehentliches Löschen).</summary>
    [HttpDelete("{id}/permanent")]
    public async Task<object> Purge(Guid id)
    {
        var (item, _, canEdit, _) = await Load(id, inTrash: true);
        if (!canEdit) throw ApiException.Forbidden();
        await db.Items.Where(i => i.Id == item.Id && i.DeletedAt != null).ExecuteDeleteAsync();
        if (item.Folder is not null)
            await audit.Log(new AuditEntry("item.purged", TenantId: item.Folder.TenantId, Actor: Actor.Of(Auth.User), TargetType: "item", TargetId: item.Id.ToString(),
                Metadata: new { folderId = item.FolderId }, Meta: Meta));
        return OkResult;
    }

    /// <summary>
    /// Export von Unternehmenseinträgen (verschlüsselte Exportdatei) im Audit-Log festhalten. Der Web-Client meldet ihn, bevor er
    /// die Datei erzeugt. Wie "Passwort angezeigt/kopiert" ist das nur bei unverändertem Client aussagekräftig (Zero-Knowledge:
    /// der Server sieht nicht, was im Browser geschieht); protokolliert werden nur Ordner, auf die der Benutzer Zugriff hat.
    /// </summary>
    [Throttle(30), Ok200, HttpPost("export-event")]
    public async Task<object> ExportEvent(ExportEventDto body)
    {
        var user = Auth.User;
        var ctx = await perms.ForUser(user);
        var tenantId = user.TenantId;
        var visible = await db.Folders.AsNoTracking().Where(f => body.Folders.Contains(f.Id) && tenantId != null && f.TenantId == tenantId).ToListAsync();
        var allowed = visible.Where(f => ctx.CanFolder(PermissionService.Ref(f), P.VaultReveal)).Select(f => f.Id).ToList();
        await audit.Log(new AuditEntry("items.exported", TenantId: tenantId, Actor: Actor.Of(user), Metadata: new { count = body.Count, folders = allowed }, Meta: Meta));
        return OkResult;
    }

    /// <summary>Protokollierung clientseitiger Zugriffe (Passwort angezeigt/kopiert) auf Unternehmenseinträge.</summary>
    [AllowExtension, Throttle(120), Ok200, HttpPost("{id}/events")]
    public async Task<object> Event(Guid id, ItemEventDto body)
    {
        var (item, _, _, canReveal) = await Load(id);
        if (!canReveal) throw ApiException.BadRequest("FORBIDDEN");
        if (item.Folder is not null)
            await audit.Log(new AuditEntry($"item.{body.Event}", TenantId: item.Folder.TenantId, Actor: Actor.Of(Auth.User), TargetType: "item", TargetId: item.Id.ToString(),
                Metadata: new { field = body.Field, folderId = item.FolderId }, Meta: Meta));
        return OkResult;
    }
}
