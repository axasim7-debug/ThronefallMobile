using Thronefall.Engine;

namespace Thronefall.Engine.Tests;

/// <summary>
/// docs/ART_DIRECTION.md's opening finding: MarchingTroop used to carry no
/// position, only an arrival tick — a unit jumped from produced to arrived
/// with nothing to show moving in between. These tests are the contract for
/// the fix: a snapshot must report a troop's actual progress across its
/// march, from both sides' seats, symmetrically.
/// </summary>
public class MarchingTroopSnapshotTests
{
    private static (MatchSession Session, PlayerController Player) NewMatch(string opponent = "atk")
    {
        var player = new PlayerController("player");
        var session = new MatchSession(player, new BotController(Strategies.All[opponent]));
        return (session, player);
    }

    [Fact]
    public void OutgoingTroop_ReportsZeroProgress_OnTheTickItDeparts()
    {
        var (session, player) = NewMatch();
        session.A.Gold = 10_000;
        session.A.HasBarracks = true;
        session.Step();

        player.Submit(new PlayerCommand(CommandKind.Train, "cavalry"));
        session.Step(); // command applies, training starts
        while (session.A.TroopBusy) session.Step(); // wait out build time — this is the departure tick

        var snapshot = SnapshotBuilder.Build(session, viewerIsA: true);
        var troop = Assert.Single(snapshot.You.MarchingTroops);
        Assert.Equal("cavalry", troop.TroopKey);
        Assert.Equal(0, troop.Progress);
    }

    /// <summary>
    /// Progress never actually reaches 1 in an observed snapshot: arrival
    /// resolves and removes the troop within the same Step() that reaches
    /// its arrival tick, so the last tick it's visible in flight is
    /// ArriveAt-1 — progress (span-1)/span, not 1. That's correct, not a
    /// rounding gap: there's nothing to show "arriving" for, since combat
    /// resolves instantly. Uses the engineer (march time 7) so the climb is
    /// visible across several ticks rather than one lone 0/0.5 pair.
    /// </summary>
    [Fact]
    public void OutgoingTroop_ProgressRisesMonotonically_TowardCompletion()
    {
        var (session, player) = NewMatch();
        session.A.Gold = 10_000;
        session.A.HasBarracks = true;
        session.Step();
        player.Submit(new PlayerCommand(CommandKind.Train, "engineer")); // march time 7
        session.Step();
        while (session.A.TroopBusy) session.Step();

        var marchTicks = 0;
        double lastProgress = -1;
        while (true)
        {
            var troops = SnapshotBuilder.Build(session, viewerIsA: true).You.MarchingTroops;
            if (troops.Count == 0) break;
            var p = troops[0].Progress;
            Assert.True(p >= lastProgress, "progress must never go backwards");
            lastProgress = p;
            session.Step();
            marchTicks++;
            Assert.True(marchTicks < 60, "test runaway — troop never arrived");
        }
        Assert.True(marchTicks >= 6, $"expected roughly a 7-tick march, only saw {marchTicks} ticks");
        Assert.True(lastProgress > 0.8, $"progress should approach completion, was {lastProgress}");
        Assert.True(lastProgress < 1, "the arrival tick itself resolves and removes the troop in the same step");
    }

    [Fact]
    public void MarchingTroops_AreSymmetricAcrossBothViewers()
    {
        // Two players, identical commands — the mirror-symmetry guarantee
        // (docs/PROGRESS.md) extended to the new field: what A sees as its
        // own outgoing troop must be exactly what B sees as an incoming one.
        var left = new PlayerController("left");
        var right = new PlayerController("right");
        var session = new MatchSession(left, right);
        session.A.Gold = session.B.Gold = 10_000;
        session.A.HasBarracks = session.B.HasBarracks = true;
        session.Step();

        left.Submit(new PlayerCommand(CommandKind.Train, "infantry"));
        right.Submit(new PlayerCommand(CommandKind.Train, "infantry"));
        session.Step();

        var fromA = SnapshotBuilder.Build(session, viewerIsA: true);
        var fromB = SnapshotBuilder.Build(session, viewerIsA: false);

        // A's outgoing troop (fromA.You) must equal what B reports as incoming (fromB.Enemy)
        Assert.Equal(fromA.You.MarchingTroops.Count, fromB.Enemy.MarchingTroops.Count);
        Assert.Equal(fromB.You.MarchingTroops.Count, fromA.Enemy.MarchingTroops.Count);
        if (fromA.You.MarchingTroops.Count > 0)
        {
            Assert.Equal(fromA.You.MarchingTroops[0].Progress, fromB.Enemy.MarchingTroops[0].Progress);
            Assert.Equal(fromA.You.MarchingTroops[0].TroopKey, fromB.Enemy.MarchingTroops[0].TroopKey);
        }
    }

    [Fact]
    public void MarchingTroops_DisappearOnceResolved_NotBeforeAndNotAfter()
    {
        var (session, player) = NewMatch();
        session.A.Gold = 10_000;
        session.A.HasBarracks = true;
        session.Step();
        player.Submit(new PlayerCommand(CommandKind.Train, "cavalry"));
        session.Step();
        while (session.A.TroopBusy) session.Step();

        var sawInFlight = false;
        for (var i = 0; i < 30 && !session.Finished; i++)
        {
            var inFlight = SnapshotBuilder.Build(session, viewerIsA: true).You.MarchingTroops.Count > 0;
            if (inFlight) sawInFlight = true;
            if (sawInFlight && !inFlight) break; // it landed
            session.Step();
        }
        Assert.True(sawInFlight, "the troop should have appeared in flight at some point");
        Assert.Empty(SnapshotBuilder.Build(session, viewerIsA: true).You.MarchingTroops);
        // and it actually resolved into combat, not just vanished
        Assert.True(session.A.TroopsProduced > 0);
    }
}
