using System.Collections.Concurrent;

namespace Thronefall.Engine;

/// <summary>
/// The four things a player can actually do during a match. Anything the
/// client wants to happen arrives as one of these — the client itself holds
/// no game logic (docs/GAME_DESIGN.md §5), so this is the complete surface.
/// </summary>
public enum CommandKind
{
    Build,     // Arg: "farm" | "wall" | "barracks"
    Train,     // Arg: a key from Content.Troops
    Repair,    // Arg: ignored (the engine picks the damaged structure)
    CastRage,  // Arg: a commander key in the player's own squad
}

/// <summary>One intent from a client. <paramref name="ClientSeq"/> is echoed
/// back in the ack so a client can match a response to what it sent.</summary>
public sealed record PlayerCommand(CommandKind Kind, string Arg, long? ClientSeq = null);

/// <summary>
/// The server's verdict on one command. A rejection is a normal outcome, not
/// an error: clients optimistically fire commands and the authoritative
/// server decides. <paramref name="Reason"/> is a stable machine-readable
/// slug, so the client can localize it.
/// </summary>
public sealed record CommandAck(
    long? ClientSeq, CommandKind Kind, string Arg, bool Accepted, string? Reason, int Tick);

/// <summary>
/// Drives one side of a match. Implemented either by a test bot or by a real
/// networked player; MatchSession treats them identically, which is what
/// keeps bot-validated numbers meaningful for real matches.
/// </summary>
public interface IMatchController
{
    string Name { get; }
    IReadOnlyList<string> Squad { get; }

    /// <summary>Called first each tick, before anything resolves — the point
    /// at which buffered network input is frozen for this tick.</summary>
    void BeginTick(int t);

    /// <summary>Commanders attempting to fire their rage skill this tick.</summary>
    IEnumerable<CommanderInstance> CommandersToCast(PlayerState pl, int t);

    /// <summary>Build/train agency for this tick.</summary>
    void Act(PlayerState pl, int t);
}

/// <summary>
/// Wraps a build-order bot. Fires rage the moment it's affordable and follows
/// its fixed build order — the exact behavior every balance number in
/// docs/PROGRESS.md was measured against.
/// </summary>
public sealed class BotController : IMatchController
{
    private readonly IStrategy _strategy;
    public BotController(IStrategy strategy) => _strategy = strategy;

    public string Name => _strategy.Name;
    public IReadOnlyList<string> Squad => _strategy.Squad;

    public void BeginTick(int t) { }

    // auto-cast: offer every commander, TryCast decides affordability
    public IEnumerable<CommanderInstance> CommandersToCast(PlayerState pl, int t) => pl.Commanders;

    public void Act(PlayerState pl, int t)
    {
        if (pl.BuildBusy is null) _strategy.Decide(pl, t);
        if (!pl.TroopBusy) MatchEngine.StartTroop(pl, _strategy.PickTroop(pl));
    }
}

/// <summary>
/// A real player. Commands arrive asynchronously off the network and are
/// buffered; each tick the queue is drained once and the intents are applied
/// in their correct phase — rage with the other casts, builds/training in the
/// decision phase. That keeps a networked match resolving in exactly the same
/// order as a bot match, so arrival timing can't be gamed by spamming input.
/// </summary>
public sealed class PlayerController : IMatchController
{
    private readonly ConcurrentQueue<PlayerCommand> _inbox = new();
    private readonly ConcurrentQueue<CommandAck> _acks = new();
    private readonly List<PlayerCommand> _thisTick = new();

    public string Name { get; }
    public IReadOnlyList<string> Squad { get; }

    public PlayerController(string name, IReadOnlyList<string>? squad = null)
    {
        Name = name;
        Squad = squad ?? Strategies.FullSquad;
    }

    /// <summary>Called from the network thread; never blocks the tick loop.</summary>
    public void Submit(PlayerCommand command) => _inbox.Enqueue(command);

    /// <summary>Drains acks produced since the last call, for sending back.</summary>
    public IReadOnlyList<CommandAck> DrainAcks()
    {
        var list = new List<CommandAck>();
        while (_acks.TryDequeue(out var ack)) list.Add(ack);
        return list;
    }

    public void BeginTick(int t)
    {
        _thisTick.Clear();
        while (_inbox.TryDequeue(out var cmd)) _thisTick.Add(cmd);
    }

    public IEnumerable<CommanderInstance> CommandersToCast(PlayerState pl, int t)
    {
        foreach (var cmd in _thisTick.Where(c => c.Kind == CommandKind.CastRage))
        {
            var commander = pl.Commanders.FirstOrDefault(c => c.Key == cmd.Arg);
            if (commander is null)
            {
                Reject(cmd, "commander-not-in-squad", t);
                continue;
            }
            if (commander.Rage < Content.Commanders[commander.Key].RageCost)
            {
                Reject(cmd, "rage-not-charged", t);
                continue;
            }
            Accept(cmd, t);
            yield return commander;
        }
    }

    public void Act(PlayerState pl, int t)
    {
        foreach (var cmd in _thisTick)
        {
            switch (cmd.Kind)
            {
                case CommandKind.CastRage:
                    continue; // already handled in the cast phase
                case CommandKind.Build:
                    Resolve(cmd, t, MatchEngine.StartBuild(pl, cmd.Arg), () => WhyBuildFailed(pl, cmd.Arg));
                    break;
                case CommandKind.Train:
                    Resolve(cmd, t, MatchEngine.StartTroop(pl, cmd.Arg), () => WhyTrainFailed(pl, cmd.Arg));
                    break;
                case CommandKind.Repair:
                    Resolve(cmd, t, MatchEngine.StartRepair(pl, t), () => WhyRepairFailed(pl, t));
                    break;
            }
        }
    }

    private void Resolve(PlayerCommand cmd, int t, bool ok, Func<string> reason)
    {
        if (ok) Accept(cmd, t);
        else Reject(cmd, reason(), t);
    }

    private void Accept(PlayerCommand cmd, int t) =>
        _acks.Enqueue(new CommandAck(cmd.ClientSeq, cmd.Kind, cmd.Arg, true, null, t));

    private void Reject(PlayerCommand cmd, string reason, int t) =>
        _acks.Enqueue(new CommandAck(cmd.ClientSeq, cmd.Kind, cmd.Arg, false, reason, t));

    // --- rejection diagnostics -------------------------------------------
    // These only explain a refusal that StartBuild/StartTroop/StartRepair has
    // ALREADY made. The authority stays in the engine; duplicating a check
    // here could at worst produce a misleading message, never an illegal move.

    private static string WhyBuildFailed(PlayerState pl, string building)
    {
        if (building is not ("farm" or "wall" or "barracks")) return "unknown-building";
        if (pl.BuildBusy is not null) return "build-slot-busy";
        switch (building)
        {
            case "farm":
                if (pl.Farms.Count >= Content.Buildings.Farm.MaxCount) return "farm-limit-reached";
                return "not-enough-gold";
            case "wall":
                var wall = Content.Buildings.Wall;
                if (pl.WallMaxHp >= wall.MaxSegments * wall.HpPerSegment) return "wall-already-complete";
                return "not-enough-gold";
            default:
                if (pl.HasBarracks) return "barracks-already-built";
                return "not-enough-gold";
        }
    }

    private static string WhyTrainFailed(PlayerState pl, string troopKey)
    {
        if (!Content.Troops.ContainsKey(troopKey)) return "unknown-troop";
        if (!pl.HasBarracks) return "no-barracks";
        if (pl.TroopBusy) return "training-slot-busy";
        return "not-enough-gold";
    }

    private static string WhyRepairFailed(PlayerState pl, int t)
    {
        if (pl.BuildBusy is not null) return "build-slot-busy";
        return "nothing-to-repair-or-not-enough-gold";
    }
}
