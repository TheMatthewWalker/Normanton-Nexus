namespace NormantonNexus.Tests;

public class ScaffoldTests
{
    [Fact]
    public void NormantonNexus_assembly_loads()
    {
        var assembly = typeof(global::Program).Assembly;
        Assert.Equal("NormantonNexus", assembly.GetName().Name);
    }
}
