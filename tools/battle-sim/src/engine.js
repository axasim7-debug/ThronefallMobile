"use strict";

// Continuous positional combat prototype — a deliberately separate tool from
// tools/balance-sim, not a replacement of it. That tool's economy math
// (gold, build timers, farm disruption) is untouched and still valid; this
// one exists purely to design and stress-test the NEW combat model before
// any of it reaches the C# engine or the client:
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
// See docs/PROGRESS.md for why this model replaced the old one, and the
// standing rule: nothing here is "final" until tested from multiple angles.

const DEFAULT_DT = 0.25; // seconds per tick — fine enough for smooth kiting/retreats

function distance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function moveToward(entity, target, maxStep) {
  const d = distance(entity, target);
  if (d <= maxStep || d === 0) {
    entity.x = target.x;
    entity.z = target.z;
    return true; // arrived
  }
  const t = maxStep / d;
  entity.x += (target.x - entity.x) * t;
  entity.z += (target.z - entity.z) * t;
  return false;
}

/**
 * A live battle. Two sides ("A"/"B"), each a list of units plus fixed
 * structures. Advance with step(dt); issue orders with moveUnit(id, x, z)
 * at any time between steps — exactly like a player dragging a card.
 */
class Battle {
  constructor() {
    this.time = 0;
    this.units = new Map(); // id -> unit
    this.structures = new Map(); // id -> structure
    this.log = []; // {t, event, ...} — for test assertions and debugging
    this._nextId = 1;
  }

  addUnit({ side, x, z, hp, dps, range, speed, waypoint = null, key = "unit" }) {
    const id = `u${this._nextId++}`;
    this.units.set(id, {
      id, key, side, x, z, hp, maxHp: hp, dps, range, speed,
      waypoint, alive: true, targetId: null,
    });
    return id;
  }

  addStructure({ side, x, z, hp, dps, range, key = "structure" }) {
    const id = `s${this._nextId++}`;
    this.structures.set(id, {
      id, key, side, x, z, hp, maxHp: hp, dps, range, destroyed: false,
    });
    return id;
  }

  /** Player intent: send a unit toward (x, z). Overrides any current order
   * and — this is the retreat mechanic — takes priority over whatever the
   * unit was doing, combat included. */
  moveUnit(id, x, z) {
    const u = this.units.get(id);
    if (!u || !u.alive) return false;
    u.waypoint = { x, z };
    return true;
  }

  aliveUnits(side) {
    return [...this.units.values()].filter((u) => u.alive && (side === undefined || u.side === side));
  }

  aliveStructures(side) {
    return [...this.structures.values()].filter((s) => !s.destroyed && (side === undefined || s.side === side));
  }

  _nearestEnemyTarget(entity) {
    const enemySide = entity.side === "A" ? "B" : "A";
    let best = null;
    let bestDist = Infinity;
    for (const u of this.aliveUnits(enemySide)) {
      const d = distance(entity, u);
      if (d <= entity.range && d < bestDist) { best = u; bestDist = d; }
    }
    for (const s of this.aliveStructures(enemySide)) {
      const d = distance(entity, s);
      if (d <= entity.range && d < bestDist) { best = s; bestDist = d; }
    }
    return best;
  }

  /** Advance the battle by dt seconds: move anything with an order, then
   * resolve all engagements simultaneously (damage computed off
   * start-of-tick targets, applied all at once — the same
   * damage-before-removal discipline the original engine's mirror-symmetry
   * bug taught us to enforce; see docs/PROGRESS.md). */
  step(dt = DEFAULT_DT) {
    this.time += dt;

    // 1. movement: a pending player order always drives movement, even for
    //    a unit currently in a fight — this IS the retreat mechanic.
    for (const u of this.aliveUnits()) {
      if (u.waypoint) {
        const arrived = moveToward(u, u.waypoint, u.speed * dt);
        if (arrived) u.waypoint = null;
      }
    }

    // 2. targeting + simultaneous damage resolution
    const pendingDamage = []; // {targetKind, id, amount}
    for (const u of this.aliveUnits()) {
      const target = this._nearestEnemyTarget(u);
      u.targetId = target ? target.id : null;
      if (target) pendingDamage.push({ id: target.id, amount: u.dps * dt });
    }
    for (const s of this.aliveStructures()) {
      const target = this._nearestEnemyTarget(s);
      s.targetId = target ? target.id : null;
      if (target) pendingDamage.push({ id: target.id, amount: s.dps * dt });
    }

    for (const { id, amount } of pendingDamage) {
      const u = this.units.get(id);
      if (u) { u.hp -= amount; continue; }
      const s = this.structures.get(id);
      if (s) s.hp -= amount;
    }

    // 3. deaths — after ALL damage this tick is applied, never mid-loop
    for (const u of this.aliveUnits()) {
      if (u.hp <= 0) {
        u.hp = 0; u.alive = false;
        this.log.push({ t: this.time, event: "unitDied", id: u.id, key: u.key, side: u.side });
      }
    }
    for (const s of this.aliveStructures()) {
      if (s.hp <= 0) {
        s.hp = 0; s.destroyed = true;
        this.log.push({ t: this.time, event: "structureDestroyed", id: s.id, key: s.key, side: s.side });
      }
    }
  }

  /** Runs until nothing can possibly happen anymore (no unit on either side
   * has a target in range AND no unit has a pending order) or maxTime is
   * hit — used by scenarios that should reach a natural stop, not by
   * "idle armies never fight" tests (those assert the opposite: use step()
   * directly and check nothing changed). */
  runUntilSettled(maxTime = 120, dt = DEFAULT_DT) {
    while (this.time < maxTime) {
      const engaged = [...this.units.values()].some((u) => u.alive && u.targetId) ||
        [...this.structures.values()].some((s) => !s.destroyed && s.targetId);
      const moving = [...this.units.values()].some((u) => u.alive && u.waypoint);
      if (!engaged && !moving && this.time > 0) break;
      this.step(dt);
    }
  }
}

module.exports = { Battle, distance, DEFAULT_DT };
