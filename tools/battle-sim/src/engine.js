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
 * Standard slab-method segment-vs-AABB test: does the straight path from
 * (x1,z1) to (x2,z2) enter `rect`, and if so, where does it first cross the
 * boundary? Returns null for no intersection within this segment.
 *
 * This is what makes a wall an actual obstacle rather than just another
 * target a unit happens to be near. Without it, "build a wall" would be
 * cosmetic — nothing would stop an attacker from walking straight past one
 * to whatever's behind it.
 */
function segmentRectEntry(x1, z1, x2, z2, rect) {
  const dx = x2 - x1, dz = z2 - z1;
  let tmin = 0, tmax = 1;
  if (dx === 0) {
    if (x1 < rect.minX || x1 > rect.maxX) return null;
  } else {
    let t1 = (rect.minX - x1) / dx, t2 = (rect.maxX - x1) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (dz === 0) {
    if (z1 < rect.minZ || z1 > rect.maxZ) return null;
  } else {
    let t1 = (rect.minZ - z1) / dz, t2 = (rect.maxZ - z1) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmin < 0 || tmin > 1) return null;
  return { t: tmin, x: x1 + dx * tmin, z: z1 + dz * tmin };
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

  /** blockRect: {minX, maxX, minZ, maxZ} — omit for a structure that doesn't
   * physically obstruct movement (towers, keep: standalone point targets).
   * Only walls set this in practice. */
  addStructure({ side, x, z, hp, dps, range, key = "structure", blockRect = null }) {
    const id = `s${this._nextId++}`;
    this.structures.set(id, {
      id, key, side, x, z, hp, maxHp: hp, dps, range, destroyed: false, blockRect,
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

  /** The nearest point along entity's straight path to `dest` where a
   * standing enemy wall blocks the way, or null if the path is clear. */
  _firstBlockingWall(entity, dest) {
    const enemySide = entity.side === "A" ? "B" : "A";
    let best = null;
    for (const s of this.aliveStructures(enemySide)) {
      if (!s.blockRect) continue;
      const hit = segmentRectEntry(entity.x, entity.z, dest.x, dest.z, s.blockRect);
      if (hit && (!best || hit.t < best.hit.t)) best = { structure: s, hit };
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
    //    a unit currently in a fight — this IS the retreat mechanic, and it
    //    is not qualified by anything below. (An earlier version of this
    //    also froze movement for a unit already in range of an enemy, to
    //    stop it walking through its target. That broke retreat outright —
    //    a retreating unit IS "in range" of what it's fleeing right up until
    //    it isn't — so it's gone. Units visually overlapping their melee
    //    target when they finish closing distance is a known cosmetic gap,
    //    for a later pass with real unit footprints; it doesn't affect the
    //    combat math this prototype exists to validate.)
    //
    //    A standing enemy wall crossing the path is the one thing that DOES
    //    redirect movement: the destination for this tick becomes the wall's
    //    entry point instead of the real waypoint, and — the important part —
    //    the waypoint itself is NOT cleared, so the original order resumes
    //    automatically the moment the wall falls.
    for (const u of this.aliveUnits()) {
      if (!u.waypoint) continue;
      const blocker = this._firstBlockingWall(u, u.waypoint);
      const dest = blocker ? blocker.hit : u.waypoint;
      const arrived = moveToward(u, dest, u.speed * dt);
      if (arrived && !blocker) u.waypoint = null; // only the REAL destination clears the order
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
