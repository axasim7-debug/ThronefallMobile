using Thronefall.PositionalEngine;

namespace Thronefall.PositionalEngine.Tests;

/// <summary>
/// Faithful port of tools/battle-sim/test/match.test.js — the full-match
/// (economy + continuous combat) regression suite. Same philosophy as
/// server/Thronefall.Engine.Tests/MatchEngineTests.cs's cross-validation
/// pass: numbers below are captured from an actual run, not invented, and a
/// disagreement with the JS engine means this port drifted, not a license to
/// re-tune. See docs/PROGRESS.md for the full history of this engine,
/// including two real bugs (structures fighting each other directly, and
/// repair covering the keep) found and fixed here.
/// </summary>
public class MatchTests
{
    private static readonly (string A, string B)[] Matchups =
    {
        ("eco", "atk"), ("eco", "def"), ("def", "atk"),
        ("eco", "eco"), ("def", "def"), ("atk", "atk"),
    };

    private static (Battle Battle, MatchPlayer A, MatchPlayer B, Match.MatchResult Result) Run(string a, string b) =>
        Match.SimulateMatch(Strategies.All[a], Strategies.All[b]);

    [Fact]
    public void MirrorMatchup_IsSymmetric()
    {
        foreach (var name in Strategies.All.Keys)
        {
            var (battle, a, b, _) = Run(name, name);
            Assert.Equal(Match.KeepDestroyedAtT(battle, b), Match.KeepDestroyedAtT(battle, a));
            Assert.Equal(b.TroopsProduced, a.TroopsProduced);
        }
    }

    [Fact]
    public void EveryStrategy_ReachesBarracksAndProducesTroops_InMirrorMatch()
    {
        foreach (var name in Strategies.All.Keys)
        {
            var (_, a, b, _) = Run(name, name);
            Assert.NotNull(a.BarracksT);
            Assert.NotNull(b.BarracksT);
            Assert.True(a.TroopsProduced > 0);
            Assert.True(b.TroopsProduced > 0);
        }
    }

    [Fact]
    public void NoMatchup_ProducesInvalidValues()
    {
        foreach (var (a, b) in Matchups)
        {
            var (battle, pa, pb, _) = Run(a, b);
            foreach (var pl in new[] { pa, pb })
            {
                Assert.True(pl.Gold >= 0 && double.IsFinite(pl.Gold));
                var keep = battle.Structures[pl.KeepId];
                Assert.True(keep.Hp >= 0 && double.IsFinite(keep.Hp));
                foreach (var id in pl.TowerIds)
                {
                    var tower = battle.Structures[id];
                    Assert.True(tower.Hp >= 0 && double.IsFinite(tower.Hp));
                }
            }
        }
    }

    // Floor revised from the old model's 60s to 90s after discussion with the
    // user: the old 120-360s WINDOW was calibrated for staged, instant-per-
    // troop resolution and doesn't map onto this model's continuous,
    // geometry-driven combat, so the strict upper bound was dropped (reaching
    // time-up with no kill is a healthy outcome here too). The lower floor is
    // kept and raised slightly, since a genuinely fast collapse is still
    // exactly the failure this test exists to catch. See docs/PROGRESS.md.
    [Fact]
    public void NoMatchup_EndsBefore90Seconds()
    {
        foreach (var (a, b) in Matchups)
        {
            var (battle, pa, pb, _) = Run(a, b);
            foreach (var pl in new[] { pa, pb })
                if (Match.KeepDestroyedAtT(battle, pl) is { } t) Assert.True(t >= 90, $"{a} vs {b}: died at {t}s");
        }
    }

    [Fact]
    public void EveryMatchup_ResolvesToWellFormedResult_MirrorsAlwaysDraw()
    {
        foreach (var (a, b) in Matchups)
        {
            var (_, _, _, result) = Run(a, b);
            Assert.Contains(result.Winner, new[] { "A", "B", "draw" });
            if (a == b) Assert.Equal("draw", result.Winner);
        }
    }

    [Fact]
    public void Balance_NoSingleStrategyDominatesEveryMatchup_ViaKeepKill()
    {
        const double dominanceKeepHpRatio = 0.7;
        foreach (var (a, b) in Matchups)
        {
            if (a == b) continue;
            var (battle, pa, pb, _) = Run(a, b);
            foreach (var (winner, loser) in new[] { (pa, pb), (pb, pa) })
            {
                if (Match.KeepDestroyedAtT(battle, loser) is null || Match.KeepDestroyedAtT(battle, winner) is not null) continue;
                var ratio = battle.Structures[winner.KeepId].Hp / Content.Defense.Keep.Hp;
                Assert.True(ratio <= dominanceKeepHpRatio,
                    $"{winner.Strategy.Name} beat {loser.Strategy.Name} while keeping {ratio * 100:F0}% of its own keep HP — one-sided result");
            }
        }
    }

    // The core hypothesis this whole file exists to check: earlier tests only
    // ever proved ONE troop's combat resolves correctly over time. Does the
    // continuous model still correctly accumulate damage across MANY separate
    // troop arrivals, sustained over a full match, without anything resetting
    // or getting lost between arrivals?
    [Fact]
    public void ContinuousAccumulation_SustainedAttackersTroops_ProduceRealCumulativeDamage()
    {
        var (battle, a, b, _) = Run("atk", "atk"); // fast rusher on both sides — reliably produces several troops each
        Assert.True(a.TroopsProduced > 3 && b.TroopsProduced > 3,
            $"expected several troops produced over a full match, got A={a.TroopsProduced} B={b.TroopsProduced}");

        static bool HasDamage(MatchPlayer pl) => pl.MyStructures().Any(s => s.Destroyed || s.Hp < s.MaxHp * 0.95);
        Assert.True(HasDamage(a), "A's defense shows no accumulated damage after a sustained assault");
        Assert.True(HasDamage(b), "B's defense shows no accumulated damage after a sustained assault");
    }

    // --- cross-validation against the JS engine's captured output ---------
    // Numbers below were captured from `node scripts/inspect-match.js` in
    // tools/battle-sim, at the commit that fixed the structure-vs-structure
    // and keep-repair bugs (see docs/PROGRESS.md). Default numbers, no
    // tuning applied on top.

    [Fact]
    public void CrossValidate_EcoVsAtk()
    {
        var (battle, a, b, result) = Run("eco", "atk");
        Assert.Equal("A", result.Winner); // eco wins
        Assert.Equal("keep-kill", result.Tiebreak);
        Assert.Equal(108, Match.KeepDestroyedAtT(battle, b));
        Assert.Equal(648, Math.Round(battle.Structures[a.KeepId].Hp));
    }

    [Fact]
    public void CrossValidate_EcoVsDef()
    {
        var (battle, a, b, result) = Run("eco", "def");
        Assert.Equal("A", result.Winner); // eco wins narrowly
        Assert.Equal("keep-kill", result.Tiebreak);
        Assert.Equal(117.75, Match.KeepDestroyedAtT(battle, b));
        Assert.Equal(288, Math.Round(battle.Structures[a.KeepId].Hp));
    }

    [Fact]
    public void CrossValidate_DefVsAtk()
    {
        var (battle, a, b, result) = Run("def", "atk");
        Assert.Equal("A", result.Winner); // def wins
        Assert.Equal("keep-kill", result.Tiebreak);
        Assert.Equal(132.75, Match.KeepDestroyedAtT(battle, b));
        Assert.Equal(468, Math.Round(battle.Structures[a.KeepId].Hp));
    }

    [Fact]
    public void CrossValidate_MirrorMatchups()
    {
        var (ebattle, ea, eb, er) = Run("eco", "eco");
        Assert.Equal("draw", er.Winner);
        Assert.Equal(128.75, Match.KeepDestroyedAtT(ebattle, ea));
        Assert.Equal(27, ea.TroopsProduced);

        var (dbattle, da, db, dr) = Run("def", "def");
        Assert.Equal("draw", dr.Winner);
        Assert.Equal(145.75, Match.KeepDestroyedAtT(dbattle, da));
        Assert.Equal(25, da.TroopsProduced);

        var (abattle, aa, ab, ar) = Run("atk", "atk");
        Assert.Equal("draw", ar.Winner);
        Assert.Equal(161, Match.KeepDestroyedAtT(abattle, aa));
        Assert.Equal(19, aa.TroopsProduced);
    }
}
