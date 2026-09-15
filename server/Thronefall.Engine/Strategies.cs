namespace Thronefall.Engine;

/// <summary>
/// Build-order archetypes used to stress-test the engine — a faithful port
/// of tools/balance-sim/src/strategies.js. Not production player logic
/// (real players send real commands over the network); these exist so the
/// C# engine can be regression-tested against the same known-good numbers
/// the JS balance-sim already validated.
/// </summary>
public interface IStrategy
{
    string Name { get; }
    IReadOnlyList<string> Squad { get; }
    void Decide(PlayerState pl, int t);
    string PickTroop(PlayerState pl) => "infantry";
}

public static class Strategies
{
    // launch roster fields all 3 commanders — see docs/GAME_DESIGN.md §3.3
    public static readonly string[] FullSquad = { "warlord", "guardian", "shadow" };

    public sealed class Eco : IStrategy
    {
        public string Name => "eco";
        public IReadOnlyList<string> Squad => FullSquad;
        public void Decide(PlayerState pl, int t)
        {
            if (MatchEngine.StartBuild(pl, "farm")) return;
            if (pl.Farms.Count >= Content.Buildings.Farm.MaxCount) MatchEngine.StartBuild(pl, "barracks");
        }
    }

    public sealed class Def : IStrategy
    {
        public string Name => "def";
        public IReadOnlyList<string> Squad => FullSquad;
        // With no wall to build (removed — see docs/PROGRESS.md), "defensive"
        // no longer means "invest in an extra structure before barracks": the
        // only buildable structures are farm/barracks, both of which "eco"
        // and "atk" already stress-test at their own extremes. This
        // archetype's distinguishing trait now is upkeep discipline instead —
        // one farm for a small cushion, then barracks, then a repair ALWAYS
        // takes the idle build slot over spending on anything else once a
        // tower is damaged.
        public void Decide(PlayerState pl, int t)
        {
            if (MatchEngine.StartRepair(pl, t)) return;
            if (pl.Farms.Count < 1 && MatchEngine.StartBuild(pl, "farm")) return;
            if (!pl.HasBarracks) MatchEngine.StartBuild(pl, "barracks");
        }
    }

    public sealed class Atk : IStrategy
    {
        public string Name => "atk";
        public IReadOnlyList<string> Squad => FullSquad;
        public void Decide(PlayerState pl, int t)
        {
            MatchEngine.StartBuild(pl, "barracks");
        }
    }

    public static readonly IReadOnlyDictionary<string, IStrategy> All = new Dictionary<string, IStrategy>
    {
        ["eco"] = new Eco(),
        ["def"] = new Def(),
        ["atk"] = new Atk(),
    };
}
