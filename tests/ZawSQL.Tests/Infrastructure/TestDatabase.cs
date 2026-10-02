using System.Text.Json;
using MySqlConnector;

namespace ZawSQL.Tests.Infrastructure;

/// <summary>
/// Connection settings for integration tests, from the environment:
/// ZAWSQL_TEST_HOST (required to enable them), ZAWSQL_TEST_PORT, ZAWSQL_TEST_USER, ZAWSQL_TEST_PASSWORD.
/// The account needs full privileges (tests create databases, users and functions).
/// </summary>
public static class TestServer
{
    public static string? Host => Environment.GetEnvironmentVariable("ZAWSQL_TEST_HOST");
    public static int Port => int.TryParse(Environment.GetEnvironmentVariable("ZAWSQL_TEST_PORT"), out var p) ? p : 3306;
    public static string User => Environment.GetEnvironmentVariable("ZAWSQL_TEST_USER") ?? "root";
    public static string Password => Environment.GetEnvironmentVariable("ZAWSQL_TEST_PASSWORD") ?? "";
    public static bool Enabled => !string.IsNullOrEmpty(Host);

    public static string ConnectionString(string? user = null, string? password = null, string? database = null) =>
        new MySqlConnectionStringBuilder
        {
            Server = Host, Port = (uint)Port, UserID = user ?? User, Password = password ?? Password, Database = database ?? "",
            AllowPublicKeyRetrieval = true, SslMode = MySqlSslMode.Preferred, AllowUserVariables = true, Pooling = false,
        }.ConnectionString;
}

/// <summary>A test that needs a MySQL/MariaDB server; skipped when ZAWSQL_TEST_HOST is not set.</summary>
public sealed class DbFactAttribute : FactAttribute
{
    public DbFactAttribute()
    {
        if (!TestServer.Enabled) Skip = "Set ZAWSQL_TEST_HOST (and ZAWSQL_TEST_PORT/USER/PASSWORD) to run integration tests.";
    }
}

[CollectionDefinition(Name)]
public sealed class DbCollection : ICollectionFixture<TestDatabase>
{
    public const string Name = "database";
}

/// <summary>
/// Seeds a uniquely named schema, starts a ZawSQL backend and connects a session to the test server.
/// Shared by all integration tests; cleans everything up afterwards.
/// </summary>
public sealed class TestDatabase : IAsyncLifetime
{
    public string Db { get; } = "zt_shop_" + Guid.NewGuid().ToString("n")[..8];
    public string Suffix => Db[^8..];
    public TestApp App { get; private set; } = null!;
    public string Sid { get; private set; } = "";
    public string ProfileId { get; private set; } = "";
    public bool IsMariaDb { get; private set; }
    public string Version { get; private set; } = "";
    readonly List<string> cleanup = [];

    public async Task InitializeAsync()
    {
        if (!TestServer.Enabled) return;
        await using (var c = new MySqlConnection(TestServer.ConnectionString()))
        {
            await c.OpenAsync();
            Version = c.ServerVersion;
            IsMariaDb = Version.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);
            await ExecAsync(c, $"CREATE DATABASE `{Db}` CHARACTER SET utf8mb4");
            await c.ChangeDatabaseAsync(Db);
            foreach (var sql in Seed) await ExecAsync(c, sql);
            // Allows creating a data-modifying function with binary logging enabled (MySQL 8 default).
            try { await ExecAsync(c, "SET GLOBAL log_bin_trust_function_creators = 1"); } catch (MySqlException) { /* not needed / not allowed */ }
            await ExecAsync(c, "CREATE FUNCTION sneaky() RETURNS INT MODIFIES SQL DATA BEGIN INSERT INTO logs VALUES ('sneaky', 9, NOW()); RETURN 1; END");
        }
        App = await TestApp.StartAsync();
        ProfileId = await SaveSessionAsync("Test server");
        Sid = await ConnectAsync(ProfileId);
    }

    /// <summary>Saves a session profile for the test server and returns its id.</summary>
    public async Task<string> SaveSessionAsync(string name, bool readOnly = false, bool production = false, string? color = null)
    {
        var p = (await App.PostAsync("/sessions", new
        {
            name, host = TestServer.Host, port = TestServer.Port, user = TestServer.User, password = TestServer.Password,
            savePassword = true, readOnly, production, color,
        })).Expect();
        return p.GetProperty("id").GetString()!;
    }

    public async Task<string> ConnectAsync(string profileId) =>
        (await App.PostAsync("/connect", new { sessionId = profileId })).Expect().GetProperty("sid").GetString()!;

    /// <summary>Registers an extra database or account to drop at the end ("db:name" / "user:'u'@'h'").</summary>
    public void CleanupLater(string item) => cleanup.Add(item);

    public async Task<string?> ScalarAsync(string sql)
    {
        await using var c = new MySqlConnection(TestServer.ConnectionString(database: Db));
        await c.OpenAsync();
        await using var cmd = new MySqlCommand(sql, c);
        var v = await cmd.ExecuteScalarAsync();
        return v is null or DBNull ? null : Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
    }

    public async Task ExecRootAsync(string sql)
    {
        await using var c = new MySqlConnection(TestServer.ConnectionString(database: Db));
        await c.OpenAsync();
        await ExecAsync(c, sql);
    }

    static async Task ExecAsync(MySqlConnection c, string sql)
    {
        await using var cmd = new MySqlCommand(sql, c);
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>Executes statements through the API on the shared session.</summary>
    public async Task<JsonElement> ExecAsync(params string[] statements) =>
        (await App.PostAsync($"/s/{Sid}/exec", new { statements, database = Db })).Expect();

    public async Task DisposeAsync()
    {
        if (!TestServer.Enabled) return;
        if (App != null) await App.DisposeAsync();
        await using var c = new MySqlConnection(TestServer.ConnectionString());
        await c.OpenAsync();
        foreach (var item in cleanup.Prepend("db:" + Db))
        {
            try
            {
                if (item.StartsWith("db:")) await ExecAsync(c, $"DROP DATABASE IF EXISTS `{item[3..]}`");
                else if (item.StartsWith("user:")) await ExecAsync(c, $"DROP USER IF EXISTS {item[5..]}");
                else if (item.StartsWith("role:")) await ExecAsync(c, $"DROP ROLE IF EXISTS {item[5..]}");
            }
            catch (MySqlException) { /* best effort */ }
        }
    }

    // Works on MySQL 8.0/8.4 and MariaDB 10.11/11.x.
    static readonly string[] Seed =
    [
        """
        CREATE TABLE customers (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(255) NULL DEFAULT NULL,
          balance DECIMAL(10,2) NOT NULL DEFAULT 0,
          status ENUM('active','blocked') NOT NULL DEFAULT 'active',
          avatar BLOB NULL,
          is_vip BIT(1) NOT NULL DEFAULT b'0',
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          birthday DATE NULL,
          notes TEXT NULL,
          UNIQUE KEY uq_email (email),
          KEY idx_name (name(20))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Customer list'
        """,
        """
        CREATE TABLE orders (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          customer_id INT UNSIGNED NOT NULL,
          total DOUBLE NOT NULL,
          t TIME NULL,
          CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
        ) ENGINE=InnoDB
        """,
        "CREATE TABLE logs (msg VARCHAR(200), level TINYINT, at DATETIME) ENGINE=InnoDB",
        """
        INSERT INTO customers (name, email, balance, status, avatar, is_vip, birthday, notes) VALUES
          ('Alice', 'alice@example.com', 120.50, 'active', 0xDEADBEEF, b'1', '1990-05-01', 'line1\nline2'),
          ('Bob', NULL, 0, 'blocked', NULL, b'0', NULL, NULL),
          ('Zoë Ünicode', 'zoe@example.com', -5.25, 'active', NULL, b'0', '2001-12-31', 'Ünïcødé ✓')
        """,
        "INSERT INTO orders (customer_id, total, t) VALUES (1, 99.99, '12:30:00'), (1, 1.5, '-01:00:00'), (3, 1e20, NULL)",
        "INSERT INTO logs VALUES ('hello', 1, '2024-01-01 10:00:00'), ('hello', 1, '2024-01-01 10:00:00'), ('bye', 2, NULL)",
        "CREATE VIEW v_orders AS SELECT o.id, c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id",
        "CREATE PROCEDURE top_customers(IN n INT) BEGIN SELECT * FROM customers ORDER BY balance DESC LIMIT n; SELECT COUNT(*) AS cnt FROM orders; END",
        "CREATE TRIGGER trg_orders_bi BEFORE INSERT ON orders FOR EACH ROW BEGIN IF NEW.total < 0 THEN SET NEW.total = 0; END IF; END",
        """
        CREATE TABLE sales (id INT NOT NULL, sold DATE NOT NULL, PRIMARY KEY (id, sold))
        PARTITION BY RANGE (YEAR(sold)) (PARTITION p2023 VALUES LESS THAN (2024) COMMENT 'old', PARTITION pmax VALUES LESS THAN MAXVALUE)
        """,
        "INSERT INTO sales VALUES (1, '2023-05-01'), (2, '2026-01-01')",
    ];
}
