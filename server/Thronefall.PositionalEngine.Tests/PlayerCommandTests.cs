using Thronefall.PositionalEngine;

namespace Thronefall.PositionalEngine.Tests;

/// <summary>
/// The real-time player command protocol. These are adversarial on purpose:
/// commands arrive from a network client we do not control, so every test
/// here asks "what if the client lies?" rather than "does the happy path
/// work?". The engine must refuse illegal commands rather than trust them —
/// docs/GAME_DESIGN.md §5: the client holds no game logic and no authority.
/// A faithful structural port of
/// server/Thronefall.Engine.Tests/PlayerCommandTests.cs, plus MoveUnit
/// coverage — the new primitive this engine adds.
/// </summary>
public class PlayerCommandTests
{
    private static (MatchSession Session, PlayerController Player) NewMatch(string opponent = "atk") =>
        NewMatchWith(new PlayerController("player"), opponent);

    private static (MatchSession, PlayerController) NewMatchWith(PlayerController player, string opponent)
    {
        var session = new MatchSession(player, new BotController(Strategies.All[opponent]));
        return (session, player);
    }

    private static void StepTo(MatchSession session, int tick)
    {
        while (session.Tick < tick && session.Step()) { }
    }

    private static CommandAck SingleAck(PlayerController player)
    {
        var acks = player.DrainAcks();
        return Assert.Single(acks);
    }

    /// <summary>Walks A's king onto the given plot instantly (bypassing
    /// AdvanceKing) — every Build/Repair test below needs this now that
    /// those commands require the king to actually be standing there. Tests
    /// that exercise the king-gating itself do NOT use this helper.</summary>
    private static void PutKingAt(MatchSession session, (double X, double Z) plot)
    {
        session.A.KingX = plot.X;
        session.A.KingZ = plot.Z;
    }

    private static (double X, double Z) FarmPlot(MatchSession session) =>
        (Content.FarmPlotOffsetX, session.A.Direction * Content.Layout.Econ * Content.PlotDepth);

    private static (double X, double Z) BarracksPlot(MatchSession session) =>
        (0, session.A.Direction * Content.Layout.Econ * Content.PlotDepth);

    // --- the player actually gets agency -------------------------------

    [Fact]
    public void BuildCommand_IsApplied_AndChargesGold()
    {
        var (session, player) = NewMatch();
        session.Step(); // t=0
        session.A.Gold = Content.Buildings.Farm.Cost;
        PutKingAt(session, FarmPlot(session));

        var goldBefore = session.A.Gold;
        player.Submit(new PlayerCommand(CommandKind.Build, "farm", ClientSeq: 7));
        session.Step();

        var ack = SingleAck(player);
        Assert.True(ack.Accepted);
        Assert.Equal(7, ack.ClientSeq);
        Assert.Equal("farm", session.A.BuildBusy);
        Assert.Equal(Content.Buildings.Farm.Cost, goldBefore + session.A.Income - session.A.Gold);
    }

    [Fact]
    public void BuildCommand_CompletesAfterItsBuildTime()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = Content.Buildings.Farm.Cost;
        PutKingAt(session, FarmPlot(session));
        player.Submit(new PlayerCommand(CommandKind.Build, "farm"));

        StepTo(session, (int)Content.Buildings.Farm.BuildTime + 4);

        Assert.Equal(1, session.A.Farms);
        Assert.Null(session.A.BuildBusy);
        Assert.Equal(Content.Economy.BaseIncome + Content.Buildings.Farm.IncomeBonus, session.A.Income);
    }

    [Fact]
    public void TrainCommand_ProducesATroop_ThatCanBeMovedAndEngageTheEnemy()
    {
        var (session, player) = NewMatch("eco"); // slow to field an army — won't interfere within this test's short window
        session.Step();
        session.A.Gold = 10_000;
        session.A.HasBarracks = true;
        player.Submit(new PlayerCommand(CommandKind.Train, "cavalry"));
        session.Step();
        player.DrainAcks();
        StepTo(session, session.Tick + (int)Content.Troops["cavalry"].BuildTime + 1);

        var unit = Assert.Single(session.Battle.AliveUnits("A"));
        var enemyKeep = session.Battle.Structures[session.B.KeepId];
        // a live player gets full manual control — no auto-release, so the
        // trained troop just sits at the barracks until explicitly moved
        player.Submit(new PlayerCommand(CommandKind.MoveUnit, unit.Id, X: enemyKeep.X, Z: enemyKeep.Z));
        session.Step();
        Assert.True(SingleAck(player).Accepted);

        StepTo(session, session.Tick + 60); // give it time to march in and fight

        Assert.True(session.Battle.Log.Any(e => e.Event is "structureDestroyed" or "unitDied"),
            "the moved troop should have engaged something by now");
    }

    // --- MoveUnit: the new primitive this engine adds -------------------

    [Fact]
    public void MoveUnit_SendsAnOwnUnit_ToTheGivenPosition()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        session.A.HasBarracks = true;
        Match.StartTroop(session.A, "infantry");
        StepTo(session, session.Tick + (int)Content.Troops["infantry"].BuildTime + 1);

        var unitId = Assert.Single(session.Battle.AliveUnits("A")).Id;
        player.Submit(new PlayerCommand(CommandKind.MoveUnit, unitId, X: 1.5, Z: -2.5));
        session.Step();

        var ack = SingleAck(player);
        Assert.True(ack.Accepted);
        var unit = session.Battle.Units[unitId];
        Assert.Equal((1.5, -2.5), unit.Waypoint);
    }

    [Fact]
    public void MoveUnit_IsRefused_ForAnEnemyUnit()
    {
        var (session, player) = NewMatch("atk");
        StepTo(session, 60); // let the bot train at least one troop

        var enemyUnit = session.Battle.AliveUnits("B").FirstOrDefault();
        if (enemyUnit is null) StepTo(session, 120);
        enemyUnit = session.Battle.AliveUnits("B").First();

        player.Submit(new PlayerCommand(CommandKind.MoveUnit, enemyUnit.Id, X: 0, Z: 0));
        session.Step();

        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("not-your-unit", ack.Reason);
    }

    [Fact]
    public void MoveUnit_WithUnknownId_IsRefused_NotThrown()
    {
        var (session, player) = NewMatch();
        session.Step();

        player.Submit(new PlayerCommand(CommandKind.MoveUnit, "ghost-unit", X: 0, Z: 0));
        var exception = Record.Exception(() => session.Step());

        Assert.Null(exception);
        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("unknown-unit", ack.Reason);
    }

    [Fact]
    public void MoveUnit_WithoutCoordinates_IsRefused()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        session.A.HasBarracks = true;
        Match.StartTroop(session.A, "infantry");
        StepTo(session, session.Tick + (int)Content.Troops["infantry"].BuildTime + 1);

        var unitId = Assert.Single(session.Battle.AliveUnits("A")).Id;
        player.Submit(new PlayerCommand(CommandKind.MoveUnit, unitId)); // no X/Z
        session.Step();

        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("move-needs-coordinates", ack.Reason);
    }

    // --- king walk-and-build: Build/Repair require the king to be there --

    [Fact]
    public void Build_IsRefused_WhenTheKingIsFarFromThePlot()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        // king starts at the keep, deliberately not repositioned near any plot

        player.Submit(new PlayerCommand(CommandKind.Build, "farm"));
        session.Step();

        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("king-too-far", ack.Reason);
        Assert.Null(session.A.BuildBusy);
        Assert.Equal(10_000 + Content.Economy.BaseIncome, session.A.Gold); // income ticked, but never charged for the farm
    }

    [Fact]
    public void Build_Succeeds_OnceTheKingWalksToThePlot()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        PutKingAt(session, BarracksPlot(session));

        player.Submit(new PlayerCommand(CommandKind.Build, "barracks"));
        session.Step();

        Assert.True(SingleAck(player).Accepted);
        Assert.Equal("barracks", session.A.BuildBusy);
    }

    [Fact]
    public void Repair_IsRefused_WhenTheKingIsFarFromTheDamagedTower()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        var tower = session.Battle.Structures[session.A.TowerIds[0]];
        DamageThroughRealCombat(session, tower);
        // king stays at the keep — nowhere near either tower

        player.Submit(new PlayerCommand(CommandKind.Repair, ""));
        session.Step();

        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("king-too-far", ack.Reason);
        Assert.Null(session.A.BuildBusy);
    }

    [Fact]
    public void Repair_Succeeds_OnceTheKingWalksToTheDamagedTower()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        var tower = session.Battle.Structures[session.A.TowerIds[0]];
        DamageThroughRealCombat(session, tower);
        session.A.KingX = tower.X;
        session.A.KingZ = tower.Z;

        player.Submit(new PlayerCommand(CommandKind.Repair, ""));
        session.Step();

        Assert.True(SingleAck(player).Accepted);
        Assert.Equal("repair", session.A.BuildBusy);
    }

    /// <summary>Dents a tower for real, through Battle combat, so the
    /// reinforcement bookkeeping (MatchPlayer's private _damageTaken) stays
    /// consistent — directly poking Structure.Hp does NOT create a lasting
    /// repair target: the very next tick's ApplyReinforcement recomputes Hp
    /// from ceiling(t) minus recorded damage and stomps an untracked
    /// assignment straight back to the ramp value (the same
    /// snapshot-vs-formula distinction documented on ApplyReinforcement
    /// itself).</summary>
    private static void DamageThroughRealCombat(MatchSession session, Structure tower)
    {
        session.Battle.AddUnit("B", tower.X, tower.Z, hp: 999, dps: 50, range: 10, speed: 0, key: "raider");
        StepTo(session, session.Tick + 1);
        Assert.True(tower.Hp < Match.ReinforcementCeiling(tower.MaxHp, session.Tick), "the tower should be a genuine repair target now");
    }

    [Fact]
    public void MoveKing_SetsAWaypoint_ThatAdvanceKingWalksTowardOverTime()
    {
        var (session, player) = NewMatch();
        session.Step();
        var farmPlot = FarmPlot(session);

        player.Submit(new PlayerCommand(CommandKind.MoveKing, "", X: farmPlot.X, Z: farmPlot.Z));
        session.Step();

        Assert.True(SingleAck(player).Accepted);
        Assert.Equal((farmPlot.X, farmPlot.Z), (session.A.KingWaypointX, session.A.KingWaypointZ));

        StepTo(session, session.Tick + 20); // more than enough time to arrive at king speed

        Assert.Null(session.A.KingWaypointX);
        Assert.Equal(farmPlot.X, session.A.KingX, 3);
        Assert.Equal(farmPlot.Z, session.A.KingZ, 3);
    }

    [Fact]
    public void MoveKing_WithoutCoordinates_IsRefused()
    {
        var (session, player) = NewMatch();
        session.Step();

        player.Submit(new PlayerCommand(CommandKind.MoveKing, ""));
        session.Step();

        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("move-needs-coordinates", ack.Reason);
    }

    // --- refusals: the client does not get to lie ----------------------

    [Fact]
    public void Build_IsRefused_WhenGoldIsInsufficient()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 0;
        PutKingAt(session, BarracksPlot(session));

        player.Submit(new PlayerCommand(CommandKind.Build, "barracks"));
        session.Step();

        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("not-enough-gold", ack.Reason);
        Assert.Null(session.A.BuildBusy);
        Assert.False(session.A.HasBarracks);
    }

    [Fact]
    public void Build_IsRefused_WhenSlotIsBusy_AndGoldIsNotDoubleCharged()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        PutKingAt(session, FarmPlot(session));

        player.Submit(new PlayerCommand(CommandKind.Build, "farm"));
        player.Submit(new PlayerCommand(CommandKind.Build, "farm"));
        session.Step();

        var acks = player.DrainAcks();
        Assert.Equal(2, acks.Count);
        Assert.True(acks[0].Accepted);
        Assert.False(acks[1].Accepted);
        Assert.Equal("build-slot-busy", acks[1].Reason);
    }

    [Fact]
    public void Build_IsRefused_BeyondTheFarmCap()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        PutKingAt(session, FarmPlot(session));

        for (var i = 0; i < Content.Buildings.Farm.MaxCount; i++)
        {
            player.Submit(new PlayerCommand(CommandKind.Build, "farm"));
            StepTo(session, session.Tick + (int)Content.Buildings.Farm.BuildTime + 1);
            session.A.Gold = 10_000;
        }
        player.DrainAcks();

        player.Submit(new PlayerCommand(CommandKind.Build, "farm"));
        session.Step();

        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("farm-limit-reached", ack.Reason);
        Assert.Equal(Content.Buildings.Farm.MaxCount, session.A.Farms);
    }

    [Fact]
    public void Train_IsRefused_WithoutBarracks()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;

        player.Submit(new PlayerCommand(CommandKind.Train, "infantry"));
        session.Step();

        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("no-barracks", ack.Reason);
        Assert.Equal(0, session.A.TroopsProduced);
    }

    [Fact]
    public void Train_WithUnknownTroop_IsRefused_NotThrown()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        session.A.HasBarracks = true;

        player.Submit(new PlayerCommand(CommandKind.Train, "dragon-that-does-not-exist"));
        var exception = Record.Exception(() => session.Step());

        Assert.Null(exception);
        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("unknown-troop", ack.Reason);
    }

    [Fact]
    public void Build_WithUnknownBuilding_IsRefused_NotThrown()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;

        player.Submit(new PlayerCommand(CommandKind.Build, "wonder-of-the-world"));
        var exception = Record.Exception(() => session.Step());

        Assert.Null(exception);
        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("unknown-building", ack.Reason);
    }

    [Fact]
    public void Repair_CannotClobberAnInProgressBuild()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        // a damaged tower exists, so repair has a legitimate target
        var tower = session.Battle.Structures[session.A.TowerIds[0]];
        tower.Hp = tower.MaxHp - 50;
        PutKingAt(session, BarracksPlot(session));

        player.Submit(new PlayerCommand(CommandKind.Build, "barracks"));
        session.Step();
        Assert.Equal("barracks", session.A.BuildBusy);
        player.DrainAcks();

        player.Submit(new PlayerCommand(CommandKind.Repair, ""));
        session.Step();

        var ack = SingleAck(player);
        Assert.False(ack.Accepted);
        Assert.Equal("build-slot-busy", ack.Reason);
        Assert.Equal("barracks", session.A.BuildBusy); // the paid build survived
    }

    // --- the session itself --------------------------------------------

    /// <summary>
    /// Stepping tick-by-tick must land on exactly the result the batch
    /// simulation gives. If these ever diverge, the live match and every
    /// validated number are no longer describing the same game.
    /// </summary>
    [Fact]
    public void SteppedSession_MatchesBatchSimulation_Exactly()
    {
        foreach (var (a, b) in new[] { ("eco", "atk"), ("def", "atk"), ("eco", "def"), ("atk", "atk") })
        {
            var stepped = new MatchSession(new BotController(Strategies.All[a]), new BotController(Strategies.All[b]));
            while (stepped.Step()) { }

            var (batchBattle, batchA, batchB, batchResult) = Match.SimulateMatch(Strategies.All[a], Strategies.All[b]);

            Assert.Equal(batchResult.Winner, stepped.Result!.Winner);
            Assert.Equal(batchResult.Tiebreak, stepped.Result.Tiebreak);
            Assert.Equal(batchA.TroopsProduced, stepped.A.TroopsProduced);
            Assert.Equal(batchB.TroopsProduced, stepped.B.TroopsProduced);
            Assert.Equal(batchBattle.Structures[batchA.KeepId].Hp, stepped.Battle.Structures[stepped.A.KeepId].Hp, 6);
            Assert.Equal(batchBattle.Structures[batchB.KeepId].Hp, stepped.Battle.Structures[stepped.B.KeepId].Hp, 6);
        }
    }

    [Fact]
    public void TwoPlayers_IssuingIdenticalCommands_StaySymmetric()
    {
        var left = new PlayerController("left");
        var right = new PlayerController("right");
        var session = new MatchSession(left, right);

        while (!session.Finished)
        {
            foreach (var player in new[] { left, right })
            {
                if (!session.A.HasBarracks && session.A.BuildBusy is null)
                    player.Submit(new PlayerCommand(CommandKind.Build, "barracks"));
                else if (session.A.HasBarracks && !session.A.TroopBusy)
                    player.Submit(new PlayerCommand(CommandKind.Train, "infantry"));
            }
            session.Step();
        }

        Assert.Equal(session.A.TroopsProduced, session.B.TroopsProduced);
        Assert.Equal(session.A.Gold, session.B.Gold);
        Assert.Equal(Match.KeepDestroyedAtT(session.Battle, session.A), Match.KeepDestroyedAtT(session.Battle, session.B));
        Assert.Equal(
            session.Battle.Structures[session.A.KeepId].Hp,
            session.Battle.Structures[session.B.KeepId].Hp, 6);
        Assert.Equal("draw", session.Result!.Winner);
    }

    [Fact]
    public void LiveMatch_EndsEarly_WhenAKeepFalls()
    {
        var session = new MatchSession(
            new BotController(Strategies.All["atk"]),
            new BotController(Strategies.All["eco"]),
            endEarlyOnKeepKill: true);
        session.RunToCompletion();

        if (Match.KeepDestroyedAtT(session.Battle, session.A) is not null || Match.KeepDestroyedAtT(session.Battle, session.B) is not null)
            Assert.True(session.Tick < MatchSession.Duration, "a decided match should not keep ticking");
        Assert.True(session.Finished);
        Assert.NotNull(session.Result);
    }

    [Fact]
    public void Snapshot_ReportsEachSideFromItsOwnSeat_WithRealPositions()
    {
        var (session, _) = NewMatch();
        StepTo(session, 30);

        var fromA = SnapshotBuilder.Build(session, viewerIsA: true);
        var fromB = SnapshotBuilder.Build(session, viewerIsA: false);

        Assert.Equal(fromA.You.Name, fromB.Enemy.Name);
        Assert.Equal(fromA.Enemy.Name, fromB.You.Name);
        Assert.Equal(session.Tick, fromA.Tick);
        Assert.Equal(MatchSession.Duration, fromA.Duration);
        Assert.Equal(2, fromA.You.Structures.Count(s => s.Key == "tower"));
        Assert.Single(fromA.You.Structures, s => s.Key == "keep");
        // reinforcement means the keep isn't at raw MaxHp yet this early
        var keep = fromA.You.Structures.Single(s => s.Key == "keep");
        Assert.True(keep.Hp < Content.Defense.Keep.Hp);
    }
}
