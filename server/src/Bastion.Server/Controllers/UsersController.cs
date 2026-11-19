using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

[Route("api/users")]
public sealed class UsersController(
    BastionDb db,
    PermissionService perms,
    AuditService audit,
    InvitationService invitations,
    PasswordService passwords,
    MailService mail,
    OrgService org,
    AuthService authService) : BastionController
{
    private sealed record Target(User User, AccessContext? Ctx);

    private static bool IsTenantAdmin(User u) =>
        u.Assignments.Any(a => a.ScopeType == ScopeType.TENANT && a.Role.Permissions.Contains(P.TenantAdmin));

    /// <summary>
    /// Lädt das Ziel und prüft, ob der Akteur es verwalten darf.
    /// - System-Admins: andere System-Admins sowie Tenant-Admins
    /// - Tenant-Benutzer: Benutzer des eigenen Tenants mit dem jeweiligen Recht; Tenant-Admins nur durch Tenant-Admins
    /// </summary>
    private async Task<Target> LoadTarget(Guid id, string perm)
    {
        var me = Auth.User;
        var target = await db.Users.AsNoTracking()
            .Include(u => u.Assignments).ThenInclude(a => a.Role)
            .Include(u => u.Tenant)
            .FirstOrDefaultAsync(u => u.Id == id);
        if (target is null || target.Status == UserStatus.SETUP_REQUIRED) throw ApiException.NotFound("USER_NOT_FOUND");
        if (target.Id == me.Id) throw ApiException.BadRequest("CANNOT_TARGET_SELF");
        var targetIsAdmin = IsTenantAdmin(target);
        var sameTenant = me.TenantId is not null && target.TenantId == me.TenantId;

        // System-Admin-Konten können nur von System-Admins verwaltet werden (Schutz vor Übernahme durch Tenant-Admins)
        if (target.SystemRole == SystemRole.SYSTEM_ADMIN)
        {
            if (me.SystemRole != SystemRole.SYSTEM_ADMIN) throw ApiException.Forbidden();
            return new Target(target, null);
        }
        // System-Admins verwalten fremde Tenants nur auf Ebene der Tenant-Admins; im eigenen Tenant gelten die Tenant-Rechte
        if (me.SystemRole == SystemRole.SYSTEM_ADMIN && !sameTenant)
        {
            if (targetIsAdmin) return new Target(target, null);
            throw ApiException.Forbidden();
        }
        if (!sameTenant) throw ApiException.NotFound("USER_NOT_FOUND");
        var ctx = await perms.ForUser(me);
        ctx.Require(perm);
        if (targetIsAdmin && !ctx.IsTenantAdmin) throw ApiException.Forbidden();
        return new Target(target, ctx);
    }

    private Task Log(string action, User target, object? metadata = null) =>
        audit.Log(new AuditEntry(action, TenantId: target.TenantId, Actor: Actor.Of(Auth.User), TargetType: "user", TargetId: target.Id.ToString(), Metadata: metadata, Meta: Meta));

    [HttpGet]
    public async Task<object> List()
    {
        if (Auth.User.TenantId is not { } tenantId) throw ApiException.Forbidden();
        var ctx = await perms.ForUser(Auth.User);
        var canSeeAll = new[] { P.UsersInvite, P.UsersConfirm, P.UsersManage, P.RolesManage }.Any(ctx.Has);
        if (!canSeeAll) throw ApiException.Forbidden();
        var users = await PermissionService.TenantMembers(db.Users.AsNoTracking(), tenantId)
            .Include(u => u.Assignments.Where(a => a.TenantId == tenantId)).ThenInclude(a => a.Role)
            .Include(u => u.Endorsements.Where(e => e.TenantId == tenantId))
            .OrderBy(u => u.Email)
            .AsSplitQuery()
            .ToListAsync();
        return users.Select(u => UserView.Of(u, withAssignments: true, endorsed: u.Endorsements.Count > 0)).ToList();
    }

    /// <summary>Aktive Benutzer des Tenants (für Freigaben durch Manager).</summary>
    [HttpGet("directory")]
    public async Task<object> Directory()
    {
        if (Auth.User.TenantId is not { } tenantId) return Array.Empty<object>();
        return await PermissionService.TenantMembers(db.Users.AsNoTracking(), tenantId)
            .Where(u => u.Status == UserStatus.ACTIVE)
            .OrderBy(u => u.Name)
            .Select(u => new { u.Id, u.Name, u.Email })
            .ToListAsync();
    }

    // Begrenzt systematisches Ausprobieren von E-Mail-Adressen; reicht für normales Einladen auch größerer Teams
    [Ok200, Throttle(60, 600), HttpPost("invite")]
    public Task<object> Invite(InviteUserDto body) =>
        invitations.Create(Auth, new InviteInput(
            Normalize.Email(body.Email),
            body.Name?.Trim(),
            null,
            false,
            body.Assignments?.Select(a => new AssignmentInput(a.RoleId, a.ScopeType, a.DepartmentId, a.FolderId)).ToList()), Meta, asSystem: false);

    [HttpPatch("{id}")]
    public async Task<object> Update(Guid id, UserNameDto body)
    {
        var t = await LoadTarget(id, P.UsersManage);
        var name = body.Name.Trim();
        await db.Users.Where(u => u.Id == t.User.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.Name, name).SetProperty(x => x.UpdatedAt, DateTime.UtcNow));
        await Log("user.updated", t.User, new { name });
        return OkResult;
    }

    [Ok200, HttpPost("{id}/resend-invite")]
    public async Task<object> Resend(Guid id)
    {
        var t = await LoadTarget(id, P.UsersInvite);
        var (emailSent, inviteUrl) = await invitations.Issue(Auth, t.User.Id);
        await Log("user.invitation_resent", t.User);
        return new { emailSent, inviteUrl };
    }

    /// <summary>Bestätigung der Zugehörigkeit. Der Admin muss den Fingerprint des Schlüssels mit dem Benutzer abgleichen.</summary>
    [Ok200, HttpPost("{id}/confirm")]
    public async Task<object> Confirm(Guid id, FingerprintDto body)
    {
        var t = await LoadTarget(id, P.UsersConfirm);
        var target = t.User;
        if (target.Status != UserStatus.PENDING_CONFIRMATION || target.PublicKey is null) throw ApiException.BadRequest("USER_NOT_PENDING");
        if (CryptoUtil.PublicKeyFingerprint(target.PublicKey) != body.Fingerprint.ToUpperInvariant().Trim()) throw ApiException.BadRequest("FINGERPRINT_MISMATCH");
        var me = Auth.User;
        var now = DateTime.UtcNow;
        await db.Users.Where(u => u.Id == target.Id).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Status, UserStatus.ACTIVE)
            .SetProperty(x => x.ConfirmedAt, now)
            .SetProperty(x => x.ConfirmedById, me.Id)
            .SetProperty(x => x.UpdatedAt, now));
        await Log("user.confirmed", target, new { email = target.Email, fingerprint = body.Fingerprint });
        // Bestätigt ein System-Admin von außen einen Tenant-Admin, erfahren die bestehenden Tenant-Admins davon
        if (me.SystemRole == SystemRole.SYSTEM_ADMIN && target.TenantId is { } tid && tid != me.TenantId)
        {
            await org.NotifyTenantAdmins(tid, new MailEvent(
                $"Der System-Admin {me.Email} hat {target.Email} als Tenant-Admin bestätigt. Schlüssel erhält das Konto erst nach Ihrer Beglaubigung.",
                $"System admin {me.Email} confirmed {target.Email} as tenant admin. The account receives keys only after your endorsement."),
                [target.Id, me.Id]);
        }
        return OkResult;
    }

    /// <summary>
    /// Beglaubigung des öffentlichen Schlüssels durch einen Tenant-Admin (nach Fingerprint-Abgleich).
    /// Erst danach verteilen die Clients Ordner- und Recovery-Schlüssel an den Benutzer. Gilt auch für System-Admins,
    /// die dem Tenant beigetreten sind: Ohne Zustimmung eines Tenant-Admins erhalten sie keine Schlüssel.
    /// </summary>
    [Ok200, HttpPost("{id}/endorse")]
    public async Task<object> Endorse(Guid id, SignatureDto body)
    {
        var me = Auth.User;
        var tenant = me.Tenant;
        if (tenant?.SigningPublicKey is null) throw ApiException.BadRequest("TENANT_KEYS_NOT_INITIALIZED");
        if (!(await perms.ForUser(me)).IsTenantAdmin) throw ApiException.Forbidden();
        if (id == me.Id) throw ApiException.BadRequest("CANNOT_TARGET_SELF");
        var target = await PermissionService.TenantMembers(db.Users.AsNoTracking(), tenant.Id)
            .FirstOrDefaultAsync(u => u.Id == id && (u.Status == UserStatus.ACTIVE || u.Status == UserStatus.PENDING_CONFIRMATION));
        if (target?.PublicKey is null) throw ApiException.NotFound("USER_NOT_FOUND");
        if (!Endorsement.Verify(tenant.SigningPublicKey, tenant.Id, target.Id, target.PublicKey, body.Signature)) throw ApiException.BadRequest("INVALID_ENDORSEMENT");
        var existing = await db.KeyEndorsements.FirstOrDefaultAsync(e => e.TenantId == tenant.Id && e.UserId == target.Id);
        if (existing is null) db.KeyEndorsements.Add(new KeyEndorsement { TenantId = tenant.Id, UserId = target.Id, Signature = body.Signature, SignedById = me.Id });
        else
        {
            existing.Signature = body.Signature;
            existing.SignedById = me.Id;
        }
        await db.SaveChangesAsync();
        await audit.Log(new AuditEntry("keys.endorsed",
            TenantId: tenant.Id,
            Actor: Actor.Of(me),
            TargetType: "user",
            TargetId: target.Id.ToString(),
            Metadata: new { email = target.Email, fingerprint = CryptoUtil.PublicKeyFingerprint(target.PublicKey), systemAdmin = target.SystemRole == SystemRole.SYSTEM_ADMIN },
            Meta: Meta));
        return OkResult;
    }

    [Ok200, HttpPost("{id}/disable")]
    public async Task<object> Disable(Guid id)
    {
        var target = (await LoadTarget(id, P.UsersManage)).User;
        if (target.TenantId is { } tid) await org.AssertNotLastAdmin(tid, target.Id);
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            await db.Users.Where(u => u.Id == target.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.Status, UserStatus.DISABLED).SetProperty(x => x.UpdatedAt, DateTime.UtcNow));
            await db.Sessions.Where(s => s.UserId == target.Id).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        if (target.TenantId is { } t) await perms.PruneKeys(t);
        await Log("user.disabled", target, new { email = target.Email });
        return OkResult;
    }

    [Ok200, HttpPost("{id}/enable")]
    public async Task<object> Enable(Guid id)
    {
        var target = (await LoadTarget(id, P.UsersManage)).User;
        if (target.Status != UserStatus.DISABLED) throw ApiException.BadRequest("USER_NOT_DISABLED");
        var status = target.ConfirmedAt is not null ? UserStatus.ACTIVE : target.AuthHash is not null ? UserStatus.PENDING_CONFIRMATION : UserStatus.INVITED;
        await db.Users.Where(u => u.Id == target.Id).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Status, status)
            .SetProperty(x => x.FailedLogins, 0)
            .SetProperty(x => x.LockedUntil, (DateTime?)null)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow));
        await Log("user.enabled", target, new { email = target.Email });
        return OkResult;
    }

    [Ok200, HttpPost("{id}/unlock")]
    public async Task<object> Unlock(Guid id)
    {
        var target = (await LoadTarget(id, P.UsersManage)).User;
        await db.Users.Where(u => u.Id == target.Id).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.FailedLogins, 0)
            .SetProperty(x => x.LockedUntil, (DateTime?)null)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow));
        await Log("user.unlocked", target);
        return OkResult;
    }

    [HttpDelete("{id}")]
    public async Task<object> Remove(Guid id)
    {
        var target = (await LoadTarget(id, P.UsersManage)).User;
        if (target.TenantId is { } tid) await org.AssertNotLastAdmin(tid, target.Id);
        // Seine Ordnerschlüssel verschwinden mit dem Konto; die Ordner zur Schlüsselerneuerung vormerken
        var keyedFolders = await perms.FoldersKeyedBy(target.Id);
        await db.Users.Where(u => u.Id == target.Id).ExecuteDeleteAsync();
        await perms.RecommendRotation(keyedFolders);
        if (target.TenantId is { } t) await perms.PruneKeys(t);
        await Log("user.deleted", target, new { email = target.Email });
        return OkResult;
    }

    [Ok200, HttpPost("{id}/reset-mfa")]
    public async Task<object> ResetMfa(Guid id, AuthHashDto body)
    {
        var target = (await LoadTarget(id, P.TenantAdmin)).User;
        var me = Auth.User;
        // Erneute Prüfung des eigenen Masterpassworts: eine übernommene Sitzung allein reicht nicht
        await authService.VerifyAuthHash(me, body.AuthHash, Meta);
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            await db.Users.Where(u => u.Id == target.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.TotpEnabled, false)
                .SetProperty(x => x.TotpSecretEnc, (string?)null)
                .SetProperty(x => x.TotpLastStep, (long?)null)
                .SetProperty(x => x.MfaRecoveryCodes, new List<string>())
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow));
            await db.Sessions.Where(s => s.UserId == target.Id).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        await Log("user.mfa_reset", target);
        // Betroffenen informieren; greift ein System-Admin in einen Tenant ein, zusätzlich alle Tenant-Admins
        var isSys = me.SystemRole == SystemRole.SYSTEM_ADMIN;
        var by = isSys ? $"dem System-Admin {me.Email}" : me.Email;
        var byEn = isSys ? $"system admin {me.Email}" : me.Email;
        await mail.SendTenantAdminNotice(target.Email, target.Tenant?.Name ?? "Bastion", new MailEvent(
            $"Die Zwei-Faktor-Anmeldung (2FA) Ihres Kontos {target.Email} wurde von {by} zurückgesetzt, alle Sitzungen wurden beendet.",
            $"Two-factor authentication (2FA) for your account {target.Email} was reset by {byEn}; all sessions were ended."));
        if (isSys && target.TenantId is { } tid)
        {
            await org.NotifyTenantAdmins(tid, new MailEvent(
                $"Der System-Admin {me.Email} hat die 2FA von {target.Email} zurückgesetzt.",
                $"System admin {me.Email} reset 2FA of {target.Email}."),
                [target.Id, me.Id]);
        }
        return OkResult;
    }

    // ---------- Kontowiederherstellung (nur Tenant-Admins) ----------

    [HttpGet("{id}/recovery")]
    public async Task<object> RecoveryData(Guid id)
    {
        var t = await LoadTarget(id, P.TenantAdmin);
        if (t.Ctx is null) throw ApiException.Forbidden();
        if (t.User.RecoveryAccountKey is null) throw ApiException.BadRequest("NO_RECOVERY_KEY");
        return new { recoveryAccountKey = t.User.RecoveryAccountKey };
    }

    /// <summary>
    /// Setzt ein temporäres Masterpasswort. Der Admin entschlüsselt dazu clientseitig den AccountKey
    /// mit dem Tenant-Recovery-Key. Der persönliche Tresor ist nicht wiederherstellbar und wird geleert.
    /// </summary>
    [Ok200, HttpPost("{id}/recover")]
    public async Task<object> Recover(Guid id, RecoverDto input)
    {
        var t = await LoadTarget(id, P.TenantAdmin);
        if (t.Ctx is null) throw ApiException.Forbidden();
        var target = t.User;
        if (target.RecoveryAccountKey is null || target.Status is not (UserStatus.ACTIVE or UserStatus.PENDING_CONFIRMATION)) throw ApiException.BadRequest("NO_RECOVERY_KEY");
        // Nachweis, dass der Admin den AccountKey tatsächlich mit dem Recovery-Schlüssel entschlüsselt hat.
        // Ohne ihn könnte jeder Tenant-Admin das Konto übernehmen und den persönlichen Tresor löschen.
        if (target.RecoveryVerifier is null) throw ApiException.BadRequest("RECOVERY_VERIFIER_MISSING");
        if (!CryptoUtil.SafeEqual(CryptoUtil.Sha256Hex(Convert.FromBase64String(input.RecoveryProof)), target.RecoveryVerifier)) throw ApiException.Forbidden("INVALID_RECOVERY_PROOF");
        var hash = await passwords.Hash(input.AuthHash);
        int deleted;
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            deleted = await db.Items.Where(i => i.OwnerId == target.Id).ExecuteDeleteAsync();
            await db.Users.Where(u => u.Id == target.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.AuthHash, hash)
                .SetProperty(x => x.KdfSalt, input.KdfSalt)
                .SetProperty(x => x.KdfMemory, input.KdfMemory)
                .SetProperty(x => x.KdfIterations, input.KdfIterations)
                .SetProperty(x => x.KdfParallelism, input.KdfParallelism)
                .SetProperty(x => x.ProtectedAccountKey, input.ProtectedAccountKey)
                .SetProperty(x => x.ProtectedPersonalKey, input.ProtectedPersonalKey)
                .SetProperty(x => x.ForcePasswordChange, true)
                .SetProperty(x => x.FailedLogins, 0)
                .SetProperty(x => x.LockedUntil, (DateTime?)null)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow));
            await db.Sessions.Where(s => s.UserId == target.Id).ExecuteDeleteAsync();
            // Neuer persönlicher Schlüssel: altes Notfall-Schlüsselpaket ist wertlos, der Browser des Benutzers erstellt ein neues
            await db.EmergencyPersonalKeys.Where(p => p.UserId == target.Id).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        await Log("user.recovered", target, new { email = target.Email, personalItemsDeleted = deleted });
        await mail.SendPasswordReset(target.Email, target.Tenant?.Name ?? "Bastion");
        return new { ok = true, personalItemsDeleted = deleted };
    }
}
