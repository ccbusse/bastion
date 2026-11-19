using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Services;

public sealed record AssignmentInput(Guid RoleId, ScopeType ScopeType, Guid? DepartmentId, Guid? FolderId);

public sealed record InviteInput(string Email, string? Name, Guid? TenantId, bool SystemAdmin, IReadOnlyList<AssignmentInput>? Assignments);

public sealed class InvitationService(
    BastionDb db,
    AppConfig config,
    CryptoUtil crypto,
    AuditService audit,
    MailService mail,
    PermissionService perms,
    OrgService org,
    PasswordService passwords)
{
    /// <summary><paramref name="asSystem"/>: Aufruf aus der System-Administration (nur Tenant-Admins bzw. System-Admins einladbar).</summary>
    public async Task<object> Create(AuthContext actor, InviteInput input, RequestMeta meta, bool asSystem)
    {
        var isSysAdmin = actor.User.SystemRole == SystemRole.SYSTEM_ADMIN;
        Guid? tenantId = null;
        var assignments = input.Assignments ?? [];

        if (asSystem && !isSysAdmin) throw ApiException.Forbidden();
        if (input.SystemAdmin)
        {
            if (!isSysAdmin || !asSystem) throw ApiException.Forbidden();
            assignments = [];
        }
        else if (asSystem)
        {
            // Aus der System-Administration werden ausschließlich Tenant-Admins eingeladen
            tenantId = input.TenantId ?? throw ApiException.BadRequest("TENANT_REQUIRED");
            if (!await db.Tenants.AnyAsync(t => t.Id == tenantId)) throw ApiException.NotFound("TENANT_NOT_FOUND");
            var role = await org.TenantAdminRole(tenantId.Value);
            assignments = [new AssignmentInput(role.Id, ScopeType.TENANT, null, null)];
        }
        else
        {
            tenantId = actor.User.TenantId ?? throw ApiException.Forbidden();
            var ctx = await perms.ForUser(actor.User);
            ctx.Require(P.UsersInvite);
            if (actor.User.Tenant?.RecoveryPublicKey is null) throw ApiException.BadRequest("TENANT_KEYS_NOT_INITIALIZED");
            foreach (var a in assignments)
            {
                var role = await db.Roles.AsNoTracking().FirstOrDefaultAsync(r => r.Id == a.RoleId && r.TenantId == tenantId) ?? throw ApiException.NotFound("ROLE_NOT_FOUND");
                OrgService.AssertCanAssign(ctx, role.Permissions, await org.ResolveScope(tenantId.Value, new ScopeInput(a.ScopeType, a.DepartmentId, a.FolderId)));
            }
        }

        var existing = await db.Users.AsNoTracking().Where(u => u.Email == input.Email).Select(u => new { u.Id, u.TenantId }).FirstOrDefaultAsync();
        if (existing is not null)
        {
            // E-Mail-Adressen sind systemweit eindeutig. Kollisionen mit Konten außerhalb des eigenen Tenants werden protokolliert
            // (ohne Angaben zum fremden Konto), damit systematisches Ausprobieren auffällt (Enumeration über Tenant-Grenzen).
            if (!asSystem && existing.TenantId != tenantId)
                await audit.Log(new AuditEntry("user.invite_collision", TenantId: tenantId, Actor: Actor.Of(actor.User), Metadata: new { email = input.Email }, Meta: meta));
            throw ApiException.Conflict("EMAIL_EXISTS");
        }
        if (tenantId is { } tid && !await db.Tenants.AnyAsync(t => t.Id == tid)) throw ApiException.NotFound("TENANT_NOT_FOUND");

        var user = new User
        {
            Email = input.Email,
            Name = input.Name ?? "",
            Status = UserStatus.INVITED,
            TenantId = tenantId,
            SystemRole = input.SystemAdmin ? SystemRole.SYSTEM_ADMIN : SystemRole.USER,
        };
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            db.Users.Add(user);
            if (tenantId is { } t)
            {
                foreach (var a in assignments)
                {
                    var scope = await org.ResolveScope(t, new ScopeInput(a.ScopeType, a.DepartmentId, a.FolderId));
                    db.RoleAssignments.Add(new RoleAssignment
                    {
                        TenantId = t,
                        UserId = user.Id,
                        RoleId = a.RoleId,
                        ScopeType = scope.ScopeType,
                        DepartmentId = scope.DepartmentId,
                        FolderId = scope.FolderId,
                        CreatedById = actor.User.Id,
                    });
                }
            }
            await db.SaveChangesAsync();
            await tx.CommitAsync();
        }

        var (emailSent, inviteUrl) = await Issue(actor, user.Id);
        await audit.Log(new AuditEntry("user.invited",
            TenantId: tenantId,
            Actor: Actor.Of(actor.User),
            TargetType: "user",
            TargetId: user.Id.ToString(),
            Metadata: new { email = user.Email, systemAdmin = input.SystemAdmin, assignments = assignments.Count },
            Meta: meta));
        return new { userId = user.Id, emailSent, inviteUrl };
    }

    /// <summary>Erzeugt ein (neues) Einladungstoken und versendet die Mail. Alte Tokens werden widerrufen.</summary>
    public async Task<(bool EmailSent, string? InviteUrl)> Issue(AuthContext actor, Guid userId)
    {
        var user = await db.Users.AsNoTracking().Include(u => u.Tenant).FirstOrDefaultAsync(u => u.Id == userId) ?? throw ApiException.NotFound("USER_NOT_FOUND");
        if (user.Status != UserStatus.INVITED) throw ApiException.BadRequest("USER_NOT_INVITED");
        var token = CryptoUtil.RandomToken(32);
        var now = DateTime.UtcNow;
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            await db.Invitations.Where(i => i.UserId == userId && i.AcceptedAt == null && i.RevokedAt == null)
                .ExecuteUpdateAsync(u => u.SetProperty(i => i.RevokedAt, now));
            db.Invitations.Add(new Invitation
            {
                UserId = userId,
                TenantId = user.TenantId,
                TokenHash = crypto.TokenHash(token),
                InvitedById = actor.User.Id,
                ExpiresAt = now.AddHours(config.InviteValidityHours),
            });
            await db.SaveChangesAsync();
            await tx.CommitAsync();
        }
        // Token im URL-Fragment: gelangt nicht in Server-Logs oder Referrer
        var inviteUrl = $"{config.PublicUrl.TrimEnd('/')}/invite#{token}";
        var orgName = user.Tenant?.Name ?? "Bastion";
        var sender = string.IsNullOrEmpty(actor.User.Name) ? actor.User.Email : actor.User.Name;
        var emailSent = await mail.SendInvitation(user.Email, inviteUrl, orgName, sender, config.InviteValidityHours);
        // Link wird nur zurückgegeben, wenn kein Mailversand möglich war (manuelle Weitergabe)
        return (emailSent, emailSent ? null : inviteUrl);
    }

    private async Task<Invitation> FindValid(string token)
    {
        var hash = crypto.TokenHash(token);
        var inv = await db.Invitations.Include(i => i.User).Include(i => i.Tenant).FirstOrDefaultAsync(i => i.TokenHash == hash);
        if (inv is null || inv.RevokedAt is not null || inv.AcceptedAt is not null || inv.User.Status != UserStatus.INVITED) throw ApiException.NotFound("INVITATION_INVALID");
        if (inv.ExpiresAt < DateTime.UtcNow) throw ApiException.Gone("INVITATION_EXPIRED");
        return inv;
    }

    public async Task<object> Describe(string token)
    {
        var inv = await FindValid(token);
        return new
        {
            email = inv.User.Email,
            name = inv.User.Name,
            tenantId = inv.TenantId,
            tenantName = inv.Tenant?.Name,
            systemAdmin = inv.User.SystemRole == SystemRole.SYSTEM_ADMIN,
            recoveryPublicKey = inv.Tenant?.RecoveryPublicKey,
            signingPublicKey = inv.Tenant?.SigningPublicKey,
            expiresAt = inv.ExpiresAt,
        };
    }

    public async Task Accept(AcceptInvitationDto input, RequestMeta meta)
    {
        var inv = await FindValid(input.Token);
        if (inv.Tenant?.RecoveryPublicKey is not null && input.RecoveryAccountKey is null) throw ApiException.BadRequest("RECOVERY_KEY_REQUIRED");
        // Vertrauensanker: Der neue Benutzer legt die Tenant-Schlüssel aus der Einladung fest (verschlüsselt mit seinem AccountKey)
        if (inv.Tenant?.SigningPublicKey is not null && input.TrustAnchor is null) throw ApiException.BadRequest("TRUST_ANCHOR_REQUIRED");
        var user = inv.User;
        AuthService.ApplyKeys(user, input);
        user.Name = input.Name.Trim();
        user.AuthHash = await passwords.Hash(input.AuthHash);
        user.RecoveryAccountKey = inv.Tenant?.RecoveryPublicKey is not null ? input.RecoveryAccountKey : null;
        user.RecoveryVerifier = input.RecoveryVerifier;
        user.Status = UserStatus.PENDING_CONFIRMATION;
        user.PasswordChangedAt = DateTime.UtcNow;
        inv.AcceptedAt = DateTime.UtcNow;
        if (inv.TenantId is { } tid && inv.Tenant?.SigningPublicKey is not null && input.TrustAnchor is not null)
            db.TrustAnchors.Add(new TrustAnchor { UserId = inv.UserId, TenantId = tid, Data = input.TrustAnchor });
        await db.SaveChangesAsync();
        await audit.Log(new AuditEntry("user.invitation_accepted", TenantId: inv.TenantId, Actor: new Actor(inv.UserId, user.Email), TargetType: "user", TargetId: inv.UserId.ToString(), Meta: meta));
    }
}
