using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Data;

/// <summary>
/// Datenbankkontext. Löschen kaskadiert innerhalb eines Tenants (Tenant → Benutzer, Ordner, Einträge …);
/// das Audit-Log hat bewusst keine Fremdschlüssel und überlebt das Löschen von Benutzern und Tenants.
/// </summary>
public class BastionDb(DbContextOptions<BastionDb> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Tenant> Tenants => Set<Tenant>();
    public DbSet<KeyEndorsement> KeyEndorsements => Set<KeyEndorsement>();
    public DbSet<TrustAnchor> TrustAnchors => Set<TrustAnchor>();
    public DbSet<RecoveryGrant> RecoveryGrants => Set<RecoveryGrant>();
    public DbSet<TenantJoinRequest> TenantJoinRequests => Set<TenantJoinRequest>();
    public DbSet<Department> Departments => Set<Department>();
    public DbSet<Folder> Folders => Set<Folder>();
    public DbSet<FolderKey> FolderKeys => Set<FolderKey>();
    public DbSet<Item> Items => Set<Item>();
    public DbSet<Role> Roles => Set<Role>();
    public DbSet<RoleAssignment> RoleAssignments => Set<RoleAssignment>();
    public DbSet<Invitation> Invitations => Set<Invitation>();
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<SystemSetting> SystemSettings => Set<SystemSetting>();
    public DbSet<EmergencyKey> EmergencyKeys => Set<EmergencyKey>();
    public DbSet<EmergencyApproval> EmergencyApprovals => Set<EmergencyApproval>();
    public DbSet<EmergencyFolderKey> EmergencyFolderKeys => Set<EmergencyFolderKey>();
    public DbSet<EmergencyPersonalKey> EmergencyPersonalKeys => Set<EmergencyPersonalKey>();
    public DbSet<EmergencyAnchor> EmergencyAnchors => Set<EmergencyAnchor>();
    public DbSet<EmergencyTarget> EmergencyTargets => Set<EmergencyTarget>();

    /// <summary>Npgsql mit snake_case-Namen für Tabellen und Spalten.</summary>
    public static void Configure(DbContextOptionsBuilder o, string connectionString) =>
        o.UseNpgsql(connectionString).UseSnakeCaseNamingConvention();

    protected override void ConfigureConventions(ModelConfigurationBuilder b)
    {
        // Enums als Text speichern (lesbar in SQL, keine PostgreSQL-Enum-Typen nötig)
        b.Properties<SystemRole>().HaveConversion<string>();
        b.Properties<UserStatus>().HaveConversion<string>();
        b.Properties<ScopeType>().HaveConversion<string>();
        b.Properties<ItemType>().HaveConversion<string>();
        b.Properties<SessionScope>().HaveConversion<string>();
        b.Properties<SessionClient>().HaveConversion<string>();
        b.Properties<EmergencyTargetType>().HaveConversion<string>();
    }

    protected override void OnModelCreating(ModelBuilder m)
    {
        m.Entity<User>(e =>
        {
            e.HasIndex(x => x.Email).IsUnique();
            e.HasIndex(x => x.TenantId);
            e.HasOne(x => x.Tenant).WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<Tenant>(e => e.HasIndex(x => x.Slug).IsUnique());

        m.Entity<KeyEndorsement>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany(u => u.Endorsements).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<TrustAnchor>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.TenantId }).IsUnique();
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<TenantJoinRequest>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<RecoveryGrant>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<Department>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Name }).IsUnique();
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Folders).WithOne().HasForeignKey(f => f.DepartmentId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<Folder>(e =>
        {
            // Eindeutiger Name je Ebene; NULLS NOT DISTINCT, damit auch Namen auf oberster Ebene eindeutig sind
            e.HasIndex(x => new { x.DepartmentId, x.ParentId, x.Name }).IsUnique().AreNullsDistinct(false);
            e.HasIndex(x => x.ParentId);
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Folder>().WithMany().HasForeignKey(x => x.ParentId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<FolderKey>(e =>
        {
            e.HasIndex(x => new { x.FolderId, x.UserId }).IsUnique();
            e.HasOne(x => x.Folder).WithMany().HasForeignKey(x => x.FolderId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<Item>(e =>
        {
            e.Property(x => x.Id).ValueGeneratedNever();
            e.HasIndex(x => x.FolderId);
            e.HasIndex(x => x.OwnerId);
            e.HasIndex(x => x.DeletedAt);
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Folder).WithMany().HasForeignKey(x => x.FolderId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.OwnerId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<Role>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Name }).IsUnique();
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<RoleAssignment>(e =>
        {
            e.HasIndex(x => x.TenantId);
            e.HasIndex(x => x.UserId);
            // Eine Rolle je Benutzer und Geltungsbereich nur einmal (auch auf Tenant-Ebene, wo beide Bereichs-IDs null sind)
            e.HasIndex(x => new { x.UserId, x.RoleId, x.ScopeType, x.DepartmentId, x.FolderId }).IsUnique().AreNullsDistinct(false);
            e.HasOne(x => x.Tenant).WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.User).WithMany(u => u.Assignments).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Role).WithMany(r => r.Assignments).HasForeignKey(x => x.RoleId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Department>().WithMany().HasForeignKey(x => x.DepartmentId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Folder>().WithMany().HasForeignKey(x => x.FolderId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<Invitation>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Tenant).WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<Session>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.UserId);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<AuditLog>(e =>
        {
            e.Property(x => x.Id).UseIdentityAlwaysColumn();
            e.Property(x => x.Metadata).HasColumnType("jsonb");
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });
            e.HasIndex(x => x.CreatedAt);
        });
        m.Entity<SystemSetting>(e =>
        {
            e.HasKey(x => x.Key);
            e.Property(x => x.Value).HasColumnType("jsonb");
        });
        m.Entity<EmergencyKey>(e => e.Property(x => x.Id).ValueGeneratedNever());
        m.Entity<EmergencyApproval>(e =>
        {
            e.HasIndex(x => new { x.KeyId, x.TenantId }).IsUnique();
            e.HasOne<EmergencyKey>().WithMany().HasForeignKey(x => x.KeyId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<EmergencyFolderKey>(e =>
        {
            e.HasIndex(x => new { x.KeyId, x.FolderId }).IsUnique();
            e.HasOne<EmergencyKey>().WithMany().HasForeignKey(x => x.KeyId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Folder).WithMany().HasForeignKey(x => x.FolderId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<EmergencyPersonalKey>(e =>
        {
            e.HasIndex(x => new { x.KeyId, x.UserId }).IsUnique();
            e.HasOne<EmergencyKey>().WithMany().HasForeignKey(x => x.KeyId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<EmergencyAnchor>(e =>
        {
            e.HasIndex(x => new { x.KeyId, x.UserId }).IsUnique();
            e.HasOne<EmergencyKey>().WithMany().HasForeignKey(x => x.KeyId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        m.Entity<EmergencyTarget>(e => e.Property(x => x.Config).HasColumnType("jsonb"));
    }

    /// <summary>Setzt UpdatedAt bei geänderten Datensätzen (wie @updatedAt im früheren Schema).</summary>
    public override Task<int> SaveChangesAsync(CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        foreach (var entry in ChangeTracker.Entries())
        {
            if (entry.State is EntityState.Modified or EntityState.Added && entry.Metadata.FindProperty("UpdatedAt") is not null)
                entry.Property("UpdatedAt").CurrentValue = now;
        }
        return base.SaveChangesAsync(ct);
    }
}
