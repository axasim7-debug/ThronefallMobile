namespace Thronefall.PositionalEngine;

// The state contract between server and client. The client is a renderer
// with no game logic (docs/GAME_DESIGN.md §5), so everything it draws has to
// be in here — it never derives a game value itself. Unlike the old engine's
// MatchSnapshot.cs, this one reports real (X, Z) positions for every unit
// and structure — the whole point of the positional model is that the
// client draws where things actually are, not an abstract "troopsProduced"
// counter standing in for motion.

public sealed record StructureView(string Id, string Key, double X, double Z, double Hp, double MaxHp, bool Destroyed);

public sealed record UnitView(string Id, string Key, double X, double Z, double Hp, double MaxHp, double? WaypointX, double? WaypointZ);

public sealed record SideView(
    string Name,
    double Gold,
    double Income,
    int Farms,
    bool HasBarracks,
    string? BuildBusy,
    double BuildTimer,
    bool TroopBusy,
    double TroopTimer,
    string? TroopKey,
    int TroopsProduced,
    double KingX,
    double KingZ,
    double? KingWaypointX,
    double? KingWaypointZ,
    IReadOnlyList<StructureView> Structures,
    IReadOnlyList<UnitView> Units);

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
        return new MatchSnapshot(
            Tick: Math.Max(0, session.Tick),
            Duration: MatchSession.Duration,
            Finished: session.Finished,
            Winner: session.Result is null ? null : Relabel(session.Result.Winner, viewerIsA),
            Tiebreak: session.Result?.Tiebreak,
            You: BuildSide(session.Battle, you),
            Enemy: BuildSide(session.Battle, enemy));
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

    private static SideView BuildSide(Battle battle, MatchPlayer pl)
    {
        var structures = pl.MyStructures()
            .Select(s => new StructureView(s.Id, s.Key, s.X, s.Z, Math.Round(s.Hp), Math.Round(s.MaxHp), s.Destroyed))
            .ToList();
        var units = battle.AliveUnits(pl.Side)
            .Select(u => new UnitView(u.Id, u.Key, u.X, u.Z, Math.Round(u.Hp), Math.Round(u.MaxHp), u.Waypoint?.X, u.Waypoint?.Z))
            .ToList();

        return new SideView(
            Name: pl.Name,
            Gold: Math.Floor(pl.Gold),
            Income: pl.Income,
            Farms: pl.Farms,
            HasBarracks: pl.HasBarracks,
            BuildBusy: pl.BuildBusy,
            BuildTimer: pl.BuildTimer,
            TroopBusy: pl.TroopBusy,
            TroopTimer: pl.TroopTimer,
            TroopKey: pl.TroopKey,
            TroopsProduced: pl.TroopsProduced,
            KingX: pl.KingX,
            KingZ: pl.KingZ,
            KingWaypointX: pl.KingWaypointX,
            KingWaypointZ: pl.KingWaypointZ,
            Structures: structures,
            Units: units);
    }

    /// <summary>
    /// Static costs/timings sent once at match start. The client needs these
    /// to render affordable/unaffordable buttons and troop sizes without ever
    /// computing a game value itself.
    /// </summary>
    public static object Catalog() => new
    {
        buildings = new
        {
            farm = new { cost = Content.Buildings.Farm.Cost, buildTime = Content.Buildings.Farm.BuildTime, maxCount = Content.Buildings.Farm.MaxCount },
            barracks = new { cost = Content.Buildings.Barracks.Cost, buildTime = Content.Buildings.Barracks.BuildTime },
        },
        // No display names here — the client maps these same keys to English
        // text (and, later, any other language) via content-text.ts.
        troops = Content.Troops.ToDictionary(
            kv => kv.Key,
            kv => (object)new { cost = kv.Value.Cost, buildTime = kv.Value.BuildTime, hp = kv.Value.Hp, dps = kv.Value.Dps, range = kv.Value.Range, speed = kv.Value.Speed }),
        defense = new
        {
            towerCount = Content.Defense.TowerCount,
            tower = new { hp = Content.Defense.Tower.Hp, dps = Content.Defense.Tower.Dps, range = Content.Defense.Tower.Range },
            keep = new { hp = Content.Defense.Keep.Hp, dps = Content.Defense.Keep.Dps, range = Content.Defense.Keep.Range },
        },
        layout = new
        {
            plotDepth = Content.PlotDepth,
            tower = Content.Layout.Tower,
            econ = Content.Layout.Econ,
            keep = Content.Layout.Keep,
            // sideways offset of the farm plot from the barracks/keep centerline —
            // see Content.cs's FarmPlotOffsetX comment. The barracks plot sits
            // directly on the centerline at the econ depth, so it needs no
            // separate offset here.
            farmPlotOffsetX = Content.FarmPlotOffsetX,
        },
        king = new { speed = Content.King.Speed, buildRadius = Content.King.BuildRadius },
    };
}
