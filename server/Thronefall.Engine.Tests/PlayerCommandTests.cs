using Thronefall.Engine;

namespace Thronefall.Engine.Tests;

/// <summary>
/// The real-time player command protocol. These are adversarial on purpose:
/// commands arrive from a network client we do not control, so every test
/// here asks "what if the client lies?" rather than "does the happy path
/// work?". The engine must refuse illegal commands rather than trust them —
/// docs/GAME_DESIGN.md §5: the client holds no game logic and no authority.
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

    // --- the player actually gets agency -------------------------------

    [Fact]
    public void BuildCommand_IsApplied_AndChargesGold()
    {
        var (session, player) = NewMatch();
        session.Step(); // t=0
        // the match starts with less gold than a farm costs; hand the player
        // exactly the listed price so this tests the charge, not the wait
        session.A.Gold = Content.Buildings.Farm.Cost;

        var goldBefore = session.A.Gold;
        player.Submit(new PlayerCommand(CommandKind.Build, "farm", ClientSeq: 7));
        session.Step();

        var ack = SingleAck(player);
        Assert.True(ack.Accepted);
        Assert.Equal(7, ack.ClientSeq);
        Assert.Equal("farm", session.A.BuildBusy);
        // charged exactly the listed cost (income is also added this tick)
        Assert.Equal(Content.Buildings.Farm.Cost, goldBefore + session.A.Income - session.A.Gold);
    }

    [Fact]
    public void BuildCommand_CompletesAfterItsBuildTime()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = Content.Buildings.Farm.Cost;
        player.Submit(new PlayerCommand(CommandKind.Build, "farm"));

        StepTo(session, (int)Content.Buildings.Farm.BuildTime + 4);

        Assert.Single(session.A.Farms);
        Assert.Null(session.A.BuildBusy);
        Assert.Equal(Content.Economy.BaseIncome + Content.Buildings.Farm.IncomeBonus, session.A.Income);
    }

    [Fact]
    public void TrainCommand_ProducesTroops_ThatReachTheEnemy()
    {
        var (session, player) = NewMatch("eco");
        // barracks first, then train continuously. The barracks is not
        // affordable on tick 1, so retry until income covers it.
        session.Step();
        while (session.Step())
        {
            if (!session.A.HasBarracks && session.A.BuildBusy is null)
                player.Submit(new PlayerCommand(CommandKind.Build, "barracks"));
            else if (session.A.HasBarracks && !session.A.TroopBusy)
                player.Submit(new PlayerCommand(CommandKind.Train, "cavalry"));
        }

        Assert.True(session.A.TroopsProduced > 0, "player commands should produce troops");
        // and those troops must actually land on the opponent — not merely exist.
        // (This is the failure mode the fractional-march-time bug produced.)
        var enemyWasHit = session.B.Stats.DiedAtWall + session.B.Stats.StoppedAtTower
                          + session.B.Stats.ReachedKeep + session.B.Stats.FarmsRaided;
        Assert.True(enemyWasHit > 0, "produced troops must actually arrive and engage");
    }

    // --- refusals: the client does not get to lie ----------------------

    [Fact]
    public void Build_IsRefused_WhenGoldIsInsufficient()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 0;

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
        Assert.Equal(Content.Buildings.Farm.MaxCount, session.A.Farms.Count);
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

    /// <summary>
    /// Regression: StartTroop used to index Content.Troops directly, so an
    /// unknown key threw KeyNotFoundException. Unreachable from bots (they
    /// only pass valid keys) but trivially reachable from a network client,
    /// where it would have taken down the whole tick loop.
    /// </summary>
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

    /// <summary>
    /// Regression: StartRepair did not check the build slot. Bots never hit
    /// it (their caller checked first), but a player could spam repair to
    /// overwrite an in-progress build — cancelling a build they had already
    /// paid for and freeing the slot for something else.
    /// </summary>
    [Fact]
    public void Repair_CannotClobberAnInProgressBuild()
    {
        var (session, player) = NewMatch();
        session.Step();
        session.A.Gold = 10_000;
        // a damaged wall exists, so repair has a legitimate target
        session.A.WallMaxHp = Content.Buildings.Wall.HpPerSegment;
        session.A.WallHp = 10;

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

    // --- rage is manual for players, automatic for bots -----------------

    /// <summary>
    /// The rage skill is the one ability a player fires by hand
    /// (docs/PROGRESS.md). It must charge on its own but never discharge on
    /// its own, or the tactical decision the whole commander system is built
    /// around would play itself.
    /// </summary>
    [Fact]
    public void Rage_FillsButNeverSelfCasts_ForAPlayer()
    {
        var (session, _) = NewMatch();
        StepTo(session, 200); // long past the ~54s needed to charge

        var commander = session.A.Commanders[0];
        Assert.True(commander.Rage >= Content.Commanders[commander.Key].RageCost,
            "rage must still accrue for a player");
        Assert.Equal(0, commander.Casts);

        // the bot opponent, by contrast, fires as soon as it can afford to
        Assert.True(session.B.Commanders.Sum(c => c.Casts) > 0);
    }

    [Fact]
    public void Rage_CastsOnCommand_AndSpendsTheBar()
    {
        var (session, player) = NewMatch();
        StepTo(session, 200);

        var commander = session.A.Commanders.First(c => c.Key == "warlord");
        var rageBefore = commander.Rage;

        player.Submit(new PlayerCommand(CommandKind.CastRage, "warlord"));
        session.Step();

        var ack = player.DrainAcks().Single(a => a.Kind == CommandKind.CastRage);
        Assert.True(ack.Accepted);
        Assert.Equal(1, commander.Casts);
        Assert.True(commander.Rage < rageBefore);
        // warlord's rage hits the enemy's weakest tower
        Assert.True(session.B.Towers.Any(t => t.DamageTaken > 0));
    }

    [Fact]
    public void Rage_IsRefused_WhenNotCharged()
    {
        var (session, player) = NewMatch();
        session.Step(); // barely any rage accrued yet

        player.Submit(new PlayerCommand(CommandKind.CastRage, "warlord"));
        session.Step();

        var ack = player.DrainAcks().Single(a => a.Kind == CommandKind.CastRage);
        Assert.False(ack.Accepted);
        Assert.Equal("rage-not-charged", ack.Reason);
        Assert.Equal(0, session.A.Commanders.First(c => c.Key == "warlord").Casts);
    }

    [Fact]
    public void Rage_IsRefused_ForACommanderNotInTheSquad()
    {
        var (session, player) = NewMatch();
        StepTo(session, 200);

        player.Submit(new PlayerCommand(CommandKind.CastRage, "sorcerer-not-on-roster"));
        session.Step();

        var ack = player.DrainAcks().Single(a => a.Kind == CommandKind.CastRage);
        Assert.False(ack.Accepted);
        Assert.Equal("commander-not-in-squad", ack.Reason);
    }

    // --- the session itself --------------------------------------------

    /// <summary>
    /// Stepping tick-by-tick must land on exactly the result the batch
    /// simulation gives. If these ever diverge, the live match and every
    /// validated balance number are no longer describing the same game.
    /// </summary>
    [Fact]
    public void SteppedSession_MatchesBatchSimulation_Exactly()
    {
        foreach (var (a, b) in new[] { ("eco", "atk"), ("def", "atk"), ("eco", "def"), ("atk", "atk") })
        {
            var stepped = new MatchSession(
                new BotController(Strategies.All[a]), new BotController(Strategies.All[b]));
            while (stepped.Step()) { }

            var (batchA, batchB, batchResult) = MatchEngine.Simulate(Strategies.All[a], Strategies.All[b]);

            Assert.Equal(batchResult.Winner, stepped.Result!.Winner);
            Assert.Equal(batchResult.Tiebreak, stepped.Result.Tiebreak);
            Assert.Equal(batchA.TroopsProduced, stepped.A.TroopsProduced);
            Assert.Equal(batchB.TroopsProduced, stepped.B.TroopsProduced);
            Assert.Equal(
                MatchEngine.CurrentHp(batchA.Keep, MatchSession.Duration),
                MatchEngine.CurrentHp(stepped.A.Keep, MatchSession.Duration), 6);
            Assert.Equal(
                MatchEngine.CurrentHp(batchB.Keep, MatchSession.Duration),
                MatchEngine.CurrentHp(stepped.B.Keep, MatchSession.Duration), 6);
        }
    }

    /// <summary>
    /// Two players issuing identical commands must get identical outcomes.
    /// The mirror-symmetry guarantee (docs/PROGRESS.md) was established for
    /// bots; the command path must not reintroduce an ordering advantage for
    /// whichever side the server happens to resolve first.
    /// </summary>
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
                player.Submit(new PlayerCommand(CommandKind.CastRage, "warlord"));
            }
            session.Step();
        }

        Assert.Equal(session.A.TroopsProduced, session.B.TroopsProduced);
        Assert.Equal(session.A.Gold, session.B.Gold);
        Assert.Equal(session.A.KeepDestroyedAtT, session.B.KeepDestroyedAtT);
        Assert.Equal(
            MatchEngine.CurrentHp(session.A.Keep, MatchSession.Duration),
            MatchEngine.CurrentHp(session.B.Keep, MatchSession.Duration), 6);
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

        if (session.A.KeepDestroyedAtT is not null || session.B.KeepDestroyedAtT is not null)
            Assert.True(session.Tick < MatchSession.Duration, "a decided match should not keep ticking");
        Assert.True(session.Finished);
        Assert.NotNull(session.Result);
    }

    [Fact]
    public void Snapshot_ReportsEachSideFromItsOwnSeat()
    {
        var (session, _) = NewMatch();
        StepTo(session, 30);

        var fromA = SnapshotBuilder.Build(session, viewerIsA: true);
        var fromB = SnapshotBuilder.Build(session, viewerIsA: false);

        Assert.Equal(fromA.You.Name, fromB.Enemy.Name);
        Assert.Equal(fromA.Enemy.Name, fromB.You.Name);
        Assert.Equal(session.Tick, fromA.Tick);
        Assert.Equal(MatchSession.Duration, fromA.Duration);
        // HP is pre-resolved against the reinforcement ramp, never raw MaxHp
        Assert.True(fromA.You.Keep.MaxHp < Content.Defense.Keep.Hp);
        Assert.Equal(3, fromA.You.Commanders.Count);
    }
}
