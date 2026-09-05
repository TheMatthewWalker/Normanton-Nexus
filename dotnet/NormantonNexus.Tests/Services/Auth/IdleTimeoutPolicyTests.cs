using Microsoft.Extensions.Options;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Services.Auth;

public class IdleTimeoutPolicyTests
{
    [Fact]
    public void Defaults_match_config_js_exactly_30_minutes_and_5_minutes()
    {
        var policy = new IdleTimeoutPolicy(Options.Create(new AuthOptions()));

        Assert.Equal(TimeSpan.FromMinutes(30), policy.DefaultTimeout);
        Assert.Equal(TimeSpan.FromMinutes(5), policy.ShortTimeout);
    }

    [Fact]
    public void TimeoutFor_short_idle_true_returns_the_short_timeout()
    {
        var policy = new IdleTimeoutPolicy(Options.Create(new AuthOptions()));

        Assert.Equal(policy.ShortTimeout, policy.TimeoutFor(shortIdleTimeout: true));
    }

    [Fact]
    public void TimeoutFor_short_idle_false_returns_the_default_timeout()
    {
        var policy = new IdleTimeoutPolicy(Options.Create(new AuthOptions()));

        Assert.Equal(policy.DefaultTimeout, policy.TimeoutFor(shortIdleTimeout: false));
    }

    [Fact]
    public void Timeouts_are_configurable_via_AuthOptions()
    {
        var options = new AuthOptions { DefaultIdleTimeoutMinutes = 45, ShortIdleTimeoutMinutes = 2 };
        var policy = new IdleTimeoutPolicy(Options.Create(options));

        Assert.Equal(TimeSpan.FromMinutes(45), policy.DefaultTimeout);
        Assert.Equal(TimeSpan.FromMinutes(2), policy.ShortTimeout);
    }
}
