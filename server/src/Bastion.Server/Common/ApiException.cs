using System.Net;

namespace Bastion.Server.Common;

/// <summary>
/// Fachlicher Fehler mit HTTP-Status und stabilem Fehlercode (z. B. FORBIDDEN, REVISION_CONFLICT).
/// Der Web-Client übersetzt den Code; Antworten enthalten nie Stacktraces.
/// </summary>
public class ApiException(HttpStatusCode status, string code, object? issues = null) : Exception(code)
{
    public HttpStatusCode Status { get; } = status;
    public string Code { get; } = code;
    public object? Issues { get; } = issues;

    public static ApiException BadRequest(string code) => new(HttpStatusCode.BadRequest, code);
    public static ApiException Unauthorized(string code) => new(HttpStatusCode.Unauthorized, code);
    public static ApiException Forbidden(string code = "FORBIDDEN") => new(HttpStatusCode.Forbidden, code);
    public static ApiException NotFound(string code) => new(HttpStatusCode.NotFound, code);
    public static ApiException Conflict(string code) => new(HttpStatusCode.Conflict, code);
    public static ApiException Gone(string code) => new(HttpStatusCode.Gone, code);
    public static ApiException TooManyRequests() => new(HttpStatusCode.TooManyRequests, "TOO_MANY_REQUESTS");
    public static ApiException ServiceUnavailable(string code) => new(HttpStatusCode.ServiceUnavailable, code);
}

/// <summary>Einheitliches Fehlerformat { statusCode, message, error } (kompatibel zum Web-Client und zur Erweiterung).</summary>
public static class ErrorResponses
{
    private static readonly Dictionary<int, string> Names = new()
    {
        [400] = "Bad Request",
        [401] = "Unauthorized",
        [403] = "Forbidden",
        [404] = "Not Found",
        [409] = "Conflict",
        [410] = "Gone",
        [413] = "Payload Too Large",
        [429] = "Too Many Requests",
        [500] = "Internal Server Error",
        [503] = "Service Unavailable",
    };

    public static object Body(int status, string message, object? issues = null) =>
        issues is null
            ? new { message, error = Names.GetValueOrDefault(status, "Error"), statusCode = status }
            : new { message, issues, error = Names.GetValueOrDefault(status, "Error"), statusCode = status };

    public static Task Write(HttpContext ctx, int status, string message, object? issues = null)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.Headers.CacheControl = "no-store";
        return ctx.Response.WriteAsJsonAsync(Body(status, message, issues), Json.Options);
    }
}

/// <summary>Fängt Fehler ab und schreibt sie im einheitlichen Format; unerwartete Fehler nur ins Server-Log.</summary>
public sealed class ErrorHandlingMiddleware(RequestDelegate next, ILogger<ErrorHandlingMiddleware> logger)
{
    public async Task Invoke(HttpContext ctx)
    {
        try
        {
            await next(ctx);
        }
        catch (ApiException e) when (!ctx.Response.HasStarted)
        {
            await ErrorResponses.Write(ctx, (int)e.Status, e.Code, e.Issues);
        }
        catch (BadHttpRequestException e) when (!ctx.Response.HasStarted)
        {
            await ErrorResponses.Write(ctx, e.StatusCode, e.StatusCode == 413 ? "Payload Too Large" : "BAD_REQUEST");
        }
        catch (Exception e) when (!ctx.Response.HasStarted && e is not OperationCanceledException)
        {
            logger.LogError(e, "Unerwarteter Fehler bei {Method} {Path}", ctx.Request.Method, ctx.Request.Path);
            await ErrorResponses.Write(ctx, 500, "Internal server error");
        }
    }
}
