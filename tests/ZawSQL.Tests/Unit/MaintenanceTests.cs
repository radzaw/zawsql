namespace ZawSQL.Tests.Unit;

public class MaintenanceTests
{
    static string Sql(string op, string[] tables, params string[] options) => Maintenance.BuildSql(new MaintenanceRequest("shop", tables, op, options));

    [Fact]
    public void Builds_statements_with_quoted_tables_and_options()
    {
        Assert.Equal("CHECK TABLE `shop`.`a`, `shop`.`b`", Sql("check", ["a", "b"]));
        Assert.Equal("CHECK TABLE `shop`.`a` EXTENDED", Sql("check", ["a"], "extended"));
        Assert.Equal("CHECK TABLE `shop`.`a` FOR UPGRADE", Sql("check", ["a"], "FOR UPGRADE"));
        Assert.Equal("CHECKSUM TABLE `shop`.`a` QUICK", Sql("checksum", ["a"], "QUICK"));
        Assert.Equal("ANALYZE TABLE `shop`.`a`", Sql("analyze", ["a"]));
        Assert.Equal("OPTIMIZE LOCAL TABLE `shop`.`a`", Sql("optimize", ["a"], "LOCAL"));
        Assert.Equal("REPAIR LOCAL TABLE `shop`.`a` QUICK USE_FRM", Sql("repair", ["a"], "LOCAL", "QUICK", "USE_FRM"));
        Assert.Equal("CHECK TABLE `shop`.`we``ird`", Sql("check", ["we`ird"]));
    }

    [Theory]
    [InlineData("drop", new string[0])]          // unknown operation
    [InlineData("check", new[] { "LOCAL" })]      // option of another operation
    [InlineData("check", new[] { "QUICK", "FAST" })] // CHECK takes one mode
    [InlineData("checksum", new[] { "QUICK", "EXTENDED" })]
    [InlineData("optimize", new[] { "EXTENDED; DROP TABLE x" })] // injection attempt
    public void Rejects_invalid_requests(string op, string[] options) =>
        Assert.Throws<ApiException>(() => Sql(op, ["a"], options));

    [Fact]
    public void Requires_tables_and_reports_read_only_operations()
    {
        Assert.Throws<ApiException>(() => Sql("check", []));
        Assert.True(Maintenance.IsReadOnly("check"));
        Assert.True(Maintenance.IsReadOnly("CHECKSUM"));
        Assert.False(Maintenance.IsReadOnly("optimize"));
        Assert.False(Maintenance.IsReadOnly("analyze"));
        Assert.False(Maintenance.IsReadOnly("repair"));
        Assert.False(Maintenance.IsReadOnly("nope"));
    }
}
