namespace ZawSQL.Tests.Unit;

public sealed class SessionStoreTests : IDisposable
{
    readonly string dir = Path.Combine(Path.GetTempPath(), "zawsql-tests", Guid.NewGuid().ToString("n"));
    AppOptions Opts => AppOptions.Parse(["--config", dir]);

    public SessionStoreTests() => Directory.CreateDirectory(dir);
    public void Dispose()
    {
        try { Directory.Delete(dir, true); } catch (IOException) { }
    }

    [Fact]
    public void Saved_password_is_encrypted_and_never_listed()
    {
        var store = new SessionStore(Opts);
        var saved = store.Save(new SessionProfile { Name = "Prod", Password = "s3cr3t!", SavePassword = true });

        Assert.Null(saved.Password);
        Assert.True(saved.HasPassword);
        Assert.Equal("s3cr3t!", store.GetPassword(saved.Id!));
        var onDisk = File.ReadAllText(Path.Combine(dir, "sessions.json"));
        Assert.DoesNotContain("s3cr3t!", onDisk);
        Assert.Contains("passwordEnc", onDisk);
        Assert.All(store.List(), s => Assert.Null(s.PasswordEnc));

        // A fresh store (new process) can still decrypt with the persisted key.
        Assert.Equal("s3cr3t!", new SessionStore(Opts).GetPassword(saved.Id!));
    }

    [Fact]
    public void Password_is_kept_when_not_retyped_and_dropped_when_not_saved()
    {
        var store = new SessionStore(Opts);
        var s = store.Save(new SessionProfile { Name = "A", Password = "pw", SavePassword = true });
        store.Save(new SessionProfile { Id = s.Id, Name = "A renamed", Password = null, SavePassword = true });
        Assert.Equal("pw", store.GetPassword(s.Id!));
        store.Save(new SessionProfile { Id = s.Id, Name = "A", SavePassword = false });
        Assert.Null(store.GetPassword(s.Id!));
    }

    [Theory]
    [InlineData("#d13438", "#d13438")]
    [InlineData("red", null)]
    [InlineData("#fff", null)]
    [InlineData("#123456;background:url(x)", null)]
    public void Only_plain_hex_colors_are_stored(string color, string? expected)
    {
        var store = new SessionStore(Opts);
        var s = store.Save(new SessionProfile { Name = "C", Color = color });
        Assert.Equal(expected, s.Color);
    }

    [Fact]
    public void Delete_removes_session_and_state_roundtrips()
    {
        var store = new SessionStore(Opts);
        var s = store.Save(new SessionProfile { Name = "X" });
        store.Delete(s.Id!);
        Assert.Empty(store.List());

        store.SaveState("""{"prefs":{"theme":"dark"}}""");
        Assert.Equal("dark", store.LoadState().GetProperty("prefs").GetProperty("theme").GetString());
    }
}
