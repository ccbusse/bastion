using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

/// <summary>Nur aktive System-Admins (läuft nach dem globalen SessionGuard).</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class SystemAdminOnlyAttribute : Attribute, IAuthorizationFilter
{
    public void OnAuthorization(AuthorizationFilterContext ctx)
    {
        var user = ctx.HttpContext.Auth().User;
        if (user.SystemRole != SystemRole.SYSTEM_ADMIN || user.Status != UserStatus.ACTIVE) throw ApiException.Forbidden();
    }
}

/// <summary>System-Administration: Tenants, System-Admins, SMTP, globale Einstellungen, globales Audit-Log.</summary>
[Route("api/system")]
[SystemAdminOnly]
public sealed partial class SystemController(
    BastionDb db,
    AuditService audit,
    InvitationService invitations,
    OrgService org,
    SettingsService settings,
    MailService mail,
    PermissionService perms) : BastionController
{
    // ---------- Tenants ----------

    [HttpGet("tenants")]
    public async Task<object> Tenants()
    {
        var me = Auth.User.Id;
        var now = DateTime.UtcNow;
        var tenants = await db.Tenants.AsNoTracking()
            .OrderBy(t => t.Name)
            .Select(t => new
            {
                t.Id,
                t.Name,
                t.Slug,
                t.RequireMfa,
                t.RequireJoinApproval,
                // Eigene offene Beitrittsanfrage (gültig bis)
                JoinRequestedUntil = db.TenantJoinRequests.Where(r => r.TenantId == t.Id && r.UserId == me && r.ExpiresAt > now).Select(r => (DateTime?)r.ExpiresAt).FirstOrDefault(),
                t.SigningPublicKey,
                t.ProtectedSigningPrivateKey,
                t.CreatedAt,
                t.UpdatedAt,
                KeysInitialized = t.RecoveryPublicKey != null,
                Counts = new
                {
                    Users = db.Users.Count(u => u.TenantId == t.Id),
                    Departments = db.Departments.Count(d => d.TenantId == t.Id),
                    Folders = db.Folders.Count(f => f.TenantId == t.Id),
                    Items = db.Items.Count(i => i.TenantId == t.Id),
                },
            })
            .ToListAsync();
        return tenants;
    }

    [HttpPost("tenants")]
    public async Task<object> CreateTenant(CreateTenantDto body)
    {
        // Selbst Tenant-Admin werden ist ein Beitritt (siehe Join)
        if (body.AddSelfAsAdmin) RequireRecentAuthAttribute.Assert(Auth);
        var slug = body.NormalizedSlug;
        var adminEmail = body.AdminEmail is null ? null : Normalize.Email(body.AdminEmail);
        if (await db.Tenants.AnyAsync(t => t.Slug == slug)) throw ApiException.Conflict("SLUG_EXISTS");
        if (adminEmail is not null && await db.Users.AnyAsync(u => u.Email == adminEmail)) throw ApiException.Conflict("EMAIL_EXISTS");
        var tenant = new Tenant { Name = body.Name.Trim(), Slug = slug, RequireMfa = body.RequireMfa };
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            db.Tenants.Add(tenant);
            org.AddBuiltinRoles(tenant.Id);
            await db.SaveChangesAsync();
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("tenant.created", TenantId: tenant.Id, Actor: Actor.Of(Auth.User), TargetType: "tenant", TargetId: tenant.Id.ToString(),
            Metadata: new { name = tenant.Name, slug = tenant.Slug }, Meta: Meta));
        if (body.AddSelfAsAdmin) await JoinTenant(tenant.Id);
        var invite = adminEmail is not null
            ? await invitations.Create(Auth, new InviteInput(adminEmail, body.AdminName?.Trim(), tenant.Id, false, null), Meta, true)
            : null;
        return new
        {
            tenant = new
            {
                tenant.Id,
                tenant.Name,
                tenant.Slug,
                tenant.RequireMfa,
                tenant.RecoveryPublicKey,
                tenant.ProtectedRecoveryPrivateKey,
                tenant.SigningPublicKey,
                tenant.ProtectedSigningPrivateKey,
                tenant.CreatedAt,
                tenant.UpdatedAt,
            },
            invite,
        };
    }

    [HttpPatch("tenants/{id}")]
    public async Task<object> UpdateTenant(Guid id, UpdateTenantDto body)
    {
        var tenant = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id) ?? throw ApiException.NotFound("TENANT_NOT_FOUND");
        var name = body.Name?.Trim();
        if (name is not null) tenant.Name = name;
        if (body.RequireMfa is { } r) tenant.RequireMfa = r;
        await db.SaveChangesAsync();
        await audit.Log(new AuditEntry("tenant.updated", TenantId: id, Actor: Actor.Of(Auth.User), TargetType: "tenant", TargetId: id.ToString(),
            Metadata: new { name, requireMfa = body.RequireMfa }, Meta: Meta));
        return OkResult;
    }

    [RequireRecentAuth, HttpDelete("tenants/{id}")]
    public async Task<object> DeleteTenant(Guid id, [FromQuery] string? confirm)
    {
        var tenant = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id) ?? throw ApiException.NotFound("TENANT_NOT_FOUND");
        if (confirm != tenant.Slug) throw ApiException.BadRequest("CONFIRMATION_MISMATCH");
        // System-Admin-Konten werden nur vom Tenant gelöst, nicht mitgelöscht
        var activeHere = await db.Users.Where(u => u.TenantId == id && u.SystemRole == SystemRole.SYSTEM_ADMIN).Select(u => u.Id).ToListAsync();
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            await db.Users.Where(u => u.TenantId == id && u.SystemRole == SystemRole.SYSTEM_ADMIN).ExecuteUpdateAsync(u => u.SetProperty(x => x.TenantId, (Guid?)null));
            await db.Tenants.Where(t => t.Id == id).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        // Betroffene System-Admins wechseln in einen anderen ihrer Tenants
        foreach (var userId in activeHere) await SwitchTo(userId, (await org.SysadminTenantIds(userId)).Cast<Guid?>().FirstOrDefault());
        await audit.Log(new AuditEntry("tenant.deleted", TenantId: id, Actor: Actor.Of(Auth.User), TargetType: "tenant", TargetId: id.ToString(),
            Metadata: new { name = tenant.Name, slug = tenant.Slug }, Meta: Meta));
        await org.NotifySystemAdmins(new MailEvent(
            $"Der System-Admin {Auth.User.Email} hat den Tenant „{tenant.Name}“ ({tenant.Slug}) mit allen Daten gelöscht.",
            $"System admin {Auth.User.Email} deleted the tenant \"{tenant.Name}\" ({tenant.Slug}) including all data."), Auth.User.Id);
        return OkResult;
    }

    [HttpGet("tenants/{id}/users")]
    public async Task<object> TenantUsers(Guid id)
    {
        var users = await db.Users.AsNoTracking()
            .Include(u => u.Assignments).ThenInclude(a => a.Role)
            .Where(u => u.TenantId == id)
            .OrderBy(u => u.Email)
            .ToListAsync();
        // System-Admins sehen nur Basisdaten; verwalten können sie ausschließlich Tenant-Admins
        return users.Select(u =>
        {
            var v = JsonSerializer.SerializeToNode(UserView.Of(u, withAssignments: true), Json.Options)!.AsObject();
            v.Remove("assignments");
            v.Remove("endorsed");
            return v;
        }).ToList();
    }

    [RequireRecentAuth, HttpPost("tenants/{id}/admins")]
    public async Task<object> InviteTenantAdmin(Guid id, InviteAdminDto body)
    {
        var email = Normalize.Email(body.Email);
        var result = await invitations.Create(Auth, new InviteInput(email, body.Name?.Trim(), id, false, null), Meta, true);
        await org.NotifyTenantAdmins(id, new MailEvent(
            $"Der System-Admin {Auth.User.Email} hat {email} als weiteren Tenant-Admin eingeladen.",
            $"System admin {Auth.User.Email} invited {email} as an additional tenant admin."), [Auth.User.Id]);
        return result;
    }

    // ---------- Eigene Tenant-Mitgliedschaft des System-Admins ----------

    /// <summary>
    /// Der System-Admin wird Tenant-Admin eines (weiteren) Tenants und wechselt in diesen. Die Ordnerschlüssel erhält er Zero-Knowledge-konform
    /// erst, wenn ein bestehender Tenant-Admin sie in seinem Browser für ihn verschlüsselt. Der Vorgang wird protokolliert.
    /// Verlangt der Tenant eine Zustimmung (Standard), entsteht nur eine Beitrittsanfrage, die ein Tenant-Admin annehmen muss.
    /// Ohne aktiven Tenant-Admin (z. B. neuer Tenant, dessen Admin die Einladung noch nicht angenommen hat) ist niemand da,
    /// der zustimmen könnte: Dann tritt der System-Admin direkt bei, die Tenant-Admins werden wie bisher informiert.
    /// </summary>
    [RequireRecentAuth, Ok200, HttpPost("tenants/{id}/join")]
    public async Task<object> Join(Guid id)
    {
        var tenant = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id) ?? throw ApiException.NotFound("TENANT_NOT_FOUND");
        var user = Auth.User;
        if ((await org.SysadminTenantIds(user.Id)).Contains(id)) throw ApiException.BadRequest("ALREADY_IN_TENANT");
        var admins = (await org.ActiveTenantAdminIds(id)).Where(a => a != user.Id).ToList();
        if (!tenant.RequireJoinApproval || admins.Count == 0)
        {
            await JoinTenant(id);
            return new { ok = true, joined = true, requested = false };
        }

        // Neue Anfrage ersetzt eine frühere (auch eine abgelaufene); die Frist beginnt neu
        var now = DateTime.UtcNow;
        var expiresAt = now + TenantJoinRequest.Lifetime;
        await db.TenantJoinRequests.Where(r => r.TenantId == id && r.UserId == user.Id).ExecuteDeleteAsync();
        db.TenantJoinRequests.Add(new TenantJoinRequest { TenantId = id, UserId = user.Id, CreatedAt = now, ExpiresAt = expiresAt });
        await db.SaveChangesAsync();
        await audit.Log(new AuditEntry("tenant.sysadmin_join_requested", TenantId: id, Actor: Actor.Of(user), TargetType: "user", TargetId: user.Id.ToString(),
            Metadata: new { expiresAt }, Meta: Meta));
        await org.NotifyTenantAdmins(id, new MailEvent(
            $"Der System-Admin {user.Email} möchte Ihrem Tenant als Tenant-Admin beitreten. Ein Tenant-Admin kann die Anfrage in Bastion unter „Einstellungen“ annehmen oder ablehnen. Ohne Antwort verfällt sie am {expiresAt:dd.MM.yyyy} (UTC). Lehnen Sie ab, wenn Sie die Anfrage nicht erwartet haben.",
            $"System admin {user.Email} asks to join your tenant as tenant admin. A tenant admin can approve or reject the request in Bastion under \"Settings\". Without an answer it expires on {expiresAt:yyyy-MM-dd} (UTC). Reject it if you did not expect it."), [user.Id]);
        return new { ok = true, joined = false, requested = true, expiresAt };
    }

    /// <summary>Zieht die eigene offene Beitrittsanfrage zurück.</summary>
    [HttpDelete("tenants/{id}/join")]
    public async Task<object> CancelJoinRequest(Guid id)
    {
        var removed = await db.TenantJoinRequests.Where(r => r.TenantId == id && r.UserId == Auth.User.Id).ExecuteDeleteAsync();
        if (removed == 0) throw ApiException.NotFound("JOIN_REQUEST_NOT_FOUND");
        await audit.Log(new AuditEntry("tenant.sysadmin_join_cancelled", TenantId: id, Actor: Actor.Of(Auth.User), TargetType: "user", TargetId: Auth.User.Id.ToString(), Meta: Meta));
        return OkResult;
    }

    /// <summary>Wechselt den aktiven Tenant (nur Tenants, in denen der System-Admin Mitglied ist).</summary>
    [AllowExtension, Ok200, HttpPost("tenants/{id}/switch")]
    public async Task<object> SwitchTenant(Guid id)
    {
        if (!(await org.SysadminTenantIds(Auth.User.Id)).Contains(id)) throw ApiException.BadRequest("NOT_TENANT_MEMBER");
        if (Auth.User.TenantId != id)
        {
            var from = Auth.User.TenantId;
            await SwitchTo(Auth.User.Id, id);
            await audit.Log(new AuditEntry("tenant.sysadmin_switched", TenantId: id, Actor: Actor.Of(Auth.User), TargetType: "user", TargetId: Auth.User.Id.ToString(),
                Metadata: new { from }, Meta: Meta));
        }
        return OkResult;
    }

    private async Task SwitchTo(Guid userId, Guid? tenantId)
    {
        var now = DateTime.UtcNow;
        await db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(u => u.SetProperty(x => x.TenantId, tenantId).SetProperty(x => x.UpdatedAt, now));
    }

    private async Task JoinTenant(Guid tenantId)
    {
        var user = Auth.User;
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            await SwitchTo(user.Id, tenantId);
            await org.AddTenantAdmin(tenantId, user.Id, user.Id);
            await db.TenantJoinRequests.Where(r => r.TenantId == tenantId && r.UserId == user.Id).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("tenant.sysadmin_joined", TenantId: tenantId, Actor: Actor.Of(user), TargetType: "user", TargetId: user.Id.ToString(), Meta: Meta));
        await org.NotifyTenantAdmins(tenantId, new MailEvent(
            $"Der System-Admin {user.Email} ist Ihrem Tenant als Tenant-Admin beigetreten. Schlüssel erhält er erst, wenn ein Tenant-Admin seinen Schlüssel beglaubigt.",
            $"System admin {user.Email} joined your tenant as tenant admin. They receive keys only after a tenant admin endorses their key."), [user.Id]);
    }

    [Ok200, HttpPost("tenants/{id}/leave")]
    public async Task<object> Leave(Guid id)
    {
        var user = Auth.User;
        if (!(await org.SysadminTenantIds(user.Id)).Contains(id)) throw ApiException.BadRequest("NOT_TENANT_MEMBER");
        await org.AssertNotLastAdmin(id, user.Id);
        var keyedFolders = await perms.FoldersKeyedBy(user.Id, id);
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            await db.RoleAssignments.Where(a => a.TenantId == id && a.UserId == user.Id).ExecuteDeleteAsync();
            await db.FolderKeys.Where(k => k.UserId == user.Id && k.Folder.TenantId == id).ExecuteDeleteAsync();
            await db.RecoveryGrants.Where(g => g.TenantId == id && g.UserId == user.Id).ExecuteDeleteAsync();
            // Bei erneutem Beitritt ist wieder die Zustimmung eines Tenant-Admins nötig
            await db.KeyEndorsements.Where(e => e.TenantId == id && e.UserId == user.Id).ExecuteDeleteAsync();
            await db.TrustAnchors.Where(a => a.TenantId == id && a.UserId == user.Id).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        await perms.RecommendRotation(keyedFolders);
        // War es der aktive Tenant, in einen anderen eigenen Tenant wechseln
        if (user.TenantId == id) await SwitchTo(user.Id, (await org.SysadminTenantIds(user.Id)).Cast<Guid?>().FirstOrDefault());
        await perms.PruneKeys(id);
        await audit.Log(new AuditEntry("tenant.sysadmin_left", TenantId: id, Actor: Actor.Of(user), TargetType: "user", TargetId: user.Id.ToString(), Meta: Meta));
        return OkResult;
    }

    // ---------- System-Admins ----------

    [HttpGet("admins")]
    public async Task<object> Admins()
    {
        var users = await db.Users.AsNoTracking()
            .Where(u => u.SystemRole == SystemRole.SYSTEM_ADMIN && u.Status != UserStatus.SETUP_REQUIRED)
            .OrderBy(u => u.Email)
            .ToListAsync();
        return users.Select(u => UserView.Of(u)).ToList();
    }

    /// <summary>Neuer System-Admin bedeutet dauerhaften Systemzugang: erneute Passworteingabe und Hinweis an alle anderen System-Admins.</summary>
    [RequireRecentAuth, HttpPost("admins")]
    public async Task<object> InviteSystemAdmin(InviteAdminDto body)
    {
        var email = Normalize.Email(body.Email);
        var result = await invitations.Create(Auth, new InviteInput(email, body.Name?.Trim(), null, true, null), Meta, true);
        await org.NotifySystemAdmins(new MailEvent(
            $"Der System-Admin {Auth.User.Email} hat {email} als weiteren System-Admin eingeladen.",
            $"System admin {Auth.User.Email} invited {email} as an additional system admin."), Auth.User.Id);
        return result;
    }

    // ---------- Einstellungen ----------

    [HttpGet("settings")]
    public Task<SystemSettings> GetSettings() => settings.GetSystem();

    [RequireRecentAuth, HttpPut("settings")]
    public async Task<object> PutSettings(SystemSettingsDto body)
    {
        var mfaRequiredBefore = (await settings.GetSystem()).RequireMfaForSystemAdmins;
        var value = await settings.SetSystem(body.RequireMfaForSystemAdmins, body.AutoLockMinutes, body.ExtensionAutoLockMinutes);
        await audit.Log(new AuditEntry("system.settings_updated", Actor: Actor.Of(Auth.User),
            Metadata: new { requireMfaForSystemAdmins = body.RequireMfaForSystemAdmins, autoLockMinutes = body.AutoLockMinutes, extensionAutoLockMinutes = body.ExtensionAutoLockMinutes }, Meta: Meta));
        if (mfaRequiredBefore && body.RequireMfaForSystemAdmins == false)
            await org.NotifySystemAdmins(new MailEvent(
                $"Der System-Admin {Auth.User.Email} hat die 2FA-Pflicht für System-Admins abgeschaltet.",
                $"System admin {Auth.User.Email} turned off mandatory two-factor authentication for system admins."), Auth.User.Id);
        return value;
    }

    [HttpGet("smtp")]
    public Task<object?> GetSmtp() => settings.GetSmtpPublic();

    [RequireRecentAuth, HttpPut("smtp")]
    public async Task<object> PutSmtp(SmtpDto body)
    {
        var host = body.Host.Trim();
        var fromName = body.FromName.Trim();
        // Zugangsdaten nie unverschlüsselt übertragen: Anmeldung am SMTP-Server nur mit TLS bzw. STARTTLS
        if (body.Security == "none" && body.Username.Length > 0) throw ApiException.BadRequest("SMTP_AUTH_REQUIRES_TLS");
        // Kein SMTP-Server auf dem Bastion-Server selbst bzw. in seinen internen Netzen (SSRF-Schutz)
        if (host.Length > 0)
        {
            try { await NetGuard.AssertAllowedHost(host); }
            catch (BlockedDestinationException) { throw ApiException.BadRequest("SMTP_HOST_NOT_ALLOWED"); }
        }
        var password = body.PasswordProvided ? Optional<string?>.Of(body.Password) : Optional<string?>.None;
        await settings.SetSmtp(new SmtpInput(host, body.Port, body.Security, body.Username, Normalize.Email(body.FromAddress), fromName, password));
        await audit.Log(new AuditEntry("system.smtp_updated", Actor: Actor.Of(Auth.User),
            Metadata: new { host, port = body.Port, security = body.Security, username = body.Username, passwordChanged = body.PasswordProvided }, Meta: Meta));
        var server = host.Length > 0 ? $"{host}:{body.Port}" : "–";
        var account = body.Username.Length > 0 ? body.Username : "–";
        await org.NotifySystemAdmins(new MailEvent(
            $"Der System-Admin {Auth.User.Email} hat die SMTP-Einstellungen geändert (Server {server}, Benutzer {account}).",
            $"System admin {Auth.User.Email} changed the SMTP settings (server {server}, user {account})."), Auth.User.Id);
        return OkResult;
    }

    [Ok200, HttpPost("smtp/test")]
    public async Task<object> TestSmtp(SmtpTestDto body)
    {
        var to = Normalize.Email(body.To);
        var (ok, error) = await mail.SendTest(to);
        await audit.Log(new AuditEntry("system.smtp_tested", Actor: Actor.Of(Auth.User), Metadata: new { to, ok }, Meta: Meta));
        return new { ok, error };
    }

    // ---------- Audit ----------

    [GeneratedRegex("^[0-9]+$")]
    private static partial Regex Digits();

    [GeneratedRegex("^[0-9]{1,19}$")]
    private static partial Regex AnchorIdPattern();

    [HttpGet("audit")]
    public async Task<object> List([FromQuery] string? before, [FromQuery] string? action, [FromQuery] string? tenantId)
    {
        if (before is not null && !Digits().IsMatch(before)) throw QueryValidation.Failed("before", "invalid format");
        if (action is { Length: > 60 }) throw QueryValidation.Failed("action", "too long");
        var filterTenant = tenantId is not null;
        Guid? tid = null;
        if (tenantId is not null && tenantId != "system")
        {
            if (!Guid.TryParseExact(tenantId, "D", out var g)) throw QueryValidation.Failed("tenantId", "invalid uuid");
            tid = g;
        }
        return await audit.List(tid, filterTenant, action, before, null);
    }

    [HttpGet("audit/verify")]
    public async Task<object> Verify([FromQuery] string? anchorId, [FromQuery] string? anchorHash)
    {
        // Optionaler Anker: früher notierter Kettenkopf (Server-Log, Notfall-Backup); muss unverändert in der Kette stehen
        if (anchorId is not null && !AnchorIdPattern().IsMatch(anchorId)) throw QueryValidation.Failed("anchorId", "invalid format");
        if (anchorHash is { Length: > 80 }) throw QueryValidation.Failed("anchorHash", "too long");
        var useAnchor = !string.IsNullOrEmpty(anchorId) && !string.IsNullOrEmpty(anchorHash);
        var result = useAnchor ? await audit.VerifyChain(anchorId, anchorHash!.Trim()) : await audit.VerifyChain();
        await audit.Log(new AuditEntry("system.audit_verified", Actor: Actor.Of(Auth.User),
            Metadata: new { ok = result.Ok, @checked = result.Checked, legacyEntries = result.LegacyEntries, reason = result.Reason, anchor = useAnchor ? anchorId : null, anchorOk = result.AnchorOk },
            Meta: Meta));
        return result;
    }
}
