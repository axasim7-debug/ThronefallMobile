using Thronefall.PositionalEngine;

namespace Thronefall.PositionalEngine.Tests;

/// <summary>
/// Generic stat profiles for testing the combat MATH only — a faithful port
/// of tools/battle-sim/src/content.js's UNIT_PROFILES/STRUCTURE_PROFILES.
/// These are NOT meant to become permanent troop types: every real card
/// carries its own bespoke stats, and there is no rock-paper-scissors type
/// system in the engine. "Tank"/"skirmisher"/"ranged" here are just readable
/// labels for a few different stat shapes, picked to stress different parts
/// of the model (melee brawling, focus fire, kiting).
/// </summary>
internal static class TestProfiles
{
    public sealed record UnitProfile(double Hp, double Dps, double Range, double Speed);
    public sealed record StructureProfile(double Hp, double Dps, double Range);

    public static readonly UnitProfile Tank = new(Hp: 300, Dps: 15, Range: 1.2, Speed: 2.0);
    public static readonly UnitProfile Skirmisher = new(Hp: 80, Dps: 25, Range: 1.2, Speed: 4.0);
    public static readonly UnitProfile Ranged = new(Hp: 60, Dps: 20, Range: 5.0, Speed: 2.2);

    public static readonly StructureProfile Tower = new(Hp: 700, Dps: 20, Range: 6.0);
    public static readonly StructureProfile Keep = new(Hp: 1200, Dps: 30, Range: 3.5);
    // negligible counter-damage on purpose — used to isolate pure DPS-stacking
    // math in tests without an attacker's own death confounding the measurement
    public static readonly StructureProfile Dummy = new(Hp: 300, Dps: 0, Range: 0);
}

/// <summary>
/// Faithful port of tools/battle-sim/test/battle.test.js — the core
/// positional-combat regression suite. Keep in sync deliberately; see
/// docs/PROGRESS.md for why this engine exists and the standing rule that
/// nothing here is "final" until tested from multiple angles.
/// </summary>
public class BattleTests
{
    private static string AddUnit(Battle b, string side, double x, double z, TestProfiles.UnitProfile p, string key = "unit") =>
        b.AddUnit(side, x, z, p.Hp, p.Dps, p.Range, p.Speed, key);

    private static string AddStructure(Battle b, string side, double x, double z, TestProfiles.StructureProfile p, string key = "structure") =>
        b.AddStructure(side, x, z, p.Hp, p.Dps, p.Range, key);

    // -----------------------------------------------------------------------
    // Sanity: the old engine's mirror-symmetry bug (docs/PROGRESS.md) came
    // from applying one side's effects fully before the other's. This model
    // resolves ALL damage off start-of-tick state before applying any of it,
    // so a mirror matchup must stay exactly symmetric.
    // -----------------------------------------------------------------------
    [Fact]
    public void MirrorMatchup_IsSymmetric()
    {
        var b = new Battle();
        var a = AddUnit(b, "A", 0, 0, TestProfiles.Tank);
        var e = AddUnit(b, "B", 1.0, 0, TestProfiles.Tank); // within range (1.2)

        var ticks = 0;
        while (b.Units[a].Alive && b.Units[e].Alive && ticks < 1000) { b.Step(); ticks++; }

        var ua = b.Units[a];
        var ue = b.Units[e];
        Assert.Equal(ue.Alive, ua.Alive);
        Assert.Equal(ue.Hp, ua.Hp);
    }

    // -----------------------------------------------------------------------
    // Focus fire: three attackers on one target should kill roughly 3x
    // faster than one attacker would. Target is a negligible-counter-damage
    // dummy on purpose — see battle.test.js's comment on the bogus "500s"
    // result a real-tank target first produced.
    // -----------------------------------------------------------------------
    [Fact]
    public void FocusFire_ThreeAttackersKillMuchFasterThanOne()
    {
        double TimeToKill(int attackerCount)
        {
            var b = new Battle();
            var targetId = AddStructure(b, "B", 0, 0, TestProfiles.Dummy);
            for (var i = 0; i < attackerCount; i++) AddUnit(b, "A", 0.3 * i, 1.0, TestProfiles.Skirmisher);
            var ticks = 0;
            while (!b.Structures[targetId].Destroyed && ticks < 2000) { b.Step(); ticks++; }
            Assert.True(ticks < 2000, "the dummy should actually die, not time out");
            return b.Time;
        }

        var t1 = TimeToKill(1);
        var t3 = TimeToKill(3);
        var expected1 = TestProfiles.Dummy.Hp / TestProfiles.Skirmisher.Dps;
        var expected3 = TestProfiles.Dummy.Hp / (3 * TestProfiles.Skirmisher.Dps);
        Assert.True(Math.Abs(t1 - expected1) < 0.5, $"1 attacker: {t1}s should match the naive DPS math ({expected1}s)");
        Assert.True(Math.Abs(t3 - expected3) < 0.5, $"3 attackers: {t3}s should match the naive DPS math ({expected3}s)");
        Assert.True(t3 < t1 / 2.5, $"3 attackers ({t3}s) should kill much faster than 1 ({t1}s)");
    }

    // -----------------------------------------------------------------------
    // A lone skirmisher does not just take longer against a tank — it loses
    // outright, because the tank's own counter-fire kills it first. A
    // legitimate property of DPS-stacking combat, kept as a permanent fact.
    // -----------------------------------------------------------------------
    [Fact]
    public void LoneSkirmisher_LosesOutrightToATank()
    {
        var b = new Battle();
        var skirmisher = AddUnit(b, "A", 0, 1.0, TestProfiles.Skirmisher);
        var tank = AddUnit(b, "B", 0, 0, TestProfiles.Tank);
        var ticks = 0;
        while (b.Units[skirmisher].Alive && b.Units[tank].Alive && ticks < 2000) { b.Step(); ticks++; }
        Assert.False(b.Units[skirmisher].Alive, "the skirmisher should die first");
        Assert.True(b.Units[tank].Alive, "the tank should survive a lone skirmisher");
        Assert.True(b.Units[tank].Hp < TestProfiles.Tank.Hp, "the tank should still have taken real damage first");
    }

    // -----------------------------------------------------------------------
    // Retreat: a player-issued move order must break engagement immediately,
    // even mid-fight.
    // -----------------------------------------------------------------------
    [Fact]
    public void Retreat_MovingOutOfRange_StopsDamageAndSavesAWoundedUnit()
    {
        var b = new Battle();
        var ranged = AddUnit(b, "A", 0, 0, TestProfiles.Ranged);
        AddUnit(b, "B", 1.0, 0, TestProfiles.Tank); // within melee range of ranged unit too

        for (var i = 0; i < 4; i++) b.Step();
        Assert.True(b.Units[ranged].Hp < TestProfiles.Ranged.Hp, "the ranged unit should have taken damage while in range");

        b.MoveUnit(ranged, -20, 0); // retreat straight back, well out of the tank's 1.2 range
        for (var i = 0; i < 40; i++) b.Step();

        var u = b.Units[ranged];
        Assert.True(u.Alive, "retreating in time should save the unit");
        Assert.True(Battle.Distance(u.X, u.Z, 1.0, 0) > TestProfiles.Tank.Range, "the unit should have actually left melee range");

        var hpBeforeExtra = u.Hp;
        b.Step();
        Assert.Equal(hpBeforeExtra, b.Units[ranged].Hp);
    }

    // -----------------------------------------------------------------------
    // No auto-advance: the single most load-bearing rule in this design.
    // -----------------------------------------------------------------------
    [Fact]
    public void NoAutoAdvance_IdleArmiesOutOfRange_NeverEngageOnTheirOwn()
    {
        var b = new Battle();
        var ids = new[]
        {
            AddUnit(b, "A", 0, 0, TestProfiles.Tank),
            AddUnit(b, "A", 1, 0, TestProfiles.Skirmisher),
            AddUnit(b, "B", 50, 50, TestProfiles.Tank),
            AddUnit(b, "B", 51, 50, TestProfiles.Skirmisher),
        };

        for (var i = 0; i < 400; i++) b.Step(); // 100 real seconds, no orders ever given

        foreach (var id in ids)
        {
            var u = b.Units[id];
            Assert.True(u.Alive, $"{id} should never have taken damage");
            Assert.Equal(u.MaxHp, u.Hp);
        }
        Assert.Empty(b.Log);
    }

    // -----------------------------------------------------------------------
    // Structures fight the same way units do: a sustained exchange, never an
    // instant one-shot resolution in either direction.
    // -----------------------------------------------------------------------
    [Fact]
    public void Structures_TradeDamageOverTime_NeverInstant()
    {
        var b = new Battle();
        var attacker = AddUnit(b, "A", -10, 0, TestProfiles.Tank);
        var tower = AddStructure(b, "B", 0, 0, TestProfiles.Tower);
        b.MoveUnit(attacker, 0, 0);

        int? firstDamageTick = null;
        var ticks = 0;
        while (b.Units[attacker].Alive && !b.Structures[tower].Destroyed && ticks < 4000)
        {
            var before = b.Structures[tower].Hp;
            b.Step();
            ticks++;
            if (firstDamageTick is null && b.Structures[tower].Hp < before) firstDamageTick = ticks;
        }

        Assert.NotNull(firstDamageTick);
        Assert.True(ticks > firstDamageTick, "combat must span multiple ticks, not resolve on the first hit");
        Assert.True(b.Time > 1, $"the whole engagement took {b.Time}s — should never be a single instant");
    }

    // -----------------------------------------------------------------------
    // The payoff: standing and fighting loses, deliberate kiting wins.
    // -----------------------------------------------------------------------
    [Fact]
    public void Tactics_StandingStillLoses_KitingTheSameMatchupWins()
    {
        var stand = new Battle();
        var rangedStand = AddUnit(stand, "A", 0, 0, TestProfiles.Ranged);
        var tankStand = AddUnit(stand, "B", 1.0, 0, TestProfiles.Tank);
        var ticks = 0;
        while (stand.Units[rangedStand].Alive && stand.Units[tankStand].Alive && ticks < 2000) { stand.Step(); ticks++; }
        Assert.False(stand.Units[rangedStand].Alive, "standing still, the lower-HP ranged unit should lose");

        var kite = new Battle();
        var ranged = AddUnit(kite, "A", 0, 0, TestProfiles.Ranged);
        var tank = AddUnit(kite, "B", 4.5, 0, TestProfiles.Tank);

        var kiteTicks = 0;
        while (kite.Units[ranged].Alive && kite.Units[tank].Alive && kiteTicks < 4000)
        {
            var r = kite.Units[ranged];
            var t = kite.Units[tank];
            var d = Battle.Distance(r.X, r.Z, t.X, t.Z);

            kite.MoveUnit(tank, r.X, r.Z); // naive opponent: always walk straight at the ranged unit

            if (d < TestProfiles.Tank.Range + 0.6)
            {
                var dx = r.X - t.X;
                var dz = r.Z - t.Z;
                var len = Math.Sqrt(dx * dx + dz * dz);
                if (len == 0) len = 1;
                kite.MoveUnit(ranged, r.X + dx / len * 5, r.Z + dz / len * 5);
            }
            else
            {
                r.Waypoint = null; // hold ground and keep shooting
            }

            kite.Step();
            kiteTicks++;
        }

        Assert.True(kite.Units[ranged].Alive, "kiting should keep the ranged unit alive");
        Assert.False(kite.Units[tank].Alive, "kiting should eventually bring the tank down");
    }
}
