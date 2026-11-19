using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Bastion.Server.Common;

public static class Json
{
    /// <summary>JSON wie im Web-Client erwartet: camelCase, Enums als Text, Nullwerte werden geschrieben.</summary>
    public static readonly JsonSerializerOptions Options = Configure(new JsonSerializerOptions(JsonSerializerDefaults.Web));

    public static JsonSerializerOptions Configure(JsonSerializerOptions o)
    {
        o.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        o.DictionaryKeyPolicy = null;
        o.Converters.Add(new JsonStringEnumConverter());
        o.Converters.Add(new IsoDateTimeConverter());
        o.Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;
        o.NumberHandling = JsonNumberHandling.Strict;
        return o;
    }

    public static string Serialize(object? value) => JsonSerializer.Serialize(value, Options);

    /// <summary>Wie <see cref="Serialize"/>, aber ohne Felder mit null (entspricht undefined in JavaScript; für Audit-Metadaten).</summary>
    public static string SerializeCompact(object? value) => JsonSerializer.Serialize(value, CompactOptions);

    private static readonly JsonSerializerOptions CompactOptions = new(Options) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    public static JsonNode? Parse(string? json) => string.IsNullOrEmpty(json) ? null : JsonNode.Parse(json);

    /// <summary>
    /// Deterministische Serialisierung (sortierte Schlüssel, keine Leerzeichen) für die Audit-Hash-Kette.
    /// Die Ausgabe hängt nur vom Inhalt ab, nicht von der Reihenfolge der Schlüssel – so ergibt der aus der Datenbank
    /// (jsonb) gelesene Wert denselben Hash wie beim Schreiben.
    /// </summary>
    public static string Stable(JsonNode? node)
    {
        switch (node)
        {
            case null:
                return "null";
            case JsonArray arr:
                return "[" + string.Join(",", arr.Select(Stable)) + "]";
            case JsonObject obj:
                return "{" + string.Join(",", obj
                    .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                    .Select(kv => JsonSerializer.Serialize(kv.Key, Options) + ":" + Stable(kv.Value))) + "}";
            default:
                return node.ToJsonString(Options);
        }
    }
}

/// <summary>Zeitpunkte wie in JavaScript (Date.toISOString): UTC mit Millisekunden, z. B. 2026-11-06T09:30:00.000Z.</summary>
public sealed class IsoDateTimeConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetDateTimeOffset().UtcDateTime;

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options) =>
        writer.WriteStringValue(DateTime.SpecifyKind(value, value.Kind == DateTimeKind.Unspecified ? DateTimeKind.Utc : value.Kind)
            .ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture));
}
