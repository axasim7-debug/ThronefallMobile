namespace Thronefall.PositionalEngine;

/// <summary>
/// One side's full-match state: economy (gold, build orders, troop
/// training) plus its stake in the shared Battle (which structures/units are
/// its own). A faithful port of tools/battle-sim/src/match.js's MatchPlayer
/// class — see docs/PROGRESS.md for why the full-match layer exists.
/// </summary>
public sealed class MatchPlayer
{
    public string Side { get; }
    public int Direction { get; }
    public IStrategy Strategy { get; }
    public Battle Battle { get; }
    public IReadOnlyList<string> TowerIds { get; }
    public string KeepId { get; }

    public double Gold { get; set; }
    public double Income { get; set; }
    public int Farms { get; set; }
    public bool HasBarracks { get; set; }
    public string? BuildBusy { get; set; } // "farm" | "barracks" | "repair"
    public double BuildTimer { get; set; }
    public string? RepairTargetId { get; set; }
    public bool TroopBusy { get; set; }
    public double TroopTimer { get; set; }
    public string? TroopKey { get; set; }
    public int TroopsProduced { get; set; }
    public int? BarracksT { get; set; }

    /// <summary>Unit ids trained but not yet sent — see Match.cs's GROUPING
    /// header comment.</summary>
    public List<string> Reserve { get; } = new();

    // Reinforcement bookkeeping: cumulative REAL combat damage taken, kept
    // separate from a structure's own (ceiling-suppressed) raw Hp.
    private readonly Dictionary<string, double> _damageTaken = new();

    public MatchPlayer(string side, int direction, IStrategy strategy, Battle battle, IReadOnlyList<string> towerIds, string keepId)
    {
        Side = side;
        Direction = direction;
        Strategy = strategy;
        Battle = battle;
        TowerIds = towerIds;
        KeepId = keepId;

        Gold = Content.Economy.StartGold;
        Income = Content.Economy.BaseIncome;

        foreach (var s in MyStructures())
        {
            _damageTaken[s.Id] = 0;
            s.Hp = Match.ReinforcementCeiling(s.MaxHp, 0); // soften starting HP immediately
        }
    }

    public IEnumerable<Structure> MyStructures() =>
        TowerIds.Select(id => Battle.Structures[id]).Append(Battle.Structures[KeepId]);

    /// <summary>Repair's own eligible targets — towers only, same as the
    /// shipped engine's DamagedStructureNeeding (server/Thronefall.Engine/
    /// MatchEngine.cs): the keep was never repairable, only reinforced over
    /// time. An earlier version of this used MyStructures() (towers + keep)
    /// for repair too, letting "def" actively heal its keep — a capability
    /// the design never intended, and the real cause of it dominating every
    /// other archetype (see docs/PROGRESS.md).</summary>
    public IEnumerable<Structure> MyTowers() => TowerIds.Select(id => Battle.Structures[id]);

    public void ResetDamageTaken(string structureId) => _damageTaken[structureId] = 0;

    /// <summary>Recompute each of this side's structures' effective HP against
    /// the rising reinforcement ceiling, after combat for tick `t` has
    /// resolved. `beforeHp` is each structure's Hp snapshotted right before
    /// this tick's combat ran — the ONLY correct way to measure "damage dealt
    /// this tick", since a structure's Hp already has all PRIOR damage baked
    /// into it (a first version of this re-derived a "previous ceiling" from
    /// the formula instead of a real snapshot, which silently re-counted a
    /// structure's entire damage history as new damage every single tick —
    /// caught by a calibration sweep where the reinforcement curve stopped
    /// mattering at all, which should have been impossible; see
    /// docs/PROGRESS.md). Skips anything already destroyed — reinforcement
    /// never revives a structure the engine already declared dead.</summary>
    public void ApplyReinforcement(int t, IReadOnlyDictionary<string, double> beforeHp)
    {
        foreach (var s in MyStructures())
        {
            if (s.Destroyed) continue;
            var dealtThisTick = Math.Max(0, beforeHp[s.Id] - s.Hp);
            var dt = _damageTaken[s.Id] + dealtThisTick;
            _damageTaken[s.Id] = dt;
            s.Hp = Math.Max(0, Match.ReinforcementCeiling(s.MaxHp, t) - dt);
        }
    }
}
