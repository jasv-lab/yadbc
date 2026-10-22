using System.Security.Cryptography;
using System.Text;
using Yadbc.Broker;
using Yadbc.Broker.Auth;
using Yadbc.Broker.Shares;

namespace Yadbc.Broker.Tests;

public class LoginVaultTests
{
    static LoginVault Vault() => new(new BrokerOptions { LoginKey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)) });

    [Fact]
    public void Round_trips_and_is_bound_to_its_share()
    {
        var vault = Vault();
        var sealedBytes = vault.Seal("share-1", "pä$$wörd");
        Assert.Equal("pä$$wörd", vault.Open("share-1", sealedBytes));
        Assert.ThrowsAny<CryptographicException>(() => vault.Open("share-2", sealedBytes));
    }

    [Fact]
    public void Refuses_a_key_that_is_not_32_bytes()
    {
        Assert.Throws<InvalidOperationException>(() => new LoginVault(new BrokerOptions { LoginKey = Convert.ToBase64String(new byte[16]) }));
        Assert.Throws<InvalidOperationException>(() => new LoginVault(new BrokerOptions { LoginKey = "not base64!" }));
    }
}

public class LoginFlowTests
{
    const string Challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // RFC 7636 example
    const string Verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    [Theory]
    [InlineData("http://127.0.0.1:5179/api/broker/callback", null)]
    [InlineData("http://localhost:61234/cb", null)]
    [InlineData("https://127.0.0.1:5179/cb", "Start the sign-in from yadbc")] // loopback http only
    [InlineData("http://evil.example:5179/cb", "Start the sign-in from yadbc")]
    [InlineData("http://127.0.0.1/cb", "Start the sign-in from yadbc")] // explicit port
    [InlineData("http://user@127.0.0.1:5179/cb", "Start the sign-in from yadbc")]
    [InlineData("/relative", "Start the sign-in from yadbc")]
    public void Only_lets_the_sign_in_come_back_to_this_computer(string redirect, string? error)
    {
        var result = LoginFlow.Invalid(redirect, Challenge, "s1");
        if (error is null) Assert.Null(result);
        else Assert.StartsWith(error, result);
    }

    [Fact]
    public void Needs_an_S256_challenge_and_a_state()
    {
        Assert.NotNull(LoginFlow.Invalid("http://127.0.0.1:5179/cb", "short", "s"));
        Assert.NotNull(LoginFlow.Invalid("http://127.0.0.1:5179/cb", Challenge, ""));
    }

    [Fact]
    public void A_code_works_once_and_only_with_its_verifier()
    {
        var codes = new LoginCodes();
        var code = codes.Create("u1", Challenge);
        Assert.Null(codes.Redeem(code, "wrong-verifier"));
        // A wrong verifier burns the code too: no guessing against the same code.
        Assert.Null(codes.Redeem(code, Verifier));

        var second = codes.Create("u1", Challenge);
        Assert.Equal("u1", codes.Redeem(second, Verifier));
        Assert.Null(codes.Redeem(second, Verifier));
    }

    [Fact]
    public void Token_hashes_are_stable_and_never_the_token()
    {
        Assert.Equal(DeviceTokens.Hash("ybt_x"), DeviceTokens.Hash("ybt_x"));
        Assert.DoesNotContain("ybt_x", DeviceTokens.Hash("ybt_x"));
        Assert.Equal(64, Encoding.ASCII.GetByteCount(DeviceTokens.Hash("ybt_x")));
    }
}
