namespace Thronefall.PositionalEngine;

/// <summary>
/// One live match, advanced one tick at a time by an outside caller. This
/// holds the only authoritative tick loop in the project — Match.SimulateMatch
/// now drives this same class with bot controllers, so the loop a networked
/// match runs is byte-for-byte the loop every number in docs/PROGRESS.md's
/// full-match section was measured against. A faithful structural port of
/// server/Thronefall.Engine/MatchSession.cs, adapted for this engine's
/// continuous combat (sub-stepped Battle.Step calls instead of a
/// troop-arrival queue).
///
/// Phase order within a tick is deliberate:
///   0. freeze buffered player input for this tick
///   1. advance combat (several Battle.Step sub-steps to cover one second)
///   2. reinforcement bookkeeping, off a real pre-combat HP snapshot
///   3. income, build/train timers
///   4. agency (bot decide/train/release, or player command resolution)
/// </summary>
public sealed class MatchSession
{
    public Battle Battle { get; }
    public MatchPlayer A { get; }
    public MatchPlayer B { get; }

    /// <summary>Current tick in seconds; -1 before the first Step().</summary>
    public int Tick { get; private set; } = -1;

    public bool Finished { get; private set; }
    public Match.MatchResult? Result { get; private set; }

    public static int Duration => Content.Economy.DurationSeconds;

    private static readonly int SubStepsPerSecond = (int)Math.Round(1 / Battle.DefaultDt);

    private readonly IMatchController _controllerA;
    private readonly IMatchController _controllerB;
    private readonly bool _endEarlyOnKeepKill;

    /// <param name="endEarlyOnKeepKill">
    /// Live matches stop the moment a keep falls. Bot simulations must NOT:
    /// tests and cross-validation numbers depend on running the full
    /// duration and observing the surviving player's final stats. Hence the
    /// default of false.
    /// </param>
    public MatchSession(IMatchController controllerA, IMatchController controllerB, bool endEarlyOnKeepKill = false)
    {
        _controllerA = controllerA;
        _controllerB = controllerB;
        _endEarlyOnKeepKill = endEarlyOnKeepKill;

        Battle = new Battle();
        var defA = Match.BuildDefense(Battle, "A", -1);
        var defB = Match.BuildDefense(Battle, "B", 1);
        A = new MatchPlayer("A", -1, controllerA.Name, Battle, defA.TowerIds, defA.KeepId);
        B = new MatchPlayer("B", 1, controllerB.Name, Battle, defB.TowerIds, defB.KeepId);
    }

    /// <summary>Advances the match by exactly one second. Returns false once
    /// the match is over (and leaves <see cref="Result"/> populated).</summary>
    public bool Step()
    {
        if (Finished) return false;
        var t = ++Tick;

        // 0. freeze this tick's input
        _controllerA.BeginTick(t);
        _controllerB.BeginTick(t);

        if (t > 0)
        {
            // 1-2. combat, then reinforcement bookkeeping off a real snapshot
            var beforeHp = new Dictionary<string, double>();
            foreach (var s in A.MyStructures().Concat(B.MyStructures())) beforeHp[s.Id] = s.Hp;

            for (var i = 0; i < SubStepsPerSecond; i++) Battle.Step();

            A.ApplyReinforcement(t, beforeHp);
            B.ApplyReinforcement(t, beforeHp);

            // 3. income, build/train timers
            foreach (var pl in new[] { A, B })
            {
                if (Match.IsKeepDestroyed(Battle, pl)) continue;
                pl.Gold += pl.Income;
                Match.AdvanceBuild(pl, t);
                Match.AdvanceTroop(pl, t);
            }
        }

        // 4. agency
        if (!Match.IsKeepDestroyed(Battle, A)) _controllerA.Act(A, B, t);
        if (!Match.IsKeepDestroyed(Battle, B)) _controllerB.Act(B, A, t);

        // end of match: don't leave a half-formed bot group sitting unused
        // forever — send whatever's left, even if too late to matter, so
        // final numbers (TroopsProduced, structure HP) stay honest. A real
        // player's untouched units are swept the same way, harmlessly — the
        // match is over the instant this tick ends either way.
        if (t == Duration)
        {
            Match.ReleaseReserve(A, B);
            Match.ReleaseReserve(B, A);
        }

        var keepFell = Match.IsKeepDestroyed(Battle, A) || Match.IsKeepDestroyed(Battle, B);
        if (t >= Duration || (_endEarlyOnKeepKill && keepFell))
        {
            Finished = true;
            Result = Match.DetermineWinner(Battle, A, B);
        }
        return true;
    }

    public void RunToCompletion()
    {
        while (Step()) { }
    }
}
