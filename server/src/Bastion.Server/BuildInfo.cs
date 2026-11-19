namespace Bastion.Server;

/// <summary>
/// Versionsangaben. Im Container liegen VERSION, BUILD_COMMIT und BUILD_DATE neben der Anwendung,
/// in der Entwicklung liegt VERSION im Bastion-Ordner.
/// </summary>
public static class BuildInfo
{
    private static string? Read(string name)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; dir is not null && i < 8; i++, dir = dir.Parent)
        {
            var file = Path.Combine(dir.FullName, name);
            if (File.Exists(file))
            {
                var text = File.ReadAllText(file).Trim();
                return text.Length > 0 ? text : null;
            }
        }
        return null;
    }

    public static readonly string Version = Read("VERSION") ?? "0.0.0";
    public static readonly string? Commit = Read("BUILD_COMMIT");
    public static readonly string? BuiltAt = Read("BUILD_DATE");

    public static object Public => new { version = Version, commit = (string?)null, builtAt = (string?)null };
    public static object Full => new { version = Version, commit = Commit, builtAt = BuiltAt };
}
