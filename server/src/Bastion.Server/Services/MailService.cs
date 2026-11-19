using System.Net;
using Bastion.Server.Common;
using MailKit;
using MailKit.Net.Smtp;
using MailKit.Security;
using MimeKit;

namespace Bastion.Server.Services;

public sealed record MailEvent(string De, string En);

public sealed class MailService(SettingsService settings, ILogger<MailService> logger)
{
    private static string Esc(string s) => WebUtility.HtmlEncode(s);
    private static string TextToHtml(string text) => $"<p>{Esc(text).Replace("\n", "<br>")}</p>";

    private sealed record Transport(SmtpSettings Settings, string? Password, MailboxAddress From);

    private async Task<Transport?> Load()
    {
        var s = await settings.GetSmtp();
        if (s is null || string.IsNullOrEmpty(s.Host)) return null;
        // Kein Versand an den Bastion-Server selbst bzw. seine internen Netze (SSRF-Schutz); geprüft beim Verbinden (Connect)
        // Keine Anmeldung ohne TLS (Zugangsdaten würden im Klartext übertragen)
        if (s.Security == "none" && !string.IsNullOrEmpty(s.Username)) throw new InvalidOperationException("SMTP_AUTH_REQUIRES_TLS");
        var from = new MailboxAddress(string.IsNullOrEmpty(s.FromName) ? null : s.FromName.Replace("\"", ""), s.FromAddress);
        return new Transport(s, settings.SmtpPassword(s), from);
    }

    private static async Task<SmtpClient> Connect(Transport t, CancellationToken ct)
    {
        var client = new SmtpClient { Timeout = 10_000, SslProtocols = System.Security.Authentication.SslProtocols.Tls12 | System.Security.Authentication.SslProtocols.Tls13 };
        var options = t.Settings.Security switch
        {
            "tls" => SecureSocketOptions.SslOnConnect,
            "starttls" => SecureSocketOptions.StartTls,
            _ => SecureSocketOptions.None,
        };
        // Verbindung nur zu der bei der Prüfung aufgelösten Adresse (Schutz gegen DNS-Rebinding); TLS prüft weiter den Namen
        var socket = await NetGuard.Connect(t.Settings.Host, t.Settings.Port, ct);
        try
        {
            await client.ConnectAsync(socket, t.Settings.Host, t.Settings.Port, options, ct);
        }
        catch
        {
            socket.Dispose();
            client.Dispose();
            throw;
        }
        if (!string.IsNullOrEmpty(t.Settings.Username)) await client.AuthenticateAsync(t.Settings.Username, t.Password ?? "", ct);
        return client;
    }

    public async Task<bool> IsConfigured() => !string.IsNullOrEmpty((await settings.GetSmtp())?.Host);

    public async Task<bool> Send(string to, string subject, string text, string? html)
    {
        try
        {
            var t = await Load();
            if (t is null) return false;
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            using var client = await Connect(t, cts.Token);
            await client.SendAsync(new SendRequest(Message(t.From, to, subject, text, html)), cts.Token);
            await client.DisconnectAsync(true, cts.Token);
            return true;
        }
        catch (Exception e)
        {
            logger.LogWarning("Mailversand an {To} fehlgeschlagen: {Message}", to, e.Message);
            return false;
        }
    }

    private static MimeMessage Message(MailboxAddress from, string to, string subject, string text, string? html)
    {
        var msg = new MimeMessage();
        msg.From.Add(from);
        msg.To.Add(MailboxAddress.Parse(to));
        msg.Subject = subject;
        var body = new BodyBuilder { TextBody = text };
        if (html is not null) body.HtmlBody = html;
        msg.Body = body.ToMessageBody();
        return msg;
    }

    public async Task<(bool Ok, string? Error)> SendTest(string to)
    {
        try
        {
            var t = await Load();
            if (t is null) return (false, "SMTP_NOT_CONFIGURED");
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            using var client = await Connect(t, cts.Token);
            await client.SendAsync(new SendRequest(Message(t.From, to, "Bastion – Testmail / Test email",
                "Die SMTP-Konfiguration von Bastion funktioniert.\n\nBastion SMTP configuration works.", null)), cts.Token);
            await client.DisconnectAsync(true, cts.Token);
            return (true, null);
        }
        catch (BlockedDestinationException) { return (false, "SMTP_HOST_NOT_ALLOWED"); }
        catch (InvalidOperationException e) when (e.Message == "SMTP_AUTH_REQUIRES_TLS") { return (false, "SMTP_AUTH_REQUIRES_TLS"); }
        catch (Exception e) { return (false, e.Message); }
    }

    public Task<bool> SendInvitation(string to, string link, string orgName, string inviter, int validHours)
    {
        var subject = $"Einladung zu Bastion ({orgName}) / Invitation to Bastion";
        var text = string.Join('\n',
            "Hallo,",
            "",
            $"{inviter} hat Sie zu Bastion, dem Passwort-Tresor von {orgName}, eingeladen.",
            $"Öffnen Sie den folgenden Link, um Ihr Konto einzurichten (gültig für {validHours} Stunden):",
            link,
            "",
            "Nach der Einrichtung muss ein Administrator Ihre Zugehörigkeit bestätigen.",
            "",
            "---",
            $"{inviter} invited you to Bastion, the password vault of {orgName}.",
            $"Open the link above to set up your account (valid for {validHours} hours).");
        var html = $"""
            <div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#1f2a44">
            <h2 style="color:#1f2a44">Bastion</h2>
            <p>{Esc(inviter)} hat Sie zu Bastion, dem Passwort-Tresor von <b>{Esc(orgName)}</b>, eingeladen.</p>
            <p><a href="{Esc(link)}" style="display:inline-block;background:#1f2a44;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Konto einrichten / Set up account</a></p>
            <p style="font-size:13px;color:#555">Der Link ist {validHours} Stunden gültig. Nach der Einrichtung muss ein Administrator Ihre Zugehörigkeit bestätigen.</p>
            <p style="font-size:13px;color:#555">{Esc(inviter)} invited you to Bastion, the password vault of {Esc(orgName)}. The link is valid for {validHours} hours.</p>
            </div>
            """;
        return Send(to, subject, text, html);
    }

    /// <summary>Hinweis an Tenant-Admins bzw. Betroffene über einen sicherheitsrelevanten Eingriff.</summary>
    public Task<bool> SendTenantAdminNotice(string to, string orgName, MailEvent ev)
    {
        var text =
            $"{ev.De}\n\nDiese Änderung ist im Audit-Log von {orgName} protokolliert. Falls sie nicht abgesprochen war, prüfen Sie bitte umgehend Ihre Benutzer und Rollen.\n\n---\n" +
            $"{ev.En}\n\nThis change is recorded in the audit log of {orgName}. If it was not agreed, please review your users and roles immediately.";
        return Send(to, $"Bastion ({orgName}): Sicherheitshinweis / Security notice", text, TextToHtml(text));
    }

    /// <summary>Hinweis an den Kontoinhaber über eine sicherheitsrelevante Änderung am eigenen Konto.</summary>
    public Task<bool> SendAccountNotice(string to, MailEvent ev)
    {
        var text =
            $"{ev.De}\n\nFalls Sie das nicht selbst waren, ändern Sie bitte umgehend Ihr Masterpasswort, beenden Sie unter „Mein Konto“ alle unbekannten Sitzungen und informieren Sie Ihre Administration.\n\n---\n" +
            $"{ev.En}\n\nIf this was not you, please change your master password immediately, end all unknown sessions under “My account” and inform your administrator.";
        return Send(to, "Bastion: Sicherheitshinweis zu Ihrem Konto / Security notice for your account", text, TextToHtml(text));
    }

    /// <summary>Hinweis an System-Admins über eine Änderung an der Systemkonfiguration durch einen anderen System-Admin.</summary>
    public Task<bool> SendSystemAdminNotice(string to, MailEvent ev)
    {
        var text =
            $"{ev.De}\n\nDiese Änderung ist im System-Audit-Log protokolliert. Falls sie nicht abgesprochen war, prüfen Sie bitte umgehend die System-Admins und die Konfiguration.\n\n---\n" +
            $"{ev.En}\n\nThis change is recorded in the system audit log. If it was not agreed, please review the system admins and the configuration immediately.";
        return Send(to, "Bastion: Sicherheitshinweis (System) / Security notice (system)", text, TextToHtml(text));
    }

    public Task<bool> SendLoginLimitWarning(string to)
    {
        const string text =
            "Für Ihr Bastion-Konto gab es in der letzten Stunde ungewöhnlich viele fehlgeschlagene Anmeldeversuche. Anmeldungen von neuen Geräten sind deshalb vorübergehend gesperrt; auf Geräten, an denen Sie sich bereits angemeldet haben, funktioniert die Anmeldung weiterhin. Falls Sie das nicht selbst waren, informieren Sie bitte Ihre Administration.\n\n" +
            "There were unusually many failed sign-in attempts for your Bastion account in the last hour. Sign-ins from new devices are temporarily blocked; devices you have signed in on before still work. If this was not you, please inform your administrator.";
        return Send(to, "Bastion: Viele fehlgeschlagene Anmeldeversuche / Many failed sign-in attempts", text, TextToHtml(text));
    }

    public Task<bool> SendPasswordReset(string to, string orgName)
    {
        var text = $"Ihr Bastion-Masterpasswort ({orgName}) wurde von einem Administrator zurückgesetzt. Ihr persönlicher Tresor wurde dabei geleert. Bitte vergeben Sie bei der nächsten Anmeldung ein neues Masterpasswort.\n\nYour Bastion master password was reset by an administrator. Your personal vault was cleared.";
        return Send(to, "Bastion: Masterpasswort zurückgesetzt / Master password reset", text, TextToHtml(text));
    }
}
