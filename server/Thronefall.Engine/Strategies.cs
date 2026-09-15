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
            var farm = Content.Buildings.Farm;
            var barracks = Content.Buildings.Barracks;
            if (pl.Farms.Count < farm.MaxCount && pl.Gold >= farm.Cost)
            {
                pl.Gold -= farm.Cost; pl.BuildBusy = "farm"; pl.BuildTimer = farm.BuildTime; return;
            }
            if (pl.Farms.Count >= farm.MaxCount && !pl.HasBarracks && pl.Gold >= barracks.Cost)
            {
                pl.Gold -= barracks.Cost; pl.BuildBusy = "barracks"; pl.BuildTimer = barracks.BuildTime;
            }
        }
    }

    public sealed class Def : IStrategy
    {
        public string Name => "def";
        public IReadOnlyList<string> Squad => FullSquad;
        public void Decide(PlayerState pl, int t)
        {
            var wall = Content.Buildings.Wall;
            var barracks = Content.Buildings.Barracks;
            // repairs only compete for the idle build slot once the initial
            // wall -> barracks order is done, so they never preempt reaching barracks
            if (pl.HasBarracks && MatchEngine.StartRepair(pl, t)) return;
            if (pl.WallMaxHp < wall.MaxSegments * wall.HpPerSegment && pl.Gold >= wall.Cost)
            {
                pl.WallMaxHp += wall.HpPerSegment;
                pl.Gold -= wall.Cost; pl.BuildBusy = "wall"; pl.BuildTimer = wall.BuildTime; return;
            }
            if (pl.WallMaxHp >= wall.MaxSegments * wall.HpPerSegment && !pl.HasBarracks && pl.Gold >= barracks.Cost)
            {
                pl.Gold -= barracks.Cost; pl.BuildBusy = "barracks"; pl.BuildTimer = barracks.BuildTime;
            }
        }
    }

    public sealed class Atk : IStrategy
    {
        public string Name => "atk";
        public IReadOnlyList<string> Squad => FullSquad;
        public void Decide(PlayerState pl, int t)
        {
            var barracks = Content.Buildings.Barracks;
            if (!pl.HasBarracks && pl.Gold >= barracks.Cost)
            {
                pl.Gold -= barracks.Cost; pl.BuildBusy = "barracks"; pl.BuildTimer = barracks.BuildTime;
            }
        }
    }

    public static readonly IReadOnlyDictionary<string, IStrategy> All = new Dictionary<string, IStrategy>
    {
        ["eco"] = new Eco(),
        ["def"] = new Def(),
        ["atk"] = new Atk(),
    };
}
