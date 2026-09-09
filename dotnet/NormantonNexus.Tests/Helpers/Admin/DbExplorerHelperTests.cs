using NormantonNexus.Helpers.Admin;

namespace NormantonNexus.Tests.Helpers.Admin;

public class DbExplorerHelperTests
{
    [Theory]
    [InlineData("Nexus", "[Nexus]")]
    [InlineData("NexusOperations", "[NexusOperations]")]
    [InlineData("Weird]Name", "[Weird]]Name]")] // a literal ] in the (already-verified-real) name is doubled, standard T-SQL bracket-quoting
    [InlineData("", "[]")]
    public void Bracket_escapes_an_identifier_for_safe_interpolation(string name, string expected)
    {
        Assert.Equal(expected, DbExplorerHelper.Bracket(name));
    }
}
