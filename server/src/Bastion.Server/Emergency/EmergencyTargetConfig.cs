using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Bastion.Server.Common;
using Bastion.Server.Data;

namespace Bastion.Server.Emergency;

/// <summary>Einstellungen eines Speicherziels (nicht geheim). Zugangsdaten liegen getrennt und verschlüsselt (secretsEnc).</summary>
public abstract record TargetConfig
{
    /// <summary>Vorlage, aus der das Ziel in der Oberfläche angelegt wurde, und deren einfache Eingaben (nur zur Anzeige und Bearbeitung).</summary>
    public string? Preset { get; init; }
    public JsonObject? Simple { get; init; }

    /// <summary>Normalisierte Darstellung zum Speichern (Standardwerte ergänzt, unbekannte Felder entfernt).</summary>
    public JsonObject ToJson()
    {
        var o = new JsonObject();
        foreach (var (k, v) in Fields()) o[k] = v switch
        {
            null => null,
            string s => JsonValue.Create(s),
            int i => JsonValue.Create(i),
            bool b => JsonValue.Create(b),
            _ => throw new InvalidOperationException(),
        };
        if (Preset is not null) o["preset"] = Preset;
        if (Simple is not null) o["simple"] = Simple.DeepClone();
        return o;
    }

    /// <summary>Felder in Reihenfolge (camelCase).</summary>
    public abstract IEnumerable<(string Key, object? Value)> Fields();

    public object? Get(string key) => Fields().FirstOrDefault(f => f.Key == key).Value;
}

public sealed record FolderTargetConfig(string Path) : TargetConfig
{
    public override IEnumerable<(string, object?)> Fields() => [("path", Path)];
}

public sealed record SmbTargetConfig(string Host, string Share, string Path, string Username, string Domain) : TargetConfig
{
    public override IEnumerable<(string, object?)> Fields() => [("host", Host), ("share", Share), ("path", Path), ("username", Username), ("domain", Domain)];
}

public sealed record SftpTargetConfig(string Host, int Port, string Username, string Path, string? HostKey) : TargetConfig
{
    public override IEnumerable<(string, object?)> Fields() => [("host", Host), ("port", Port), ("username", Username), ("path", Path), ("hostKey", HostKey)];
}

public sealed record WebDavTargetConfig(string Url, string Username) : TargetConfig
{
    public override IEnumerable<(string, object?)> Fields() => [("url", Url), ("username", Username)];
}

/// <summary>Prüfung der Ziel-Einstellungen und Zugangsdaten (entspricht den bisherigen Schemas je Zieltyp).</summary>
public static partial class TargetSchemas
{
    [GeneratedRegex(@"^[A-Za-z0-9.\-:\[\]]+$")] private static partial Regex HostPattern();
    // Windows-Freigabe: keine Anführungszeichen o. ä., da Pfade an smbclient übergeben werden
    [GeneratedRegex("^[^\"\\\\/:*?<>|;]*$")] private static partial Regex SmbName();
    [GeneratedRegex("^[^\"*?<>|;:]*$")] private static partial Regex SmbPath();
    [GeneratedRegex("^[^\"\n]*$")] private static partial Regex NoQuoteLine();
    [GeneratedRegex("^SHA256:[A-Za-z0-9+/]{43}$")] private static partial Regex SshFingerprint();
    [GeneratedRegex("^[^\n]*$")] private static partial Regex SingleLine();

    private sealed class Reader(JsonObject o, List<object> issues)
    {
        private void Issue(string path, string message) => issues.Add(new { path, message });

        private JsonNode? Node(string key, out bool present)
        {
            present = o.TryGetPropertyValue(key, out var n);
            return n;
        }

        /// <summary>Text (getrimmt). Fehlt das Feld, gilt <paramref name="def"/>; ohne Standardwert ist es Pflicht.</summary>
        public string? Str(string key, string? def = null, int min = 0, int max = int.MaxValue, Regex? pattern = null, bool nullable = false, bool hasDefault = false, string message = "invalid format")
        {
            var n = Node(key, out var present);
            if (!present) { if (hasDefault || def is not null) return def; Issue(key, "required"); return null; }
            if (n is null) { if (nullable) return null; Issue(key, "expected string"); return null; }
            if (n is not JsonValue v || !v.TryGetValue<string>(out var s)) { Issue(key, "expected string"); return null; }
            s = s.Trim();
            if (s.Length < min) Issue(key, $"at least {min} characters expected");
            else if (s.Length > max) Issue(key, $"at most {max} characters expected");
            else if (pattern is not null && !pattern.IsMatch(s)) Issue(key, message);
            return s;
        }

        public int Int(string key, int def, int min, int max)
        {
            var n = Node(key, out var present);
            if (!present) return def;
            if (n is JsonValue v && v.GetValueKind() == JsonValueKind.Number && v.TryGetValue<int>(out var i))
            {
                if (i < min || i > max) Issue(key, $"number between {min} and {max} expected");
                return i;
            }
            Issue(key, "expected integer");
            return def;
        }

        public bool Bool(string key, bool def)
        {
            var n = Node(key, out var present);
            if (!present) return def;
            if (n is JsonValue v && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False) return v.GetValue<bool>();
            Issue(key, "expected boolean");
            return def;
        }

        public string? HttpUrl(string key, bool nullable, string? def)
        {
            var s = Str(key, def, 0, 1000, nullable: nullable, hasDefault: nullable);
            if (s is null) return null;
            if (!Uri.TryCreate(s, UriKind.Absolute, out var u) || u.Scheme is not ("http" or "https")) Issue(key, "http(s) URL expected");
            return s;
        }

        public (string? Preset, JsonObject? Simple) Ui()
        {
            var preset = Str("preset", null, 0, 30, nullable: false, hasDefault: true);
            JsonObject? simple = null;
            var n = Node("simple", out var present);
            if (present)
            {
                if (n is not JsonObject so) Issue("simple", "expected object");
                else
                {
                    foreach (var (k, v) in so)
                    {
                        var ok = v is JsonValue jv && (jv.GetValueKind() switch
                        {
                            JsonValueKind.String => jv.GetValue<string>().Length <= 1000,
                            JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => true,
                            _ => false,
                        });
                        if (!ok) Issue($"simple.{k}", "invalid value");
                    }
                    simple = (JsonObject)so.DeepClone();
                }
            }
            return (preset, simple);
        }
    }

    private static ApiException Invalid(List<object> issues) => new(HttpStatusCode.BadRequest, "VALIDATION_FAILED", issues);

    public static TargetConfig ParseConfig(EmergencyTargetType type, JsonNode? raw)
    {
        var issues = new List<object>();
        if (raw is not JsonObject o) throw Invalid([new { path = "", message = "expected object" }]);
        var r = new Reader(o, issues);
        var (preset, simple) = r.Ui();
        TargetConfig cfg = type switch
        {
            EmergencyTargetType.FOLDER => new FolderTargetConfig(r.Str("path", "", 0, 500)!),
            EmergencyTargetType.SMB => new SmbTargetConfig(
                r.Str("host", null, 1, 253, HostPattern(), message: "host expected")!,
                r.Str("share", null, 1, 200, SmbName(), message: "invalid name")!,
                r.Str("path", "", 0, 500, SmbPath(), message: "invalid path")!,
                r.Str("username", "", 0, 200, NoQuoteLine())!,
                r.Str("domain", "", 0, 100, NoQuoteLine())!),
            EmergencyTargetType.SFTP => new SftpTargetConfig(
                r.Str("host", null, 1, 253, HostPattern(), message: "host expected")!,
                r.Int("port", 22, 1, 65535),
                r.Str("username", null, 1, 200)!,
                r.Str("path", "", 0, 500)!,
                // OpenSSH-Format "SHA256:…"; ohne bestätigten Host-Schlüssel wird nichts übertragen
                r.Str("hostKey", null, 0, int.MaxValue, SshFingerprint(), nullable: true, hasDefault: true)),
            _ => new WebDavTargetConfig(r.HttpUrl("url", nullable: false, def: null)!, r.Str("username", "", 0, 200)!),
        };
        if (issues.Count > 0) throw Invalid(issues);
        return cfg with { Preset = preset, Simple = simple };
    }

    /// <summary>Zugangsdaten prüfen; unbekannte Felder werden verworfen.</summary>
    public static Dictionary<string, string> ParseSecrets(EmergencyTargetType type, IReadOnlyDictionary<string, string> raw)
    {
        var issues = new List<object>();
        var output = new Dictionary<string, string>();
        void Opt(string key, int max, Regex? pattern = null, int min = 0, bool required = false)
        {
            if (!raw.TryGetValue(key, out var v))
            {
                if (required) issues.Add(new { path = key, message = "required" });
                return;
            }
            if (v.Length < min || v.Length > max || (pattern is not null && !pattern.IsMatch(v))) issues.Add(new { path = key, message = "invalid value" });
            output[key] = v;
        }
        switch (type)
        {
            case EmergencyTargetType.SMB: Opt("password", 500, SingleLine()); break;
            case EmergencyTargetType.SFTP: Opt("password", 500); Opt("privateKey", 20_000); Opt("passphrase", 500); break;
            case EmergencyTargetType.WEBDAV: Opt("password", 500); break;
        }
        if (issues.Count > 0) throw Invalid(issues);
        return output;
    }

    /// <summary>Felder, an die gespeicherte Zugangsdaten gebunden sind (Ziel der Anmeldung).</summary>
    public static string[] DestinationFields(EmergencyTargetType type) => type switch
    {
        EmergencyTargetType.WEBDAV => ["url", "username"],
        EmergencyTargetType.SFTP => ["host", "port", "username"],
        EmergencyTargetType.SMB => ["host", "share", "username", "domain"],
        _ => [],
    };

    public static bool SameDestination(EmergencyTargetType type, string storedJson, TargetConfig next)
    {
        TargetConfig stored;
        try { stored = ParseConfig(type, JsonNode.Parse(storedJson)); }
        catch (Exception e) when (e is ApiException or JsonException) { return false; }
        return DestinationFields(type).All(k => Equals(stored.Get(k), next.Get(k)));
    }

    /// <summary>Zielangaben ohne Zugangsdaten und Oberflächenhilfen (für das Audit-Log).</summary>
    public static Dictionary<string, object?> DestinationOf(EmergencyTargetType type, TargetConfig cfg)
    {
        var fields = cfg.Fields().ToDictionary(f => f.Key, f => f.Value);
        return DestinationFields(type).Concat(["path", "prefix"])
            .Where(fields.ContainsKey)
            .ToDictionary(k => k, k => fields[k]);
    }
}
