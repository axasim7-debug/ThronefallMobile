namespace Thronefall.Engine;

// The state contract between server and client. The client is a renderer
// with no game logic (docs/GAME_DESIGN.md §5), so everything it draws has to
// be in here — it never derives a game value itself.
//
// HP is reported already resolved against the reinforcement ramp (defenses
// start at 35% and harden to 100% over 90s), so the client just draws the
// number it is given.

public sealed record StructureView(double Hp, double MaxHp, bool Destroyed);

public sealed record FarmView(double Hp, double MaxHp, bool IncomeRemoved);

// No Name field — the key is the only identity the engine ships; the client
// maps it to display text (see content-text.ts).
public sealed record CommanderView(string Key, double Rage, double RageCost, bool Ready, int Casts, bool Mastered);

public sealed record SideView(
    string Name,
    double Gold,
    double Income,
    double IncomePenalty,
    IReadOnlyList<FarmView> Farms,
    double WallHp,
    double WallMaxHp,
    bool HasBarracks,
    string? BuildBusy,
    double BuildTimer,
    bool TroopBusy,
    double TroopTimer,
    string? TroopKey,
    int TroopsProduced,
    IReadOnlyList<StructureView> Towers,
    StructureView Keep,
    IReadOnlyList<CommanderView> Commanders,
    int TowersLost,
    int FarmsRaided);

public sealed record MatchSnapshot(
    int Tick,
    int Duration,
    bool Finished,
    string? Winner,
    string? Tiebreak,
    SideView You,
    SideView Enemy);

public static class SnapshotBuilder
{
    public static MatchSnapshot Build(MatchSession session, bool viewerIsA)
    {
        var you = viewerIsA ? session.A : session.B;
        var enemy = viewerIsA ? session.B : session.A;
        var t = Math.Max(0, session.Tick);
        return new MatchSnapshot(
            Tick: t,
            Duration: MatchSession.Duration,
            Finished: session.Finished,
            Winner: session.Result is null ? null : Relabel(session.Result.Winner, viewerIsA),
            Tiebreak: session.Result?.Tiebreak,
            You: BuildSide(you, t),
            Enemy: BuildSide(enemy, t));
    }

    // The engine's result is in absolute sides (A/B); each client sees it
    // from its own seat so the client never has to know which side it is.
    private static string Relabel(string winner, bool viewerIsA) => winner switch
    {
        "draw" => "draw",
        "A" => viewerIsA ? "you" : "enemy",
        "B" => viewerIsA ? "enemy" : "you",
        _ => winner,
    };

    private static SideView BuildSide(PlayerState pl, int t)
    {
        var farmCfg = Content.Buildings.Farm;
        return new SideView(
            Name: pl.Strategy,
            Gold: Math.Floor(pl.Gold),
            Income: pl.Income,
            IncomePenalty: pl.Disruptions.Sum(d => d.Amount),
            Farms: pl.Farms.Select(f => new FarmView(f.Hp, farmCfg.Hp, f.IncomeRemoved)).ToList(),
            WallHp: pl.WallHp,
            WallMaxHp: pl.WallMaxHp,
            HasBarracks: pl.HasBarracks,
            BuildBusy: pl.BuildBusy,
            BuildTimer: pl.BuildTimer,
            TroopBusy: pl.TroopBusy,
            TroopTimer: pl.TroopTimer,
            TroopKey: pl.TroopKey,
            TroopsProduced: pl.TroopsProduced,
            Towers: pl.Towers.Select(s => new StructureView(
                Math.Round(MatchEngine.CurrentHp(s, t)),
                Math.Round(MatchEngine.Ceiling(s.MaxHp, t)),
                s.Destroyed)).ToList(),
            Keep: new StructureView(
                Math.Round(MatchEngine.CurrentHp(pl.Keep, t)),
                Math.Round(MatchEngine.Ceiling(pl.Keep.MaxHp, t)),
                pl.Keep.Destroyed),
            Commanders: pl.Commanders.Select(c =>
            {
                var def = Content.Commanders[c.Key];
                return new CommanderView(c.Key, Math.Round(c.Rage, 2), def.RageCost,
                    c.Rage >= def.RageCost, c.Casts, c.IsMastered());
            }).ToList(),
            TowersLost: pl.Stats.TowersLost,
            FarmsRaided: pl.Stats.FarmsRaided);
    }

    /// <summary>
    /// Static costs/timings sent once at match start. The client needs these
    /// to render affordable/unaffordable buttons without ever computing a
    /// game outcome itself.
    /// </summary>
    public static object Catalog() => new
    {
        buildings = new
        {
            farm = new { cost = Content.Buildings.Farm.Cost, buildTime = Content.Buildings.Farm.BuildTime, maxCount = Content.Buildings.Farm.MaxCount },
            wall = new { cost = Content.Buildings.Wall.Cost, buildTime = Content.Buildings.Wall.BuildTime, maxSegments = Content.Buildings.Wall.MaxSegments, hpPerSegment = Content.Buildings.Wall.HpPerSegment },
            barracks = new { cost = Content.Buildings.Barracks.Cost, buildTime = Content.Buildings.Barracks.BuildTime },
        },
        // No display names here — the client maps these same keys to English
        // text (and, later, any other language) via content-text.ts.
        troops = Content.Troops.ToDictionary(
            kv => kv.Key,
            kv => (object)new { cost = kv.Value.Cost, buildTime = kv.Value.BuildTime, marchTime = kv.Value.MarchTime }),
        commanders = Content.Commanders.ToDictionary(
            kv => kv.Key,
            kv => (object)new { rageCost = kv.Value.RageCost }),
        rage = new { max = Content.Rage.Max, fillRatePerSec = Content.Rage.FillRatePerSec },
    };
}
