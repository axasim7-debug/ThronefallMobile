namespace Thronefall.PositionalEngine;

// Continuous positional combat engine — a faithful C# port of
// tools/battle-sim/src/engine.js. Deliberately a NEW, separate engine
// (server/Thronefall.Engine, the tick-based instant-resolution model, is
// untouched and still what real matches run on) — see docs/PROGRESS.md for
// why this exists and the "new engine alongside the old" decision.
//
//   - units have a real (x, z) position, HP, DPS, range, move speed
//   - NOTHING auto-advances. A unit sits exactly where it's put until a
//     player issues a move order or an enemy comes within its range.
//   - engagement is symmetric and continuous: two things in range of each
//     other exchange damage every tick until one dies or leaves range —
//     never a single instant-resolution hit, troop-vs-troop or troop-vs-
//     structure alike.
//   - retreating (a fresh move order) breaks engagement immediately; there
//     is no forced lock-in.
//   - there is deliberately no rock-paper-scissors unit-type system. Every
//     card carries its own raw stats; tactics comes from which cards a
//     player brings and how they move them live, not from a type table
//     baked into the engine.
//
// Keep this file in sync with tools/battle-sim/src/engine.js deliberately —
// that JS copy is the fast-iteration tool the model was designed and
// stress-tested in; this is what real matches will actually run on once
// wired up. Nothing here is "final" until tested from multiple angles.

public interface ICombatant
{
    string Id { get; }
    string Side { get; }
    double X { get; }
    double Z { get; }
}

public sealed class Unit : ICombatant
{
    public required string Id { get; init; }
    public required string Key { get; init; }
    public required string Side { get; init; }
    public double X { get; set; }
    public double Z { get; set; }
    public double Hp { get; set; }
    public double MaxHp { get; init; }
    public double Dps { get; init; }
    public double Range { get; init; }
    public double Speed { get; init; }
    public (double X, double Z)? Waypoint { get; set; }
    public bool Alive { get; set; } = true;
    public string? TargetId { get; set; }
}

public sealed class Structure : ICombatant
{
    public required string Id { get; init; }
    public required string Key { get; init; }
    public required string Side { get; init; }
    public double X { get; init; }
    public double Z { get; init; }
    public double Hp { get; set; }
    public double MaxHp { get; init; }
    public double Dps { get; init; }
    public double Range { get; init; }
    public bool Destroyed { get; set; }
    public string? TargetId { get; set; }
}

public sealed record LogEvent(double T, string Event, string Id, string Key, string Side);

/// <summary>
/// A live battle. Two sides ("A"/"B"), each a list of units plus fixed
/// structures. Advance with Step(dt); issue orders with MoveUnit(id, x, z)
/// at any time between steps — exactly like a player dragging a card.
/// </summary>
public sealed class Battle
{
    public const double DefaultDt = 0.25; // seconds per tick — fine enough for smooth kiting/retreats

    public double Time { get; private set; }
    public Dictionary<string, Unit> Units { get; } = new();
    public Dictionary<string, Structure> Structures { get; } = new();
    public List<LogEvent> Log { get; } = new();

    private int _nextId = 1;

    public static double Distance(double x1, double z1, double x2, double z2)
    {
        var dx = x1 - x2;
        var dz = z1 - z2;
        return Math.Sqrt(dx * dx + dz * dz);
    }

    public string AddUnit(string side, double x, double z, double hp, double dps, double range, double speed, string key = "unit")
    {
        var id = $"u{_nextId++}";
        Units[id] = new Unit { Id = id, Key = key, Side = side, X = x, Z = z, Hp = hp, MaxHp = hp, Dps = dps, Range = range, Speed = speed };
        return id;
    }

    public string AddStructure(string side, double x, double z, double hp, double dps, double range, string key = "structure")
    {
        var id = $"s{_nextId++}";
        Structures[id] = new Structure { Id = id, Key = key, Side = side, X = x, Z = z, Hp = hp, MaxHp = hp, Dps = dps, Range = range };
        return id;
    }

    /// <summary>Player intent: send a unit toward (x, z). Overrides any current
    /// order and — this is the retreat mechanic — takes priority over whatever
    /// the unit was doing, combat included.</summary>
    public bool MoveUnit(string id, double x, double z)
    {
        if (!Units.TryGetValue(id, out var u) || !u.Alive) return false;
        u.Waypoint = (x, z);
        return true;
    }

    public IEnumerable<Unit> AliveUnits(string? side = null) =>
        Units.Values.Where(u => u.Alive && (side == null || u.Side == side));

    public IEnumerable<Structure> AliveStructures(string? side = null) =>
        Structures.Values.Where(s => !s.Destroyed && (side == null || s.Side == side));

    /// <summary>unitsOnly: structures only ever target enemy UNITS, never each
    /// other — a stationary tower has no combat reason to duel another
    /// stationary structure with no unit involved. Without this, two mirrored
    /// towers within each other's range (a real layout fact: the client's
    /// tower depth puts them well inside a 6.0 range across the river) fight
    /// each other from tick 0 regardless of economy or troops, silently
    /// dominating every full-match outcome — caught by a calibration sweep
    /// whose numbers made no sense until traced back to this; see
    /// docs/PROGRESS.md.</summary>
    private ICombatant? NearestEnemyTarget(ICombatant entity, double range, bool unitsOnly = false)
    {
        var enemySide = entity.Side == "A" ? "B" : "A";
        ICombatant? best = null;
        var bestDist = double.PositiveInfinity;
        foreach (var u in AliveUnits(enemySide))
        {
            var d = Distance(entity.X, entity.Z, u.X, u.Z);
            if (d <= range && d < bestDist) { best = u; bestDist = d; }
        }
        if (!unitsOnly)
        {
            foreach (var s in AliveStructures(enemySide))
            {
                var d = Distance(entity.X, entity.Z, s.X, s.Z);
                if (d <= range && d < bestDist) { best = s; bestDist = d; }
            }
        }
        return best;
    }

    private static bool MoveToward(Unit u, double targetX, double targetZ, double maxStep)
    {
        var d = Distance(u.X, u.Z, targetX, targetZ);
        if (d <= maxStep || d == 0)
        {
            u.X = targetX;
            u.Z = targetZ;
            return true; // arrived
        }
        var t = maxStep / d;
        u.X += (targetX - u.X) * t;
        u.Z += (targetZ - u.Z) * t;
        return false;
    }

    /// <summary>Advance the battle by dt seconds: move anything with an order,
    /// then resolve all engagements simultaneously (damage computed off
    /// start-of-tick targets, applied all at once — the same
    /// damage-before-removal discipline the original engine's mirror-symmetry
    /// bug taught us to enforce; see docs/PROGRESS.md).</summary>
    public void Step(double dt = DefaultDt)
    {
        Time += dt;

        // 1. movement: a pending player order always drives movement, even for
        //    a unit currently in a fight — this IS the retreat mechanic, and it
        //    is not qualified by anything below. There is deliberately no
        //    physical obstruction here (see the removed wall-blocking system
        //    in docs/PROGRESS.md) — a waypoint always drives a unit straight
        //    to its real destination.
        foreach (var u in AliveUnits())
        {
            if (u.Waypoint is not { } wp) continue;
            var arrived = MoveToward(u, wp.X, wp.Z, u.Speed * dt);
            if (arrived) u.Waypoint = null;
        }

        // 2. targeting + simultaneous damage resolution
        var pendingDamage = new List<(string Id, double Amount)>();
        foreach (var u in AliveUnits())
        {
            var target = NearestEnemyTarget(u, u.Range);
            u.TargetId = target?.Id;
            if (target is not null) pendingDamage.Add((target.Id, u.Dps * dt));
        }
        foreach (var s in AliveStructures())
        {
            var target = NearestEnemyTarget(s, s.Range, unitsOnly: true); // structures only ever target units
            s.TargetId = target?.Id;
            if (target is not null) pendingDamage.Add((target.Id, s.Dps * dt));
        }

        foreach (var (id, amount) in pendingDamage)
        {
            if (Units.TryGetValue(id, out var u2)) { u2.Hp -= amount; continue; }
            if (Structures.TryGetValue(id, out var s2)) s2.Hp -= amount;
        }

        // 3. deaths — after ALL damage this tick is applied, never mid-loop
        foreach (var u in AliveUnits())
        {
            if (u.Hp <= 0)
            {
                u.Hp = 0;
                u.Alive = false;
                Log.Add(new LogEvent(Time, "unitDied", u.Id, u.Key, u.Side));
            }
        }
        foreach (var s in AliveStructures())
        {
            if (s.Hp <= 0)
            {
                s.Hp = 0;
                s.Destroyed = true;
                Log.Add(new LogEvent(Time, "structureDestroyed", s.Id, s.Key, s.Side));
            }
        }
    }

    /// <summary>Runs until nothing can possibly happen anymore (no unit on
    /// either side has a target in range AND no unit has a pending order) or
    /// maxTime is hit.</summary>
    public void RunUntilSettled(double maxTime = 120, double dt = DefaultDt)
    {
        while (Time < maxTime)
        {
            var engaged = Units.Values.Any(u => u.Alive && u.TargetId is not null) ||
                          Structures.Values.Any(s => !s.Destroyed && s.TargetId is not null);
            var moving = Units.Values.Any(u => u.Alive && u.Waypoint is not null);
            if (!engaged && !moving && Time > 0) break;
            Step(dt);
        }
    }
}
