using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

/// <summary>Rollen des Tenants und ihre Zuweisungen an Benutzer (Tenant-, Abteilungs- oder Ordnerebene).</summary>
[Route("api")]
public sealed class RolesController(BastionDb db, PermissionService perms, AuditService audit, OrgService org) : BastionController
{
    private Guid TenantOf() => Auth.User.TenantId ?? throw ApiException.Forbidden();

    private static object RoleView(Role r) => new { r.Id, r.TenantId, r.Key, r.Name, r.Description, r.Permissions, r.IsSystem, r.CreatedAt, r.UpdatedAt };

    private static object AssignmentView(RoleAssignment a) =>
        new { a.Id, a.TenantId, a.UserId, a.RoleId, a.ScopeType, a.DepartmentId, a.FolderId, a.CreatedById, a.CreatedAt };

    /// <summary>Rechte aus dem Katalog, mindestens eines, ohne Wiederholungen über die Katalogröße hinaus.</summary>
    private static void ValidatePermissions(List<string> permissions)
    {
        if (permissions.Count < 1 || permissions.Count > P.All.Length) throw OrgHelpers.Invalid("permissions", $"between 1 and {P.All.Length} items expected");
        for (var i = 0; i < permissions.Count; i++)
            if (!P.All.Contains(permissions[i])) throw OrgHelpers.Invalid($"permissions.{i}", "Invalid option");
    }

    [HttpGet("roles")]
    public async Task<object> List()
    {
        var tenantId = TenantOf();
        var roles = await db.Roles.AsNoTracking().Where(r => r.TenantId == tenantId)
            .OrderByDescending(r => r.IsSystem).ThenBy(r => r.Name)
            .Select(r => new { r.Id, r.TenantId, r.Key, r.Name, r.Description, r.Permissions, r.IsSystem, r.CreatedAt, r.UpdatedAt, AssignmentCount = r.Assignments.Count })
            .ToListAsync();
        return roles;
    }

    [HttpGet("permissions")]
    public object Catalog() => P.All;

    private async Task<AccessContext> AssertRoleEditor(IEnumerable<string> permissions)
    {
        var ctx = await perms.ForUser(Auth.User);
        ctx.Require(P.RolesManage);
        // Nur Tenant-Admins dürfen Rollen mit Admin-Recht oder Rechten definieren, die sie selbst nicht besitzen
        if (!ctx.IsTenantAdmin && permissions.Any(p => p == P.TenantAdmin || (P.IsTenantPermission(p) && !ctx.Has(p)))) throw ApiException.Forbidden();
        return ctx;
    }

    [HttpPost("roles")]
    public async Task<object> Create(RoleCreateDto input)
    {
        var tenantId = TenantOf();
        ValidatePermissions(input.Permissions);
        await AssertRoleEditor(input.Permissions);
        var role = new Role { TenantId = tenantId, Name = input.Name.Trim(), Description = input.Description?.Trim() ?? "", Permissions = input.Permissions };
        db.Roles.Add(role);
        try { await db.SaveChangesAsync(); }
        catch (DbUpdateException e) when (OrgHelpers.IsUniqueViolation(e)) { throw ApiException.Conflict("NAME_EXISTS"); }
        await audit.Log(new AuditEntry("role.created", TenantId: tenantId, Actor: Actor.Of(Auth.User), TargetType: "role", TargetId: role.Id.ToString(),
            Metadata: new { name = role.Name, description = role.Description, permissions = role.Permissions }, Meta: Meta));
        return RoleView(role);
    }

    [HttpPatch("roles/{id}")]
    public async Task<object> Update(Guid id, RoleUpdateDto input)
    {
        var tenantId = TenantOf();
        var role = await db.Roles.FirstOrDefaultAsync(r => r.Id == id && r.TenantId == tenantId) ?? throw ApiException.NotFound("ROLE_NOT_FOUND");
        if (role.IsSystem) throw ApiException.BadRequest("SYSTEM_ROLE_IMMUTABLE");
        if (input.Permissions is not null) ValidatePermissions(input.Permissions);
        var ctx = await AssertRoleEditor(role.Permissions.Concat(input.Permissions ?? []));
        // Geänderte Rechte wirken auf alle bestehenden Zuweisungen: Der Bearbeiter muss sie dort jeweils vergeben dürfen
        if (input.Permissions is not null)
        {
            var assignments = await db.RoleAssignments.AsNoTracking().Where(a => a.RoleId == role.Id && a.TenantId == tenantId).ToListAsync();
            foreach (var a in assignments)
                OrgService.AssertCanAssign(ctx, input.Permissions, await org.ResolveScope(tenantId, new ScopeInput(a.ScopeType, a.DepartmentId, a.FolderId)));
        }
        var name = input.Name?.Trim();
        var description = input.Description?.Trim();
        if (name is not null) role.Name = name;
        if (description is not null) role.Description = description;
        if (input.Permissions is not null) role.Permissions = input.Permissions;
        try { await db.SaveChangesAsync(); }
        catch (DbUpdateException e) when (OrgHelpers.IsUniqueViolation(e)) { throw ApiException.Conflict("NAME_EXISTS"); }
        await perms.PruneKeys(tenantId);
        await audit.Log(new AuditEntry("role.updated", TenantId: tenantId, Actor: Actor.Of(Auth.User), TargetType: "role", TargetId: role.Id.ToString(),
            Metadata: new { name, description, permissions = input.Permissions }, Meta: Meta));
        return RoleView(role);
    }

    [HttpDelete("roles/{id}")]
    public async Task<object> Remove(Guid id)
    {
        var tenantId = TenantOf();
        var role = await db.Roles.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id && r.TenantId == tenantId) ?? throw ApiException.NotFound("ROLE_NOT_FOUND");
        if (role.IsSystem) throw ApiException.BadRequest("SYSTEM_ROLE_IMMUTABLE");
        await AssertRoleEditor(role.Permissions);
        await db.Roles.Where(r => r.Id == role.Id).ExecuteDeleteAsync();
        await perms.PruneKeys(tenantId);
        await audit.Log(new AuditEntry("role.deleted", TenantId: tenantId, Actor: Actor.Of(Auth.User), TargetType: "role", TargetId: role.Id.ToString(), Metadata: new { name = role.Name }, Meta: Meta));
        return OkResult;
    }

    // ---------- Zuweisungen ----------

    [HttpGet("assignments")]
    public async Task<object> ListAssignments([FromQuery] string? scopeType, [FromQuery] string? departmentId, [FromQuery] string? folderId)
    {
        var tenantId = TenantOf();
        if (!Enum.TryParse<ScopeType>(scopeType, ignoreCase: false, out var st) || !Enum.IsDefined(st) || scopeType!.Any(char.IsDigit))
            throw OrgHelpers.Invalid("scopeType", "Invalid option");
        Guid? ParseId(string? v, string path)
        {
            if (v is null) return null;
            return Guid.TryParseExact(v, "D", out var g) ? g : throw OrgHelpers.Invalid(path, "Invalid UUID");
        }
        var dept = ParseId(departmentId, "departmentId");
        var fold = ParseId(folderId, "folderId");
        var ctx = await perms.ForUser(Auth.User);
        var scope = await org.ResolveScope(tenantId, new ScopeInput(st, dept, fold));
        var allowed = ctx.Has(P.RolesManage)
            || ctx.Has(P.UsersManage)
            || (scope.ScopeType == ScopeType.DEPARTMENT && ctx.DeptVault(scope.DepartmentId!.Value).Contains(P.VaultManage))
            || (scope.ScopeType == ScopeType.FOLDER && ctx.CanFolder(PermissionService.Ref(scope.Folder!), P.VaultManage));
        if (!allowed) throw ApiException.Forbidden();
        return await db.RoleAssignments.AsNoTracking()
            .Where(a => a.TenantId == tenantId && a.ScopeType == scope.ScopeType && a.DepartmentId == scope.DepartmentId && a.FolderId == scope.FolderId)
            .OrderBy(a => a.CreatedAt)
            .Select(a => new
            {
                a.Id,
                a.TenantId,
                a.UserId,
                a.RoleId,
                a.ScopeType,
                a.DepartmentId,
                a.FolderId,
                a.CreatedById,
                a.CreatedAt,
                User = new { a.User.Id, a.User.Name, a.User.Email, a.User.Status },
                Role = new { a.Role.Id, a.Role.Name, a.Role.Key, a.Role.Permissions },
            })
            .ToListAsync();
    }

    [HttpPost("assignments")]
    public async Task<object> Assign(AssignDto input)
    {
        var tenantId = TenantOf();
        var user = await PermissionService.TenantMembers(db.Users.AsNoTracking(), tenantId).FirstOrDefaultAsync(u => u.Id == input.UserId);
        var role = await db.Roles.AsNoTracking().FirstOrDefaultAsync(r => r.Id == input.RoleId && r.TenantId == tenantId);
        if (user is null) throw ApiException.NotFound("USER_NOT_FOUND");
        if (role is null) throw ApiException.NotFound("ROLE_NOT_FOUND");
        var scope = await org.ResolveScope(tenantId, new ScopeInput(input.ScopeType, input.DepartmentId, input.FolderId));
        OrgService.AssertCanAssign(await perms.ForUser(Auth.User), role.Permissions, scope);
        var created = new RoleAssignment
        {
            TenantId = tenantId,
            UserId = user.Id,
            RoleId = role.Id,
            ScopeType = scope.ScopeType,
            DepartmentId = scope.DepartmentId,
            FolderId = scope.FolderId,
            CreatedById = Auth.User.Id,
        };
        db.RoleAssignments.Add(created);
        try { await db.SaveChangesAsync(); }
        catch (DbUpdateException e) when (OrgHelpers.IsUniqueViolation(e)) { throw ApiException.Conflict("ASSIGNMENT_EXISTS"); }
        await audit.Log(new AuditEntry("assignment.created",
            TenantId: tenantId,
            Actor: Actor.Of(Auth.User),
            TargetType: "user",
            TargetId: user.Id.ToString(),
            Metadata: new { role = role.Name, roleId = role.Id, scopeType = scope.ScopeType.ToString(), departmentId = scope.DepartmentId, folderId = scope.FolderId },
            Meta: Meta));
        return AssignmentView(created);
    }

    [HttpDelete("assignments/{id}")]
    public async Task<object> Unassign(Guid id)
    {
        var tenantId = TenantOf();
        var a = await db.RoleAssignments.AsNoTracking().Include(x => x.Role).FirstOrDefaultAsync(x => x.Id == id && x.TenantId == tenantId) ?? throw ApiException.NotFound("ASSIGNMENT_NOT_FOUND");
        var scope = await org.ResolveScope(tenantId, new ScopeInput(a.ScopeType, a.DepartmentId, a.FolderId));
        OrgService.AssertCanAssign(await perms.ForUser(Auth.User), a.Role.Permissions, scope);
        if (a.Role.Permissions.Contains(P.TenantAdmin))
        {
            var otherAdminAssignments = await db.RoleAssignments.CountAsync(x =>
                x.TenantId == tenantId && x.UserId == a.UserId && x.ScopeType == ScopeType.TENANT && x.Id != a.Id && x.Role.Permissions.Contains(P.TenantAdmin));
            if (otherAdminAssignments == 0) await org.AssertNotLastAdmin(tenantId, a.UserId);
        }
        await db.RoleAssignments.Where(x => x.Id == a.Id).ExecuteDeleteAsync();
        await perms.PruneKeys(tenantId);
        await audit.Log(new AuditEntry("assignment.deleted",
            TenantId: tenantId,
            Actor: Actor.Of(Auth.User),
            TargetType: "user",
            TargetId: a.UserId.ToString(),
            Metadata: new { role = a.Role.Name, roleId = a.RoleId, scopeType = a.ScopeType.ToString(), departmentId = a.DepartmentId, folderId = a.FolderId },
            Meta: Meta));
        return OkResult;
    }
}
