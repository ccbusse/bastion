using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Bastion.Server.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using QRCoder;

namespace Bastion.Server.Controllers;

[Route("api/mfa")]
public sealed class MfaController(BastionDb db, AuditService audit, AuthService auth, SettingsService settings, CryptoUtil crypto) : BastionController
{
    private static List<string> GenerateRecoveryCodes(int n = 10) =>
        Enumerable.Range(0, n).Select(_ =>
        {
            var s = CryptoUtil.RandomFromAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 10);
            return s[..5] + "-" + s[5..];
        }).ToList();

    private static List<string> Hashes(IEnumerable<string> codes) => codes.Select(c => CryptoUtil.Sha256Hex(c.Replace("-", ""))).ToList();

    /// <summary>
    /// Einrichtung nur mit dem eigenen Masterpasswort: Sonst könnte eine übernommene Sitzung einen eigenen zweiten Faktor
    /// setzen und den Inhaber aussperren (wie beim Abschalten).
    /// </summary>
    [AllowRestricted, Ok200, HttpPost("totp/setup")]
    public async Task<object> Setup(AuthHashDto body)
    {
        if (Auth.User.TotpEnabled) throw ApiException.Conflict("MFA_ALREADY_ENABLED");
        await auth.VerifyAuthHash(Auth.User, body.AuthHash, Meta);
        var secret = Totp.NewSecret();
        var enc = crypto.ServerEncrypt(secret);
        await db.Users.Where(u => u.Id == Auth.User.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.TotpSecretEnc, enc).SetProperty(x => x.TotpLastStep, (long?)null));
        var label = Auth.User.Tenant is { } t ? $"{t.Name}:{Auth.User.Email}" : Auth.User.Email;
        var otpauthUrl = Totp.Uri(label, secret);
        using var qr = QRCodeGenerator.GenerateQrCode(otpauthUrl, QRCodeGenerator.ECCLevel.M);
        var png = new PngByteQRCode(qr).GetGraphic(6, drawQuietZones: true);
        return new { secret, otpauthUrl, qrDataUrl = "data:image/png;base64," + Convert.ToBase64String(png) };
    }

    [AllowRestricted, Ok200, HttpPost("totp/enable")]
    public async Task<object> Enable(TotpCodeDto body)
    {
        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == Auth.User.Id);
        if (user.TotpEnabled) throw ApiException.Conflict("MFA_ALREADY_ENABLED");
        var step = user.TotpSecretEnc is not null ? Totp.Check(body.Code, crypto.ServerDecrypt(user.TotpSecretEnc)) : null;
        if (step is null) throw ApiException.BadRequest("INVALID_MFA_CODE");
        var codes = GenerateRecoveryCodes();
        var hashes = Hashes(codes);
        // Der Bestätigungscode gilt als verbraucht und kann nicht direkt zur Anmeldung wiederverwendet werden
        await db.Users.Where(u => u.Id == user.Id).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.TotpEnabled, true)
            .SetProperty(x => x.TotpLastStep, step)
            .SetProperty(x => x.MfaRecoveryCodes, hashes));
        await audit.Log(new AuditEntry("mfa.enabled", TenantId: user.TenantId, Actor: Actor.Of(user), Meta: Meta));
        auth.NotifyAccount(user.Email, new MailEvent(
            "Für Ihr Bastion-Konto wurde die Zwei-Faktor-Authentifizierung eingerichtet.",
            "Two-factor authentication was set up for your Bastion account."));
        return new { recoveryCodes = codes };
    }

    [Ok200, HttpPost("totp/disable")]
    public async Task<object> Disable(AuthHashDto body)
    {
        await auth.VerifyAuthHash(Auth.User, body.AuthHash, Meta);
        var systemPolicy = Auth.User.SystemRole == SystemRole.SYSTEM_ADMIN && (await settings.GetSystem()).RequireMfaForSystemAdmins;
        if ((Auth.User.Tenant?.RequireMfa ?? false) || systemPolicy) throw ApiException.Forbidden("MFA_REQUIRED_BY_POLICY");
        await db.Users.Where(u => u.Id == Auth.User.Id).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.TotpEnabled, false)
            .SetProperty(x => x.TotpSecretEnc, (string?)null)
            .SetProperty(x => x.TotpLastStep, (long?)null)
            .SetProperty(x => x.MfaRecoveryCodes, new List<string>()));
        await audit.Log(new AuditEntry("mfa.disabled", TenantId: Auth.User.TenantId, Actor: Actor.Of(Auth.User), Meta: Meta));
        auth.NotifyAccount(Auth.User.Email, new MailEvent(
            "Die Zwei-Faktor-Authentifizierung Ihres Bastion-Kontos wurde abgeschaltet.",
            "Two-factor authentication for your Bastion account was turned off."));
        return OkResult;
    }

    [Ok200, HttpPost("recovery-codes")]
    public async Task<object> Regenerate(AuthHashDto body)
    {
        await auth.VerifyAuthHash(Auth.User, body.AuthHash, Meta);
        if (!Auth.User.TotpEnabled) throw ApiException.BadRequest("MFA_NOT_ENABLED");
        var codes = GenerateRecoveryCodes();
        var hashes = Hashes(codes);
        await db.Users.Where(u => u.Id == Auth.User.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.MfaRecoveryCodes, hashes));
        await audit.Log(new AuditEntry("mfa.recovery_codes_regenerated", TenantId: Auth.User.TenantId, Actor: Actor.Of(Auth.User), Meta: Meta));
        auth.NotifyAccount(Auth.User.Email, new MailEvent(
            "Für Ihr Bastion-Konto wurden neue Wiederherstellungscodes erzeugt; die bisherigen sind ungültig.",
            "New recovery codes were generated for your Bastion account; the previous ones are no longer valid."));
        return new { recoveryCodes = codes };
    }
}
