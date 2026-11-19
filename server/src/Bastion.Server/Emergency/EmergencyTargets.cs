using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Bastion.Server.Common;
using Bastion.Server.Data;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace Bastion.Server.Emergency;

/// <summary>Fehler mit für den Benutzer verständlicher Meldung; <see cref="HostKey"/> bei unbekanntem SFTP-Host-Schlüssel.</summary>
public sealed class TargetException(string message, string? hostKey = null, string? status = null) : Exception(message)
{
    public string? HostKey { get; } = hostKey;
    public string? Status { get; } = status;
}

public interface ITargetDriver : IAsyncDisposable
{
    Task Put(string name, byte[] data);
    /// <summary>Dateinamen im Zielverzeichnis</summary>
    Task<List<string>> List();
    Task Remove(string name);
}

public sealed class OpenOptions
{
    /// <summary>
    /// SFTP ohne gespeicherte Server-Kennung: beim ersten Verbinden übernehmen (wie ssh beim ersten Kontakt).
    /// Nur beim Einrichten eines Ziels; danach muss die Kennung exakt übereinstimmen.
    /// </summary>
    public bool TrustOnFirstUse { get; init; }
    /// <summary>Gemerkte Server-Kennung (wird bei TrustOnFirstUse gesetzt)</summary>
    public string? LearnedHostKey { get; set; }
}

/// <summary>
/// Speicherziele für den automatischen Export des Notfall-Backups.
/// Alle Ziele speichern nur die bereits verschlüsselte Backup-Datei und das Notfall-Werkzeug.
/// </summary>
public static partial class EmergencyTargets
{
    [GeneratedRegex("^bastion-notfall-backup-[0-9T-]+Z\\.json$")]
    public static partial Regex BackupFile();

    public const string ToolFile = "bastion-notfall-werkzeug.html";

    private static string TrimSlashes(string p) => p.Trim('/');

    /// <summary>Host, zu dem ein Ziel verbindet (null bei Ordnern auf dem Server).</summary>
    public static string? TargetHost(TargetConfig config) => config switch
    {
        SmbTargetConfig c => c.Host,
        SftpTargetConfig c => c.Host,
        WebDavTargetConfig c => new Uri(c.Url).Host,
        _ => null,
    };

    /// <summary>
    /// Interne Adressen (Loopback, Link-Local, Docker-Netze des Containers) sind als Ziel nicht zulässig.
    /// WebDAV mit Anmeldung nur über HTTPS: Basic-Auth würde das Passwort sonst im Klartext übertragen.
    /// </summary>
    public static async Task AssertTargetAllowed(TargetConfig config)
    {
        if (config is WebDavTargetConfig w && w.Username.Length > 0 && new Uri(w.Url).Scheme != "https")
            throw new TargetException("Mit Benutzername und Passwort ist eine verschlüsselte Verbindung (https://) erforderlich.", null, "HTTPS_REQUIRED");
        var host = TargetHost(config);
        if (host is null) return;
        try
        {
            await NetGuard.AssertAllowedHost(host);
        }
        catch (BlockedDestinationException)
        {
            throw new TargetException("Dieses Ziel ist nicht zulässig: Die Adresse gehört zum Bastion-Server selbst bzw. zu seinem internen Netz.", null, "DESTINATION_NOT_ALLOWED");
        }
    }

    public static async Task<ITargetDriver> Open(TargetConfig config, IReadOnlyDictionary<string, string> secrets, string folderBase, OpenOptions? options = null)
    {
        await AssertTargetAllowed(config);
        return config switch
        {
            FolderTargetConfig c => FolderDriver.Open(c, folderBase),
            SmbTargetConfig c => await SmbDriver.Open(c, secrets),
            SftpTargetConfig c => await SftpDriver.Open(c, secrets, options ?? new OpenOptions()),
            WebDavTargetConfig c => await WebDavDriver.Open(c, secrets),
            _ => throw new InvalidOperationException("Unbekannter Zieltyp"),
        };
    }

    /// <summary>Verbindungstest: kleine Datei schreiben, auflisten, löschen. Liefert die Zahl vorhandener Backups.</summary>
    public static async Task<int> Test(TargetConfig config, IReadOnlyDictionary<string, string> secrets, string folderBase, OpenOptions? options = null)
    {
        await using var driver = await Open(config, secrets, folderBase, options);
        var name = $".bastion-test-{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6))}.txt";
        await driver.Put(name, Encoding.UTF8.GetBytes($"Bastion Verbindungstest {DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)}\n"));
        var files = await driver.List();
        if (!files.Contains(name)) throw new TargetException("Testdatei wurde geschrieben, erscheint aber nicht in der Auflistung");
        await driver.Remove(name);
        return files.Count(f => BackupFile().IsMatch(f));
    }

    /// <summary>
    /// Adresse, zu der verbunden wird: einmal aufgelöst und geprüft. Der Treiber verbindet nur zu dieser Adresse,
    /// damit ein zweiter DNS-Lookup nicht auf eine interne Adresse umgelenkt werden kann (DNS-Rebinding).
    /// </summary>
    internal static async Task<IPAddress> PinnedAddress(string host, string what)
    {
        try
        {
            var addrs = await NetGuard.ResolveAllowed(host);
            return addrs.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork) ?? addrs[0];
        }
        catch (BlockedDestinationException)
        {
            throw new TargetException("Dieses Ziel ist nicht zulässig: Die Adresse gehört zum Bastion-Server selbst bzw. zu seinem internen Netz.", null, "DESTINATION_NOT_ALLOWED");
        }
        catch (SocketException e)
        {
            throw Friendly(what, e);
        }
    }

    /// <summary>Netzwerkfehler in verständliche Meldungen übersetzen.</summary>
    internal static TargetException Friendly(string what, Exception e)
    {
        if (e is TargetException te) return te;
        if (e is BlockedDestinationException || e.InnerException is BlockedDestinationException)
            return new TargetException("Dieses Ziel ist nicht zulässig: Die Adresse gehört zum Bastion-Server selbst bzw. zu seinem internen Netz.", null, "DESTINATION_NOT_ALLOWED");
        if (e is SshAuthenticationException) return new TargetException("Benutzername oder Passwort falsch.");
        var socket = e as SocketException ?? e.InnerException as SocketException ?? e.InnerException?.InnerException as SocketException;
        switch (socket?.SocketErrorCode)
        {
            case SocketError.HostNotFound or SocketError.TryAgain or SocketError.NoData:
                return new TargetException($"{what} nicht gefunden. Bitte die Adresse prüfen.");
            case SocketError.ConnectionRefused:
                return new TargetException($"{what} lehnt die Verbindung ab. Stimmt die Adresse bzw. der Port?");
            case SocketError.TimedOut:
                return new TargetException($"{what} antwortet nicht (Zeitüberschreitung).");
        }
        if (e is TaskCanceledException or TimeoutException or SshOperationTimeoutException) return new TargetException($"{what} antwortet nicht (Zeitüberschreitung).");
        if (e is AuthenticationException || e.InnerException is AuthenticationException) return new TargetException($"Sichere Verbindung zu {what} fehlgeschlagen (Zertifikat ungültig).");
        return new TargetException($"{what} nicht erreichbar: {e.InnerException?.Message ?? e.Message}");
    }

    internal static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        // Weiterleitungen nicht folgen: sonst ließe sich die Prüfung der Zieladresse umgehen
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(30),
        UseCookies = false,
        // Verbindung nur zu der bei der Prüfung aufgelösten Adresse (Schutz gegen DNS-Rebinding)
        ConnectCallback = NetGuard.HttpConnect,
    })
    { Timeout = TimeSpan.FromSeconds(120) };

    internal static string DecodeXml(string s) =>
        s.Replace("&lt;", "<").Replace("&gt;", ">").Replace("&quot;", "\"").Replace("&apos;", "'").Replace("&amp;", "&");

    // ---------- Ordner / Netzlaufwerk ----------

    private sealed class FolderDriver(string dir) : ITargetDriver
    {
        public static FolderDriver Open(FolderTargetConfig config, string folderBase)
        {
            var baseDir = Path.GetFullPath(folderBase);
            var dir = Path.GetFullPath(Path.Combine(baseDir, TrimSlashes(config.Path)));
            // Nur innerhalb des eingebundenen Verzeichnisses schreiben
            var rel = Path.GetRelativePath(baseDir, dir);
            if (rel.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(rel)) throw new TargetException($"Pfad liegt außerhalb von {folderBase}");
            try
            {
                Directory.CreateDirectory(dir);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                var code = e is UnauthorizedAccessException ? "EACCES" : "Fehler";
                throw new TargetException($"Verzeichnis {dir} nicht beschreibbar ({code}). Ist {folderBase} als Volume eingebunden?");
            }
            return new FolderDriver(dir);
        }

        public async Task Put(string name, byte[] data)
        {
            var tmp = Path.Combine(dir, $".{name}.part");
            var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead;
            await using (var fs = new FileStream(tmp, options)) await fs.WriteAsync(data);
            File.Move(tmp, Path.Combine(dir, name), overwrite: true);
        }

        public Task<List<string>> List() => Task.FromResult(Directory.EnumerateFileSystemEntries(dir).Select(p => Path.GetFileName(p)).ToList());

        public Task Remove(string name)
        {
            File.Delete(Path.Combine(dir, name));
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    // ---------- SFTP ----------

    public static string SshFingerprint(byte[] key) => "SHA256:" + Convert.ToBase64String(SHA256.HashData(key)).TrimEnd('=');

    private sealed class SftpDriver(SftpClient sftp, string dir) : ITargetDriver
    {
        public static async Task<SftpDriver> Open(SftpTargetConfig config, IReadOnlyDictionary<string, string> secrets, OpenOptions options)
        {
            var methods = new List<AuthenticationMethod>();
            if (secrets.GetValueOrDefault("privateKey") is { Length: > 0 } pk)
            {
                var passphrase = secrets.GetValueOrDefault("passphrase") is { Length: > 0 } pp ? pp : null;
                try
                {
                    methods.Add(new PrivateKeyAuthenticationMethod(config.Username, new PrivateKeyFile(new MemoryStream(Encoding.UTF8.GetBytes(pk)), passphrase)));
                }
                catch (Exception e) when (e is SshException or ArgumentException or InvalidOperationException)
                {
                    throw new TargetException($"Privater Schlüssel nicht lesbar: {e.Message}");
                }
            }
            if (secrets.GetValueOrDefault("password") is { Length: > 0 } pw) methods.Add(new PasswordAuthenticationMethod(config.Username, pw));
            if (methods.Count == 0) methods.Add(new NoneAuthenticationMethod(config.Username));

            var address = await PinnedAddress(config.Host, "Server");
            var info = new Renci.SshNet.ConnectionInfo(address.ToString(), config.Port, config.Username, [.. methods]) { Timeout = TimeSpan.FromSeconds(15) };
            var sftp = new SftpClient(info);
            string? seen = null;
            var tofu = config.HostKey is null && options.TrustOnFirstUse;
            // Server-Kennung muss zur gespeicherten passen (Schutz vor Man-in-the-Middle); beim Einrichten wird sie gemerkt
            sftp.HostKeyReceived += (_, e) =>
            {
                seen = SshFingerprint(e.HostKey);
                e.CanTrust = tofu || seen == config.HostKey;
            };
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                await sftp.ConnectAsync(cts.Token);
            }
            catch (Exception e)
            {
                sftp.Dispose();
                if (!tofu && seen is not null && seen != config.HostKey)
                {
                    throw new TargetException(
                        config.HostKey is not null
                            ? "Die Kennung des Servers hat sich geändert. Das kann an einer Neuinstallation des Servers liegen, aber auch an einem Angriff. Bitte beim Betreiber nachfragen und das Ziel neu einrichten."
                            : "Die Kennung des Servers ist noch nicht bekannt. Bitte das Ziel neu speichern.",
                        seen);
                }
                throw Friendly("Server", e);
            }
            if (tofu) options.LearnedHostKey = seen;
            var dir = config.Path.Length > 0 ? config.Path.TrimEnd('/') : ".";
            if (dir.Length == 0) dir = "/";
            try
            {
                if (dir != "." && !sftp.Exists(dir))
                {
                    // Verzeichnis Ebene für Ebene anlegen (wie mkdir -p)
                    var current = dir.StartsWith('/') ? "" : null;
                    foreach (var part in dir.Split('/', StringSplitOptions.RemoveEmptyEntries))
                    {
                        current = current is null ? part : $"{current}/{part}";
                        if (!sftp.Exists(current)) sftp.CreateDirectory(current);
                    }
                }
            }
            catch (Exception e)
            {
                sftp.Dispose();
                throw new TargetException($"Server meldet Fehler: {e.Message}");
            }
            return new SftpDriver(sftp, dir);
        }

        private string P(string name) => dir == "." ? name : $"{dir}/{name}";

        public Task Put(string name, byte[] data) => Task.Run(() =>
        {
            var tmp = P($".{name}.part");
            using (var ms = new MemoryStream(data)) sftp.UploadFile(ms, tmp, canOverride: true);
            if (sftp.Exists(P(name))) sftp.DeleteFile(P(name));
            sftp.RenameFile(tmp, P(name));
        });

        public Task<List<string>> List() => Task.Run(() => sftp.ListDirectory(dir).Select(f => f.Name).Where(n => n is not "." and not "..").ToList());

        public Task Remove(string name) => Task.Run(() =>
        {
            try { sftp.DeleteFile(P(name)); }
            catch (SftpPathNotFoundException) { /* bereits gelöscht */ }
        });

        public ValueTask DisposeAsync()
        {
            try { sftp.Disconnect(); } catch { /* egal */ }
            sftp.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    // ---------- WebDAV / Nextcloud ----------

    private sealed partial class WebDavDriver(string baseUrl, string? authorization) : ITargetDriver
    {
        private static readonly HttpMethod Propfind = new("PROPFIND");
        private static readonly HttpMethod Mkcol = new("MKCOL");

        [GeneratedRegex(@"<(?:[\w-]+:)?href>([^<]+)</(?:[\w-]+:)?href>")]
        private static partial Regex Href();

        public static async Task<WebDavDriver> Open(WebDavTargetConfig config, IReadOnlyDictionary<string, string> secrets)
        {
            var baseUrl = config.Url.EndsWith('/') ? config.Url : config.Url + "/";
            var auth = config.Username.Length > 0
                ? "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes($"{config.Username}:{secrets.GetValueOrDefault("password") ?? ""}"))
                : null;
            var driver = new WebDavDriver(baseUrl, auth);
            // Zielordner anlegen, falls er fehlt (nur die letzte Ebene)
            using var probe = await driver.Call(Propfind, baseUrl, new() { ["depth"] = "0" });
            if (probe.StatusCode == HttpStatusCode.NotFound)
            {
                using var mk = await driver.Call(Mkcol, baseUrl);
                if (!mk.IsSuccessStatusCode) throw Fail("MKCOL", mk);
            }
            else if (!probe.IsSuccessStatusCode) throw Fail("PROPFIND", probe);
            return driver;
        }

        private async Task<HttpResponseMessage> Call(HttpMethod method, string url, Dictionary<string, string>? headers = null, HttpContent? content = null)
        {
            using var req = new HttpRequestMessage(method, url) { Content = content };
            if (authorization is not null) req.Headers.TryAddWithoutValidation("Authorization", authorization);
            foreach (var (k, v) in headers ?? []) req.Headers.TryAddWithoutValidation(k, v);
            try
            {
                return await Http.SendAsync(req);
            }
            catch (Exception e)
            {
                throw Friendly("Server", e);
            }
        }

        private static TargetException Fail(string method, HttpResponseMessage res)
        {
            var s = (int)res.StatusCode;
            return new TargetException(s switch
            {
                401 => "Benutzername oder Passwort falsch.",
                403 => "Keine Berechtigung, in diesen Ordner zu schreiben.",
                404 or 409 => "Adresse oder übergeordneter Ordner nicht gefunden. Bitte Server-Adresse und Ordner prüfen.",
                507 => "Kein Speicherplatz mehr frei.",
                >= 300 and < 400 => "Der Server leitet auf eine andere Adresse weiter. Bitte die endgültige Adresse (z. B. mit https:// bzw. abschließendem /) eintragen.",
                _ => $"Server meldet Fehler {s} {res.ReasonPhrase} ({method})",
            });
        }

        public async Task Put(string name, byte[] data)
        {
            var content = new ByteArrayContent(data);
            content.Headers.ContentType = new(name.EndsWith(".html", StringComparison.Ordinal) ? "text/html" : "application/json");
            using var res = await Call(HttpMethod.Put, baseUrl + Uri.EscapeDataString(name), null, content);
            if (!res.IsSuccessStatusCode) throw Fail("PUT", res);
        }

        public async Task<List<string>> List()
        {
            var content = new StringContent("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>", Encoding.UTF8);
            content.Headers.ContentType = new("application/xml");
            using var res = await Call(Propfind, baseUrl, new() { ["depth"] = "1" }, content);
            if (!res.IsSuccessStatusCode) throw Fail("PROPFIND", res);
            var xml = await res.Content.ReadAsStringAsync();
            return Href().Matches(xml)
                .Select(m => Uri.UnescapeDataString(DecodeXml(m.Groups[1].Value)).TrimEnd('/'))
                .Select(h => h[(h.LastIndexOf('/') + 1)..])
                .Where(n => n.Length > 0)
                .ToList();
        }

        public async Task Remove(string name)
        {
            using var res = await Call(HttpMethod.Delete, baseUrl + Uri.EscapeDataString(name));
            if (!res.IsSuccessStatusCode && res.StatusCode != HttpStatusCode.NotFound) throw Fail("DELETE", res);
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    // ---------- Windows-Freigabe / NAS (SMB, über smbclient) ----------

    private sealed partial class SmbDriver(string work, string conf, string authFile, string service, string address, string dir) : ITargetDriver
    {
        [GeneratedRegex("NT_STATUS_[A-Z_]+")] private static partial Regex NtStatus();
        [GeneratedRegex(@"^ {2}(\S.*?)\s+[A-Z]*\s+\d+\s+\w{3} \w{3}")] private static partial Regex LsLine();

        private static readonly (Regex Pattern, string Message)[] Errors =
        [
            (new Regex("LOGON_FAILURE|WRONG_PASSWORD|ACCOUNT_"), "Benutzername oder Passwort falsch."),
            (new Regex("BAD_NETWORK_NAME"), "Die Freigabe wurde auf dem Server nicht gefunden. Bitte den Freigabenamen prüfen."),
            (new Regex("ACCESS_DENIED"), "Keine Berechtigung, in diese Freigabe zu schreiben."),
            (new Regex("OBJECT_PATH_NOT_FOUND|OBJECT_NAME_NOT_FOUND"), "Der Ordner in der Freigabe wurde nicht gefunden."),
            (new Regex("DISK_FULL"), "Kein Speicherplatz mehr frei."),
            (new Regex("HOST_UNREACHABLE|NETWORK_UNREACHABLE|IO_TIMEOUT|CONNECTION_REFUSED|Connection to .* failed|resolve", RegexOptions.IgnoreCase), "Der Server ist nicht erreichbar. Bitte Namen bzw. IP-Adresse prüfen."),
        ];

        private static async Task WritePrivate(string path, string content)
        {
            var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            await using var fs = new FileStream(path, options);
            await fs.WriteAsync(Encoding.UTF8.GetBytes(content));
        }

        public static async Task<SmbDriver> Open(SmbTargetConfig config, IReadOnlyDictionary<string, string> secrets)
        {
            // smbclient verbindet mit -I nur zu dieser Adresse; der Name dient nur noch als Servername der Freigabe
            var address = (await PinnedAddress(config.Host, "Server")).ToString();
            // Eigenes Arbeitsverzeichnis in /tmp (Container-Dateisystem ist schreibgeschützt); Zugangsdaten nur in einer Datei mit 0600
            var work = Directory.CreateTempSubdirectory("bastion-smb-").FullName;
            var conf = Path.Combine(work, "smb.conf");
            var authFile = Path.Combine(work, "auth");
            await File.WriteAllTextAsync(conf, string.Join('\n',
                "[global]", $"cache directory = {work}", $"lock directory = {work}", $"state directory = {work}", $"private dir = {work}", $"ncalrpc dir = {work}", "client min protocol = SMB2", ""));
            await WritePrivate(authFile,
                $"username = {(config.Username.Length > 0 ? config.Username : "guest")}\npassword = {secrets.GetValueOrDefault("password") ?? ""}\n{(config.Domain.Length > 0 ? $"domain = {config.Domain}\n" : "")}");
            var dir = Regex.Replace(config.Path, @"[\\/]+", "/").Trim('/');
            var driver = new SmbDriver(work, conf, authFile, $"//{config.Host}/{config.Share}", address, dir);
            try
            {
                // Ordner Ebene für Ebene anlegen; "existiert bereits" ist kein Fehler
                var current = "";
                foreach (var part in dir.Length > 0 ? dir.Split('/') : [])
                {
                    try { await driver.Run($"mkdir \"{part}\"", current); }
                    catch (TargetException e) when (e.Status == "NT_STATUS_OBJECT_NAME_COLLISION") { }
                    current = current.Length > 0 ? $"{current}/{part}" : part;
                }
                await driver.Run("ls");
            }
            catch
            {
                await driver.DisposeAsync();
                throw;
            }
            return driver;
        }

        private async Task<string> Run(string command, string? cwd = null)
        {
            cwd ??= dir;
            var psi = new ProcessStartInfo("smbclient")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var a in new[] { "-s", conf, service, "-I", address, "-A", authFile, "-m", "SMB3", "-t", "60", "-c", cwd.Length > 0 ? $"cd \"{cwd}\"; {command}" : command })
                psi.ArgumentList.Add(a);
            Process process;
            try
            {
                process = Process.Start(psi) ?? throw new Win32Exception();
            }
            catch (Win32Exception)
            {
                throw new TargetException("Windows-Freigaben werden von diesem Bastion-Image nicht unterstützt (smbclient fehlt).");
            }
            using (process)
            {
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(180));
                var timedOut = false;
                try { await process.WaitForExitAsync(cts.Token); }
                catch (OperationCanceledException)
                {
                    timedOut = true;
                    try { process.Kill(entireProcessTree: true); } catch { /* bereits beendet */ }
                }
                var outText = await stdout;
                var output = $"{outText}\n{await stderr}";
                var status = NtStatus().Match(output) is { Success: true } m ? m.Value : null;
                if (timedOut || process.ExitCode != 0 || status is not null)
                {
                    var hit = Errors.FirstOrDefault(x => x.Pattern.IsMatch(output));
                    var last = output.Trim().Split('\n').LastOrDefault();
                    throw new TargetException(hit.Message ?? $"Windows-Freigabe meldet Fehler: {status ?? (string.IsNullOrEmpty(last) ? "unbekannt" : last)}", null, status);
                }
                return outText;
            }
        }

        public async Task Put(string name, byte[] data)
        {
            var local = Path.Combine(work, "upload");
            await File.WriteAllBytesAsync(local, data);
            try
            {
                await Run($"put \"{local}\" \".{name}.part\"");
                try { await Run($"del \"{name}\""); } catch (TargetException) { /* gibt es noch nicht */ }
                await Run($"rename \".{name}.part\" \"{name}\"");
            }
            finally
            {
                File.Delete(local);
            }
        }

        public async Task<List<string>> List()
        {
            var output = await Run("ls");
            return output.Split('\n')
                .Select(l => LsLine().Match(l.TrimEnd('\r')))
                .Where(m => m.Success)
                .Select(m => m.Groups[1].Value)
                .Where(n => n is not "." and not "..")
                .ToList();
        }

        public Task Remove(string name) => Run($"del \"{name}\"");

        public ValueTask DisposeAsync()
        {
            try { Directory.Delete(work, recursive: true); } catch { /* egal */ }
            return ValueTask.CompletedTask;
        }
    }
}
