namespace Thronefall.Engine;

// Faithful C# port of tools/balance-sim/src/content.js. Keep this file and
// its JS counterpart in sync deliberately — a balance number tested and
// adopted there is meant to ship here unchanged. See docs/PROGRESS.md for
// the full history of why each of these numbers is what it is.

public sealed record EconomyConfig(int DurationSeconds, double StartGold, double BaseIncome);

public sealed record FarmConfig(
    double Cost, double BuildTime, double IncomeBonus, double Hp, int MaxCount,
    double AssaultEngageTime, double DisruptionPenalty, double DisruptionSeconds);

public sealed record BarracksConfig(double Cost, double BuildTime);

public sealed record BuildingsConfig(FarmConfig Farm, BarracksConfig Barracks);

public sealed record TowerConfig(double Hp, double Dps, double EngageTime);
public sealed record KeepConfig(double Hp, double Dps, double EngageTime);
public sealed record ReinforceConfig(double StartFraction, double RampSeconds);

public sealed record DefenseConfig(int TowerCount, TowerConfig Tower, double CrossFireFactor, KeepConfig Keep, ReinforceConfig Reinforce);

public sealed record RepairConfig(double CostPerMissingHp, double TimePerMissingHp);

// No display name here on purpose: the engine ships stable keys only
// ("cavalry", "warlord", ...), never a string meant for a player's eyes.
// The client owns display text (name, description, localization) keyed off
// these same keys — see client/src/content-text.ts. That split is what lets
// the game ship in English now and add languages later without touching the
// engine, and it's why a catalog dump of this file was never localizable in
// the first place.
public sealed record TroopConfig(
    double Cost, double BuildTime, double MarchTime, double HpFactor, double DpsFactor,
    double? DefenseResistFactor = null,
    string[]? Bypasses = null,
    IReadOnlyDictionary<string, double>? DamageProfile = null);

public sealed record RageConfig(double Max, double FillRatePerSec);

public sealed record TroopTargetBonus(string Troop, double[] MultByLevel);
public sealed record TroopsTargetBonus(string[] Troops, double[] MultByLevel);
public sealed record RageEffectConfig(string Kind, string Target, double[] AmountByLevel);
public sealed record MasteryConfig(double RageEffectMultiplier);

public sealed record CommanderPassives(
    TroopTargetBonus? TroopDpsBonus = null,
    TroopTargetBonus? TroopDpsBonus2 = null,
    TroopTargetBonus? TroopHpBonus = null,
    double[]? StructureDamageTakenMultByLevel = null,
    TroopsTargetBonus? MarchTimeMult = null,
    TroopsTargetBonus? InfiltratorResistMult = null,
    double[]? RageEffectBonusByLevel = null);

// Same rule as TroopConfig: no display name, keys only.
public sealed record CommanderConfig(
    string[] SkillOrder, double RageCost, RageEffectConfig RageEffect,
    CommanderPassives Passives, MasteryConfig Mastery);

public static class Content
{
    // Skill-level curve: identical to bonusCurve/reductionCurve/amountCurve
    // in content.js. Level 5 always equals the previously flat-tested value.
    private static readonly double[] LevelFractions = { 0.4, 0.6, 0.75, 0.9, 1.0 };

    public static double[] BonusCurve(double level5Mult) =>
        LevelFractions.Select(f => 1 + (level5Mult - 1) * f).ToArray();

    public static double[] ReductionCurve(double level5Mult) =>
        LevelFractions.Select(f => 1 - (1 - level5Mult) * f).ToArray();

    public static double[] AmountCurve(double level5Amount) =>
        LevelFractions.Select(f => Math.Round(level5Amount * f)).ToArray();

    public static readonly EconomyConfig Economy = new(DurationSeconds: 360, StartGold: 100, BaseIncome: 8);

    public static readonly BuildingsConfig Buildings = new(
        Farm: new FarmConfig(
            Cost: 150, BuildTime: 8, IncomeBonus: 5, Hp: 60, MaxCount: 2,
            AssaultEngageTime: 2, DisruptionPenalty: 6, DisruptionSeconds: 40),
        Barracks: new BarracksConfig(Cost: 200, BuildTime: 12));

    public static readonly DefenseConfig Defense = new(
        TowerCount: 2,
        Tower: new TowerConfig(Hp: 700, Dps: 20, EngageTime: 5),
        CrossFireFactor: 0.45,
        Keep: new KeepConfig(Hp: 1200, Dps: 30, EngageTime: 1.5),
        Reinforce: new ReinforceConfig(StartFraction: 0.35, RampSeconds: 90));

    public static readonly RepairConfig Repair = new(CostPerMissingHp: 0.6, TimePerMissingHp: 0.08);

    public static readonly IReadOnlyDictionary<string, TroopConfig> Troops = new Dictionary<string, TroopConfig>
    {
        ["infantry"] = new(Cost: 60, BuildTime: 3, MarchTime: 6, HpFactor: 3.5, DpsFactor: 0.4),
        ["archer"] = new(Cost: 70, BuildTime: 4, MarchTime: 4, HpFactor: 1.3, DpsFactor: 0.6, DefenseResistFactor: 0.7),
        ["cavalry"] = new(Cost: 90, BuildTime: 4, MarchTime: 2, HpFactor: 0.8, DpsFactor: 0.75),
        ["ninja"] = new(Cost: 130, BuildTime: 6, MarchTime: 4, HpFactor: 0.8, DpsFactor: 0.5,
            Bypasses: new[] { "tower" }),
        ["fire"] = new(Cost: 55, BuildTime: 2, MarchTime: 4, HpFactor: 0.5, DpsFactor: 0.4,
            DamageProfile: new Dictionary<string, double> { ["farm"] = 3, ["keep"] = 2.5 }),
        ["engineer"] = new(Cost: 90, BuildTime: 6, MarchTime: 7, HpFactor: 1.8, DpsFactor: 0.5,
            DamageProfile: new Dictionary<string, double> { ["tower"] = 2 }),
    };

    public static readonly RageConfig Rage = new(Max: 10, FillRatePerSec: 10.0 / 90.0);

    public static readonly IReadOnlyDictionary<string, CommanderConfig> Commanders = new Dictionary<string, CommanderConfig>
    {
        ["warlord"] = new(
            SkillOrder: new[] { "rage", "troopDpsBonus", "troopDpsBonus2", "rageEffectBonus" },
            RageCost: 6,
            RageEffect: new("damageStructure", "enemyTower", AmountCurve(320)),
            Passives: new CommanderPassives(
                TroopDpsBonus: new("cavalry", BonusCurve(1.15)),
                TroopDpsBonus2: new("engineer", BonusCurve(1.15)),
                RageEffectBonusByLevel: BonusCurve(1.2)),
            Mastery: new(RageEffectMultiplier: 1.15)),

        ["guardian"] = new(
            SkillOrder: new[] { "rage", "troopHpBonus", "structureDamageTakenMult", "rageEffectBonus" },
            RageCost: 6,
            RageEffect: new("repairStructure", "ownDamaged", AmountCurve(260)),
            Passives: new CommanderPassives(
                TroopHpBonus: new("infantry", BonusCurve(1.2)),
                StructureDamageTakenMultByLevel: ReductionCurve(0.9),
                RageEffectBonusByLevel: BonusCurve(1.2)),
            Mastery: new(RageEffectMultiplier: 1.15)),

        ["shadow"] = new(
            SkillOrder: new[] { "rage", "marchTimeMult", "infiltratorResistMult", "rageEffectBonus" },
            RageCost: 6,
            RageEffect: new("damageStructure", "enemyFarm", AmountCurve(200)),
            Passives: new CommanderPassives(
                MarchTimeMult: new(new[] { "ninja", "fire" }, ReductionCurve(0.85)),
                InfiltratorResistMult: new(new[] { "ninja", "fire" }, ReductionCurve(0.85)),
                RageEffectBonusByLevel: BonusCurve(1.2)),
            Mastery: new(RageEffectMultiplier: 1.15)),
    };
}
