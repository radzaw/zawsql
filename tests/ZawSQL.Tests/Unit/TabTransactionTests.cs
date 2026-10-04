namespace ZawSQL.Tests.Unit;

/// <summary>What statements do to the open transaction of a manual-commit query tab.</summary>
public class TabTransactionTests
{
    [Theory]
    [InlineData("SELECT * FROM t", TxEffect.Read)]
    [InlineData("  (SELECT 1) UNION (SELECT 2)", TxEffect.Read)]
    [InlineData("SHOW TABLES", TxEffect.Read)]
    [InlineData("SET @a = 1", TxEffect.Read)]
    [InlineData("SAVEPOINT s1", TxEffect.Read)]
    [InlineData("ROLLBACK TO SAVEPOINT s1", TxEffect.Read)]
    [InlineData("ROLLBACK WORK TO s1", TxEffect.Read)]
    [InlineData("SELECT * FROM t WHERE id = 1 FOR UPDATE", TxEffect.Change)]
    [InlineData("SELECT * FROM t FOR SHARE", TxEffect.Change)]
    [InlineData("SELECT * FROM t LOCK IN SHARE MODE", TxEffect.Change)]
    [InlineData("SELECT 'for update' FROM t -- for update", TxEffect.Read)]
    [InlineData("INSERT INTO t VALUES (1)", TxEffect.Change)]
    [InlineData("update t set a = 1", TxEffect.Change)]
    [InlineData("WITH x AS (SELECT 1) UPDATE t JOIN x SET t.a = 1", TxEffect.Change)]
    [InlineData("WITH x AS (SELECT INSERT('abc', 1, 1, 'z')) SELECT * FROM x", TxEffect.Read)]
    [InlineData("CALL refresh_totals()", TxEffect.Change)]
    [InlineData("LOAD DATA LOCAL INFILE 'a.csv' INTO TABLE t", TxEffect.Change)]
    [InlineData("CREATE TEMPORARY TABLE tmp (a INT)", TxEffect.Change)]
    [InlineData("DROP TEMPORARY TABLE tmp", TxEffect.Change)]
    [InlineData("COMMIT", TxEffect.Commit)]
    [InlineData("commit work", TxEffect.Commit)]
    [InlineData("ROLLBACK", TxEffect.Rollback)]
    [InlineData("START TRANSACTION", TxEffect.Begin)]
    [InlineData("BEGIN", TxEffect.Begin)]
    [InlineData("BEGIN NOT ATOMIC SELECT 1; END", TxEffect.Change)]
    [InlineData("CREATE TABLE t2 (a INT)", TxEffect.ImplicitCommit)]
    [InlineData("ALTER TABLE t ADD b INT", TxEffect.ImplicitCommit)]
    [InlineData("TRUNCATE TABLE t", TxEffect.ImplicitCommit)]
    [InlineData("GRANT SELECT ON db.* TO 'u'@'%'", TxEffect.ImplicitCommit)]
    [InlineData("LOCK TABLES t WRITE", TxEffect.ImplicitCommit)]
    [InlineData("SET PASSWORD = 'x'", TxEffect.ImplicitCommit)]
    [InlineData("ANALYZE TABLE t", TxEffect.ImplicitCommit)]
    [InlineData("/*!40000 ALTER TABLE t DISABLE KEYS */", TxEffect.ImplicitCommit)]
    [InlineData("SET autocommit = 1", TxEffect.Autocommit)]
    [InlineData("SET SESSION autocommit=1", TxEffect.Autocommit)]
    [InlineData("SET @@autocommit = 0", TxEffect.Autocommit)]
    [InlineData("SET @autocommit_backup = 1", TxEffect.Read)]
    [InlineData("", TxEffect.Read)]
    public void Statements_are_classified(string sql, TxEffect expected) => Assert.Equal(expected, TabTransactions.Classify(sql));

    [Fact]
    public void Changes_are_counted_until_the_transaction_ends()
    {
        var t = new TabConnection { Conn = new MySqlConnector.MySqlConnection() };
        Assert.Null(TabTransactions.Apply(t, "SELECT 1", TxEffect.Read));
        Assert.Equal(0, t.Changes);
        Assert.Null(t.Since);
        TabTransactions.Apply(t, "INSERT INTO t VALUES (1)", TxEffect.Change);
        TabTransactions.Apply(t, "UPDATE t SET a = 2", TxEffect.Change);
        Assert.Equal(2, t.Changes);
        Assert.NotNull(t.Since);
        Assert.Equal("CREATE TABLE committed the open transaction (2 changes) – the server does that before this kind of statement.",
            TabTransactions.Apply(t, "create table x (a int)", TxEffect.ImplicitCommit));
        Assert.Equal(0, t.Changes);
        Assert.Null(TabTransactions.Apply(t, "COMMIT", TxEffect.Commit)); // nothing was open
        TabTransactions.Apply(t, "DELETE FROM t", TxEffect.Change);
        Assert.Equal("ROLLBACK undid the open transaction (1 change).", TabTransactions.Apply(t, "ROLLBACK", TxEffect.Rollback));
        TabTransactions.Apply(t, "DELETE FROM t", TxEffect.Change);
        Assert.Equal("START TRANSACTION first committed the open transaction (1 change).", TabTransactions.Apply(t, "START TRANSACTION", TxEffect.Begin));
    }
}
