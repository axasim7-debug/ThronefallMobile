using System.Collections.Concurrent;

namespace Thronefall.PositionalEngine;

/// <summary>
/// What a player can actually do during a match. Anything the client wants
/// to happen arrives as one of these — the client itself holds no game logic
/// (docs/GAME_DESIGN.md §5), so this is the complete surface. A faithful
/// extension of server/Thronefall.Engine/PlayerCommands.cs's shape, plus
/// MoveUnit — the primitive the live-positioning vision (drag a unit to a
/// spot on the field, including mid-fight retreat) is built on.
/// </summary>
public enum CommandKind
{
    Build,      // Arg: "farm" | "barracks"
    Train,      // Arg: a key from Content.Troops
    Repair,     // Arg: ignored (the engine picks the damaged tower)
    MoveUnit,   // Arg: the unit's id; X/Z: the target position
}

/// <summary>One intent from a client. X/Z are only meaningful for MoveUnit.
/// <paramref name="ClientSeq"/> is echoed back in the ack so a client can
/// match a response to what it sent.</summary>
public sealed record PlayerCommand(CommandKind Kind, string Arg, double? X = null, double? Z = null, long? ClientSeq = null);

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

    /// <summary>Called first each tick, before anything resolves — the point
    /// at which buffered network input is frozen for this tick.</summary>
    void BeginTick(int t);

    /// <summary>Build/train/move agency for this tick. `enemy` is needed for
    /// a bot's grouped-release target (the enemy keep); a real player ignores
    /// it entirely, since MoveUnit commands already carry an explicit
    /// target.</summary>
    void Act(MatchPlayer pl, MatchPlayer enemy, int t);
}

/// <summary>
/// Wraps a build-order bot. Follows its fixed build order and groups trained
/// troops before sending them — the exact behavior every number in
/// docs/PROGRESS.md's full-match section was measured against.
/// </summary>
public sealed class BotController : IMatchController
{
    private readonly IStrategy _strategy;
    public BotController(IStrategy strategy) => _strategy = strategy;

    public string Name => _strategy.Name;

    public void BeginTick(int t) { }

    public void Act(MatchPlayer pl, MatchPlayer enemy, int t)
    {
        if (pl.BuildBusy is null) _strategy.Decide(pl, t);
        if (!pl.TroopBusy) Match.StartTroop(pl, _strategy.PickTroop(pl));
        var groupSize = _strategy.AttackGroupSize ?? Match.DefaultAttackGroupSize;
        if (pl.Reserve.Count >= groupSize) Match.ReleaseReserve(pl, enemy);
    }
}

/// <summary>
/// A real player. Commands arrive asynchronously off the network and are
/// buffered; each tick the queue is drained once and the intents are applied
/// in the agency phase. That keeps a networked match resolving in exactly the
/// same order as a bot match, so arrival timing can't be gamed by spamming
/// input. Unlike BotController, a trained troop is left exactly where it
/// spawns until the player sends an explicit MoveUnit — no auto-release,
/// full manual control.
/// </summary>
public sealed class PlayerController : IMatchController
{
    private readonly ConcurrentQueue<PlayerCommand> _inbox = new();
    private readonly ConcurrentQueue<CommandAck> _acks = new();
    private readonly List<PlayerCommand> _thisTick = new();

    public string Name { get; }
    public PlayerController(string name) => Name = name;

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

    public void Act(MatchPlayer pl, MatchPlayer enemy, int t)
    {
        foreach (var cmd in _thisTick)
        {
            switch (cmd.Kind)
            {
                case CommandKind.Build:
                    Resolve(cmd, t, Match.StartBuild(pl, cmd.Arg), () => WhyBuildFailed(pl, cmd.Arg));
                    break;
                case CommandKind.Train:
                    Resolve(cmd, t, Match.StartTroop(pl, cmd.Arg), () => WhyTrainFailed(pl, cmd.Arg));
                    break;
                case CommandKind.Repair:
                    Resolve(cmd, t, Match.StartRepair(pl, t), () => WhyRepairFailed(pl));
                    break;
                case CommandKind.MoveUnit:
                    Resolve(cmd, t, TryMoveUnit(pl, cmd), () => WhyMoveFailed(pl, cmd));
                    break;
            }
        }
    }

    private static bool TryMoveUnit(MatchPlayer pl, PlayerCommand cmd)
    {
        if (cmd.X is null || cmd.Z is null) return false;
        if (!pl.Battle.Units.TryGetValue(cmd.Arg, out var unit)) return false;
        if (unit.Side != pl.Side || !unit.Alive) return false;
        return pl.Battle.MoveUnit(cmd.Arg, cmd.X.Value, cmd.Z.Value);
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
    // These only explain a refusal that StartBuild/StartTroop/StartRepair/
    // TryMoveUnit has ALREADY made. The authority stays in the engine;
    // duplicating a check here could at worst produce a misleading message,
    // never an illegal move.

    private static string WhyBuildFailed(MatchPlayer pl, string building)
    {
        if (building is not ("farm" or "barracks")) return "unknown-building";
        if (pl.BuildBusy is not null) return "build-slot-busy";
        return building switch
        {
            "farm" => pl.Farms >= Content.Buildings.Farm.MaxCount ? "farm-limit-reached" : "not-enough-gold",
            _ => pl.HasBarracks ? "barracks-already-built" : "not-enough-gold",
        };
    }

    private static string WhyTrainFailed(MatchPlayer pl, string troopKey)
    {
        if (!Content.Troops.ContainsKey(troopKey)) return "unknown-troop";
        if (!pl.HasBarracks) return "no-barracks";
        if (pl.TroopBusy) return "training-slot-busy";
        return "not-enough-gold";
    }

    private static string WhyRepairFailed(MatchPlayer pl) =>
        pl.BuildBusy is not null ? "build-slot-busy" : "nothing-to-repair-or-not-enough-gold";

    private static string WhyMoveFailed(MatchPlayer pl, PlayerCommand cmd)
    {
        if (cmd.X is null || cmd.Z is null) return "move-needs-coordinates";
        if (!pl.Battle.Units.TryGetValue(cmd.Arg, out var unit)) return "unknown-unit";
        if (unit.Side != pl.Side) return "not-your-unit";
        if (!unit.Alive) return "unit-already-dead";
        return "invalid-move";
    }
}
