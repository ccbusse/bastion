using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Bastion.Server.Common;

/// <summary>Ziel zeigt auf eine gesperrte Adresse (siehe <see cref="NetGuard"/>).</summary>
public sealed class BlockedDestinationException(string host) : Exception("DESTINATION_NOT_ALLOWED")
{
    public string Host { get; } = host;
}

/// <summary>
/// Schutz vor Server-Side Request Forgery bei frei konfigurierbaren Zielen (Notfall-Backup-Ziele, SMTP):
/// Gesperrt sind Loopback, Link-Local (u. a. Cloud-Metadaten 169.254.169.254), unspezifizierte und Multicast-Adressen
/// sowie die Netze, an denen der Bastion-Container selbst hängt (Docker-Netze mit Datenbank und Reverse-Proxy).
/// Private Netze im Übrigen bleiben erlaubt, da NAS und Fileserver typischerweise dort stehen.
/// Schutz gegen DNS-Rebinding: Verbindungen werden nur zu den Adressen aufgebaut, die bei der Prüfung aufgelöst wurden
/// (<see cref="ResolveAllowed"/>, <see cref="Connect"/>); ein Name wird zwischen Prüfung und Verbindung nicht neu aufgelöst.
/// </summary>
public static class NetGuard
{
    private static readonly (uint Net, int Prefix)[] StaticV4 =
    [
        (V4("0.0.0.0"), 8),
        (V4("127.0.0.0"), 8),
        (V4("169.254.0.0"), 16),
        (V4("224.0.0.0"), 4),
        (V4("255.255.255.255"), 32),
    ];

    private static uint V4(string ip) => V4(IPAddress.Parse(ip));

    private static uint V4(IPAddress ip)
    {
        var b = ip.GetAddressBytes();
        return ((uint)b[0] << 24) | ((uint)b[1] << 16) | ((uint)b[2] << 8) | b[3];
    }

    internal static bool InNet(uint ip, uint net, int prefix) => prefix == 0 || (ip ^ net) >> (32 - prefix) == 0;

    /// <summary>Eigene Netze des Containers (ohne Loopback, das ist ohnehin gesperrt).</summary>
    private static IEnumerable<(uint Net, int Prefix)> OwnNetworks()
    {
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var a in nic.GetIPProperties().UnicastAddresses)
            {
                if (a.Address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(a.Address)) continue;
                yield return (V4(a.Address), a.PrefixLength);
            }
        }
    }

    internal static bool BlockedV4(IPAddress ip, IEnumerable<(uint Net, int Prefix)>? own = null)
    {
        var n = V4(ip);
        return StaticV4.Concat(own ?? OwnNetworks()).Any(x => InNet(n, x.Net, x.Prefix));
    }

    internal static bool BlockedV6(IPAddress ip, IEnumerable<(uint Net, int Prefix)>? own = null)
    {
        if (ip.IsIPv4MappedToIPv6) return BlockedV4(ip.MapToIPv4(), own);
        var b = ip.GetAddressBytes();
        return ip.Equals(IPAddress.IPv6Any) || ip.Equals(IPAddress.IPv6Loopback)
            || (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) // fe80::/10 Link-Local
            || b[0] == 0xff; // Multicast
    }

    public static bool IsBlocked(IPAddress ip) =>
        ip.AddressFamily == AddressFamily.InterNetwork ? BlockedV4(ip) : BlockedV6(ip);

    private static bool IsLocalName(string lower) =>
        lower is "localhost" or "localhost." || lower.EndsWith(".localhost", StringComparison.Ordinal) || lower.EndsWith(".localhost.", StringComparison.Ordinal);

    private static string Clean(string rawHost) => rawHost.Trim().TrimStart('[').TrimEnd(']');

    /// <summary>Namensauflösung (in Tests austauschbar).</summary>
    internal static Func<string, CancellationToken, Task<IPAddress[]>> Resolver { get; set; } = (host, ct) => Dns.GetHostAddressesAsync(host, ct);

    /// <summary>Wirft <see cref="BlockedDestinationException"/>, wenn der Host auf eine gesperrte Adresse zeigt. Nicht auflösbare Namen scheitern später beim Verbinden.</summary>
    public static async Task AssertAllowedHost(string rawHost)
    {
        try { await ResolveAllowed(rawHost); }
        catch (SocketException) { /* nicht auflösbar: Fehler erst beim Verbinden */ }
    }

    /// <summary>
    /// Löst den Host einmal auf und prüft alle Adressen. Zeigt eine davon auf ein gesperrtes Netz, wird
    /// <see cref="BlockedDestinationException"/> geworfen; nicht auflösbare Namen ergeben eine <see cref="SocketException"/>
    /// (HostNotFound). Die Verbindung muss anschließend genau zu einer der gelieferten Adressen aufgebaut werden.
    /// </summary>
    public static async Task<IPAddress[]> ResolveAllowed(string rawHost, CancellationToken ct = default)
    {
        var host = Clean(rawHost);
        if (host.Length == 0) throw new SocketException((int)SocketError.HostNotFound);
        if (IsLocalName(host.ToLowerInvariant())) throw new BlockedDestinationException(host);
        IPAddress[] addrs;
        if (IPAddress.TryParse(host, out var literal)) addrs = [literal];
        else
        {
            try { addrs = await Resolver(host, ct); }
            catch (SocketException) { addrs = []; }
        }
        if (addrs.Length == 0) throw new SocketException((int)SocketError.HostNotFound);
        foreach (var a in addrs)
            if (IsBlocked(a)) throw new BlockedDestinationException(host);
        return addrs;
    }

    /// <summary>TCP-Verbindung zu einer bei der Prüfung aufgelösten Adresse (siehe <see cref="ResolveAllowed"/>).</summary>
    public static async Task<Socket> Connect(string host, int port, CancellationToken ct = default)
    {
        Exception? last = null;
        foreach (var a in await ResolveAllowed(host, ct))
        {
            var socket = new Socket(a.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(new IPEndPoint(a, port), ct);
                return socket;
            }
            catch (SocketException e)
            {
                socket.Dispose();
                last = e;
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }
        throw last ?? new SocketException((int)SocketError.HostNotFound);
    }

    /// <summary>Für <see cref="SocketsHttpHandler.ConnectCallback"/>: HTTP-Verbindungen nur zu geprüften Adressen.</summary>
    public static async ValueTask<Stream> HttpConnect(SocketsHttpConnectionContext context, CancellationToken ct) =>
        new NetworkStream(await Connect(context.DnsEndPoint.Host, context.DnsEndPoint.Port, ct), ownsSocket: true);
}
