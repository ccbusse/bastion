using Bastion.Server.Data;
using Bastion.Server.Services;

namespace Bastion.Server.Tests;

/// <summary>Rechtevererbung: Tenant → Abteilung → Ordner → Unterordner, Unterbrechung der Vererbung, keine Rechteausweitung.</summary>
public class PermissionTests
{
    private static readonly Guid Dept = Guid.NewGuid();
    private static readonly Guid OtherDept = Guid.NewGuid();
    private static readonly FolderRef Root = new(Guid.NewGuid(), Dept, null, true);
    private static readonly FolderRef Child = new(Guid.NewGuid(), Dept, Root.Id, true);
    private static readonly FolderRef Isolated = new(Guid.NewGuid(), Dept, Root.Id, false);
    private static readonly FolderRef BelowIsolated = new(Guid.NewGuid(), Dept, Isolated.Id, true);

    private static readonly Dictionary<Guid, FolderRef> Folders = new[] { Root, Child, Isolated, BelowIsolated }.ToDictionary(f => f.Id);

    private static AccessContext Ctx(params AssignmentRef[] a) => new(Guid.NewGuid(), Guid.NewGuid(), false, true, a, Folders);

    private static AssignmentRef OnTenant(params string[] p) => new(ScopeType.TENANT, null, null, p);
    private static AssignmentRef OnDept(Guid d, params string[] p) => new(ScopeType.DEPARTMENT, d, null, p);
    private static AssignmentRef OnFolder(FolderRef f, params string[] p) => new(ScopeType.FOLDER, null, f.Id, p);

    [Fact]
    public void Vault_permissions_imply_lower_ones()
    {
        Assert.Equal(new HashSet<string> { P.VaultView, P.VaultReveal, P.VaultEdit }, P.ExpandVault([P.VaultEdit]));
        Assert.Empty(P.ExpandVault(["tenant.admin"]));
    }

    [Fact]
    public void Department_rights_flow_into_folders_and_subfolders()
    {
        var ctx = Ctx(OnDept(Dept, P.VaultReveal));
        Assert.True(ctx.CanFolder(Root, P.VaultReveal));
        Assert.True(ctx.CanFolder(Child, P.VaultView));
        Assert.False(ctx.CanFolder(Child, P.VaultEdit));
        Assert.DoesNotContain(P.VaultView, ctx.DeptVault(OtherDept));
    }

    [Fact]
    public void Disabled_inheritance_cuts_off_upper_levels()
    {
        var ctx = Ctx(OnTenant(P.VaultManage), OnFolder(Isolated, P.VaultView));
        Assert.True(ctx.CanFolder(Child, P.VaultManage));
        Assert.True(ctx.CanFolder(Isolated, P.VaultView));
        Assert.False(ctx.CanFolder(Isolated, P.VaultReveal));
        // Unterordner erbt nur ab der unterbrochenen Ebene
        Assert.True(ctx.CanFolder(BelowIsolated, P.VaultView));
        Assert.False(ctx.CanFolder(BelowIsolated, P.VaultEdit));
    }

    [Fact]
    public void Tenant_permissions_only_count_on_tenant_scope()
    {
        var ctx = Ctx(OnDept(Dept, P.TenantAdmin, P.UsersManage, P.VaultView));
        Assert.False(ctx.IsTenantAdmin);
        Assert.False(ctx.Has(P.UsersManage));
        Assert.True(ctx.CanFolder(Root, P.VaultView));
    }

    [Fact]
    public void Tenant_admin_has_everything()
    {
        var ctx = Ctx(OnTenant(P.TenantAdmin));
        Assert.True(ctx.Has(P.RolesManage));
        Assert.True(ctx.CanFolder(Isolated, P.VaultManage));
        Assert.Equal(P.TenantPermissions.Length + P.VaultPermissions.Length, ctx.TenantPermissions().Count);
    }

    [Fact]
    public void Inactive_users_have_no_rights()
    {
        var ctx = new AccessContext(Guid.NewGuid(), Guid.NewGuid(), false, false, [OnTenant(P.TenantAdmin)], Folders);
        Assert.False(ctx.IsTenantAdmin);
        Assert.False(ctx.CanFolder(Root, P.VaultView));
    }

    [Fact]
    public void Unknown_parent_or_cycle_inherits_nothing()
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var cycle = new Dictionary<Guid, FolderRef> { [a] = new(a, Dept, b, true), [b] = new(b, Dept, a, true) };
        var orphan = new FolderRef(Guid.NewGuid(), Dept, Guid.NewGuid(), true);
        var ctx = new AccessContext(Guid.NewGuid(), Guid.NewGuid(), false, true, [OnTenant(P.VaultView)], cycle);
        Assert.False(ctx.CanFolder(cycle[a], P.VaultView));
        Assert.False(ctx.CanFolder(orphan, P.VaultView));
    }

    [Fact]
    public void Nobody_can_grant_more_than_they_hold()
    {
        var scope = new ResolvedScope(ScopeType.DEPARTMENT, Dept, null, null);
        var manager = Ctx(OnDept(Dept, P.VaultManage));
        OrgService.AssertCanAssign(manager, [P.VaultEdit], scope);
        Assert.Throws<Common.ApiException>(() => OrgService.AssertCanAssign(manager, [P.VaultEdit], new ResolvedScope(ScopeType.DEPARTMENT, OtherDept, null, null)));
        Assert.Throws<Common.ApiException>(() => OrgService.AssertCanAssign(manager, [P.UsersInvite], new ResolvedScope(ScopeType.TENANT, null, null, null)));

        var editor = Ctx(OnDept(Dept, P.VaultEdit));
        Assert.Throws<Common.ApiException>(() => OrgService.AssertCanAssign(editor, [P.VaultView], scope));

        var roleManager = Ctx(OnTenant(P.RolesManage, P.UsersInvite));
        Assert.Throws<Common.ApiException>(() => OrgService.AssertCanAssign(roleManager, [P.TenantAdmin], new ResolvedScope(ScopeType.TENANT, null, null, null)));
        Assert.Throws<Common.ApiException>(() => OrgService.AssertCanAssign(roleManager, [P.UsersInvite], scope));
        OrgService.AssertCanAssign(roleManager, [P.UsersInvite], new ResolvedScope(ScopeType.TENANT, null, null, null));
    }
}
