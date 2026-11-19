using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Services;

/// <summary>
/// Rechtekatalog.
/// <list type="bullet">
/// <item>tenant.*: administrative Rechte, wirken nur bei Zuweisung auf Tenant-Ebene.</item>
/// <item>vault.*: Tresorrechte, zuweisbar auf Tenant-, Abteilungs- oder Ordnerebene; sie vererben sich nach unten.
/// manage ⊃ edit ⊃ reveal ⊃ view</item>
/// </list>
/// </summary>
public static class P
{
    public const string TenantAdmin = "tenant.admin";
    public const string UsersInvite = "tenant.users.invite";
    public const string UsersConfirm = "tenant.users.confirm";
    public const string UsersManage = "tenant.users.manage";
    public const string StructureManage = "tenant.structure.manage";
    public const string RolesManage = "tenant.roles.manage";
    public const string AuditRead = "tenant.audit.read";
    public const string SettingsManage = "tenant.settings.manage";
    public const string VaultView = "vault.view";
    public const string VaultReveal = "vault.reveal";
    public const string VaultEdit = "vault.edit";
    public const string VaultManage = "vault.manage";

    public static readonly string[] TenantPermissions = [TenantAdmin, UsersInvite, UsersConfirm, UsersManage, StructureManage, RolesManage, AuditRead, SettingsManage];
    public static readonly string[] VaultPermissions = [VaultView, VaultReveal, VaultEdit, VaultManage];
    public static readonly string[] All = [.. TenantPermissions, .. VaultPermissions];

    public static bool IsTenantPermission(string p) => p.StartsWith("tenant.", StringComparison.Ordinal);
    public static bool IsVaultPermission(string p) => p.StartsWith("vault.", StringComparison.Ordinal);

    /// <summary>Erweitert Tresorrechte um implizierte Rechte.</summary>
    public static HashSet<string> ExpandVault(IEnumerable<string> perms)
    {
        var output = new HashSet<string>();
        foreach (var p in perms)
        {
            var idx = Array.IndexOf(VaultPermissions, p);
            for (var i = 0; i <= idx; i++) output.Add(VaultPermissions[i]);
        }
        return output;
    }

    public sealed record BuiltinRole(string Key, string Name, string Description, string[] Permissions);

    public static readonly BuiltinRole[] BuiltinRoles =
    [
        new("tenant_admin", "Tenant-Administrator", "Vollzugriff auf den Tenant inkl. Kontowiederherstellung", [TenantAdmin]),
        new("manager", "Manager", "Einträge verwalten, Ordner und Freigaben verwalten", [VaultManage]),
        new("editor", "Bearbeiter", "Einträge anzeigen, anlegen, bearbeiten und löschen", [VaultEdit]),
        new("reader", "Leser", "Einträge inkl. Passwörtern anzeigen", [VaultReveal]),
        new("viewer", "Betrachter", "Nur Übersicht (Name, Benutzername, URL), keine Passwörter", [VaultView]),
        new("user_manager", "Benutzerverwaltung", "Benutzer einladen, bestätigen und verwalten", [UsersInvite, UsersConfirm, UsersManage]),
        new("auditor", "Auditor", "Audit-Log lesen", [AuditRead]),
    ];
}

public sealed record FolderRef(Guid Id, Guid DepartmentId, Guid? ParentId, bool InheritPermissions);

public sealed record AssignmentRef(ScopeType ScopeType, Guid? DepartmentId, Guid? FolderId, IReadOnlyList<string> Permissions);

/// <summary>
/// Effektive Rechte eines Benutzers.
/// Ordner erben Rechte vom übergeordneten Ordner, Ordner auf oberster Ebene von Tenant- und Abteilungsebene.
/// Ist die Vererbung an einem Ordner deaktiviert, zählen dort (und für seine erbenden Unterordner)
/// nur direkte Ordnerzuweisungen ab dieser Ebene. Tenant-Admins haben implizit alle Rechte.
/// </summary>
public sealed class AccessContext
{
    private const int MaxDepth = 64;
    private readonly HashSet<string> tenantRaw = [];
    private readonly Dictionary<Guid, HashSet<string>> deptRaw = [];
    private readonly Dictionary<Guid, HashSet<string>> folderRaw = [];
    private readonly IReadOnlyDictionary<Guid, FolderRef> folders;

    public Guid UserId { get; }
    public Guid? TenantId { get; }
    public bool IsSystemAdmin { get; }
    public bool IsTenantAdmin { get; }

    public AccessContext(Guid userId, Guid? tenantId, bool isSystemAdmin, bool active, IEnumerable<AssignmentRef> assignments, IReadOnlyDictionary<Guid, FolderRef>? folders = null)
    {
        UserId = userId;
        TenantId = tenantId;
        IsSystemAdmin = isSystemAdmin;
        this.folders = folders ?? new Dictionary<Guid, FolderRef>();
        if (active)
        {
            foreach (var a in assignments)
            {
                var target = a.ScopeType switch
                {
                    ScopeType.TENANT => tenantRaw,
                    ScopeType.DEPARTMENT => GetOrInit(deptRaw, a.DepartmentId!.Value),
                    _ => GetOrInit(folderRaw, a.FolderId!.Value),
                };
                foreach (var p in a.Permissions)
                {
                    // Tenant-Rechte wirken nur auf Tenant-Ebene
                    if (a.ScopeType != ScopeType.TENANT && !P.IsVaultPermission(p)) continue;
                    target.Add(p);
                }
            }
        }
        IsTenantAdmin = tenantRaw.Contains(P.TenantAdmin);
    }

    private static HashSet<string> GetOrInit(Dictionary<Guid, HashSet<string>> m, Guid k)
    {
        if (!m.TryGetValue(k, out var s)) m[k] = s = [];
        return s;
    }

    public bool Has(string perm) => IsTenantAdmin || tenantRaw.Contains(perm);

    /// <summary>Effektive Tenant-Rechte (für die Oberfläche).</summary>
    public List<string> TenantPermissions()
    {
        if (IsTenantAdmin) return [.. P.TenantPermissions, .. P.VaultPermissions];
        return tenantRaw.Where(p => !P.IsVaultPermission(p)).Concat(P.ExpandVault(tenantRaw)).Distinct().ToList();
    }

    /// <summary>Tresorrechte auf Tenant-Ebene (wirken auf alle Abteilungen und erbenden Ordner).</summary>
    public HashSet<string> TenantVault() => IsTenantAdmin ? [.. P.VaultPermissions] : P.ExpandVault(tenantRaw);

    public HashSet<string> DeptVault(Guid departmentId) =>
        IsTenantAdmin ? [.. P.VaultPermissions] : P.ExpandVault(tenantRaw.Concat(deptRaw.GetValueOrDefault(departmentId) ?? []));

    public HashSet<string> FolderVault(FolderRef folder) => IsTenantAdmin ? [.. P.VaultPermissions] : P.ExpandVault(RawFolder(folder, 0));

    private IEnumerable<string> RawFolder(FolderRef folder, int depth)
    {
        IEnumerable<string> own = folderRaw.GetValueOrDefault(folder.Id) ?? [];
        if (!folder.InheritPermissions) return own;
        FolderRef? parent = folder.ParentId is { } pid ? folders.GetValueOrDefault(pid) : null;
        // Unbekannter Elternordner oder zu tiefe Verschachtelung: sicherheitshalber nichts erben
        if (folder.ParentId is not null && (parent is null || depth >= MaxDepth)) return own;
        var inherited = parent is not null ? RawFolder(parent, depth + 1) : tenantRaw.Concat(deptRaw.GetValueOrDefault(folder.DepartmentId) ?? []);
        return inherited.Concat(own).ToList();
    }

    public bool CanFolder(FolderRef folder, string perm) => FolderVault(folder).Contains(perm);

    public bool HasDeptAssignment(Guid departmentId) => deptRaw.TryGetValue(departmentId, out var s) && s.Count > 0;

    public void Require(string perm)
    {
        if (!Has(perm)) throw ApiException.Forbidden();
    }
}

public sealed record MemberContext(User User, AccessContext Ctx);

public sealed class PermissionService(BastionDb db)
{
    /// <summary>
    /// Mitglieder eines Tenants: reguläre Benutzer über ihre Tenant-Zuordnung, System-Admins über eine
    /// Rollenzuweisung auf Tenant-Ebene (sie können mehreren Tenants angehören; TenantId ist dann der aktive).
    /// </summary>
    public static IQueryable<User> TenantMembers(IQueryable<User> users, Guid tenantId) =>
        users.Where(u => u.TenantId == tenantId
            || (u.SystemRole == SystemRole.SYSTEM_ADMIN && u.Assignments.Any(a => a.TenantId == tenantId && a.ScopeType == ScopeType.TENANT)));

    public static FolderRef Ref(Folder f) => new(f.Id, f.DepartmentId, f.ParentId, f.InheritPermissions);

    private async Task<List<(Guid UserId, AssignmentRef A)>> Assignments(Guid tenantId, Guid? userId)
    {
        var rows = await db.RoleAssignments.AsNoTracking()
            .Where(a => a.TenantId == tenantId && (userId == null || a.UserId == userId))
            .Select(a => new { a.UserId, a.ScopeType, a.DepartmentId, a.FolderId, a.Role.Permissions })
            .ToListAsync();
        return rows.Select(a => (a.UserId, new AssignmentRef(a.ScopeType, a.DepartmentId, a.FolderId, a.Permissions))).ToList();
    }

    public async Task<AccessContext> ForUser(User user)
    {
        if (user.TenantId is not { } tenantId)
            return new AccessContext(user.Id, null, user.SystemRole == SystemRole.SYSTEM_ADMIN, user.Status == UserStatus.ACTIVE, []);
        // Nur Zuweisungen des aktiven Tenants – System-Admins können weiteren Tenants angehören
        var assignments = await Assignments(tenantId, user.Id);
        var folders = await FolderMap(tenantId);
        return new AccessContext(user.Id, tenantId, user.SystemRole == SystemRole.SYSTEM_ADMIN, user.Status == UserStatus.ACTIVE, assignments.Select(a => a.A), folders);
    }

    /// <summary>Ordnerbaum eines Tenants (für die Rechtevererbung über Elternordner).</summary>
    public async Task<Dictionary<Guid, FolderRef>> FolderMap(Guid tenantId) =>
        await db.Folders.AsNoTracking().Where(f => f.TenantId == tenantId)
            .Select(f => new FolderRef(f.Id, f.DepartmentId, f.ParentId, f.InheritPermissions))
            .ToDictionaryAsync(f => f.Id);

    /// <summary>Kontexte aller aktiven Benutzer eines Tenants mit Schlüsselpaar (für die Empfängerberechnung).</summary>
    public async Task<List<MemberContext>> TenantContexts(Guid tenantId)
    {
        var users = await TenantMembers(db.Users.AsNoTracking(), tenantId)
            .Where(u => u.Status == UserStatus.ACTIVE && u.PublicKey != null)
            .ToListAsync();
        var assignments = await Assignments(tenantId, null);
        var folders = await FolderMap(tenantId);
        var byUser = assignments.ToLookup(a => a.UserId, a => a.A);
        return users.Select(u => new MemberContext(u, new AccessContext(u.Id, tenantId, false, true, byUser[u.Id], folders))).ToList();
    }

    /// <summary>
    /// Entfernt Ordnerschlüssel von Benutzern, die keinen Lesezugriff mehr haben,
    /// sowie Recovery-Grants von Benutzern, die keine Tenant-Admins mehr sind.
    /// </summary>
    public async Task<(int RemovedFolderKeys, int RemovedRecoveryGrants)> PruneKeys(Guid tenantId)
    {
        var contexts = await TenantContexts(tenantId);
        var ctxByUser = contexts.ToDictionary(c => c.User.Id, c => c.Ctx);
        var folderById = await FolderMap(tenantId);
        var keys = await db.FolderKeys.AsNoTracking().Where(k => k.Folder.TenantId == tenantId)
            .Select(k => new { k.Id, k.UserId, k.FolderId, k.WrappedSecretKey }).ToListAsync();

        bool Can(Guid userId, Guid folderId, string perm) =>
            ctxByUser.TryGetValue(userId, out var ctx) && folderById.TryGetValue(folderId, out var f) && ctx.CanFolder(f, perm);

        // Sicherheitsnetz: Den letzten Schlüssel eines Ordners nie löschen, sonst wären die Daten unwiederbringlich verloren.
        // Der Server liefert die Einträge trotzdem nur an berechtigte Benutzer aus.
        var holdersLeft = keys.Where(k => Can(k.UserId, k.FolderId, P.VaultView)).GroupBy(k => k.FolderId).ToDictionary(g => g.Key, g => g.Count());
        var stale = keys.Where(k => !Can(k.UserId, k.FolderId, P.VaultView) && holdersLeft.GetValueOrDefault(k.FolderId) > 0).ToList();
        if (stale.Count > 0)
        {
            var ids = stale.Select(k => k.Id).ToList();
            await db.FolderKeys.Where(k => ids.Contains(k.Id)).ExecuteDeleteAsync();
        }

        // Geheim-Schlüssel nur für Benutzer mit "reveal" (auch hier bleibt der letzte Halter erhalten)
        var staleIds = stale.Select(k => k.Id).ToHashSet();
        var withSecret = keys.Where(k => k.WrappedSecretKey is not null && !staleIds.Contains(k.Id)).ToList();
        var secretHolders = withSecret.Where(k => Can(k.UserId, k.FolderId, P.VaultReveal)).GroupBy(k => k.FolderId).ToDictionary(g => g.Key, g => g.Count());
        var staleSecrets = withSecret.Where(k => !Can(k.UserId, k.FolderId, P.VaultReveal) && secretHolders.GetValueOrDefault(k.FolderId) > 0).ToList();
        if (staleSecrets.Count > 0) await StripSecretKeys(staleSecrets.Select(k => k.Id).ToList());
        // Wer einen Schlüssel hatte, kann ihn behalten haben: Erneuerung des Ordnerschlüssels empfehlen
        await RecommendRotation(stale.Select(k => k.FolderId).Concat(staleSecrets.Select(k => k.FolderId)));

        var grants = await db.RecoveryGrants.AsNoTracking().Where(g => g.TenantId == tenantId).Select(g => new { g.Id, g.UserId }).ToListAsync();
        var staleGrants = grants.Where(g => !(ctxByUser.GetValueOrDefault(g.UserId)?.IsTenantAdmin ?? false)).Select(g => g.Id).ToList();
        if (staleGrants.Count > 0) await db.RecoveryGrants.Where(g => staleGrants.Contains(g.Id)).ExecuteDeleteAsync();
        return (stale.Count, staleGrants.Count);
    }

    /// <summary>
    /// Entfernt den Geheim-Schlüssel aus Schlüsselpaketen (Recht "reveal" entzogen). Bei Paketen mit Herkunftsnachweis bleibt
    /// der SHA-256-Wert des entfernten Geheim-Schlüssels erhalten, damit der Empfänger die Signatur über den verbleibenden
    /// Ordnerschlüssel weiter prüfen kann.
    /// </summary>
    public async Task StripSecretKeys(IReadOnlyCollection<Guid> folderKeyIds)
    {
        if (folderKeyIds.Count == 0) return;
        var ids = folderKeyIds.ToArray();
        await db.Database.ExecuteSqlAsync($"""
            UPDATE folder_keys SET
              stripped_secret_hash = CASE WHEN signature IS NOT NULL THEN encode(sha256(decode(wrapped_secret_key, 'base64')), 'hex') ELSE NULL END,
              wrapped_secret_key = NULL
            WHERE id = ANY({ids}) AND wrapped_secret_key IS NOT NULL
            """);
    }

    /// <summary>Markiert Ordner, deren Schlüssel jemandem entzogen wurde: Ein Manager sollte den Schlüssel erneuern (Rotation).</summary>
    public async Task RecommendRotation(IEnumerable<Guid> folderIds)
    {
        var ids = folderIds.Distinct().ToList();
        if (ids.Count > 0) await db.Folders.Where(f => ids.Contains(f.Id)).ExecuteUpdateAsync(u => u.SetProperty(f => f.KeyRotationRecommended, true));
    }

    /// <summary>Ordner, für die ein Benutzer Schlüssel hält (vor dem Löschen seiner Schlüssel aufrufen).</summary>
    public Task<List<Guid>> FoldersKeyedBy(Guid userId, Guid? tenantId = null) =>
        db.FolderKeys.Where(k => k.UserId == userId && (tenantId == null || k.Folder.TenantId == tenantId)).Select(k => k.FolderId).ToListAsync();
}
