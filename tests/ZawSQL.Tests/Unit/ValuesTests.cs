using MySqlConnector;

namespace ZawSQL.Tests.Unit;

public class ValuesTests
{
    [Theory]
    [InlineData("INT", "int")]
    [InlineData("bigint unsigned", "int")]
    [InlineData("TINYINT", "int")]
    [InlineData("bit(1)", "int")]
    [InlineData("YEAR", "int")]
    [InlineData("DECIMAL", "real")]
    [InlineData("double", "real")]
    [InlineData("DATETIME", "date")]
    [InlineData("time", "date")]
    [InlineData("BLOB", "binary")]
    [InlineData("varbinary(16)", "binary")]
    [InlineData("POINT", "spatial")]
    [InlineData("MULTIPOINT", "spatial")]
    [InlineData("VARCHAR", "text")]
    [InlineData("TINYTEXT", "text")]
    [InlineData("JSON", "text")]
    public void KindOf_classifies_types(string type, string kind) => Assert.Equal(kind, Values.KindOf(type));

    [Fact]
    public void Formats_values_like_the_server_shows_them()
    {
        Assert.Null(Values.Format(DBNull.Value, "INT"));
        Assert.Equal("0xDEADBEEF", Values.Format(new byte[] { 0xde, 0xad, 0xbe, 0xef }, "BLOB"));
        Assert.Equal("", Values.Format(Array.Empty<byte>(), "BLOB"));
        Assert.Equal("2024-01-02", Values.Format(new DateTime(2024, 1, 2), "DATE"));
        Assert.Equal("2024-01-02 03:04:05", Values.Format(new DateTime(2024, 1, 2, 3, 4, 5), "DATETIME"));
        Assert.Equal("2024-01-02 03:04:05.12", Values.Format(new DateTime(2024, 1, 2, 3, 4, 5).AddTicks(1_200_000), "DATETIME"));
        Assert.Equal("0000-00-00 00:00:00", Values.Format(new MySqlDateTime(0, 0, 0, 0, 0, 0, 0), "DATETIME"));
        Assert.Equal("-01:00:00", Values.Format(TimeSpan.FromHours(-1), "TIME"));
        Assert.Equal("838:59:59", Values.Format(new TimeSpan(34, 22, 59, 59), "TIME"));
        Assert.Equal("120.50", Values.Format(120.50m, "DECIMAL"));
        Assert.Equal("1E+20", Values.Format(1e20, "DOUBLE"));
        Assert.Equal("1", Values.Format(true, "BIT"));
    }

    [Fact]
    public void Quotes_sql_literals_safely()
    {
        Assert.Equal(@"'it\'s \\ a\ntest\0'", SqlLiteral.Quote("it's \\ a\ntest\0"));
        Assert.Equal("NULL", SqlLiteral.FromValue(null, ""));
        Assert.Equal("0x0102", SqlLiteral.FromValue(new byte[] { 1, 2 }, ""));
        Assert.Equal("42", SqlLiteral.FromValue(42L, ""));
        Assert.Equal("'2024-01-02 03:04:05'", SqlLiteral.FromValue(new DateTime(2024, 1, 2, 3, 4, 5), "DATETIME"));
    }

    [Theory]
    [InlineData("a`b", "`a``b`")]
    [InlineData("plain", "`plain`")]
    public void Quotes_identifiers(string name, string quoted) => Assert.Equal(quoted, Db.Q(name));
}
