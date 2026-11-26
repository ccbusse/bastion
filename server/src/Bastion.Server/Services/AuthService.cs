using System.Text.RegularExpressions;
using Bastion.Server.Auth;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Bastion.Server.Services;

public sealed partial class AuthService(
    BastionDb db,
    AppConfig config,
    CryptoUtil crypto,
    PasswordService passwords,
    SessionService sessions,
    DeviceToken deviceToken,
    LoginThrottle loginThrottle,
    AuditService audit,
    PermissionService perms,
    SettingsService settings,
    IServiceScopeFactory scopes)
{
    private const int MaxFailed = 5;
    private const int BaseLockMinutes = 15;

    private static string ThrottleKey(string account, RequestMeta meta) => $"{account}\0{meta.Ip ?? ""}";

    public async Task<object> Status()
    {
        var setup = await db.Users.AnyAsync(u => u.Status == UserStatus.SETUP_REQUIRED);
        return new { setupRequired = setup, hibpEnabled = config.HibpEnabled, version = BuildInfo.Version };
    }

    /// <summary>KDF-Parameter. Für unbekannte Adressen deterministische Fake-Werte (keine User-Enumeration).</summary>
    public async Task<object> Prelogin(string email)
    {
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email == email);
        if (user?.KdfSalt is not null)
            return new { kdfSalt = user.KdfSalt, kdfMemory = user.KdfMemory, kdfIterations = user.KdfIterations, kdfParallelism = user.KdfParallelism };
        return new { kdfSalt = Convert.ToBase64String(crypto.HmacBytes("prelogin", email, 16)), kdfMemory = 65536, kdfIterations = 3, kdfParallelism = 4 };
    }

    // ---------- Ersteinrichtung ----------

    public async Task SetupLogin(HttpResponse res, string password, RequestMeta meta)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Status == UserStatus.SETUP_REQUIRED) ?? throw ApiException.Unauthorized("INVALID_CREDENTIALS");
        var key = ThrottleKey("admin", meta);
        await loginThrottle.AssertAllowed(key);
        if (!await passwords.Verify(user.SetupPasswordHash, password))
        {
            await loginThrottle.Fail(key);
            await LogFailure(user, meta, "auth.setup_login_failed");
            throw ApiException.Unauthorized("INVALID_CREDENTIALS");
        }
        await loginThrottle.Reset(key);
        await sessions.Create(new SessionTarget.Web(res), user.Id, SessionScope.SETUP, meta);
        await audit.Log(new AuditEntry("auth.setup_login", Actor: Actor.Of(user), Meta: meta));
    }

    public async Task CompleteSetup(HttpResponse res, AuthContext auth, CompleteSetupDto input, RequestMeta meta)
    {
        var email = Normalize.Email(input.Email);
        if (await db.Users.AnyAsync(u => u.Email == email && u.Id != auth.User.Id)) throw ApiException.Conflict("EMAIL_EXISTS");
        var user = await db.Users.FirstAsync(u => u.Id == auth.User.Id);
        ApplyKeys(user, input);
        user.Email = email;
        user.Name = input.Name.Trim();
        user.AuthHash = await passwords.Hash(input.AuthHash);
        user.Status = UserStatus.ACTIVE;
        user.SetupPasswordHash = null;
        user.ForcePasswordChange = false;
        user.ConfirmedAt = DateTime.UtcNow;
        user.PasswordChangedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        await sessions.RevokeAllForUser(user.Id);
        await sessions.Create(new SessionTarget.Web(res), user.Id, SessionScope.FULL, meta);
        await audit.Log(new AuditEntry("system.setup_completed", Actor: Actor.Of(user), Meta: meta));
    }

    public static void ApplyKeys(User user, AccountKeysDto k)
    {
        user.KdfSalt = k.KdfSalt;
        user.KdfMemory = k.KdfMemory;
        user.KdfIterations = k.KdfIterations;
        user.KdfParallelism = k.KdfParallelism;
        user.ProtectedAccountKey = k.ProtectedAccountKey;
        user.ProtectedPersonalKey = k.ProtectedPersonalKey;
        user.PublicKey = k.PublicKey;
        user.ProtectedPrivateKey = k.ProtectedPrivateKey;
    }

    // ---------- Anmeldung ----------

    public async Task<(bool MfaRequired, string? Token)> Login(SessionTarget target, string email, string authHash, RequestMeta meta, string? deviceCookie)
    {
        // Gleiche Begrenzung für bekannte und unbekannte Adressen (keine User-Enumeration über die Sperre).
        // Bekannte Geräte (gültiges Gerätecookie) haben einen eigenen Zähler und sind vom kontoweiten Limit ausgenommen.
        var device = deviceToken.Verify(email, deviceCookie);
        var key = device is not null ? $"device\0{email}\0{device}" : ThrottleKey(email, meta);
        await loginThrottle.AssertAllowed(key);
        if (device is null) await loginThrottle.AssertAccountAllowed(email);
        var user = await db.Users.FirstOrDefaultAsync(u => u.Email == email);
        var eligible = user is { AuthHash: not null, Status: UserStatus.ACTIVE or UserStatus.PENDING_CONFIRMATION };
        if (!eligible)
        {
            await passwords.Verify(null, authHash);
            await RecordFailure(key, email, device is null, null, meta);
            // Begrenzt je IP-Adresse: Sonst ließe sich das (nicht löschbare) Audit-Log ohne Anmeldung mit erfundenen Adressen füllen
            var seen = await loginThrottle.UnknownFail(meta.Ip);
            if (seen <= LoginThrottle.UnknownAuditLimit)
            {
                await audit.Log(new AuditEntry("auth.login_failed",
                    TenantId: user?.TenantId,
                    Metadata: new { email, reason = "unknown_or_inactive", furtherSuppressed = seen == LoginThrottle.UnknownAuditLimit ? true : (bool?)null },
                    Meta: meta));
            }
            throw ApiException.Unauthorized("INVALID_CREDENTIALS");
        }
        if (!await passwords.Verify(user!.AuthHash, authHash))
        {
            await RecordFailure(key, email, device is null, user, meta);
            await LogFailure(user, meta, "auth.login_failed");
            throw ApiException.Unauthorized("INVALID_CREDENTIALS");
        }
        await loginThrottle.Reset(key);
        if (user.TotpEnabled) return (true, await sessions.Create(target, user.Id, SessionScope.MFA, meta));
        return (false, await FinishLogin(target, user, meta, knownDevice: device is not null));
    }

    [GeneratedRegex(@"[\s-]")]
    private static partial Regex CodeSeparators();

    [GeneratedRegex("^[0-9]{6}$")]
    private static partial Regex SixDigits();

    [GeneratedRegex("^[a-zA-Z0-9]{10}$")]
    private static partial Regex RecoveryCode();

    public async Task<string?> VerifyMfa(SessionTarget target, AuthContext auth, string code, RequestMeta meta, string? deviceCookie)
    {
        var user = auth.User;
        // Versuch vor der Prüfung atomar verbuchen: parallele Anfragen können die Sperre nicht umgehen
        await ReserveAttempt(user.Id);
        var normalized = CodeSeparators().Replace(code, "");
        var ok = false;
        var usedRecovery = false;
        if (SixDigits().IsMatch(normalized) && user.TotpSecretEnc is not null)
        {
            var step = Totp.Check(normalized, crypto.ServerDecrypt(user.TotpSecretEnc), user.TotpLastStep);
            ok = step is { } s && await ConsumeTotpStep(user.Id, s);
        }
        else if (RecoveryCode().IsMatch(normalized))
        {
            ok = await ConsumeRecoveryCode(user.Id, CryptoUtil.Sha256Hex(normalized.ToLowerInvariant()));
            usedRecovery = ok;
        }
        if (!ok)
        {
            await LogFailure(user, meta, "auth.mfa_failed");
            throw ApiException.Unauthorized("INVALID_MFA_CODE");
        }
        await sessions.Revoke(auth.Session.Id);
        return await FinishLogin(target, user, meta, deviceToken.Verify(user.Email, deviceCookie) is not null, usedRecovery);
    }

    /// <summary>Merkt sich den Zeitschritt eines akzeptierten Codes; false, wenn er (parallel) schon verwendet wurde.</summary>
    public async Task<bool> ConsumeTotpStep(Guid userId, long step) =>
        await db.Users
            .Where(u => u.Id == userId && (u.TotpLastStep == null || u.TotpLastStep < step))
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.TotpLastStep, step)) > 0;

    /// <summary>Entfernt einen Wiederherstellungscode atomar; jeder Code ist genau einmal gültig.</summary>
    private async Task<bool> ConsumeRecoveryCode(Guid userId, string hash) =>
        await db.Database.ExecuteSqlAsync($"""
            UPDATE users SET mfa_recovery_codes = array_remove(mfa_recovery_codes, {hash})
            WHERE id = {userId} AND {hash} = ANY(mfa_recovery_codes)
            """) > 0;

    /// <summary>
    /// Verbucht einen Versuch für den zweiten Faktor bzw. eine erneute Passwortprüfung, bevor geprüft wird.
    /// Ab dem 5. Versuch ist das Konto sofort gesperrt (15 Min., danach steigend bis 24 h); ein Erfolg hebt die Sperre auf.
    /// Die Zeilensperre von PostgreSQL serialisiert parallele Anfragen.
    /// </summary>
    private async Task ReserveAttempt(Guid userId)
    {
        var rows = await db.Database.ExecuteSqlAsync($"""
            UPDATE users SET
              failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= {MaxFailed}
                THEN now() + make_interval(mins => LEAST({BaseLockMinutes} * power(2, failed_logins + 1 - {MaxFailed}), 1440)::int)
                ELSE NULL END
            WHERE id = {userId} AND (locked_until IS NULL OR locked_until <= now())
            """);
        if (rows == 0) throw ApiException.TooManyRequests();
    }

    private Task ClearAttempts(Guid userId) =>
        db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(u => u.SetProperty(x => x.FailedLogins, 0).SetProperty(x => x.LockedUntil, (DateTime?)null));

    private async Task<string?> FinishLogin(SessionTarget target, User user, RequestMeta meta, bool knownDevice, bool usedRecoveryCode = false)
    {
        // Anmeldung in einem Browser ohne gültiges Gerätecookie: Inhaber informieren (nicht bei der allerersten Anmeldung)
        if (target is SessionTarget.Web && !knownDevice && user.LastLoginAt is not null)
            NotifyAccount(user.Email, new MailEvent(
                $"Neue Anmeldung an Ihrem Bastion-Konto von einem bisher unbekannten Browser ({Origin(meta)}).",
                $"New sign-in to your Bastion account from a browser not seen before ({Origin(meta)})."));
        // Die Browser-Erweiterung hat kein Gerätecookie: jede Anmeldung melden (nicht bei der allerersten Anmeldung)
        if (target is SessionTarget.Extension && user.LastLoginAt is not null)
            NotifyAccount(user.Email, new MailEvent(
                $"Neue Anmeldung an Ihrem Bastion-Konto über die Browser-Erweiterung ({Origin(meta)}).",
                $"New sign-in to your Bastion account via the browser extension ({Origin(meta)})."));
        if (usedRecoveryCode)
            NotifyAccount(user.Email, new MailEvent(
                "Bei einer Anmeldung an Ihrem Bastion-Konto wurde ein Wiederherstellungscode für die Zwei-Faktor-Authentifizierung verwendet.",
                "A two-factor recovery code was used to sign in to your Bastion account."));
        var now = DateTime.UtcNow;
        await db.Users.Where(u => u.Id == user.Id).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.FailedLogins, 0)
            .SetProperty(x => x.LockedUntil, (DateTime?)null)
            .SetProperty(x => x.LastLoginAt, now));
        var token = await sessions.Create(target, user.Id, SessionScope.FULL, meta);
        // Browser als bekanntes Gerät markieren (eigener Fehlversuchszähler, siehe LoginThrottle)
        if (target is SessionTarget.Web web) deviceToken.SetCookie(web.Response, user.Email);
        await audit.Log(new AuditEntry("auth.login",
            TenantId: user.TenantId,
            Actor: Actor.Of(user),
            Metadata: usedRecoveryCode || target is SessionTarget.Extension
                ? new { mfaRecoveryCode = usedRecoveryCode ? true : (bool?)null, client = target.Client.ToString() }
                : null,
            Meta: meta));
        return token;
    }

    /// <summary>
    /// Fehlversuch verbuchen. Erreicht ein Konto das Limit für unbekannte Geräte, wird das protokolliert und der Inhaber
    /// per Mail gewarnt (im Hintergrund, damit die Antwortzeit nichts über die Existenz des Kontos verrät).
    /// </summary>
    private async Task RecordFailure(string key, string email, bool unknownDevice, User? user, RequestMeta meta)
    {
        await loginThrottle.Fail(key);
        if (!unknownDevice) return;
        if (await loginThrottle.AccountFail(email) != LoginThrottle.AccountLimit || user is null) return;
        var (userId, userEmail, tenantId) = (user.Id, user.Email, user.TenantId);
        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = scopes.CreateScope();
                await scope.ServiceProvider.GetRequiredService<AuditService>()
                    .Log(new AuditEntry("auth.login_account_limited", TenantId: tenantId, Actor: new Actor(userId, userEmail), Meta: meta));
                await scope.ServiceProvider.GetRequiredService<MailService>().SendLoginLimitWarning(userEmail);
            }
            catch
            {
                // bereits protokolliert
            }
        });
    }

    /// <summary>
    /// Sicherheitshinweis an den Kontoinhaber (neues Gerät, Passwortwechsel, 2FA abgeschaltet …). Läuft im Hintergrund,
    /// damit ein langsamer Mailserver die Anfrage nicht aufhält; Fehler beim Versand protokolliert der MailService.
    /// </summary>
    public void NotifyAccount(string email, MailEvent ev) =>
        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = scopes.CreateScope();
                await scope.ServiceProvider.GetRequiredService<MailService>().SendAccountNotice(email, ev);
            }
            catch
            {
                // Versandfehler blockieren die Aktion nicht
            }
        });

    /// <summary>Herkunft einer Anmeldung für die Benachrichtigung (IP-Adresse und Browser, gekürzt).</summary>
    private static string Origin(RequestMeta meta)
    {
        var ua = meta.UserAgent ?? "–";
        if (ua.Length > 120) ua = ua[..120] + "…";
        return $"{meta.Ip ?? "–"}, {ua}";
    }

    private Task LogFailure(User user, RequestMeta meta, string action) =>
        audit.Log(new AuditEntry(action, TenantId: user.TenantId, Actor: Actor.Of(user), Meta: meta));

    // ---------- Sitzungsinformationen ----------

    public async Task<object> SessionInfo(AuthContext auth)
    {
        var (session, user, restrictions) = (auth.Session, auth.User, auth.Restrictions);
        var ctx = await perms.ForUser(user);
        var system = await settings.GetSystem();
        var isSystemAdmin = user.SystemRole == SystemRole.SYSTEM_ADMIN;
        // Tenants für die Auswahl: System-Admins alle, denen sie angehören; sonst nur der eigene
        var tenants = isSystemAdmin
            ? (await db.RoleAssignments.Where(a => a.UserId == user.Id && a.ScopeType == ScopeType.TENANT)
                .Select(a => new { a.Tenant.Id, a.Tenant.Name }).Distinct().ToListAsync())
                .OrderBy(t => t.Name, StringComparer.CurrentCultureIgnoreCase).Select(t => (object)new { id = t.Id, name = t.Name }).ToList()
            : user.Tenant is { } own ? new List<object> { new { id = own.Id, name = own.Name } } : new List<object>();
        return new
        {
            user = new
            {
                id = user.Id,
                email = user.Email,
                name = user.Name,
                locale = user.Locale,
                systemRole = user.SystemRole,
                status = user.Status,
                tenantId = user.TenantId,
                totpEnabled = user.TotpEnabled,
                recoveryCodesLeft = user.MfaRecoveryCodes.Count,
                passwordChangedAt = user.PasswordChangedAt,
                createdAt = user.CreatedAt,
            },
            tenant = user.Tenant is { } t
                ? new { id = t.Id, name = t.Name, slug = t.Slug, requireMfa = t.RequireMfa, keysInitialized = t.RecoveryPublicKey is not null, signingInitialized = t.SigningPublicKey is not null }
                : null,
            tenants,
            keys = new
            {
                kdfSalt = user.KdfSalt,
                kdfMemory = user.KdfMemory,
                kdfIterations = user.KdfIterations,
                kdfParallelism = user.KdfParallelism,
                protectedAccountKey = user.ProtectedAccountKey,
                protectedPersonalKey = user.ProtectedPersonalKey,
                protectedPrivateKey = user.ProtectedPrivateKey,
                publicKey = user.PublicKey,
                // System-Admins sind von der Tenant-Wiederherstellung ausgenommen (Schutz über Tenant-Grenzen hinweg)
                hasRecoveryAccountKey = isSystemAdmin || user.RecoveryAccountKey is not null,
                hasRecoveryVerifier = user.RecoveryVerifier is not null,
            },
            emergency = new { personalIncluded = await PersonalInEmergencyBackup(user) },
            onboarding = new { tourCompletedAt = user.TourCompletedAt, checklistHiddenAt = user.ChecklistHiddenAt },
            permissions = new { isSystemAdmin, isTenantAdmin = ctx.IsTenantAdmin, tenant = ctx.TenantPermissions() },
            restrictions,
            // Commit und Build-Datum nur für System-Admins (Hilfe bei der Fehlersuche)
            build = isSystemAdmin ? BuildInfo.Full : BuildInfo.Public,
            session = new { id = session.Id, expiresAt = session.ExpiresAt, idleMinutes = config.SessionIdleMinutes, autoLockMinutes = system.AutoLockMinutes, extensionAutoLockMinutes = system.ExtensionAutoLockMinutes },
        };
    }

    /// <summary>Ist der persönliche Tresor im Notfall-Backup enthalten (bzw. wird er beim nächsten Entsperren aufgenommen)?</summary>
    private async Task<bool> PersonalInEmergencyBackup(User user)
    {
        var keyId = await db.EmergencyKeys.OrderByDescending(k => k.CreatedAt).Select(k => (Guid?)k.Id).FirstOrDefaultAsync();
        if (keyId is not { } kid) return false;
        if (await db.EmergencyPersonalKeys.AnyAsync(p => p.KeyId == kid && p.UserId == user.Id)) return true;
        if (user.SystemRole == SystemRole.SYSTEM_ADMIN) return await db.EmergencyAnchors.AnyAsync(a => a.KeyId == kid && a.UserId == user.Id);
        return user.TenantId is { } tid && await db.EmergencyApprovals.AnyAsync(a => a.KeyId == kid && a.TenantId == tid);
    }

    public async Task ChangePassword(AuthContext auth, ChangePasswordDto input, RequestMeta meta)
    {
        var user = auth.User;
        await ReserveAttempt(user.Id);
        if (!await passwords.Verify(user.AuthHash, input.CurrentAuthHash))
        {
            await LogFailure(user, meta, "auth.password_change_failed");
            throw ApiException.Unauthorized("INVALID_CREDENTIALS");
        }
        // Pflicht-Passwortwechsel nach Admin-Wiederherstellung: Der Client ersetzt den (dem Admin bekannten) PersonalKey.
        // Dafür muss der persönliche Tresor leer sein (er wurde bei der Wiederherstellung geleert, und eingeschränkte Konten
        // können keine Einträge anlegen); das Notfall-Schlüsselpaket des vorläufigen Schlüssels wird verworfen.
        if (user.ForcePasswordChange)
        {
            if (await db.Items.AnyAsync(i => i.OwnerId == user.Id)) throw ApiException.Conflict("PERSONAL_VAULT_NOT_EMPTY");
            await db.EmergencyPersonalKeys.Where(p => p.UserId == user.Id).ExecuteDeleteAsync();
        }
        var hash = await passwords.Hash(input.AuthHash);
        var now = DateTime.UtcNow;
        await db.Users.Where(u => u.Id == user.Id).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.AuthHash, hash)
            .SetProperty(x => x.KdfSalt, input.KdfSalt)
            .SetProperty(x => x.KdfMemory, input.KdfMemory)
            .SetProperty(x => x.KdfIterations, input.KdfIterations)
            .SetProperty(x => x.KdfParallelism, input.KdfParallelism)
            .SetProperty(x => x.ProtectedAccountKey, input.ProtectedAccountKey)
            .SetProperty(x => x.ProtectedPersonalKey, input.ProtectedPersonalKey)
            .SetProperty(x => x.ForcePasswordChange, false)
            .SetProperty(x => x.FailedLogins, 0)
            .SetProperty(x => x.LockedUntil, (DateTime?)null)
            .SetProperty(x => x.PasswordChangedAt, now)
            .SetProperty(x => x.UpdatedAt, now));
        await sessions.RevokeAllForUser(user.Id, auth.Session.Id);
        await audit.Log(new AuditEntry("auth.password_changed", TenantId: user.TenantId, Actor: Actor.Of(user), Meta: meta));
        // Nach einer Admin-Wiederherstellung wurde der Benutzer bereits per Mail informiert
        if (!user.ForcePasswordChange)
            NotifyAccount(user.Email, new MailEvent(
                $"Das Masterpasswort Ihres Bastion-Kontos wurde geändert ({Origin(meta)}). Alle anderen Sitzungen wurden beendet.",
                $"The master password of your Bastion account was changed ({Origin(meta)}). All other sessions were ended."));
    }

    /// <summary>Erneute Prüfung des Masterpassworts für sensible Aktionen.</summary>
    public async Task VerifyAuthHash(User user, string authHash, RequestMeta meta)
    {
        await ReserveAttempt(user.Id);
        if (!await passwords.Verify(user.AuthHash, authHash))
        {
            await LogFailure(user, meta, "auth.reauth_failed");
            throw ApiException.Unauthorized("INVALID_CREDENTIALS");
        }
        await ClearAttempts(user.Id);
    }
}
