using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Services;

public sealed record ScopeInput(ScopeType ScopeType, Guid? DepartmentId, Guid? FolderId);

public sealed record ResolvedScope(ScopeType ScopeType, Guid? DepartmentId, Guid? FolderId, Folder? Folder);

public sealed class OrgService(BastionDb db, MailService mail)
{
    /// <summary>
    /// Informiert alle aktiven Tenant-Admins per E-Mail über einen Eingriff von außen (z. B. durch einen System-Admin),
    /// damit dieser nicht nur im Audit-Log steht. Fehler beim Versand blockieren die Aktion nicht.
    /// </summary>
    public async Task NotifyTenantAdmins(Guid tenantId, MailEvent ev, IReadOnlyCollection<Guid>? exceptUserIds = null)
    {
        var except = exceptUserIds ?? [];
        var tenantName = await db.Tenants.Where(t => t.Id == tenantId).Select(t => t.Name).FirstOrDefaultAsync();
        var admins = await db.Users
            .Where(u => u.Status == UserStatus.ACTIVE && !except.Contains(u.Id)
                && u.Assignments.Any(a => a.TenantId == tenantId && a.ScopeType == ScopeType.TENANT && a.Role.Permissions.Contains(P.TenantAdmin)))
            .Select(u => u.Email)
            .ToListAsync();
        foreach (var email in admins) await mail.SendTenantAdminNotice(email, tenantName ?? "Bastion", ev);
    }

    /// <summary>Informiert alle anderen aktiven System-Admins per E-Mail über eine Änderung durch einen System-Admin.</summary>
    public async Task NotifySystemAdmins(MailEvent ev, Guid exceptUserId)
    {
        var admins = await db.Users
            .Where(u => u.SystemRole == SystemRole.SYSTEM_ADMIN && u.Status == UserStatus.ACTIVE && u.Id != exceptUserId)
            .Select(u => u.Email)
            .ToListAsync();
        foreach (var email in admins) await mail.SendSystemAdminNotice(email, ev);
    }

    public void AddBuiltinRoles(Guid tenantId)
    {
        foreach (var r in P.BuiltinRoles)
            db.Roles.Add(new Role { TenantId = tenantId, Key = r.Key, Name = r.Name, Description = r.Description, Permissions = [.. r.Permissions], IsSystem = true });
    }

    /// <summary>Tenants, denen ein System-Admin über eine Zuweisung auf Tenant-Ebene angehört (alphabetisch).</summary>
    public async Task<List<Guid>> SysadminTenantIds(Guid userId)
    {
        var rows = await db.RoleAssignments
            .Where(a => a.UserId == userId && a.ScopeType == ScopeType.TENANT)
            .Select(a => new { a.TenantId, a.Tenant.Name })
            .Distinct()
            .ToListAsync();
        return rows.OrderBy(r => r.Name, StringComparer.CurrentCultureIgnoreCase).Select(r => r.TenantId).Distinct().ToList();
    }

    /// <summary>Aktive Tenant-Admins eines Tenants (Zuweisung auf Tenant-Ebene).</summary>
    public Task<List<Guid>> ActiveTenantAdminIds(Guid tenantId) =>
        db.RoleAssignments
            .Where(a => a.TenantId == tenantId && a.ScopeType == ScopeType.TENANT && a.Role.Permissions.Contains(P.TenantAdmin) && a.User.Status == UserStatus.ACTIVE)
            .Select(a => a.UserId)
            .Distinct()
            .ToListAsync();

    /// <summary>Macht einen Benutzer zum Tenant-Admin (idempotent). Aufrufer kümmert sich um Transaktion und Audit.</summary>
    public async Task AddTenantAdmin(Guid tenantId, Guid userId, Guid createdById)
    {
        var role = await TenantAdminRole(tenantId);
        var exists = await db.RoleAssignments.AnyAsync(a => a.TenantId == tenantId && a.UserId == userId && a.RoleId == role.Id && a.ScopeType == ScopeType.TENANT);
        if (exists) return;
        db.RoleAssignments.Add(new RoleAssignment { TenantId = tenantId, UserId = userId, RoleId = role.Id, ScopeType = ScopeType.TENANT, CreatedById = createdById });
        await db.SaveChangesAsync();
    }

    public async Task<Role> TenantAdminRole(Guid tenantId) =>
        await db.Roles.FirstOrDefaultAsync(r => r.TenantId == tenantId && r.Key == "tenant_admin")
        ?? throw new InvalidOperationException("Rolle tenant_admin fehlt");

    /// <summary>Normalisiert und prüft einen Scope gegen den Tenant.</summary>
    public async Task<ResolvedScope> ResolveScope(Guid tenantId, ScopeInput s)
    {
        if (s.ScopeType == ScopeType.TENANT) return new ResolvedScope(ScopeType.TENANT, null, null, null);
        if (s.ScopeType == ScopeType.DEPARTMENT)
        {
            var dept = s.DepartmentId is { } did ? await db.Departments.FirstOrDefaultAsync(d => d.Id == did && d.TenantId == tenantId) : null;
            if (dept is null) throw ApiException.NotFound("DEPARTMENT_NOT_FOUND");
            return new ResolvedScope(ScopeType.DEPARTMENT, dept.Id, null, null);
        }
        var folder = s.FolderId is { } fid ? await db.Folders.FirstOrDefaultAsync(f => f.Id == fid && f.TenantId == tenantId) : null;
        if (folder is null) throw ApiException.NotFound("FOLDER_NOT_FOUND");
        return new ResolvedScope(ScopeType.FOLDER, null, folder.Id, folder);
    }

    /// <summary>
    /// Darf <paramref name="ctx"/> die Rolle auf diesem Scope vergeben bzw. entziehen?
    /// Grundsatz: Niemand kann Rechte vergeben, die er selbst nicht besitzt (keine Rechteausweitung).
    /// Das gilt auch für Rollenverwalter: Tresorrechte vergeben sie nur in Bereichen, in denen sie diese Rechte selbst haben.
    /// </summary>
    public static void AssertCanAssign(AccessContext ctx, IReadOnlyCollection<string> rolePermissions, ResolvedScope scope)
    {
        var tenantPerms = rolePermissions.Where(P.IsTenantPermission).ToList();
        var vaultPerms = P.ExpandVault(rolePermissions);

        if (tenantPerms.Count > 0)
        {
            if (scope.ScopeType != ScopeType.TENANT) throw ApiException.BadRequest("TENANT_ROLE_REQUIRES_TENANT_SCOPE");
            if (rolePermissions.Contains(P.TenantAdmin) && !ctx.IsTenantAdmin) throw ApiException.Forbidden();
            if (!ctx.Has(P.RolesManage) || !tenantPerms.All(ctx.Has)) throw ApiException.Forbidden();
        }
        if (vaultPerms.Count == 0) return;
        var own = scope.ScopeType switch
        {
            ScopeType.TENANT => ctx.TenantVault(),
            ScopeType.DEPARTMENT => ctx.DeptVault(scope.DepartmentId!.Value),
            _ => ctx.FolderVault(PermissionService.Ref(scope.Folder!)),
        };
        // Delegieren dürfen Rollenverwalter und Manager des Bereichs, jeweils nur Rechte, die sie dort selbst besitzen
        var mayDelegate = ctx.Has(P.RolesManage) || own.Contains(P.VaultManage);
        if (mayDelegate && vaultPerms.All(own.Contains)) return;
        throw ApiException.Forbidden();
    }

    /// <summary>Verhindert, dass der letzte aktive Tenant-Admin entfernt wird.</summary>
    public async Task AssertNotLastAdmin(Guid tenantId, Guid userId)
    {
        var admins = await ActiveTenantAdminIds(tenantId);
        var others = admins.Where(id => id != userId).ToHashSet();
        if (admins.Contains(userId) && others.Count == 0) throw ApiException.BadRequest("LAST_TENANT_ADMIN");
    }
}
