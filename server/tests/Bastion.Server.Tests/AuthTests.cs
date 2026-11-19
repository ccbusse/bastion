using System.Net;
using System.Text;
using Bastion.Server.Auth;
using Bastion.Server.Common;

namespace Bastion.Server.Tests;

internal sealed class ManualTime(DateTimeOffset start) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = start;
    public override DateTimeOffset GetUtcNow() => Now;
    public void Advance(TimeSpan by) => Now += by;
}

public class TotpTests
{
    // RFC 6238, Anhang B (SHA-1): Schlüssel "12345678901234567890", 8-stellige Werte – die letzten 6 Ziffern gelten
    private static readonly string Secret = Totp.Base32Encode(Encoding.ASCII.GetBytes("12345678901234567890"));

    [Theory]
    [InlineData(59, "287082")]
    [InlineData(1111111109, "081804")]
    [InlineData(1234567890, "005924")]
    [InlineData(2000000000, "279037")]
    public void Matches_rfc6238_vectors(long unix, string code)
    {
        var step = Totp.Check(code, Secret, now: DateTimeOffset.FromUnixTimeSeconds(unix));
        Assert.Equal(unix / 30, step);
    }

    [Fact]
    public void Accepts_one_step_of_clock_skew_but_not_more()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1111111109);
        Assert.NotNull(Totp.Check("081804", Secret, now: now.AddSeconds(30)));
        Assert.Null(Totp.Check("081804", Secret, now: now.AddSeconds(90)));
    }

    [Fact]
    public void Rejects_reuse_of_an_accepted_step()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1111111109);
        var step = Totp.Check("081804", Secret, now: now);
        Assert.Null(Totp.Check("081804", Secret, afterStep: step, now: now));
    }

    [Fact]
    public void Rejects_malformed_input()
    {
        Assert.Null(Totp.Check("12345", Secret));
        Assert.Null(Totp.Check("12345a", Secret));
        Assert.Null(Totp.Check("123456", "not base32!"));
    }

    [Fact]
    public void Base32_roundtrip()
    {
        var data = new byte[] { 0, 1, 2, 250, 251, 252, 253, 254, 255, 42 };
        Assert.Equal(data, Totp.Base32Decode(Totp.Base32Encode(data)));
        Assert.Equal(32, Totp.NewSecret().Length);
    }
}

public class LoginThrottleTests
{
    private static (LoginThrottle T, ManualTime Time, MemoryLoginThrottleStore Store) Make()
    {
        var time = new ManualTime(DateTimeOffset.UnixEpoch.AddYears(50));
        var store = new MemoryLoginThrottleStore();
        return (new LoginThrottle(store, new CryptoUtil(CryptoTests.Config()), time), time, store);
    }

    [Fact]
    public async Task Blocks_after_five_failures_and_doubles_the_block()
    {
        var (t, time, _) = Make();
        for (var i = 0; i < 5; i++) { await t.AssertAllowed("k"); await t.Fail("k"); }
        await Assert.ThrowsAsync<ApiException>(() => t.AssertAllowed("k"));
        time.Advance(TimeSpan.FromMinutes(15) + TimeSpan.FromSeconds(1));
        await t.AssertAllowed("k");
        await t.Fail("k");
        time.Advance(TimeSpan.FromMinutes(20));
        await Assert.ThrowsAsync<ApiException>(() => t.AssertAllowed("k"));
        time.Advance(TimeSpan.FromMinutes(11));
        await t.AssertAllowed("k");
        await t.Reset("k");
        await t.AssertAllowed("k");
    }

    [Fact]
    public async Task Block_is_capped_at_24_hours()
    {
        var (t, time, _) = Make();
        for (var i = 0; i < 40; i++) await t.Fail("k");
        time.Advance(TimeSpan.FromHours(24) + TimeSpan.FromSeconds(1));
        await t.AssertAllowed("k");
    }

    [Fact]
    public async Task Counting_restarts_after_a_day_without_failures()
    {
        var (t, time, _) = Make();
        for (var i = 0; i < 4; i++) await t.Fail("k");
        time.Advance(TimeSpan.FromHours(25));
        await t.Fail("k");
        await t.AssertAllowed("k");
    }

    [Fact]
    public async Task Account_limit_counts_per_hour()
    {
        var (t, time, _) = Make();
        for (var i = 1; i <= LoginThrottle.AccountLimit; i++) Assert.Equal(i, await t.AccountFail("a@b.test"));
        await Assert.ThrowsAsync<ApiException>(() => t.AssertAccountAllowed("a@b.test"));
        await t.AssertAccountAllowed("c@d.test");
        time.Advance(TimeSpan.FromMinutes(61));
        await t.AssertAccountAllowed("a@b.test");
        Assert.Equal(1, await t.AccountFail("a@b.test"));
    }

    [Fact]
    public async Task Unknown_address_failures_count_per_ip_and_hour()
    {
        var (t, time, _) = Make();
        for (var i = 1; i <= LoginThrottle.UnknownAuditLimit + 5; i++) Assert.Equal(i, await t.UnknownFail("198.51.100.7"));
        Assert.Equal(1, await t.UnknownFail("198.51.100.8"));
        Assert.Equal(1, await t.UnknownFail(null));
        time.Advance(TimeSpan.FromMinutes(61));
        Assert.Equal(1, await t.UnknownFail("198.51.100.7"));
    }

    [Fact]
    public async Task Keys_are_stored_as_hmac_and_pruned()
    {
        var (t, time, store) = Make();
        for (var i = 0; i < 40; i++) await t.Fail("a@b.test\0198.51.100.7");
        await t.AccountFail("a@b.test");
        Assert.Equal(0, await t.Prune());
        time.Advance(TimeSpan.FromHours(24) + TimeSpan.FromSeconds(1));
        Assert.Equal(2, await t.Prune());
        Assert.Null(await store.Get("a@b.test"));
    }
}

public class DeviceTokenTests
{
    [Fact]
    public void Token_is_bound_to_the_email_address()
    {
        var config = CryptoTests.Config();
        var crypto = new CryptoUtil(config);
        var device = new DeviceToken(crypto, config, null!);
        var ctx = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        var sessions = new SessionService(null!, config, crypto);
        new DeviceToken(crypto, config, sessions).SetCookie(ctx.Response, "a@b.test");
        var header = ctx.Response.Headers.SetCookie.ToString();
        var value = WebUtility.UrlDecode(header.Split(';')[0].Split('=', 2)[1]);

        Assert.Contains("httponly", header, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=strict", header, StringComparison.OrdinalIgnoreCase);
        Assert.NotNull(device.Verify("a@b.test", value));
        Assert.Null(device.Verify("other@b.test", value));
        Assert.Null(device.Verify("a@b.test", value[..^2] + "xx"));
        Assert.Null(device.Verify("a@b.test", null));
    }
}

public class NetGuardTests
{
    private static readonly (uint, int)[] NoOwnNets = [];

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("0.0.0.0")]
    [InlineData("169.254.169.254")]
    [InlineData("224.0.0.1")]
    [InlineData("255.255.255.255")]
    public void Blocks_special_ipv4(string ip) => Assert.True(NetGuard.BlockedV4(IPAddress.Parse(ip), NoOwnNets));

    [Theory]
    [InlineData("10.1.2.3")]
    [InlineData("192.168.1.10")]
    [InlineData("93.184.216.34")]
    public void Allows_lan_and_internet(string ip) => Assert.False(NetGuard.BlockedV4(IPAddress.Parse(ip), NoOwnNets));

    [Fact]
    public void Blocks_own_container_networks()
    {
        (uint, int)[] own = [(0xAC120000u, 16)]; // 172.18.0.0/16
        Assert.True(NetGuard.BlockedV4(IPAddress.Parse("172.18.0.5"), own));
        Assert.False(NetGuard.BlockedV4(IPAddress.Parse("172.19.0.5"), own));
    }

    [Theory]
    [InlineData("::1", true)]
    [InlineData("::", true)]
    [InlineData("fe80::1", true)]
    [InlineData("ff02::1", true)]
    [InlineData("::ffff:127.0.0.1", true)]
    [InlineData("2001:db8::1", false)]
    public void Ipv6(string ip, bool blocked) => Assert.Equal(blocked, NetGuard.BlockedV6(IPAddress.Parse(ip), NoOwnNets));

    [Theory]
    [InlineData("localhost")]
    [InlineData("LOCALHOST.")]
    [InlineData("db.localhost")]
    [InlineData("[::1]")]
    [InlineData("127.0.0.53")]
    public async Task Rejects_local_names(string host) =>
        await Assert.ThrowsAsync<BlockedDestinationException>(() => NetGuard.AssertAllowedHost(host));

    /// <summary>Namensauflösung, die beim ersten Aufruf eine öffentliche, danach eine interne Adresse liefert (DNS-Rebinding).</summary>
    private static async Task WithRebindingDns(Func<Func<int>, Task> test)
    {
        var calls = 0;
        var original = NetGuard.Resolver;
        NetGuard.Resolver = (_, _) => Task.FromResult(Interlocked.Increment(ref calls) == 1 ? new[] { IPAddress.Parse("192.0.2.10") } : [IPAddress.Loopback]);
        try { await test(() => calls); }
        finally { NetGuard.Resolver = original; }
    }

    [Fact]
    public Task Connect_resolves_once_and_uses_the_checked_address() => WithRebindingDns(async calls =>
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        // Verbindungsaufbau zu 192.0.2.10 wird sofort abgebrochen; entscheidend ist, dass nicht erneut aufgelöst wurde
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => NetGuard.Connect("nas.example.test", 445, cts.Token));
        Assert.Equal(1, calls());
        // Eine zweite Auflösung (wie sie ein Treiber mit eigenem Lookup vornähme) zeigte auf Loopback und wird abgelehnt
        await Assert.ThrowsAsync<BlockedDestinationException>(() => NetGuard.ResolveAllowed("nas.example.test"));
    });

    [Fact]
    public async Task Resolve_rejects_any_internal_address_and_unknown_names()
    {
        var original = NetGuard.Resolver;
        try
        {
            NetGuard.Resolver = (_, _) => Task.FromResult(new[] { IPAddress.Parse("192.0.2.10"), IPAddress.Parse("169.254.169.254") });
            await Assert.ThrowsAsync<BlockedDestinationException>(() => NetGuard.Connect("mixed.example.test", 25));
            NetGuard.Resolver = (_, _) => Task.FromResult(Array.Empty<IPAddress>());
            var e = await Assert.ThrowsAsync<System.Net.Sockets.SocketException>(() => NetGuard.ResolveAllowed("unknown.example.test"));
            Assert.Equal(System.Net.Sockets.SocketError.HostNotFound, e.SocketErrorCode);
            await NetGuard.AssertAllowedHost("unknown.example.test");
        }
        finally { NetGuard.Resolver = original; }
    }
}

public class ValidationTests
{
    [Fact]
    public void Base64_with_length_limits()
    {
        var a = new B64Attribute(4, 8);
        Assert.True(a.IsValid("QUJD"));
        Assert.True(a.IsValid(null));
        Assert.False(a.IsValid("QU"));
        Assert.False(a.IsValid("QUJD!!"));
        Assert.False(a.IsValid("QUJDREVGR0g="));
    }

    [Fact]
    public void Encrypted_values_need_the_v1_format()
    {
        var a = new EncAttribute(100);
        Assert.True(a.IsValid("v1.AAAA.BBBB=="));
        Assert.False(a.IsValid("v2.AAAA.BBBB"));
        Assert.False(a.IsValid("v1.AAAA"));
        Assert.False(a.IsValid("v1." + new string('A', 100) + ".B"));
    }

    [Fact]
    public void Email_addresses()
    {
        var a = new EmailAddrAttribute();
        Assert.True(a.IsValid(" Max@Example.test "));
        Assert.False(a.IsValid("kein-at.example"));
        Assert.False(a.IsValid(new string('a', 250) + "@x.de"));
        Assert.Equal("max@example.test", Normalize.Email(" Max@Example.test "));
    }
}
