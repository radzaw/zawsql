namespace ZawSQL.Tests.Unit;

public class SqlLogTests
{
    [Fact]
    public async Task Finish_records_how_long_a_statement_took_once()
    {
        var log = new SqlLog();
        var line = log.Add("SELECT SLEEP(1)");
        log.Add("/* a comment */");
        await Task.Delay(120);
        log.Finish(line);
        var first = log.Ms[line];
        Assert.InRange(first!.Value, 100, 5000);
        Assert.Null(log.Ms[1]); // comments aren't timed
        await Task.Delay(50);
        log.Finish(line); // only the first call counts
        Assert.Equal(first, log.Ms[line]);
        log.Finish(99);
        log.Finish(-1);
        Assert.Equal(log.Items.Count, log.Ms.Count);
        Assert.Equal(log.Items.Count, log.Times.Count);
    }

    [Fact]
    public void Lines_copied_from_another_log_keep_their_time_and_duration()
    {
        var log = new SqlLog();
        log.Add("SELECT 1", 1_700_000_000_000, 12.5);
        log.Add("/* done */", 1_700_000_000_100);
        Assert.Equal([1_700_000_000_000, 1_700_000_000_100], log.Times);
        Assert.Equal([12.5, null], log.Ms);
        log.Finish(1); // copied lines can't be finished again
        Assert.Null(log.Ms[1]);
    }
}
