using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Controllers;

/// <summary>Einstellungen und Audit-Log des eigenen Tenants.</summary>
[Route("api/tenant")]
public sealed class TenantController(BastionDb db, PermissionService perms, AuditService audit, OrgService org, MailService mail) : BastionController
{
    [HttpGet]
    public async Task<object> Get()
    {
        var t = Auth.User.Tenant ?? throw ApiException.Forbidden();
        var users = await db.Users.Where(u => u.TenantId == t.Id).GroupBy(u => u.Status).Select(g => new { Status = g.Key, Count = g.Count() }).ToListAsync();
        var departments = await db.Departments.CountAsync(d => d.TenantId == t.Id);
        var folders = await db.Folders.CountAsync(f => f.TenantId == t.Id);
        var items = await db.Items.CountAsync(i => i.TenantId == t.Id);
        return new
        {
            id = t.Id,
            name = t.Name,
            slug = t.Slug,
            requireMfa = t.RequireMfa,
            requireJoinApproval = t.RequireJoinApproval,
            keysInitialized = t.RecoveryPublicKey is not null,
            stats = new { users = users.ToDictionary(u => u.Status.ToString(), u => u.Count), departments, folders, items },
        };
    }

    [HttpPatch]
    public async Task<object> Update(TenantUpdateDto input)
    {
        var t = Auth.User.Tenant ?? throw ApiException.Forbidden();
        (await perms.ForUser(Auth.User)).Require(P.SettingsManage);
        var name = input.Name?.Trim();
        var tenant = await db.Tenants.FirstAsync(x => x.Id == t.Id);
        var approvalTurnedOff = tenant.RequireJoinApproval && input.RequireJoinApproval == false;
        if (input.RequireMfa is { } mfa) tenant.RequireMfa = mfa;
        if (input.RequireJoinApproval is { } approval) tenant.RequireJoinApproval = approval;
        if (name is not null) tenant.Name = name;
        await db.SaveChangesAsync();
        await audit.Log(new AuditEntry("tenant.settings_updated", TenantId: t.Id, Actor: Actor.Of(Auth.User), TargetType: "tenant", TargetId: t.Id.ToString(),
            Metadata: new { requireMfa = input.RequireMfa, requireJoinApproval = input.RequireJoinApproval, name }, Meta: Meta));
        if (approvalTurnedOff)
            await org.NotifyTenantAdmins(t.Id, new MailEvent(
                $"{Auth.User.Email} hat die Zustimmungspflicht für den Beitritt von System-Admins abgeschaltet. System-Admins können Ihrem Tenant jetzt ohne Rückfrage als Tenant-Admin beitreten.",
                $"{Auth.User.Email} turned off the approval requirement for system admins joining. System admins can now join your tenant as tenant admin without asking."), [Auth.User.Id]);
        return OkResult;
    }

    // ---------- Beitrittsanfragen von System-Admins ----------

    [HttpGet("join-requests")]
    public async Task<object> JoinRequests()
    {
        var t = await RequireTenantAdmin();
        var now = DateTime.UtcNow;
        return await db.TenantJoinRequests.AsNoTracking()
            .Where(r => r.TenantId == t && r.ExpiresAt > now)
            .OrderBy(r => r.CreatedAt)
            .Select(r => new { r.Id, r.UserId, r.User.Email, r.User.Name, r.CreatedAt, r.ExpiresAt })
            .ToListAsync();
    }

    /// <summary>
    /// Zustimmung: Der System-Admin wird Tenant-Admin. Schlüssel erhält er wie jedes neue Mitglied erst nach der Beglaubigung seines
    /// Schlüssels. Erneute Passworteingabe, denn die Zustimmung gibt einem weiteren Konto Vollzugriff auf den Tenant.
    /// </summary>
    [RequireRecentAuth, Ok200, HttpPost("join-requests/{id}/approve")]
    public async Task<object> ApproveJoin(Guid id)
    {
        var t = await RequireTenantAdmin();
        var request = await LoadRequest(t, id);
        var requester = request.User;
        if (requester.SystemRole != SystemRole.SYSTEM_ADMIN || requester.Status != UserStatus.ACTIVE)
        {
            await db.TenantJoinRequests.Where(r => r.Id == id).ExecuteDeleteAsync();
            throw ApiException.BadRequest("JOIN_REQUEST_INVALID");
        }
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            await org.AddTenantAdmin(t, requester.Id, Auth.User.Id);
            // Ohne aktiven Tenant wechselt der System-Admin in diesen; sonst wechselt er selbst bei Bedarf
            if (requester.TenantId is null)
                await db.Users.Where(u => u.Id == requester.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.TenantId, t).SetProperty(x => x.UpdatedAt, DateTime.UtcNow));
            await db.TenantJoinRequests.Where(r => r.Id == id).ExecuteDeleteAsync();
            await tx.CommitAsync();
        }
        await audit.Log(new AuditEntry("tenant.sysadmin_join_approved", TenantId: t, Actor: Actor.Of(Auth.User), TargetType: "user", TargetId: requester.Id.ToString(),
            Metadata: new { email = requester.Email }, Meta: Meta));
        var tenantName = Auth.User.Tenant?.Name ?? "Bastion";
        await mail.SendTenantAdminNotice(requester.Email, tenantName, new MailEvent(
            $"{Auth.User.Email} hat Ihrer Beitrittsanfrage zugestimmt. Sie sind jetzt Tenant-Admin von „{tenantName}“. Schlüssel erhalten Sie, sobald ein Tenant-Admin Ihren Schlüssel beglaubigt hat.",
            $"{Auth.User.Email} approved your join request. You are now tenant admin of \"{tenantName}\". You receive keys once a tenant admin has endorsed your key."));
        await org.NotifyTenantAdmins(t, new MailEvent(
            $"{Auth.User.Email} hat der Beitrittsanfrage des System-Admins {requester.Email} zugestimmt. Er ist jetzt Tenant-Admin; Schlüssel erhält er erst nach der Beglaubigung seines Schlüssels.",
            $"{Auth.User.Email} approved the join request of system admin {requester.Email}. They are now tenant admin and receive keys only after their key has been endorsed."), [Auth.User.Id, requester.Id]);
        return OkResult;
    }

    [Ok200, HttpPost("join-requests/{id}/reject")]
    public async Task<object> RejectJoin(Guid id)
    {
        var t = await RequireTenantAdmin();
        var request = await LoadRequest(t, id);
        await db.TenantJoinRequests.Where(r => r.Id == id).ExecuteDeleteAsync();
        await audit.Log(new AuditEntry("tenant.sysadmin_join_rejected", TenantId: t, Actor: Actor.Of(Auth.User), TargetType: "user", TargetId: request.UserId.ToString(),
            Metadata: new { email = request.User.Email }, Meta: Meta));
        var tenantName = Auth.User.Tenant?.Name ?? "Bastion";
        await mail.SendTenantAdminNotice(request.User.Email, tenantName, new MailEvent(
            $"{Auth.User.Email} hat Ihre Anfrage abgelehnt, dem Tenant „{tenantName}“ beizutreten.",
            $"{Auth.User.Email} rejected your request to join the tenant \"{tenantName}\"."));
        await org.NotifyTenantAdmins(t, new MailEvent(
            $"{Auth.User.Email} hat die Beitrittsanfrage des System-Admins {request.User.Email} abgelehnt.",
            $"{Auth.User.Email} rejected the join request of system admin {request.User.Email}."), [Auth.User.Id, request.UserId]);
        return OkResult;
    }

    private async Task<Guid> RequireTenantAdmin()
    {
        var t = Auth.User.Tenant ?? throw ApiException.Forbidden();
        if (!(await perms.ForUser(Auth.User)).IsTenantAdmin) throw ApiException.Forbidden();
        return t.Id;
    }

    private async Task<TenantJoinRequest> LoadRequest(Guid tenantId, Guid id)
    {
        var now = DateTime.UtcNow;
        return await db.TenantJoinRequests.Include(r => r.User).FirstOrDefaultAsync(r => r.Id == id && r.TenantId == tenantId && r.ExpiresAt > now)
            ?? throw ApiException.NotFound("JOIN_REQUEST_NOT_FOUND");
    }

    [HttpGet("audit")]
    public async Task<object> AuditLog([FromQuery] string? before, [FromQuery] string? action)
    {
        var t = Auth.User.Tenant ?? throw ApiException.Forbidden();
        (await perms.ForUser(Auth.User)).Require(P.AuditRead);
        if (before is not null && (before.Length == 0 || !before.All(char.IsAsciiDigit))) throw OrgHelpers.Invalid("before", "Invalid string");
        if (action is { Length: > 60 }) throw OrgHelpers.Invalid("action", "Too big");
        return await audit.List(t.Id, filterTenant: true, action, before, null);
    }
}
