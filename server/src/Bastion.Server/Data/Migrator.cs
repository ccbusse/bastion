using System.Reflection;
using System.Text.RegularExpressions;
using Bastion.Server.Common;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Bastion.Server.Data;

/// <summary>
/// Datenbankschema und Datenbankkonto der Anwendung. Läuft im einmaligen Migrationsdienst mit dem Eigentümer-Konto
/// (DATABASE_URL), nie im Anwendungsprozess.
/// <para>
/// Migrationen sind nummerierte SQL-Dateien in Data/Migrations (eingebettet), angewendet in Reihenfolge und je Datei in
/// einer Transaktion; Buch geführt wird in der Tabelle schema_migrations. Neue Migrationen entstehen aus dem Vergleich
/// von "Bastion.Server schema" (SQL des aktuellen Datenmodells) mit dem bisherigen Stand.
/// </para>
/// <para>
/// Das Anwendungskonto darf nur Daten lesen und schreiben: Es besitzt keine Tabellen, kann daher keine Trigger
/// abschalten und das Audit-Log weder ändern noch löschen.
/// </para>
/// </summary>
public static partial class Migrator
{
    [GeneratedRegex("^[a-z_][a-z0-9_]{0,62}$")]
    private static partial Regex RoleName();

    public static async Task<int> Run(string command, Func<string, string?> env)
    {
        try
        {
            if (command == "schema")
            {
                var options = new DbContextOptionsBuilder<BastionDb>();
                BastionDb.Configure(options, "Host=localhost");
                await using var db = new BastionDb(options.Options);
                Console.WriteLine(db.Database.GenerateCreateScript());
                return 0;
            }
            var url = env("DATABASE_URL");
            if (string.IsNullOrEmpty(url)) throw new InvalidOperationException("DATABASE_URL fehlt");
            await using var conn = new NpgsqlConnection(AppConfig.ToNpgsql(url));
            await conn.OpenAsync();
            await ApplyMigrations(conn);
            await SetupAppRole(conn, env("APP_DB_USER") ?? "bastion_app", env("APP_DB_PASSWORD") ?? "");
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"Migration fehlgeschlagen: {e.Message}");
            return 1;
        }
    }

    public static IEnumerable<(string Id, string Sql)> Migrations()
    {
        var asm = Assembly.GetExecutingAssembly();
        const string prefix = "Bastion.Server.Data.Migrations.";
        foreach (var name in asm.GetManifestResourceNames().Where(n => n.StartsWith(prefix, StringComparison.Ordinal) && n.EndsWith(".sql", StringComparison.Ordinal)).Order(StringComparer.Ordinal))
        {
            using var stream = asm.GetManifestResourceStream(name)!;
            using var reader = new StreamReader(stream);
            yield return (name[prefix.Length..^4], reader.ReadToEnd());
        }
    }

    private static async Task ApplyMigrations(NpgsqlConnection conn)
    {
        await Exec(conn, "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
        // Parallel startende Migrationsdienste nacheinander
        await Exec(conn, "SELECT pg_advisory_lock(7420002)");
        try
        {
            var applied = new HashSet<string>();
            await using (var cmd = new NpgsqlCommand("SELECT id FROM schema_migrations", conn))
            await using (var reader = await cmd.ExecuteReaderAsync())
                while (await reader.ReadAsync()) applied.Add(reader.GetString(0));

            foreach (var (id, sql) in Migrations())
            {
                if (applied.Contains(id)) continue;
                await using var tx = await conn.BeginTransactionAsync();
                await using (var cmd = new NpgsqlCommand(sql, conn, tx)) await cmd.ExecuteNonQueryAsync();
                await using (var cmd = new NpgsqlCommand("INSERT INTO schema_migrations (id) VALUES (@id)", conn, tx))
                {
                    cmd.Parameters.AddWithValue("id", id);
                    await cmd.ExecuteNonQueryAsync();
                }
                await tx.CommitAsync();
                Console.WriteLine($"Migration angewendet: {id}");
            }
        }
        finally
        {
            await Exec(conn, "SELECT pg_advisory_unlock(7420002)");
        }
    }

    private static async Task SetupAppRole(NpgsqlConnection conn, string role, string password)
    {
        if (!RoleName().IsMatch(role)) throw new InvalidOperationException("APP_DB_USER ungültig");
        if (password.Length < 24 || password.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("APP_DB_PASSWORD fehlt oder ist zu schwach (mindestens 24 Zeichen, z. B. openssl rand -base64 32)");

        var ident = Ident(role);
        await using var tx = await conn.BeginTransactionAsync();
        string database;
        await using (var cmd = new NpgsqlCommand("SELECT current_database()", conn, tx)) database = Ident((string)(await cmd.ExecuteScalarAsync())!);
        bool exists;
        await using (var cmd = new NpgsqlCommand("SELECT 1 FROM pg_roles WHERE rolname = @r", conn, tx))
        {
            cmd.Parameters.AddWithValue("r", role);
            exists = await cmd.ExecuteScalarAsync() is not null;
        }
        if (!exists) await Exec(conn, $"CREATE ROLE {ident} LOGIN", tx);
        await Exec(conn, $"ALTER ROLE {ident} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {Literal(password)}", tx);
        await Exec(conn, $"GRANT CONNECT ON DATABASE {database} TO {ident}", tx);
        await Exec(conn, $"GRANT USAGE ON SCHEMA public TO {ident}", tx);
        await Exec(conn, $"REVOKE CREATE ON SCHEMA public FROM {ident}", tx);
        await Exec(conn, $"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {ident}", tx);
        await Exec(conn, $"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {ident}", tx);
        // Audit-Log: nur anhängen
        await Exec(conn, $"REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM {ident}", tx);
        await Exec(conn, $"REVOKE ALL ON schema_migrations FROM {ident}", tx);
        await Exec(conn, $"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {ident}", tx);
        await tx.CommitAsync();
        Console.WriteLine($"Datenbankkonto \"{role}\" eingerichtet (nur Datenzugriff, Audit-Log nur anhängen).");
    }

    private static async Task Exec(NpgsqlConnection conn, string sql, NpgsqlTransaction? tx = null)
    {
        await using var cmd = new NpgsqlCommand(sql, conn, tx);
        await cmd.ExecuteNonQueryAsync();
    }

    private static string Ident(string s) => "\"" + s.Replace("\"", "\"\"") + "\"";
    private static string Literal(string s) => "'" + s.Replace("'", "''") + "'";
}
