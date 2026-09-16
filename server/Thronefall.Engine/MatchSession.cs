namespace Thronefall.Engine;

/// <summary>
/// One live match, advanced one tick at a time by an outside caller.
///
/// This holds the ONLY authoritative tick loop in the project —
/// MatchEngine.Simulate now drives this same class with bot controllers, so
/// the loop a networked match runs is byte-for-byte the loop every balance
/// number in docs/PROGRESS.md was measured against. Changing phase order here
/// changes bot results too, and the cross-validation tests will say so.
///
/// Phase order within a tick is deliberate and load-bearing:
///   0. freeze buffered player input for this tick
///   1. resolve troop arrivals
///   2. income (minus farm-disruption penalties)
///   3. advance in-flight build/training timers
///   4. rage: fill, then collect casts, then apply DAMAGE casts before REPAIR
///   5. player/bot agency (new builds, new training)
///
/// Step 4's damage-before-repair split is not cosmetic: applying one player's
/// effects fully before the other's made mirror matchups asymmetric, because
/// whoever resolved second got to repair damage the first had just dealt.
/// See docs/PROGRESS.md; a permanent mirror-symmetry test guards it.
/// </summary>
public sealed class MatchSession
{
    public PlayerState A { get; }
    public PlayerState B { get; }

    /// <summary>Current tick in seconds; -1 before the first Step().</summary>
    public int Tick { get; private set; } = -1;

    public bool Finished { get; private set; }
    public MatchEngine.MatchResult? Result { get; private set; }

    public static int Duration => Content.Economy.DurationSeconds;

    private readonly IMatchController _controllerA;
    private readonly IMatchController _controllerB;
    private readonly Dictionary<int, List<MarchingTroop>> _arrivalsToA = new();
    private readonly Dictionary<int, List<MarchingTroop>> _arrivalsToB = new();
    private readonly bool _endEarlyOnKeepKill;

    /// <param name="endEarlyOnKeepKill">
    /// Live matches stop the moment a keep falls. Bot simulations must NOT:
    /// the JS reference engine runs the full 360s and keeps accumulating the
    /// surviving player's stats, and the cross-validation numbers depend on
    /// that. Hence the default of false.
    /// </param>
    public MatchSession(IMatchController controllerA, IMatchController controllerB, bool endEarlyOnKeepKill = false)
    {
        _controllerA = controllerA;
        _controllerB = controllerB;
        _endEarlyOnKeepKill = endEarlyOnKeepKill;
        A = MatchEngine.InitPlayer(controllerA.Name, controllerA.Squad);
        B = MatchEngine.InitPlayer(controllerB.Name, controllerB.Squad);
    }

    private static void Queue(Dictionary<int, List<MarchingTroop>> map, MarchingTroop arrival)
    {
        if (!map.TryGetValue(arrival.ArriveAt, out var list)) map[arrival.ArriveAt] = list = new List<MarchingTroop>();
        list.Add(arrival);
    }

    /// <summary>
    /// Advances the match by exactly one second. Returns false once the match
    /// is over (and leaves <see cref="Result"/> populated).
    /// </summary>
    public bool Step()
    {
        if (Finished) return false;
        var t = ++Tick;

        // 0. freeze this tick's input
        _controllerA.BeginTick(t);
        _controllerB.BeginTick(t);

        // 1. arrivals
        if (_arrivalsToA.TryGetValue(t, out var arrA))
        {
            foreach (var troop in arrA) MatchEngine.ResolveAttack(A, troop, t);
            _arrivalsToA.Remove(t); // resolved; keeps InFlightFrom's scan bounded
        }
        if (_arrivalsToB.TryGetValue(t, out var arrB))
        {
            foreach (var troop in arrB) MatchEngine.ResolveAttack(B, troop, t);
            _arrivalsToB.Remove(t);
        }

        if (t > 0)
        {
            // 2. income
            foreach (var pl in new[] { A, B })
            {
                if (pl.KeepDestroyedAtT is not null) continue;
                pl.Disruptions = pl.Disruptions.Where(d => d.Until > t).ToList();
                var penalty = pl.Disruptions.Sum(d => d.Amount);
                pl.Gold += Math.Max(1, pl.Income - penalty);
            }

            // 3. in-flight timers
            if (A.KeepDestroyedAtT is null)
            {
                MatchEngine.AdvanceBuild(A, t);
                MatchEngine.AdvanceTroop(A, t, arr => Queue(_arrivalsToB, arr));
            }
            if (B.KeepDestroyedAtT is null)
            {
                MatchEngine.AdvanceBuild(B, t);
                MatchEngine.AdvanceTroop(B, t, arr => Queue(_arrivalsToA, arr));
            }

            // 4. rage
            var pending = new List<MatchEngine.PendingCast>();
            if (A.KeepDestroyedAtT is null)
            {
                MatchEngine.FillRage(A);
                foreach (var commander in _controllerA.CommandersToCast(A, t))
                    if (MatchEngine.TryCast(A, B, commander, t) is { } cast) pending.Add(cast);
            }
            if (B.KeepDestroyedAtT is null)
            {
                MatchEngine.FillRage(B);
                foreach (var commander in _controllerB.CommandersToCast(B, t))
                    if (MatchEngine.TryCast(B, A, commander, t) is { } cast) pending.Add(cast);
            }
            foreach (var cast in pending.Where(c => c.Kind == "damageStructure"))
                MatchEngine.ApplyCommanderCast(cast, t);
            foreach (var cast in pending.Where(c => c.Kind != "damageStructure"))
                MatchEngine.ApplyCommanderCast(cast, t);
        }

        // 5. agency
        if (A.KeepDestroyedAtT is null) _controllerA.Act(A, t);
        if (B.KeepDestroyedAtT is null) _controllerB.Act(B, t);

        var keepFell = A.KeepDestroyedAtT is not null || B.KeepDestroyedAtT is not null;
        if (t >= Duration || (_endEarlyOnKeepKill && keepFell))
        {
            Finished = true;
            Result = MatchEngine.DetermineWinner(A, B);
        }
        return true;
    }

    public void RunToCompletion()
    {
        while (Step()) { }
    }

    /// <summary>
    /// Troops this side has sent that have not yet arrived — what a snapshot
    /// needs to draw units on the battlefield instead of two static bases.
    /// A's outgoing troops live in _arrivalsToB (they're queued by
    /// destination, not by sender), so this reads the other side's inbox and
    /// keeps everything still keyed by future arrival tick.
    /// </summary>
    public IReadOnlyList<MarchingTroop> InFlightFrom(bool fromA)
    {
        var inbox = fromA ? _arrivalsToB : _arrivalsToA;
        return inbox.Where(kv => kv.Key > Tick).SelectMany(kv => kv.Value).ToList();
    }
}
