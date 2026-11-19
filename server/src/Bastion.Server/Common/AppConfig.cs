namespace Bastion.Server.Common;

/// <summary>
/// Konfiguration aus Umgebungsvariablen (.env). Ungültige Werte beenden den Start mit einer verständlichen Meldung;
/// insbesondere werden Platzhalter und zu gleichförmige Werte für APP_SECRET abgelehnt.
/// </summary>
public sealed class AppConfig
{
    public required string DatabaseUrl { get; init; }
    public required string AppSecret { get; init; }
    public required string PublicUrl { get; init; }
    public required string PublicOrigin { get; init; }
    public required IReadOnlySet<string> AllowedOrigins { get; init; }
    public int Port { get; init; } = 3000;
    public bool CookieSecure { get; init; } = true;
    public int TrustProxy { get; init; } = 1;
    public int SessionIdleMinutes { get; init; } = 30;
    public int SessionMaxHours { get; init; } = 12;
    public int InviteValidityHours { get; init; } = 72;
    /// <summary>Tage, die gelöschte Einträge im Papierkorb bleiben, bevor sie endgültig entfernt werden.</summary>
    public int TrashRetentionDays { get; init; } = 30;
    public string? InitialAdminPassword { get; init; }
    public bool HibpEnabled { get; init; } = true;
    public required string WebDist { get; init; }
    public string EmergencyBackupDir { get; init; } = "/backup";

    /// <summary>Name des Session-Cookies; mit Secure-Cookies als __Host-Cookie (nur HTTPS, ohne Domain, Pfad /).</summary>
    public string SessionCookie => CookieSecure ? "__Host-bastion_sid" : "bastion_sid";
    public string DeviceCookie => CookieSecure ? "__Host-bastion_device" : "bastion_device";

    public static AppConfig Load(Func<string, string?> env)
    {
        var errors = new List<string>();
        string? Get(string key) => string.IsNullOrEmpty(env(key)) ? null : env(key);

        int Int(string key, int def, int min, int max)
        {
            var raw = Get(key);
            if (raw is null) return def;
            if (!int.TryParse(raw, out var v) || v < min || v > max) { errors.Add($"{key}: ganze Zahl zwischen {min} und {max} erwartet"); return def; }
            return v;
        }
        bool Bool(string key, bool def)
        {
            var raw = Get(key);
            if (raw is null) return def;
            if (raw is "true" or "1") return true;
            if (raw is "false" or "0") return false;
            errors.Add($"{key}: true/false erwartet");
            return def;
        }

        var databaseUrl = Get("DATABASE_URL");
        if (databaseUrl is null) errors.Add("DATABASE_URL: fehlt");

        var secret = Get("APP_SECRET") ?? "";
        if (secret.Length < 32) errors.Add("APP_SECRET: APP_SECRET muss mindestens 32 Zeichen lang sein");
        else if (secret.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase)) errors.Add("APP_SECRET: APP_SECRET ist noch der Platzhalter aus .env.example");
        else if (secret.Distinct().Count() < 16) errors.Add("APP_SECRET: APP_SECRET ist zu gleichförmig, bitte zufällig erzeugen (openssl rand -base64 48)");

        var publicUrl = Get("PUBLIC_URL") ?? "https://localhost";
        var origin = "";
        if (!Uri.TryCreate(publicUrl, UriKind.Absolute, out var uri)) errors.Add("PUBLIC_URL: gültige URL erwartet");
        else origin = uri.GetLeftPart(UriPartial.Authority);

        var allowed = new HashSet<string>(StringComparer.Ordinal) { origin };
        foreach (var o in (Get("ALLOWED_ORIGINS") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) allowed.Add(o);

        var initial = Get("INITIAL_ADMIN_PASSWORD");
        if (initial is not null && initial.Length < 16) errors.Add("INITIAL_ADMIN_PASSWORD: mindestens 16 Zeichen");

        var config = new AppConfig
        {
            DatabaseUrl = databaseUrl ?? "",
            AppSecret = secret,
            PublicUrl = publicUrl,
            PublicOrigin = origin,
            AllowedOrigins = allowed,
            Port = Int("PORT", 3000, 1, 65535),
            CookieSecure = Bool("COOKIE_SECURE", true),
            TrustProxy = Int("TRUST_PROXY", 1, 0, 10),
            SessionIdleMinutes = Int("SESSION_IDLE_MINUTES", 30, 5, 480),
            SessionMaxHours = Int("SESSION_MAX_HOURS", 12, 1, 72),
            InviteValidityHours = Int("INVITE_VALIDITY_HOURS", 72, 1, 720),
            TrashRetentionDays = Int("TRASH_RETENTION_DAYS", 30, 1, 365),
            InitialAdminPassword = initial,
            HibpEnabled = Bool("HIBP_ENABLED", true),
            WebDist = Get("WEB_DIST") ?? Path.Combine(AppContext.BaseDirectory, "public"),
            EmergencyBackupDir = Get("EMERGENCY_BACKUP_DIR") ?? "/backup",
        };
        if (errors.Count > 0) throw new InvalidOperationException("Ungültige Konfiguration:\n" + string.Join("\n", errors.Select(e => " - " + e)));
        return config;
    }

    /// <summary>Wandelt eine postgresql://-URL in einen Npgsql-Verbindungsstring um.</summary>
    public static string ToNpgsql(string url)
    {
        if (!url.StartsWith("postgres", StringComparison.OrdinalIgnoreCase)) return url;
        var u = new Uri(url);
        var userInfo = u.UserInfo.Split(':', 2);
        var b = new Npgsql.NpgsqlConnectionStringBuilder
        {
            Host = u.Host,
            Port = u.Port > 0 ? u.Port : 5432,
            Database = Uri.UnescapeDataString(u.AbsolutePath.TrimStart('/')),
            Username = Uri.UnescapeDataString(userInfo[0]),
            Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : null,
        };
        return b.ConnectionString;
    }
}
