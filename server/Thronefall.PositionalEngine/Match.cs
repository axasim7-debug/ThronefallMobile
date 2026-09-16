namespace Thronefall.PositionalEngine;

/// <summary>
/// Economy (gold, build orders, troop training) driving the continuous
/// positional combat model in Battle.cs. A faithful port of
/// tools/battle-sim/src/match.js. See docs/PROGRESS.md.
///
/// Known deliberate simplifications (not oversights — see docs/PROGRESS.md):
///   - farms are pure economy (income) — not physical Battle structures a
///     troop can path into or attack. The positional engine's targeting is
///     purely nearest-in-range, not a staged wall/tower/farm/keep order, so
///     "farm raiding" needs its own deliberate design pass, not a guess.
///   - a BOT's troops don't retreat or reposition once a group is sent — the
///     same baseline aggression the OLD model's eco/def/atk archetypes always
///     had. A real player, via PlayerController, gets full manual control of
///     every unit the instant it's trained (MoveUnit command) — grouping is
///     bot-testing behavior only, never forced on a live player.
///
/// GROUPING (bot behavior, see PlayerCommands.cs's BotController): a bot's
/// trained troop waits at its own barracks (unordered — nothing enemy is
/// anywhere nearby, so it never auto-engages) until AttackGroupSize troops
/// have queued up, then all of them are sent together. This directly tested
/// the finding that a solo unit dies to a tower's range advantage before it
/// can ever fight back.
/// </summary>
public static class Match
{
    public const int DefaultAttackGroupSize = 3;

    public static double ReinforcementCeiling(double maxHp, double t)
    {
        var progress = Math.Min(1, t / Content.Reinforce.RampSeconds);
        return maxHp * (Content.Reinforce.StartFraction + (1 - Content.Reinforce.StartFraction) * progress);
    }

    internal static (IReadOnlyList<string> TowerIds, string KeepId) BuildDefense(Battle battle, string side, int direction)
    {
        var towerZ = direction * Content.Layout.Tower * Content.PlotDepth;
        var keepZ = direction * Content.Layout.Keep * Content.PlotDepth;
        var towerIds = new[] { -3.0, 3.0 }
            .Select(x => battle.AddStructure(side, x, towerZ, Content.Defense.Tower.Hp, Content.Defense.Tower.Dps, Content.Defense.Tower.Range, key: "tower"))
            .ToList();
        var keepId = battle.AddStructure(side, 0, keepZ, Content.Defense.Keep.Hp, Content.Defense.Keep.Dps, Content.Defense.Keep.Range, key: "keep");
        return (towerIds, keepId);
    }

    internal static (double X, double Z) BarracksAnchor(int direction) => (0, direction * Content.Layout.Econ * Content.PlotDepth);
    internal static (double X, double Z) KeepAnchor(int direction) => (0, direction * Content.Layout.Keep * Content.PlotDepth);

    public static bool StartRepair(MatchPlayer pl, int t)
    {
        if (pl.BuildBusy is not null) return false;
        var target = pl.MyTowers().FirstOrDefault(s => !s.Destroyed && s.Hp < ReinforcementCeiling(s.MaxHp, t));
        if (target is null) return false;
        var missing = ReinforcementCeiling(target.MaxHp, t) - target.Hp;
        var cost = Math.Ceiling(missing * Content.Repair.CostPerMissingHp);
        if (pl.Gold < cost) return false;
        pl.Gold -= cost;
        pl.BuildBusy = "repair";
        pl.BuildTimer = Math.Ceiling(missing * Content.Repair.TimePerMissingHp);
        pl.RepairTargetId = target.Id;
        return true;
    }

    public static bool StartBuild(MatchPlayer pl, string building)
    {
        if (pl.BuildBusy is not null) return false;
        switch (building)
        {
            case "farm":
            {
                var farm = Content.Buildings.Farm;
                if (pl.Farms >= farm.MaxCount || pl.Gold < farm.Cost) return false;
                pl.Gold -= farm.Cost;
                pl.BuildBusy = "farm";
                pl.BuildTimer = farm.BuildTime;
                return true;
            }
            case "barracks":
            {
                var barracks = Content.Buildings.Barracks;
                if (pl.HasBarracks || pl.Gold < barracks.Cost) return false;
                pl.Gold -= barracks.Cost;
                pl.BuildBusy = "barracks";
                pl.BuildTimer = barracks.BuildTime;
                return true;
            }
            default:
                return false;
        }
    }

    public static bool StartTroop(MatchPlayer pl, string troopKey)
    {
        if (pl.TroopBusy || !pl.HasBarracks) return false;
        if (!Content.Troops.TryGetValue(troopKey, out var troop)) return false;
        if (pl.Gold < troop.Cost) return false;
        pl.Gold -= troop.Cost;
        pl.TroopBusy = true;
        pl.TroopTimer = troop.BuildTime;
        pl.TroopKey = troopKey;
        return true;
    }

    internal static void AdvanceBuild(MatchPlayer pl, int t)
    {
        if (pl.BuildBusy is null) return;
        pl.BuildTimer--;
        if (pl.BuildTimer > 0) return;
        switch (pl.BuildBusy)
        {
            case "farm":
                pl.Farms++;
                pl.Income += Content.Buildings.Farm.IncomeBonus;
                break;
            case "barracks":
                pl.HasBarracks = true;
                pl.BarracksT = t;
                break;
            case "repair":
            {
                var target = pl.Battle.Structures[pl.RepairTargetId!];
                // restore to the CURRENT reinforcement ceiling, not raw MaxHp
                // — a repaired tower shouldn't leapfrog the ramp everyone
                // else is still subject to (same as the old engine: repair
                // zeroes DamageTaken, not MaxHp itself).
                pl.ResetDamageTaken(target.Id);
                target.Hp = ReinforcementCeiling(target.MaxHp, t);
                target.Destroyed = false;
                pl.RepairTargetId = null;
                break;
            }
        }
        pl.BuildBusy = null;
    }

    internal static void AdvanceTroop(MatchPlayer pl, int t)
    {
        if (!pl.TroopBusy) return;
        pl.TroopTimer--;
        if (pl.TroopTimer > 0) return;
        var troopDef = Content.Troops[pl.TroopKey!];
        pl.TroopsProduced++;
        pl.TroopBusy = false;

        var spawn = BarracksAnchor(pl.Direction);
        var id = pl.Battle.AddUnit(pl.Side, spawn.X, spawn.Z, troopDef.Hp, troopDef.Dps, troopDef.Range, troopDef.Speed, key: pl.TroopKey!);
        pl.Reserve.Add(id); // unordered until a controller sends it — see header comment
    }

    /// <summary>Sends every currently-reserved troop at once toward the enemy
    /// keep, empties the reserve. Used by BotController (grouped assault) and
    /// by the end-of-match sweep in MatchSession — never forced on a real
    /// player, who commands individual units via MoveUnit instead.</summary>
    public static void ReleaseReserve(MatchPlayer pl, MatchPlayer enemy)
    {
        if (pl.Reserve.Count == 0) return;
        var target = KeepAnchor(enemy.Direction);
        foreach (var id in pl.Reserve) pl.Battle.MoveUnit(id, target.X, target.Z);
        pl.Reserve.Clear();
    }

    public static bool IsKeepDestroyed(Battle battle, MatchPlayer pl) => battle.Structures[pl.KeepId].Destroyed;

    public static double? KeepDestroyedAtT(Battle battle, MatchPlayer pl)
    {
        var ev = battle.Log.FirstOrDefault(e => e.Event == "structureDestroyed" && e.Side == pl.Side && e.Key == "keep");
        return ev?.T;
    }

    public static int TowersLost(Battle battle, MatchPlayer pl) => pl.TowerIds.Count(id => battle.Structures[id].Destroyed);

    public sealed record MatchResult(string Winner, string Tiebreak); // Winner: "A" | "B" | "draw"

    internal static MatchResult DetermineWinner(Battle battle, MatchPlayer a, MatchPlayer b)
    {
        var aDied = KeepDestroyedAtT(battle, a);
        var bDied = KeepDestroyedAtT(battle, b);

        if (aDied is not null && bDied is null) return new("B", "keep-kill");
        if (bDied is not null && aDied is null) return new("A", "keep-kill");
        if (aDied is not null && bDied is not null)
        {
            if (aDied == bDied) return new("draw", "mutual-destruction-same-tick");
            return new(aDied > bDied ? "A" : "B", "mutual-destruction-timing");
        }

        var aTowersLost = TowersLost(battle, a);
        var bTowersLost = TowersLost(battle, b);
        if (aTowersLost != bTowersLost) return new(bTowersLost > aTowersLost ? "A" : "B", "towers-destroyed");

        var aKeepFraction = battle.Structures[a.KeepId].Hp / Content.Defense.Keep.Hp;
        var bKeepFraction = battle.Structures[b.KeepId].Hp / Content.Defense.Keep.Hp;
        if (aKeepFraction != bKeepFraction) return new(aKeepFraction > bKeepFraction ? "A" : "B", "own-keep-hp-pct");

        return new("draw", "true-draw");
    }

    /// <summary>Runs a full bot-vs-bot match. A thin driver over MatchSession
    /// — the tick loop itself lives there and is shared with live networked
    /// matches, so these validated numbers keep testing the code real players
    /// actually run (same relationship as MatchEngine.Simulate / MatchSession
    /// in the old engine).</summary>
    public static (Battle Battle, MatchPlayer A, MatchPlayer B, MatchResult Result) SimulateMatch(IStrategy stratA, IStrategy stratB)
    {
        var session = new MatchSession(new BotController(stratA), new BotController(stratB));
        session.RunToCompletion();
        return (session.Battle, session.A, session.B, session.Result!);
    }
}
