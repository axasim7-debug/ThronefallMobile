namespace Thronefall.PositionalEngine;

/// <summary>
/// Build-order archetypes for the full-match scenario — a faithful port of
/// tools/battle-sim/src/match-strategies.js's eco/def/atk (and the
/// post-wall-removal "def" redesign there: repair-first discipline instead
/// of investing in a wall that no longer exists — see docs/PROGRESS.md).
/// </summary>
public interface IStrategy
{
    string Name { get; }
    void Decide(MatchPlayer pl, int t);
    string PickTroop(MatchPlayer pl) => "infantry";
    int? AttackGroupSize => null; // null = Match's default group size
}

public static class Strategies
{
    public sealed class Eco : IStrategy
    {
        public string Name => "eco";
        public void Decide(MatchPlayer pl, int t)
        {
            var farm = Content.Buildings.Farm;
            var barracks = Content.Buildings.Barracks;
            if (pl.Farms < farm.MaxCount && pl.Gold >= farm.Cost) { Match.StartBuild(pl, "farm"); return; }
            if (pl.Farms >= farm.MaxCount && !pl.HasBarracks && pl.Gold >= barracks.Cost) Match.StartBuild(pl, "barracks");
        }
    }

    // With no wall to build (removed — see docs/PROGRESS.md), "defensive"
    // no longer means "invest in an extra structure before barracks": the
    // only buildable structures are farm/barracks, both of which "eco" and
    // "atk" already stress-test at their own extremes. This archetype's
    // distinguishing trait is upkeep discipline instead — one farm for a
    // small cushion, then barracks, then a repair ALWAYS takes the idle
    // build slot over spending on anything else once a tower is damaged.
    public sealed class Def : IStrategy
    {
        public string Name => "def";
        public void Decide(MatchPlayer pl, int t)
        {
            var barracks = Content.Buildings.Barracks;
            if (Match.StartRepair(pl, t)) return;
            if (pl.Farms < 1 && Match.StartBuild(pl, "farm")) return;
            if (!pl.HasBarracks && pl.Gold >= barracks.Cost) Match.StartBuild(pl, "barracks");
        }
    }

    public sealed class Atk : IStrategy
    {
        public string Name => "atk";
        public void Decide(MatchPlayer pl, int t)
        {
            var barracks = Content.Buildings.Barracks;
            if (!pl.HasBarracks && pl.Gold >= barracks.Cost) Match.StartBuild(pl, "barracks");
        }
    }

    public static readonly IReadOnlyDictionary<string, IStrategy> All = new Dictionary<string, IStrategy>
    {
        ["eco"] = new Eco(),
        ["def"] = new Def(),
        ["atk"] = new Atk(),
    };
}
