namespace Thronefall.Engine;

/// <summary>
/// Faithful C# port of tools/balance-sim/src/engine.js. Keep the two in
/// sync deliberately: this is the AUTHORITATIVE server-side simulation
/// (docs/GAME_DESIGN.md §5.3) — the JS copy in tools/balance-sim stays as
/// the fast iteration/balance-testing tool, this one is what real matches
/// actually run on. A troop's combat behavior is still data-driven via
/// Bypasses / DamageProfile / DefenseResistFactor on its TroopConfig —
/// see content.js's engine.js header comment for the rationale, it holds
/// here unchanged.
/// </summary>
public static class MatchEngine
{
    public static double Ceiling(double maxHp, int t)
    {
        var r = Content.Defense.Reinforce;
        var progress = Math.Min(1.0, t / r.RampSeconds);
        return maxHp * (r.StartFraction + (1 - r.StartFraction) * progress);
    }

    public static double CurrentHp(Structure s, int t) =>
        s.Destroyed ? 0 : Math.Max(0, Ceiling(s.MaxHp, t) - s.DamageTaken);

    internal static void DamageStructure(Structure s, double dmg, int t)
    {
        s.DamageTaken += dmg;
        if (!s.Destroyed && CurrentHp(s, t) <= 0) s.Destroyed = true;
    }

    public static PlayerState InitPlayer(string strategyName, IReadOnlyList<(string Key, Dictionary<string, int>? Levels)>? squad = null)
    {
        var pl = new PlayerState
        {
            Strategy = strategyName,
            Gold = Content.Economy.StartGold,
            Income = Content.Economy.BaseIncome,
            Keep = new Structure(Content.Defense.Keep.Hp),
        };
        for (var i = 0; i < Content.Defense.TowerCount; i++) pl.Towers.Add(new Structure(Content.Defense.Tower.Hp));

        foreach (var entry in squad ?? Array.Empty<(string, Dictionary<string, int>?)>())
        {
            var order = Content.Commanders[entry.Key].SkillOrder;
            var levels = new Dictionary<string, int>();
            foreach (var skill in order) levels[skill] = entry.Levels?.GetValueOrDefault(skill) ?? 3;
            pl.Commanders.Add(new CommanderInstance { Key = entry.Key, Levels = levels });
        }
        return pl;
    }

    // convenience overload: bare commander keys, default level-3 loadout
    public static PlayerState InitPlayer(string strategyName, IReadOnlyList<string> squadKeys) =>
        InitPlayer(strategyName, squadKeys.Select(k => (k, (Dictionary<string, int>?)null)).ToList());

    private static double AtLevel(double[] byLevel, int level) => byLevel[Math.Clamp(level, 1, 5) - 1];

    // ---- economy building ----

    private static Structure? DamagedStructureNeeding(PlayerState pl, int t) =>
        pl.Towers.FirstOrDefault(s => CurrentHp(s, t) < Ceiling(s.MaxHp, t));

    public static bool StartRepair(PlayerState pl, int t)
    {
        // Repair occupies the same single build slot as everything else.
        // Bots only ever call this with an idle slot, so this guard changes
        // no existing number — but without it a networked player could
        // overwrite (and silently cancel) a build they had already paid for.
        if (pl.BuildBusy is not null) return false;
        var tower = DamagedStructureNeeding(pl, t);
        if (tower is null) return false;
        var r = Content.Repair;
        var missingHp = Ceiling(tower.MaxHp, t) - CurrentHp(tower, t);
        var towerCost = Math.Ceiling(missingHp * r.CostPerMissingHp);
        if (pl.Gold < towerCost) return false;
        pl.Gold -= towerCost;
        pl.BuildBusy = "repairTower";
        pl.BuildTimer = Math.Ceiling(missingHp * r.TimePerMissingHp);
        pl.RepairTargetTower = tower;
        return true;
    }

    /// <summary>
    /// Server-authoritative build order. Both the test bots (Strategies) and
    /// real player commands (MatchSession) go through this exact path, so a
    /// networked player can never obtain a build a bot couldn't — the
    /// affordability/prerequisite rules live in one place only.
    /// Returns false (rather than throwing) when the order is illegal.
    /// </summary>
    public static bool StartBuild(PlayerState pl, string building)
    {
        if (pl.BuildBusy is not null) return false;
        switch (building)
        {
            case "farm":
            {
                var farm = Content.Buildings.Farm;
                if (pl.Farms.Count >= farm.MaxCount || pl.Gold < farm.Cost) return false;
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

    public static bool StartTroop(PlayerState pl, string troopKey)
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

    internal static void AdvanceBuild(PlayerState pl, int t)
    {
        if (pl.BuildBusy is null) return;
        pl.BuildTimer--;
        if (pl.BuildTimer > 0) return;
        switch (pl.BuildBusy)
        {
            case "farm":
                pl.Farms.Add(new FarmInstance { Hp = Content.Buildings.Farm.Hp });
                pl.Income += Content.Buildings.Farm.IncomeBonus;
                break;
            case "barracks":
                pl.HasBarracks = true;
                pl.BarracksT = t;
                break;
            case "repairTower":
                pl.RepairTargetTower!.DamageTaken = 0;
                pl.RepairTargetTower!.Destroyed = false;
                pl.RepairTargetTower = null;
                pl.Stats.RepairsDone++;
                break;
        }
        pl.BuildBusy = null;
    }

    internal static void AdvanceTroop(PlayerState pl, int t, Action<MarchingTroop> onSpawn)
    {
        if (!pl.TroopBusy) return;
        pl.TroopTimer--;
        if (pl.TroopTimer > 0) return;
        var troopDef = Content.Troops[pl.TroopKey!];
        pl.TroopsProduced++;
        pl.ArmyValue += troopDef.Cost;
        pl.TroopBusy = false;
        pl.FirstTroopT ??= t;

        double dps = troopDef.DpsFactor * troopDef.Cost;
        double hp = troopDef.HpFactor * troopDef.Cost;
        double marchTime = troopDef.MarchTime;
        double resistFactor = troopDef.DefenseResistFactor ?? 1;

        foreach (var cmd in pl.Commanders)
        {
            var p = Content.Commanders[cmd.Key].Passives;
            if (p.TroopDpsBonus is { } b1 && b1.Troop == pl.TroopKey) dps *= AtLevel(b1.MultByLevel, cmd.Levels["troopDpsBonus"]);
            if (p.TroopDpsBonus2 is { } b2 && b2.Troop == pl.TroopKey) dps *= AtLevel(b2.MultByLevel, cmd.Levels["troopDpsBonus2"]);
            if (p.TroopHpBonus is { } b3 && b3.Troop == pl.TroopKey) hp *= AtLevel(b3.MultByLevel, cmd.Levels["troopHpBonus"]);
            if (p.MarchTimeMult is { } b4 && b4.Troops.Contains(pl.TroopKey)) marchTime *= AtLevel(b4.MultByLevel, cmd.Levels["marchTimeMult"]);
            if (p.InfiltratorResistMult is { } b5 && b5.Troops.Contains(pl.TroopKey)) resistFactor *= AtLevel(b5.MultByLevel, cmd.Levels["infiltratorResistMult"]);
        }

        // rounded to a whole tick (MidpointRounding.AwayFromZero to match
        // JS's Math.round semantics exactly) — a passive (shadow's
        // marchTimeMult) can make this fractional, and the tick loop only
        // ever looks up integer ticks; an un-rounded arrival would silently
        // never resolve. Found and fixed in the JS port first — see
        // tools/balance-sim/src/engine.js's matching comment.
        var arriveAt = t + (int)Math.Round(marchTime, MidpointRounding.AwayFromZero);
        onSpawn(new MarchingTroop(pl.TroopKey!, t, arriveAt, hp, dps, troopDef.Bypasses, troopDef.DamageProfile, resistFactor));
    }

    // ---- combat ----

    private static double DmgMult(MarchingTroop troop, string targetType) =>
        troop.DamageProfile is not null && troop.DamageProfile.TryGetValue(targetType, out var m) ? m : 1;

    private static double ResistMult(MarchingTroop troop) => troop.DefenseResistFactor;

    private static double GuardianDamageMult(PlayerState pl)
    {
        var cmd = pl.Commanders.FirstOrDefault(c => c.Key == "guardian");
        if (cmd is null) return 1;
        var p = Content.Commanders["guardian"].Passives.StructureDamageTakenMultByLevel;
        return p is null ? 1 : AtLevel(p, cmd.Levels["structureDamageTakenMult"]);
    }

    private static Structure? WeakestAliveTower(PlayerState pl, int t)
    {
        var alive = pl.Towers.Where(s => !s.Destroyed).ToList();
        return alive.Count == 0 ? null : alive.Aggregate((a, b) => CurrentHp(a, t) <= CurrentHp(b, t) ? a : b);
    }

    private static FarmInstance? WeakestAliveFarm(PlayerState pl) => pl.Farms.FirstOrDefault(f => f.Hp > 0);

    internal static void ResolveAttack(PlayerState defender, MarchingTroop troop, int t)
    {
        if (defender.KeepDestroyedAtT is not null) return;
        double hp = troop.Hp;
        var tower = Content.Defense.Tower;
        var crossFireFactor = Content.Defense.CrossFireFactor;
        var keep = Content.Defense.Keep;
        var bypasses = troop.Bypasses ?? Array.Empty<string>();
        var gMult = GuardianDamageMult(defender);

        if (!bypasses.Contains("tower"))
        {
            var primary = WeakestAliveTower(defender, t);
            if (primary is not null)
            {
                var dmgToTroop = tower.Dps * ResistMult(troop) * tower.EngageTime;
                var dmgToTower = troop.Dps * DmgMult(troop, "tower") * tower.EngageTime * gMult;
                DamageStructure(primary, dmgToTower, t);
                if (primary.Destroyed) defender.Stats.TowersLost++;
                hp -= dmgToTroop;
                if (hp <= 0 || !primary.Destroyed) { defender.Stats.StoppedAtTower++; return; }
            }

            var survivors = defender.Towers.Any(s => !s.Destroyed);
            if (survivors)
            {
                hp -= tower.Dps * ResistMult(troop) * crossFireFactor * tower.EngageTime;
                if (hp <= 0) { defender.Stats.StoppedAtTower++; return; }
            }
        }

        if (hp <= 0) return;

        var farm = Content.Buildings.Farm;
        var targetFarm = WeakestAliveFarm(defender);
        if (targetFarm is not null)
        {
            defender.Stats.FarmsRaided++;
            targetFarm.Hp = Math.Max(0, targetFarm.Hp - troop.Dps * DmgMult(troop, "farm") * farm.AssaultEngageTime);
            if (targetFarm.Hp == 0 && !targetFarm.IncomeRemoved)
            {
                defender.Income -= farm.IncomeBonus;
                if (farm.DisruptionPenalty > 0 && farm.DisruptionSeconds > 0)
                    defender.Disruptions.Add(new Disruption { Amount = farm.DisruptionPenalty, Until = t + (int)farm.DisruptionSeconds });
                targetFarm.IncomeRemoved = true;
            }
            return;
        }

        defender.Stats.ReachedKeep++;
        var dmgToKeep = troop.Dps * DmgMult(troop, "keep") * keep.EngageTime * gMult;
        DamageStructure(defender.Keep, dmgToKeep, t);
        if (defender.Keep.Destroyed) defender.KeepDestroyedAtT ??= t;
    }

    // ---- commanders / rage ----

    internal sealed record PendingCast(PlayerState Self, PlayerState Opponent, string Kind, string Target, double Amount);

    /// <summary>
    /// Rage accrues at one flat rate for everyone and nothing may alter it —
    /// see docs/PROGRESS.md: letting anything speed this up would indirectly
    /// sell "more ability casts", which the monetization rules forbid.
    /// </summary>
    internal static void FillRage(PlayerState pl)
    {
        foreach (var cmd in pl.Commanders)
            cmd.Rage = Math.Min(Content.Rage.Max, cmd.Rage + Content.Rage.FillRatePerSec);
    }

    /// <summary>
    /// Spends rage and produces the cast, or returns null if it isn't
    /// castable right now. Authoritative: a player command lands here with
    /// exactly the same checks a bot gets, so the client can never fire an
    /// ability it hasn't actually charged.
    /// </summary>
    internal static PendingCast? TryCast(PlayerState self, PlayerState opponent, CommanderInstance cmd, int t)
    {
        var def = Content.Commanders[cmd.Key];
        if (cmd.Rage < def.RageCost) return null;
        var targetsEnemy = def.RageEffect.Target is "enemyFarm" or "enemyTower";
        if (targetsEnemy && opponent.KeepDestroyedAtT is not null) return null;
        cmd.Rage -= def.RageCost;
        cmd.Casts++;

        var amount = AtLevel(def.RageEffect.AmountByLevel, cmd.Levels["rage"]);
        if (def.Passives.RageEffectBonusByLevel is { } bonus)
            amount *= AtLevel(bonus, cmd.Levels["rageEffectBonus"]);
        if (cmd.IsMastered()) amount *= def.Mastery.RageEffectMultiplier;

        return new PendingCast(self, opponent, def.RageEffect.Kind, def.RageEffect.Target, amount);
    }

    internal static void ApplyCommanderCast(PendingCast cast, int t)
    {
        if (cast.Kind == "damageStructure")
        {
            var targetPlayer = cast.Target is "enemyFarm" or "enemyTower" ? cast.Opponent : cast.Self;
            if (cast.Target == "enemyTower")
            {
                var tower = WeakestAliveTower(targetPlayer, t);
                if (tower is not null) DamageStructure(tower, cast.Amount, t);
                if (targetPlayer.Keep.Destroyed) targetPlayer.KeepDestroyedAtT ??= t;
            }
            else if (cast.Target == "enemyFarm")
            {
                var farm = WeakestAliveFarm(targetPlayer);
                if (farm is not null)
                {
                    farm.Hp = Math.Max(0, farm.Hp - cast.Amount);
                    if (farm.Hp == 0 && !farm.IncomeRemoved)
                    {
                        var fc = Content.Buildings.Farm;
                        targetPlayer.Income -= fc.IncomeBonus;
                        if (fc.DisruptionPenalty > 0 && fc.DisruptionSeconds > 0)
                            targetPlayer.Disruptions.Add(new Disruption { Amount = fc.DisruptionPenalty, Until = t + (int)fc.DisruptionSeconds });
                        farm.IncomeRemoved = true;
                    }
                }
            }
        }
        else if (cast.Kind == "repairStructure")
        {
            var self = cast.Self;
            var tower = self.Towers.Where(s => s.DamageTaken > 0).OrderByDescending(s => s.DamageTaken).FirstOrDefault();
            if (tower is not null)
            {
                tower.DamageTaken = Math.Max(0, tower.DamageTaken - cast.Amount);
                if (tower.Destroyed && CurrentHp(tower, t) > 0) tower.Destroyed = false;
            }
        }
    }

    // ---- win resolution ----

    public sealed record MatchResult(string Winner, string Tiebreak); // Winner: "A" | "B" | "draw"

    public static MatchResult DetermineWinner(PlayerState a, PlayerState b)
    {
        var duration = Content.Economy.DurationSeconds;
        if (a.KeepDestroyedAtT is not null && b.KeepDestroyedAtT is null) return new("B", "keep-kill");
        if (b.KeepDestroyedAtT is not null && a.KeepDestroyedAtT is null) return new("A", "keep-kill");
        if (a.KeepDestroyedAtT is not null && b.KeepDestroyedAtT is not null)
        {
            if (a.KeepDestroyedAtT == b.KeepDestroyedAtT) return new("draw", "mutual-destruction-same-tick");
            return new(a.KeepDestroyedAtT > b.KeepDestroyedAtT ? "A" : "B", "mutual-destruction-timing");
        }
        if (a.Stats.TowersLost != b.Stats.TowersLost)
            return new(b.Stats.TowersLost > a.Stats.TowersLost ? "A" : "B", "towers-destroyed");
        // Note: aTowersTaken = b.Stats.TowersLost (towers OF b that A destroyed)
        var aKeepPct = CurrentHp(a.Keep, duration) / Content.Defense.Keep.Hp;
        var bKeepPct = CurrentHp(b.Keep, duration) / Content.Defense.Keep.Hp;
        if (aKeepPct != bKeepPct) return new(aKeepPct > bKeepPct ? "A" : "B", "own-keep-hp-pct");
        return new("draw", "true-draw");
    }

    // ---- top-level simulation ----

    /// <summary>
    /// Runs a full bot-vs-bot match. This is now a thin driver over
    /// MatchSession — the tick loop itself lives there and is shared with
    /// live networked matches, so these validated numbers keep testing the
    /// code real players actually run.
    /// </summary>
    public static (PlayerState A, PlayerState B, MatchResult Result) Simulate(IStrategy stratA, IStrategy stratB)
    {
        var session = new MatchSession(new BotController(stratA), new BotController(stratB));
        session.RunToCompletion();
        return (session.A, session.B, session.Result!);
    }
}
