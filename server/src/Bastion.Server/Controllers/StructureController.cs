using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

/// <summary>Abteilungen und Ordner (Baumstruktur) sowie die Verteilung der Ordnerschlüssel.</summary>
[Route("api")]
public sealed class StructureController(BastionDb db, PermissionService perms, AuditService audit) : BastionController
{
    private sealed record Recipient(User User, bool Reveal, string? Endorsement);

    private Guid TenantOf() => Auth.User.TenantId ?? throw ApiException.Forbidden();

    private static object DepartmentView(Department d) => new { d.Id, d.TenantId, d.Name, d.Description, d.CreatedAt, d.UpdatedAt };

    /// <summary>Sichtbare Struktur inkl. effektiver Rechte des Benutzers.</summary>
    [AllowExtension, HttpGet("structure")]
    public async Task<object> Structure()
    {
        if (Auth.User.TenantId is not { } tenantId) return new { departments = Array.Empty<object>() };
        var ctx = await perms.ForUser(Auth.User);
        var canStructure = ctx.Has(P.StructureManage);
        var departments = await db.Departments.AsNoTracking().Where(d => d.TenantId == tenantId).OrderBy(d => d.Name).ToListAsync();
        var allFolders = await db.Folders.AsNoTracking().Where(f => f.TenantId == tenantId).OrderBy(f => f.Name).ToListAsync();
        var userId = Auth.User.Id;
        var keySet = (await db.FolderKeys.Where(k => k.UserId == userId && k.Folder.TenantId == tenantId).Select(k => k.FolderId).ToListAsync()).ToHashSet();
        var countMap = await db.Items.Where(i => i.TenantId == tenantId && i.FolderId != null && i.DeletedAt == null)
            .GroupBy(i => i.FolderId!.Value).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count);
        var foldersByDept = allFolders.ToLookup(f => f.DepartmentId);

        var result = new List<object>();
        foreach (var d in departments)
        {
            var deptPerms = ctx.DeptVault(d.Id);
            var deptFolders = foldersByDept[d.Id].ToList();
            var byId = deptFolders.ToDictionary(f => f.Id);
            var children = new Dictionary<Guid, List<Folder>>();
            var roots = new List<Folder>();
            foreach (var f in deptFolders)
            {
                if (f.ParentId is { } pid && byId.ContainsKey(pid))
                {
                    if (!children.TryGetValue(pid, out var list)) children[pid] = list = [];
                    list.Add(f);
                }
                else roots.Add(f);
            }
            // Baum in Anzeige-Reihenfolge (Tiefensuche, alphabetisch je Ebene) mit Pfad und Tiefe
            var ordered = new List<(Folder F, List<string> Path)>();
            void Walk(IEnumerable<Folder> level, List<string> path)
            {
                foreach (var f in level)
                {
                    if (path.Count >= 64) continue;
                    var p = new List<string>(path) { f.Name };
                    ordered.Add((f, p));
                    Walk(children.GetValueOrDefault(f.Id) ?? [], p);
                }
            }
            Walk(roots, []);
            var mapped = ordered.Select(o =>
            {
                var fp = ctx.FolderVault(PermissionService.Ref(o.F));
                return new
                {
                    id = o.F.Id,
                    parentId = o.F.ParentId,
                    name = o.F.Name,
                    path = string.Join(" / ", o.Path),
                    depth = o.Path.Count - 1,
                    description = o.F.Description,
                    inheritPermissions = o.F.InheritPermissions,
                    permissions = fp.ToList(),
                    hasKey = keySet.Contains(o.F.Id),
                    itemCount = fp.Contains(P.VaultView) ? countMap.GetValueOrDefault(o.F.Id) : (int?)null,
                    // Nur für Manager des Ordners relevant: sie können den Schlüssel erneuern
                    keyRotationRecommended = fp.Contains(P.VaultManage) && o.F.KeyRotationRecommended,
                };
            }).ToList();
            // Sichtbar sind berechtigte Ordner und – nur mit Namen – deren übergeordnete Ordner, damit der Baum vollständig bleibt
            var shown = new HashSet<Guid>();
            foreach (var f in mapped)
            {
                if (!(canStructure || f.permissions.Contains(P.VaultView) || deptPerms.Contains(P.VaultManage))) continue;
                for (Guid? id = f.id; id is { } cur && !shown.Contains(cur); id = byId.GetValueOrDefault(cur)?.ParentId) shown.Add(cur);
            }
            var folders = mapped.Where(f => shown.Contains(f.id)).ToList();
            var visible = canStructure || folders.Count > 0 || deptPerms.Count > 0 || ctx.HasDeptAssignment(d.Id);
            if (visible)
                result.Add(new { id = d.Id, name = d.Name, description = d.Description, permissions = deptPerms.ToList(), canManage = canStructure || deptPerms.Contains(P.VaultManage), folders });
        }
        return new { departments = result, canManageStructure = canStructure };
    }

    // ---------- Abteilungen ----------

    [HttpPost("departments")]
    public async Task<object> CreateDepartment(DepartmentCreateDto body)
    {
        var tenantId = TenantOf();
        (await perms.ForUser(Auth.User)).Require(P.StructureManage);
        var dept = new Department { TenantId = tenantId, Name = body.Name.Trim(), Description = body.Description?.Trim() ?? "" };
        db.Departments.Add(dept);
        await SaveUnique();
        await audit.Log(new AuditEntry("department.created", TenantId: tenantId, Actor: Actor.Of(Auth.User), TargetType: "department", TargetId: dept.Id.ToString(), Metadata: new { name = dept.Name }, Meta: Meta));
        return DepartmentView(dept);
    }

    private async Task SaveUnique()
    {
        try { await db.SaveChangesAsync(); }
        catch (DbUpdateException e) when (OrgHelpers.IsUniqueViolation(e)) { throw ApiException.Conflict("NAME_EXISTS"); }
    }

    [HttpPatch("departments/{id}")]
    public async Task<object> UpdateDepartment(Guid id, DepartmentUpdateDto body)
    {
        var tenantId = TenantOf();
        (await perms.ForUser(Auth.User)).Require(P.StructureManage);
        var dept = await db.Departments.FirstOrDefaultAsync(d => d.Id == id && d.TenantId == tenantId) ?? throw ApiException.NotFound("DEPARTMENT_NOT_FOUND");
        var name = body.Name?.Trim();
        var description = body.Description?.Trim();
        if (name is not null) dept.Name = name;
        if (description is not null) dept.Description = description;
        await SaveUnique();
        await audit.Log(new AuditEntry("department.updated", TenantId: tenantId, Actor: Actor.Of(Auth.User), TargetType: "department", TargetId: dept.Id.ToString(), Metadata: new { name, description }, Meta: Meta));
        return DepartmentView(dept);
    }

    [HttpDelete("departments/{id}")]
    public async Task<object> DeleteDepartment(Guid id)
    {
        var tenantId = TenantOf();
        (await perms.ForUser(Auth.User)).Require(P.StructureManage);
        var dept = await db.Departments.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id && d.TenantId == tenantId) ?? throw ApiException.NotFound("DEPARTMENT_NOT_FOUND");
        if (await db.Folders.AnyAsync(f => f.DepartmentId == dept.Id)) throw ApiException.BadRequest("DEPARTMENT_NOT_EMPTY");
        await db.Departments.Where(d => d.Id == dept.Id).ExecuteDeleteAsync();
        await audit.Log(new AuditEntry("department.deleted", TenantId: tenantId, Actor: Actor.Of(Auth.User), TargetType: "department", TargetId: dept.Id.ToString(), Metadata: new { name = dept.Name }, Meta: Meta));
        return OkResult;
    }

    /// <summary>
    /// Prüft, ob der Benutzer in einer Abteilung (bzw. unterhalb eines Elternordners) Ordner anlegen darf,
    /// und liefert den "virtuellen" neuen Ordner für die Empfängerberechnung.
    /// </summary>
    private async Task<(Department Dept, Folder? Parent, FolderRef Virtual)> NewFolderScope(Guid tenantId, Guid departmentId, Guid? parentId, bool inherit)
    {
        var dept = await db.Departments.AsNoTracking().FirstOrDefaultAsync(d => d.Id == departmentId && d.TenantId == tenantId) ?? throw ApiException.NotFound("DEPARTMENT_NOT_FOUND");
        var parent = parentId is { } pid ? await db.Folders.AsNoTracking().FirstOrDefaultAsync(f => f.Id == pid && f.TenantId == tenantId) : null;
        if (parentId is not null && (parent is null || parent.DepartmentId != dept.Id)) throw ApiException.NotFound("FOLDER_NOT_FOUND");
        var ctx = await perms.ForUser(Auth.User);
        var allowed = ctx.Has(P.StructureManage) || ctx.DeptVault(dept.Id).Contains(P.VaultManage) || (parent is not null && ctx.CanFolder(PermissionService.Ref(parent), P.VaultManage));
        if (!allowed) throw ApiException.Forbidden();
        return (dept, parent, new FolderRef(Guid.Empty, dept.Id, parent?.Id, inherit));
    }

    /// <summary>Beglaubigte Empfänger eines (neuen) Ordners; der eigene Schlüssel braucht keine Beglaubigung.</summary>
    private async Task<List<Recipient>> KeyRecipients(Guid tenantId, FolderRef folder)
    {
        var contexts = await perms.TenantContexts(tenantId);
        var endorsed = await db.KeyEndorsements.AsNoTracking().Where(e => e.TenantId == tenantId).ToDictionaryAsync(e => e.UserId, e => e.Signature);
        var me = Auth.User.Id;
        return contexts
            .Where(c => c.Ctx.CanFolder(folder, P.VaultView) && (c.User.Id == me || endorsed.ContainsKey(c.User.Id)))
            .Select(c => new Recipient(c.User, c.Ctx.CanFolder(folder, P.VaultReveal), endorsed.GetValueOrDefault(c.User.Id)))
            .ToList();
    }

    private static object RecipientView(Recipient r) =>
        new { userId = r.User.Id, name = r.User.Name, email = r.User.Email, publicKey = r.User.PublicKey, reveal = r.Reveal, endorsement = r.Endorsement };

    /// <summary>Empfänger des Schlüssels für einen neuen Ordner (vor dem Anlegen, damit der Client ihn für alle verschlüsseln kann).</summary>
    [HttpGet("departments/{id}/recipients")]
    public async Task<object> Recipients(Guid id, [FromQuery] string? inherit, [FromQuery] string? parentId)
    {
        var tenantId = TenantOf();
        Guid? parent = null;
        if (!string.IsNullOrEmpty(parentId))
        {
            if (!Guid.TryParseExact(parentId, "D", out var p)) throw OrgHelpers.Invalid("", "Invalid UUID");
            parent = p;
        }
        var (_, _, virt) = await NewFolderScope(tenantId, id, parent, inherit != "false");
        return (await KeyRecipients(tenantId, virt)).Select(RecipientView).ToList();
    }

    // ---------- Ordner ----------

    /// <summary>
    /// Schlüsselpakete für die zulässigen Empfänger, jeweils mit geprüftem Herkunftsnachweis des Absenders (des Aufrufers).
    /// Einen mitgesendeten Geheim-Schlüssel behält nur, wer Geheimteile sehen darf; sein Prüfwert bleibt für die Signatur erhalten.
    /// </summary>
    private async Task<List<FolderKey>> SignedKeys(Guid tenantId, Guid folderId, IEnumerable<FolderKeyDto> keys, Dictionary<Guid, Recipient> allowed)
    {
        var me = Auth.User;
        var myEndorsement = await db.KeyEndorsements.AsNoTracking().Where(e => e.TenantId == tenantId && e.UserId == me.Id).Select(e => e.Signature).FirstOrDefaultAsync();
        var rows = new List<FolderKey>();
        foreach (var k in keys.Where(k => allowed.ContainsKey(k.UserId)).DistinctBy(k => k.UserId))
        {
            if (!FolderKeyProof.Verify(me.PublicKey, tenantId, folderId, k.UserId, me.Id, k.WrappedKey, k.WrappedSecretKey, k.Signature))
                throw ApiException.BadRequest("INVALID_KEY_SIGNATURE");
            var reveal = allowed[k.UserId].Reveal;
            rows.Add(new FolderKey
            {
                FolderId = folderId,
                UserId = k.UserId,
                WrappedKey = k.WrappedKey,
                WrappedSecretKey = reveal ? k.WrappedSecretKey : null,
                CreatedById = me.Id,
                SignerId = me.Id,
                SignerPublicKey = me.PublicKey,
                SignerEndorsement = myEndorsement,
                Signature = k.Signature,
                StrippedSecretHash = !reveal && k.WrappedSecretKey is not null ? FolderKeyProof.HashOf(k.WrappedSecretKey) : null,
            });
        }
        return rows;
    }

    [HttpPost("folders")]
    public async Task<object> CreateFolder(FolderCreateDto input)
    {
        var tenantId = TenantOf();
        var inherit = input.InheritPermissions ?? true;
        var (dept, parent, virt) = await NewFolderScope(tenantId, input.DepartmentId, input.ParentId, inherit);
        // Die Kennung vergibt der Client, weil die Herkunftsnachweise der Schlüssel an sie gebunden sind
        if (input.Id is not { } folderId || folderId == Guid.Empty) throw ApiException.BadRequest("FOLDER_ID_REQUIRED");
        if (await db.Folders.AnyAsync(f => f.Id == folderId)) throw ApiException.Conflict("FOLDER_EXISTS");
        var allowed = (await KeyRecipients(tenantId, virt)).ToDictionary(r => r.User.Id);
        var keys = await SignedKeys(tenantId, folderId, input.Keys, allowed);
        if (keys.Count == 0) throw ApiException.BadRequest("NO_KEY_RECIPIENTS");
        // Neue Ordner trennen Übersicht und Geheimteil immer; ohne Geheim-Schlüssel wäre die Trennung wirkungslos
        if (!keys.Any(k => k.WrappedSecretKey is not null)) throw ApiException.BadRequest("SECRET_KEY_REQUIRED");

        var folder = new Folder
        {
            Id = folderId,
            TenantId = tenantId,
            DepartmentId = dept.Id,
            ParentId = parent?.Id,
            Name = input.Name.Trim(),
            Description = input.Description?.Trim() ?? "",
            InheritPermissions = inherit,
            SecretKeyed = true,
        };
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            db.Folders.Add(folder);
            db.FolderKeys.AddRange(keys);
            await SaveUnique();
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("folder.created",
            TenantId: tenantId,
            Actor: Actor.Of(Auth.User),
            TargetType: "folder",
            TargetId: folder.Id.ToString(),
            Metadata: new { name = folder.Name, departmentId = dept.Id, parentId = folder.ParentId, keyRecipients = keys.Count },
            Meta: Meta));
        return folder;
    }

    private async Task<(Guid TenantId, Folder Folder, AccessContext Ctx)> FolderFor(Guid id)
    {
        var tenantId = TenantOf();
        var folder = await db.Folders.FirstOrDefaultAsync(f => f.Id == id && f.TenantId == tenantId) ?? throw ApiException.NotFound("FOLDER_NOT_FOUND");
        var ctx = await perms.ForUser(Auth.User);
        if (!ctx.Has(P.StructureManage) && !ctx.CanFolder(PermissionService.Ref(folder), P.VaultManage)) throw ApiException.Forbidden();
        return (tenantId, folder, ctx);
    }

    /// <summary>Prüft, dass alle Einträge des Ordners in ihrer aktuellen Revision gesendet wurden.</summary>
    private async Task AssertAllItems(Guid folderId, IEnumerable<(Guid Id, int Revision)> sentItems)
    {
        var current = await db.Items.Where(i => i.FolderId == folderId).Select(i => new { i.Id, i.Revision }).ToListAsync();
        var sent = new Dictionary<Guid, int>();
        foreach (var (id, rev) in sentItems) sent[id] = rev;
        if (current.Count != sent.Count || current.Any(c => !sent.TryGetValue(c.Id, out var r) || r != c.Revision)) throw ApiException.Conflict("REVISION_CONFLICT");
    }

    /// <summary>
    /// Umstellung eines bestehenden Ordners auf einen eigenen Geheim-Schlüssel: Ein Manager verschlüsselt alle Geheimteile
    /// im Browser neu. Danach erhalten Benutzer mit reinem Leserecht ("view") den Geheimteil auch kryptografisch nicht mehr.
    /// </summary>
    [Ok200, HttpPost("folders/{id}/secret-key")]
    public async Task<object> UpgradeSecretKey(Guid id, SecretKeyUpgradeDto input)
    {
        var (tenantId, folder, ctx) = await FolderFor(id);
        if (!ctx.CanFolder(PermissionService.Ref(folder), P.VaultManage)) throw ApiException.Forbidden();
        if (folder.SecretKeyed) throw ApiException.Conflict("ALREADY_SECRET_KEYED");
        var me = Auth.User.Id;
        var own = await db.FolderKeys.AsNoTracking().FirstOrDefaultAsync(k => k.FolderId == folder.Id && k.UserId == me) ?? throw ApiException.Forbidden("FOLDER_KEY_MISSING");
        // Eigener Herkunftsnachweis über den unveränderten Ordnerschlüssel und den neuen Geheim-Schlüssel
        if (!FolderKeyProof.Verify(Auth.User.PublicKey, tenantId, folder.Id, me, me, own.WrappedKey, input.WrappedSecretKey, input.Signature))
            throw ApiException.BadRequest("INVALID_KEY_SIGNATURE");
        var myEndorsement = await db.KeyEndorsements.AsNoTracking().Where(e => e.TenantId == tenantId && e.UserId == me).Select(e => e.Signature).FirstOrDefaultAsync();
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            // Alle Einträge müssen in derselben Revision neu verschlüsselt vorliegen, sonst wiederholt der Client später
            await AssertAllItems(folder.Id, input.Items.Select(i => (i.Id, i.Revision)));
            var now = DateTime.UtcNow;
            foreach (var i in input.Items)
            {
                var count = await db.Items.Where(x => x.Id == i.Id && x.FolderId == folder.Id && x.Revision == i.Revision).ExecuteUpdateAsync(u => u
                    .SetProperty(x => x.Secret, i.Secret)
                    .SetProperty(x => x.Revision, x => x.Revision + 1)
                    .SetProperty(x => x.UpdatedById, me)
                    .SetProperty(x => x.UpdatedAt, now));
                if (count == 0) throw ApiException.Conflict("REVISION_CONFLICT");
            }
            var upgraded = await db.Folders.Where(f => f.Id == folder.Id && !f.SecretKeyed)
                .ExecuteUpdateAsync(u => u.SetProperty(f => f.SecretKeyed, true).SetProperty(f => f.UpdatedAt, now));
            if (upgraded == 0) throw ApiException.Conflict("ALREADY_SECRET_KEYED");
            // Bisherige Schlüssel für Geheimteile verwerfen; Berechtigte mit "reveal" erhalten den neuen über die Schlüsselverteilung
            var others = await db.FolderKeys.Where(k => k.FolderId == folder.Id && k.Id != own.Id && k.WrappedSecretKey != null).Select(k => k.Id).ToListAsync();
            await perms.StripSecretKeys(others);
            await db.FolderKeys.Where(k => k.Id == own.Id).ExecuteUpdateAsync(u => u
                .SetProperty(k => k.WrappedSecretKey, input.WrappedSecretKey)
                .SetProperty(k => k.SignerId, me)
                .SetProperty(k => k.SignerPublicKey, Auth.User.PublicKey)
                .SetProperty(k => k.SignerEndorsement, myEndorsement)
                .SetProperty(k => k.Signature, input.Signature)
                .SetProperty(k => k.StrippedSecretHash, (string?)null));
            // Notfall-Schlüsselpakete enthalten den alten Schlüssel; der Browser eines Schlüsselhalters erstellt sie neu
            await db.EmergencyFolderKeys.Where(k => k.FolderId == folder.Id).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("folder.secret_key_created", TenantId: tenantId, Actor: Actor.Of(Auth.User), TargetType: "folder", TargetId: folder.Id.ToString(), Metadata: new { items = input.Items.Count }, Meta: Meta));
        return OkResult;
    }

    /// <summary>Aktuell berechtigte (beglaubigte) Empfänger eines bestehenden Ordners, für die Schlüsselerneuerung.</summary>
    [HttpGet("folders/{id}/key-recipients")]
    public async Task<object> FolderKeyRecipients(Guid id)
    {
        var (tenantId, folder, ctx) = await FolderFor(id);
        var fref = PermissionService.Ref(folder);
        if (!ctx.CanFolder(fref, P.VaultManage)) throw ApiException.Forbidden();
        return (await KeyRecipients(tenantId, fref)).Select(RecipientView).ToList();
    }

    /// <summary>
    /// Schlüsselerneuerung (Rotation) nach Rechteentzug: Ein Manager erzeugt im Browser neue Ordner- und Geheim-Schlüssel,
    /// verschlüsselt alle Einträge neu und verteilt die Schlüssel an die aktuell Berechtigten. Alte Schlüssel – auch solche,
    /// die ein früheres Mitglied behalten hat – passen danach zu keinem gespeicherten Chiffretext mehr.
    /// </summary>
    [Ok200, HttpPost("folders/{id}/rotate-key")]
    public async Task<object> RotateKey(Guid id, RotateKeyDto input)
    {
        var (tenantId, folder, ctx) = await FolderFor(id);
        var fref = PermissionService.Ref(folder);
        if (!ctx.CanFolder(fref, P.VaultManage)) throw ApiException.Forbidden();
        var me = Auth.User.Id;
        // Nur wer den bisherigen Schlüssel hält, kann die Einträge entschlüsseln und neu verschlüsseln
        if (!await db.FolderKeys.AnyAsync(k => k.FolderId == folder.Id && k.UserId == me)) throw ApiException.Forbidden("FOLDER_KEY_MISSING");
        var allowed = (await KeyRecipients(tenantId, fref)).ToDictionary(r => r.User.Id);
        var keys = await SignedKeys(tenantId, folder.Id, input.Keys, allowed);
        var mine = keys.FirstOrDefault(k => k.UserId == me);
        if (mine?.WrappedSecretKey is null) throw ApiException.BadRequest("OWN_KEY_REQUIRED");

        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            // Alle Einträge müssen in ihrer aktuellen Revision neu verschlüsselt vorliegen
            await AssertAllItems(folder.Id, input.Items.Select(i => (i.Id, i.Revision)));
            var now = DateTime.UtcNow;
            foreach (var i in input.Items)
            {
                var count = await db.Items.Where(x => x.Id == i.Id && x.FolderId == folder.Id && x.Revision == i.Revision).ExecuteUpdateAsync(u => u
                    .SetProperty(x => x.Overview, i.Overview)
                    .SetProperty(x => x.Secret, i.Secret)
                    .SetProperty(x => x.Revision, x => x.Revision + 1)
                    .SetProperty(x => x.UpdatedById, me)
                    .SetProperty(x => x.UpdatedAt, now));
                if (count == 0) throw ApiException.Conflict("REVISION_CONFLICT");
            }
            await db.FolderKeys.Where(k => k.FolderId == folder.Id).ExecuteDeleteAsync();
            db.FolderKeys.AddRange(keys);
            folder.SecretKeyed = true;
            folder.KeyRotationRecommended = false;
            await db.SaveChangesAsync();
            // Notfall-Schlüsselpakete enthalten den alten Schlüssel; der Browser eines Schlüsselhalters erstellt sie neu
            await db.EmergencyFolderKeys.Where(k => k.FolderId == folder.Id).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("folder.key_rotated",
            TenantId: tenantId,
            Actor: Actor.Of(Auth.User),
            TargetType: "folder",
            TargetId: folder.Id.ToString(),
            Metadata: new
            {
                items = input.Items.Count,
                recipients = keys.Count,
                // Bestätigt übernommene, unlesbare Einträge (nur IDs dieses Ordners)
                keptUnreadable = input.KeptUnreadable is { Count: > 0 } k ? k.Intersect(input.Items.Select(i => i.Id)).ToList() : null,
            },
            Meta: Meta));
        return new { ok = true, recipients = keys.Count };
    }

    [HttpPatch("folders/{id}")]
    public async Task<object> UpdateFolder(Guid id, FolderUpdateDto input)
    {
        var (tenantId, folder, ctx) = await FolderFor(id);
        var inheritChanged = input.InheritPermissions is { } inh && inh != folder.InheritPermissions;
        // Die Vererbung bestimmt, wer den Ordner sehen darf: nur Tenant-Admins und Manager dieses Ordners dürfen sie ändern,
        // sonst könnten Strukturverwalter sich über geerbte Rechte Zugang zu gesperrten Ordnern verschaffen
        if (inheritChanged && !ctx.CanFolder(PermissionService.Ref(folder), P.VaultManage)) throw ApiException.Forbidden();
        var name = input.Name?.Trim();
        var description = input.Description?.Trim();
        if (name is not null) folder.Name = name;
        if (description is not null) folder.Description = description;
        if (input.InheritPermissions is { } i) folder.InheritPermissions = i;
        await SaveUnique();
        if (inheritChanged) await perms.PruneKeys(tenantId);
        await audit.Log(new AuditEntry("folder.updated", TenantId: tenantId, Actor: Actor.Of(Auth.User), TargetType: "folder", TargetId: folder.Id.ToString(),
            Metadata: new { name, description, inheritPermissions = input.InheritPermissions }, Meta: Meta));
        // PruneKeys kann die Rotationsmarkierung gesetzt haben: aktuellen Stand liefern
        if (inheritChanged) await db.Entry(folder).ReloadAsync();
        return folder;
    }

    [HttpDelete("folders/{id}")]
    public async Task<object> DeleteFolder(Guid id)
    {
        var tenantId = TenantOf();
        var folder = await db.Folders.AsNoTracking().FirstOrDefaultAsync(f => f.Id == id && f.TenantId == tenantId) ?? throw ApiException.NotFound("FOLDER_NOT_FOUND");
        var items = await db.Items.CountAsync(i => i.FolderId == folder.Id);
        var hasChildren = await db.Folders.AnyAsync(f => f.ParentId == folder.Id);
        var ctx = await perms.ForUser(Auth.User);
        if (!ctx.Has(P.StructureManage) && !ctx.DeptVault(folder.DepartmentId).Contains(P.VaultManage)) throw ApiException.Forbidden();
        // Einträge löscht nur, wer den Ordner selbst verwalten darf (gesperrte Ordner bleiben auch für Abteilungs-Manager tabu)
        if (items > 0 && !ctx.CanFolder(PermissionService.Ref(folder), P.VaultManage)) throw ApiException.Forbidden();
        if (hasChildren) throw ApiException.BadRequest("FOLDER_HAS_SUBFOLDERS");
        await db.Folders.Where(f => f.Id == folder.Id).ExecuteDeleteAsync();
        await audit.Log(new AuditEntry("folder.deleted", TenantId: tenantId, Actor: Actor.Of(Auth.User), TargetType: "folder", TargetId: folder.Id.ToString(),
            Metadata: new { name = folder.Name, itemsDeleted = items }, Meta: Meta));
        return OkResult;
    }
}
