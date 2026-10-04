using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Unit;

/// <summary>Importing sessions from HeidiSQL, DBeaver and MySQL Workbench (formats as written by those tools).</summary>
public class SessionImportTests
{
    // ---------------------------------------------------------------- HeidiSQL

    [Fact]
    public void HeidiSQL_passwords_are_decoded()
    {
        // ANSI form: two hex digits per character, each shifted by the salt digit at the end ("secret", salt 3).
        Assert.Equal("secret", SessionImport.HeidiDecrypt("7668667568773"));
        // Values above 255 wrap around (þ = 0xFE + 9 → 0x08).
        Assert.Equal("þ", SessionImport.HeidiDecrypt("089"));
        // Unicode form: four hex digits per character, then the salt and a "0" flag ("żx", salt 5).
        Assert.Equal("żx", SessionImport.HeidiDecrypt("0181007D50"));
        Assert.Equal("", SessionImport.HeidiDecrypt(""));
        Assert.Equal("", SessionImport.HeidiDecrypt("zz"));
    }

    [Fact]
    public void HeidiSQL_colors_are_Delphi_TColor_values()
    {
        Assert.Equal("#ff8000", SessionImport.HeidiColor((0x0080FF).ToString())); // 0x00BBGGRR
        Assert.Null(SessionImport.HeidiColor("536870911")); // clNone
        Assert.Null(SessionImport.HeidiColor("-16777211")); // a system color
        Assert.Null(SessionImport.HeidiColor(null));
    }

    // File › Export settings: "path<|||>registry data type<|||>value", CR and LF as <{{{> and <}}}>.
    const string HeidiExport = """
        Servers\Local\Host<|||>1<|||>127.0.0.1
        Servers\Local\User<|||>1<|||>root
        Servers\Local\Password<|||>1<|||>7668667568773
        Servers\Local\Port<|||>1<|||>3307
        Servers\Local\NetType<|||>3<|||>0
        Servers\Local\Compressed<|||>3<|||>1
        Servers\Local\Databases<|||>1<|||>shop;crm
        Servers\Local\Comment<|||>1<|||>line one<{{{><}}}>line two
        Servers\Local\TreeBackground<|||>3<|||>33023
        Servers\Customers<|||>3<|||>1
        Servers\Customers\Folder<|||>3<|||>1
        Servers\Customers\Acme prod\Host<|||>1<|||>10.0.0.5
        Servers\Customers\Acme prod\User<|||>1<|||>app
        Servers\Customers\Acme prod\Password<|||>1<|||>
        Servers\Customers\Acme prod\LoginPrompt<|||>3<|||>1
        Servers\Customers\Acme prod\NetType<|||>3<|||>2
        Servers\Customers\Acme prod\SSHtunnelHost<|||>1<|||>bastion.acme.com
        Servers\Customers\Acme prod\SSHtunnelHostPort<|||>3<|||>2222
        Servers\Customers\Acme prod\SSHtunnelUser<|||>1<|||>deploy
        Servers\Customers\Acme prod\SSHtunnelPrivateKey<|||>1<|||>C:\keys\acme.ppk
        Servers\Customers\Acme prod\SSL_Active<|||>3<|||>1
        Servers\Customers\Acme prod\SSL_CA<|||>1<|||>C:\certs\ca.pem
        Servers\Reporting PG\Host<|||>1<|||>pg.local
        Servers\Reporting PG\NetType<|||>3<|||>8
        Servers\Pipe\Host<|||>1<|||>.
        Servers\Pipe\NetType<|||>3<|||>1
        Servers\Tunnel off\Host<|||>1<|||>db.internal
        Servers\Tunnel off\NetType<|||>3<|||>2
        Servers\Tunnel off\SSHtunnelActive<|||>3<|||>0
        Servers\Tunnel off\SSHtunnelHost<|||>1<|||>ignored
        LastSessions<|||>1<|||>Local
        """;

    [Fact]
    public void HeidiSQL_settings_export()
    {
        var s = SessionImport.ParseHeidiSettings(HeidiExport.Replace("\n", "\r\n"));
        Assert.Equal(["Local", "Acme prod", "Reporting PG", "Pipe", "Tunnel off"], s.Select(x => x.Profile.Name));

        var local = s[0].Profile;
        Assert.Null(s[0].Folder);
        Assert.Equal(("127.0.0.1", 3307, "root"), (local.Host, local.Port, local.User));
        Assert.Equal("secret", local.Password);
        Assert.True(local.SavePassword);
        Assert.True(local.Compression);
        Assert.Equal("shop;crm", local.Databases);
        Assert.Equal("line one\nline two", local.Comment);
        Assert.Equal("#ff8000", local.Color);
        Assert.False(local.SshEnabled);

        var acme = s[1];
        Assert.Equal("Customers", acme.Folder);
        Assert.Equal("Customers / Acme prod", SessionImport.ImportName(acme));
        Assert.False(acme.Profile.SavePassword); // HeidiSQL asks at login
        Assert.Null(acme.Profile.Password);
        Assert.True(acme.Profile.SshEnabled);
        Assert.Equal(("bastion.acme.com", 2222, "deploy", "key"), (acme.Profile.SshHost, acme.Profile.SshPort, acme.Profile.SshUser, acme.Profile.SshAuth));
        Assert.Equal(@"C:\keys\acme.ppk", acme.Profile.SshKeyFile);
        Assert.Equal("Required", acme.Profile.SslMode);
        Assert.Contains(acme.Notes, n => n.Contains("PuTTY"));
        Assert.Contains(acme.Notes, n => n.Contains("certificate files"));

        Assert.Equal("PostgreSQL session", s[2].Skip);
        Assert.Contains(s[3].Notes, n => n.Contains("Named pipe"));
        Assert.Equal("127.0.0.1", s[3].Profile.Host);
        Assert.False(s[4].Profile.SshEnabled); // SSH tunnel network type, tunnel switched off
    }

    // ---------------------------------------------------------------- DBeaver

    /// <summary>credentials-config.json as DBeaver writes it: AES-128-CBC with its fixed key, the IV in front.</summary>
    static byte[] DbeaverEncrypt(string json)
    {
        using var aes = Aes.Create();
        aes.Key = Convert.FromHexString("babb4a9f774ab853c96c2d653dfe544a");
        var iv = RandomNumberGenerator.GetBytes(16);
        return [.. iv, .. aes.EncryptCbc(Encoding.UTF8.GetBytes(json), iv)];
    }

    const string DbeaverSources = """
        {
          "folders": { "Prod": {} },
          "connections": {
            "mysql8-1": {
              "provider": "mysql", "driver": "mysql8", "name": "Shop", "save-password": true, "read-only": false, "folder": "Prod",
              "configuration": {
                "host": "db.shop.com", "port": "3306", "database": "shop", "url": "jdbc:mysql://db.shop.com:3306/shop", "type": "prod", "auth-model": "native",
                "handlers": {
                  "ssh_tunnel": { "type": "TUNNEL", "enabled": true, "save-password": true, "properties": { "host": "jump.shop.com", "port": 22, "authType": "PUBLIC_KEY", "keyPath": "/home/me/.ssh/id_ed25519" } },
                  "mysql_ssl": { "type": "CONFIG", "enabled": true, "properties": { "ssl.verify.server": "true" } }
                }
              }
            },
            "mariaDB-2": {
              "provider": "mysql", "driver": "mariaDB", "name": "Maria local", "save-password": true, "read-only": true,
              "configuration": { "host": "localhost", "port": "3307", "type": "dev", "user": "old", "password": "plain-old" }
            },
            "mysql8-3": {
              "provider": "mysql", "driver": "mysql8", "name": "URL only", "save-password": false,
              "configuration": { "url": "jdbc:mysql://url.example.com:3310/x", "type": "test" }
            },
            "postgres-jdbc-4": { "provider": "postgresql", "driver": "postgres-jdbc", "name": "PG", "configuration": { "host": "pg" } }
          }
        }
        """;

    const string DbeaverCredentials = """
        {
          "mysql8-1": { "#connection": { "user": "shop_app", "password": "s3cret!" }, "network/ssh_tunnel": { "user": "ubuntu", "password": "key-passphrase" } },
          "mariaDB-2": { "#connection": { "user": "maria", "password": "m4ria" } }
        }
        """;

    [Fact]
    public void DBeaver_data_sources_with_encrypted_credentials()
    {
        var creds = SessionImport.DbeaverCredentials(DbeaverEncrypt(DbeaverCredentials));
        Assert.NotNull(creds);
        var s = SessionImport.ParseDbeaver(DbeaverSources, creds);
        Assert.Equal(["Shop", "Maria local", "URL only", "PG"], s.Select(x => x.Profile.Name));

        var shop = s[0];
        Assert.Equal("Prod / Shop", SessionImport.ImportName(shop));
        Assert.Equal(("db.shop.com", 3306, "shop_app", "s3cret!"), (shop.Profile.Host, shop.Profile.Port, shop.Profile.User, shop.Profile.Password));
        Assert.True(shop.Profile.Production);
        Assert.True(shop.Profile.SshEnabled);
        Assert.Equal(("jump.shop.com", 22, "ubuntu", "key", "/home/me/.ssh/id_ed25519", "key-passphrase"),
            (shop.Profile.SshHost, shop.Profile.SshPort, shop.Profile.SshUser, shop.Profile.SshAuth, shop.Profile.SshKeyFile, shop.Profile.SshSecret));
        Assert.Equal("VerifyCA", shop.Profile.SslMode);
        Assert.Equal("Default database in DBeaver: shop", shop.Profile.Comment);

        // Credentials win over the plain ones older versions kept in the configuration.
        Assert.Equal(("maria", "m4ria", true), (s[1].Profile.User, s[1].Profile.Password, s[1].Profile.ReadOnly));
        Assert.Equal(("url.example.com", 3310), (s[2].Profile.Host, s[2].Profile.Port));
        Assert.False(s[2].Profile.SavePassword);
        Assert.Equal("PostgreSQL connection", s[3].Skip);

        // Without credentials-config.json: users and passwords from the configuration only, with a note.
        var bare = SessionImport.ParseDbeaver(DbeaverSources, null);
        Assert.Equal(("", null), (bare[0].Profile.User, bare[0].Profile.Password));
        Assert.Contains(bare[0].Notes, n => n.Contains("credentials-config.json"));
        Assert.Equal(("old", "plain-old"), (bare[1].Profile.User, bare[1].Profile.Password));
        Assert.Null(SessionImport.DbeaverCredentials(Encoding.UTF8.GetBytes("not encrypted at all, just text")));
    }

    [Fact]
    public void DBeaver_settings_on_the_connection_itself()
    {
        // The documentation's example puts host, port and type next to the name.
        var s = SessionImport.ParseDbeaver("""{ "connections": { "m": { "provider": "mysql", "driver": "mysql8", "name": "Doc", "host": "h", "port": "3311", "type": "prod", "configuration": {} } } }""", null);
        Assert.Equal(("h", 3311, true), (s[0].Profile.Host, s[0].Profile.Port, s[0].Profile.Production));
    }

    // ---------------------------------------------------------------- MySQL Workbench

    const string WorkbenchXml = """
        <?xml version="1.0"?>
        <data grt_format="2.0">
          <value _ptr_="0x1" type="list" content-type="object" content-struct-name="db.mgmt.Connection">
            <value type="object" struct-name="db.mgmt.Connection" id="a">
              <link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native</link>
              <value type="string" key="hostIdentifier">Mysql@127.0.0.1:3306</value>
              <value _ptr_="0x2" type="dict" key="parameterValues">
                <value type="string" key="hostName">127.0.0.1</value>
                <value type="int" key="port">3306</value>
                <value type="string" key="userName">root</value>
                <value type="string" key="schema">sakila</value>
                <value type="int" key="useSSL">2</value>
              </value>
              <value type="string" key="name">Local instance 3306</value>
            </value>
            <value type="object" struct-name="db.mgmt.Connection" id="b">
              <link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native_sshtun</link>
              <value _ptr_="0x3" type="dict" key="parameterValues">
                <value type="string" key="hostName">10.1.0.7</value>
                <value type="int" key="port">3306</value>
                <value type="string" key="userName">ops</value>
                <value type="string" key="sshHost">bastion.example.com:2200</value>
                <value type="string" key="sshUserName">ec2-user</value>
                <value type="string" key="sshKeyFile">~/.ssh/aws.pem</value>
                <value type="int" key="useSSL">1</value>
              </value>
              <value type="string" key="name">AWS via bastion</value>
            </value>
            <value type="object" struct-name="db.mgmt.Connection" id="c">
              <link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native_socket</link>
              <value _ptr_="0x4" type="dict" key="parameterValues">
                <value type="string" key="socket">/var/run/mysqld/mysqld.sock</value>
                <value type="string" key="userName">me</value>
                <value type="int" key="useSSL">0</value>
              </value>
              <value type="string" key="name">Socket</value>
            </value>
          </value>
        </data>
        """;

    [Fact]
    public void MySQL_Workbench_connections()
    {
        var s = SessionImport.ParseWorkbench(WorkbenchXml);
        Assert.Equal(["Local instance 3306", "AWS via bastion", "Socket"], s.Select(x => x.Profile.Name));
        Assert.Equal(("127.0.0.1", 3306, "root", "Required"), (s[0].Profile.Host, s[0].Profile.Port, s[0].Profile.User, s[0].Profile.SslMode));
        Assert.False(s[0].Profile.SavePassword); // passwords are in the system keychain: asked when connecting
        Assert.Contains(s[0].Notes, n => n.Contains("keychain"));
        Assert.Equal("Default schema in Workbench: sakila", s[0].Profile.Comment);

        var aws = s[1].Profile;
        Assert.True(aws.SshEnabled);
        Assert.Equal(("bastion.example.com", 2200, "ec2-user", "key", "~/.ssh/aws.pem", "Preferred"), (aws.SshHost, aws.SshPort, aws.SshUser, aws.SshAuth, aws.SshKeyFile, aws.SslMode));
        Assert.Equal(("/var/run/mysqld/mysqld.sock", "None"), (s[2].Profile.Host, s[2].Profile.SslMode));
    }

    // ---------------------------------------------------------------- read → pick → save through the API

    [Fact]
    public async Task Imported_sessions_are_saved_with_their_passwords_but_never_sent_to_the_page()
    {
        await using var app = await TestApp.StartAsync();
        (await app.PostAsync("/sessions", new { name = "Local", host = "127.0.0.1", port = 3307, user = "root" })).Expect();

        static object File(string name, string text) => new { name, data = Convert.ToBase64String(Encoding.UTF8.GetBytes(text)) };
        var read = await app.PostAsync("/sessions/import/read", new { source = "heidisql", files = new[] { File("heidisql-settings.txt", HeidiExport) } });
        var r = read.Expect();
        Assert.DoesNotContain("secret", read.Data.GetRawText()); // no password reaches the page
        var list = r.GetProperty("sessions").EnumerateArray().ToList();
        Assert.Equal("Local", list[0].GetProperty("exists").GetString()); // same server as the saved "Local"
        Assert.True(list[0].GetProperty("hasPassword").GetBoolean());
        Assert.Equal("deploy@bastion.acme.com:2222", list[1].GetProperty("ssh").GetString());
        Assert.Equal("PostgreSQL session", list[2].GetProperty("skip").GetString());

        var id = r.GetProperty("id").GetString();
        var saved = (await app.PostAsync("/sessions/import/save", new { id, items = new object[]
        {
            new { index = 0, name = "Local" },          // the name is taken: made unique
            new { index = 1, name = "" },               // empty: the imported name
            new { index = 2, name = "Reporting PG" },   // not a MySQL session: ignored
        } })).Expect().GetProperty("saved").EnumerateArray().ToList();
        Assert.Equal(["Local (2)", "Customers / Acme prod"], saved.Select(x => x.GetProperty("name").GetString()));

        var sessions = (await app.GetAsync("/sessions")).Expect().EnumerateArray().ToList();
        var local2 = sessions.Single(x => x.GetProperty("name").GetString() == "Local (2)");
        Assert.True(local2.GetProperty("hasPassword").GetBoolean());
        Assert.Equal("#ff8000", local2.GetProperty("color").GetString());
        Assert.True(sessions.Single(x => x.GetProperty("name").GetString() == "Customers / Acme prod").GetProperty("sshEnabled").GetBoolean());

        // DBeaver: data-sources.json plus the encrypted credentials; a production connection gets the production color.
        var db = (await app.PostAsync("/sessions/import/read", new
        {
            source = "dbeaver",
            files = new[] { File("data-sources.json", DbeaverSources), new { name = "credentials-config.json", data = Convert.ToBase64String(DbeaverEncrypt(DbeaverCredentials)) } },
        })).Expect();
        Assert.Equal(["Prod / Shop", "Maria local", "URL only", "PG"], db.GetProperty("sessions").EnumerateArray().Select(x => x.GetProperty("name").GetString()));
        var shop = (await app.PostAsync("/sessions/import/save", new { id = db.GetProperty("id").GetString(), items = new[] { new { index = 0, name = "" } } }))
            .Expect().GetProperty("saved")[0];
        Assert.Equal(("Prod / Shop", true, "#d13438", true), (shop.GetProperty("name").GetString(), shop.GetProperty("production").GetBoolean(), shop.GetProperty("color").GetString(), shop.GetProperty("hasPassword").GetBoolean()));

        // Each read can be saved once.
        Assert.Contains("expired", (await app.PostAsync("/sessions/import/save", new { id, items = new[] { new { index = 0, name = "x" } } })).Error);
        // Wrong file for the source: a clear message.
        Assert.Contains("data-sources.json", (await app.PostAsync("/sessions/import/read", new { source = "dbeaver", files = new[] { File("x.json", "not json") } })).Error);
        // Only locations found on this computer can be read, no arbitrary paths.
        Assert.Contains("no longer available", (await app.PostAsync("/sessions/import/read", new { source = "workbench", location = "/etc/passwd" })).Error);
    }
}
