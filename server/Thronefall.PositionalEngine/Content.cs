namespace Thronefall.PositionalEngine;

// Real launch-roster numbers for the full-match scenario (economy + the
// continuous positional combat model together) — a faithful C# port of
// tools/battle-sim/src/match-content.js. NOT a new balance pass:
// cost/hpFactor/dpsFactor/marchTime are the numbers already adopted in
// server/Thronefall.Engine/Content.cs; this file only translates them into
// what the positional model needs (hp/dps/range/speed instead of
// hpFactor/dpsFactor/marchTime). See docs/PROGRESS.md.

public sealed record EconomyConfig(int DurationSeconds, double StartGold, double BaseIncome);

public sealed record FarmConfig(double Cost, double BuildTime, double IncomeBonus, int MaxCount);
public sealed record BarracksConfig(double Cost, double BuildTime);
public sealed record BuildingsConfig(FarmConfig Farm, BarracksConfig Barracks);

public sealed record TroopConfig(double Cost, double BuildTime, double Hp, double Dps, double Speed, double Range);

public sealed record TowerConfig(double Hp, double Dps, double Range);
public sealed record KeepConfig(double Hp, double Dps, double Range);
public sealed record DefenseConfig(int TowerCount, TowerConfig Tower, KeepConfig Keep);

// Same numbers as the shipped engine's ReinforceConfig: defenses start at
// StartFraction of max effective HP and harden to 100% over RampSeconds.
// Load-bearing here too: the continuous model's real exposure-time damage
// makes full-strength towers from tick 0 nearly unbeatable for a lone early
// unit — see docs/PROGRESS.md.
public sealed record ReinforceConfig(double StartFraction, double RampSeconds);

// Same numbers as the shipped engine's RepairConfig — repair cost/time scale
// with missing HP. Repair only ever covers towers, never the keep — see
// Match.cs's header comment for why that distinction matters.
public sealed record RepairConfig(double CostPerMissingHp, double TimePerMissingHp);

public sealed record LayoutConfig(double Tower, double Econ, double Keep);

// The king: the player's own mobile presence on the field. Building,
// upgrading, and repairing all require walking the king within BuildRadius
// of the target first (docs/PROGRESS.md — "king walks and builds", agreed
// directly with the user, not in GAME_DESIGN.md). Speed is a deliberate
// middle ground: faster than the tankiest troop (infantry), slower than the
// fastest (cavalry) — the king is the one piece a player moves constantly,
// so it shouldn't be the slowest thing on the field, but it also isn't a
// combat unit and has no reason to outrun a shock-cavalry rush.
public sealed record KingConfig(double Speed, double BuildRadius);

public static class Content
{
    public static readonly EconomyConfig Economy = new(DurationSeconds: 360, StartGold: 100, BaseIncome: 8);

    public static readonly BuildingsConfig Buildings = new(
        Farm: new FarmConfig(Cost: 150, BuildTime: 8, IncomeBonus: 5, MaxCount: 2),
        Barracks: new BarracksConfig(Cost: 200, BuildTime: 12));

    // Real client layout (client/src/scene.ts): PlotDepth=7.5, fractions from
    // the river inward (wall removed — see docs/PROGRESS.md). Reused
    // verbatim, not re-guessed.
    public const double PlotDepth = 7.5;
    public static readonly LayoutConfig Layout = new(Tower: 0.36, Econ: 0.58, Keep: 0.86);

    // Total straight-line distance a troop actually has to cover in the
    // positional model: from its own side's barracks to the enemy's keep,
    // unobstructed. This is ONLY a unit-conversion anchor — it turns the old
    // model's marchTime (a number that meant "when combat resolves", with no
    // real distance behind it) into a speed stat the positional model needs.
    // It is not a new balance number.
    public static readonly double MarchDistance = Layout.Econ * PlotDepth + Layout.Keep * PlotDepth; // 4.35 + 6.45 = 10.8

    // NOTE: the positional engine only knows hp/dps/range/speed right now —
    // it never implemented the old engine's per-troop Bypasses/DamageProfile/
    // DefenseResistFactor mechanics (ninja slipping past towers, engineer's
    // siege bonus, archer's return-fire resistance, fire's arson bonus).
    // Giving those their positional-combat equivalent is a real design
    // question, deliberately left for its own pass rather than guessed here.
    // All six troops below differ ONLY by hp/dps/range/speed.
    private static TroopConfig Troop(double cost, double buildTime, double marchTime, double hpFactor, double dpsFactor, double range = 1.2) =>
        new(Cost: cost, BuildTime: buildTime, Hp: hpFactor * cost, Dps: dpsFactor * cost, Speed: MarchDistance / marchTime, Range: range);

    public static readonly IReadOnlyDictionary<string, TroopConfig> Troops = new Dictionary<string, TroopConfig>
    {
        ["infantry"] = Troop(cost: 60, buildTime: 3, marchTime: 6, hpFactor: 3.5, dpsFactor: 0.4),
        ["archer"] = Troop(cost: 70, buildTime: 4, marchTime: 4, hpFactor: 1.3, dpsFactor: 0.6, range: 4.5),
        ["cavalry"] = Troop(cost: 90, buildTime: 4, marchTime: 2, hpFactor: 0.8, dpsFactor: 0.75),
        ["ninja"] = Troop(cost: 130, buildTime: 6, marchTime: 4, hpFactor: 0.8, dpsFactor: 0.5),
        ["fire"] = Troop(cost: 55, buildTime: 2, marchTime: 4, hpFactor: 0.5, dpsFactor: 0.4),
        ["engineer"] = Troop(cost: 90, buildTime: 6, marchTime: 7, hpFactor: 1.8, dpsFactor: 0.5),
    };

    // Fixed baseline defense, same numbers as the shipped engine
    // (server/Thronefall.Engine/Content.cs's DefenseConfig).
    public static readonly DefenseConfig Defense = new(
        TowerCount: 2,
        Tower: new TowerConfig(Hp: 700, Dps: 20, Range: 6.0),
        Keep: new KeepConfig(Hp: 1200, Dps: 30, Range: 3.5));

    public static readonly ReinforceConfig Reinforce = new(StartFraction: 0.35, RampSeconds: 90);

    public static readonly RepairConfig Repair = new(CostPerMissingHp: 0.6, TimePerMissingHp: 0.08);

    // Speed sits between infantry's (MarchDistance/6 ≈ 1.8) and cavalry's
    // (MarchDistance/2 ≈ 5.4) — see the KingConfig doc comment.
    public static readonly KingConfig King = new(Speed: 2.6, BuildRadius: 1.5);

    // How far off the barracks/keep centerline the farm plot sits — a plain
    // sideways offset at the same depth as the barracks anchor, giving the
    // king a real, distinct spot to walk to that isn't the barracks itself.
    public const double FarmPlotOffsetX = 2.5;
}
