namespace ZawSQL.Tests.Unit;

public class SqlDumperTests
{
    [Fact]
    public void Views_come_after_the_views_they_select_from()
    {
        var views = new Dictionary<string, string?>
        {
            ["a_summary"] = "CREATE VIEW `a_summary` AS select `b_base`.`id` AS `id` from `b_base`",
            ["b_base"] = "CREATE VIEW `b_base` AS select `c_raw`.`id` AS `id` from `c_raw`",
            ["c_raw"] = "CREATE VIEW `c_raw` AS select `t`.`id` AS `id` from `t`",
            ["d_alone"] = "CREATE VIEW `d_alone` AS select 1 AS `x`",
        };
        Assert.Equal(["c_raw", "b_base", "a_summary", "d_alone"], SqlDumper.DependencyOrder(views));
    }

    [Fact]
    public void A_cycle_still_lists_every_view_once()
    {
        // Only possible through same-named columns, but the order must still be complete.
        var views = new Dictionary<string, string?>
        {
            ["x"] = "CREATE VIEW `x` AS select `y`.`a` AS `y` from `y`",
            ["y"] = "CREATE VIEW `y` AS select 1 AS `x`",
        };
        var order = SqlDumper.DependencyOrder(views);
        Assert.Equal(2, order.Count);
        Assert.Equal(["x", "y"], order.Order());
    }
}
