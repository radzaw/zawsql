namespace ZawSQL.Tests.Unit;

public class QueryStatsTests
{
    [Fact]
    public void Delta_takes_off_what_reading_the_counters_costs()
    {
        var before = new Dictionary<string, long> { ["Handler_read_rnd_next"] = 100, ["Handler_read_key"] = 5, ["Sort_rows"] = 0 };
        var after = new Dictionary<string, long> { ["Handler_read_rnd_next"] = 1130, ["Handler_read_key"] = 5, ["Sort_rows"] = 7, ["Created_tmp_tables"] = 2 };
        var overhead = new Dictionary<string, long> { ["Handler_read_rnd_next"] = 30, ["Created_tmp_tables"] = 1 };
        Assert.Equal(new Dictionary<string, long> { ["Handler_read_rnd_next"] = 1000, ["Sort_rows"] = 7, ["Created_tmp_tables"] = 1 },
            QueryStats.Delta(before, after, overhead));
    }

    [Fact]
    public void Counters_that_did_not_move_or_went_back_are_left_out()
    {
        var before = new Dictionary<string, long> { ["Handler_write"] = 10, ["Handler_update"] = 4 };
        var after = new Dictionary<string, long> { ["Handler_write"] = 10, ["Handler_update"] = 3 };
        Assert.Empty(QueryStats.Delta(before, after, null));
    }
}
