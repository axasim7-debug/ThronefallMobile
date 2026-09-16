namespace Thronefall.PositionalEngine;

/// <summary>
/// Full-match scenario: economy (gold, build orders, troop training) driving
/// the continuous positional combat model in Battle.cs, sustained over a
/// realistic match duration — not just an isolated skirmish. A faithful port
/// of tools/battle-sim/src/match.js. See docs/PROGRESS.md.
///
/// Known deliberate simplifications (not oversights — see docs/PROGRESS.md):
///   - farms are pure economy (income) — not physical Battle structures a
///     troop can path into or attack. The positional engine's targeting is
///     purely nearest-in-range, not a staged wall/tower/farm/keep order, so
///     "farm raiding" needs its own deliberate design pass, not a guess.
///   - bots never retreat or reposition once a group is sent — same baseline
///     aggression the OLD model's eco/def/atk archetypes always had; this
///     pass is about economy/combat PACING, not skilled live positioning.
///
/// GROUPING: a troop doesn't march alone the instant it's trained. It waits
/// at its own barracks (in the reserve — not engaged, since nothing enemy is
/// anywhere nearby) until AttackGroupSize troops have queued up, then all of
/// them are sent together. Bots still don't retreat, flank, or spread out
/// once released — this is "attack in numbers," not "attack with skill."
/// </summary>
public static class Match
{
    private const int DefaultAttackGroupSize = 3;

    public static double ReinforcementCeiling(double maxHp, double t)
    {
        var progress = Math.Min(1, t / Content.Reinforce.RampSeconds);
        return maxHp * (Content.Reinforce.StartFraction + (1 - Content.Reinforce.StartFraction) * progress);
    }

    private static (IReadOnlyList<string> TowerIds, string KeepId) BuildDefense(Battle battle, string side, int direction)
    {
        var towerZ = direction * Content.Layout.Tower * Content.PlotDepth;
        var keepZ = direction * Content.Layout.Keep * Content.PlotDepth;
        var towerIds = new[] { -3.0, 3.0 }
            .Select(x => battle.AddStructure(side, x, towerZ, Content.Defense.Tower.Hp, Content.Defense.Tower.Dps, Content.Defense.Tower.Range, key: "tower"))
            .ToList();
        var keepId = battle.AddStructure(side, 0, keepZ, Content.Defense.Keep.Hp, Content.Defense.Keep.Dps, Content.Defense.Keep.Range, key: "keep");
        return (towerIds, keepId);
    }

    private static (double X, double Z) BarracksAnchor(int direction) => (0, direction * Content.Layout.Econ * Content.PlotDepth);
    private static (double X, double Z) KeepAnchor(int direction) => (0, direction * Content.Layout.Keep * Content.PlotDepth);

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

    private static bool StartTroop(MatchPlayer pl, string troopKey)
    {
        if (pl.TroopBusy || !pl.HasBarracks) return false;
        var troop = Content.Troops[troopKey];
        if (pl.Gold < troop.Cost) return false;
        pl.Gold -= troop.Cost;
        pl.TroopBusy = true;
        pl.TroopTimer = troop.BuildTime;
        pl.TroopKey = troopKey;
        return true;
    }

    private static void AdvanceBuild(MatchPlayer pl, int t)
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

    private static void AdvanceTroop(MatchPlayer pl, int t)
    {
        if (!pl.TroopBusy) return;
        pl.TroopTimer--;
        if (pl.TroopTimer > 0) return;
        var troopDef = Content.Troops[pl.TroopKey!];
        pl.TroopsProduced++;
        pl.TroopBusy = false;

        var spawn = BarracksAnchor(pl.Direction);
        var id = pl.Battle.AddUnit(pl.Side, spawn.X, spawn.Z, troopDef.Hp, troopDef.Dps, troopDef.Range, troopDef.Speed, key: pl.TroopKey!);
        pl.Reserve.Add(id); // held back — see GROUPING header comment
    }

    /// <summary>Sends every currently-reserved troop at once toward the enemy
    /// keep, empties the reserve. Bots commit once released — no retreat.</summary>
    private static void ReleaseReserve(MatchPlayer pl, MatchPlayer enemy)
    {
        if (pl.Reserve.Count == 0) return;
        var target = KeepAnchor(enemy.Direction);
        foreach (var id in pl.Reserve) pl.Battle.MoveUnit(id, target.X, target.Z);
        pl.Reserve.Clear();
    }

    public sealed record MatchResult(string Winner, string Tiebreak); // Winner: "A" | "B" | "draw"

    /// <summary>Simulate one full 1v1 match. stratA/stratB expose Decide(pl,
    /// t) (may call StartBuild/StartRepair once) and PickTroop(pl) (defaults
    /// to "infantry"), same shape as server/Thronefall.Engine/Strategies.cs
    /// on purpose — these are the same archetypes, ported.</summary>
    public static (Battle Battle, MatchPlayer A, MatchPlayer B, MatchResult Result) SimulateMatch(IStrategy stratA, IStrategy stratB)
    {
        var battle = new Battle();
        var defA = BuildDefense(battle, "A", -1);
        var defB = BuildDefense(battle, "B", 1);
        var a = new MatchPlayer("A", -1, stratA, battle, defA.TowerIds, defA.KeepId);
        var b = new MatchPlayer("B", 1, stratB, battle, defB.TowerIds, defB.KeepId);

        var duration = Content.Economy.DurationSeconds;
        var subStepsPerSecond = (int)Math.Round(1 / Battle.DefaultDt);

        for (var t = 0; t <= duration; t++)
        {
            if (t > 0)
            {
                var beforeHp = new Dictionary<string, double>();
                foreach (var s in a.MyStructures().Concat(b.MyStructures())) beforeHp[s.Id] = s.Hp;

                for (var i = 0; i < subStepsPerSecond; i++) battle.Step();

                a.ApplyReinforcement(t, beforeHp);
                b.ApplyReinforcement(t, beforeHp);

                foreach (var (pl, enemy) in new[] { (a, b), (b, a) })
                {
                    if (IsKeepDestroyed(battle, pl)) continue;
                    pl.Gold += pl.Income;
                    AdvanceBuild(pl, t);
                    AdvanceTroop(pl, t);
                    var groupSize = pl.Strategy.AttackGroupSize ?? DefaultAttackGroupSize;
                    if (pl.Reserve.Count >= groupSize) ReleaseReserve(pl, enemy);
                }
            }

            foreach (var (pl, _) in new[] { (a, b), (b, a) })
            {
                if (IsKeepDestroyed(battle, pl)) continue;
                if (pl.BuildBusy is null) pl.Strategy.Decide(pl, t);
                if (!pl.TroopBusy) StartTroop(pl, pl.Strategy.PickTroop(pl));
            }

            // end of match: don't leave a half-formed group of trained troops
            // sitting unused forever — send whatever's left, even if too late
            // to matter, so final numbers (TroopsProduced, structure HP)
            // stay honest.
            if (t == duration)
            {
                ReleaseReserve(a, b);
                ReleaseReserve(b, a);
            }
        }

        return (battle, a, b, DetermineWinner(battle, a, b));
    }

    public static bool IsKeepDestroyed(Battle battle, MatchPlayer pl) => battle.Structures[pl.KeepId].Destroyed;

    public static double? KeepDestroyedAtT(Battle battle, MatchPlayer pl)
    {
        var ev = battle.Log.FirstOrDefault(e => e.Event == "structureDestroyed" && e.Side == pl.Side && e.Key == "keep");
        return ev?.T;
    }

    public static int TowersLost(Battle battle, MatchPlayer pl) => pl.TowerIds.Count(id => battle.Structures[id].Destroyed);

    private static MatchResult DetermineWinner(Battle battle, MatchPlayer a, MatchPlayer b)
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
}
